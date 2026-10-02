import { createReadStream, type Stats } from 'node:fs';
import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Preferences, Project, SessionInfo } from '../shared/types';
import { JsonlDecoder } from './rpc';

export function expandPath(value: string, baseDir = process.cwd()): string {
  return resolve(baseDir, value === '~' ? homedir() : /^~[\\/]/.test(value) ? join(homedir(), value.slice(2)) : value);
}
export function agentDir(baseDir = process.cwd()): string { return process.env.PI_CODING_AGENT_DIR ? expandPath(process.env.PI_CODING_AGENT_DIR, baseDir) : join(homedir(), '.pi', 'agent'); }
export function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  return normalize(a) === normalize(b);
}

export class PreferenceStore {
  private value: Preferences = { projects: [], theme: 'light', lastSessions: {} };
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async load(): Promise<Preferences> {
    try { this.value = this.merge(JSON.parse(await readFile(this.file, 'utf8'))); } catch { /* First launch or damaged preferences. */ }
    return this.get();
  }
  get(): Preferences { return structuredClone(this.value); }
  private merge(patch: Partial<Preferences>): Preferences {
    const next = { ...this.value };
    if (patch.theme === 'light' || patch.theme === 'dark') next.theme = patch.theme;
    for (const key of ['lastProject', 'piPath', 'nodePath'] as const) {
      if (typeof patch[key] === 'string') next[key] = patch[key]!.trim();
    }
    if (Array.isArray(patch.projects)) {
      next.projects = patch.projects.filter((p): p is Project => Boolean(p && typeof p.path === 'string' && typeof p.name === 'string' && typeof p.lastOpened === 'string'));
    }
    if (patch.lastSessions && typeof patch.lastSessions === 'object') {
      next.lastSessions = Object.fromEntries(Object.entries(patch.lastSessions).filter(([k, v]) => k && typeof v === 'string').slice(-100));
    }
    return next;
  }
  async save(patch: Partial<Preferences>): Promise<Preferences> {
    this.value = this.merge(patch);
    const snapshot = JSON.stringify(this.value, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.file);
    });
    await this.writes;
    return this.get();
  }
  async opened(project: string, sessionFile?: string): Promise<Preferences> {
    const prefs = this.get();
    const projects = [{ path: project, name: basename(project) || project, lastOpened: new Date().toISOString() }, ...prefs.projects.filter(p => !samePath(p.path, project))];
    return this.save({ projects, lastProject: project, lastSessions: sessionFile ? { ...prefs.lastSessions, [project]: sessionFile } : prefs.lastSessions });
  }
}

