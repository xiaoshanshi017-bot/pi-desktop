// Real Electron/preload/IPC/Pi acceptance using an isolated local model.
const { app } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, 'output', 'qa', 'progress');
const project = path.join(qaRoot, '实时进度验收项目');
const agent = path.join(qaRoot, 'agent');
const desktop = path.join(qaRoot, 'desktop');
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { started: new Date().toISOString(), checks: [], errors: [], screenshots: [], requests: 0, guidanceObserved: false };
let mainWindow;
let server;
let finishing = false;
const deadline = setTimeout(() => void finish(new Error('Progress acceptance exceeded 180 seconds')), 180_000);

async function evaluate(source) {
  return mainWindow.webContents.executeJavaScript(source, true);
}
async function waitFor(label, source, timeout = 35_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(source)) return;
    await delay(100);
  }
  const ui = await evaluate('document.body.innerText.slice(-9000)');
  throw new Error(`Timed out: ${label}. UI: ${ui}`);
}
async function screenshot(name) {
  const file = path.join(root, 'output', 'playwright', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const capture = await mainWindow.webContents.capturePage();
  assert.ok(!capture.isEmpty());
  await fs.writeFile(file, capture.toPNG());
  report.screenshots.push(file);
}
async function send(prompt) {
  await evaluate(`(() => {
    window.__progressEvents = [];
    const input = document.querySelector('textarea[aria-label="输入消息"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('enabled composer', `Boolean(document.querySelector('button[aria-label="发送消息"]:not(:disabled)'))`);
  await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
}
async function settled() {
  await waitFor('settled run', `window.__progressEvents.some(event => event.type === 'agent_settled') && !document.querySelector('.activity-line') && Boolean(document.querySelector('.run-progress.finished'))`, 50_000);
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) {
    report.errors.push(error.stack || String(error));
    console.error(error);
    try { await screenshot('progress-failure.png'); } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { await evaluate(`(async () => { try { await window.pi.rpc({type:'abort'}); } catch {} await window.pi.disconnect(); })()`); }
    catch (cleanupError) { report.errors.push(cleanupError.message); }
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
  assert.equal((await evaluate(`window.pi.rpc({type:'get_state'})`)).model.provider, 'progress-fixture');
  await evaluate(`(() => { window.__progressEvents = []; window.pi.onEvent(event => window.__progressEvents.push({type:event.type, toolName:event.toolName, isError:event.isError, deltaType:event.assistantMessageEvent?.type})); return true; })()`);
  report.checks.push('Actual Electron, sandboxed preload, IPC and Pi connect to an isolated local model');

  await send('[progress-normal] 检查命令进度，再读取说明文件。');
  await waitFor('thinking stage', `document.querySelector('.run-progress')?.dataset.phase === 'thinking'`);
  await waitFor('prose before tools', `document.querySelector('.run-progress')?.dataset.phase === 'responding' && document.querySelector('.messages').textContent.includes('我先执行检查命令')`);
  await waitFor('first live output while command is running', `Boolean(document.querySelector('.tool-live-preview pre')?.textContent.includes('步骤一')) && document.querySelector('.run-progress')?.dataset.phase === 'tool'`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.tool-card .tool-detail'))`), false, 'latest output is visible with details collapsed');
  const elapsedBefore = await evaluate(`document.querySelector('.progress-elapsed').textContent`);
  await waitFor('second output before command completion', `document.querySelector('.tool-live-preview pre')?.textContent.includes('步骤二')`);
  assert.notEqual(await evaluate(`document.querySelector('.progress-elapsed').textContent`), elapsedBefore);
  assert.match(await evaluate(`document.querySelector('.tool-state').textContent`), /运行中/);
  report.checks.push('Thinking and prose have distinct phases; cumulative command output and elapsed time update before completion');

  await evaluate(`document.querySelector('.tool-live-heading button').click()`);
  await waitFor('running details', `document.querySelector('.tool-card .tool-detail')?.textContent.includes('步骤二')`);
  await evaluate(`document.querySelector('.tool-card summary').click(); document.querySelector('.progress-toggle').click()`);
  await waitFor('execution record', `document.querySelector('.progress-steps')?.textContent.includes('执行命令') && Boolean(document.querySelector('.tool-live-preview pre'))`);
  await screenshot('progress-live.png');
  report.checks.push('Tool details remain optional; execution records list observed stages and commands');

  await waitFor('quiet command signal', `Boolean(document.querySelector('.progress-quiet')) && document.querySelector('.tool-live-preview').textContent.includes('没有新输出')`, 25_000);
  assert.equal(await evaluate(`document.querySelector('.run-progress').dataset.phase`), 'tool');
  await screenshot('progress-waiting.png');
  report.checks.push('A quiet long command stays in the tool stage and displays time since the last output with a stop action');
  await settled();
  assert.equal(await evaluate(`document.querySelector('.run-progress').dataset.phase`), 'complete');
  assert.match(await evaluate(`document.querySelector('.progress-meta').textContent`), /已结束 2 次工具调用/);
  assert.match(await evaluate(`document.querySelector('.messages').textContent`), /命令检查已完成，现在读取说明文件/);
  assert.equal(await evaluate(`document.querySelectorAll('.tool-state .spin').length`), 0);
  assert.equal(report.guidanceObserved, true, 'real model requests include desktop progress guidance');
  await screenshot('progress-complete.png');
  report.checks.push('Intermediate prose, a second real tool and final result are visible; completed counts use actual results');

  mainWindow.setSize(960, 680);
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await delay(200);
  assert.ok(await evaluate(`(() => { const panel = document.querySelector('.run-progress').getBoundingClientRect(); const input = document.querySelector('.composer').getBoundingClientRect(); return panel.top >= 0 && input.bottom < innerHeight && panel.width < innerWidth; })()`));
  await screenshot('progress-small-dark.png');
  report.checks.push('Progress and composer remain usable at 960×680 in the dark theme');
  mainWindow.setSize(1440, 940);
  await evaluate(`document.documentElement.dataset.theme = 'light'`);

  await send('[progress-error] 验证工具失败的展示。');
  await settled();
  assert.ok(await evaluate(`Boolean(document.querySelector('.tool-card.failed[open] .tool-detail'))`), 'tool errors expand automatically');
  assert.match(await evaluate(`document.querySelector('.progress-meta').textContent`), /1 次返回错误/);
  assert.equal(await evaluate(`document.querySelector('.run-progress').dataset.phase`), 'complete', 'model may recover from tool errors');
  report.checks.push('Failed tools expose their error output and are counted; a recovered error does not fail the entire run');

  await send('[progress-stop] 验证停止长命令。');
  await waitFor('stoppable tool', `[...document.querySelectorAll('.tool-live-preview')].some(node => node.textContent.includes('等待停止的命令'))`);
  await evaluate(`document.querySelector('.stop-button').click()`);
  await settled();
  assert.equal(await evaluate(`document.querySelector('.run-progress').dataset.phase`), 'interrupted');
  assert.equal(await evaluate(`document.querySelectorAll('.tool-state .spin').length`), 0);
  await screenshot('progress-stopped.png');
  report.checks.push('Stopping a real running command ends spinners and preserves an interrupted run state');

  await evaluate(`document.querySelector('.new-chat').click()`);
  await waitFor('session reset', `!document.querySelector('.run-progress') && !document.querySelector('.message') && !document.querySelector('.new-chat').disabled`);
  report.checks.push('A new session clears the previous progress record');
  await finish();
}

