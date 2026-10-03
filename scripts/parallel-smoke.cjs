// Real Electron / sandboxed preload / IPC / Pi acceptance. All model calls stay
// on localhost and every run gets its own profile, sessions and projects.
const { app } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, 'output', 'qa', 'parallel');
const runRoot = path.join(qaRoot, `run-${Date.now()}`);
const projectA = path.join(runRoot, '并行项目 A');
const projectB = path.join(runRoot, '并行项目 B');
const agent = path.join(runRoot, 'agent');
const desktop = path.join(runRoot, 'desktop');
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { started: new Date().toISOString(), runRoot, checks: [], errors: [], screenshots: [], requests: [] };
let mainWindow;
let server;
let finishing = false;
const deadline = setTimeout(() => void finish(new Error('Parallel acceptance exceeded 240 seconds')), 240_000);

async function evaluate(source) {
  try { return await mainWindow.webContents.executeJavaScript(source, true); }
  catch (error) { error.message += `\nRenderer source: ${source}`; throw error; }
}
async function waitFor(label, source, timeout = 35_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(source)) return;
    await delay(100);
  }
  const ui = await evaluate('document.body.innerText.slice(-10000)');
  throw new Error(`Timed out: ${label}. UI: ${ui}`);
}
async function connections() {
  const value = await evaluate('window.pi.listConnections()');
  return Array.isArray(value) ? value : value.connections;
}
async function screenshot(name) {
  const file = path.join(root, 'output', 'playwright', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await delay(120); // Capture after React has painted the latest UI interaction.
  const capture = await mainWindow.webContents.capturePage();
  assert.ok(!capture.isEmpty());
  await fs.writeFile(file, capture.toPNG());
  report.screenshots.push(file);
}
async function draft(text) {
  await evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="输入消息"]');
    if (!input) throw new Error('Composer is absent');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}
async function send(id, prompt) {
  await evaluate(`window.__parallelOffsets[${JSON.stringify(id)}] = window.__parallelEvents.length`);
  await draft(prompt);
  await waitFor('enabled independent composer', `Boolean(document.querySelector('button[aria-label="发送消息"]:not(:disabled)'))`);
  await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
}
function tabExpression(id) {
  return `[...document.querySelectorAll('.active-conversations [data-connection-id]')].find(node => node.dataset.connectionId === ${JSON.stringify(id)})`;
}
async function activate(id) {
  await waitFor(`conversation tab ${id}`, `Boolean(${tabExpression(id)})`);
  await evaluate(`(() => { const node = ${tabExpression(id)}; (node.matches('[role="tab"]') ? node : node.querySelector('[role="tab"]')).click(); })()`);
  await waitFor(`active conversation ${id}`, `(() => { const node = ${tabExpression(id)}; return Boolean(node && (node.getAttribute('aria-selected') === 'true' || node.querySelector('[role="tab"][aria-selected="true"]'))); })()`);
  await waitFor('conversation ready', `Boolean(document.querySelector('.connection-pill.connected')) && Boolean(document.querySelector('textarea[aria-label="输入消息"]:not(:disabled)'))`);
}
async function settled(id, timeout = 35_000) {
  await waitFor(`connection ${id} settles`, `window.__parallelEvents.slice(window.__parallelOffsets[${JSON.stringify(id)}] || 0).some(event => event.connectionId === ${JSON.stringify(id)} && event.type === 'agent_settled')`, timeout);
}
async function messages(id) {
  const reply = await evaluate(`window.pi.rpc({type:'get_messages'}, ${JSON.stringify(id)})`);
  return JSON.stringify(reply.messages);
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) {
    report.errors.push(error.stack || String(error));
    console.error(error);
    try { await screenshot('parallel-failure.png'); } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await evaluate(`(async () => {
        const value = await window.pi.listConnections();
        for (const connection of (Array.isArray(value) ? value : value.connections)) {
          try { await window.pi.rpc({type:'abort'}, connection.id); } catch {}
          try { await window.pi.disconnect(connection.id); } catch {}
        }
      })()`);
    } catch (cleanupError) { report.errors.push(cleanupError.message); }
  }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  report.success = report.errors.length === 0;
  report.finished = new Date().toISOString();
  await fs.mkdir(qaRoot, { recursive: true });
  await fs.writeFile(path.join(qaRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.success ? 0 : 1);
}

