// Real renderer + sandboxed preload + IPC + pinned Pi. No external requests or user data.
const { app, ipcMain, dialog } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const footerOnly = process.argv.includes('--footer-case');
const failureMode = footerOnly || process.argv.includes('--failure-cases');
const qaRoot = path.join(root, 'output', 'qa', failureMode ? 'model-import-cases' : 'model-import');
let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;
const runRoot = path.join(qaRoot, `run-${Date.now()}`);
const project = path.join(runRoot, '模型导入验收项目');
const agent = path.join(runRoot, 'agent');
const desktop = path.join(runRoot, 'desktop');
const appRoot = path.join(runRoot, 'app');
const runtimeRoot = path.join(appRoot, 'build', 'runtime', 'win32-x64');
const configFile = path.join(agent, 'models.json');
const attachmentFile = path.join(runRoot, '模型刷新保留附件.txt');
const sentinel = `MODEL_IMPORT_QA_SECRET_${crypto.randomUUID()}`;
const wrongSentinel = `${sentinel}_INVALID`;
const existingSentinel = `MODEL_IMPORT_EXISTING_${crypto.randomUUID()}`;
const replacementSentinel = `MODEL_IMPORT_REPLACEMENT_${crypto.randomUUID()}`;
const provider = 'model-import-fixture';
const selectedIds = ['import-alpha-chat', 'import-alpha-reasoner'];
const excludedId = 'import-beta-unchecked';
const catalog = [
  { id: selectedIds[0], object: 'model', name: '导入 Alpha 对话', owned_by: 'local-fixture' },
  { id: selectedIds[1], object: 'model', name: '导入 Alpha 推理', owned_by: 'local-fixture', reasoning: true },
  { id: excludedId, object: 'model', name: '不应导入的 Beta', owned_by: 'local-fixture' },
];
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
fsSync.mkdirSync(desktop, { recursive: true });
fsSync.mkdirSync(path.join(runRoot, 'chromium'), { recursive: true });
app.setPath('userData', desktop);
app.setPath('sessionData', path.join(runRoot, 'chromium'));
app.setAppPath(appRoot);

