import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { bundledRuntimePaths, createPiEnvironment, createPiLaunchOptions, environmentPathDirectories } from '../electron/runtime';
import type { Diagnostics } from '../shared/types';

test('bundled runtime PATH is scoped to the Pi child and combines Windows PATH spellings without duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-env-'));
  try {
    const paths = bundledRuntimePaths(root);
    await Promise.all(paths.pathDirectories.map(directory => mkdir(directory, { recursive: true })));
    const inherited = {
      PATH: '"C:\\Existing";C:\\Windows\\System32', Path: 'c:\\existing;D:\\Other', pAtH: 'D:\\Other;',
      ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', PRIVATE_TEST_VALUE: 'fixture-only-secret',
      ProgramFiles: 'C:\\Program Files', PI_CODING_AGENT_DIR: join(homedir(), '.pi', 'agent'),
    };
    const before = { ...inherited };
    const parentPath = process.env.PATH;
    const parentPathCase = process.env.Path;
    const result = await createPiEnvironment(root, inherited, 'win32');
    assert.deepEqual(Object.keys(result).filter(key => key.toLowerCase() === 'path'), ['Path']);
    assert.deepEqual(environmentPathDirectories(result, 'win32'), [...paths.pathDirectories, 'C:\\Existing', 'C:\\Windows\\System32', 'D:\\Other']);
    assert.equal(Object.keys(result).some(key => key.toLowerCase() === 'electron_run_as_node'), false);
    assert.equal(result.PRIVATE_TEST_VALUE, inherited.PRIVATE_TEST_VALUE, 'Pi retains its own provider environment without publishing it');
    assert.equal(result.ProgramFiles, inherited.ProgramFiles);
    assert.equal(result.PI_CODING_AGENT_DIR, inherited.PI_CODING_AGENT_DIR);
    assert.deepEqual(inherited, before);
    assert.equal(process.env.PATH, parentPath);
    assert.equal(process.env.Path, parentPathCase);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('pi-runtime-env-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('unprepared bundled directories are not advertised in child PATH', async () => {
  const result = await createPiEnvironment(join(tmpdir(), 'pi-no-such-runtime', 'missing'), { PATH: 'C:\\Windows\\System32', ELECTRON_RUN_AS_NODE: '1' }, 'win32');
  assert.equal(result.Path, 'C:\\Windows\\System32');
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
});

test('non-Windows environments retain case-sensitive keys and use the correct PATH delimiter', async () => {
  const inherited = { PATH: '/usr/bin:/bin:/usr/bin', Path: 'unrelated-value', ELECTRON_RUN_AS_NODE: '1' };
  const result = await createPiEnvironment(undefined, inherited, 'linux');
  assert.equal(result.PATH, '/usr/bin:/bin');
  assert.equal(result.Path, 'unrelated-value');
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, '1');
});

test('only bundled Pi uses the desktop launcher and an inherited shell override cannot reach custom Pi', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-launch-'));
  try {
    const paths = bundledRuntimePaths(root);
    const diagnostics: Diagnostics = { nodePath: paths.node, piPath: paths.pi, bashPath: paths.bash, piSource: 'bundled', piVersion: '0.84.2', nodeVersion: 'v22.23.3', agentDir: root, errors: [] };
    const options = { environment: { PI_DESKTOP_BASH_PATH: 'untrusted-inherited-value' } };
    await assert.rejects(createPiLaunchOptions(diagnostics, root, ['--mode', 'rpc'], options), /启动器缺失.*修复/);
    const devLauncher = join(root, 'development-launcher.mjs');
    await writeFile(devLauncher, '// fixture');
    const development = await createPiLaunchOptions(diagnostics, root, ['--mode', 'rpc'], { ...options, developmentLauncher: devLauncher });
    assert.deepEqual(development.args, [devLauncher, paths.pi, '--mode', 'rpc']);
    assert.equal(development.env.PI_DESKTOP_BASH_PATH, paths.bash);
    await writeFile(paths.launcher, '// fixture');
    const bundled = await createPiLaunchOptions(diagnostics, root, ['--mode', 'rpc', '--session', '中文 会话.jsonl'], options);
    assert.equal(bundled.executable, paths.node);
    assert.deepEqual(bundled.args, [paths.launcher, paths.pi, '--mode', 'rpc', '--session', '中文 会话.jsonl']);
    for (const piSource of ['custom', 'system'] as const) {
      const direct = await createPiLaunchOptions({ ...diagnostics, piSource }, root, ['--mode', 'rpc'], options);
      assert.deepEqual(direct.args, [paths.pi, '--mode', 'rpc']);
      assert.equal(direct.env.PI_DESKTOP_BASH_PATH, undefined);
    }
    assert.equal(options.environment.PI_DESKTOP_BASH_PATH, 'untrusted-inherited-value');
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('pi-runtime-launch-'));
    await rm(root, { recursive: true, force: true });
  }
});
