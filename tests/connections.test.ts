import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ConnectionPool, type ConnectionClient } from '../electron/connections';
import type { RpcRecord } from '../shared/types';

class FixtureClient implements ConnectionClient {
  running = false;
  busy = false;
  hasSessionControls = true;
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
  async waitForIdle({ signal, timeoutMs = 1_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.busy) {
      if (signal?.aborted) throw new Error('cancelled');
      if (!this.running) throw new Error('disconnected');
      if (Date.now() > end) throw new Error('idle timeout');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    if (!this.running) throw new Error('disconnected');
  }
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
const turn = () => new Promise(resolve => setTimeout(resolve, 10));

test('immediate redirect waits for real idle, supersedes older requests and deduplicates identical sends in one chat', async t => {
  const { pool, clients, events } = fixture();
  t.after(() => pool.stopAll());
  const a = await pool.connect(project); const b = await pool.connect(project, undefined, { newSession: true });
  await pool.rpc({ type: 'prompt', message: 'old A' }, a.connectionId);
  await pool.rpc({ type: 'prompt', message: 'keep B' }, b.connectionId);
  const first = pool.redirect({ message: 'obsolete A' }, a.connectionId);
  const duplicate = pool.redirect({ message: 'obsolete A' }, a.connectionId);
  await turn();
  assert.equal(clients[0].sent.filter(command => command.type === 'prompt').length, 1, 'abort acknowledgement alone is insufficient');
  const newest = pool.redirect({ message: 'latest A' }, a.connectionId);
  const [oldResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(oldResult.status, 'superseded');
  assert.equal(duplicateResult.requestId, oldResult.requestId);
  await assert.rejects(pool.rpc({ type: 'prompt', message: 'cannot race handoff' }, a.connectionId), /调整当前任务/);
  await assert.rejects(pool.rpc({ type: 'set_model', modelId: 'cannot race settings' }, a.connectionId), /正在执行/);
  assert.equal(pool.list().find(entry => entry.id === a.connectionId)?.busy, true);
  clients[0].finish();
  const result = await newest;
  assert.equal(result.status, 'submitted');
  assert.deepEqual(clients[0].sent.filter(command => command.type === 'prompt').map(command => command.message), ['old A', 'latest A']);
  assert.equal(clients[1].busy, true, 'B keeps working');
  assert.equal(clients[1].sent.some(command => command.type === 'abort'), false);
  const scoped = events.filter(event => event.connectionId === a.connectionId);
  const newStart = scoped.findLastIndex(event => event.type === 'agent_start');
  const oldSettled = scoped.findIndex(event => event.type === 'agent_settled');
  assert.ok(oldSettled >= 0 && newStart > oldSettled);
  assert.ok(scoped.some(event => event.type === 'redirect_update' && event.requestId === result.requestId && event.status === 'submitted'));
  assert.ok(!scoped.some(event => event.type === 'redirect_update' && event.requestId === oldResult.requestId && event.status === 'cancelled'));
});

test('Stop cancels the latest automatic continuation and keeps its unsent message recoverable', async t => {
  const { pool, clients, events } = fixture();
  t.after(() => pool.stopAll());
  const a = await pool.connect(project);
  await pool.rpc({ type: 'prompt', message: 'old work' }, a.connectionId);
  const replacement = pool.redirect({ message: 'do not auto run after Stop' }, a.connectionId);
  await turn();
  await pool.rpc({ type: 'abort' }, a.connectionId);
  assert.equal((await replacement).status, 'cancelled');
  clients[0].finish(); await turn();
  assert.equal(clients[0].sent.filter(command => command.type === 'prompt').length, 1);
  const cancelled = events.find(event => event.type === 'redirect_update' && event.status === 'cancelled');
  assert.equal(cancelled?.message, 'do not auto run after Stop');
  assert.equal(pool.get(a.connectionId).redirect, undefined);
});

test('disconnect cancels a redirect even while its abort request is pending', async () => {
  const { pool, clients } = fixture();
  const a = await pool.connect(project);
  const request = clients[0].request.bind(clients[0]);
  let release!: () => void;
  clients[0].request = command => command.type === 'abort' ? new Promise(resolve => { release = () => resolve({}); }) : request(command);
  const redirected = pool.redirect({ message: 'must not run after disconnect' }, a.connectionId);
  await turn();
  await pool.disconnect(a.connectionId);
  assert.equal((await redirected).status, 'cancelled');
  release(); await turn();
  assert.equal(clients[0].sent.some(command => command.type === 'prompt'), false);
});

test('redirect capability and submission failures reject safely without pretending the new instruction ran', async t => {
  const { pool, clients, events } = fixture();
  t.after(() => pool.stopAll());
  const a = await pool.connect(project);
  clients[0].hasSessionControls = false;
  await assert.rejects(pool.redirect({ message: 'unsupported' }, a.connectionId), /未加载桌面中断适配器/);
  assert.equal(clients[0].sent.some(command => command.type === 'abort'), false);
  clients[0].hasSessionControls = true;
  const request = clients[0].request.bind(clients[0]);
  clients[0].request = command => command.type === 'prompt' ? Promise.reject(new Error('fixture preflight rejected')) : request(command);
  await assert.rejects(pool.redirect({ message: 'failed latest' }, a.connectionId), /preflight rejected/);
  await turn();
  assert.equal(pool.get(a.connectionId).redirect, undefined);
  assert.ok(events.some(event => event.type === 'redirect_update' && event.status === 'error' && event.message === 'failed latest'));
});

test('redirect waits for a compaction mutation to finish before submitting the replacement', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const a = await pool.connect(project);
  const compact = pool.rpc({ type: 'compact' }, a.connectionId);
  const redirected = pool.redirect({ message: 'after cancelled compaction' }, a.connectionId);
  await turn();
  assert.equal(clients[0].sent.some(command => command.type === 'prompt'), false);
  clients[0].compactRelease!(); await compact;
  assert.equal((await redirected).status, 'submitted');
  assert.equal(pool.get(a.connectionId).mutation, false);
});

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

test('background restored chats use stable tab IDs without changing foreground selection or restore priority', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project);
  const selected = pool.get(first.connectionId);
  const order = selected.selectionOrder;
  const background = await pool.connect(project, path.join(project, 'restored-B.jsonl'), { connectionId: 'stable-cache-B', background: true, restoring: true });
  assert.equal(background.connectionId, 'stable-cache-B');
  assert.equal(pool.activeConnectionId, first.connectionId);
  assert.equal(selected.selectionOrder, order);
  assert.equal(pool.isLatestSelection(selected), true);
  assert.equal(pool.isLatestSelection(pool.get(background.connectionId)), false);
  const reused = await pool.connect(project, background.state.sessionFile, { connectionId: background.connectionId, background: true });
  assert.equal(reused.connectionId, background.connectionId);
  assert.equal(clients.length, 2);
  assert.equal(pool.activeConnectionId, first.connectionId);
  pool.select(background.connectionId!);
  assert.equal(pool.activeConnectionId, background.connectionId);
  assert.equal(pool.isLatestSelection(selected), false);
});

