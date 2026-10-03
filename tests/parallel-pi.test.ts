import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConnectionPool } from '../electron/connections';
import { PiRpcClient } from '../electron/rpc';
import type { RpcRecord } from '../shared/types';

const cli = [
  process.env.PI_TEST_CLI,
  path.resolve('build/runtime/win32-x64/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
  path.resolve('release/win-unpacked/resources/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
  path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

async function until(predicate: () => boolean, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('real isolated Pi chats stream concurrently, preserve separate history, reuse sessions and stop only their owning child', { skip: !cli, timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-parallel-'));
  const project = path.join(root, '并行任务项目');
  const agent = path.join(root, 'agent');
  await Promise.all([mkdir(project), mkdir(agent)]);
  const incoming: { response: http.ServerResponse; marker: string }[] = [];
  const events: RpcRecord[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw);
    const user = body.messages.filter((message: RpcRecord) => message.role === 'user').at(-1);
    const marker = JSON.stringify(user?.content).includes('JOB_A') ? 'JOB_A' : 'JOB_B';
    incoming.push({ response, marker });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ id: 'parallel-local', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: `${marker}:START ` }, finish_reason: null }] })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: {
    'local-fixture': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'isolated-local-only', models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 1024 }] },
  } }));
  const allowed = new Set(['path', 'pathext', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'home', 'userprofile']);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  let processCount = 0;
  const pool = new ConnectionPool({
    onEvent: event => events.push(event),
    createClient: (cwd, sessionPath, onEvent) => {
      processCount++;
      return new PiRpcClient({
        executable: process.execPath,
        args: [cli!, '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--provider', 'local-fixture', '--model', 'fixture-model', '--thinking', 'off', ...(sessionPath ? ['--session', sessionPath] : [])],
        cwd, env: { ...environment, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NO_COLOR: '1' }, onEvent,
        requestTimeoutMs: 60_000,
      });
    },
  });
  function finish(marker: string) {
    const pending = incoming.find(entry => entry.marker.includes(marker));
    assert.ok(pending, `${marker} reached the isolated model`);
    pending.response.end(`data: ${JSON.stringify({ id: 'parallel-local', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { content: `${marker}:DONE` }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  try {
    const first = await pool.connect(project);
    await pool.rpc({ type: 'set_session_name', name: '任务 A' }, first.connectionId);
    await pool.rpc({ type: 'prompt', message: 'JOB_A' }, first.connectionId);
    const second = await pool.connect(project, undefined, { newSession: true });
    await pool.rpc({ type: 'set_session_name', name: '任务 B' }, second.connectionId);
    await pool.rpc({ type: 'prompt', message: 'JOB_B' }, second.connectionId);
    await until(() => incoming.length === 2, 'both local model requests overlap');
    assert.equal(pool.busyCount, 2, 'both independent Pi processes are busy');
    assert.notEqual(first.state.sessionFile, second.state.sessionFile);
    const selected = await pool.activate(first.connectionId!);
    assert.equal(selected.state.isStreaming, true);
    assert.equal(pool.busyCount, 2, 'selecting A does not interrupt B');
    const reused = await pool.connect(project, second.state.sessionFile);
    assert.equal(reused.connectionId, second.connectionId);
    assert.equal(processCount, 2, 'opening an active JSONL reuses its writer');
    assert.ok(events.some(event => event.type === 'message_update' && event.connectionId === first.connectionId));
    assert.ok(events.some(event => event.type === 'message_update' && event.connectionId === second.connectionId));
    await pool.disconnect(first.connectionId);
    assert.equal(pool.list().length, 1);
    assert.equal(pool.get(second.connectionId).client!.running, true);
    assert.equal(pool.get(second.connectionId).client!.busy, true, 'stopping A leaves B streaming');
    finish('JOB_B');
    await until(() => events.some(event => event.type === 'agent_settled' && event.connectionId === second.connectionId), 'B completion');
    const result = await pool.rpc({ type: 'get_messages' }, second.connectionId);
    assert.ok(JSON.stringify(result).includes('JOB_B:DONE'));
    assert.ok(!JSON.stringify(result).includes('JOB_A'));
    const persisted = await readFile(second.state.sessionFile, 'utf8');
    assert.ok(persisted.includes('JOB_B:DONE'));
    assert.ok(!persisted.includes('JOB_A'));
    await pool.disconnect(second.connectionId);
    const reopened = await pool.connect(project, second.state.sessionFile);
    assert.equal(reopened.state.sessionId, second.state.sessionId);
    assert.equal(reopened.state.sessionName, '任务 B');
    assert.ok(JSON.stringify(reopened.messages).includes('JOB_B:DONE'));
  } finally {
    await pool.stopAll();
    for (const pending of incoming) pending.response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pi-desktop-parallel-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
