// Real Electron/preload/IPC acceptance with read-only access to local Pi history.
// Imported project references are saved only in an isolated desktop profile.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
process.env.PI_DESKTOP_USER_DATA = path.join(root, 'output', `project-migration-desktop-${process.pid}`);
delete process.env.PI_DESKTOP_DEV_URL;
const report = { checks: [], errors: [], success: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
let finished = false;
const timer = setTimeout(() => void finish(new Error('Project migration acceptance timed out')), 120_000);
const evaluate = source => window.webContents.executeJavaScript(source, true);
async function waitFor(source) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await evaluate(source)) return;
    await delay(100);
  }
  throw new Error(`UI did not reach expected state: ${source}`);
}
async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) report.errors.push(error.stack || String(error));
  report.success = !report.errors.length;
  await fs.mkdir(path.join(root, 'output', 'qa'), { recursive: true });
  await fs.writeFile(path.join(root, 'output', 'qa', 'project-migration-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.success ? 0 : 1);
}
async function run() {
  await waitFor(`Boolean(window.pi?.previewProjectMigration) && Boolean(document.querySelector('.project-migration-button'))`);
  const boot = await evaluate('window.pi.bootstrap()');
  assert.equal(boot.preferences.projects.length, 0);
  const preview = await evaluate('window.pi.previewProjectMigration()');
  const available = preview.projects.filter(project => project.available);
  assert.ok(available.length > 3, 'Read existing local projects for migration acceptance');
  report.projects = available.length;
  report.discoveredSessions = preview.sessionCount;
  report.warnings = preview.warnings;
  report.checks.push('Existing Pi projects discovered through the real sandboxed bridge');

  await evaluate(`document.querySelector('.project-migration-button').click()`);
  await waitFor(`Boolean(document.querySelector('.project-migration-preview')) && Boolean(document.querySelector('.project-import-button:not(:disabled)'))`);
  await evaluate(`document.querySelector('.project-import-button').click()`);
  await waitFor(`document.body.innerText.includes('导入') && !document.querySelector('.project-import-button:disabled')`);
  // Wait for durable preferences; the dialog may keep its completion status open.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await evaluate('window.pi.bootstrap()')).preferences.projects.length === available.length) break;
    await delay(100);
  }
  const imported = await evaluate('window.pi.bootstrap()');
  assert.equal(imported.preferences.projects.length, available.length);
  assert.equal(imported.preferences.lastProject, undefined);
  assert.deepEqual(imported.preferences.lastSessions, {});
  report.checks.push('Import saves every project without opening or taking over a conversation');

  // Close any import dialog, then open the complete library.
  await evaluate(`document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click()`);
  await evaluate(`document.querySelector('.project-library-button').click()`);
  await waitFor(`document.querySelectorAll('.project-library .project-entry').length === ${available.length}`);
  report.checks.push('All imported projects are accessible in the project library');
  const target = available.find(project => /[^\x00-\x7f]/.test(project.path)) || available[available.length - 1];
  await evaluate(`(() => { const input = document.querySelector('.project-library-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(target.path)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await waitFor(`document.querySelectorAll('.project-library .project-entry').length === 1`);
  assert.equal(await evaluate(`document.querySelector('.project-library .project-entry').dataset.path`), target.path);
  report.checks.push('Full-path search finds Chinese project directories');
  await evaluate(`(() => { const input = document.querySelector('.project-library-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await waitFor(`document.querySelectorAll('.project-library .project-entry').length === ${available.length}`);
  await fs.mkdir(path.join(root, 'output', 'playwright'), { recursive: true });
  await evaluate('document.body.getBoundingClientRect().toJSON()');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const image = await window.webContents.capturePage();
      await fs.writeFile(path.join(root, 'output', 'playwright', 'imported-projects.png'), image.toPNG());
      break;
    } catch (error) { if (attempt === 2) throw error; await delay(300); }
  }
  let visibleSessions = 0;
  for (const project of available) {
    const sessions = await evaluate(`window.pi.listSessions(${JSON.stringify(project.path)})`);
    assert.ok(sessions.length >= project.sessionCount, `Missing history for ${project.name}`);
    assert.ok(sessions.every(session => path.resolve(session.cwd).toLowerCase() === path.resolve(project.path).toLowerCase()));
    visibleSessions += sessions.length;
  }
  report.visibleSessions = visibleSessions;
  report.checks.push('Each imported project exposes its original persisted history');
  const repeated = await evaluate(`window.pi.importProjects(${JSON.stringify(available.map(project => project.path))})`);
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.alreadyPresent, available.length);
  assert.equal(repeated.preferences.projects.length, available.length);
  assert.equal(await evaluate(`Boolean(document.querySelector('.connection-pill.connected'))`), false);
  report.checks.push('Repeated import is idempotent and never starts a Pi task');
  await finish();
}
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created;
  created.webContents.setBackgroundThrottling(false);
  created.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') report.errors.push(details.message);
  });
  created.webContents.once('did-finish-load', () => void run().catch(finish));
});
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));
require(path.join(root, 'dist-electron', 'main.cjs'));
