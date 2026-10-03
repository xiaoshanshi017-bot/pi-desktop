// Large-session performance acceptance through actual Electron/preload/IPC/Pi.
// Fixture sessions and credentials are isolated; the model endpoint is localhost.
const { app, ipcMain } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const stage = process.env.PI_SWITCH_STAGE || 'final';
const enforce = process.env.PI_SWITCH_ENFORCE === '1' || stage !== 'baseline';
const qaRoot = path.join(root, 'output', 'qa', 'switch');
const runRoot = path.join(qaRoot, `${stage}-${Date.now()}`);
const project = path.join(runRoot, '大会话切换验收');
const otherProject = path.join(runRoot, '另一个切换验收项目');
const agent = path.join(runRoot, 'agent');
const desktop = path.join(runRoot, 'desktop');
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
app.setAppPath(root);

const report = { stage, enforce, started: new Date().toISOString(), runRoot, checks: [], errors: [], performanceFailures: [], measurements: [], screenshots: [], ipc: [], modelRequests: 0 };
const limits = { maxRenderedMessages: 160, medianFrameMs: 900, maxFrameMs: 3000, maxTabMs: 1800 };
report.limits = limits;
let mainWindow;
let server;
let finishing = false;
let sessionA;
let sessionB;
let sessionC;
let connectionA;
let connectionB;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => void finish(new Error('Switch acceptance exceeded 8 minutes')), 480_000);
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, ...args) => {
  const entry = { channel, command: args[0]?.type, startedAt: Date.now() };
  if (channel.startsWith('pi:')) report.ipc.push(entry);
  try {
    const result = await handler(event, ...args);
    entry.durationMs = Date.now() - entry.startedAt;
    if (['pi:activateConnection','pi:connect'].includes(channel) && result) entry.snapshotMessages = result.messages?.length;
    return result;
  } catch (error) { entry.error = error.message; throw error; }
});

async function evaluate(source) {
  try { return await mainWindow.webContents.executeJavaScript(source, true); }
  catch (error) { error.message += `\nRenderer source: ${source}`; throw error; }
}
async function waitFor(label, source, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(source)) return;
    await delay(100);
  }
  const text = await evaluate('document.body.innerText.slice(-6000)');
  throw new Error(`Timed out: ${label}. UI: ${text}`);
}
const tab = id => `[...document.querySelectorAll('.active-conversations [data-connection-id]')].find(node => node.dataset.connectionId === ${JSON.stringify(id)})`;
const tail = name => `SWITCH_${name}_TAIL`;
const earliest = name => `SWITCH_${name}_EARLIEST`;
const messageTail = name => `([...document.querySelectorAll('.conversation-scroll .message')].at(-1)?.textContent || '').includes(${JSON.stringify(tail(name))})`;

