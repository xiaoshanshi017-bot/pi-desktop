// Read-only acceptance check of the user's shared model configuration.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
process.env.PI_DESKTOP_USER_DATA = path.join(root, 'output', 'migration-desktop');
delete process.env.PI_DESKTOP_DEV_URL;
const report = { checks: [], errors: [], success: false };
let window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => finish(new Error('Model visibility check timed out')), 45_000);
let finished = false;
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  if (error) report.errors.push(error.message || String(error));
  report.success = !report.errors.length;
  await fs.mkdir(path.join(root, 'output', 'qa'), { recursive: true });
  await fs.writeFile(path.join(root, 'output', 'qa', 'model-config-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.success ? 0 : 1);
}
async function evaluate(source) { return window.webContents.executeJavaScript(source, true); }
async function run() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(`Boolean(window.pi) && Boolean(document.querySelector('#model-select'))`)) break;
    await delay(150);
  }
  const bootstrap = await evaluate('window.pi.bootstrap()');
  assert.equal(bootstrap.preferences.projects.length, 0);
  assert.ok(bootstrap.modelConfig.models.length > 0, 'This optional check requires configured local models');
  const configuredDefault = bootstrap.modelConfig.models.find(model => model.provider === bootstrap.modelConfig.defaultProvider && model.id === bootstrap.modelConfig.defaultModel);
  if (configuredDefault) assert.equal(await evaluate(`document.querySelector('#model-select').textContent.includes(${JSON.stringify(configuredDefault.name)})`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector('.connection-pill.connected'))`), false);
  report.checks.push('Configured local models are visible in bootstrap without opening a project');
  report.checks.push('Configured default model is displayed before connecting to Pi');
  await evaluate(`document.querySelector('.settings-button').click()`);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`)) break;
    await delay(100);
  }
  const visible = await evaluate(`document.querySelector('[role="dialog"]').innerText`);
  for (const model of bootstrap.modelConfig.models) assert.ok(visible.includes(model.name), `Missing configured model ${model.name}`);
  assert.ok(visible.includes(bootstrap.modelConfig.source));
  report.checks.push('Settings lists every configured model and its shared source path');
  await fs.mkdir(path.join(root, 'output', 'playwright'), { recursive: true });
  await evaluate(`document.querySelector('.configured-model-list')?.scrollIntoView({block:'center'})`);
  await evaluate('document.body.getBoundingClientRect().toJSON()');
  await delay(150);
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(root, 'output', 'playwright', 'configured-models.png'), image.toPNG());
  await finish();
}
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created;
  created.webContents.setBackgroundThrottling(false);
  created.webContents.once('did-finish-load', () => void run().catch(finish));
});
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));
require(path.join(root, 'dist-electron', 'main.cjs'));
