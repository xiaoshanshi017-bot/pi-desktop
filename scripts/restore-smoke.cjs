// Private multi-launch workspace restore acceptance; launched by the runner.
const { app, dialog } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const runRoot = path.resolve(process.env.PI_RESTORE_SMOKE_ROOT || '');
const phase = process.env.PI_RESTORE_SMOKE_PHASE || 'seed';
const root = path.resolve(__dirname,'..');
assert.ok(runRoot.startsWith(path.join(root,'output','qa','restore')+path.sep),'Only private QA profiles may be used');
process.env.PI_DESKTOP_USER_DATA = path.join(runRoot,'desktop');
process.env.PI_CODING_AGENT_DIR = path.join(runRoot,'agent');
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
app.setAppPath(root);
const report={phase,started:new Date().toISOString(),checks:[],errors:[],screenshots:[],events:[],persistedCountsDuringRestore:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let mainWindow;
let manifest;
let finishing=false;
let loadedAt;
let watchPersistence=false;
let watchTimer;
const deadline=setTimeout(()=>void finish(new Error(`Restore phase ${phase} exceeded 180 seconds`)),180_000);

function check(message) {report.checks.push(message);console.log(`[restore ${phase}] ${message}`);}
async function evaluate(source) {
  const result=await mainWindow.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(error){return {ok:false,error:error.stack||String(error)};}})()`,true);
  if(!result.ok)throw new Error(`${result.error}\nRenderer source: ${source}`);
  return result.value;
}
async function waitFor(label,source,timeout=40_000) {
  const until=Date.now()+timeout;
  while(Date.now()<until) {if(await evaluate(source))return;await delay(100);}
  throw new Error(`Timed out: ${label}. UI: ${await evaluate('document.body.innerText.slice(-6500)')}`);
}
const namedTab=name=>`[...document.querySelectorAll('.conversation-tab-wrap')].find(node=>node.querySelector('.conversation-tab-label strong')?.textContent===${JSON.stringify(`RESTORE_${name}`)})`;
const emptyTab=()=>`[...document.querySelectorAll('.conversation-tab-wrap')].find(node=>node.querySelector('.conversation-tab-label small')?.textContent===${JSON.stringify(path.basename(manifest.projectC))})`;
const selected=expr=>`Boolean(${expr}?.querySelector('[role="tab"][aria-selected="true"]'))`;
async function selectExpression(expr,bodyMarker) {
  await waitFor('cached or live tab',`Boolean(${expr})`);
  await evaluate(`(()=>{${expr}.querySelector('[role="tab"]').click();return true;})()`);
  await waitFor('selected tab',selected(expr));
  if(bodyMarker)await waitFor('selected body',`document.querySelector('.conversation-scroll').textContent.includes(${JSON.stringify(bodyMarker)})`);
}
async function openHistory(name) {
  const item=`[...document.querySelectorAll('.session-item')].find(node=>node.querySelector('strong')?.textContent===${JSON.stringify(`RESTORE_${name}`)})`;
  await waitFor(`history ${name}`,`Boolean(${item}) && !${item}.disabled`);
  await evaluate(`(()=>{${item}.click();return true;})()`);
  await waitFor(`hydrated history ${name}`,`${selected(namedTab(name))} && Boolean(document.querySelector('.connection-pill.connected')) && document.querySelector('.conversation-scroll').textContent.includes(${JSON.stringify(`RESTORE_${name}_TAIL`)})`);
  return {connectionId:await evaluate(`${namedTab(name)}.dataset.connectionId`)};
}
async function openProject(project) {
  const item=`[...document.querySelectorAll('.recent-project')].find(node=>node.textContent.trim()===${JSON.stringify(path.basename(project))})`;
  await waitFor('recent project',`Boolean(${item}) && !${item}.disabled`);
  await evaluate(`(()=>{${item}.click();return true;})()`);
  await waitFor('hydrated project',`Boolean(document.querySelector('.connection-pill.connected')) && document.querySelector('.project-breadcrumb')?.textContent.trim()===${JSON.stringify(path.basename(project))}`);
  return {connectionId:await evaluate(`document.querySelector('.conversation-tab-wrap:has([role="tab"][aria-selected="true"])').dataset.connectionId`)};
}
async function draft(value) {
  await evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor('composer draft',`document.querySelector('textarea[aria-label="输入消息"]').value===${JSON.stringify(value)}`);
}
async function workspace() {return JSON.parse(await fs.readFile(path.join(manifest.desktop,'workspace.json'),'utf8'));}
async function persisted(predicate,label,timeout=15_000) {
  const until=Date.now()+timeout;
  while(Date.now()<until) {try {const value=await workspace();if(predicate(value))return value;}catch{}await delay(100);}
  throw new Error(`Timed out waiting for persisted workspace: ${label}`);
}
async function screenshot(name) {
  const file=path.join(root,'output','playwright',`restore-${phase}-${name}.png`);
  await fs.mkdir(path.dirname(file),{recursive:true});await delay(120);
  await fs.writeFile(file,(await mainWindow.webContents.capturePage()).toPNG());report.screenshots.push(file);
}
async function finish(error) {
  if(finishing)return;finishing=true;clearTimeout(deadline);clearInterval(watchTimer);
  if(error){report.errors.push(error.stack||String(error));console.error(error);try{await screenshot('failure');}catch{}}
  report.success=report.errors.length===0;report.finished=new Date().toISOString();
  await fs.writeFile(path.join(runRoot,`${phase}-report.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify({phase,success:report.success,checks:report.checks,errors:report.errors,cacheRenderMs:report.cacheRenderMs},null,2));
  if(error){app.exit(1);return;}
  // Exercise the app's normal stop-and-exit path. Disconnecting every tab here
  // would intentionally erase the workspace that the next process must restore.
  mainWindow.close();
  setTimeout(()=>{console.error('Normal QA window close did not finish within 20s');app.exit(1);},20_000).unref();
}
async function assertCachedPaint(count) {
  await waitFor('cache-first tabs, B body and draft',`document.querySelectorAll('.conversation-tab-wrap').length===${count} && ${selected(namedTab('B'))} && document.querySelector('.conversation-scroll').textContent.includes('RESTORE_B_EARLIEST') && document.querySelector('textarea[aria-label="输入消息"]').value==='RESTORE_B_DRAFT 未发送内容'`,6000);
  report.cacheRenderMs=Date.now()-loadedAt;
  const ready=(await fs.readFile(path.join(manifest.agent,'boot-ready.jsonl'),'utf8')).trim();
  assert.equal(ready,'','cached workspace paints before any delayed real Pi process initializes');
  assert.ok(report.cacheRenderMs<4000,'cached workspace does not wait for fresh Pi startup');
  assert.ok(await evaluate(`document.querySelector('.attachments').textContent.includes('B-缓存附件.txt')`),'unsent attachment is already visible from cache');
  assert.equal(await evaluate(`document.querySelector('.messages').dataset.windowStart`),'0');
  assert.equal(await evaluate(`document.querySelector('.messages').dataset.historyLatest`),'false');
  assert.equal(await evaluate(`Boolean(document.querySelector('.inspector'))`),true,'saved inspector preference is restored');
  const scroll=await evaluate(`document.querySelector('.conversation-scroll').scrollTop`);
  report.cachedScrollTop=scroll;
  assert.ok(Math.abs(scroll-manifest.expected.bScrollTop)<=35,'cached history reading position is restored');
  report.cachedTabStatuses=await evaluate(`[...document.querySelectorAll('.conversation-tab-wrap')].map(node=>({id:node.dataset.connectionId,status:node.dataset.status}))`);
  const expectedIds=phase==='restore'?[manifest.expected.a,manifest.expected.b,manifest.expected.c]:phase==='after-close'?[manifest.expected.b]:[manifest.expected.b,manifest.expected.d,manifest.expected.e];
  assert.deepEqual(report.cachedTabStatuses.map(tab=>tab.id).sort(),expectedIds.sort(),'cached tabs retain their stable connection UUIDs across processes');
  await screenshot('cache-first');
  assert.equal((await fs.readFile(path.join(manifest.agent,'boot-ready.jsonl'),'utf8')).trim(),'','cache-first screenshot is also captured before real Pi initialization');
  check('Saved tabs, active B, body, draft, attachment, earliest page and scroll paint before any real Pi process is ready');
}
async function allConnected(count) {
  await waitFor('background reconnect complete',`[...document.querySelectorAll('.conversation-tab-wrap')].filter(node=>node.dataset.status==='connected').length===${count}`,100_000);
}
async function closeTab(expr) {
  await waitFor('tab close control',`Boolean(${expr}?.querySelector('.conversation-tab-close'))`);
  await evaluate(`(()=>{${expr}.querySelector('.conversation-tab-close').click();return true;})()`);
  await waitFor('closed tab removed',`!(${expr})`,30_000);
}

