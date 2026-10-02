import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { readSessionHeader, readSessionInfo } from '../electron/storage';

const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const session = (project: string, id = 'session-1') => jsonl(
  { type: 'session', id, cwd: project },
  { type: 'message', message: { role: 'user', content: '中文缓存检查' } },
  { type: 'session_info', name: '原名称' },
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-session-cache-'));
  const project = path.join(root, '中文 项目');
  await mkdir(project);
  return {
    root, project, file: path.join(root, 'history.jsonl'),
    cleanup: async () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('pi-session-cache-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('unchanged session reads coalesce, use metadata cache, enforce project ownership, and return independent objects', async () => {
  const env = await fixture();
  const original = fs.createReadStream;
  let reads = 0;
  const spy = mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    if (String(args[0]) === env.file) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(env.file, session(env.project));
    const concurrent = await Promise.all(Array.from({ length: 16 }, () => readSessionInfo(env.file, env.project)));
    assert.equal(reads, 2, 'parallel requests share one header stream and one complete history stream');
    assert.ok(concurrent.every(info => info?.messageCount === 1));
    concurrent[0]!.name = '调用方修改';
    concurrent[0]!.cwd = path.join(env.root, 'wrong');
    concurrent[0]!.messageCount = 999;
    assert.equal(concurrent[1]!.name, '原名称', 'concurrent callers must not share mutable results');

    const header = await readSessionHeader(env.file);
    header!.id = 'changed-by-caller';
    header!.cwd = path.join(env.root, 'wrong');
    const again = await readSessionInfo(env.file, env.project);
    assert.equal(again?.name, '原名称');
    assert.equal(again?.messageCount, 1);
    assert.equal((await readSessionHeader(env.file))?.id, 'session-1');
    assert.equal(await readSessionInfo(env.file, path.join(env.root, 'other-project')), null);
    assert.equal(reads, 2, 'unchanged cache hits and rejected project ownership do not read file contents');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    await env.cleanup();
  }
});

test('session cache refreshes after append, rename, deletion, and replacement even when size and mtime are preserved', async () => {
  const env = await fixture();
  try {
    await writeFile(env.file, session(env.project));
    assert.equal((await readSessionInfo(env.file, env.project))?.messageCount, 1);
    await appendFile(env.file, jsonl(
      { type: 'message', message: { role: 'assistant', content: '新增回复' } },
      { type: 'session_info', name: '追加后重命名' },
    ));
    const appended = await readSessionInfo(env.file, env.project);
    assert.equal(appended?.messageCount, 2);
    assert.equal(appended?.name, '追加后重命名');

    const moved = path.join(env.root, 'renamed.jsonl');
    await rename(env.file, moved);
    assert.equal(await readSessionInfo(env.file, env.project), null);
    assert.equal(await readSessionHeader(env.file), null);
    assert.equal((await readSessionInfo(moved, env.project))?.name, '追加后重命名');
    await rm(moved);
    assert.equal(await readSessionInfo(moved, env.project), null);
    assert.equal(await readSessionHeader(moved), null);

    await writeFile(env.file, session(env.project, 'session-A'));
    assert.equal((await readSessionInfo(env.file, env.project))?.id, 'session-A');
    const previous = await stat(env.file);
    const replacement = path.join(env.root, 'replacement.jsonl');
    await writeFile(replacement, session(env.project, 'session-B'));
    await utimes(replacement, previous.atime, previous.mtime);
    await rm(env.file);
    await rename(replacement, env.file);
    assert.equal((await stat(env.file)).size, previous.size);
    assert.equal((await readSessionInfo(env.file, env.project))?.id, 'session-B', 'ctime and file identity reject stale same-size replacement');
    assert.equal((await readSessionHeader(env.file))?.id, 'session-B');
  } finally { await env.cleanup(); }
});

test('a session changing during reading is not retained as a stable cache entry', async () => {
  const env = await fixture();
  const original = fs.createReadStream;
  let reads = 0;
  let mutate = true;
  const spy = mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = original(...args);
    if (String(args[0]) === env.file) {
      reads++;
      if (mutate) {
        mutate = false;
        stream.once('data', () => {
          fs.appendFileSync(env.file, jsonl({ type: 'session_info', name: '读取期间追加' }));
        });
      }
    }
    return stream;
  });
  syncBuiltinESMExports();
  try {
    await writeFile(env.file, session(env.project));
    assert.equal((await readSessionHeader(env.file))?.id, 'session-1');
    assert.equal(reads, 1);
    await readSessionHeader(env.file);
    assert.equal(reads, 2, 'a file changed between the pre-read and post-read stat requires another read');
    await readSessionHeader(env.file);
    assert.equal(reads, 2, 'the subsequent stable read becomes cacheable');
    assert.equal((await readSessionInfo(env.file, env.project))?.name, '读取期间追加');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    await env.cleanup();
  }
});

test('session metadata cache evicts old entries without limiting discoverable history files', async () => {
  const env = await fixture();
  const original = fs.createReadStream;
  let reads = 0;
  const spy = mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    if (path.dirname(String(args[0])) === env.root) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(env.file, session(env.project));
    await readSessionHeader(env.file);
    const otherFiles = Array.from({ length: 512 }, (_, i) => path.join(env.root, `other-${i}.jsonl`));
    for (let i = 0; i < otherFiles.length; i += 32) {
      await Promise.all(otherFiles.slice(i, i + 32).map(async file => {
        await writeFile(file, session(env.project));
        assert.equal((await readSessionHeader(file))?.id, 'session-1');
      }));
    }
    assert.equal(reads, 513);
    await readSessionHeader(otherFiles[256]);
    assert.equal(reads, 513, 'a retained file uses the cached metadata');
    assert.equal((await readSessionHeader(env.file))?.id, 'session-1');
    assert.equal(reads, 514, 'the oldest evicted entry remains readable from disk');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    await env.cleanup();
  }
});