export async function sessionDirectories(project: string): Promise<string[]> {
  const configured: string[] = [];
  const projectAgentDir = agentDir(project);
  for (const settingsPath of [join(projectAgentDir, 'settings.json'), join(project, '.pi', 'settings.json')]) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (typeof settings.sessionDir === 'string') configured.push(expandPath(settings.sessionDir, project));
    } catch { /* A settings file is optional. */ }
  }
  if (process.env.PI_CODING_AGENT_SESSION_DIR) configured.push(expandPath(process.env.PI_CODING_AGENT_SESSION_DIR, project));
  const encoded = `--${resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return [...new Set([join(projectAgentDir, 'sessions', encoded), ...configured])];
}

type SessionHeader = { cwd: string; id: string; modified: string };
type SessionCacheValues = { header: SessionHeader | null; info: SessionInfo | null };
type SessionCacheEntry = { fingerprint: string } & Partial<SessionCacheValues>;
const sessionCache = new Map<string, SessionCacheEntry>();
const sessionReads = new Map<string, Promise<SessionHeader | SessionInfo | null>>();
const sessionCacheLimit = 512;
const sessionCacheValueLimit = 32_768;
const sessionPathKey = (file: string): string => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
const sessionFingerprint = (metadata: Stats): string => [metadata.size, metadata.mtimeMs, metadata.ctimeMs, metadata.dev, metadata.ino].join(':');

function discardSessionCache(key: string, fingerprint?: string): void {
  if (fingerprint === undefined || sessionCache.get(key)?.fingerprint === fingerprint) sessionCache.delete(key);
}

async function cachedSessionRead<K extends keyof SessionCacheValues>(
  file: string,
  part: K,
  read: (file: string, metadata: Stats) => Promise<SessionCacheValues[K]>,
): Promise<SessionCacheValues[K]> {
  file = resolve(file);
  const key = sessionPathKey(file);
  let metadata: Stats;
  try {
    metadata = await stat(file);
    if (!metadata.isFile()) { discardSessionCache(key); return null; }
  } catch { discardSessionCache(key); return null; }
  const fingerprint = sessionFingerprint(metadata);
  const cached = sessionCache.get(key);
  if (cached?.fingerprint === fingerprint) {
    sessionCache.delete(key);
    sessionCache.set(key, cached);
    if (cached[part] !== undefined) return structuredClone(cached[part]) as SessionCacheValues[K];
  } else discardSessionCache(key);

  const pendingKey = `${key}\0${fingerprint}\0${part}`;
  let pending = sessionReads.get(pendingKey);
  if (!pending) {
    pending = (async () => {
      try {
        const value = await read(file, metadata);
        const after = await stat(file);
        if (!after.isFile() || sessionFingerprint(after) !== fingerprint) {
          discardSessionCache(key, fingerprint);
          return value;
        }
        // A malformed file can contain huge metadata strings. Such results can
        // still be returned, but do not retain them in the bounded metadata cache.
        if (JSON.stringify(value).length <= sessionCacheValueLimit) {
          const current = sessionCache.get(key);
          const entry: SessionCacheEntry = current?.fingerprint === fingerprint ? current : { fingerprint };
          Object.assign(entry, { [part]: value });
          if (part === 'info' && value) {
            const info = value as SessionInfo;
            entry.header = info.id && isAbsolute(info.cwd) ? { cwd: resolve(info.cwd), id: info.id, modified: info.modified } : null;
          }
          sessionCache.delete(key);
          sessionCache.set(key, entry);
          while (sessionCache.size > sessionCacheLimit) sessionCache.delete(sessionCache.keys().next().value!);
        }
        return value;
      } catch {
        discardSessionCache(key, fingerprint);
        return null;
      }
    })();
    sessionReads.set(pendingKey, pending);
    void pending.finally(() => { if (sessionReads.get(pendingKey) === pending) sessionReads.delete(pendingKey); });
  }
  return structuredClone(await pending) as SessionCacheValues[K];
}

async function parseSessionInfo(file: string, metadata: Stats): Promise<SessionInfo | null> {
  let header: any;
  let invalid = false;
  let name: string | undefined;
  let firstMessage = '';
  let messageCount = 0;
  const decoder = new JsonlDecoder(line => {
    if (!line.trim() || invalid) return;
    let entry: any;
    // Match Pi's recovery behavior: a process interruption can leave one
    // truncated JSONL record without invalidating the saved conversation.
    try { entry = JSON.parse(line); } catch { return; }
    if (!entry || typeof entry !== 'object') return;
    if (!header) {
      if (entry.type !== 'session' || typeof entry.id !== 'string' || typeof entry.cwd !== 'string') { invalid = true; return; }
      header = entry;
      return;
    }
    if (entry.type === 'session_info') name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined;
    if (entry.type !== 'message') return;
    messageCount++;
    if (!firstMessage && entry.message?.role === 'user') {
      const content = entry.message.content;
      firstMessage = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ') : '').replace(/\s+/g, ' ').slice(0, 240);
    }
  });
  for await (const chunk of createReadStream(file)) {
    decoder.write(chunk as Buffer);
    if (invalid) return null;
  }
  decoder.end();
  if (invalid || !header) return null;
  return { path: resolve(file), id: header.id, cwd: header.cwd, name, firstMessage, modified: metadata.mtime.toISOString(), messageCount };
}

export async function readSessionInfo(file: string, project?: string): Promise<SessionInfo | null> {
  // Check ownership before parsing a large history, including on cache hits.
  if (project) {
    const header = await readSessionHeader(file);
    if (header && !samePath(header.cwd, project)) return null;
  }
  const info = await cachedSessionRead(file, 'info', parseSessionInfo);
  return info && (!project || samePath(info.cwd, project)) ? info : null;
}

async function parseSessionHeader(file: string, metadata: Stats): Promise<SessionHeader | null> {
  let header: SessionHeader | null = null;
  let found = false;
  const decoder = new JsonlDecoder(line => {
    if (found || !line.trim()) return;
    let entry: any;
    try { entry = JSON.parse(line); } catch { return; }
    if (!entry || typeof entry !== 'object') return;
    found = true;
    if (entry.type === 'session' && typeof entry.id === 'string' && entry.id && typeof entry.cwd === 'string' && isAbsolute(entry.cwd)) {
      header = { cwd: resolve(entry.cwd), id: entry.id, modified: metadata.mtime.toISOString() };
    }
  });
  for await (const chunk of createReadStream(file, { highWaterMark: 4096, end: 256 * 1024 - 1 })) {
    decoder.write(chunk as Buffer);
    if (found) break;
  }
  if (!found) decoder.end();
  return header;
}

/** Read only a bounded prefix. Discovery never needs message bodies or index previews. */
export async function readSessionHeader(file: string): Promise<SessionHeader | null> {
  return cachedSessionRead(file, 'header', parseSessionHeader);
}

export async function readIndexedSessionPaths(source = agentDir()): Promise<{ files: string[]; warning?: string }> {
  try {
    const index = JSON.parse(await readFile(join(source, 'pi-web-session-index.json'), 'utf8'));
    if (!index || typeof index.entries !== 'object' || !index.entries || Array.isArray(index.entries)) {
      return { files: [], warning: '网页版会话索引格式无法识别，已继续检查 Pi 会话目录。' };
    }
    return { files: Object.keys(index.entries).filter(file => isAbsolute(file) && file.toLowerCase().endsWith('.jsonl')).map(file => resolve(file)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [] };
    return { files: [], warning: '无法读取网页版会话索引，已继续检查 Pi 会话目录。' };
  }
}

export async function discoverSessionPaths(source = agentDir()): Promise<{ files: string[]; warnings: string[] }> {
  const indexed = await readIndexedSessionPaths(source);
  const files = [...indexed.files];
  const warnings = indexed.warning ? [indexed.warning] : [];
  const sessionsRoot = join(source, 'sessions');
  try {
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) files.push(join(sessionsRoot, entry.name));
      if (!entry.isDirectory()) continue;
      try {
        for (const file of await readdir(join(sessionsRoot, entry.name), { withFileTypes: true })) {
          if (file.isFile() && file.name.toLowerCase().endsWith('.jsonl')) files.push(join(sessionsRoot, entry.name, file.name));
        }
      } catch { warnings.push('部分会话目录无法读取，已跳过。'); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('无法读取 Pi 会话目录。');
  }
  return {
    files: [...new Map(files.map(file => [process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file), file])).values()],
    warnings: [...new Set(warnings)],
  };
}

export async function listSessions(project: string): Promise<SessionInfo[]> {
  const files: string[] = [];
  const discovered = await discoverSessionPaths(agentDir(project));
  // Share migration's discovery scope so every imported history is available.
  // Read headers first, never trusting the web index's cached project metadata.
  for (let i = 0; i < discovered.files.length; i += 12) {
    const batch = discovered.files.slice(i, i + 12);
    const headers = await Promise.all(batch.map(readSessionHeader));
    batch.forEach((file, index) => { if (headers[index] && samePath(headers[index]!.cwd, project)) files.push(file); });
  }
  for (const directory of await sessionDirectories(project)) {
    try {
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.isFile() && file.name.toLowerCase().endsWith('.jsonl')) files.push(join(directory, file.name));
      }
    } catch { /* No sessions for a new project. */ }
  }
  const results: SessionInfo[] = [];
  const unique = [...new Map(files.map(file => [process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file), file])).values()];
  for (let i = 0; i < unique.length; i += 6) {
    const batch = await Promise.all(unique.slice(i, i + 6).map(file => readSessionInfo(file, project)));
    results.push(...batch.filter((s): s is SessionInfo => Boolean(s)));
  }
  return results.sort((a, b) => b.modified.localeCompare(a.modified));
}