async function run() {
  await waitFor('isolated Pi connection', `Boolean(document.querySelector('.connection-pill.connected')) && !document.querySelector('.new-chat').disabled`, 75_000);
  const boot = await evaluate('window.pi.bootstrap()');
  assert.equal(path.resolve(boot.diagnostics.agentDir), agent);
  assert.equal(await evaluate(`Boolean(document.querySelector('.inspector'))`), false, 'details are hidden by default');
  const initial = await connections();
  assert.equal(initial.length, 1);
  const a = initial[0].id;
  assert.equal((await evaluate(`window.pi.rpc({type:'get_state'}, ${JSON.stringify(a)})`)).model.provider, 'parallel-fixture');
  await evaluate(`(() => {
    window.__parallelEvents = [];
    window.__parallelOffsets = {};
    window.pi.onEvent(event => window.__parallelEvents.push({type:event.type, connectionId:event.connectionId, project:event.project, toolName:event.toolName, isError:event.isError}));
    return true;
  })()`);
  report.checks.push('Actual Electron, sandboxed preload, IPC and Pi use an isolated localhost-only model; details are hidden initially');

  await send(a, '[parallel-A] 运行 A 的检查，期间允许继续在另一个会话提问。');
  await waitFor('A running real Bash', `[...document.querySelectorAll('.tool-live-preview pre')].some(node => node.textContent.includes('A_TOOL_BEGIN')) && document.querySelector('.run-progress')?.dataset.phase === 'tool'`);
  assert.equal(await evaluate(`document.querySelector('.new-chat').disabled`), false, 'new conversation remains available while A runs');
  await draft('A 独立草稿：待会补充检查结果');
  await evaluate(`document.querySelector('.new-chat').click()`);
  await waitFor('second connection tab', `document.querySelectorAll('.active-conversations [role="tab"]').length === 2`, 50_000);
  const afterNew = await connections();
  const b = afterNew.find(connection => connection.id !== a)?.id;
  assert.ok(b, 'UI new chat creates a second independent connection');
  await activate(b);
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`), '', 'new conversation does not inherit A draft');
  await send(b, '[parallel-B] 独立回答 B，不能等待 A 完成。');
  await settled(b);
  await waitFor('B independent answer', `document.querySelector('.messages')?.textContent.includes('B_INDEPENDENT_DONE')`);
  assert.equal((await connections()).find(connection => connection.id === a).busy, true, 'A is still executing when B finishes');
  await fs.writeFile(path.join(projectA, 'parallel-a-release'), 'B completed independently; acceptance now releases A\n');
  assert.doesNotMatch(await messages(b), /A_TOOL_BEGIN|A_TOOL_END|A_COMPLETED/);
  assert.match(await messages(b), /B_INDEPENDENT_DONE/);
  assert.equal(await evaluate(`document.querySelector('.messages').textContent.includes('A_TOOL_BEGIN')`), false);
  await draft('B 独立草稿：不要混入 A');
  await screenshot('parallel-workbench.png');
  report.checks.push('UI creates B while A runs a real bounded Bash; B answers independently before A completes, with no A content');

  await settled(a);
  await waitFor('background A completion badge', `Boolean(${tabExpression(a)}?.querySelector('.conversation-unread'))`);
  const stateB = await evaluate(`window.pi.rpc({type:'get_state'}, ${JSON.stringify(b)})`);
  assert.ok(stateB.sessionFile, 'B has a durable session to restore');
  await waitFor('selected B restore target recorded', `(async () => (await window.pi.bootstrap()).preferences.lastSessions?.[${JSON.stringify(projectA)}] === ${JSON.stringify(stateB.sessionFile)})()`);
  assert.ok(await evaluate(`Boolean(${tabExpression(b)}?.querySelector('[role="tab"][aria-selected="true"]'))`), 'background completion keeps B selected');
  report.checks.push('A background completion preserves the selected B tab and its persisted restore target');
  await activate(a);
  await waitFor('A draft restored', `document.querySelector('textarea[aria-label="输入消息"]').value === 'A 独立草稿：待会补充检查结果'`);
  await waitFor('A complete transcript restored', `document.querySelector('.messages')?.textContent.includes('A_TOOL_END') && document.querySelector('.messages')?.textContent.includes('A_COMPLETED') && document.querySelector('.run-progress')?.dataset.phase === 'complete'`);
  assert.match(await messages(a), /ACTUAL_PROJECT_A/);
  const completedA = await evaluate(`window.pi.rpc({type:'get_messages'}, ${JSON.stringify(a)})`);
  assert.ok(completedA.messages.some(message => message.role === 'toolResult' && !message.isError && JSON.stringify(message.content).includes('A_TOOL_END')), 'A really completes its Bash rather than only showing the marker in the command argument');
  assert.equal(await evaluate(`document.querySelector('.messages').textContent.includes('B_INDEPENDENT_DONE')`), false);
  await evaluate(`document.querySelector('.progress-toggle').click()`);
  await waitFor('restored completed execution record', `Boolean(document.querySelector('.progress-meta'))`);
  assert.match(await evaluate(`document.querySelector('.progress-meta').textContent`), /已结束 1 次工具调用/);
  await evaluate(`document.querySelector('.progress-toggle').click()`);
  await activate(b);
  await waitFor('B draft restored', `document.querySelector('textarea[aria-label="输入消息"]').value === 'B 独立草稿：不要混入 A'`);
  report.checks.push('Background A completion sets an unread badge; switching tabs restores each draft, transcript, tool output and completed progress');

  const stateA = await evaluate(`window.pi.rpc({type:'get_state'}, ${JSON.stringify(a)})`);
  assert.ok(stateA.sessionFile && path.resolve(stateA.sessionFile).startsWith(agent + path.sep));
  const beforeReuse = (await connections()).length;
  const resumed = await evaluate(`window.pi.connect(${JSON.stringify(projectA)}, ${JSON.stringify(stateA.sessionFile)})`);
  assert.equal(resumed.connectionId, a, 'opening the same JSONL reuses its existing process');
  assert.equal((await connections()).length, beforeReuse);
  await activate(a);
  assert.match(await messages(a), /A_COMPLETED/);
  report.checks.push('Opening an already running JSONL reuses its connection without spawning a duplicate process');

  await send(a, '[parallel-stop-A] 运行 A 的长检查，接下来只停止 A。');
  await waitFor('A second Bash started', `[...document.querySelectorAll('.tool-live-preview pre')].some(node => node.textContent.includes('A_STOP_BEGIN')) && document.querySelector('.run-progress')?.dataset.phase === 'tool'`);
  const otherProject = await evaluate(`window.pi.connect(${JSON.stringify(projectB)}, undefined, {newSession:true})`);
  const c = otherProject.connectionId;
  assert.ok(c && c !== a && c !== b);
  await activate(c);
  await send(c, '[parallel-keep-B] 在项目 B 独立运行检查。');
  await waitFor('other project real Bash started', `[...document.querySelectorAll('.tool-live-preview pre')].some(node => node.textContent.includes('B_PROJECT_BEGIN')) && document.querySelector('.run-progress')?.dataset.phase === 'tool'`);
  const simultaneous = await connections();
  assert.equal(simultaneous.find(connection => connection.id === a).busy, true);
  assert.equal(simultaneous.find(connection => connection.id === c).busy, true);
  assert.notEqual(simultaneous.find(connection => connection.id === a).project, simultaneous.find(connection => connection.id === c).project);
  report.checks.push('Two distinct projects execute real Bash concurrently in separate Pi processes');

  await activate(a);
  await evaluate(`document.querySelector('.stop-button').click()`);
  await settled(a);
  await waitFor('only A interrupted', `document.querySelector('.run-progress')?.dataset.phase === 'interrupted' && !document.querySelector('.activity-line')`);
  assert.equal((await connections()).find(connection => connection.id === c).busy, true, 'stopping A does not stop project B');
  const aAfterStop = await messages(a);
  // The command argument contains A_STOP_SHOULD_NOT_APPEAR, so inspect the
  // successful tool result rather than the whole conversation string.
  const stopResult = await evaluate(`window.pi.rpc({type:'get_messages'}, ${JSON.stringify(a)})`);
  assert.equal(stopResult.messages.some(message => message.role === 'toolResult' && JSON.stringify(message.content).includes('A_STOP_SHOULD_NOT_APPEAR')), false);
  assert.match(aAfterStop, /A_STOP_BEGIN/);
  await activate(c);
  await screenshot('parallel-two-projects.png');
  await settled(c);
  await waitFor('unaffected project B finishes', `document.querySelector('.messages')?.textContent.includes('B_PROJECT_END') && document.querySelector('.messages')?.textContent.includes('B_PROJECT_COMPLETED') && document.querySelector('.run-progress')?.dataset.phase === 'complete'`);
  assert.match(await messages(c), /ACTUAL_PROJECT_B/);
  assert.doesNotMatch(await messages(c), /A_TOOL_BEGIN|A_STOP_BEGIN|A_COMPLETED/);
  report.checks.push('Stopping A through the UI targets A alone; project B continues, finishes, and retains its own transcript');

  mainWindow.setSize(960, 680);
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await delay(250);
  assert.ok(await evaluate(`(() => {
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const tabs = document.querySelector('.active-conversations').getBoundingClientRect();
    const input = document.querySelector('textarea[aria-label="输入消息"]').getBoundingClientRect();
    return composer.top >= 0 && composer.bottom <= innerHeight && input.width >= 250 && tabs.top >= 0 && tabs.right <= innerWidth;
  })()`), 'conversation switcher and composer fit at 960×680');
  await screenshot('parallel-small-dark.png');
  report.checks.push('The conversation switcher and composer remain usable at 960×680 in the dark theme');

  const tagged = await evaluate(`window.__parallelEvents.filter(event => ['agent_start','agent_settled','tool_execution_start','tool_execution_end'].includes(event.type))`);
  assert.ok(tagged.length >= 10);
  assert.ok(tagged.every(event => event.connectionId && event.project), 'every agent/tool event identifies its origin');
  assert.ok(report.requests.every(request => request.model === 'parallel-fixture'));
  report.checks.push('Every observed agent/tool event carries its connection and project; all completion requests use the local fixture');
  await finish();
}

async function start() {
  await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true }), fs.mkdir(agent, { recursive: true }), fs.mkdir(desktop, { recursive: true })]);
  await Promise.all([fs.writeFile(path.join(projectA, 'project-marker.txt'), 'ACTUAL_PROJECT_A\n'), fs.writeFile(path.join(projectB, 'project-marker.txt'), 'ACTUAL_PROJECT_B\n')]);
  await fs.writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: projectA, name: '并行项目 A', lastOpened: new Date().toISOString() }, { path: projectB, name: '并行项目 B', lastOpened: new Date().toISOString() }], lastProject: projectA }));
  server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const userIndex = body.messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(body.messages[userIndex]?.content);
      const toolCount = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool').length;
      const scenario = ['parallel-stop-A', 'parallel-keep-B', 'parallel-A', 'parallel-B'].find(marker => prompt.includes(`[${marker}]`));
      assert.ok(scenario, 'all model requests are controlled fixture prompts');
      report.requests.push({ model: body.model, scenario, toolCount, at: new Date().toISOString() });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'parallel-fixture', object: 'chat.completion.chunk', created: 1, model: 'parallel-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant' });
      if (toolCount === 0 && scenario !== 'parallel-B') {
        emit({ content: scenario === 'parallel-keep-B' ? '我将在项目 B 执行检查，其他会话继续运行。\n' : '我先执行 A 的检查，实时显示命令输出。\n' });
        await delay(150);
        // A stays alive across slow cold starts of B. The bounded handshake
        // proves real overlap without relying on process startup taking <10s.
        const command = scenario === 'parallel-stop-A' ? "printf 'A_STOP_BEGIN\\n'; sleep 35; printf 'A_STOP_SHOULD_NOT_APPEAR\\n'" : scenario === 'parallel-keep-B' ? "printf 'B_PROJECT_BEGIN\\n'; cat project-marker.txt; sleep 10; printf 'B_PROJECT_END\\n'" : "printf 'A_TOOL_BEGIN\\n'; cat project-marker.txt; sleep 6; for ((attempt=0; attempt<250; attempt++)); do if [[ -f parallel-a-release ]]; then sleep 2; printf 'A_TOOL_END\\n'; exit 0; fi; sleep 0.1; done; printf 'Fixture timed out waiting for B\\n' >&2; exit 8";
        emit({ tool_calls: [{ index: 0, id: `parallel_${report.requests.length}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, timeout: 45 }) } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ content: scenario === 'parallel-B' ? 'B_INDEPENDENT_DONE：B 的独立回答已完成。' : scenario === 'parallel-keep-B' ? 'B_PROJECT_COMPLETED：项目 B 的检查已完成。' : scenario === 'parallel-stop-A' ? 'A_STOP_ACKNOWLEDGED：A 的检查已停止。' : 'A_COMPLETED：A 的检查已完成，日志完整。' });
        emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      report.errors.push(error.stack || String(error));
      response.destroy(error);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await fs.writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'parallel-fixture': { baseUrl, api: 'openai-completions', apiKey: 'local-fixture', models: [{ id: 'parallel-fixture', name: '本地并行验收模型', reasoning: false, contextWindow: 32000, maxTokens: 2048 }] } } }));
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'parallel-fixture', defaultModel: 'parallel-fixture', defaultThinkingLevel: 'off' }));
  app.on('browser-window-created', (_event, created) => {
    if (mainWindow) return;
    mainWindow = created;
    created.webContents.setBackgroundThrottling(false);
    created.webContents.once('did-finish-load', () => { void run().catch(finish); });
    created.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') report.errors.push(details.message); });
  });
  require(path.join(root, 'dist-electron', 'main.cjs'));
}

process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));
void start().catch(finish);
