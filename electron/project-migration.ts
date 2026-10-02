import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ProjectMigrationCandidate, ProjectMigrationPreview, ProjectMigrationResult } from '../shared/types';
import { agentDir, discoverSessionPaths, PreferenceStore, readSessionHeader, samePath } from './storage';

const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

export async function previewProjectMigration(source = agentDir()): Promise<ProjectMigrationPreview> {
  source = resolve(source);
  const { files: uniqueFiles, warnings } = await discoverSessionPaths(source);
  const projects = new Map<string, ProjectMigrationCandidate>();
  let invalid = 0;
  let sessionCount = 0;
  for (let i = 0; i < uniqueFiles.length; i += 12) {
    const headers = await Promise.all(uniqueFiles.slice(i, i + 12).map(readSessionHeader));
    for (const header of headers) {
      if (!header) { invalid++; continue; }
      sessionCount++;
      const key = pathKey(header.cwd);
      const existing = projects.get(key);
      if (existing) {
        existing.sessionCount++;
        if (header.modified > existing.lastOpened) existing.lastOpened = header.modified;
      } else {
        projects.set(key, { path: header.cwd, name: basename(header.cwd) || header.cwd, lastOpened: header.modified, sessionCount: 1, available: false });
      }
    }
  }
  const candidates = [...projects.values()];
  for (let i = 0; i < candidates.length; i += 12) {
    await Promise.all(candidates.slice(i, i + 12).map(async project => {
      try { project.available = (await stat(project.path)).isDirectory(); } catch { /* Moved or deleted project. */ }
    }));
  }
  if (invalid) warnings.push(`已跳过 ${invalid} 个不存在或无效的会话文件。`);
  return { source, projects: candidates.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened)), sessionCount, warnings: [...new Set(warnings)] };
}

export async function importProjects(paths: string[], store: PreferenceStore, source = agentDir()): Promise<ProjectMigrationResult> {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.trim() || !isAbsolute(path))) throw new Error('待导入项目路径无效。');
  // Rediscover at import time: a preview cannot authorize arbitrary paths or stale files.
  const preview = await previewProjectMigration(source);
  const candidates = new Map(preview.projects.map(project => [pathKey(project.path), project]));
  const selected = [...new Set(paths.map(pathKey))];
  const preferences = store.get();
  const projects = [...preferences.projects];
  let imported = 0;
  let alreadyPresent = 0;
  let skipped = 0;
  let sessionCount = 0;
  for (const key of selected) {
    const candidate = candidates.get(key);
    if (!candidate?.available) { skipped++; continue; }
    sessionCount += candidate.sessionCount;
    if (projects.some(project => samePath(project.path, candidate.path))) { alreadyPresent++; continue; }
    projects.push({ path: candidate.path, name: candidate.name, lastOpened: candidate.lastOpened });
    imported++;
  }
  return { preferences: imported ? await store.save({ projects }) : store.get(), imported, alreadyPresent, skipped, sessionCount };
}
