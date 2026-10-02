// Development-only acceptance of the real renderer, sandboxed preload, IPC and Pi.
// All configuration lives in output/selector-qa-<pid>; no prompts are sent.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, 'output', `selector-qa-${process.pid}`);
const project = path.join(qaRoot, '中文 选择器项目');
const agent = path.join(qaRoot, 'agent');
const desktop = path.join(qaRoot, 'desktop');
const screenshotRoot = path.join(root, 'output', 'playwright');
const reportFile = path.join(root, 'output', 'qa', 'selector-report.json');
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
delete process.env.PI_DESKTOP_DEV_URL;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

const providerA = 'selector-alpha';
const providerB = 'selector-beta';
const initialKey = `${providerA}/alpha-shared`;
const betaKey = `${providerB}/beta-shared`;
const longKey = `${providerA}/alpha-long`;
const longName = '适合大型复杂工程推理、跨文件重构与超长上下文分析的模型 Long Context Reasoner Extended Edition';
const modelFixture = (id, name, reasoning = true) => ({ id, name, reasoning, input: ['text'], contextWindow: 64000, maxTokens: 2048 });
const report = { started: new Date().toISOString(), profile: qaRoot, checks: [], screenshots: [], errors: [], rendererErrors: [], success: false };
let mainWindow;
let finishing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => void finish(new Error('Selector acceptance exceeded 120 seconds')), 120_000);