const report = { started: new Date().toISOString(), runRoot, checks: [], requests: [], ipc: [], screenshots: [], errors: [], rendererErrors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let mainWindow;
let server;
let origin;
let responseMode = 'models';
let initialConfig;
let initialSettings;
let finishing = false;
let lastPreviewToken;
let lastPreview;
let saveDelay = 0;
const deadline = setTimeout(() => void finish(new Error('Model import acceptance exceeded 240 seconds')), 240_000);

function check(message) { report.checks.push(message); console.log(`[model import] ${message}`); }
function redact(value) {
  let result = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  for (const key of [wrongSentinel, sentinel, existingSentinel, replacementSentinel]) result = result.replaceAll(key, '[QA KEY REDACTED]');
  return result;
}
function assertPublic(value, label) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  for (const key of [sentinel, wrongSentinel, existingSentinel, replacementSentinel]) assert.equal(raw.includes(key), false, `${label} must not expose an API key`);
}
async function evaluate(source) {
  const result = await mainWindow.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(error){return {ok:false,error:error.stack||String(error)};}})()`, true);
  if (!result.ok) throw new Error(redact(`${result.error}\nRenderer source: ${source}`));
  return result.value;
}
async function waitFor(label, source, timeout = 25_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await evaluate(source); if (value) return value; await delay(100); }
  throw new Error(redact(`Timed out: ${label}. UI: ${await evaluate('document.body.innerText.slice(-8000)')}`));
}
async function waitNative(label, predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function click(selector) {
  await waitFor(`enabled ${selector}`, `Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`);
  await evaluate(`(()=>{document.querySelector(${JSON.stringify(selector)}).click();return true;})()`);
}
async function input(selector, value) {
  await waitFor(`input ${selector}`, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor(`input value ${selector}`, `document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`);
}
async function screenshot(name) {
  const file = path.join(root, 'output', 'playwright', `model-import-${name}.png`);
  const runFile = path.join(runRoot, 'screenshots', `${name}.png`);
  await Promise.all([fs.mkdir(path.dirname(file), { recursive: true }), fs.mkdir(path.dirname(runFile), { recursive: true })]);
  await delay(120);
  const image = (await mainWindow.webContents.capturePage()).toPNG();
  await Promise.all([fs.writeFile(file, image), fs.writeFile(runFile, image)]);
  report.screenshots.push(file);
  (report.runScreenshots ||= []).push(runFile);
}
async function assertUnchanged(label) {
  assert.equal(await fs.readFile(configFile, 'utf8'), initialConfig, `${label} cannot write models.json`);
  assert.equal(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'), initialSettings, `${label} cannot write settings.json`);
}
async function assertPublicState(label) {
  const bootstrap = await evaluate('window.pi.bootstrap({workspace:true})');
  assertPublic(bootstrap, `${label} bootstrap/diagnostics/summary/workspace`);
  assertPublic(await evaluate('document.body.innerText'), `${label} rendered text`);
  const saved = await fs.readFile(path.join(desktop, 'workspace.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  assertPublic(saved, `${label} persisted workspace`);
  if (origin) assert.equal(saved.includes(origin), false, `${label} importer URL draft must not be persisted with conversation state`);
  const preferences = await fs.readFile(path.join(desktop, 'preferences.json'), 'utf8');
  assertPublic(preferences, `${label} preferences`);
  if (origin) assert.equal(preferences.includes(origin), false, `${label} importer URL must not become a desktop preference`);
}

// These selectors and two bridge adapters are kept together for the feature's
// final UI/API contract. No product method is replaced by the acceptance test.
const controls = {
  section: '.model-import', url: 'input[name="model-api-url"]', key: 'input[name="model-api-key"]',
  provider: 'input[name="model-api-provider"]', search: 'input[aria-label="搜索 API 模型"]',
  discover: '.model-import-fetch button', save: '.model-import-actions button', error: '.model-import-error',
  checkbox: id => `.model-import-model input[aria-label="添加模型 ${id}"]`,
};
async function discoverApi(url, apiKey = sentinel, requestedProvider = provider) {
  const result = await evaluate(`window.pi.previewModels(${JSON.stringify({ url, apiKey, provider: requestedProvider })})`);
  assertPublic(result, 'model discovery preview');
  return result;
}
async function importApi(preview, ids) {
  const result = await evaluate(`window.pi.importModels(${JSON.stringify({ token: preview.token, provider: preview.provider, modelIds: ids })})`);
  assertPublic(result, 'model import result');
  return result;
}
async function configureForm(url, apiKey = sentinel, requestedProvider = provider) {
  await input(controls.url, url);
  await input(controls.key, apiKey);
  await input(controls.provider, requestedProvider);
}
async function waitCatalog() {
  await waitFor('unique model catalog', `document.querySelectorAll('.model-import-model').length===${catalog.length} && !document.querySelector(${JSON.stringify(controls.discover)}).disabled`);
}
async function closeSettings() {
  await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');const button=[...dialog.querySelectorAll('.modal-actions button')].find(node=>node.textContent.trim()==='关闭');if(!button)throw new Error('Missing settings close control');button.click();return true;})()`);
  await waitFor('settings closed', '!document.querySelector(".settings-body")');
}
async function feedbackVisible(selector, label) {
  const bounds = await waitFor(label, `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;const rect=node.getBoundingClientRect();const body=document.querySelector('.settings-body');const clip=(body?.contains(node)?body:document.querySelector('[role="dialog"]')).getBoundingClientRect();return rect.bottom>clip.top&&rect.top<clip.bottom&&rect.top>=0&&rect.bottom<=innerHeight?{bounds:rect.toJSON(),clip:clip.toJSON()}:false;})()`);
  (report.feedbackVisibility ||= []).push({ label, ...bounds });
  return bounds;
}
async function expectedRows(count) {
  await waitFor(`catalog with ${count} rows`, `document.querySelectorAll('.model-import-model').length===${count} && !document.querySelector(${JSON.stringify(controls.discover)}).disabled`);
}
async function savedFeedback(label, footer = true) {
  await waitFor(label, 'Boolean(document.querySelector(".model-import-success")) && !document.querySelector(".model-import-preview[aria-busy=true]")');
  if (footer) await feedbackVisible('.settings-feedback.success', `${label} footer confirmation`);
}
async function checkModelPicker(ids, label) {
  await click('.model-picker-trigger');
  for (const id of ids) await waitFor(`${label} model ${id}`, `Boolean(document.querySelector(${JSON.stringify(`.model-picker-option[data-model-key="${provider}/${id}"]`)}))`);
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(`.model-picker-option[data-model-key="${provider}/${excludedId}"]`)}))`), false, 'unselected models must not appear');
  assertPublic(await evaluate('document.querySelector(".model-picker-panel").innerText'), `${label} model picker`);
}

async function run() {
  // Guard old compiled builds so an accidental early run cannot silently
  // exercise a placeholder bridge. All paths remain private regardless.
  await waitFor('isolated pinned Pi ready', 'Boolean(document.querySelector(".connection-pill.connected")) && !document.querySelector(".new-chat").disabled', 90_000);
  const boot = await evaluate('window.pi.bootstrap({workspace:false})');
  assert.equal(path.resolve(boot.diagnostics.agentDir), agent);
  assert.equal(path.resolve(boot.diagnostics.runtimeRoot), runtimeRoot);
  assert.equal(boot.diagnostics.piSource, 'bundled');
  report.runtime = boot.diagnostics;
  assertPublic(boot, 'initial bootstrap');
  assert.equal(await evaluate('typeof window.pi.previewModels'), 'function', 'Build the model-import feature before running this acceptance');
  assert.equal(await evaluate('typeof window.pi.importModels'), 'function');
  assert.equal(await evaluate('typeof window.pi.reloadModels'), 'function');
  assert.equal(await evaluate('typeof window.pi.configureModelReasoning'), 'function');
  check('Actual Electron/preload/Pi use a private profile and pinned source adapters; initial diagnostics contain no credentials');
  if (footerOnly) await exerciseFooterCase();
  else if (failureMode) await exerciseFailureCases();
  else { await exerciseImport(); await exerciseSaveRegressions(); await exerciseReasoningConfiguration(); }
  await finish();
}

async function exerciseFooterCase() {
  await click('.settings-button');
  await configureForm(origin, sentinel, 'footer-save-fixture');
  await click(controls.discover); await waitCatalog();
  await click(controls.checkbox(selectedIds[0]));
  await evaluate('document.querySelector(".model-import-actions").scrollIntoView({block:"center"})');
  await screenshot('case-footer-before');
  const importsBefore = report.ipc.filter(item => item.channel === 'pi:importModels').length;
  const preferencesBefore = report.ipc.filter(item => item.channel === 'pi:savePreferences').length;
  await click('.modal-actions .button.primary');
  await waitNative('footer preference handler completed', async () => report.ipc.filter(item => item.channel === 'pi:savePreferences').length > preferencesBefore && report.ipc.filter(item => item.channel === 'pi:savePreferences').at(-1).ok);
  await delay(250);
  const after = await fs.readFile(configFile, 'utf8');
  const visible = await evaluate('({modalClosed:!document.querySelector(".settings-body"),notice:document.querySelector(".notice")?.innerText||""})');
  assertPublic(visible, 'footer result');
  report.cases = [{ name: 'footer-selected', ...visible, fileUnchanged: after === initialConfig, nativeImportCalls: report.ipc.filter(item => item.channel === 'pi:importModels').length - importsBefore }];
  await screenshot('case-footer-after');
  check(`Footer with an explicitly selected model: modalClosed=${visible.modalClosed}, modelsFileUnchanged=${after === initialConfig}, nativeImportCalls=${report.cases[0].nativeImportCalls}`);
}

async function failureFeedback(name, before) {
  const visible = await evaluate(`(()=>{const error=document.querySelector('.model-import-error');const body=document.querySelector('.settings-body');const er=error?.getBoundingClientRect(),br=body.getBoundingClientRect();return {error:error?.innerText||'',errorVisible:Boolean(er&&er.bottom>br.top&&er.top<br.bottom),errorFullyVisible:Boolean(er&&er.top>=br.top&&er.bottom<=br.bottom),errorBounds:er?.toJSON(),bodyBounds:br.toJSON(),selected:document.querySelectorAll('.model-import-model input:checked').length,previewRetained:Boolean(document.querySelector('.model-import-preview')),saving:Boolean(document.querySelector('.model-import-preview[aria-busy="true"]'))};})()`);
  assertPublic(visible, `${name} feedback`);
  const after = await fs.readFile(configFile, 'utf8');
  const result = { name, ...visible, fileUnchanged: before === after };
  (report.cases ||= []).push(result);
  await screenshot(`case-${name}`);
  return result;
}

async function exerciseFailureCases() {
  mainWindow.setSize(960, 680); await delay(150);
  await click('.settings-button');
  const seed = JSON.parse(initialConfig);
  seed.providers['existing-provider'].baseUrl = `${origin}/v1`;
  const seedText = JSON.stringify(seed, null, 2) + '\n';
  await fs.writeFile(configFile, seedText);

  await configureForm(origin, sentinel, 'existing-provider');
  await click(controls.discover); await waitCatalog();
  await click(controls.checkbox(selectedIds[0]));
  await evaluate('document.querySelector(".model-import-actions").scrollIntoView({block:"center"})');
  await click(controls.save);
  await waitFor('different-key save failure', 'Boolean(document.querySelector(".model-import-error")) && document.querySelector(".model-import-preview")?.getAttribute("aria-busy")==="false"');
  const conflict = await failureFeedback('existing-key-conflict', seedText);
  assert.match(conflict.error, /密钥|服务名称/);
  assert.equal(conflict.fileUnchanged, true);
  assert.equal(conflict.selected, 1);
  check(`Existing-provider/new-key failure is caught, selections retained; error visible at the clicked position: ${conflict.errorVisible}`);

  await configureForm(origin, sentinel, 'expires-fixture');
  await click(controls.discover); await waitCatalog();
  await click(controls.checkbox(selectedIds[0]));
  assert.ok(lastPreviewToken);
  await evaluate('document.querySelector(".model-import-actions").scrollIntoView({block:"center"})');
  clockOffset = 6 * 60_000;
  try {
    await click(controls.save);
    await waitFor('genuinely expired preview error', 'Boolean(document.querySelector(".model-import-error")) && document.querySelector(".model-import-preview")?.getAttribute("aria-busy")==="false"');
  } finally { clockOffset = 0; }
  const expired = await failureFeedback('expired-preview', seedText);
  assert.match(expired.error, /失效|过期/);
  assert.equal(expired.fileUnchanged, true);
  assert.equal(expired.selected, 1);
  check(`A six-minute main-process clock advance triggers genuine preview expiration; error visible at clicked position: ${expired.errorVisible}`);

  await configureForm(origin, sentinel, 'slow-save-fixture');
  await click(controls.discover); await waitCatalog();
  await click(controls.checkbox(selectedIds[0]));
  const importCount = report.ipc.filter(item => item.channel === 'pi:importModels').length;
  saveDelay = 900;
  await evaluate('(()=>{const button=document.querySelector(".model-import-actions button");button.click();button.click();return true;})()');
  await waitFor('pending save is visibly locked', 'document.querySelector(".model-import-preview")?.getAttribute("aria-busy")==="true" && document.querySelector(".model-import-actions button")?.disabled');
  await waitFor('delayed save completed', 'Boolean(document.querySelector(".model-import-success"))');
  saveDelay = 0;
  assert.equal(report.ipc.filter(item => item.channel === 'pi:importModels').length - importCount, 1);
  const slowSaved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(slowSaved.providers['slow-save-fixture'].models.length, 1);
  (report.cases ||= []).push({ name: 'slow-double-click', nativeImportCalls: 1, savedModels: 1 });
  check('A 900 ms delayed real save visibly locks the button and two immediate clicks produce exactly one native write');

  await fs.writeFile(configFile, seedText);
  await configureForm(origin, sentinel, '我的服务商');
  await click(controls.discover);
  await waitFor('Chinese provider validation', 'Boolean(document.querySelector(".model-import-error")) && !document.querySelector(".model-import-fetch button").disabled');
  const chinese = await failureFeedback('chinese-provider', seedText);
  assert.equal(chinese.fileUnchanged, true);
  assert.match(chinese.error, /名称|字母/);
  check('A Chinese service label is rejected at discovery with a public validation error, before any configuration write');

  const bomText = '\uFEFF' + seedText;
  await fs.writeFile(configFile, bomText);
  await configureForm(origin, sentinel, 'bom-fixture');
  await click(controls.discover);
  await waitFor('BOM existing config result', 'Boolean(document.querySelector(".model-import-error") || document.querySelector(".model-import-preview")) && !document.querySelector(".model-import-fetch button").disabled');
  const bom = await failureFeedback('windows-bom', bomText);
  assert.equal(bom.fileUnchanged, true);
  check(`A valid Windows UTF-8 BOM config preview outcome: ${bom.error ? 'rejected by summary reader' : 'accepted'}`);

  const rotationSeed = JSON.parse(seedText);
  rotationSeed.providers['existing-provider'].models = catalog.map(({id,name}) => ({id,name,reasoning:false,input:['text'],contextWindow:32000,maxTokens:2048}));
  const rotationText = JSON.stringify(rotationSeed, null, 2) + '\n';
  await fs.writeFile(configFile, rotationText);
  await configureForm(origin, sentinel, 'existing-provider');
  await click(controls.discover); await waitCatalog();
  assert.equal(await evaluate('document.querySelectorAll(".model-import-model input:disabled").length'), catalog.length);
  assert.equal(await evaluate('document.querySelector(".model-import-actions button").disabled'), true);
  const preview = await discoverApi(origin, sentinel, 'existing-provider');
  const duplicate = await importApi(preview, catalog.map(model => model.id));
  assert.equal(duplicate.added, 0);
  assert.equal(duplicate.skipped, catalog.length);
  const afterRotation = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(afterRotation.providers['existing-provider'].apiKey, existingSentinel);
  const rotation = await failureFeedback('no-new-models-key-change', rotationText);
  rotation.added = duplicate.added; rotation.skipped = duplicate.skipped; rotation.keyRemainedUnchanged = true;
  check('When every model already exists, UI disables save and duplicate native import does not update a changed key');
  await assertPublicState('failure cases');
  await closeSettings();
}

async function exerciseImport() {
  const originalConnection = (await evaluate('window.pi.listConnections()'))[0].id;
  const keptDraft = 'MODEL_IMPORT_KEEP_DRAFT 重新加载模型不能清除未发送内容';
  await evaluate(`(()=>{const node=document.querySelector('textarea[aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(keptDraft)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor('initial unsent draft', `document.querySelector('textarea[aria-label="输入消息"]').value===${JSON.stringify(keptDraft)}`);
  await click('button[aria-label="添加图片或文本文件"]');
  await waitFor('initial unsent text attachment', `document.querySelector('.attachments')?.textContent.includes(${JSON.stringify(path.basename(attachmentFile))})`);
  await click('.settings-button');
  await waitFor('API import section', `Boolean(document.querySelector(${JSON.stringify(controls.section)}))`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.key)}).type`), 'password', 'API key is masked');
  await configureForm(`${origin}/v1/models`, wrongSentinel, 'unauthorized-fixture');
  await click(controls.discover);
  await waitFor('401 readable failure and unlocked form', `Boolean(document.querySelector(${JSON.stringify(controls.error)})) && !document.querySelector(${JSON.stringify(controls.discover)}).disabled`);
  const authError = await evaluate(`document.querySelector(${JSON.stringify(controls.error)}).innerText`);
  assert.match(authError, /401|认证|鉴权|密钥|拒绝|权限|API Key/i);
  assert.ok(report.requests.some(request => !request.authenticated), 'the real native request reached the unauthorized endpoint');
  await assertUnchanged('401 discovery');
  await assertPublicState('401 failure');
  check('An actual 401 is readable and recoverable; upstream key echoes are absent from native errors, UI and diagnostics; no file is changed');

  const variants = [
    { url: origin, baseUrl: `${origin}/v1`, endpoint: '/v1/models' },
    { url: `${origin}/v1/`, baseUrl: `${origin}/v1`, endpoint: '/v1/models' },
    { url: `${origin}/v1/models`, baseUrl: `${origin}/v1`, endpoint: '/v1/models' },
    { url: `${origin}/gateway/v1/models`, baseUrl: `${origin}/gateway/v1`, endpoint: '/gateway/v1/models' },
  ];
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    const preview = await discoverApi(variant.url, sentinel, `normalization-${index}`);
    assert.equal(preview.baseUrl, variant.baseUrl);
    assert.equal(preview.models.length, catalog.length, 'duplicate endpoint rows are deduplicated');
    assert.equal(new Set(preview.models.map(model => model.id)).size, catalog.length);
    assert.equal(report.requests.at(-1).path, variant.endpoint);
    assert.equal(report.requests.at(-1).authenticated, true);
    await evaluate(`window.pi.discardModelPreview(${JSON.stringify(preview.token)})`);
  }
  await assertUnchanged('normalization previews');
  check('Origin, /v1/, full /models endpoint and a prefixed gateway normalize correctly; authenticated discovery deduplicates models without writing configuration');

  responseMode = 'empty';
  await configureForm(origin, sentinel, provider);
  await click(controls.discover);
  await waitFor('empty catalog message and unlocked retry', `Boolean(document.querySelector('.model-import-empty') || document.querySelector(${JSON.stringify(controls.error)})) && !document.querySelector(${JSON.stringify(controls.discover)}).disabled`);
  assert.match(await evaluate('document.querySelector(".model-import").innerText'), /模型/);
  assert.equal(await evaluate('document.querySelectorAll(".model-import-model").length'), 0);
  await assertUnchanged('empty discovery');
  await assertPublicState('empty list');
  responseMode = 'models';
  await configureForm(`${origin}/v1/models`, sentinel, provider);
  await click(controls.discover); await waitCatalog();
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.save)}).disabled`), true, 'nothing is preselected');
  assert.equal(await evaluate('Boolean(document.querySelector(".model-import-error"))'), false);
  check('An empty endpoint list preserves files and can be retried successfully in the same settings form');

  await input(controls.search, selectedIds[0]);
  await waitFor('first search result', 'document.querySelectorAll(".model-import-model").length===1');
  await click(controls.checkbox(selectedIds[0]));
  await input(controls.search, selectedIds[1]);
  await waitFor('second search result', 'document.querySelectorAll(".model-import-model").length===1');
  await click('.model-import-selection input[type="checkbox"]');
  await input(controls.search, ''); await waitCatalog();
  for (const id of selectedIds) assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.checkbox(id))}).checked`), true, 'filtered select-all preserves other selected rows');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.checkbox(excludedId))}).checked`), false);
  await assertUnchanged('selection preview');
  await assertPublicState('selected preview');
  await evaluate('document.querySelector(".model-import-preview").scrollIntoView({block:"center"})');
  await screenshot('selected-light');
  check('Search plus filtered select-all preserves earlier selections; only two checked models are chosen, and previews contain no key');

  await click('.settings-actions .button.primary');
  await waitFor('import success', 'Boolean(document.querySelector(".model-import-success")) && !document.querySelector(".model-import-loading")');
  await waitNative('selected models saved', async () => {
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    return selectedIds.every(id => config.providers[provider]?.models.some(model => model.id === id));
  });
  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.deepEqual(saved.providers['existing-provider'], JSON.parse(initialConfig).providers['existing-provider'], 'another provider and all its model/header configuration survive');
  assert.equal(saved.providers[provider].baseUrl, `${origin}/v1`);
  assert.equal(saved.providers[provider].api, 'openai-completions');
  assert.equal(saved.providers[provider].apiKey, sentinel, 'the authorized key is written only to the private Pi model configuration');
  assert.deepEqual(saved.providers[provider].models.map(model => model.id).sort(), [...selectedIds].sort());
  assert.equal(saved.providers[provider].models.find(model => model.id === selectedIds[1]).reasoning, true, 'an explicit catalog reasoning capability is preserved');
  assert.notEqual(saved.providers[provider].models.find(model => model.id === selectedIds[0]).reasoning, true, 'a model name or absent flag cannot silently enable reasoning');
  assert.equal(saved.providers[provider].models.some(model => model.id === excludedId), false);
  assert.equal(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'), initialSettings, 'existing defaults are preserved');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.key)}).value`), '', 'success clears the key input');
  assert.equal(await evaluate('Boolean(document.querySelector(".model-import-preview"))'), false, 'completed discovery ticket is removed from the UI');
  await assertPublicState('saved models');
  await screenshot('saved-light');
  await feedbackVisible('.settings-feedback.success', 'footer import success');
  check('The Settings footer saves exactly two selected models with visible confirmation, clears the key, and preserves other provider/header/default settings');

  const beforeDuplicate = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const duplicatePreview = await discoverApi(origin);
  assert.equal(duplicatePreview.models.filter(model => model.exists).length, selectedIds.length);
  const duplicateResult = await importApi(duplicatePreview, selectedIds);
  assert.equal(duplicateResult.added, 0);
  assert.equal(duplicateResult.skipped, selectedIds.length);
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), beforeDuplicate);
  await configureForm(origin); await click(controls.discover); await waitCatalog();
  for (const id of selectedIds) assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.checkbox(id))}).disabled`), true, 'existing models cannot be selected again');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.checkbox(excludedId))}).disabled`), false);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.save)}).disabled`), true);
  check('Duplicate imports are skipped in native IPC and preserve all prior models; the UI disables existing rows while leaving new rows selectable');

  await waitFor('load current idle chat button', `Boolean([...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='加载到当前会话' && !node.disabled))`);
  await evaluate(`(()=>{[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='加载到当前会话').click();return true;})()`);
  await waitFor('current idle reload finished', `(async()=>{const connection=(await window.pi.listConnections()).find(item=>item.id===${JSON.stringify(originalConnection)});return connection?.status==='connected' && !connection.busy && Boolean([...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='加载到当前会话' && !node.disabled)) && Boolean(document.querySelector('.connection-pill.connected'));})()`, 60_000);
  await closeSettings();
  assert.equal(await evaluate('document.querySelector("textarea[aria-label=输入消息]").value'), keptDraft, 'reloading an empty chat preserves its unsent draft');
  assert.equal(await evaluate(`Boolean(document.querySelector('.attachments')?.textContent.includes(${JSON.stringify(path.basename(attachmentFile))}))`), true, 'reloading an empty chat preserves its unsent attachment');
  // Observe the original chat before creating a fresh chat: reload must keep
  // its stable ID and must not simply wait for a new process in another tab.
  await waitFor('original idle chat sees imported models', `(async()=>{const list=await window.pi.rpc({type:'get_available_models'},${JSON.stringify(originalConnection)});return ${JSON.stringify(selectedIds)}.every(id=>list.models.some(model=>model.provider===${JSON.stringify(provider)} && model.id===id));})()`, 45_000);
  await checkModelPicker(selectedIds, 'original idle chat');
  await click(`.model-picker-option[data-model-key="${provider}/${selectedIds[0]}"]`);
  await waitFor('original chat can choose imported model', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(originalConnection)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[0])};})()`);
  check('The original idle empty chat refreshes without losing its connection identity, unsent draft or text attachment and can choose an imported model');

  await click('.new-chat');
  await waitFor('new chat ready', 'document.querySelectorAll(".conversation-tab-wrap").length===2 && Boolean(document.querySelector(".connection-pill.connected")) && !document.querySelector(".new-chat").disabled', 60_000);
  const fresh = (await evaluate('window.pi.listConnections()')).find(item => item.id !== originalConnection);
  assert.ok(fresh);
  await checkModelPicker(selectedIds, 'new chat');
  await click(`.model-picker-option[data-model-key="${provider}/${selectedIds[1]}"]`);
  await waitFor('new chat imported model selected', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(fresh.id)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[1])};})()`);
  await evaluate(`(()=>{const node=document.querySelector('textarea[aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,'[model-import-qa] 使用已导入模型返回本地验收标记。');node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor('imported model prompt ready', 'document.querySelector("textarea[aria-label=输入消息]").value.includes("model-import-qa") && Boolean(document.querySelector(".send-button:not(:disabled)"))');
  await click('.send-button');
  await waitFor('imported model actual localhost completion', `document.querySelector('.messages')?.textContent.includes('MODEL_IMPORT_LOCAL_SUCCESS') && !(await window.pi.listConnections()).find(connection=>connection.id===${JSON.stringify(fresh.id)})?.busy`, 40_000);
  assert.ok(report.requests.some(request => request.method === 'POST' && request.authenticated && request.model === selectedIds[1]), 'Pi actually uses the saved provider key and selected imported model');
  await waitNative('workspace persisted after imported selection', async () => (await fs.readFile(path.join(desktop, 'workspace.json'), 'utf8').catch(() => '')).includes(selectedIds[1]));
  await assertPublicState('new chat imported model');
  check('A fresh real Pi chat lists imported models and obtains a localhost completion using the saved key; persisted workspace and model metadata remain credential-free');

  await click('.settings-button');
  await configureForm(`${origin}/v1/models`); await click(controls.discover); await waitCatalog();
  mainWindow.setSize(960, 680); await delay(200);
  await evaluate('(async()=>{await window.pi.savePreferences({theme:"dark"});const button=[...document.querySelectorAll(".theme-buttons button")].find(node=>node.textContent.includes("深色"));button.click();return true;})()');
  await waitFor('dark theme', 'document.documentElement.dataset.theme==="dark" || document.body.dataset.theme==="dark"');
  await evaluate('document.querySelector(".model-import-preview").scrollIntoView({block:"center"})');
  await screenshot('small-dark');
  const layout = await evaluate('(()=>{const panel=document.querySelector("[role=dialog]").getBoundingClientRect();const list=document.querySelector(".model-import-list").getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},panel:panel.toJSON(),list:list.toJSON(),documentWidth:document.documentElement.scrollWidth};})()');
  report.layout = layout;
  assert.ok(layout.panel.left >= -1 && layout.panel.right <= layout.viewport.width + 1 && layout.panel.top >= -1 && layout.panel.bottom <= layout.viewport.height + 1, 'settings dialog fits the small viewport');
  assert.ok(layout.list.left >= -1 && layout.list.right <= layout.viewport.width + 1 && layout.documentWidth <= layout.viewport.width + 1, 'model list has no horizontal overflow');
  await assertPublicState('small dark settings');
  await closeSettings();
  for (const item of await evaluate('window.pi.listConnections()')) {
    const state = await evaluate(`window.pi.rpc({type:'get_state'},${JSON.stringify(item.id)})`);
    assert.equal(state.messageCount, item.id === fresh.id ? 2 : 0, 'only the explicit synthetic prompt produced history');
    assertPublic(state, 'real Pi public model state');
  }
  assert.ok(report.requests.length >= 8);
  assert.ok(report.requests.every(request => request.method === 'GET' && ['/v1/models', '/gateway/v1/models'].includes(request.path) || request.method === 'POST' && request.path === '/v1/chat/completions'), 'only controlled localhost catalog/completion endpoints are used');
  assert.equal(report.rendererErrors.length, 0);
  check('The import form and list fit a 960×680 dark window; all catalog/completion traffic stays local with no console errors or persistent credential leaks');
}

async function exerciseSaveRegressions() {
  const parseConfig = async () => JSON.parse((await fs.readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  await click('.settings-button');
  const beforeFetch = await fs.readFile(configFile, 'utf8');
  await configureForm(origin, sentinel, 'footer-unpreviewed');
  await click('.settings-actions .button.primary');
  await waitCatalog();
  await feedbackVisible('.model-import-info', 'footer requests deliberate model selection');
  assert.equal(await evaluate('document.querySelectorAll(".model-import-model input:checked").length'), 0);
  assert.equal(await fs.readFile(configFile, 'utf8'), beforeFetch, 'an unpreviewed footer action cannot save arbitrary models');
  await click(controls.checkbox(selectedIds[0]));
  await click('.settings-actions .button.primary'); await savedFeedback('footer selected model saved');
  assert.equal((await parseConfig()).providers['footer-unpreviewed'].models.length, 1);
  check('An unpreviewed Settings footer fetches and visibly requests a deliberate selection; a subsequent footer click persists exactly that selected model');

  await configureForm(origin, sentinel, '我的服务商');
  const beforeChinese = await fs.readFile(configFile, 'utf8');
  await fs.writeFile(configFile, '\uFEFF' + beforeChinese);
  await click(controls.discover); await waitCatalog();
  assert.equal(lastPreview.provider, '我的服务商', 'Chinese provider IDs are accepted without rewriting the name');
  const bomBoot = await evaluate('window.pi.bootstrap({workspace:false})');
  assert.equal(bomBoot.modelConfig.error, undefined, 'UTF-8 BOM is valid config syntax');
  await click(controls.checkbox(selectedIds[1]));
  await click(controls.save); await savedFeedback('BOM config import saved', false);
  const afterBom = await parseConfig();
  assert.equal(afterBom.providers['我的服务商'].models[0].id, selectedIds[1]);
  for (const [id, definition] of Object.entries(JSON.parse(beforeChinese))) {
    if (id !== 'providers') assert.deepEqual(afterBom[id], definition);
  }
  for (const [id, definition] of Object.entries(JSON.parse(beforeChinese).providers)) assert.deepEqual(afterBom.providers[id], definition, 'BOM normalization must preserve all existing provider definitions');
  check('A Chinese provider ID discovers and saves correctly into a Windows UTF-8 BOM config while preserving every existing provider');

  await configureForm(origin, sentinel, 'expiry-recovery');
  await click(controls.discover); await waitCatalog();
  await click(controls.checkbox(selectedIds[0]));
  const previousToken = lastPreviewToken;
  const discoveryCount = report.ipc.filter(item => item.channel === 'pi:previewModels').length;
  clockOffset = 6 * 60_000;
  try {
    await click('.settings-actions .button.primary');
    await savedFeedback('expired preview automatically refetched and saved');
  } finally { clockOffset = 0; }
  assert.notEqual(lastPreviewToken, previousToken, 'the expired ticket is replaced rather than reused');
  assert.ok(report.ipc.filter(item => item.channel === 'pi:previewModels').length > discoveryCount);
  assert.deepEqual((await parseConfig()).providers['expiry-recovery'].models.map(model => model.id), [selectedIds[0]], 'automatic refresh preserves the explicit selection');
  check('A genuinely expired preview refetches once and automatically saves the original explicit selection through the footer');

  await configureForm(origin, sentinel, 'slow-save-regression');
  await click(controls.discover); await waitCatalog();
  await click(controls.checkbox(selectedIds[1]));
  const importsBefore = report.ipc.filter(item => item.channel === 'pi:importModels').length;
  saveDelay = 900;
  try {
    await evaluate('(()=>{const button=document.querySelector(".settings-actions .button.primary");button.click();button.click();return true;})()');
    await waitFor('slow footer save visibly busy', 'document.querySelector(".settings-actions .button.primary").disabled && /正在保存/.test(document.querySelector(".settings-actions .button.primary").innerText)');
    await savedFeedback('slow double-click footer save completed');
  } finally { saveDelay = 0; }
  assert.equal(report.ipc.filter(item => item.channel === 'pi:importModels').length - importsBefore, 1);
  assert.deepEqual((await parseConfig()).providers['slow-save-regression'].models.map(model => model.id), [selectedIds[1]]);
  check('Two footer clicks during a delayed real save show a busy control and produce exactly one import/write');

  responseMode = 'existing-only';
  const beforeRotation = await parseConfig();
  const oldModels = beforeRotation.providers[provider].models;
  await configureForm(origin, replacementSentinel, provider);
  await click(controls.discover); await expectedRows(selectedIds.length);
  assert.ok(lastPreview.conflicts.includes('apiKey'));
  assert.equal(await evaluate('document.querySelectorAll(".model-import-model input:checked").length'), 0);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.save)}).disabled`), true);
  const beforeUnconfirmed = await fs.readFile(configFile, 'utf8');
  await click('.settings-actions .button.primary');
  await feedbackVisible('.model-import-error', 'unconfirmed changed key error remains visible');
  await feedbackVisible('.settings-feedback.error', 'footer changed key error remains visible');
  assert.equal(await fs.readFile(configFile, 'utf8'), beforeUnconfirmed, 'a changed key is never applied without explicit consent');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.key)}).value`), replacementSentinel);
  await screenshot('key-update-needs-confirmation');
  await click('input[name="model-update-existing"]');
  await click('.settings-actions .button.primary'); await savedFeedback('zero-addition key update saved');
  const keyUpdated = await parseConfig();
  assert.equal(keyUpdated.providers[provider].apiKey, replacementSentinel);
  assert.deepEqual(keyUpdated.providers[provider].models, oldModels, 'key-only updates preserve model definitions and capabilities');
  assert.ok(report.ipc.some(item => item.channel === 'pi:importModels' && item.ok && item.updateExisting && item.modelCount === 0));
  check('With zero new models, a changed key first shows a visible non-destructive error, then explicit consent updates the key while preserving all model definitions');

  await configureForm(`${origin}/gateway/v1/models`, replacementSentinel, provider);
  await click(controls.discover); await expectedRows(selectedIds.length);
  assert.ok(lastPreview.conflicts.includes('baseUrl'));
  await click('input[name="model-update-existing"]');
  await click('.settings-actions .button.primary'); await savedFeedback('zero-addition address update saved');
  const addressUpdated = await parseConfig();
  assert.equal(addressUpdated.providers[provider].baseUrl, `${origin}/gateway/v1`);
  assert.equal(addressUpdated.providers[provider].apiKey, replacementSentinel);
  assert.deepEqual(addressUpdated.providers[provider].models, oldModels);
  check('An explicitly confirmed API address update also works without new models and preserves the key and existing model capabilities');

  const protocolSeed = await parseConfig();
  protocolSeed.providers['incompatible-fixture'] = {
    api: 'anthropic-messages', baseUrl: `${origin}/v1`, apiKey: sentinel,
    models: [{ id: 'preserved-incompatible', name: '保留另一协议', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048 }],
  };
  const protocolBefore = JSON.stringify(protocolSeed, null, 2) + '\n';
  await fs.writeFile(configFile, protocolBefore);
  responseMode = 'models';
  await configureForm(origin, sentinel, 'incompatible-fixture');
  await click(controls.discover); await waitCatalog();
  assert.ok(lastPreview.conflicts.includes('api'));
  assert.ok(lastPreview.suggestedProvider && lastPreview.suggestedProvider !== 'incompatible-fixture');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(controls.save)}).disabled`), true);
  assert.equal(await evaluate('Boolean(document.querySelector("input[name=model-update-existing]"))'), false, 'an incompatible API protocol cannot be confirmed for overwrite');
  const rejected = await evaluate(`(async()=>{try{await window.pi.importModels(${JSON.stringify({token:lastPreviewToken,provider:'incompatible-fixture',modelIds:[excludedId],updateExisting:true})});return '';}catch(error){return error.message;}})()`);
  assert.match(rejected, /协议|API/); assertPublic(rejected, 'protocol conflict error');
  assert.equal(await fs.readFile(configFile, 'utf8'), protocolBefore);
  await click('.model-import-new-provider');
  await waitFor('suggested provider gets its own preview', 'document.querySelector("input[name=model-api-provider]").value!=="incompatible-fixture" && document.querySelector(".model-import-summary strong")?.textContent===document.querySelector("input[name=model-api-provider]").value && document.querySelectorAll(".model-import-model input:not(:disabled)").length===3');
  const suggested = await evaluate('document.querySelector("input[name=model-api-provider]").value');
  await click(controls.checkbox(excludedId));
  await click(controls.save); await savedFeedback('incompatible protocol saved under suggested ID', false);
  const afterProtocol = await parseConfig();
  assert.deepEqual(afterProtocol.providers['incompatible-fixture'], protocolSeed.providers['incompatible-fixture']);
  assert.equal(afterProtocol.providers[suggested].models[0].id, excludedId);
  check('Another API protocol cannot be overwritten even through native IPC; its suggested new provider ID saves separately and preserves the original service');

  await closeSettings();
  const previousIds = (await evaluate('window.pi.listConnections()')).map(item => item.id);
  await click('.new-chat');
  await waitFor('rotation verification chat ready', `document.querySelectorAll('.conversation-tab-wrap').length===${previousIds.length+1} && Boolean(document.querySelector('.connection-pill.connected')) && !document.querySelector('.new-chat').disabled`, 60_000);
  const fresh = (await evaluate('window.pi.listConnections()')).find(item => !previousIds.includes(item.id));
  await click('.model-picker-trigger');
  await click(`.model-picker-option[data-model-key="${provider}/${selectedIds[0]}"]`);
  await waitFor('rotated model selected', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(fresh.id)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[0])};})()`);
  await evaluate(`(()=>{const node=document.querySelector('textarea[aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,'[model-import-qa] 验证显式更新后的Key和gateway地址。');node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await click('.send-button');
  await waitFor('rotated provider actual completion', `document.querySelector('.messages')?.textContent.includes('MODEL_IMPORT_LOCAL_SUCCESS') && !(await window.pi.listConnections()).find(item=>item.id===${JSON.stringify(fresh.id)})?.busy`, 40_000);
  assert.ok(report.requests.some(item => item.method === 'POST' && item.path === '/gateway/v1/chat/completions' && item.keyVariant === 'replacement' && item.model === selectedIds[0]));
  await assertPublicState('all save regressions');
  await screenshot('save-regressions-final');
  check('A new real Pi chat successfully uses the explicitly updated gateway address and replacement key; public responses, errors, previews and workspace remain key-free');
}

async function exerciseReasoningConfiguration() {
  const parseConfig = async () => JSON.parse((await fs.readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  const modelKey = `${provider}/${selectedIds[0]}`;
  const modelSelector = `.model-picker-option[data-model-key="${modelKey}"]`;
  const enabled = '[data-testid="model-reasoning-enabled"]';
  const effort = '[data-testid="model-reasoning-effort"]';
  const before = await parseConfig();
  const connectionIds = (await evaluate('window.pi.listConnections()')).map(item => item.id);
  await click('.new-chat');
  await waitFor('reasoning test chat ready', `document.querySelectorAll('.conversation-tab-wrap').length===${connectionIds.length+1} && Boolean(document.querySelector('.connection-pill.connected')) && !document.querySelector('.new-chat').disabled`, 60_000);
  let current = (await evaluate('window.pi.listConnections()')).find(item => !connectionIds.includes(item.id));
  assert.ok(current, 'a new controlled chat owns the reasoning tests');
  await click('.model-picker-trigger'); await click(modelSelector);
  await waitFor('unannotated imported model selected', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(current.id)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[0])} && state.model?.reasoning===false;})()`);
  const originalLevels = await evaluate(`window.pi.rpc({type:'get_available_thinking_levels'},${JSON.stringify(current.id)})`);
  assert.deepEqual(originalLevels.levels, ['off'], 'an unannotated model must not fabricate reasoning support');
  const importedModels = await evaluate(`window.pi.rpc({type:'get_available_models'},${JSON.stringify(current.id)})`);
  assert.equal(importedModels.models.find(model => model.provider === provider && model.id === selectedIds[1]).reasoning, true, 'an explicit catalog flag reaches the actual SDK');

  const setCheckbox = async (selector, checked) => {
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`) !== checked) await click(selector);
  };
  const openEditor = async () => {
    await click('.thinking-picker-trigger');
    await click('.thinking-configure-button');
    await waitFor('reasoning capability dialog', 'Boolean(document.querySelector(".model-reasoning-dialog"))');
  };
  const saveEditor = async label => {
    await click('.model-reasoning-dialog .modal-actions .button.primary');
    await waitFor(label, `!document.querySelector('.model-reasoning-dialog') && Boolean(document.querySelector('.connection-pill.connected')) && !(await window.pi.listConnections()).find(item=>item.id===${JSON.stringify(current.id)})?.busy`, 60_000);
  };
  const sendControlledPrompt = async label => {
    const posts = report.requests.filter(item => item.method === 'POST').length;
    await evaluate(`(()=>{const node=document.querySelector('textarea[aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(`[model-import-qa] ${label}`)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await click('.send-button');
    await waitNative(label, async () => report.requests.filter(item => item.method === 'POST' && item.completed).length > posts, 40_000);
    await waitFor(`${label} idle`, `!(await window.pi.listConnections()).find(item=>item.id===${JSON.stringify(current.id)})?.busy`);
    return report.requests.filter(item => item.method === 'POST').at(-1);
  };

  await openEditor();
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(enabled)}).checked`), false);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(effort)}).disabled`), true);
  await setCheckbox(enabled, true); await setCheckbox(effort, true);
  assert.equal(await evaluate('Boolean(document.querySelector(".model-reasoning-dialog input[type=password]"))'), false, 'capability edits never ask for the existing API key again');
  const dialogLayout = await evaluate('(()=>{const dialog=document.querySelector(".model-reasoning-dialog").getBoundingClientRect();const footer=document.querySelector(".model-reasoning-dialog footer").getBoundingClientRect();return {dialog:dialog.toJSON(),footer:footer.toJSON(),width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth};})()');
  assert.ok(dialogLayout.dialog.left >= 0 && dialogLayout.dialog.right <= dialogLayout.width && dialogLayout.dialog.top >= 0 && dialogLayout.dialog.bottom <= dialogLayout.height, 'the capability dialog fits the small dark window');
  assert.ok(dialogLayout.footer.top >= 0 && dialogLayout.footer.bottom <= dialogLayout.height && dialogLayout.documentWidth <= dialogLayout.width, 'capability save controls stay visible without horizontal overflow');
  report.reasoningDialogLayout = dialogLayout;
  await screenshot('reasoning-enable-dark');
  await saveEditor('reasoning capability saved and original idle chat reloaded');
  const afterEnable = await parseConfig();
  const enabledModel = afterEnable.providers[provider].models.find(model => model.id === selectedIds[0]);
  assert.equal(enabledModel.reasoning, true);
  assert.equal(enabledModel.compat.supportsReasoningEffort, true);
  assert.equal(afterEnable.providers[provider].apiKey, replacementSentinel, 'reasoning edits preserve the saved replacement key');
  assert.equal(afterEnable.providers[provider].baseUrl, `${origin}/gateway/v1`, 'reasoning edits preserve the saved endpoint');
  assert.deepEqual(afterEnable.providers[provider].models.find(model => model.id === selectedIds[1]), before.providers[provider].models.find(model => model.id === selectedIds[1]), 'other models keep their metadata');
  for (const [id, definition] of Object.entries(before.providers)) if (id !== provider) assert.deepEqual(afterEnable.providers[id], definition, 'reasoning edits preserve other services');
  await waitFor('actual Pi exposes high reasoning', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(current.id)});const levels=await window.pi.rpc({type:'get_available_thinking_levels'},${JSON.stringify(current.id)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[0])} && state.model?.reasoning===true && levels.levels.includes('high');})()`);
  await click('.thinking-picker-trigger'); await click('.thinking-picker-option[data-level="high"]');
  await waitFor('High selected in real Pi', `(await window.pi.rpc({type:'get_state'},${JSON.stringify(current.id)})).thinkingLevel==='high'`);
  const highRequest = await sendControlledPrompt('验证手动启用的 High 思考强度');
  assert.equal(highRequest.reasoningEffort, 'high', 'the gateway receives the selected High effort, not only a changed UI label');
  assert.equal(highRequest.keyVariant, 'replacement');
  assert.equal(highRequest.path, '/gateway/v1/chat/completions');
  await screenshot('reasoning-high-dark');
  check('Explicit catalog reasoning flags reach Pi; an unannotated model starts at Off, then its capability editor persists and reloads the same chat so High is sent as reasoning_effort on the actual gateway request');

  const oldIds = (await evaluate('window.pi.listConnections()')).map(item => item.id);
  await click('.new-chat');
  await waitFor('fresh process for saved capability ready', `document.querySelectorAll('.conversation-tab-wrap').length===${oldIds.length+1} && Boolean(document.querySelector('.connection-pill.connected')) && !document.querySelector('.new-chat').disabled`, 60_000);
  current = (await evaluate('window.pi.listConnections()')).find(item => !oldIds.includes(item.id));
  assert.ok(current);
  await waitFor('saved model capability survives a fresh Pi process', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(current.id)});const levels=await window.pi.rpc({type:'get_available_thinking_levels'},${JSON.stringify(current.id)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[0])} && state.model?.reasoning===true && state.thinkingLevel==='high' && levels.levels.includes('high');})()`);
  await click('.settings-button');
  await click(`.configured-model[data-provider="${provider}"][data-model-id="${selectedIds[0]}"] button`);
  await waitFor('settings capability editor owns focus', 'document.querySelector(".model-reasoning-dialog")?.contains(document.activeElement)');
  await delay(60);
  assert.equal(await evaluate('document.querySelector(".model-reasoning-dialog").contains(document.activeElement)'), true, 'the parent settings dialog cannot steal child focus');
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor('Escape closes only the capability editor', '!document.querySelector(".model-reasoning-dialog") && Boolean(document.querySelector(".settings-body"))');
  await closeSettings();
  check('A genuinely new Pi process restores the saved model reasoning capability and selected High effort without another import or key entry');

  await openEditor();
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(enabled)}).checked`), true);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(effort)}).checked`), true);
  await setCheckbox(effort, false);
  await saveEditor('server-controlled capability saved');
  await waitFor('server-controlled toolbar label', 'document.querySelector(".thinking-picker-trigger")?.textContent.includes("服务端控制")');
  const serverModel = (await parseConfig()).providers[provider].models.find(model => model.id === selectedIds[0]);
  assert.equal(serverModel.reasoning, true);
  assert.equal(serverModel.compat.supportsReasoningEffort, false);
  const serverRequest = await sendControlledPrompt('验证由服务端控制思考时不发送强度参数');
  assert.equal(Object.hasOwn(serverRequest, 'reasoningEffort'), false, 'a service without effort support receives no reasoning_effort field');
  await click('.thinking-picker-trigger');
  assert.equal(await evaluate('document.querySelectorAll(".thinking-picker-option").length'), 0, 'server-controlled models cannot select a no-op local effort');
  await waitFor('server-controlled picker list focused', 'document.activeElement?.classList.contains("thinking-picker-list")');
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor('keyboard reaches configure capability button', 'document.activeElement?.classList.contains("thinking-configure-button")');
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  // Chromium button activation is a keypress default action. Electron's
  // low-level API does not synthesize that char event from keyDown alone.
  mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor('keyboard opens reasoning capability dialog', 'Boolean(document.querySelector(".model-reasoning-dialog"))');
  await setCheckbox(enabled, false);
  await saveEditor('reasoning disabled and same chat reloaded');
  await waitFor('disabled reasoning reaches actual Pi', `(async()=>{const state=await window.pi.rpc({type:'get_state'},${JSON.stringify(current.id)});const levels=await window.pi.rpc({type:'get_available_thinking_levels'},${JSON.stringify(current.id)});return state.model?.provider===${JSON.stringify(provider)} && state.model?.id===${JSON.stringify(selectedIds[0])} && state.model?.reasoning===false && state.thinkingLevel==='off' && JSON.stringify(levels.levels)==='["off"]';})()`);
  assert.equal((await parseConfig()).providers[provider].models.find(model => model.id === selectedIds[0]).reasoning, false);
  await screenshot('reasoning-disabled-dark');
  await assertPublicState('reasoning capability configuration');
  check('Turning off effort support preserves reasoning but shows server control and omits the wire parameter; disabling reasoning later clamps the real SDK to Off, with other models/services and saved credentials preserved');
}

