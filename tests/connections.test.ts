import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ConnectionPool, type ConnectionClient } from '../electron/connections';
import type { RpcRecord } from '../shared/types';

class FixtureClient implements ConnectionClient {
  running = false;
  busy = false;
  stopped = false;
  sent: RpcRecord[] = [];
  state: RpcRecord;
  switchRelease?: () => void;
  compactRelease?: () => void;
  stopDelay = 0;
  constructor(readonly project: string, sessionPath: string | undefined, readonly emit: (event: RpcRecord) => void, number: number) {
    this.state = { sessionFile: sessionPath ?? path.join(project, `fixture-${number}.jsonl`), sessionId: String(number), isStreaming: false, model: { id: 'fixture' } };
  }
  start(): void { this.running = true; }
  async stop(): Promise<void> {
    if (this.stopDelay) await new Promise(resolve => setTimeout(resolve, this.stopDelay));
    this.stopped = true; this.running = false; this.busy = false; this.emit({ type: 'connection_status', status: 'disconnected' });
  }
  async request(command: RpcRecord): Promise<RpcRecord> {
    assert.ok(this.running);
    this.sent.push(command);
    if (command.type === 'get_state') return { ...this.state, isStreaming: this.busy };
    if (command.type === 'get_messages') return { messages: [] };
    if (command.type === 'get_available_models') return { models: [this.state.model] };
    if (command.type === 'get_commands') return { commands: [] };
    if (command.type === 'prompt') {
      this.busy = true;
      this.emit({ type: 'agent_start' });
    }
    if (command.type === 'set_session_name') this.state.sessionName = command.name;
    if (command.type === 'set_model') this.state.model = { id: command.modelId };
    if (command.type === 'switch_session') {
      await new Promise<void>(resolve => { this.switchRelease = resolve; });
      this.state.sessionFile = command.sessionPath;
    }
    if (command.type === 'compact') await new Promise<void>(resolve => { this.compactRelease = resolve; });
    return {};
  }
  send(command: RpcRecord): void { this.sent.push(command); }
  finish(): void { this.emit({ type: 'agent_end' }); this.busy = false; this.emit({ type: 'agent_settled' }); }
}
function fixture(factoryDelay = 0) {
  const clients: FixtureClient[] = [];
  const events: RpcRecord[] = [];
  const pool = new ConnectionPool({
    createClient: async (project, sessionPath, onEvent) => {
      if (factoryDelay) await new Promise(resolve => setTimeout(resolve, factoryDelay));
      const client = new FixtureClient(project, sessionPath, onEvent, clients.length + 1);
      clients.push(client);
      return client;
    },
    onEvent: event => events.push(event),
  });
  return { pool, clients, events };
}
const project = path.resolve('output/qa/parallel-fixture');

test('new chats run concurrently; activating another chat preserves both jobs and explicit RPC routing', async t => {
  const { pool, clients, events } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  await pool.rpc({ type: 'prompt', message: 'job A' }, first.connectionId);
  const second = await pool.connect(project, undefined, { newSession: true });
  await pool.rpc({ type: 'prompt', message: 'job B' }, second.connectionId);
  assert.equal(pool.busyCount, 2);
  assert.notEqual(first.connectionId, second.connectionId);
  assert.notEqual(first.state.sessionFile, second.state.sessionFile);
  assert.equal((await pool.activate(first.connectionId!)).connectionId, first.connectionId);
  assert.equal(pool.busyCount, 2);
  assert.ok(clients.every(client => !client.stopped));
  await pool.rpc({ type: 'steer', message: 'only B' }, second.connectionId);
  assert.ok(!clients[0].sent.some(command => command.message === 'only B'));
  assert.ok(clients[1].sent.some(command => command.message === 'only B'));
  assert.ok(events.filter(event => event.type === 'agent_start').every(event => event.connectionId && event.project === project));
  assert.ok(events.some(event => event.type === 'connections_changed' && event.connections.filter((entry: RpcRecord) => entry.busy).length === 2));
});

