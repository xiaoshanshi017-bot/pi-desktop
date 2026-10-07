// Actual Electron + pinned Pi, with only private sessions and a localhost model.
const { app, ipcMain } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, 'output', 'qa', 'redirect');
const runRoot = path.join(qaRoot, `run-${Date.now()}`);
const project = path.join(runRoot, '立即调整验收项目');
const agent = path.join(runRoot, 'agent');
const desktop = path.join(runRoot, 'desktop');
const qaAppRoot = path.join(runRoot, 'app');
const qaRuntimeRoot = path.join(qaAppRoot, 'build', 'runtime', 'win32-x64');
const lifecycleFile = path.join(runRoot, 'real-pi-cleanup.jsonl');
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
// Chromium can initialize while async fixture files are being prepared, before
// product main reads its env override. Isolate its paths synchronously as well.
require('node:fs').mkdirSync(desktop,{recursive:true});
require('node:fs').mkdirSync(path.join(runRoot,'chromium'),{recursive:true});
app.setPath('userData',desktop);
app.setPath('sessionData',path.join(runRoot,'chromium'));
app.setAppPath(qaAppRoot);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { started: new Date().toISOString(), runRoot, checks: [], errors: [], screenshots: [], requests: [], events: [], ipc: [] };
let mainWindow;
let server;
let finishing = false;
const deadline = setTimeout(() => void finish(new Error('Redirect acceptance exceeded 240 seconds')), 240_000);
function check(message) { report.checks.push(message); console.log(`[redirect] ${message}`); }
async function evaluate(source) {
  const result = await mainWindow.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(error){return {ok:false,error:error.stack||String(error)};}})()`, true);
  if (!result.ok) throw new Error(`${result.error}\nRenderer source: ${source}`);
  return result.value;
}
async function waitFor(label, source, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await evaluate(source)) return; await delay(80); }
  throw new Error(`Timed out: ${label}. UI: ${await evaluate('document.body.innerText.slice(-8500)')}`);
}
async function waitNative(label, predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(80); }
  throw new Error(`Timed out: ${label}`);
}
const tab = id => `[...document.querySelectorAll('.conversation-tab-wrap')].find(node=>node.dataset.connectionId===${JSON.stringify(id)})`;
async function activate(id) {
  await waitFor('conversation tab', `Boolean(${tab(id)})`);
  await evaluate(`(()=>{${tab(id)}.querySelector('[role="tab"]').click();return true;})()`);
  await waitFor('selected ready conversation', `Boolean(${tab(id)}?.querySelector('[role="tab"][aria-selected="true"]')) && Boolean(document.querySelector('.connection-pill.connected'))`);
}
async function draft(value) {
  await evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor('new composer contents', `document.querySelector('textarea[aria-label="输入消息"]').value===${JSON.stringify(value)}`);
}
async function send(value, mode) {
  if (mode) {
    await waitFor('busy send modes', `Boolean(document.querySelector('.queue-mode option[value=${JSON.stringify(mode)}]'))`);
    await evaluate(`(()=>{const select=document.querySelector('.queue-mode');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(mode)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await waitFor('selected send mode', `document.querySelector('.queue-mode').value===${JSON.stringify(mode)}`);
  }
  await draft(value);
  await waitFor('send enabled', `Boolean(document.querySelector('.send-button:not(:disabled)'))`);
  await evaluate(`(()=>{document.querySelector('.send-button').click();return true;})()`);
}
async function messages(id) { return (await evaluate(`window.pi.rpc({type:'get_messages'},${JSON.stringify(id)})`)).messages; }
const text = message => (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
async function idle(id) {
  await waitFor('target chat idle', `(async()=>!(await window.pi.listConnections()).find(item=>item.id===${JSON.stringify(id)})?.busy)()`);
}
async function toolStarted(marker) {
  await waitFor('real Bash output', `[...document.querySelectorAll('.tool-live-preview pre')].some(node=>node.textContent.includes(${JSON.stringify(marker)})) && document.querySelector('.run-progress')?.dataset.phase==='tool'`);
}
async function assertReply(id, marker, answer) {
  await waitNative('target reply persisted', async () => (await messages(id)).some(message => message.role === 'assistant' && text(message).includes(answer)));
  await idle(id);
  const history = await messages(id);
  const users = history.filter(message => message.role === 'user' && text(message).includes(marker));
  assert.equal(users.length, 1, `new ${marker} requirement appears exactly once`);
  const index = history.indexOf(users[0]);
  const replies = history.slice(index + 1).filter(message => message.role === 'assistant' && !(message.content || []).some(block => block.type === 'toolCall'));
  assert.equal(replies.length, 1, 'redirect produces one complete assistant response');
  assert.equal(replies[0].stopReason, 'stop', 'new reply is not aborted by the old abort controller');
  assert.ok(text(replies[0]).includes(answer));
  assert.equal(report.requests.filter(request => request.scenario === marker && request.toolCount === 0).length, 1, 'localhost model receives the new requirement once');
}
async function screenshot(name) {
  const file = path.join(root, 'output', 'playwright', `redirect-${name}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await delay(100);
  await fs.writeFile(file, (await mainWindow.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
}
async function finish(error) {
  if (finishing) return; finishing = true; clearTimeout(deadline);
  if (error) { report.errors.push(error.stack || String(error)); console.error(error); try { await screenshot('failure'); } catch {} }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { await evaluate(`(async()=>{for(const connection of await window.pi.listConnections()){try{await window.pi.rpc({type:'abort'},connection.id);}catch{}try{await window.pi.disconnect(connection.id);}catch{}}return true;})()`); }
    catch (cleanupError) { report.errors.push(`QA cleanup: ${cleanupError.message}`); }
  }
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  try { report.realPiLifecycle = (await fs.readFile(lifecycleFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
  report.success = !report.errors.length; report.finished = new Date().toISOString();
  await fs.mkdir(qaRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(qaRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: report.success, checks: report.checks, metrics: report.metrics, errors: report.errors, report: path.join(qaRoot, 'report.json') }, null, 2));
  app.exit(report.success ? 0 : 1);
}

async function run() {
  await waitFor('private real Pi ready', `Boolean(document.querySelector('.connection-pill.connected')) && !document.querySelector('.new-chat').disabled`, 90_000);
  const boot = await evaluate('window.pi.bootstrap({workspace:false})');
  assert.equal(path.resolve(boot.diagnostics.agentDir), agent);
  assert.equal(await evaluate(`typeof window.pi.redirect`), 'function', 'new targeted native API exists');
  report.runtime = boot.diagnostics;
  assert.equal(path.resolve(boot.diagnostics.runtimeRoot),qaRuntimeRoot,'all adapters run from the private QA overlay');
  assert.equal(boot.diagnostics.piSource,'bundled','QA uses the pinned bundled Pi instead of a global install');
  const runtimeRoot = boot.diagnostics.runtimeRoot;
  if (runtimeRoot) {
    report.runtimeAdapterHashes = [];
    for (const file of ['pi-launcher.mjs', 'desktop-command-guard.mjs', 'desktop-session-controls.mjs']) {
      const bundled = await fs.readFile(path.join(runtimeRoot, file));
      const source = await fs.readFile(path.join(root, 'electron', file));
      const sha256=crypto.createHash('sha256').update(bundled).digest('hex');
      assert.equal(sha256, crypto.createHash('sha256').update(source).digest('hex'), `QA runtime ${file} matches current source adapter`);
      report.runtimeAdapterHashes.push({file,sha256});
    }
  }
  const a = (await evaluate('window.pi.listConnections()'))[0].id;
  report.connections = { a };
  await send('[redirect-long] A：先执行45秒真实长命令。');
  await toolStarted('A_OLD_BEGIN');
  assert.equal(await evaluate(`document.querySelector('.queue-mode').value`), 'redirect', 'busy composer defaults to immediate adjustment');
  assert.deepEqual(await evaluate(`[...document.querySelector('.queue-mode').options].map(option=>({value:option.value,label:option.textContent}))`), [
    { value: 'redirect', label: '立即调整' }, { value: 'afterTool', label: '工具结束后调整' }, { value: 'followUp', label: '完成后继续' },
  ]);
  check('Isolated actual Electron/Pi use localhost only; busy send modes clearly distinguish immediate, after-tool and after-task timing');

  await evaluate(`(()=>{document.querySelector('.new-chat').click();return true;})()`);
  await waitFor('second ready chat', `document.querySelectorAll('.conversation-tab-wrap').length===2 && Boolean(document.querySelector('.connection-pill.connected')) && !document.querySelector('.new-chat').disabled && document.querySelector('.conversation-tab-wrap:has([role="tab"][aria-selected="true"])')?.dataset.connectionId!==${JSON.stringify(a)}`, 60_000);
  const b = (await evaluate('window.pi.listConnections()')).find(connection => connection.id !== a).id;
  report.connections.b = b; await activate(b);
  await send('[redirect-B] B：独立长检查，等待自己的release文件。'); await toolStarted('B_INDEPENDENT_BEGIN');
  await activate(a);
  assert.equal((await evaluate('window.pi.listConnections()')).filter(connection => connection.busy).length, 2);
  check('A and B execute real Bash concurrently; B is held by a bounded file handshake rather than a timing assumption');

  await draft('[redirect-latest-one] A新要求：立即停止旧命令，改为返回最新答案一。');
  await waitFor('immediate adjust button', `Boolean(document.querySelector('button[aria-label="立即调整任务"]:not(:disabled)'))`);
  const redirectAt = Date.now();
  // Same task: the send handler must capture A before B changes activeId.
  await evaluate(`(()=>{document.querySelector('button[aria-label="立即调整任务"]').click();${tab(b)}.querySelector('[role="tab"]').click();return true;})()`);
  await waitFor('B selected while A redirects', `Boolean(${tab(b)}?.querySelector('[role="tab"][aria-selected="true"]'))`);
  await assertReply(a, 'redirect-latest-one', 'A_LATEST_ONE_COMPLETE');
  const latency = report.requests.find(request => request.scenario === 'redirect-latest-one').time - redirectAt;
  report.metrics = { immediateAdjustmentMs: latency, originalToolSleepMs: 45_000 };
  assert.ok(latency >= 0 && latency < 15_000, 'new requirement starts well before old 45-second tool could finish');
  const cleanup = (await fs.readFile(lifecycleFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const oldSettled = cleanup.find(event=>event.prompt.includes('[redirect-long]') && event.stage==='cleanup-end');
  assert.ok(oldSettled, 'genuine old Pi extension cleanup completed');
  assert.ok(report.requests.find(request=>request.scenario==='redirect-latest-one').time>=oldSettled.time, 'new prompt waits for genuine old SDK cleanup instead of only abort acknowledgment');
  assert.ok(await evaluate(`Boolean(${tab(b)}?.querySelector('[role="tab"][aria-selected="true"]'))`), 'background adjustment never steals B selection');
  assert.equal((await evaluate('window.pi.listConnections()')).find(connection => connection.id === b).busy, true);
  assert.equal((await messages(b)).some(message => text(message).includes('redirect-latest-one')), false);
  await activate(a);
  await waitFor('preserved old partial output and new reply', `[...document.querySelectorAll('.tool-live-preview pre,.tool-detail .tool-text:last-child pre')].some(node=>node.textContent.includes('A_OLD_BEGIN')) && document.querySelector('.messages').textContent.includes('A_LATEST_ONE_COMPLETE')`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.notice.error'))`),false,'expected interruption does not leave an error notice over the successful new task');
  assert.equal(await evaluate(`[...document.querySelectorAll('.message-error')].some(node=>node.textContent.includes('This operation was aborted'))`),false,'expected SDK abort is shown neutrally in history');
  assert.ok(await evaluate(`document.querySelector('.messages').textContent.includes('本次回复已停止')`),'old cancelled reply remains visible as stopped history');
  const firstHistory = await messages(a);
  assert.equal(await fs.readFile(path.join(project,'applied-before-redirect.txt'),'utf8'),'A_EDIT_SURVIVES_REDIRECT\n','file changes completed before interruption are preserved');
  assert.ok(firstHistory.some(message => message.role === 'user' && text(message).includes('[redirect-long]')));
  assert.equal(firstHistory.some(message => message.role === 'toolResult' && text(message).includes('A_OLD_SHOULD_NOT_FINISH')), false);
  await screenshot('completed');
  check('Immediate adjustment interrupts the long tool promptly, preserves partial output/history, sends once and finishes normally even when selection switches to B');

  await send('[redirect-queue-old] A：再启动长工具，验证已排队的文本可立即应用。');
  await toolStarted('A_QUEUE_BEGIN');
  await send('[redirect-queued-old] A旧排队要求：等待当前工具结束。', 'afterTool');
  await waitFor('waiting plain-text queue', `document.querySelector('.queue-list')?.textContent.includes('[redirect-queued-old]')`);
  assert.equal(report.requests.some(request => request.scenario === 'redirect-queued-old'), false, 'afterTool waits until after the running tool');
  await send('[redirect-queued-latest] A新要求二：覆盖旧排队要求，完整保留这条最新文本。', 'redirect');
  await assertReply(a, 'redirect-queued-latest', 'A_QUEUED_LATEST_COMPLETE');
  await waitFor('old waiting queue removed', `!document.querySelector('.queue-list')?.textContent.includes('[redirect-queued-old]')`);
  assert.equal(report.requests.some(request => request.scenario === 'redirect-queued-old'), false, 'superseded queued requirement never reaches the model');
  assert.equal((await messages(a)).some(message=>message.role==='user' && text(message).includes('[redirect-queued-old]')),false,'old queue is cancelled without fabricating consumed history');
  assert.equal((await evaluate('window.pi.listConnections()')).find(connection => connection.id === b).busy, true);
  check('A new immediate requirement replaces an old waiting steer instruction and runs once; the old queue cannot replay it after abort');

  await send('[redirect-replace-old] A：长工具停止期间允许连续改两次要求。'); await toolStarted('A_REPLACE_BEGIN');
  await send('[redirect-replace-first] A第一次新要求：随后还会替换。','redirect');
  await waitFor('editable first handoff',`document.querySelector('.redirect-pending')?.textContent.includes('[redirect-replace-first]') && Boolean(document.querySelector('textarea[aria-label="输入消息"]:not(:disabled)'))`,2500);
  await send('[redirect-replace-latest] A最终新要求：只执行这条最后的要求。');
  await assertReply(a,'redirect-replace-latest','A_REPLACED_LATEST_COMPLETE');
  assert.equal(report.requests.some(request=>request.scenario==='redirect-replace-first'),false,'superseded first requirement never reaches the model');
  assert.equal((await messages(a)).some(message=>message.role==='user' && text(message).includes('[redirect-replace-first]')),false,'superseded requirement never becomes a submitted user message');
  const superseded=report.ipc.find(entry=>entry.channel==='pi:redirect' && JSON.stringify(entry.args).includes('[redirect-replace-first]'));
  assert.equal(superseded?.result?.status,'superseded','first pending native call finishes with explicit superseded status');
  assert.equal((await evaluate('window.pi.listConnections()')).find(connection=>connection.id===b).busy,true);
  check('Two immediate changes during real old-task cleanup stay editable; only the latest instruction enters history/model and the first ticket is superseded');

  await send('[redirect-stop-old] A：长工具中准备调整，再取消自动继续。'); await toolStarted('A_CANCEL_BEGIN');
  await send('[redirect-stop-new] A：这条新要求必须被后续Stop取消。', 'redirect');
  await waitFor('visible stop-to-continue handoff', `document.querySelector('.redirect-pending')?.textContent.includes('[redirect-stop-new]') && Boolean(document.querySelector('button[aria-label="停止任务"]'))`, 2500);
  await screenshot('pending');
  const previousSize=mainWindow.getSize();
  mainWindow.setSize(960,680);
  await evaluate(`(()=>{document.documentElement.dataset.theme='dark';return true;})()`);
  await delay(120);
  report.narrowBounds=await evaluate(`(()=>{const composer=document.querySelector('.composer').getBoundingClientRect();const pending=document.querySelector('.redirect-pending').getBoundingClientRect();const input=document.querySelector('textarea[aria-label="输入消息"]').getBoundingClientRect();return {width:innerWidth,height:innerHeight,composer:{top:composer.top,bottom:composer.bottom,left:composer.left,right:composer.right},pending:{top:pending.top,bottom:pending.bottom,left:pending.left,right:pending.right},inputWidth:input.width};})()`);
  assert.ok(report.narrowBounds.composer.bottom<=report.narrowBounds.height && report.narrowBounds.pending.right<=report.narrowBounds.width && report.narrowBounds.inputWidth>=200,'pending handoff and composer fit a 960×680 dark window');
  await screenshot('pending-small-dark');
  mainWindow.setSize(...previousSize);
  await evaluate(`(()=>{document.documentElement.dataset.theme='light';return true;})()`);
  const cancelAt = Date.now();
  await evaluate(`(()=>{document.querySelector('button[aria-label="停止任务"]').click();return true;})()`);
  await idle(a);
  await waitFor('cancelled handoff removed', `!document.querySelector('.redirect-pending')`);
  await waitFor('cancelled requirement retained as an unsent draft',`document.querySelector('textarea[aria-label="输入消息"]').value.includes('[redirect-stop-new]')`);
  report.metrics.stopCancellationMs = Date.now() - cancelAt;
  assert.equal(report.requests.some(request => request.scenario === 'redirect-stop-new'), false, 'Stop cancels automatic continuation before its model request');
  assert.equal((await messages(a)).some(message => message.role === 'user' && text(message).includes('[redirect-stop-new]')), false);
  assert.ok(report.events.some(event => event.connectionId === a && event.type === 'redirect_update' && event.status === 'cancelled'));
  const cancelCleanup = (await fs.readFile(lifecycleFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const cancelWindow = cancelCleanup.filter(event=>event.prompt.includes('[redirect-stop-old]'));
  assert.equal(cancelWindow.length,2,'old SDK cleanup really runs through its delayed begin/end window');
  assert.ok(cancelAt<cancelWindow.find(event=>event.stage==='cleanup-end').time,'Stop was clicked before the genuine old run finished cleanup');
  assert.equal((await evaluate('window.pi.listConnections()')).find(connection => connection.id === b).busy, true);
  check('Stop during a genuine delayed Pi cleanup cancels automatic continuation, removes pending UI, and keeps the other chat running');

  await send('[redirect-final] A：取消后仍可正常开始新任务。');
  await assertReply(a, 'redirect-final', 'A_FINAL_NORMAL_COMPLETE');
  await fs.writeFile(path.join(project, 'redirect-b-release'), 'A redirects and cancellation were verified; now B may finish.\n');
  await assertReply(b, 'redirect-B', 'B_INDEPENDENT_COMPLETE');
  const bHistory = await messages(b);
  assert.ok(bHistory.some(message => message.role === 'toolResult' && !message.isError && text(message).includes('B_INDEPENDENT_END')));
  assert.equal(bHistory.some(message => message.role === 'user' && /redirect-latest|redirect-queued|redirect-stop|redirect-replace/.test(text(message))), false);
  await activate(a); await screenshot('final');
  check('After cancellation A starts another normal task; B independently completes its actual Bash and contains none of A’s changed requirements');
  assert.ok(report.requests.every(request => request.model === 'redirect-fixture'));
  assert.ok(report.events.filter(event => ['agent_start','agent_settled','redirect_update'].includes(event.type)).every(event => event.connectionId && event.project));
  check('All redirect and agent lifecycle events retain their source chat/project, and every completion request stayed on localhost');
  await finish();
}

async function start() {
  await Promise.all([project, agent, desktop, path.join(agent, 'extensions'),qaRuntimeRoot].map(directory => fs.mkdir(directory, { recursive: true })));
  const sharedRuntimeRoot=path.join(root,'build','runtime','win32-x64');
  for(const directory of ['node','git','pi','bin','licenses']) {
    const source=path.join(sharedRuntimeRoot,directory);
    assert.equal((await fs.stat(source)).isDirectory(),true,`existing bundled ${directory} is available`);
    await fs.symlink(source,path.join(qaRuntimeRoot,directory),'junction');
  }
  for(const file of ['pi-launcher.mjs','desktop-command-guard.mjs','desktop-session-controls.mjs']) await fs.copyFile(path.join(root,'electron',file),path.join(qaRuntimeRoot,file));
  await fs.copyFile(path.join(root,'build','runtime','win32-x64','manifest.json'),path.join(qaRuntimeRoot,'manifest.json'));
  await fs.copyFile(path.join(root,'build','icon.png'),path.join(qaAppRoot,'build','icon.png'));
  await fs.copyFile(path.join(root,'package.json'),path.join(qaAppRoot,'package.json'));
  await fs.writeFile(lifecycleFile, '');
  // Keep the real old SDK turn open after tool cancellation. This exposes the
  // abort-to-idle race and gives a deterministic window to cancel a handoff.
  await fs.writeFile(path.join(agent, 'extensions', 'redirect-cleanup.js'), `import fs from 'node:fs';\nexport default function(api){let prompt='';api.on('before_agent_start',event=>{prompt=event.prompt||'';});api.on('agent_end',async()=>{const ms=prompt.includes('[redirect-stop-old]')||prompt.includes('[redirect-replace-old]')?3500:prompt.includes('[redirect-long]')?600:0;if(ms){fs.appendFileSync(${JSON.stringify(lifecycleFile)},JSON.stringify({prompt,stage:'cleanup-begin',time:Date.now()})+'\\n');await new Promise(resolve=>setTimeout(resolve,ms));fs.appendFileSync(${JSON.stringify(lifecycleFile)},JSON.stringify({prompt,stage:'cleanup-end',time:Date.now()})+'\\n');}});}\n`);
  await fs.writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: project, name: path.basename(project), lastOpened: new Date().toISOString() }], lastProject: project }));
  const scenarios = ['redirect-long','redirect-B','redirect-latest-one','redirect-queue-old','redirect-queued-old','redirect-queued-latest','redirect-replace-old','redirect-replace-first','redirect-replace-latest','redirect-stop-old','redirect-stop-new','redirect-final'];
  const replies = { 'redirect-latest-one': 'A_LATEST_ONE_COMPLETE', 'redirect-queued-latest': 'A_QUEUED_LATEST_COMPLETE', 'redirect-replace-first':'SUPERSEDED_FIRST_MUST_NOT_RUN','redirect-replace-latest':'A_REPLACED_LATEST_COMPLETE','redirect-stop-new': 'CANCELLED_REQUIREMENT_MUST_NOT_RUN', 'redirect-final': 'A_FINAL_NORMAL_COMPLETE', 'redirect-B': 'B_INDEPENDENT_COMPLETE' };
  server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); assert.equal(body.model, 'redirect-fixture');
      const userIndex = body.messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(body.messages[userIndex]?.content);
      const scenario = scenarios.find(marker => prompt.includes(`[${marker}]`));
      assert.ok(scenario, 'fixture accepts only controlled synthetic prompts');
      const toolCount = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool').length;
      report.requests.push({ model: body.model, scenario, toolCount, time: Date.now() });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'redirect-fixture', object: 'chat.completion.chunk', created: 1, model: 'redirect-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant' });
      if (toolCount === 0 && ['redirect-long','redirect-queue-old','redirect-replace-old','redirect-stop-old','redirect-B'].includes(scenario)) {
        const markers = { 'redirect-long': 'A_OLD', 'redirect-queue-old': 'A_QUEUE', 'redirect-replace-old':'A_REPLACE','redirect-stop-old': 'A_CANCEL', 'redirect-B': 'B_INDEPENDENT' };
        const marker = markers[scenario];
        const command = scenario === 'redirect-B'
          ? `printf '${marker}_BEGIN\\n'; attempt=0; while [ ! -f redirect-b-release ] && [ "$attempt" -lt 800 ]; do sleep 0.1; attempt=$((attempt + 1)); done; [ -f redirect-b-release ] || { printf 'B_RELEASE_TIMEOUT\\n'; exit 17; }; printf '${marker}_END\\n'`
          : `${scenario==='redirect-long'?"printf 'A_EDIT_SURVIVES_REDIRECT\\n' > applied-before-redirect.txt; ":''}printf '${marker}_BEGIN\\n'; sleep 45; printf '${marker}_SHOULD_NOT_FINISH\\n'`;
        emit({ content: `开始 ${marker} 的真实 Bash。\n` });
        emit({ tool_calls: [{ index: 0, id: `${scenario}_${Date.now()}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, timeout: scenario === 'redirect-B' ? 100 : 55 }) } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ content: replies[scenario] || `OLD_TOOL_FINISHED_UNEXPECTEDLY_${scenario}` });
        await delay(80); emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { report.errors.push(error.stack || String(error)); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'redirect-fixture': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'private-local-fixture', models: [{ id: 'redirect-fixture', name: '本地立即调整验收模型', reasoning: false, contextWindow: 1000000, maxTokens: 2048 }] } } }));
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'redirect-fixture', defaultModel: 'redirect-fixture', defaultThinkingLevel: 'off' }));
  report.packageVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  report.electronVersion = process.versions.electron;
  report.compiledMainSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'dist-electron', 'main.cjs'))).digest('hex');
  const html = await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8');
  report.compiledHtmlSha256 = crypto.createHash('sha256').update(html).digest('hex');
  report.compiledAssets = [];
  for (const match of html.matchAll(/(?:src|href)="\.\/assets\/([^\"]+\.(?:js|css))"/g)) report.compiledAssets.push({ file: match[1], sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'dist', 'assets', match[1]))).digest('hex') });
  const handle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,listener)=>handle(channel,async(event,...args)=>{
    if(channel!=='pi:redirect' && channel!=='pi:rpc')return listener(event,...args);
    const entry={channel,time:Date.now(),args};
    if(channel==='pi:redirect' || JSON.stringify(args).includes('"abort"'))report.ipc.push(entry);
    try{const result=await listener(event,...args);if(channel==='pi:redirect')entry.result=result;return result;}
    catch(error){entry.error=error.message;throw error;}
  });
  app.on('browser-window-created', (_event, window) => {
    if (mainWindow) return; mainWindow = window; window.webContents.setBackgroundThrottling(false);
    const originalSend = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => {
      const event = args[0];
      if (channel === 'pi:event' && ['agent_start','agent_end','agent_settled','tool_execution_start','tool_execution_end','redirect_update','desktop_capabilities'].includes(event?.type)) report.events.push({ time: Date.now(), type: event.type, connectionId: event.connectionId, project: event.project, status: event.status, requestId: event.requestId, message: event.message, sessionControls:event.sessionControls });
      return originalSend(channel, ...args);
    };
    window.webContents.once('did-finish-load', () => { void run().catch(finish); });
    window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') report.errors.push(details.message); });
  });
  require(path.join(root, 'dist-electron', 'main.cjs'));
}
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));
void start().catch(finish);