async function finish(error) {
  if (finishing) return; finishing = true; clearTimeout(deadline);
  if (error) { report.errors.push(redact(error.stack || String(error))); console.error(redact(error.stack || String(error))); try { await screenshot('failure'); } catch {} }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { await evaluate('(async()=>{for(const connection of await window.pi.listConnections()){try{await window.pi.disconnect(connection.id);}catch{}}return true;})()'); }
    catch (cleanupError) { report.errors.push(redact(`QA cleanup: ${cleanupError.message}`)); }
  }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  report.success = !report.errors.length && !report.rendererErrors.length;
  report.finished = new Date().toISOString();
  await fs.mkdir(qaRoot, { recursive: true });
  const serialized = redact(JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(runRoot, 'report.json'), serialized);
  await fs.writeFile(path.join(qaRoot, 'report.json'), serialized);
  console.log(JSON.stringify({ success: report.success, checks: report.checks, errors: report.errors, report: path.join(qaRoot, 'report.json') }, null, 2));
  app.exit(report.success ? 0 : 1);
}

async function start() {
  await Promise.all([project, agent, desktop, path.join(agent, 'extensions'), runtimeRoot].map(directory => fs.mkdir(directory, { recursive: true })));
  const sharedRuntime = path.join(root, 'build', 'runtime', 'win32-x64');
  for (const directory of ['node', 'git', 'pi', 'bin', 'licenses']) {
    const source = path.join(sharedRuntime, directory);
    assert.equal((await fs.stat(source)).isDirectory(), true, `Run npm run prepare:runtime first: bundled ${directory} is required`);
    await fs.symlink(source, path.join(runtimeRoot, directory), 'junction');
  }
  report.runtimeAdapterHashes = [];
  for (const file of ['pi-launcher.mjs', 'desktop-command-guard.mjs', 'desktop-session-controls.mjs']) {
    const source = await fs.readFile(path.join(root, 'electron', file));
    await fs.writeFile(path.join(runtimeRoot, file), source);
    report.runtimeAdapterHashes.push({ file, sha256: crypto.createHash('sha256').update(source).digest('hex') });
  }
  await fs.copyFile(path.join(sharedRuntime, 'manifest.json'), path.join(runtimeRoot, 'manifest.json'));
  await fs.copyFile(path.join(root, 'build', 'icon.png'), path.join(appRoot, 'build', 'icon.png'));
  await fs.copyFile(path.join(root, 'package.json'), path.join(appRoot, 'package.json'));

  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const keyVariant = request.headers.authorization === `Bearer ${sentinel}` ? 'primary' : request.headers.authorization === `Bearer ${replacementSentinel}` ? 'replacement' : 'invalid';
    const authenticated = keyVariant !== 'invalid';
    const requestEntry = { method: request.method, path: pathname, authenticated, keyVariant, mode: responseMode };
    report.requests.push(requestEntry);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && ['/v1/chat/completions', '/gateway/v1/chat/completions'].includes(pathname)) {
      if (!authenticated) { response.writeHead(401).end(JSON.stringify({ error: 'Imported model did not use its saved local key' })); return; }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requestEntry.model = body.model;
      if (Object.hasOwn(body, 'reasoning_effort')) requestEntry.reasoningEffort = body.reasoning_effort;
      assert.ok(selectedIds.includes(body.model), 'only the imported fixture model may be prompted');
      assert.ok(JSON.stringify(body.messages.at(-1).content).includes('model-import-qa'), 'only the controlled synthetic prompt is accepted');
      response.setHeader('content-type', 'text/event-stream');
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'model-import-qa', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant' });
      emit({ content: 'MODEL_IMPORT_LOCAL_SUCCESS：已用导入的配置完成本地请求。' });
      await delay(40); emit({}, 'stop'); response.end('data: [DONE]\n\n'); requestEntry.completed = true; return;
    }
    if (request.method !== 'GET' || !['/v1/models', '/gateway/v1/models'].includes(pathname)) { response.writeHead(404).end(JSON.stringify({ error: 'Unexpected local-only QA endpoint' })); return; }
    if (!authenticated) { response.writeHead(401).end(JSON.stringify({ error: { message: `Invalid API key ${wrongSentinel}` } })); return; }
    if (responseMode === 'empty') { response.end(JSON.stringify({ object: 'list', data: [] })); return; }
    const list = responseMode === 'existing-only' ? catalog.filter(model => selectedIds.includes(model.id)) : catalog;
    response.end(JSON.stringify({ object: 'list', data: [
      ...list, list[0],
      { id: keyVariant === 'replacement' ? replacementSentinel : sentinel, name: 'Credential echo fixture must not be returned as a model' },
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  initialConfig = JSON.stringify({ providers: { 'existing-provider': {
    baseUrl: `${origin}/existing/v1`, api: 'openai-completions', apiKey: existingSentinel,
    headers: { 'X-Existing-Fixture': 'keep-this-header' },
    models: [{ id: 'preserved-existing', name: '保留原有模型', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048 }],
  } } }, null, 2) + '\n';
  initialSettings = JSON.stringify({ defaultProvider: 'existing-provider', defaultModel: 'preserved-existing', defaultThinkingLevel: 'off' }, null, 2) + '\n';
  await fs.writeFile(configFile, initialConfig);
  await fs.writeFile(attachmentFile, 'MODEL_IMPORT_ATTACHMENT_PRESERVED：刷新模型之前选择，刷新后不能丢失。\n');
  await fs.writeFile(path.join(agent, 'settings.json'), initialSettings);
  await fs.writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: project, name: path.basename(project), lastOpened: new Date().toISOString() }], lastProject: project }));
  report.packageVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  report.electronVersion = process.versions.electron;
  report.compiledMainSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'dist-electron', 'main.cjs'))).digest('hex');
  const html = await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8');
  report.compiledAssets = [];
  for (const match of html.matchAll(/(?:src|href)="\.\/assets\/([^\"]+\.(?:js|css))"/g)) report.compiledAssets.push({ file: match[1], sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'dist', 'assets', match[1]))).digest('hex') });
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
    if (!/previewModels|importModels|discardModelPreview|configureModelReasoning/i.test(channel) && !(failureMode && channel === 'pi:savePreferences')) return listener(event, ...args);
    const entry = { channel, at: Date.now() }; report.ipc.push(entry);
    try {
      if (channel === 'pi:importModels') { entry.updateExisting = Boolean(args[0]?.updateExisting); entry.modelCount = args[0]?.modelIds?.length; }
      if (channel === 'pi:importModels' && saveDelay) await delay(saveDelay);
      const value = await listener(event, ...args);
      if (channel === 'pi:previewModels') { lastPreviewToken = value?.token; lastPreview = value; }
      assertPublic(value, `${channel} native return`); entry.ok = true; return value;
    }
    catch (error) { assertPublic(error.message || String(error), `${channel} native error`); entry.ok = false; entry.error = error.message || String(error); throw error; }
  });
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1);
    return options?.properties?.includes('openDirectory') ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [attachmentFile] };
  };
  app.on('browser-window-created', (_event, window) => {
    if (mainWindow) return; mainWindow = window;
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') report.rendererErrors.push(redact(details.message)); });
    window.webContents.once('did-finish-load', () => { void run().catch(finish); });
  });
  require(path.join(root, 'dist-electron', 'main.cjs'));
}
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));
void start().catch(finish);