test('cached chat selection transfers no history and performs no Pi RPC, including while jobs run', async t => {
  const { pool, clients, events } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  const second = await pool.connect(project, undefined, { newSession: true });
  await pool.rpc({ type: 'prompt', message: 'running A' }, first.connectionId);
  for (const client of clients) {
    client.sent = [];
    const request = client.request.bind(client);
    client.request = command => {
      if (command.type.startsWith('get_')) throw new Error('cached selection must not request a full snapshot');
      return request(command);
    };
  }
  for (let index = 0; index < 50; index++) {
    const summary = pool.select(index % 2 ? first.connectionId! : second.connectionId!);
    assert.equal('messages' in summary, false);
    assert.equal('state' in summary, false);
  }
  assert.equal(pool.activeConnectionId, first.connectionId);
  assert.equal(pool.isLatestSelection(pool.get(first.connectionId)), true);
  assert.deepEqual(clients.map(client => client.sent.length), [0, 0]);
  assert.equal(pool.list().find(entry => entry.id === first.connectionId)?.busy, true);
  pool.respondUI({ type: 'extension_ui_response', id: 'selected A' });
  assert.equal(clients[0].sent[0].id, 'selected A');
  assert.equal(clients[1].sent.length, 0);
  assert.equal(events.at(-1)?.activeConnectionId, first.connectionId);
});

test('cached selection stays synchronous during a session mutation and publishes its final session path', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project, path.join(project, 'selected-before-switch.jsonl'));
  const target = path.join(project, 'selected-after-switch.jsonl');
  const switching = pool.rpc({ type: 'switch_session', sessionPath: target }, first.connectionId);
  await pool.connect(project, undefined, { newSession: true });
  const before = clients[0].sent.length;
  const selected = pool.select(first.connectionId!);
  assert.equal(selected.id, first.connectionId);
  assert.equal(selected.busy, true);
  assert.equal(selected.sessionPath, first.state.sessionFile);
  assert.equal(clients[0].sent.length, before);
  clients[0].switchRelease!();
  await switching;
  const updated = pool.select(first.connectionId!);
  assert.equal(updated.sessionPath, target);
  assert.equal(updated.busy, false);
  await pool.disconnect(first.connectionId);
  assert.throws(() => pool.select(first.connectionId!), /已经断开/);
});

test('opening a project or its history reuses its process even while it is busy, including overlapping startup', async t => {
  const { pool, clients } = fixture(10);
  t.after(() => pool.stopAll());
  const session = path.join(project, 'existing.jsonl');
  const [first, duplicate] = await Promise.all([pool.connect(project, session), pool.connect(project, session)]);
  assert.equal(first.connectionId, duplicate.connectionId);
  assert.equal(clients.length, 1);
  await pool.rpc({ type: 'prompt', message: 'working' }, first.connectionId);
  assert.equal((await pool.connect(project, session)).connectionId, first.connectionId);
  assert.equal((await pool.connect(project)).connectionId, first.connectionId);
  const otherProject = path.resolve('output/qa/another-project');
  await pool.connect(otherProject);
  assert.equal((await pool.connect(project)).connectionId, first.connectionId);
  assert.equal(clients[0].busy, true);
});

test('busy restrictions apply only to the owning chat; default RPC and UI replies follow the active chat', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  await pool.rpc({ type: 'prompt', message: 'working' }, first.connectionId);
  const second = await pool.connect(project, first.state.sessionFile, { newSession: true });
  await assert.rejects(pool.rpc({ type: 'set_model', modelId: 'blocked' }, first.connectionId), /这个会话正在执行/);
  await pool.rpc({ type: 'set_model', modelId: 'allowed' });
  assert.equal(clients[1].state.model.id, 'allowed');
  pool.respondUI({ type: 'extension_ui_response', id: 'second-dialog' });
  pool.respondUI({ type: 'extension_ui_response', id: 'first-dialog' }, first.connectionId);
  assert.ok(clients[0].sent.some(command => command.id === 'first-dialog'));
  assert.ok(clients[1].sent.some(command => command.id === 'second-dialog'));
  assert.notEqual(first.state.sessionFile, second.state.sessionFile, 'newSession ignores the historical path');
});

test('disconnecting one busy chat leaves other chats running and bulk shutdown closes every process', async () => {
  const { pool, clients } = fixture();
  const first = await pool.connect(project);
  const second = await pool.connect(project, undefined, { newSession: true });
  await pool.rpc({ type: 'prompt', message: 'A' }, first.connectionId);
  await pool.rpc({ type: 'prompt', message: 'B' }, second.connectionId);
  await pool.disconnect(first.connectionId);
  assert.equal(clients[0].stopped, true);
  assert.equal(clients[1].busy, true);
  assert.equal(pool.list().length, 1);
  assert.equal(pool.activeConnectionId, second.connectionId);
  await pool.stopAll();
  assert.ok(clients.every(client => client.stopped));
  assert.deepEqual(pool.list(), []);
  await assert.rejects(pool.connect(project), /正在退出/);
});