async function select(id, name) {
  await waitFor('existing connection tab', `Boolean(${tab(id)})`);
  await evaluate(`(() => { const node = ${tab(id)}; (node.matches('[role="tab"]') ? node : node.querySelector('[role="tab"]')).click(); })()`);
  await waitFor(`selected ${name} tab and transcript`, `Boolean(${tab(id)}?.querySelector('[role="tab"][aria-selected="true"]')) && ${messageTail(name)}`);
  await waitFor('composer ready', `Boolean(document.querySelector('textarea[aria-label="输入消息"]:not(:disabled)'))`);
}
async function draft(value) {
  await evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="输入消息"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await waitFor('draft saved', `document.querySelector('textarea[aria-label="输入消息"]').value === ${JSON.stringify(value)}`);
}
async function measure(id, name, kind) {
  const ipcOffset = report.ipc.length;
  const click = kind === 'project' ? `[...document.querySelectorAll('.recent-project')].find(node => node.textContent.trim() === ${JSON.stringify(path.basename(project))})` : kind === 'history'
    ? `[...document.querySelectorAll('.session-item')].find(node => node.querySelector('strong')?.textContent === ${JSON.stringify(`SWITCH_${name}`)})`
    : `(${tab(id)}?.querySelector('[role="tab"]'))`;
  const sample = await evaluate(`new Promise((resolve, reject) => {
    const target = ${click};
    if (!target) { reject(new Error('Missing ${kind} target ${name}')); return; }
    const began = performance.now();
    let tabMs = null;
    let bodyMs = null;
    let completed = false;
    const poll = () => {
      if (completed) return;
      const elapsed = performance.now() - began;
      if (elapsed > 20000) { completed = true; reject(new Error('Switch ${name} exceeded 20s')); return; }
      const selected = ${tab(id)}?.querySelector('[role="tab"][aria-selected="true"]');
      if (selected && tabMs === null) tabMs = elapsed;
      if (selected && ${messageTail(name)} && bodyMs === null) bodyMs = elapsed;
      if (tabMs !== null && bodyMs !== null) {
        completed = true;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          name: ${JSON.stringify(name)}, kind: ${JSON.stringify(kind)}, tabMs, bodyMs, nextFrameMs: performance.now() - began,
          renderedMessages: document.querySelectorAll('.conversation-scroll .message').length,
          domElements: document.querySelectorAll('.conversation-scroll *').length,
          longTasks: window.__switchLongTasks.filter(entry => entry.startTime >= began).map(entry => ({duration:entry.duration,startTime:entry.startTime-began})),
          scrollTop: document.querySelector('.conversation-scroll').scrollTop,
          scrollHeight: document.querySelector('.conversation-scroll').scrollHeight,
        })));
      } else requestAnimationFrame(poll);
    };
    target.click();
    requestAnimationFrame(poll);
  })`);
  sample.ipc = report.ipc.slice(ipcOffset).map(entry => ({channel:entry.channel,command:entry.command,durationMs:entry.durationMs,snapshotMessages:entry.snapshotMessages}));
  report.measurements.push(sample);
  console.log(`[switch ${stage}] ${kind} ${name}: tab ${sample.tabMs.toFixed(1)}ms, body ${sample.bodyMs.toFixed(1)}ms, frame ${sample.nextFrameMs.toFixed(1)}ms, ${sample.renderedMessages} messages / ${sample.domElements} elements`);
  return sample;
}
async function screenshot(name) {
  const file = path.join(root, 'output', 'playwright', `switch-${stage}-${name}.png`);
  await fs.mkdir(path.dirname(file), {recursive:true});
  await delay(150);
  await fs.writeFile(file, (await mainWindow.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) {
    report.errors.push(error.stack || String(error));
    console.error(error);
    try { await screenshot('failure'); } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await evaluate(`(async () => { for (const connection of await window.pi.listConnections()) { try { await window.pi.rpc({type:'abort'}, connection.id); } catch {} try { await window.pi.disconnect(connection.id); } catch {} } })()`);
    } catch (error) { report.errors.push(error.message); }
  }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  report.success = report.errors.length === 0 && (!enforce || report.performanceFailures.length === 0);
  report.finished = new Date().toISOString();
  await fs.mkdir(qaRoot, {recursive:true});
  await fs.writeFile(path.join(qaRoot, `${stage}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage, success:report.success, checks:report.checks, errors:report.errors, summary:report.summary, performanceFailures:report.performanceFailures, report:path.join(qaRoot,`${stage}-report.json`) }, null, 2));
  app.exit(report.success ? 0 : 1);
}

async function run() {
  await waitFor('isolated large session startup', `Boolean(document.querySelector('.connection-pill.connected')) && ${messageTail('A')}`, 150_000);
  const boot = await evaluate('window.pi.bootstrap()');
  report.electronVersion = boot.version;
  assert.equal(path.resolve(boot.diagnostics.agentDir), agent);
  const connections = await evaluate('window.pi.listConnections()');
  connectionA = connections[0].id;
  const importedA = await evaluate(`window.pi.rpc({type:'get_messages'}, ${JSON.stringify(connectionA)})`);
  assert.equal(importedA.messages.length, 1440);
  assert.equal((await evaluate(`window.pi.rpc({type:'get_state'}, ${JSON.stringify(connectionA)})`)).model.provider, 'switch-fixture');
  await evaluate(`(() => {
    window.__switchLongTasks = [];
    window.__switchObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__switchLongTasks.push({startTime:entry.startTime,duration:entry.duration}); });
    window.__switchObserver.observe({type:'longtask',buffered:true});
    return true;
  })()`);
  report.checks.push('Actual Electron / IPC / Pi load an isolated 1440-message session with Markdown code and tool results');
  await draft('SWITCH_A_DRAFT 独立草稿');
  const openedB = await evaluate(`window.pi.connect(${JSON.stringify(project)}, ${JSON.stringify(sessionB)})`);
  connectionB = openedB.connectionId;
  assert.ok(connectionB && connectionB !== connectionA);
  await select(connectionB, 'B');
  const importedB = await evaluate(`window.pi.rpc({type:'get_messages'}, ${JSON.stringify(connectionB)})`);
  assert.equal(importedB.messages.length, 1440);
  await draft('SWITCH_B_DRAFT 独立草稿');
  report.checks.push('Two real Pi processes each retain a separate large session and draft');

  for (let round = 0; round < 3; round++) {
    await measure(connectionA, 'A', 'tab');
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`), 'SWITCH_A_DRAFT 独立草稿');
    await measure(connectionB, 'B', 'tab');
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`), 'SWITCH_B_DRAFT 独立草稿');
  }
  report.checks.push('Repeated already-open tab switches preserve the correct transcript, tool results and drafts');
  const beforeHistory = await evaluate('window.pi.listConnections()');
  await waitFor('same-project historical session', `Boolean([...document.querySelectorAll('.session-item')].find(node => node.querySelector('strong')?.textContent === 'SWITCH_A'))`);
  await measure(connectionA, 'A', 'history');
  const afterHistory = await evaluate('window.pi.listConnections()');
  assert.equal(afterHistory.length, beforeHistory.length);
  assert.equal(afterHistory.find(connection => connection.sessionPath === sessionA)?.id, connectionA);
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`), 'SWITCH_A_DRAFT 独立草稿');
  report.checks.push('Clicking same-project history reuses the existing connection and restores its draft');
  await screenshot('tail');

  if(stage!=='baseline') {
    const openedC = await evaluate(`window.pi.connect(${JSON.stringify(otherProject)}, ${JSON.stringify(sessionC)})`);
    const connectionC = openedC.connectionId;
    await select(connectionC,'C');
    await draft('SWITCH_C_DRAFT 独立草稿');
    await measure(connectionB,'B','project-tab');
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'SWITCH_B_DRAFT 独立草稿');
    await measure(connectionC,'C','project-tab');
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'SWITCH_C_DRAFT 独立草稿');
    await measure(connectionB,'B','project');
    assert.equal((await evaluate('window.pi.listConnections()')).length,3,'sidebar project selection reuses B instead of creating a fourth connection');
    assert.equal((await evaluate(`window.pi.rpc({type:'get_state'})`)).sessionFile,sessionB,'native default selection agrees with B restored through the sidebar');
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'SWITCH_B_DRAFT 独立草稿');
    report.checks.push('Warm switches between hydrated projects keep their drafts; sidebar reopening restores most recently selected B rather than old A');
    await evaluate(`(() => {
      const a=${tab(connectionA)}.querySelector('[role="tab"]');
      const b=${tab(connectionB)}.querySelector('[role="tab"]');
      a.click(); b.click(); a.click(); b.click();
    })()`);
    await waitFor('rapid switches converge on B',`Boolean(${tab(connectionB)}?.querySelector('[role="tab"][aria-selected="true"]')) && ${messageTail('B')} && document.querySelector('textarea[aria-label="输入消息"]').value === 'SWITCH_B_DRAFT 独立草稿'`);
    assert.equal((await evaluate(`window.pi.rpc({type:'get_state'})`)).sessionFile,sessionB,'rapid clicks keep the native default connection and displayed conversation consistent');
    report.checks.push('Rapid A/B/A/B clicks settle on B with matching tab, transcript, draft and native default connection');
    await select(connectionA,'A');
  }

  // Reach the actual earliest message through progressive history controls or
  // top scrolling. Older messages must remain available after DOM windowing.
  await evaluate(`document.querySelector('.conversation-scroll').scrollTop = 0`);
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(`document.querySelector('.conversation-scroll').textContent.includes(${JSON.stringify(earliest('A'))})`)) break;
    const clicked = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.conversation-scroll button')];
      const target = buttons.find(button => button.getAttribute('aria-label') === '查看最早消息') || buttons.find(button => /更早|早期|加载历史|之前的消息|显示全部/.test((button.getAttribute('aria-label') || '') + button.textContent));
      if (target) { target.click(); return true; }
      document.querySelector('.conversation-scroll').scrollTop = 0;
      return false;
    })()`);
    await delay(clicked ? 150 : 250);
  }
  await waitFor('earliest history accessible', `document.querySelector('.conversation-scroll').textContent.includes(${JSON.stringify(earliest('A'))})`, 5000);
  await evaluate(`document.querySelector('.conversation-scroll').scrollTop = 120`);
  await delay(150);
  const savedScroll = await evaluate(`document.querySelector('.conversation-scroll').scrollTop`);
  await screenshot('early-history');
  await select(connectionB, 'B');
  await evaluate(`(() => { const node = ${tab(connectionA)}; node.querySelector('[role="tab"]').click(); })()`);
  await waitFor('A selected with restored early history', `Boolean(${tab(connectionA)}?.querySelector('[role="tab"][aria-selected="true"]')) && document.querySelector('.conversation-scroll').textContent.includes(${JSON.stringify(earliest('A'))})`);
  await delay(180);
  const restoredScroll = await evaluate(`document.querySelector('.conversation-scroll').scrollTop`);
  report.scroll = {saved:savedScroll,restored:restoredScroll};
  assert.ok(Math.abs(restoredScroll - savedScroll) <= 30, 'returning to A keeps the previously viewed scroll position');
  report.checks.push('Earliest history remains available and its reading position survives switching away and back');

  const frames = report.measurements.map(sample => sample.nextFrameMs).sort((a,b) => a-b);
  report.summary = {
    switches:frames.length, medianFrameMs:frames[Math.floor(frames.length/2)], maxFrameMs:Math.max(...frames),
    maxTabMs:Math.max(...report.measurements.map(sample => sample.tabMs)),
    maxRenderedMessages:Math.max(...report.measurements.map(sample => sample.renderedMessages)),
    maxDomElements:Math.max(...report.measurements.map(sample => sample.domElements)),
    totalLongTasks:report.measurements.reduce((sum,sample) => sum+sample.longTasks.length,0),
    maxLongTaskMs:Math.max(0,...report.measurements.flatMap(sample => sample.longTasks.map(task=>task.duration))),
    warmFullSnapshots:report.measurements.flatMap(sample=>sample.ipc).filter(entry=>(entry.snapshotMessages||0)>0||entry.command==='get_messages').length,
    warmHistoryReads:report.measurements.filter(sample=>['tab','history'].includes(sample.kind)).flatMap(sample=>sample.ipc).filter(entry=>entry.channel==='pi:listSessions'||entry.command==='get_available_thinking_levels').length,
  };
  for (const [key,limit] of Object.entries(limits)) if (report.summary[key] > limit) report.performanceFailures.push(`${key}: ${report.summary[key].toFixed(1)} > ${limit}`);
  if (enforce) assert.equal(report.performanceFailures.length,0, 'large-session switching stays within conservative time and DOM bounds');
  if (enforce) {
    assert.equal(report.summary.warmFullSnapshots,0,'already-loaded tabs and same-project history never request full snapshots again');
    assert.equal(report.summary.warmHistoryReads,0,'warm switches do not reread same-project history or thinking-level options');
  }
  report.checks.push(enforce ? 'Large-session switches satisfy bounded DOM and conservative frame latency budgets' : 'Baseline records observed frame latency, long tasks and full transcript DOM without enforcing optimized budgets');
  await finish();
}

async function fixtureSession(name,ownerProject=project,turns=360) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const encoded = `--${path.resolve(ownerProject).replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`;
  const directory = path.join(agent,'sessions',encoded);
  await fs.mkdir(directory,{recursive:true});
  const file = path.join(directory,`${name.toLowerCase()}-${id}.jsonl`);
  const entries = [{type:'session',version:3,id,cwd:ownerProject,timestamp}];
  let parentId = null;
  const append = entry => { const next = {id:crypto.randomUUID().slice(0,8),parentId,timestamp,...entry}; parentId=next.id; entries.push(next); };
  append({type:'model_change',provider:'switch-fixture',modelId:'switch-fixture'});
  const usage = {input:16,output:32,cacheRead:0,cacheWrite:0,totalTokens:48,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const assistant = content => ({role:'assistant',content,api:'openai-completions',provider:'switch-fixture',model:'switch-fixture',stopReason:'stop',usage,timestamp:Date.now()});
  for(let index=0;index<turns;index++) {
    const call = `${name}-tool-${index}`;
    const marker = index===0 ? earliest(name) : `SWITCH_${name}_USER_${index}`;
    append({type:'message',message:{role:'user',content:[{type:'text',text:`${marker}：第 ${index+1} 次历史检查。\n检查任务与代码片段，保留原有信息。`}],timestamp:Date.now()}});
    append({type:'message',message:assistant([{type:'text',text:`检查 ${name} 的第 ${index+1} 个文件，并读取已有结果。`},{type:'toolCall',id:call,name:'read',arguments:{path:`src/example-${index}.ts`}}])});
    append({type:'message',message:{role:'toolResult',toolCallId:call,toolName:'read',content:[{type:'text',text:Array.from({length:20},(_,line)=>`${name} read result ${index}:${line}: ${'result data '.repeat(8)}`).join('\n')}],isError:false,timestamp:Date.now()}});
    const code = Array.from({length:18},(_,line)=>`const result_${line} = inspectRecord(${index}, ${line}, { enabled: true });`).join('\n');
    const finalMarker = index===turns-1 ? tail(name) : `SWITCH_${name}_RESULT_${index}`;
    append({type:'message',message:assistant([{type:'text',text:`${finalMarker}：这一步已经完成。\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n- 保留已有文件\n- 检查结果已经确认\n`}])});
  }
  append({type:'session_info',name:`SWITCH_${name}`});
  await fs.writeFile(file,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
  return file;
}
async function start() {
  await Promise.all([fs.mkdir(project,{recursive:true}),fs.mkdir(otherProject,{recursive:true}),fs.mkdir(agent,{recursive:true}),fs.mkdir(desktop,{recursive:true})]);
  let buildRoot = root;
  if(stage==='baseline') {
    buildRoot = path.join(runRoot,'compiled');
    await Promise.all([fs.cp(path.join(root,'dist'),path.join(buildRoot,'dist'),{recursive:true}),fs.cp(path.join(root,'dist-electron'),path.join(buildRoot,'dist-electron'),{recursive:true}),fs.copyFile(path.join(root,'package.json'),path.join(buildRoot,'package.json'))]);
  }
  report.packageVersion = JSON.parse(await fs.readFile(path.join(buildRoot,'package.json'),'utf8')).version;
  report.packageVersionSource = stage==='baseline' ? 'Frozen package.json beside the measured compiled snapshot' : 'package.json of the measured compiled checkout';
  report.buildMainSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(buildRoot,'dist-electron','main.cjs'))).digest('hex');
  report.buildHtmlSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(buildRoot,'dist','index.html'))).digest('hex');
  report.compiledAssets = await Promise.all((await fs.readdir(path.join(buildRoot,'dist','assets'))).filter(file=>/\.(js|css)$/.test(file)).sort().map(async file=>({file,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(buildRoot,'dist','assets',file))).digest('hex')})));
  [sessionA,sessionB] = await Promise.all([fixtureSession('A'),fixtureSession('B')]);
  if(stage!=='baseline') sessionC = await fixtureSession('C',otherProject,2);
  report.fixture = {messageCountEach:1440,visibleMessagesEach:1080,sessionA,sessionB};
  await fs.writeFile(path.join(desktop,'preferences.json'),JSON.stringify({theme:'light',projects:[{path:project,name:'大会话切换验收',lastOpened:new Date().toISOString()},...(stage!=='baseline'?[{path:otherProject,name:path.basename(otherProject),lastOpened:new Date().toISOString()}]:[])],lastProject:project,lastSessions:{[project]:sessionA}}));
  server=http.createServer(async(request,response)=> {
    if(request.method!=='POST'||request.url!=='/v1/chat/completions') {response.writeHead(404).end();return;}
    let raw='';for await(const chunk of request) raw+=chunk;
    const body=JSON.parse(raw);assert.equal(body.model,'switch-fixture');report.modelRequests++;
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.end(`data: ${JSON.stringify({id:'switch-fixture',object:'chat.completion.chunk',created:1,model:'switch-fixture',choices:[{index:0,delta:{role:'assistant',content:'SWITCH_LOCAL_REPLY：本地验收回复。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(agent,'models.json'),JSON.stringify({providers:{'switch-fixture':{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'isolated-fixture',models:[{id:'switch-fixture',name:'本地切换验收模型',reasoning:false,contextWindow:1_000_000,maxTokens:2048}]}}}));
  await fs.writeFile(path.join(agent,'settings.json'),JSON.stringify({defaultProvider:'switch-fixture',defaultModel:'switch-fixture',defaultThinkingLevel:'off'}));
  app.on('browser-window-created',(_event,created)=> {
    if(mainWindow)return;mainWindow=created;created.webContents.setBackgroundThrottling(false);
    created.webContents.once('did-finish-load',()=>void run().catch(finish));
    created.webContents.on('console-message',(_event,details)=>{if(details?.level==='error') report.errors.push(details.message);});
  });
  require(path.join(buildRoot,'dist-electron','main.cjs'));
}
process.on('uncaughtException',error=>void finish(error));
process.on('unhandledRejection',error=>void finish(error));
void start().catch(finish);
