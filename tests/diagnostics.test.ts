import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { discoverDiagnostics, type DiagnosticsContext } from '../electron/diagnostics';
import { bundledRuntimePaths } from '../electron/runtime';
import type { Preferences } from '../shared/types';

const preferences: Preferences = { projects: [], theme: 'light' };
async function file(path: string, content = 'fixture') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}
async function pi(path: string, version = '0.84.2') {
  await file(path);
  await file(join(dirname(path), '..', 'package.json'), JSON.stringify({ version }));
  return path;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-diagnostics-'));
  const runtimeRoot = join(root, 'runtime');
  const bundled = bundledRuntimePaths(runtimeRoot);
  const systemBin = join(root, 'system-bin');
  const system = {
    node: join(systemBin, 'node.exe'),
    pi: join(systemBin, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    bash: join(systemBin, 'bash.exe'),
  };
  const context: DiagnosticsContext = {
    runtimeRoot, packaged: true, platform: 'win32', homeDir: join(root, 'home'),
    environment: { Path: systemBin, ProgramFiles: join(root, 'program-files'), APPDATA: join(root, 'app-data'), ELECTRON_RUN_AS_NODE: '1', PRIVATE_TEST_VALUE: 'fixture-only-secret' },
    runNodeVersion: async () => 'v22.23.3',
  };
  return {
    root, bundled, system, context,
    installBundled: () => Promise.all([file(bundled.node), pi(bundled.pi), file(bundled.bash)]),
    installSystem: () => Promise.all([file(system.node), pi(system.pi), file(system.bash)]),
    cleanup: async () => {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('pi-diagnostics-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('diagnostics prefer validated bundled files and expose only paths, versions, and sources', async () => {
  const env = await fixture();
  try {
    await Promise.all([env.installBundled(), env.installSystem()]);
    const inheritedBefore = { ...env.context.environment };
    const result = await discoverDiagnostics(preferences, {
      ...env.context,
      runNodeVersion: async (nodePath, childEnv) => {
        assert.equal(nodePath, env.bundled.node);
        assert.equal(childEnv.ELECTRON_RUN_AS_NODE, undefined);
        assert.ok(childEnv.Path?.startsWith(dirname(env.bundled.node)));
        return 'v22.23.3';
      },
    });
    assert.equal(result.nodePath, env.bundled.node);
    assert.equal(result.piPath, env.bundled.pi);
    assert.equal(result.bashPath, env.bundled.bash);
    assert.equal(result.nodeSource, 'bundled');
    assert.equal(result.piSource, 'bundled');
    assert.equal(result.bashSource, 'bundled');
    assert.equal(result.nodeVersion, 'v22.23.3');
    assert.equal(result.piVersion, '0.84.2');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(JSON.stringify(result).includes('fixture-only-secret'), false);
    assert.deepEqual(env.context.environment, inheritedBefore);
  } finally { await env.cleanup(); }
});

test('explicit Pi and Node paths override bundled runtime and invalid overrides are not silently replaced', async () => {
  const env = await fixture();
  try {
    await env.installBundled();
    const nodePath = await file(join(env.root, 'custom-node.exe'));
    const piPath = await pi(join(env.root, 'custom-pi', 'dist', 'cli.js'), '0.85.0');
    const chosen = await discoverDiagnostics({ ...preferences, nodePath, piPath }, env.context);
    assert.equal(chosen.nodePath, nodePath);
    assert.equal(chosen.piPath, piPath);
    assert.equal(chosen.nodeSource, 'custom');
    assert.equal(chosen.piSource, 'custom');
    assert.equal(chosen.piVersion, '0.85.0');
    assert.deepEqual(chosen.errors, []);
    const missing = await discoverDiagnostics({ ...preferences, nodePath: join(env.root, 'missing-node.exe'), piPath: join(env.root, 'missing-pi.js') }, env.context);
    assert.equal(missing.nodePath, null);
    assert.equal(missing.piPath, null);
    assert.equal(missing.nodeSource, undefined);
    assert.equal(missing.piSource, undefined);
    assert.equal(missing.errors.length, 2);
    assert.ok(missing.errors.every(error => error.includes('清空')));
  } finally { await env.cleanup(); }
});

test('missing bundled files fall back to system sources and packaged builds report repair while development remains usable', async () => {
  const env = await fixture();
  try {
    await env.installSystem();
    const result = await discoverDiagnostics(preferences, env.context);
    assert.equal(result.nodePath, env.system.node);
    assert.equal(result.piPath, env.system.pi);
    assert.equal(result.bashPath, env.system.bash);
    assert.equal(result.nodeSource, 'system');
    assert.equal(result.piSource, 'system');
    assert.equal(result.bashSource, 'system');
    assert.deepEqual(result.errors, []);
    assert.match(result.warnings!.join(' '), /修复|重新安装/);
    const development = await discoverDiagnostics(preferences, { ...env.context, packaged: false });
    assert.deepEqual(development.errors, []);
    assert.deepEqual(development.warnings, []);
  } finally { await env.cleanup(); }
});

test('unavailable runtime components are never reported as bundled and give actionable installation repair errors', async () => {
  const env = await fixture();
  try {
    const result = await discoverDiagnostics(preferences, { ...env.context, runNodeVersion: async () => { throw new Error('should not execute absent file'); } });
    assert.equal(result.nodePath, null);
    assert.equal(result.piPath, null);
    assert.equal(result.bashPath, null);
    assert.equal(result.nodeSource, undefined);
    assert.equal(result.piSource, undefined);
    assert.equal(result.bashSource, undefined);
    assert.equal(result.errors.length, 3);
    assert.ok(result.errors.every(error => /修复|重新安装/.test(error)));
  } finally { await env.cleanup(); }
});

test('unusable bundled Node can fall back, custom old Node is rejected, and damaged bundled Pi is diagnosed', async () => {
  const env = await fixture();
  try {
    await Promise.all([env.installBundled(), env.installSystem()]);
    const fallback = await discoverDiagnostics(preferences, {
      ...env.context,
      runNodeVersion: async path => {
        if (path === env.bundled.node) throw new Error('fixture corrupted executable');
        return 'v22.23.3';
      },
    });
    assert.equal(fallback.nodePath, env.system.node);
    assert.equal(fallback.nodeSource, 'system');
    assert.deepEqual(fallback.errors, []);
    assert.match(fallback.warnings!.join(' '), /已回退/);
    const old = await discoverDiagnostics({ ...preferences, nodePath: env.system.node }, { ...env.context, runNodeVersion: async () => 'v22.18.0' });
    assert.equal(old.nodeSource, 'custom');
    assert.match(old.errors.join(' '), /22\.19\.0/);
    await file(join(dirname(env.bundled.pi), '..', 'package.json'), '{}');
    const damaged = await discoverDiagnostics(preferences, env.context);
    assert.match(damaged.errors.join(' '), /内置 Pi.*修复/);
  } finally { await env.cleanup(); }
});

test('bundled PortableGit supports usr/bin/bash.exe when no bin wrapper is present', async () => {
  const env = await fixture();
  try {
    await Promise.all([file(env.bundled.node), pi(env.bundled.pi), file(env.bundled.bashFallback)]);
    const result = await discoverDiagnostics(preferences, env.context);
    assert.equal(result.bashPath, env.bundled.bashFallback);
    assert.equal(result.bashSource, 'bundled');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  } finally { await env.cleanup(); }
});

test('Windows blocks connection when Pi and Node exist but no Bash is available', async () => {
  const env = await fixture();
  try {
    await Promise.all([file(env.bundled.node), pi(env.bundled.pi)]);
    const packaged = await discoverDiagnostics(preferences, env.context);
    assert.equal(packaged.bashPath, null);
    assert.equal(packaged.bashSource, undefined);
    assert.equal(packaged.errors.length, 1);
    assert.match(packaged.errors[0], /Git Bash.*修复/);
    const development = await discoverDiagnostics(preferences, { ...env.context, packaged: false });
    assert.equal(development.errors.length, 1);
    assert.match(development.errors[0], /Git Bash.*准备内置运行环境/);
  } finally { await env.cleanup(); }
});

test('existing global and project shellPath settings remain valid without automatically discovered Bash', async () => {
  const env = await fixture();
  try {
    await Promise.all([file(env.bundled.node), pi(env.bundled.pi)]);
    const globalShell = await file(join(env.root, 'custom-shell', 'bash.exe'));
    await file(join(env.context.homeDir!, '.pi', 'agent', 'settings.json'), JSON.stringify({ shellPath: globalShell }));
    const global = await discoverDiagnostics(preferences, env.context);
    assert.equal(global.bashPath, globalShell);
    assert.equal(global.bashSource, 'custom');
    assert.deepEqual(global.errors, []);
    const projectDir = join(env.root, 'project');
    const projectShell = await file(join(projectDir, 'tools', 'bash.exe'));
    await file(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ shellPath: './tools/bash.exe' }));
    const local = await discoverDiagnostics(preferences, { ...env.context, projectDir });
    assert.equal(local.bashPath, projectShell);
    assert.equal(local.bashSource, 'custom');
    assert.deepEqual(local.errors, []);
    const bootstrap = await discoverDiagnostics({ ...preferences, lastProject: projectDir }, env.context);
    assert.equal(bootstrap.bashPath, projectShell, 'bootstrap resolves the last project shell exactly as connect does');
  } finally { await env.cleanup(); }
});

test('Bash diagnostics mirror Pi precedence: explicit shell, installed Git, bundled PATH, then original PATH', async () => {
  const env = await fixture();
  try {
    await Promise.all([env.installBundled(), env.installSystem()]);
    const installedBash = await file(join(env.context.environment!.ProgramFiles!, 'Git', 'bin', 'bash.exe'));
    const installed = await discoverDiagnostics(preferences, env.context);
    assert.equal(installed.bashPath, installedBash);
    assert.equal(installed.bashSource, 'system');
    assert.equal(installed.nodeSource, 'bundled');
    assert.equal(installed.piSource, 'bundled');
    await file(join(env.context.homeDir!, '.pi', 'agent', 'settings.json'), JSON.stringify({ shellPath: env.system.bash }));
    const custom = await discoverDiagnostics(preferences, env.context);
    assert.equal(custom.bashPath, env.system.bash);
    assert.equal(custom.bashSource, 'custom');
    assert.deepEqual(custom.errors, []);
  } finally { await env.cleanup(); }
});