async function seed() {
  await waitFor('isolated initial Pi',`Boolean(document.querySelector('.connection-pill.connected')) && document.querySelector('.conversation-scroll').textContent.includes('RESTORE_A_TAIL')`,110_000);
  assert.equal(path.resolve((await evaluate('window.pi.bootstrap()')).diagnostics.agentDir),manifest.agent);
  const a=(await evaluate('window.pi.listConnections()'))[0].id;
  const bConnection=await openHistory('B');
  await selectExpression(namedTab('B'),'RESTORE_B_TAIL');
  const cConnection=await openProject(manifest.projectC);
  await selectExpression(emptyTab());
  const cState=await evaluate(`window.pi.rpc({type:'get_state'},${JSON.stringify(cConnection.connectionId)})`);
  if(cState.sessionFile)assert.equal(await fs.stat(cState.sessionFile).then(()=>true,()=>false),false,'empty tab has no durable JSONL file');
  await draft('RESTORE_C_DRAFT 空会话仍需恢复');
  await selectExpression(namedTab('A'),'RESTORE_A_TAIL');
  await draft('[restore-long-tool] 退出前启动真实长工具');
  await evaluate(`(()=>{document.querySelector('button[aria-label="发送消息"]').click();return true;})()`);
  await waitFor('A real tool running',`[...document.querySelectorAll('.tool-live-preview pre')].some(node=>node.textContent.includes('RESTORE_OLD_BUSY_TOOL_BEGIN'))`);
  await draft('RESTORE_A_DRAFT A自己的未发送内容');
  await selectExpression(namedTab('B'),'RESTORE_B_TAIL');
  await draft('RESTORE_B_DRAFT 未发送内容');
  await evaluate(`(()=>{document.querySelector('button[aria-label="添加图片或文本文件"]').click();return true;})()`);
  await waitFor('text attachment',`document.querySelector('.attachments')?.textContent.includes('B-缓存附件.txt')`);
  await evaluate(`(()=>{document.querySelector('button[aria-label="查看最早消息"]').click();return true;})()`);
  await waitFor('B earliest page',`document.querySelector('.conversation-scroll').textContent.includes('RESTORE_B_EARLIEST')`);
  await evaluate(`(()=>{const button=document.querySelector('button[aria-label="展开会话详情"]');if(button)button.click();return true;})()`);
  await waitFor('inspector open',`Boolean(document.querySelector('.inspector'))`);
  await evaluate(`(()=>{document.querySelector('.conversation-scroll').scrollTop=140;return true;})()`);
  await delay(200);
  const bScrollTop=await evaluate(`document.querySelector('.conversation-scroll').scrollTop`);
  const cache=await persisted(value=>value.tabs?.length===3&&value.activeId===bConnection.connectionId&&value.tabs.find(tab=>tab.id===bConnection.connectionId)?.view.draft==='RESTORE_B_DRAFT 未发送内容'&&value.tabs.find(tab=>tab.id===bConnection.connectionId)?.view.attachments?.length===1&&value.tabs.find(tab=>tab.id===bConnection.connectionId)?.ui.windowStart===0&&Math.abs((value.tabs.find(tab=>tab.id===bConnection.connectionId)?.ui.scrollTop||0)-bScrollTop)<=35&&value.ui?.inspector===true,'all seeded tabs and B unsent state, page, scroll and inspector');
  assert.equal(cache.tabs.find(tab=>tab.id===cConnection.connectionId).view.draft,'RESTORE_C_DRAFT 空会话仍需恢复');
  assert.equal(cache.tabs.find(tab=>tab.id===bConnection.connectionId).view.attachments[0].content.includes('RESTORE_B_ATTACHMENT_CONTENT'),true);
  manifest.expected={a,b:bConnection.connectionId,c:cConnection.connectionId,bScrollTop,cSessionFile:cState.sessionFile};
  await fs.writeFile(path.join(runRoot,'manifest.json'),JSON.stringify(manifest,null,2));
  check('Seeded two projects and three tabs, including a fileless empty session, separate drafts and unsent B attachment');
  check('Active B retains its earliest history page and scroll; A is a real running tool before normal stop-and-exit');
  await screenshot('seeded');
}
async function restore() {
  await assertCachedPaint(3);
  assert.ok(report.persistedCountsDuringRestore.every(sample=>sample.count>=3),'restoration never replaces persisted sibling tabs with a partial list');
  watchPersistence=false;
  await selectExpression(namedTab('A'));
  assert.equal(await evaluate(`document.querySelectorAll('.tool-state .spin').length`),0,'old cached tools do not pretend to be running');
  assert.equal(await evaluate(`Boolean(document.querySelector('.run-progress.active'))`),false,'old run progress is not active after restart');
  await selectExpression(emptyTab());
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'RESTORE_C_DRAFT 空会话仍需恢复');
  assert.notEqual(await evaluate(`${emptyTab()}.dataset.status`),'connected','empty tab is closed before its delayed Pi reconnect finishes');
  await closeTab(emptyTab());
  await persisted(value=>value.tabs.length===2&&!value.tabs.some(tab=>tab.id===manifest.expected.c),'closed empty tab omitted without waiting for a session file');
  check('Cached stale tools are interrupted; fileless empty tab and its draft restore and can close during background reconnect');
  await selectExpression(namedTab('B'),'RESTORE_B_EARLIEST');
  await allConnected(2);
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'RESTORE_B_DRAFT 未发送内容');
  assert.equal(await evaluate(`document.querySelector('.attachments').textContent.includes('B-缓存附件.txt')`),true);
  assert.equal(await evaluate(selected(namedTab('B'))),true,'background completions never pull selection away from B');
  assert.equal(await evaluate(`document.querySelector('.messages').dataset.windowStart`),'0');
  await selectExpression(namedTab('A'));
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'RESTORE_A_DRAFT A自己的未发送内容');
  await closeTab(namedTab('A'));
  await selectExpression(namedTab('B'),'RESTORE_B_EARLIEST');
  await persisted(value=>value.tabs.length===1&&value.activeId===manifest.expected.b,'closing A preserves active cached B');
  check('Background reconnect preserves all drafts, B attachment and old page; closing A does not erase B');
  await screenshot('restored');
}
async function afterClose() {
  await assertCachedPaint(1);
  assert.equal(await evaluate(`Boolean(${namedTab('A')})`),false);
  assert.equal(await evaluate(`Boolean(${emptyTab()})`),false);
  check('A second normal relaunch restores only B; closed normal and empty tabs stay closed');
  await allConnected(1);
  const d=await openProject(manifest.projectD);
  await selectExpression(namedTab('D'),'RESTORE_D_TAIL');
  await openProject(manifest.projectA);
  const e=await openHistory('E');
  await selectExpression(namedTab('E'),'RESTORE_E_TAIL');
  await selectExpression(namedTab('B'),'RESTORE_B_EARLIEST');
  await persisted(value=>value.tabs.length===3&&value.activeId===manifest.expected.b,'B and both invalidation fixtures persisted');
  manifest.expected.d=d.connectionId;manifest.expected.e=e.connectionId;
  await fs.writeFile(path.join(runRoot,'manifest.json'),JSON.stringify(manifest,null,2));
  check('Prepared two cached tabs whose project and JSONL will be removed only within this QA profile');
}
async function invalid() {
  await assertCachedPaint(3);
  watchPersistence=false;
  await waitFor('valid B reconnects despite invalid sibling tabs',`${namedTab('B')}?.dataset.status==='connected'`,110_000);
  await waitFor('invalid cached tabs stop reconnecting',`${namedTab('D')}?.dataset.status==='error' && ${namedTab('E')}?.dataset.status==='error'`,30_000);
  await selectExpression(namedTab('D'),'RESTORE_D_TAIL');
  assert.ok(await evaluate(`Boolean(document.querySelector('.notice.error'))`),'missing project explains failure while cached content stays readable');
  await screenshot('missing-project');
  await selectExpression(namedTab('E'),'RESTORE_E_TAIL');
  assert.ok(await evaluate(`Boolean(document.querySelector('.notice.error'))`),'missing JSONL explains failure while cached content stays readable');
  await screenshot('missing-jsonl');
  assert.equal(await fs.stat(manifest.sessionE).then(()=>true,()=>false),false,'restore does not recreate the deleted JSONL');
  await selectExpression(namedTab('B'),'RESTORE_B_EARLIEST');
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="输入消息"]').value`),'RESTORE_B_DRAFT 未发送内容');
  await persisted(value=>value.tabs.length===3&&value.activeId===manifest.expected.b,'failed siblings retained without overwriting valid B');
  check('Missing project and deleted JSONL keep their cache readable with clear errors; B restores normally, no file is silently recreated');
  await screenshot('invalid-siblings');
}

