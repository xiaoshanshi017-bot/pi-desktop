import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveSessionRestore } from '../electron/session-restore';

async function isolatedRestoreTest(work: (root: string, project: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-session-restore-tests-'));
  const project = path.join(root, '中文 项目');
  await mkdir(project);
  try {
    await work(root, project);
  } finally {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('pi-session-restore-tests-'));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function sessionContent(project: string) {
  return [
    { type: 'session', version: 3, id: 'restore-session', cwd: project, timestamp: '2026-10-01T00:00:00.000Z' },
    { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: '保留原始历史。' }] } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: [{ type: 'text', text: '已完成。' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

test('session restore preserves a valid Chinese-path conversation and leaves its source unchanged', async () => {
  await isolatedRestoreTest(async (root, project) => {
    const file = path.join(root, '历史 会话.jsonl');
    const original = sessionContent(project);
    await writeFile(file, original, 'utf8');
    const restored = await resolveSessionRestore(project, file);
    assert.equal(restored.missing, false);
    assert.equal(restored.sessionPath, file);
    assert.equal(await readFile(file, 'utf8'), original);
    const fresh = await resolveSessionRestore(project);
    assert.equal(fresh.missing, false);
    assert.equal(fresh.sessionPath, undefined);
  });
});

test('deleted saved sessions and missing parent directories fall back without creating replacement files', async () => {
  await isolatedRestoreTest(async (root, project) => {
    const deleted = path.join(root, 'deleted-session.jsonl');
    await writeFile(deleted, sessionContent(project));
    await rm(deleted);
    for (const candidate of [deleted, path.join(root, 'removed-directory', 'session.jsonl')]) {
      const result = await resolveSessionRestore(project, candidate);
      assert.equal(result.missing, true);
      assert.equal(result.sessionPath, undefined);
      await assert.rejects(readFile(candidate), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    }
  });
});

test('a saved session path whose parent is now a file is treated as missing', async () => {
  await isolatedRestoreTest(async (root, project) => {
    const formerDirectory = path.join(root, 'former-directory');
    await writeFile(formerDirectory, 'a regular file now', 'utf8');
    const result = await resolveSessionRestore(project, path.join(formerDirectory, 'session.jsonl'));
    assert.equal(result.missing, true);
    assert.equal(result.sessionPath, undefined);
    assert.equal(await readFile(formerDirectory, 'utf8'), 'a regular file now');
  });
});

test('existing corrupt or other-project sessions are rejected instead of silently replacing conversation context', async () => {
  await isolatedRestoreTest(async (root, project) => {
    const otherProject = path.join(root, '另一个项目');
    await mkdir(otherProject);
    const wrongProject = path.join(root, 'wrong-project.jsonl');
    const corrupt = path.join(root, 'corrupt-session.jsonl');
    const originalWrongProject = sessionContent(otherProject);
    const originalCorrupt = '{"type":"session","id":"broken';
    await writeFile(wrongProject, originalWrongProject);
    await writeFile(corrupt, originalCorrupt);
    for (const candidate of [wrongProject, corrupt, otherProject]) {
      await assert.rejects(resolveSessionRestore(project, candidate), /会话无效|所属项目|不是文件/);
    }
    assert.equal(await readFile(wrongProject, 'utf8'), originalWrongProject);
    assert.equal(await readFile(corrupt, 'utf8'), originalCorrupt);
  });
});
