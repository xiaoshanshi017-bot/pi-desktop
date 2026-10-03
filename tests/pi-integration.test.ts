import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PiRpcClient } from '../electron/rpc';
import type { RpcRecord } from '../shared/types';
import { desktopProgressGuidance } from '../shared/progress-guidance';

// These tests use an isolated Pi configuration and never call a remote model.
// PI_TEST_CLI can point to a different installation's dist/cli.js.
const cli = [
  process.env.PI_TEST_CLI,
  path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
  path.join(process.env.APPDATA || '', 'npm/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'),
  '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

async function isolatedDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-tests-'));
  const cwd = path.join(root, '中文 项目');
  const agentDir = path.join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'local-fixture': {
        baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'test-only-not-a-secret',
        models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 1024 }],
      },
    },
  }));
  return { root, cwd, agentDir };
}

async function removeIsolatedDirectory(root: string) {
  const target = path.resolve(root);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('pi-desktop-tests-'));
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function isolatedEnvironment(agentDir: string): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'home', 'userprofile']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  return { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NO_COLOR: '1' };
}

function createPi(cwd: string, agentDir: string, extraArgs: string[], onEvent?: (event: RpcRecord) => void, launch: { cliPath?: string; launcher?: string; shell?: string } = {}) {
  const client = new PiRpcClient({
    executable: process.execPath,
    args: [...(launch.launcher ? [launch.launcher] : []), launch.cliPath ?? cli!, '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', ...extraArgs],
    cwd,
    env: { ...isolatedEnvironment(agentDir), ...(launch.shell ? { PI_DESKTOP_BASH_PATH: launch.shell } : {}) },
    onEvent,
    // Match the desktop startup budget: cold Windows imports can be slower
    // while the pinned runtime is being installed or scanned by the runner.
    requestTimeoutMs: 60_000,
  });
  client.start();
  return client;
}

test('installed Pi accepts isolated RPC state, models, commands and session operations without a model call', { skip: !cli, timeout: 90_000 }, async () => {
  const directory = await isolatedDirectory();
  const client = createPi(directory.cwd, directory.agentDir, ['--no-session', '--provider', 'local-fixture', '--model', 'fixture-model']);
  try {
    const state = await client.request({ type: 'get_state' });
    assert.equal(state.isStreaming, false);
    assert.equal(state.messageCount, 0);
    assert.equal(state.sessionFile, undefined);
    const [messages, models, commands, stats] = await Promise.all([
      client.request({ type: 'get_messages' }),
      client.request({ type: 'get_available_models' }),
      client.request({ type: 'get_commands' }),
      client.request({ type: 'get_session_stats' }),
    ]);
    assert.deepEqual(messages.messages, []);
    assert.ok(Array.isArray(models.models));
    assert.ok(Array.isArray(commands.commands));
    assert.equal(stats.totalMessages, 0);
    await client.request({ type: 'set_session_name', name: '中文 RPC 测试' });
    assert.equal((await client.request({ type: 'get_state' })).sessionName, '中文 RPC 测试');
    const fresh = await client.request({ type: 'new_session' });
    assert.equal(fresh.cancelled, false);
    assert.notEqual((await client.request({ type: 'get_state' })).sessionId, state.sessionId);
    await assert.rejects(client.request({ type: 'nonexistent_test_command' }), /Unknown command/);
    assert.equal((await client.request({ type: 'get_state' })).isStreaming, false);
  } finally {
    await client.stop();
    await removeIsolatedDirectory(directory.root);
  }
});

