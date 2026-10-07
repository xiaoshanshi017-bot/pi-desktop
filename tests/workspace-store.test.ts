import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeWorkspace, WorkspaceStore } from '../electron/workspace-store';
import type { WorkspaceSnapshot } from '../shared/types';

function snapshot(draft = '未发送的草稿'): WorkspaceSnapshot {
  return {
    version: 1, savedAt: Date.now(), activeId: 'cache-A', ui: { sidebar: false, inspector: true },
    tabs: [{
      id: 'cache-A', project: path.resolve('中文 项目'), sessionPath: path.resolve('中文 项目/session.jsonl'), lastActivity: 123, unread: true,
      ui: { windowStart: 80, scrollTop: 325, nearBottom: false },
      view: {
        state: { sessionId: 'durable-A', sessionFile: path.resolve('中文 项目/session.jsonl') }, messages: [{ role: 'user', content: [{ type: 'text', text: '缓存显示内容' }] }], models: [], commands: [], stats: {},
        draft, levels: ['off', 'high'], progress: { endedAt: 111 }, attachments: [{ name: 'draft.txt', path: 'draft.txt', type: 'text', content: 'attachment content' }], sendMode: 'steer',
        tools: { 'tool-A': { args: { command: 'original command', apiKey: 'legitimate tool argument' }, output: 'tool output' } }, widgets: { status: ['saved widget'] }, statuses: { foo: 'status text' },
        connectionId: 'process-only-ID', dialogs: [{ id: 'process-only-dialog' }], busy: true,
      },
    }],
  };
}
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-workspace-store-tests-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pi-workspace-store-tests-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('durable workspace restores tabs, drafts, attachments and reading positions without process-only UI state', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'workspace.json');
  const original = snapshot();
  const store = new WorkspaceStore(file);
  await store.save(original);
  original.tabs[0].view.draft = 'caller changed after saving';
  const loaded = await new WorkspaceStore(file).load();
  assert.equal(loaded?.activeId, 'cache-A');
  assert.equal(loaded?.tabs[0].view.draft, '未发送的草稿');
  assert.equal(loaded?.tabs[0].view.attachments[0].content, 'attachment content');
  assert.deepEqual(loaded?.tabs[0].ui, { windowStart: 80, scrollTop: 325, nearBottom: false });
  assert.deepEqual(loaded?.ui, { sidebar: false, inspector: true });
  assert.equal('connectionId' in loaded!.tabs[0].view, false);
  assert.equal('dialogs' in loaded!.tabs[0].view, false);
  assert.equal('busy' in loaded!.tabs[0].view, false);
  assert.equal(loaded?.tabs[0].view.tools['tool-A'].args.apiKey, 'legitimate tool argument');
  const detached = store.get()!;
  detached.tabs[0].view.draft = 'get caller changed';
  assert.equal(store.get()?.tabs[0].view.draft, '未发送的草稿');
});

test('queued workspace writes and shutdown flush leave the latest atomic snapshot', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'workspace.json');
  const store = new WorkspaceStore(file);
  const writes = Array.from({ length: 30 }, (_, index) => store.save(snapshot(`draft ${index}`)));
  await store.flush();
  await Promise.all(writes);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tabs[0].view.draft, 'draft 29');
  assert.deepEqual(await readdir(root), ['workspace.json']);
  await store.save(snapshot('next revision'));
  await store.flush();
  assert.equal((await new WorkspaceStore(file).load())?.tabs[0].view.draft, 'next revision');
});

test('invalid or oversized snapshots cannot replace a valid workspace', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'workspace.json');
  const store = new WorkspaceStore(file, 4_096);
  await store.save(snapshot('good'));
  await assert.rejects(store.save({ ...snapshot(), version: 2 }), /格式无效/);
  const duplicate = snapshot(); duplicate.tabs.push(duplicate.tabs[0]);
  await assert.rejects(store.save(duplicate), /缓存格式无效/);
  const relative = snapshot(); relative.tabs[0].project = 'relative-project';
  await assert.rejects(store.save(relative), /缓存格式无效/);
  await assert.rejects(store.save(snapshot('x'.repeat(5_000))), /大小限制/);
  assert.equal((await new WorkspaceStore(file).load())?.tabs[0].view.draft, 'good');
});

test('missing, interrupted or future-format cache files do not prevent app startup or get overwritten', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'workspace.json');
  const store = new WorkspaceStore(file);
  assert.equal(await store.load(), null);
  for (const damaged of ['{"version":1,"tabs":', JSON.stringify({ ...snapshot(), version: 2 })]) {
    await writeFile(file, damaged);
    assert.equal(await store.load(), null);
    assert.equal(await readFile(file, 'utf8'), damaged);
  }
});

test('closed empty workspaces and new unsaved tabs remain valid without a JSONL file', () => {
  const empty: WorkspaceSnapshot = { version: 1, savedAt: 1, activeId: null, tabs: [] };
  assert.deepEqual(normalizeWorkspace(empty), empty);
  const unsaved = snapshot();
  delete unsaved.tabs[0].sessionPath;
  unsaved.tabs[0].view.state = {};
  assert.equal(normalizeWorkspace(unsaved).tabs[0].sessionPath, undefined);
  assert.equal(normalizeWorkspace(unsaved).tabs[0].view.draft, '未发送的草稿');
});
