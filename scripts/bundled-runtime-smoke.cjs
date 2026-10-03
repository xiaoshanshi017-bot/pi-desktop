// Loaded by the private QA runner into its own packaged application's main
// process. This file is not shipped and never imports or replaces product main.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('original-fs');
const path = require('node:path');

const qaRoot = process.env.PI_DESKTOP_QA_ROOT;
const project = process.env.PI_DESKTOP_QA_PROJECT;
const reportPath = process.env.PI_DESKTOP_QA_REPORT;
const executable = process.env.PI_DESKTOP_QA_EXECUTABLE;
const sessionFile = process.env.PI_DESKTOP_QA_SESSION;
const sessionId = process.env.PI_DESKTOP_QA_SESSION_ID;
const expectedNode = process.env.PI_DESKTOP_QA_NODE_VERSION;
const secret = 'bundled-runtime-fixture-not-a-real-api-key';
assert.ok(qaRoot && project && reportPath && executable && sessionFile && sessionId, 'This harness requires the isolated bundled-runtime runner');
assert.equal(path.dirname(path.resolve(reportPath)), path.resolve(qaRoot));
const runtime = path.join(path.dirname(executable), 'resources', 'runtime');
const report = { started: new Date().toISOString(), profile: qaRoot, checks: [], errors: [], versions: {}, success: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = value => path.resolve(value).toLowerCase();
// A local update may share the verified runtime through a directory junction.
// Compare physical paths so Git Bash's canonical executable path has the same
// ownership check as Node's path through the alias.
const withinRuntime = value => key(fs.realpathSync(value)).startsWith(key(fs.realpathSync(runtime)) + path.sep);
let window;
let started = false;
let finishing = false;
const timer = setTimeout(() => void finish(new Error('Packaged runtime checks exceeded 140 seconds')), 140_000);

async function evaluate(source, timeout = 20_000) {
  assert.ok(window && !window.isDestroyed(), 'Packaged application window must remain alive');
  let deadline;
  try {
    const result = await Promise.race([
      window.webContents.executeJavaScript(`(async () => { try { return { ok: true, value: await (${source}) }; } catch (error) { return { ok: false, message: error?.message || String(error) }; } })()`, true),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Renderer/IPC request timed out')), timeout); }),
    ]);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  } finally { clearTimeout(deadline); }
}

async function waitForConnection() {
  const until = Date.now() + 65_000;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(window.pi) && Boolean(document.querySelector('.connection-pill.connected')) && Boolean(document.querySelector('.model-picker-trigger:not(:disabled)'))`)) return;
    const error = await evaluate(`document.querySelector('.notice.error')?.innerText || ''`);
    if (error) throw new Error(`Packaged startup failed: ${error}`);
    await delay(100);
  }
  throw new Error('Packaged app did not connect using bundled tools');
}

function assertNoCredential(value) {
  assert.ok(!JSON.stringify(value).includes(secret), 'Renderer bridge must not expose provider credentials or private headers');
}

async function run() {
  assert.equal(app.isPackaged, true, 'must test the real packaged application, not a development override');
  assert.equal(key(process.execPath), key(executable));
  assert.equal(key(process.resourcesPath), key(path.join(path.dirname(executable), 'resources')));
  assert.equal(key(app.getPath('userData')), key(path.join(qaRoot, 'desktop')));
  const pathEntry = Object.keys(process.env).find(name => name.toLowerCase() === 'path');
  const inheritedPath = process.env[pathEntry] || '';
  assert.ok(!/nodejs|\\git\\|\\npm(?:;|$)/i.test(inheritedPath), 'application PATH must not contain globally installed developer tools');
  assert.ok(key(process.env.APPDATA).startsWith(key(qaRoot) + path.sep));
  assert.ok(key(process.env.ProgramFiles).startsWith(key(qaRoot) + path.sep));
  report.checks.push('Actual packaged executable and resources directory run with an isolated profile and system developer tools removed from discovery');
  await waitForConnection();
  const bootstrap = await evaluate('window.pi.bootstrap()');
  assertNoCredential(bootstrap);
  const diagnostics = bootstrap.diagnostics;
  assert.deepEqual(diagnostics.errors, []);
  for (const name of ['pi', 'node', 'bash']) {
    assert.equal(diagnostics[`${name}Source`], 'bundled', `${name} must resolve from bundled resources`);
    assert.ok(withinRuntime(diagnostics[`${name}Path`]), `${name} path must stay inside the packaged runtime`);
  }
  assert.equal(key(diagnostics.runtimeRoot), key(runtime));
  assert.equal(diagnostics.piVersion, '0.84.2');
  assert.equal(diagnostics.nodeVersion, expectedNode);
  report.versions.pi = diagnostics.piVersion;
  report.versions.node = diagnostics.nodeVersion;
  report.runtimeRoot = runtime;
  report.checks.push('Diagnostics selects bundled Pi 0.84.2, the pinned Node release and bundled Git Bash');

  const state = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  const messages = (await evaluate(`window.pi.rpc({ type: 'get_messages' })`)).messages;
  const models = await evaluate(`window.pi.rpc({ type: 'get_available_models' })`);
  assertNoCredential([state, models, messages]);
  assert.equal(state.model.provider, 'bundled-fixture');
  assert.equal(state.model.id, 'runtime-model');
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.sessionName, '内置运行时恢复验收');
  assert.ok(JSON.stringify(messages).includes('RESTORE_FIXTURE_OK'));
  const assistantCount = messages.filter(message => message.role === 'assistant').length;
  report.checks.push('Packaged Pi starts offline and restores the existing Chinese-path session without model requests or credential leakage');

  const command = [
    'set -euo pipefail',
    "mkdir -p '中文 空格目录'",
    "printf 'BASH_MARKER：中文写入\\n' > '中文 空格目录/测试 文件.txt'",
    `node -e 'const fs=require("node:fs"); fs.appendFileSync("中文 空格目录/测试 文件.txt", "NODE_MARKER：内置 Node 写入\\n"); process.stdout.write("QA_NODE_EXEC="+process.execPath+"\\n")'`,
    'for tool in node npm git rg fd; do',
    '  printf "QA_TOOL_%s=" "$tool"',
    '  cygpath -w "$(command -v "$tool")"',
    'done',
    "printf 'QA_NODE_VERSION='", 'node --version',
    "printf 'QA_NPM_VERSION='", 'npm --version',
    "printf 'QA_GIT_VERSION='", 'git --version',
    "printf 'QA_RG_VERSION='", 'rg --version',
    "printf 'QA_FD_VERSION='", 'fd --version',
    "git -C '中文 空格目录' -c init.defaultBranch=main init --quiet",
    "git -C '中文 空格目录' status --porcelain",
    "rg --fixed-strings 'NODE_MARKER' '中文 空格目录/测试 文件.txt'",
    "fd --hidden --glob '测试 文件.txt' '中文 空格目录'",
    "printf 'QA_BASH_DONE\\n'",
  ].join('\n');
  const bash = await evaluate(`window.pi.rpc(${JSON.stringify({ type: 'bash', command, excludeFromContext: false })})`, 60_000);
  assertNoCredential(bash);
  assert.equal(bash.exitCode, 0, `Bundled bash command failed: ${bash.output}`);
  assert.ok(bash.output.includes('QA_BASH_DONE'));
  const toolPaths = {};
  for (const tool of ['node', 'npm', 'git', 'rg', 'fd']) {
    const line = bash.output.split(/\r?\n/).find(value => value.startsWith(`QA_TOOL_${tool}=`));
    assert.ok(line, `${tool} must be discoverable inside bundled Bash`);
    const resolved = line.slice(line.indexOf('=') + 1).trim();
    assert.ok(withinRuntime(resolved), `${tool} must use bundled runtime, got ${resolved}`);
    toolPaths[tool] = resolved;
  }
  const nodeExec = bash.output.split(/\r?\n/).find(value => value.startsWith('QA_NODE_EXEC='))?.slice('QA_NODE_EXEC='.length);
  assert.equal(key(nodeExec), key(diagnostics.nodePath));
  assert.ok(bash.output.includes(`QA_NODE_VERSION=${expectedNode}`));
  for (const tool of ['NPM', 'GIT', 'RG', 'FD']) report.versions[tool.toLowerCase()] = bash.output.split(/\r?\n/).find(value => value.startsWith(`QA_${tool}_VERSION=`))?.split('=').slice(1).join('=');
  report.toolPaths = toolPaths;
  const contents = fs.readFileSync(path.join(project, '中文 空格目录', '测试 文件.txt'), 'utf8');
  assert.equal(contents, 'BASH_MARKER：中文写入\nNODE_MARKER：内置 Node 写入\n');
  report.checks.push('Real bundled Bash and Node write/read a Chinese filename containing spaces; npm, git, rg and fd all execute from packaged resources');

  const beforeReconnect = (await evaluate(`window.pi.rpc({ type: 'get_messages' })`)).messages;
  assert.equal(beforeReconnect.filter(message => message.role === 'assistant').length, assistantCount, 'no new assistant generation may be requested');
  assert.ok(beforeReconnect.some(message => message.role === 'bashExecution'), 'real Bash execution should persist in session context');
  await evaluate('window.pi.disconnect()');
  const restored = await evaluate(`window.pi.connect(${JSON.stringify(project)}, ${JSON.stringify(sessionFile)})`, 65_000);
  assertNoCredential(restored);
  assert.equal(restored.state.sessionId, sessionId);
  assert.deepEqual(restored.messages, beforeReconnect);
  assert.equal(restored.state.isStreaming, false);
  report.checks.push('A fresh bundled Pi process restores the same persisted messages and Bash execution without contacting a model');
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(200);
  const screenshot = path.resolve(__dirname, '..', 'output', 'playwright', 'bundled-runtime.png');
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  report.screenshots = [screenshot];
  await finish();
}

async function finish(error) {
  if (finishing) return;
  finishing = true; clearTimeout(timer);
  if (error) report.errors.push(String(error.stack || error).replaceAll(secret, '[fixture credential]'));
  if (window && !window.isDestroyed()) {
    try { await evaluate('window.pi?.disconnect()', 12_000); report.checks.push('Only the isolated QA Pi process is disconnected before the packaged app exits'); }
    catch (cleanup) { report.errors.push(`Cleanup: ${cleanup.message}`); }
  }
  report.finished = new Date().toISOString();
  report.success = report.errors.length === 0;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  app.exit(report.success ? 0 : 1);
}

function attach(created) {
  if (window || created.isDestroyed()) return;
  window = created;
  created.webContents.setBackgroundThrottling(false);
  const start = () => { if (!started) { started = true; void run().catch(finish); } };
  if (!created.webContents.isLoadingMainFrame() && created.webContents.getURL()) start();
  else created.webContents.once('did-finish-load', start);
}
app.on('browser-window-created', (_event, created) => attach(created));
for (const created of BrowserWindow.getAllWindows()) attach(created);
module.exports = { installed: true };