test('real Pi streams through a local mock model, reads a Chinese filename, persists and resumes its session', { skip: !cli, timeout: 180_000 }, async () => {
  const directory = await isolatedDirectory();
  const requests: RpcRecord[] = [];
  const events: RpcRecord[] = [];
  const marker = 'isolated fixture content 你好';
  await writeFile(path.join(directory.cwd, '中文 文件.txt'), marker, 'utf8');
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta: RpcRecord, finishReason: string | null = null, usage?: RpcRecord) => {
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-local-test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
      })}\n\n`);
    };
    if (requests.length === 1) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_read_fixture', type: 'function', function: { name: 'read', arguments: '' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '{"path":"中文 ' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '文件.txt"}' } }] });
      send({}, 'tool_calls', { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 });
    } else {
      send({ role: 'assistant', content: '测试' });
      send({ content: '通过\u2028中文流式回复' });
      send({}, 'stop', { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(directory.agentDir, 'models.json'), JSON.stringify({
    providers: {
      'local-fixture': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'test-only-not-a-secret',
        models: [{ id: 'fixture-model', name: 'Test fixture', reasoning: false, contextWindow: 32000, maxTokens: 1024 }],
      },
    },
  }));
  let settled!: () => void;
  const runFinished = new Promise<void>(resolve => { settled = resolve; });
  const args = ['--provider', 'local-fixture', '--model', 'fixture-model', '--thinking', 'off', '--append-system-prompt', desktopProgressGuidance];
  let client = createPi(directory.cwd, directory.agentDir, args, event => {
    events.push(event);
    if (event.type === 'agent_settled') settled();
  });
  try {
    const initial = await client.request({ type: 'get_state' });
    assert.equal(initial.model.provider, 'local-fixture');
    await client.request({ type: 'set_session_name', name: '离线验证会话' });
    await client.request({ type: 'prompt', message: 'Read 中文 文件.txt, then respond.' });
    await Promise.race([
      runFinished,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Pi did not settle after local fixture response')), 20_000);
        timer.unref();
        runFinished.then(() => clearTimeout(timer));
      }),
    ]);
    assert.equal(requests.length, 2, 'one local completion requests a tool, a second reads its result');
    assert.equal(requests[0].model, 'fixture-model');
    assert.ok(requests[0].messages.some((message: RpcRecord) => message.role === 'system' && message.content.includes(desktopProgressGuidance)), 'desktop progress guidance reaches the real model system prompt');
    assert.ok(requests[1].messages.some((message: RpcRecord) => message.role === 'tool' && String(message.content).includes(marker)));
    assert.ok(events.some(event => event.type === 'tool_execution_start' && event.toolName === 'read'));
    assert.ok(events.some(event => event.type === 'tool_execution_end' && !event.isError));
    assert.ok(events.some(event => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'));
    assert.ok(events.filter(event => event.type === 'message_update').every(event => event.message === undefined), 'Pi 0.84.2 sends deltas without message snapshots');
    const state = await client.request({ type: 'get_state' });
    assert.equal(state.isStreaming, false);
    assert.ok(state.sessionFile.startsWith(directory.agentDir));
    const persisted = await readFile(state.sessionFile, 'utf8');
    assert.ok(persisted.includes('离线验证会话'));
    assert.ok(persisted.includes('中文流式回复'));
    const before = await client.request({ type: 'get_messages' });
    await client.stop();
    client = createPi(directory.cwd, directory.agentDir, [...args, '--session', state.sessionFile]);
    const resumedState = await client.request({ type: 'get_state' });
    assert.equal(resumedState.sessionId, state.sessionId);
    assert.equal(resumedState.sessionName, '离线验证会话');
    assert.deepEqual((await client.request({ type: 'get_messages' })).messages, before.messages);
  } finally {
    await client.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await removeIsolatedDirectory(directory.root);
  }
});

const guardedCli = [
  path.resolve('build/runtime/win32-x64/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
  path.resolve('release/win-unpacked/resources/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
].find(candidate => existsSync(candidate));
const guardedShell = [
  path.resolve('build/runtime/win32-x64/git/bin/bash.exe'),
  'C:/Program Files/Git/bin/bash.exe',
].find(candidate => existsSync(candidate));

test('real desktop launcher injects the missing Bash limit and an explicit timeout kills a hung child and settles', { skip: !guardedCli || !guardedShell, timeout: 120_000 }, async () => {
  const directory = await isolatedDirectory();
  const requests: RpcRecord[] = [];
  const events: RpcRecord[] = [];
  const auditPath = path.join(directory.agentDir, 'tool-limits.jsonl');
  const auditExtension = path.join(directory.agentDir, 'audit.js');
  await writeFile(auditExtension, `import fs from 'node:fs';
export default function(pi) {
  pi.on('tool_call', event => {
    if (event.toolName === 'bash') fs.appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({id: event.toolCallId, timeout: event.input.timeout}) + '\\n');
  });
}`);
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = requests.length === 1;
    const delta = first ? { role: 'assistant', tool_calls: [
      { index: 0, id: 'call_default_limit', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'node -e "console.log(\'DEFAULT_LIMIT_OK\')"' }) } },
      { index: 1, id: 'call_explicit_limit', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'node -e "require(\'fs\').writeFileSync(\'timeout-child.pid\', String(process.pid)); console.log(\'HANG_STARTED\'); setInterval(() => {}, 1000)"', timeout: 2 }) } },
    ] } : { role: 'assistant', content: 'TIMEOUT_RECOVERED' };
    response.end(`data: ${JSON.stringify({ id: 'chatcmpl-guard', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(directory.agentDir, 'models.json'), JSON.stringify({ providers: {
    'local-fixture': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'test-only-not-a-secret', models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 1024 }] },
  } }));
  let resolveSettled!: () => void;
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  const client = createPi(directory.cwd, directory.agentDir,
    ['--no-session', '--provider', 'local-fixture', '--model', 'fixture-model', '--thinking', 'off', '--extension', auditExtension],
    event => { events.push(event); if (event.type === 'agent_settled') resolveSettled(); },
    { cliPath: guardedCli, launcher: path.resolve('electron/pi-launcher.mjs'), shell: guardedShell });
  let deadline: NodeJS.Timeout | undefined;
  try {
    await client.request({ type: 'get_state' });
    await client.request({ type: 'prompt', message: 'Run the two fixture commands and report their results.' });
    await Promise.race([settled, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Guarded Pi did not settle after command timeout')), 20_000); })]);
    assert.equal(requests.length, 2);
    const limits = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(limits.map(entry => entry.timeout), [300, 2]);
    const prompt = requests[0].messages.filter((message: RpcRecord) => ['system', 'developer'].includes(message.role)).map((message: RpcRecord) => message.content).join('\n');
    assert.match(prompt, /300 秒后终止/);
    const completed = events.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'call_default_limit');
    assert.equal(completed?.isError, false);
    const timedOut = events.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'call_explicit_limit');
    assert.equal(timedOut?.isError, true);
    assert.match(JSON.stringify(timedOut?.result), /HANG_STARTED/);
    assert.match(JSON.stringify(timedOut?.result), /timed out after 2 seconds/);
    assert.ok(requests[1].messages.some((message: RpcRecord) => message.role === 'tool' && String(message.content).includes('timed out after 2 seconds')));
    const childId = Number(await readFile(path.join(directory.cwd, 'timeout-child.pid'), 'utf8'));
    for (let attempt = 0; attempt < 30; attempt++) {
      let running = false;
      try { process.kill(childId, 0); running = true; } catch { /* Child has ended. */ }
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.throws(() => process.kill(childId, 0), 'the hung subprocess must actually end');
    assert.equal((await client.request({ type: 'get_state' })).isStreaming, false);
  } finally {
    if (deadline) clearTimeout(deadline);
    await client.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await removeIsolatedDirectory(directory.root);
  }
});
