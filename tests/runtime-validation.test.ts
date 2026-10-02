import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const { assertRuntimeInputs, assertRuntimeTree } = createRequire(import.meta.url)('../scripts/runtime-validation.cjs') as {
  assertRuntimeInputs(manifest: unknown, lock: unknown): void;
  assertRuntimeTree(root: string): Promise<{ files: number; directories: number }>;
};
const pi = '@earendil-works/pi-coding-agent';
const manifest = { dependencies: { [pi]: '0.84.2' } };
const lock = { packages: { '': { dependencies: { [pi]: '0.84.2' } }, [`node_modules/${pi}`]: { version: '0.84.2', resolved: 'https://registry.npmjs.org/pi.tgz' } } };

test('runtime inputs reject the local desktop dependency and linked or escaping lockfile packages', () => {
  assert.doesNotThrow(() => assertRuntimeInputs(manifest, lock));
  assert.throws(() => assertRuntimeInputs({ dependencies: { [pi]: '0.84.2', 'pi-desktop': 'file:../..' } }, lock), /exactly one direct dependency/);
  assert.throws(() => assertRuntimeInputs(manifest, { packages: { ...lock.packages, '../..': { name: 'pi-desktop' } } }), /outside/);
  assert.throws(() => assertRuntimeInputs(manifest, { packages: { ...lock.packages, 'node_modules/pi-desktop': { resolved: '../..', link: true } } }), /linked package/);
  assert.throws(() => assertRuntimeInputs(manifest, { packages: { ...lock.packages, 'node_modules/unexpected': { version: '1.0.0', resolved: 'file:../../outside' } } }), /local package reference/);
});

test('runtime validation rejects a directory junction cycle without traversing it', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-validation-'));
  const loop = join(root, 'pi', 'node_modules', 'pi-desktop');
  try {
    await mkdir(dirname(loop), { recursive: true });
    await writeFile(join(root, 'ordinary.cmd'), '@echo off');
    const clean = await assertRuntimeTree(root);
    assert.equal(clean.files, 1);
    assert.equal(clean.directories, 3);
    await symlink(root, loop, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertRuntimeTree(root), /symbolic link or directory junction/);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('pi-runtime-validation-'));
    // Remove the link itself before recursively removing the fixture directory.
    await rm(loop, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