test('background restores keep unsaved tabs distinct and reject stable ID project or session conflicts', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const a = await pool.connect(project, undefined, { connectionId: 'empty-cache-A', background: true });
  const b = await pool.connect(project, undefined, { connectionId: 'empty-cache-B', background: true });
  assert.equal(pool.activeConnectionId, undefined);
  assert.notEqual(a.state.sessionFile, b.state.sessionFile);
  assert.equal(clients.length, 2);
  await assert.rejects(pool.connect(path.resolve('different-project'), a.state.sessionFile, { connectionId: a.connectionId, background: true }), /ID 已被/);
  await assert.rejects(pool.connect(project, b.state.sessionFile, { connectionId: a.connectionId, background: true }), /ID 已被/);
  const sameWriter = await pool.connect(project, a.state.sessionFile, { connectionId: 'alias-cache', background: true });
  assert.equal(sameWriter.connectionId, a.connectionId);
  assert.equal(clients.length, 2);
  assert.equal(pool.activeConnectionId, undefined);
});

test('strict cache restoration rejects a duplicate tab ID for one JSONL without adding a writer or changing selection', async t => {
  const { pool, clients } = fixture();
  t.after(() => pool.stopAll());
  const first = await pool.connect(project, path.join(project, 'single-writer-cache.jsonl'), { connectionId: 'first-cache', background: true, restoring: true });
  pool.select(first.connectionId!);
  await assert.rejects(pool.connect(project, first.state.sessionFile, { connectionId: 'duplicate-cache', background: true, restoring: true }), /另一标签恢复/);
  assert.equal(clients.length, 1);
  assert.equal(pool.activeConnectionId, first.connectionId);
  assert.equal(pool.list().length, 1);
  const reopened = await pool.connect(project, first.state.sessionFile);
  assert.equal(reopened.connectionId, first.connectionId, 'ordinary history opens still reuse its existing writer');
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