async function start() {
  manifest=JSON.parse(await fs.readFile(path.join(runRoot,'manifest.json'),'utf8'));
  report.packageVersion=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
  report.electronVersion=process.versions.electron;
  report.compiledMainSha256=crypto.createHash('sha256').update(await fs.readFile(path.join(root,'dist-electron','main.cjs'))).digest('hex');
  const html=await fs.readFile(path.join(root,'dist','index.html'),'utf8');
  report.compiledHtmlSha256=crypto.createHash('sha256').update(html).digest('hex');
  report.compiledAssets=[];
  for(const match of html.matchAll(/(?:src|href)="\.\/assets\/([^\"]+\.(?:js|css))"/g)) {
    report.compiledAssets.push({file:match[1],sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(root,'dist','assets',match[1]))).digest('hex')});
  }
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[manifest.attachment]});
  dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
  dialog.showErrorBox=(title,message)=>{report.errors.push(`${title}: ${message}`);};
  if(phase!=='seed') {
    watchPersistence=true;
    const saved=await workspace();
    report.persistedCountsDuringRestore.push({time:Date.now(),count:saved.tabs?.length,activeId:saved.activeId});
    watchTimer=setInterval(()=>{if(watchPersistence)void workspace().then(value=>report.persistedCountsDuringRestore.push({time:Date.now(),count:value.tabs?.length,activeId:value.activeId})).catch(()=>{});},100);
  }
  app.on('browser-window-created',(_event,window)=> {
    if(mainWindow)return;mainWindow=window;window.webContents.setBackgroundThrottling(false);
    const send=window.webContents.send.bind(window.webContents);
    window.webContents.send=(channel,...args)=> {
      if(channel==='pi:event'&&['connection_status','connections_changed','agent_start','tool_execution_start'].includes(args[0]?.type))report.events.push({time:Date.now(),type:args[0].type,connectionId:args[0].connectionId,status:args[0].status});
      return send(channel,...args);
    };
    window.webContents.once('did-finish-load',()=>{loadedAt=Date.now();void (phase==='seed'?seed():phase==='restore'?restore():phase==='after-close'?afterClose():invalid()).then(()=>finish(),finish);});
    window.webContents.on('console-message',(_event,details)=>{if(details?.level==='error')report.errors.push(details.message);});
  });
  require(path.join(root,'dist-electron','main.cjs'));
}
process.on('uncaughtException',error=>void finish(error));
process.on('unhandledRejection',error=>void finish(error));
void start().catch(finish);
