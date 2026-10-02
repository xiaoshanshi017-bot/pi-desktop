import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listSessions, readSessionInfo, sessionDirectories } from '../electron/storage';

test('session discovery matches Pi directory encoding and resolves configured relative paths in the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-tests-'));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const agent = path.join(root, 'agent');
    const project = path.join(root, '中文 项目');
    await Promise.all([mkdir(agent), mkdir(path.join(project, '.pi'), { recursive: true })]);
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_CODING_AGENT_SESSION_DIR = './environment-history';
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: './global-history' }));
    await writeFile(path.join(project, '.pi/settings.json'), JSON.stringify({ sessionDir: './project-history' }));
    const dirs = await sessionDirectories(project);
    const encoded = `--${path.resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    assert.ok(dirs.includes(path.join(agent, 'sessions', encoded)), 'default Pi project directory remains discoverable');
    for (const configured of ['global-history', 'project-history', 'environment-history']) {
      assert.ok(dirs.includes(path.join(project, configured)), `relative ${configured} must resolve from the Pi child working directory`);
    }
    await mkdir(dirs[0], { recursive: true });
    const sessionPath = path.join(dirs[0], 'test.jsonl');
    const lines = [
      { type: 'session', version: 3, id: 'session-1', cwd: project, timestamp: '2026-10-01T00:00:00.000Z' },
      { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: '中文\u2028first message' }] } },
      { type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] } },
      { type: 'session_info', id: 'name-1', parentId: 'assistant-1', name: '已重命名' },
    ];
    await writeFile(sessionPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const info = await readSessionInfo(sessionPath, project);
    assert.equal(info?.id, 'session-1');
    assert.equal(info?.name, '已重命名');
    assert.equal(info?.messageCount, 2);
    assert.equal(await readSessionInfo(sessionPath, path.join(root, 'other-project')), null);
    assert.equal((await listSessions(project)).length, 1);
    await writeFile(sessionPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n{"type":"message","id":"interrupted');
    const recovered = await readSessionInfo(sessionPath, project);
    assert.equal(recovered?.id, 'session-1', 'a crash-truncated tail must not hide history that Pi can recover');
    assert.equal(recovered?.messageCount, 2);
    assert.equal((await listSessions(project)).length, 1);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pi-desktop-tests-'));
    await rm(root, { recursive: true, force: true });
  }
});