test('reopening a closing history file waits until its former writer has exited', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project, path.join(project, 'closing.jsonl'));
  clients[0].stopDelay = 20;
  const closing = pool.disconnect(first.connectionId);
  const opening = pool.connect(project, first.state.sessionFile);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(clients.length, 1);
  await closing;
  const reopened = await opening;
  assert.equal(clients[0].stopped, true);
  assert.notEqual(reopened.connectionId, first.connectionId);
  assert.equal(clients.length, 2);
});

test('name and completion changes publish connection summaries with the correct background chat', async t => {
  const { pool, clients, events } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  await pool.rpc({ type: 'set_session_name', name: '独立任务 A' }, first.connectionId);
  const second = await pool.connect(project, undefined, { newSession: true });
  await pool.rpc({ type: 'prompt', message: 'A' }, first.connectionId);
  clients[0].finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  const summary = pool.list().find(entry => entry.id === first.connectionId)!;
  assert.equal(summary.sessionName, '独立任务 A');
  assert.equal(summary.busy, false);
  assert.equal(pool.activeConnectionId, second.connectionId);
  assert.ok(events.some(event => event.type === 'agent_settled' && event.connectionId === first.connectionId));
  assert.ok(events.some(event => event.type === 'connections_changed' && event.connections.some((entry: RpcRecord) => entry.sessionName === '独立任务 A')));
});

test('background activity does not steal the most recently selected chat when reopening a project', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  const second = await pool.connect(project, undefined, { newSession: true });
  await pool.connect(path.resolve('output/qa/different-project'));
  clients[0].emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'background log' } });
  assert.equal((await pool.connect(project)).connectionId, second.connectionId);
  assert.equal(pool.isLatestSelection(pool.get(first.connectionId)), false);
  assert.equal(pool.isLatestSelection(pool.get(second.connectionId)), true);
});

test('a chat remains selectable while its own context compaction is running', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  const compacting = pool.rpc({ type: 'compact' }, first.connectionId);
  await pool.connect(project, undefined, { newSession: true });
  const selection = pool.activate(first.connectionId!);
  try {
    const result = await Promise.race([selection, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('compaction blocked chat selection')), 100))]);
    assert.equal(result.connectionId, first.connectionId);
    assert.equal(pool.list().find(entry => entry.id === first.connectionId)?.busy, true);
  } finally { clients[0].compactRelease!(); await compacting; }
});

test('session switching cannot open a second writer; concurrent history selection waits for its reservation', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project, path.join(project, 'first.jsonl'));
  const second = await pool.connect(project, path.join(project, 'second.jsonl'));
  await assert.rejects(pool.rpc({ type: 'switch_session', sessionPath: second.state.sessionFile }, first.connectionId), /已经打开/);
  const target = path.join(project, 'third.jsonl');
  const switching = pool.rpc({ type: 'switch_session', sessionPath: target }, first.connectionId);
  const overlapping = pool.connect(project, target);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(clients.length, 2, 'a switching session owns the target path before the RPC responds');
  clients[0].switchRelease!();
  await switching;
  assert.equal((await overlapping).connectionId, first.connectionId);
  assert.equal(pool.list().find(entry => entry.id === first.connectionId)?.sessionPath, target);
  assert.equal(clients.length, 2);
});

test('startup failure cleans only its own process and restores a surviving active chat', async t => {
  const events: RpcRecord[] = [];
  const good = new FixtureClient(project, undefined, event => events.push(event), 1);
  let calls = 0;
  const pool = new ConnectionPool({
    createClient: () => { if (calls++) throw new Error('isolated startup failure'); return good; },
    onEvent: event => events.push(event),
  });
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  await pool.rpc({ type: 'prompt', message: 'working' }, first.connectionId);
  await assert.rejects(pool.connect(project, undefined, { newSession: true }), /isolated startup failure/);
  assert.equal(good.stopped, false);
  assert.equal(good.busy, true);
  assert.equal(pool.activeConnectionId, first.connectionId);
  assert.equal(pool.list().length, 1);
});

test('disconnect during launcher discovery cancels the pending connection and cannot leak a process', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const created: FixtureClient[] = [];
  const pool = new ConnectionPool({
    createClient: async (project, sessionPath, onEvent) => {
      await ready;
      const client = new FixtureClient(project, sessionPath, onEvent, 1);
      created.push(client);
      return client;
    },
    onEvent: () => {},
  });
  const opening = pool.connect(project);
  const failed = assert.rejects(opening, /连接已取消/);
  const closing = pool.disconnect(pool.list()[0].id);
  release();
  await Promise.all([failed, closing]);
  assert.deepEqual(pool.list(), []);
  assert.equal(created[0].running, false);
  assert.equal(created[0].stopped, true);
});
