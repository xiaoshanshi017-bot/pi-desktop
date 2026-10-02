// Development-only acceptance harness. Runs the real built Electron application
// with its sandboxed preload and IPC; no debug ports or mocked window.pi.
// First start scripts/qa-fixture.mjs, then launch this file with Electron.
const { app } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, 'output', 'qa');
const project = path.join(qaRoot, '离线验收项目');
const screenshots = path.join(root, 'output', 'playwright');
const agent = path.join(qaRoot, 'agent');
const desktop = path.join(qaRoot, 'desktop');
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

const report = { started: new Date().toISOString(), checks: [], screenshots: [], errors: [], rendererErrors: [] };
let mainWindow;
let finishing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => void finish(new Error('Electron smoke test exceeded 180 seconds.')), 180_000);

async function evaluate(source, timeout = 10_000) {
  assert.ok(mainWindow && !mainWindow.isDestroyed(), 'Application window must be alive');
  let timer;
  try {
    return await Promise.race([
      mainWindow.webContents.executeJavaScript(source, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer evaluation timed out.')), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function waitFor(label, source, timeout = 30_000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { const result = await evaluate(source); if (result) return result; } catch (error) { lastError = error; }
    await delay(150);
  }
  let details = '';
  try { details = await evaluate(`document.querySelector('.notice')?.innerText || document.querySelector('.connection-pill')?.innerText || document.body.innerText.slice(0, 1000)`); } catch {}
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` ${lastError.message}` : ''}${details ? ` UI: ${details}` : ''}`);
}

async function screenshot(name) {
  await fs.mkdir(screenshots, { recursive: true });
  // Force layout without requestAnimationFrame: Windows may occlude the QA window.
  await evaluate('document.body.getBoundingClientRect().toJSON()');
  const file = path.join(screenshots, name);
  let image;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { image = await mainWindow.webContents.capturePage(); break; }
    catch (error) { if (attempt === 2) throw error; await delay(300); }
  }
  assert.ok(!image.isEmpty(), 'Screenshot must contain pixels');
  await fs.writeFile(file, image.toPNG());
  report.screenshots.push(file);
}

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) {
    report.errors.push(error.stack || String(error));
    console.error('[electron-smoke]', error.stack || error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { await screenshot('electron-failure.png'); } catch {}
      try { report.uiAtFailure = await evaluate('document.body.innerText.slice(0, 12000)'); } catch {}
    }
  }
  // Stop the actual RPC subprocess before Electron exits. Closing the parent's
  // pipes is an additional fallback if the renderer already crashed.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await evaluate(`(async () => {
        if (!window.pi) return;
        try { await window.pi.rpc({ type: 'abort' }); } catch {}
        await window.pi.disconnect();
      })()`, 8000);
      report.checks.push('RPC process disconnected cleanly');
    } catch (cleanupError) {
      report.errors.push(`Cleanup: ${cleanupError.message}`);
    }
  }
  report.finished = new Date().toISOString();
  report.success = !report.errors.length;
  await fs.mkdir(qaRoot, { recursive: true });
  await fs.writeFile(path.join(qaRoot, 'electron-smoke-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.success ? 0 : 1);
}

async function run() {
  await waitFor('sandbox preload', `typeof window.pi?.bootstrap === 'function'`);
  const boot = await evaluate('window.pi.bootstrap()');
  assert.equal(path.resolve(boot.diagnostics.agentDir), agent, 'Pi config must be isolated to the fixture');
  assert.deepEqual(boot.diagnostics.errors, [], 'Real environment discovery must succeed');
  assert.equal(path.resolve(boot.preferences.lastProject), project);
  report.checks.push('Real preload bootstrap and runtime discovery');

  await waitFor('automatic project connection', `document.querySelector('.connection-pill.connected')?.textContent.includes('已连接') && !document.querySelector('.new-chat')?.disabled`, 75_000);
  const firstState = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  assert.equal(firstState.model.provider, 'local-qa', 'Only the local fixture provider is allowed');
  assert.equal(firstState.model.id, 'local-qa');
  report.checks.push('Project automatically connects through real IPC to local Pi');
  const startup = await evaluate('window.pi.bootstrap()');
  assert.equal(startup.preferences.lastSessions?.[project], undefined, 'Deleted restore target must be cleared');
  report.checks.push('Missing saved session recovers to a new conversation without repeated startup errors');

  // Always begin an empty conversation so repeated harness runs remain reliable.
  await evaluate(`document.querySelector('.new-chat').click()`);
  await waitFor('fresh conversation', `(async () => {
    const state = await window.pi.rpc({ type: 'get_state' });
    return state.sessionId !== ${JSON.stringify(firstState.sessionId)} &&
      !document.querySelector('.new-chat')?.disabled && !document.querySelector('.message');
  })()`);
  await screenshot('electron-welcome.png');

  await evaluate(`(() => {
    window.__piDesktopSmoke = { events: [] };
    window.pi.onEvent(event => window.__piDesktopSmoke.events.push({
      type: event.type, toolName: event.toolName, isError: event.isError,
      deltaType: event.assistantMessageEvent?.type,
    }));
    return true;
  })()`);
  const prompt = '请读取项目中的说明.txt，并用中文总结。请保留 Markdown 列表与代码示例。';
  await evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="输入消息"]');
    if (!input) throw new Error('Message composer not found');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor('enabled send button', `Boolean(document.querySelector('button[aria-label="发送消息"]:not(:disabled)'))`);
  await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
  await waitFor('streamed tool result and settled response', `(() => {
    const events = window.__piDesktopSmoke.events;
    return events.some(e => e.type === 'agent_settled') &&
      events.some(e => e.type === 'tool_execution_end' && e.toolName === 'read' && !e.isError) &&
      !document.querySelector('.activity-line') &&
      [...document.querySelectorAll('.assistant-message code')].some(node => node.textContent.includes('const status'));
  })()`, 45_000);
  const events = await evaluate('window.__piDesktopSmoke.events');
  assert.ok(events.some(event => event.type === 'message_update' && event.deltaType === 'text_delta'), 'Must receive actual streamed text deltas');
  assert.equal(await evaluate(`Boolean(document.querySelector('.tool-card .tool-detail'))`), false, 'Collapsed tool output should not be mounted');
  await evaluate(`document.querySelector('.tool-card summary').click()`);
  await waitFor('tool details opened', `Boolean(document.querySelector('.tool-card .tool-detail'))`);
  report.checks.push('Tool details are mounted only when expanded');
  assert.equal(await evaluate(`document.querySelector('.tool-text-controls')?.previousElementSibling.textContent.length`), 24_000);
  await evaluate(`document.querySelector('.tool-output-expand').click()`);
  await waitFor('full tool output', `document.querySelector('.tool-text-controls')?.previousElementSibling.textContent.length > 30_000`);
  report.checks.push('Long tool output is previewed and can be expanded without losing content');
  const rendered = await evaluate(`({
    toolText: document.querySelector('.tool-card')?.textContent,
    toolOutput: document.querySelector('.tool-detail')?.textContent,
    bold: [...document.querySelectorAll('.assistant-message strong')].map(node => node.textContent),
    listItems: document.querySelectorAll('.assistant-message li').length,
    code: document.querySelector('.assistant-message code')?.textContent,
    error: document.querySelector('.notice.error')?.textContent || '',
  })`);
  assert.match(rendered.toolText, /读取文件/);
  assert.match(rendered.toolText, /完成/);
  assert.match(rendered.toolOutput, /这是 Pi Desktop 的本地验收文件/);
  assert.ok(rendered.bold.includes('说明.txt'), 'Markdown bold must render semantically');
  assert.equal(rendered.listItems, 3, 'Markdown list must contain three items');
  assert.match(rendered.code, /const status = "ready"/);
  assert.equal(rendered.error, '', 'No error banner after the model run');
  report.checks.push('Native React composer input and send button');
  report.checks.push('Pi streamed text, real read tool, and agent_settled');
  report.checks.push('Chinese content, Markdown bold/list/code, and completed tool output');
  report.events = events.map(event => event.type);
  await screenshot('electron-chat.png');

  const savedState = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  await waitFor('durable restore preference', `(async () => {
    const boot = await window.pi.bootstrap();
    return boot.preferences.lastSessions?.[${JSON.stringify(project)}] === ${JSON.stringify(savedState.sessionFile)};
  })()`);
  await fs.access(savedState.sessionFile);
  const history = await evaluate(`window.pi.listSessions(${JSON.stringify(project)})`);
  assert.ok(history.some(session => session.path === savedState.sessionFile), 'Session must appear in the real history index');
  report.checks.push('Session JSONL persisted and indexed in history');
  const externalId = require('node:crypto').randomUUID();
  const externalFile = path.join(path.dirname(savedState.sessionFile), `external-${externalId}.jsonl`);
  const entries = (await fs.readFile(savedState.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  entries[0].id = externalId;
  entries.push({ type: 'session_info', id: require('node:crypto').randomUUID(), parentId: entries.at(-1).id, name: '新增历史会话验收', timestamp: new Date().toISOString() });
  await fs.writeFile(externalFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await evaluate(`document.querySelector('.history-refresh-button').click()`);
  await waitFor('external history refresh', `document.querySelector('.session-list')?.textContent.includes('新增历史会话验收') && !document.querySelector('.history-refresh-button').disabled`);
  await evaluate(`(() => { const input = document.querySelector('input[aria-label="搜索会话"]'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'不存在的搜索词'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor('history search clear', `Boolean(document.querySelector('.history-search-clear')) && !document.querySelector('.session-item')`);
  await evaluate(`document.querySelector('.history-search-clear').click()`);
  await waitFor('cleared history filter', `document.querySelector('.session-list').textContent.includes('新增历史会话验收') && !document.querySelector('.history-search-clear')`);
  report.checks.push('History refresh detects externally saved conversations and search can be cleared');

  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Window reload timed out.')), 15_000);
    mainWindow.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
  });
  mainWindow.webContents.reload();
  await loaded;
  await waitFor('restored conversation after renderer reload', `Boolean(document.querySelector('.connection-pill.connected')) &&
    [...document.querySelectorAll('.user-message')].some(node => node.textContent.includes(${JSON.stringify(prompt)})) &&
    [...document.querySelectorAll('.assistant-message code')].some(node => node.textContent.includes('const status'))`, 75_000);
  const restored = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  assert.equal(restored.sessionId, savedState.sessionId);
  assert.equal(restored.sessionFile, savedState.sessionFile);
  assert.equal(await evaluate(`document.querySelector('.notice.error')?.textContent || ''`), '');
  report.checks.push('Renderer reload restores the same saved session and rendered messages');
  report.sessionId = restored.sessionId;
  await screenshot('electron-restored.png');
  const simultaneous = await evaluate(`Promise.allSettled([
    window.pi.rpc({type:'switch_session',sessionPath:${JSON.stringify(savedState.sessionFile)}}),
    window.pi.rpc({type:'new_session'})
  ]).then(results => results.map(result => ({status:result.status,error:result.reason?.message})))`);
  assert.equal(simultaneous[0].status, 'fulfilled');
  assert.equal(simultaneous[1].status, 'rejected');
  assert.match(simultaneous[1].error, /等待完成|正在执行/);
  assert.equal((await evaluate(`window.pi.rpc({type:'get_state'})`)).sessionId, restored.sessionId);
  report.checks.push('Overlapping session mutations are rejected by the main process');
  await evaluate(`document.querySelector('button[aria-label="重命名会话"]').click()`);
  await waitFor('rename dialog', `Boolean(document.querySelector('[role="dialog"] input'))`);
  await evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '桌面验收会话');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(100);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[role="dialog"] input')`), true, 'Modal typing must retain input focus');
  report.checks.push('Modal typing preserves focus across updates');
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('保存名称')).click()`);
  await waitFor('renamed session', `!document.querySelector('[role="dialog"]') && document.querySelector('.current-title')?.textContent === '桌面验收会话'`);
  report.checks.push('Session rename updates Pi and the desktop header');
  await evaluate(`document.querySelector('.fork-button').click()`);
  await waitFor('fork picker', `Boolean(document.querySelector('.fork-list button:not(:disabled)'))`);
  await evaluate(`document.querySelector('.fork-list button').click()`);
  await waitFor('forked prompt prefill', `!document.querySelector('[role="dialog"]') && document.querySelector('textarea[aria-label="输入消息"]')?.value === ${JSON.stringify(prompt)}`);
  const forked = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  assert.notEqual(forked.sessionId, restored.sessionId);
  assert.match(await fs.readFile(savedState.sessionFile, 'utf8'), /桌面验收会话/);
  report.checks.push('Fork creates a distinct session and preserves the editable source prompt');
  await finish();
}

async function start() {
  // Refuse to run if the fixture would send a prompt outside the local server.
  const definitions = JSON.parse(await fs.readFile(path.join(agent, 'models.json'), 'utf8'));
  assert.equal(definitions.providers?.['local-qa']?.baseUrl, 'http://127.0.0.1:19427/v1');
  const settings = JSON.parse(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'local-qa');
  assert.equal(settings.defaultModel, 'local-qa');
  const prefs = JSON.parse(await fs.readFile(path.join(desktop, 'preferences.json'), 'utf8'));
  assert.equal(path.resolve(prefs.lastProject), project);
  const missingRestore = path.join(agent, 'sessions', `missing-startup-${Date.now()}.jsonl`);
  await fs.writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ ...prefs, lastSessions: { ...prefs.lastSessions, [project]: missingRestore } }, null, 2));
  await fs.writeFile(path.join(project, '说明.txt'), '这是 Pi Desktop 的本地验收文件。此项目不连接外部模型。\n' + 'x'.repeat(30_000), 'utf8');
  await fs.access(path.join(root, 'dist', 'index.html'));
  await fs.access(path.join(root, 'dist-electron', 'main.cjs'));
  app.on('browser-window-created', (_event, created) => {
    if (mainWindow) return;
    mainWindow = created;
    created.webContents.setBackgroundThrottling(false);
    created.webContents.on('console-message', (_event, details, line, sourceId) => {
      // Electron 44 supplies a details object; support older signatures as well.
      if (typeof details === 'object' && details.level === 'error') report.rendererErrors.push(details.message);
      else if (details === 3) report.rendererErrors.push(`${line} (${sourceId})`);
    });
    created.webContents.once('render-process-gone', (_event, details) => void finish(new Error(`Renderer exited: ${details.reason}`)));
    created.webContents.once('did-fail-load', (_event, code, description) => void finish(new Error(`Page load failed: ${code} ${description}`)));
    created.webContents.once('did-finish-load', () => { void run().catch(finish); });
  });
  require(path.join(root, 'dist-electron', 'main.cjs'));
}

process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error instanceof Error ? error : new Error(String(error))));
void start().catch(finish);
