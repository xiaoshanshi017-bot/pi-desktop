import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PreferenceStore, listSessions } from '../electron/storage';
import { importProjects, previewProjectMigration } from '../electron/project-migration';

async function withIsolatedMigration(work: (context: { root: string; agent: string; store: PreferenceStore }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-project-migration-tests-'));
  const agent = path.join(root, '独立 Pi 配置');
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousSession = process.env.PI_CODING_AGENT_SESSION_DIR;
  await mkdir(agent);
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const store = new PreferenceStore(path.join(root, 'desktop', 'preferences.json'));
  await store.load();
  try {
    await work({ root, agent, store });
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousSession === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSession;
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('pi-project-migration-tests-'));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function defaultSessionPath(agent: string, project: string, id: string) {
  const encoded = `--${path.resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(agent, 'sessions', encoded, `${id}.jsonl`);
}

async function sessionFile(file: string, project: string, id: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const entries = [
    { type: 'session', version: 3, id, cwd: project, timestamp: '2026-09-01T00:00:00.000Z' },
    { type: 'message', id: `${id}-user`, parentId: null, message: { role: 'user', content: [{ type: 'text', text: '迁移已有项目，保留历史。' }], timestamp: 1 } },
    { type: 'message', id: `${id}-assistant`, parentId: `${id}-user`, message: { role: 'assistant', content: [{ type: 'text', text: '已有回复。' }], timestamp: 2 } },
  ];
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

test('project migration imports Chinese paths without rewriting history and repeated imports preserve current desktop state', async () => {
  await withIsolatedMigration(async ({ root, agent, store }) => {
    const current = path.join(root, '当前 项目');
    const imported = path.join(root, '待导入 中文项目');
    await Promise.all([mkdir(current), mkdir(imported)]);
    const currentSession = defaultSessionPath(agent, current, 'current');
    const firstSession = defaultSessionPath(agent, imported, 'import-one');
    const secondSession = defaultSessionPath(agent, imported, 'import-two');
    await Promise.all([
      sessionFile(currentSession, current, 'current'),
      sessionFile(firstSession, imported, 'import-one'),
      sessionFile(secondSession, imported, 'import-two'),
    ]);
    const existingProject = { path: current, name: '保留现有名称', lastOpened: '2026-09-01T00:00:00.000Z' };
    await store.save({
      projects: [existingProject], lastProject: current, lastSessions: { [current]: currentSession },
      theme: 'dark', piPath: 'custom-pi-entry.js', nodePath: 'custom-node.exe',
    });
    const originalSource = await readFile(firstSession, 'utf8');
    const beforePreview = store.get();
    const preview = await previewProjectMigration(agent);
    assert.equal(preview.sessionCount, 3);
    assert.equal(preview.projects.length, 2);
    assert.equal(preview.projects.find(project => project.path === imported)?.sessionCount, 2);
    assert.ok(preview.projects.every(project => project.available));
    assert.deepEqual(store.get(), beforePreview, 'preview is read-only');

    const first = await importProjects([imported, imported], store, agent);
    assert.equal(first.imported, 1, 'repeated selection must not create duplicate project cards');
    assert.equal(first.alreadyPresent, 0);
    assert.equal(first.skipped, 0);
    assert.equal(first.sessionCount, 2);
    assert.equal(first.preferences.projects.length, 2);
    assert.deepEqual(first.preferences.projects.find(project => project.path === current), existingProject);
    assert.equal(first.preferences.lastProject, current);
    assert.deepEqual(first.preferences.lastSessions, { [current]: currentSession });
    assert.equal(first.preferences.theme, 'dark');
    assert.equal(first.preferences.piPath, 'custom-pi-entry.js');
    assert.equal(first.preferences.nodePath, 'custom-node.exe');

    const second = await importProjects([imported], store, agent);
    assert.equal(second.imported, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.sessionCount, 2);
    assert.deepEqual(second.preferences, first.preferences, 'importing an existing project must not switch or reorder it');
    assert.equal(await readFile(firstSession, 'utf8'), originalSource, 'migration must not rewrite Pi conversations');
  });
});

test('migration and subsequent preference saves retain more than thirty imported projects', async () => {
  await withIsolatedMigration(async ({ root, agent, store }) => {
    const current = path.join(root, '已打开项目');
    await mkdir(current);
    await store.save({ projects: [{ path: current, name: '当前项目', lastOpened: '2026-09-01T00:00:00.000Z' }], lastProject: current });
    const projects = Array.from({ length: 36 }, (_, index) => path.join(root, `项目 ${String(index).padStart(2, '0')}`));
    await Promise.all(projects.map(async (project, index) => {
      await mkdir(project);
      await sessionFile(defaultSessionPath(agent, project, `session-${index}`), project, `session-${index}`);
    }));
    const preview = await previewProjectMigration(agent);
    assert.equal(preview.projects.length, 36);
    const imported = await importProjects(projects, store, agent);
    assert.equal(imported.imported, 36);
    assert.equal(imported.preferences.projects.length, 37);
    assert.equal(imported.preferences.lastProject, current);
    await store.opened(projects[35]);
    assert.equal(store.get().projects.length, 37, 'opening a project must not reapply the old thirty-project cap');
    const loaded = await new PreferenceStore(path.join(root, 'desktop', 'preferences.json')).load();
    assert.equal(loaded.projects.length, 37, 'restarting the desktop must retain the full imported list');
    assert.deepEqual(new Set(loaded.projects.map(project => project.path)), new Set([current, ...projects]));
  });
});

test('a missing project is reported in preview and skipped during import without changing desktop state', async () => {
  await withIsolatedMigration(async ({ root, agent, store }) => {
    const missing = path.join(root, '已删除 中文项目');
    await sessionFile(defaultSessionPath(agent, missing, 'missing-project'), missing, 'missing-project');
    const before = store.get();
    const preview = await previewProjectMigration(agent);
    assert.equal(preview.projects.length, 1);
    assert.equal(preview.projects[0].path, missing);
    assert.equal(preview.projects[0].available, false);
    assert.equal(preview.projects[0].sessionCount, 1);
    const result = await importProjects([missing], store, agent);
    assert.equal(result.imported, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.sessionCount, 0);
    assert.deepEqual(result.preferences, before);
    assert.deepEqual(store.get(), before);
  });
});

test('PiWeb index contributes custom session paths while actual session headers determine project ownership', async () => {
  await withIsolatedMigration(async ({ root, agent, store }) => {
    const actual = path.join(root, '真实 中文项目');
    const forged = path.join(root, '索引伪造的项目');
    await Promise.all([mkdir(actual), mkdir(forged)]);
    const customFile = path.join(root, '自定义 历史目录', 'custom-session.jsonl');
    const defaultFile = defaultSessionPath(agent, actual, 'default-session');
    const missingFile = path.join(root, '不存在的会话.jsonl');
    const invalidFile = path.join(root, '自定义 历史目录', 'invalid-session.jsonl');
    await Promise.all([
      sessionFile(customFile, actual, 'custom-session'),
      sessionFile(defaultFile, actual, 'default-session'),
    ]);
    await writeFile(invalidFile, JSON.stringify({ type: 'message', id: 'not-a-session-header', cwd: forged }) + '\n');
    const index = {
      version: 1,
      entries: {
        [customFile]: { fp: {}, info: { cwd: forged, name: '不要信任此名称', id: 'forged-id', path: customFile, messageCount: 999 } },
        [defaultFile]: { fp: {}, info: { cwd: forged, path: defaultFile } },
        [missingFile]: { fp: {}, info: { cwd: forged, path: missingFile } },
        [invalidFile]: { fp: {}, info: { cwd: forged, path: invalidFile } },
      },
    };
    const indexFile = path.join(agent, 'pi-web-session-index.json');
    await writeFile(indexFile, JSON.stringify(index));
    const originalIndex = await readFile(indexFile, 'utf8');
    const originalSession = await readFile(customFile, 'utf8');
    const preview = await previewProjectMigration(agent);
    assert.equal(preview.projects.length, 1, 'forged, stale and invalid index metadata must not create project candidates');
    assert.equal(preview.projects[0].path, actual);
    assert.equal(preview.projects[0].name, path.basename(actual));
    assert.equal(preview.projects[0].sessionCount, 2, 'a session found in both default history and index counts once');
    assert.equal(preview.sessionCount, 2);
    const result = await importProjects([actual], store, agent);
    assert.equal(result.imported, 1);
    const history = await listSessions(actual);
    assert.deepEqual(new Set(history.map(session => session.path)), new Set([customFile, defaultFile]));
    assert.equal(history.find(session => session.path === customFile)?.id, 'custom-session');
    assert.equal((await listSessions(forged)).length, 0, 'index metadata must not leak another project history into this project');
    assert.equal(await readFile(indexFile, 'utf8'), originalIndex);
    assert.equal(await readFile(customFile, 'utf8'), originalSession);
  });
});

test('preview and project history agree for unindexed root sessions and legacy folders with uppercase extensions', async () => {
  await withIsolatedMigration(async ({ root, agent, store }) => {
    const project = path.join(root, '旧版 中文项目');
    await mkdir(project);
    const rootSession = path.join(agent, 'sessions', 'root-session.JSONL');
    const legacySession = path.join(agent, 'sessions', 'old-nonencoded-directory', 'legacy-session.JSONL');
    await Promise.all([
      sessionFile(rootSession, project, 'root-session'),
      sessionFile(legacySession, project, 'legacy-session'),
    ]);
    const preview = await previewProjectMigration(agent);
    assert.equal(preview.projects.length, 1);
    assert.equal(preview.projects[0].path, project);
    assert.equal(preview.projects[0].sessionCount, 2);
    assert.equal(preview.sessionCount, 2);
    const imported = await importProjects([project], store, agent);
    assert.equal(imported.imported, 1);
    assert.equal(imported.sessionCount, 2);
    const history = await listSessions(project);
    assert.equal(history.length, preview.projects[0].sessionCount, 'every discovered session remains visible after importing its project');
    assert.deepEqual(new Set(history.map(session => session.path)), new Set([rootSession, legacySession]));
  });
});
