import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createPiEnvironment } from '../electron/runtime';

const execute = promisify(execFile);
const launcher = resolve('electron', 'pi-launcher.mjs');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-launcher-中文 '));
  const packageRoot = join(root, 'pi');
  const cli = join(packageRoot, 'dist', 'cli.js');
  const settingsModule = join(packageRoot, 'dist', 'core', 'settings-manager.js');
  const settingsFile = join(root, 'settings.json');
  const shell = join(root, '便携 Bash', 'bash.exe');
  await Promise.all([mkdir(dirname(settingsModule), { recursive: true }), mkdir(dirname(shell), { recursive: true })]);
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.84.2' })),
    writeFile(settingsFile, '{}'), writeFile(shell, 'fixture'),
    writeFile(join(packageRoot, 'dist', 'core', 'agent-session.js'), `export class AgentSession {
  async abort() {} clearQueue() {} abortCompaction() {} abortBash() {}
  async prompt() {} async _runAgentPrompt() {}
}`),
    writeFile(settingsModule, `import {readFileSync} from 'node:fs';
export class SettingsManager {
  constructor() { this.settings = JSON.parse(readFileSync(process.env.FIXTURE_SETTINGS, 'utf8')); }
  getShellPath() { return this.settings.shellPath; }
  setShellPath() { throw Error('must not persist shell settings'); }
}
`),
    writeFile(cli, `import {SettingsManager} from './core/settings-manager.js';
const manager = new SettingsManager();
const first = manager.getShellPath();
manager.settings.shellPath = './changed-shell.exe';
process.stdout.write(JSON.stringify({first, updated: manager.getShellPath(), argv: process.argv.slice(1), internalEnv: process.env.PI_DESKTOP_BASH_PATH ?? null}));
`),
  ]);
  const environment = await createPiEnvironment(undefined, { ...process.env, PI_DESKTOP_BASH_PATH: 'ignored' });
  return {
    root, packageRoot, cli, settingsFile, settingsModule, shell,
    run: () => execute(process.execPath, [launcher, cli, '--mode', 'rpc', '--session', '中文 会话.jsonl'], { env: { ...environment, PI_DESKTOP_BASH_PATH: shell, FIXTURE_SETTINGS: settingsFile }, windowsHide: true, timeout: 15_000 }),
    cleanup: async () => {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('pi-launcher-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('bundled launcher supplies an absolute Unicode default shell, preserves CLI arguments, and never writes settings', async () => {
  const env = await fixture();
  try {
    const settingsBefore = await readFile(env.settingsFile, 'utf8');
    const output = (await env.run()).stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(output[0], { type: 'desktop_capabilities', sessionControls: true });
    const result = output[1];
    assert.equal(result.first, env.shell);
    assert.equal(result.updated, './changed-shell.exe', 'later user settings retain precedence over the default');
    assert.deepEqual(result.argv, [env.cli, '--extension', resolve('electron', 'desktop-command-guard.mjs'), '--mode', 'rpc', '--session', '中文 会话.jsonl']);
    assert.equal(result.internalEnv, null, 'launcher-only environment does not propagate to tool commands');
    assert.equal(await readFile(env.settingsFile, 'utf8'), settingsBefore);
  } finally { await env.cleanup(); }
});

test('bundled launcher keeps Pi own configured shellPath unchanged', async () => {
  const env = await fixture();
  try {
    await writeFile(env.settingsFile, JSON.stringify({ shellPath: './用户 自定义/bash.exe' }));
    const result = JSON.parse((await env.run()).stdout.trim().split('\n').at(-1)!);
    assert.equal(result.first, './用户 自定义/bash.exe');
    assert.equal(JSON.parse(await readFile(env.settingsFile, 'utf8')).shellPath, './用户 自定义/bash.exe');
  } finally { await env.cleanup(); }
});

test('bundled launcher fails clearly when the pinned Pi version or getter contract is missing', async () => {
  const env = await fixture();
  try {
    await writeFile(join(env.packageRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.99.0' }));
    await assert.rejects(env.run(), (error: any) => error.code === 1 && /版本不匹配/.test(error.stderr));
    await writeFile(join(env.packageRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.84.2' }));
    await writeFile(env.settingsModule, 'export class SettingsManager {}');
    await assert.rejects(env.run(), (error: any) => error.code === 1 && /接口不可用/.test(error.stderr));
  } finally { await env.cleanup(); }
});
