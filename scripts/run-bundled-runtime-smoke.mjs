// Launches only this run's packaged application, with system development tools
// absent from discovery, and attaches to its ephemeral loopback main inspector.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.env.PI_DESKTOP_QA_APP || path.join(root, 'release', 'win-unpacked', 'Pi Desktop.exe'));
const qaRoot = path.join(root, 'output', `bundled-runtime-qa-${process.pid}-${Date.now()}`);
const project = path.join(qaRoot, '中文 带空格项目');
const agent = path.join(qaRoot, 'agent');
const desktop = path.join(qaRoot, 'desktop');
const fakeHome = path.join(qaRoot, 'home');
const reportPath = path.join(qaRoot, 'bundled-runtime-report.json');
const finalReport = path.join(root, 'output', 'qa', 'bundled-runtime-report.json');
const marker = 'bundled-runtime-fixture-not-a-real-api-key';
const sessionId = randomUUID();
const sessionFile = path.join(agent, 'sessions', `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, 'restored-session.jsonl');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => String(text).replace(/ws:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]+/g, '[local inspector]').replaceAll(marker, '[fixture credential]');

await access(executable);
for (const directory of [project, agent, desktop, fakeHome, path.dirname(sessionFile), path.join(qaRoot, 'appdata'), path.join(qaRoot, 'localappdata'), path.join(qaRoot, 'program-files')]) await mkdir(directory, { recursive: true });
await writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: {
  'bundled-fixture': {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: marker,
    headers: { 'x-fixture-private': marker },
    models: [{ id: 'runtime-model', name: '内置运行时验收模型', reasoning: true, input: ['text'], contextWindow: 64000, maxTokens: 2048, headers: { 'x-model-private': marker } }],
  },
} }, null, 2));
await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'bundled-fixture', defaultModel: 'runtime-model', defaultThinkingLevel: 'off' }));
const now = new Date().toISOString();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const entries = [
  { type: 'session', version: 3, id: sessionId, cwd: project, timestamp: now },
  { type: 'model_change', id: 'model', parentId: null, timestamp: now, provider: 'bundled-fixture', modelId: 'runtime-model' },
  { type: 'thinking_level_change', id: 'thinking', parentId: 'model', timestamp: now, thinkingLevel: 'off' },
  { type: 'message', id: 'user', parentId: 'thinking', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: '恢复已有的中文验收会话。' }], timestamp: Date.now() } },
  { type: 'message', id: 'assistant', parentId: 'user', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'RESTORE_FIXTURE_OK：这是预先保存的会话，未调用模型。' }], api: 'openai-completions', provider: 'bundled-fixture', model: 'runtime-model', usage, stopReason: 'stop', timestamp: Date.now() } },
  { type: 'session_info', id: 'name', parentId: 'assistant', timestamp: now, name: '内置运行时恢复验收' },
];
await writeFile(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
await writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: project, name: path.basename(project), lastOpened: now }], lastProject: project, lastSessions: { [project]: sessionFile } }));

// Start from an allowlist; global API keys, npm/Git configuration and NVM roots
// are deliberately not copied into the application under test.
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const env = {
  SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
  PATH: [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
  PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: process.env.TEMP || qaRoot, TMP: process.env.TMP || qaRoot,
  USERPROFILE: fakeHome, HOME: fakeHome, APPDATA: path.join(qaRoot, 'appdata'), LOCALAPPDATA: path.join(qaRoot, 'localappdata'),
  ProgramFiles: path.join(qaRoot, 'program-files'), 'ProgramFiles(x86)': path.join(qaRoot, 'program-files-x86'), ProgramW6432: path.join(qaRoot, 'program-files'),
  PI_CODING_AGENT_DIR: agent, PI_DESKTOP_USER_DATA: desktop, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
  PI_DESKTOP_QA_ROOT: qaRoot, PI_DESKTOP_QA_PROJECT: project, PI_DESKTOP_QA_REPORT: reportPath,
  PI_DESKTOP_QA_EXECUTABLE: executable, PI_DESKTOP_QA_SESSION: sessionFile, PI_DESKTOP_QA_SESSION_ID: sessionId,
  PI_DESKTOP_QA_NODE_VERSION: process.env.PI_DESKTOP_QA_NODE_VERSION || 'v22.23.3',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fakeHome, '.gitconfig'),
  LANG: 'C.UTF-8', NO_COLOR: '1', FORCE_COLOR: '0',
};

let child;
let socket;
let exited = false;
let exitCode;
let nextId = 1;
const pending = new Map();
let stderr = '';
let deadline;
let endpointResolve;
let endpointReject;
const endpointReady = new Promise((resolve, reject) => { endpointResolve = resolve; endpointReject = reject; });
const childExit = new Promise(resolve => {
  child = spawn(executable, ['--inspect-brk=127.0.0.1:0', '--disable-gpu'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.once('error', error => { endpointReject(error); resolve(null); });
  child.once('exit', code => { exited = true; exitCode = code; endpointReject(new Error('Packaged application exited before QA attachment')); resolve(code); });
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr = (stderr + redact(text)).slice(-12000);
    const match = text.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
    if (match) endpointResolve(match[1]);
  });
  // Inspector endpoints and child diagnostics are kept private; only the final
  // structured report is printed after credential and endpoint redaction.
  child.stdout.on('data', () => {});
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Main inspector command timed out: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function stopOwnedChild() {
  if (exited || !child?.pid) return;
  // The PID comes only from this runner's spawn; no existing client is searched.
  await new Promise(resolve => {
    const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', resolve); killer.once('exit', resolve);
  });
}

try {
  const expiry = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Bundled runtime acceptance exceeded 180 seconds')), 180_000); });
  await Promise.race([(async () => {
    const endpoint = await endpointReady;
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Cannot attach to the spawned application inspector')), { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    await rpc('Runtime.enable');
    await rpc('Runtime.runIfWaitingForDebugger');
    const harness = path.join(root, 'scripts', 'bundled-runtime-smoke.cjs');
    let attached = false;
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      const result = await rpc('Runtime.evaluate', { expression: `(() => { const load = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule); if (!load) return false; load(${JSON.stringify(harness)}); return true; })()`, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      if (result.result?.value === true) { attached = true; break; }
      await delay(100);
    }
    assert.ok(attached, 'QA harness must attach to the actual packaged main process');
    // Once listeners are installed, detach. This avoids Node waiting for an
    // attached debugger while the application exits at the end of its checks.
    socket.close();
    await childExit;
  })(), expiry]);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(exitCode, 0, 'packaged QA process must exit successfully');
  assert.equal(report.success, true, 'bundled runtime acceptance must succeed');
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!serialized.includes(marker), 'report must not contain fixture credentials');
  await mkdir(path.dirname(finalReport), { recursive: true });
  await writeFile(finalReport, serialized);
  console.log(serialized);
} catch (error) {
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch {}
  report ||= { checks: [], errors: [], success: false, profile: qaRoot };
  report.errors.push(redact(error.stack || String(error)));
  report.success = false;
  if (!report.checks.length) report.launchDiagnostics = stderr;
  await mkdir(path.dirname(finalReport), { recursive: true });
  await writeFile(finalReport, JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  socket?.close();
  await stopOwnedChild();
}