async function start() {
  await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(agent, { recursive: true }), fs.mkdir(desktop, { recursive: true })]);
  await fs.writeFile(path.join(project, '说明.txt'), '实时进度验收：命令和文件读取均已完成。\n');
  await fs.writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: project, name: '实时进度验收项目', lastOpened: new Date().toISOString() }], lastProject: project }));
  server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      report.requests++;
      report.guidanceObserved ||= body.messages.some(message => ['system', 'developer'].includes(message.role) && JSON.stringify(message.content).includes('请让用户能看到任务的实际推进过程'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'progress-fixture', object: 'chat.completion.chunk', created: 1, model: 'progress-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const userIndex = body.messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(body.messages[userIndex]?.content);
      const toolCount = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool').length;
      const toolCall = (name, args) => { emit({ tool_calls: [{ index: 0, id: `progress_${report.requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); emit({}, 'tool_calls'); };
      emit({ role: 'assistant' });
      if (toolCount === 0) {
        emit({ reasoning_content: '分析可执行的检查步骤。' });
        await delay(700);
        emit({ content: '我先执行检查命令，并显示运行结果。\n' });
        await delay(700);
        const command = prompt.includes('[progress-stop]') ? "printf '等待停止的命令\\n'; sleep 45" : prompt.includes('[progress-error]') ? "printf '检查返回错误\\n'; exit 7" : "printf '步骤一：开始检查\\n'; sleep 2; printf '步骤二：取得结果\\n'; sleep 19";
        toolCall('bash', { command, timeout: 55 });
      } else if (toolCount === 1 && prompt.includes('[progress-normal]')) {
        emit({ content: '命令检查已完成，现在读取说明文件确认结果。\n' });
        await delay(500);
        toolCall('read', { path: '说明.txt' });
      } else {
        emit({ content: prompt.includes('[progress-error]') ? '错误已经显示，失败原因已确认。' : '检查已结束。命令日志和文件内容均已返回。' });
        await delay(500);
        emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await fs.writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'progress-fixture': { baseUrl, api: 'openai-completions', apiKey: 'local-fixture', models: [{ id: 'progress-fixture', name: '实时进度验收模型', reasoning: true, contextWindow: 32000, maxTokens: 2048 }] } } }));
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'progress-fixture', defaultModel: 'progress-fixture', defaultThinkingLevel: 'high' }));
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