async function evaluate(source, timeout = 8000) {
  assert.ok(mainWindow && !mainWindow.isDestroyed(), 'Application window must be alive');
  let timer;
  try {
    const result = await Promise.race([
      mainWindow.webContents.executeJavaScript(`(async () => { try { return { ok: true, value: await (${source}) }; } catch (error) { return { ok: false, message: error?.message || String(error), stack: error?.stack }; } })()`, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer evaluation timed out')), timeout); }),
    ]);
    if (!result.ok) throw new Error(`${result.message}\nRenderer source: ${source}\n${result.stack || ''}`);
    return result.value;
  } catch (error) {
    if (!String(error.message).includes('Renderer source:')) error.message += `\nRenderer source: ${source}`;
    throw error;
  } finally { clearTimeout(timer); }
}

async function waitFor(label, source, timeout = 15_000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { const result = await evaluate(source); if (result) return result; } catch (error) { lastError = error; }
    await delay(100);
  }
  let notice = '';
  try { notice = await evaluate(`document.querySelector('.notice')?.innerText || document.querySelector('.connection-pill')?.innerText || ''`); } catch {}
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}${notice ? `; UI: ${notice}` : ''}`);
}

async function click(selector) {
  await waitFor(`enabled control ${selector}`, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element && !element.disabled; })()`);
  await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error('Unavailable control: ' + ${JSON.stringify(selector)}); element.click(); })()`);
}
const modelOption = key => `.model-picker-option[data-model-key="${key}"]`;
const thinkingOption = level => `.thinking-picker-option[data-level="${level}"]`;

async function press(key) {
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
}

async function searchModels(value) {
  await evaluate(`(() => { const input = document.querySelector('.model-picker-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await delay(80);
}

async function openModels() {
  await waitFor('model control ready', `Boolean(document.querySelector('.model-picker-trigger:not(:disabled)'))`);
  if (!(await evaluate(`Boolean(document.querySelector('.model-picker-panel'))`))) await click('.model-picker-trigger');
  await waitFor('model picker with focused search', `Boolean(document.querySelector('.model-picker-panel')) && document.activeElement === document.querySelector('.model-picker-search')`);
}

async function openThinking() {
  await waitFor('thinking control ready', `Boolean(document.querySelector('.thinking-picker-trigger:not(:disabled)'))`);
  if (!(await evaluate(`Boolean(document.querySelector('.thinking-picker-panel'))`))) await click('.thinking-picker-trigger');
  await waitFor('thinking picker', `Boolean(document.querySelector('.thinking-picker-panel')) && document.activeElement === document.querySelector('.thinking-picker-list')`);
}

async function waitModel(key) {
  await waitFor(`real Pi model ${key}`, `(async () => { const state = await window.pi.rpc({ type: 'get_state' }); return state.model && state.model.provider + '/' + state.model.id === ${JSON.stringify(key)} && !document.querySelector('.model-picker-panel') && !document.querySelector('.model-picker-trigger').disabled; })()`);
}

async function assertPanelFits(selector) {
  const geometry = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight }; })()`);
  assert.ok(geometry.width > 100 && geometry.height > 40, `${selector} should be visibly laid out`);
  assert.ok(geometry.left >= -1 && geometry.top >= -1 && geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1, `${selector} must remain inside viewport: ${JSON.stringify(geometry)}`);
  return geometry;
}

async function screenshot(name, cropSelectors) {
  await fs.mkdir(screenshotRoot, { recursive: true });
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible() || await evaluate('document.visibilityState') !== 'visible') mainWindow.showInactive();
  await evaluate('document.body.getBoundingClientRect().toJSON()');
  // DOM visibility can precede the compositor's new menu frame. Wait for the
  // renderer to paint twice, then let the native surface catch up before capture.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await delay(200);
  const file = path.join(screenshotRoot, name);
  const crop = cropSelectors ? await evaluate(`(() => {
    const boxes = ${JSON.stringify(cropSelectors)}.map(selector => document.querySelector(selector)?.getBoundingClientRect()).filter(Boolean);
    const x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.left)) - 12));
    const y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.top)) - 12));
    return { x, y, width: Math.ceil(Math.min(650, innerWidth - x, Math.max(...boxes.map(box => box.right)) + 12 - x)), height: Math.ceil(Math.min(550, innerHeight - y, Math.max(...boxes.map(box => box.bottom)) + 12 - y)) };
  })()`) : undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const image = await mainWindow.webContents.capturePage(crop);
      assert.ok(!image.isEmpty(), 'Screenshot must contain pixels');
      await fs.writeFile(file, image.toPNG());
      report.screenshots.push(file);
      return;
    } catch (error) { if (attempt === 2) throw error; await delay(150); }
  }
}

async function chooseTheme(name, value) {
  await click('.settings-button');
  await waitFor('settings dialog', `Boolean(document.querySelector('.theme-buttons'))`);
  await evaluate(`Array.from(document.querySelectorAll('.theme-buttons button')).find(button => button.textContent.includes(${JSON.stringify(name)})).click()`);
  await waitFor(`${value} theme`, `document.documentElement.dataset.theme === ${JSON.stringify(value)}`);
  await click('[role="dialog"] [aria-label="关闭"]');
  await waitFor('settings closed', `!document.querySelector('[role="dialog"]')`);
}

async function run() {
  await waitFor('real Pi connection and custom model controls', `Boolean(window.pi) && Boolean(document.querySelector('.connection-pill.connected')) && Boolean(document.querySelector('.model-picker-trigger:not(:disabled)'))`, 40_000);
  const initial = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  assert.equal(`${initial.model.provider}/${initial.model.id}`, initialKey);
  assert.equal(initial.messageCount, 0);
  assert.equal(await evaluate(`document.querySelector('#model-select').tagName`), 'BUTTON');
  report.checks.push('Custom model controls connect through the real sandboxed preload to an isolated Pi process');

  await openModels();
  const groups = await evaluate(`Array.from(document.querySelectorAll('.model-picker-group')).map(group => group.getAttribute('aria-label'))`);
  assert.ok(groups.includes(providerA) && groups.includes(providerB));
  assert.equal(await evaluate(`document.querySelector('.model-picker-option[aria-selected="true"]')?.dataset.modelKey`), initialKey);
  await searchModels('共用模型');
  await waitFor('two same-name models', `document.querySelectorAll('.model-picker-option').length === 2`);
  assert.deepEqual(new Set(await evaluate(`Array.from(document.querySelectorAll('.model-picker-option')).map(option => option.dataset.modelKey)`)), new Set([initialKey, betaKey]));
  const sharedLabels = await evaluate(`Array.from(document.querySelectorAll('.model-picker-option')).map(option => option.innerText)`);
  assert.ok(sharedLabels.some(label => label.includes('alpha-shared')) && sharedLabels.some(label => label.includes('beta-shared')), 'duplicate display names need visible distinguishing model IDs');
  await searchModels('alpha-long');
  await waitFor('model ID search', `document.querySelectorAll('.model-picker-option').length === 1 && document.querySelector('.model-picker-option').dataset.modelKey === ${JSON.stringify(longKey)}`);
  await searchModels(providerB);
  await waitFor('provider search', `document.querySelectorAll('.model-picker-option').length === 1 && document.querySelector('.model-picker-option').dataset.modelKey === ${JSON.stringify(betaKey)}`);
  report.checks.push('Grouped models, current selection and searching by name, ID and provider work; duplicate names remain distinguishable');
  await click(modelOption(betaKey));
  await waitModel(betaKey);
  await openModels();
  assert.equal(await evaluate(`document.querySelector('.model-picker-option[aria-selected="true"]')?.dataset.modelKey`), betaKey);
  await press('Escape');
  await waitFor('Escape returns focus to model trigger', `!document.querySelector('.model-picker-panel') && document.activeElement === document.querySelector('.model-picker-trigger')`);
  report.checks.push('Selecting a model changes the actual Pi model; Escape closes and restores trigger focus');

  const supported = (await evaluate(`window.pi.rpc({ type: 'get_available_thinking_levels' })`)).levels;
  await openThinking();
  const visibleLevels = await evaluate(`Array.from(document.querySelectorAll('.thinking-picker-option')).map(option => option.dataset.level)`);
  assert.deepEqual(new Set(visibleLevels), new Set(supported));
  const beforeThinking = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  const nextLevel = supported.includes('high') ? 'high' : supported.find(level => level !== beforeThinking.thinkingLevel);
  assert.ok(nextLevel, 'reasoning fixture must expose selectable thinking levels');
  await click(thinkingOption(nextLevel));
  await waitFor('thinking level reaches real Pi', `(async () => (await window.pi.rpc({ type: 'get_state' })).thinkingLevel === ${JSON.stringify(nextLevel)} && !document.querySelector('.thinking-picker-panel') && Boolean(document.querySelector('.model-picker-trigger:not(:disabled)')) && Boolean(document.querySelector('.thinking-picker-trigger:not(:disabled)')))()`);
  report.checks.push('Thinking options exactly match Pi-supported levels and selection changes actual RPC state');

  await openModels();
  await searchModels('');
  const keys = await evaluate(`Array.from(document.querySelectorAll('.model-picker-option')).map(option => option.dataset.modelKey)`);
  const activeBefore = await evaluate(`document.querySelector('.model-picker-option.keyboard-active')?.dataset.modelKey`);
  assert.ok(keys.includes(activeBefore));
  const nextKey = keys[(keys.indexOf(activeBefore) + 1) % keys.length];
  await press('ArrowDown');
  await waitFor('model keyboard highlight advances', `document.querySelector('.model-picker-option.keyboard-active')?.dataset.modelKey === ${JSON.stringify(nextKey)}`);
  await press('Enter');
  await waitModel(nextKey);
  // Always use a reasoning fixture for the thinking keyboard check.
  if (nextKey.endsWith('/alpha-quick')) { await openModels(); await click(modelOption(initialKey)); await waitModel(initialKey); }
  await openThinking();
  const levelOrder = await evaluate(`Array.from(document.querySelectorAll('.thinking-picker-option')).map(option => option.dataset.level)`);
  const activeLevel = await evaluate(`document.querySelector('.thinking-picker-option.keyboard-active')?.dataset.level`);
  assert.ok(levelOrder.includes(activeLevel));
  const nextKeyboardLevel = levelOrder[(levelOrder.indexOf(activeLevel) + 1) % levelOrder.length];
  await press('ArrowDown');
  await waitFor('thinking keyboard highlight advances', `document.querySelector('.thinking-picker-option.keyboard-active')?.dataset.level === ${JSON.stringify(nextKeyboardLevel)}`);
  await press('Enter');
  await waitFor('thinking keyboard selection reaches Pi', `(async () => (await window.pi.rpc({ type: 'get_state' })).thinkingLevel === ${JSON.stringify(nextKeyboardLevel)} && !document.querySelector('.thinking-picker-panel') && Boolean(document.querySelector('.thinking-picker-trigger:not(:disabled)')))()`);
  await openThinking();
  await press('Escape');
  await waitFor('thinking Escape focus restore', `!document.querySelector('.thinking-picker-panel') && document.activeElement === document.querySelector('.thinking-picker-trigger')`);
  report.checks.push('ArrowDown/Enter select models and thinking levels; both pickers restore focus on Escape');

  await openModels();
  await click('.thinking-picker-trigger');
  await waitFor('only thinking menu stays open', `Boolean(document.querySelector('.thinking-picker-panel')) && !document.querySelector('.model-picker-panel')`);
  const outside = await evaluate(`(() => { const r = document.querySelector('.current-title').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', ...outside, button: 'left', clickCount: 1 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp', ...outside, button: 'left', clickCount: 1 });
  await waitFor('outside click closes both menus', `!document.querySelector('.model-picker-panel') && !document.querySelector('.thinking-picker-panel')`);
  report.checks.push('Only one menu opens at a time and a real outside mouse click closes it');

  await openModels();
  await searchModels('alpha-long');
  await click(modelOption(longKey));
  await waitModel(longKey);
  mainWindow.setContentSize(960, 680);
  await delay(200);
  await openModels();
  await searchModels('');
  report.compactGeometry = await assertPanelFits('.model-picker-panel');
  await screenshot('selectors-model-light.png');
  await screenshot('selectors-model.png', ['.model-picker-trigger', '.thinking-picker-trigger', '.model-picker-panel']);
  await press('Escape');
  await openThinking();
  await assertPanelFits('.thinking-picker-panel');
  await screenshot('selectors-thinking-light.png');
  await screenshot('selectors-thinking.png', ['.thinking-picker-trigger', '.thinking-picker-panel']);
  await press('Escape');
  await chooseTheme('深色', 'dark');
  await openModels();
  await assertPanelFits('.model-picker-panel');
  await screenshot('selectors-model-dark.png');
  await press('Escape');
  await openThinking();
  await assertPanelFits('.thinking-picker-panel');
  await screenshot('selectors-thinking-dark.png');
  await press('Escape');
  report.checks.push('Long model names and both menu panels fit a 960×680 viewport in light and dark themes');
  const finalState = await evaluate(`window.pi.rpc({ type: 'get_state' })`);
  assert.equal(finalState.messageCount, 0, 'selector acceptance must not send model prompts');
  assert.equal(finalState.isStreaming, false);
  assert.equal(finalState.isCompacting, false);
  assert.equal(report.rendererErrors.length, 0, 'renderer must not report console errors');
  report.checks.push('No prompt, generation, session content or external model request was initiated');
  await finish();
}

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) {
    report.errors.push(error.stack || String(error));
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { report.uiAtFailure = await evaluate('document.body.innerText.slice(0, 10000)'); } catch {}
      try { await screenshot('selectors-failure.png'); } catch {}
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { await evaluate('window.pi?.disconnect()', 8000); report.checks.push('Pi child disconnected cleanly before Electron exit'); }
    catch (cleanupError) { report.errors.push(`Cleanup: ${cleanupError.message}`); }
  }
  report.finished = new Date().toISOString();
  report.success = !report.errors.length && !report.rendererErrors.length;
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.mkdir(qaRoot, { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(qaRoot, 'selector-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.success ? 0 : 1);
}

app.on('browser-window-created', (_event, created) => {
  if (mainWindow) return;
  mainWindow = created;
  created.webContents.setBackgroundThrottling(false);
  created.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') report.rendererErrors.push(details.message);
  });
  created.webContents.once('did-finish-load', () => void run().catch(finish));
});
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));

(async () => {
  await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(agent, { recursive: true }), fs.mkdir(desktop, { recursive: true })]);
  const provider = models => ({ baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'selector-fixture', models });
  await fs.writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: {
    [providerA]: provider([modelFixture('alpha-shared', '共用模型'), modelFixture('alpha-quick', '轻快模型', false), modelFixture('alpha-long', longName)]),
    [providerB]: provider([modelFixture('beta-shared', '共用模型')]),
  } }, null, 2));
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: providerA, defaultModel: 'alpha-shared', defaultThinkingLevel: 'off' }));
  await fs.writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: project, name: path.basename(project), lastOpened: new Date().toISOString() }], lastProject: project, lastSessions: {} }));
  require(path.join(root, 'dist-electron', 'main.cjs'));
})().catch(finish);
