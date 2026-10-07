import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { CachedConversationTab, RpcRecord, WorkspaceSnapshot } from '../shared/types';

export const WORKSPACE_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_MAX_TABS = 50;
const viewFields = ['state', 'messages', 'models', 'commands', 'stats', 'levels', 'progress', 'draft', 'attachments', 'sendMode', 'tools', 'widgets', 'statuses'];
const isRecord = (value: unknown): value is RpcRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768 && isAbsolute(value);

/** The workspace is a local display cache, separate from Pi's durable JSONL. */
function checkedWorkspace(value: unknown, maxBytes = WORKSPACE_MAX_BYTES): { snapshot: WorkspaceSnapshot; serialized: string } {
  if (!isRecord(value) || value.version !== 1 || !finite(value.savedAt) || value.savedAt < 0 || !Array.isArray(value.tabs) || value.tabs.length > WORKSPACE_MAX_TABS) throw new Error('工作区缓存格式无效。');
  const ids = new Set<string>();
  const tabs: CachedConversationTab[] = value.tabs.map((tab: unknown) => {
    if (!isRecord(tab) || typeof tab.id !== 'string' || !tab.id.trim() || tab.id.length > 200 || tab.id === 'welcome' || ids.has(tab.id) || !validPath(tab.project) || (tab.sessionPath !== undefined && !validPath(tab.sessionPath)) || !finite(tab.lastActivity) || typeof tab.unread !== 'boolean' || !isRecord(tab.view) || !isRecord(tab.ui)) throw new Error('工作区会话缓存格式无效。');
    ids.add(tab.id);
    if (!isRecord(tab.view.state) || !isRecord(tab.view.stats) || !Array.isArray(tab.view.messages) || !Array.isArray(tab.view.models) || !Array.isArray(tab.view.commands) || typeof tab.view.draft !== 'string' || tab.view.draft.length > 2 * 1024 * 1024 || !Array.isArray(tab.view.attachments) || tab.view.attachments.length > 10) throw new Error('工作区会话内容格式无效。');
    for (const field of ['messages', 'models', 'commands']) if (tab.view[field].some((item: unknown) => !isRecord(item))) throw new Error('工作区消息缓存格式无效。');
    if (tab.view.attachments.some((attachment: unknown) => !isRecord(attachment) || typeof attachment.name !== 'string' || typeof attachment.path !== 'string' || !['text', 'image'].includes(attachment.type) || (attachment.type === 'text' && attachment.content !== undefined && typeof attachment.content !== 'string') || (attachment.type === 'image' && (typeof attachment.data !== 'string' || typeof attachment.mimeType !== 'string')))) throw new Error('工作区附件缓存格式无效。');
    const attachmentBytes = tab.view.attachments.reduce((total: number, attachment: RpcRecord) => total + Buffer.byteLength(attachment.content || attachment.data || '', 'utf8'), 0);
    if (attachmentBytes > 36 * 1024 * 1024) throw new Error('工作区附件缓存超过大小限制。');
    if ((tab.ui.windowStart !== null && (!Number.isInteger(tab.ui.windowStart) || tab.ui.windowStart < 0)) || !finite(tab.ui.scrollTop) || tab.ui.scrollTop < 0 || typeof tab.ui.nearBottom !== 'boolean') throw new Error('工作区阅读位置无效。');
    // Only the view envelope is filtered. Message and tool arguments retain
    // their original field names and contents for accurate historical display.
    const view = Object.fromEntries(viewFields.filter(field => tab.view[field] !== undefined).map(field => [field, tab.view[field]]));
    return {
      id: tab.id, project: tab.project, ...(tab.sessionPath ? { sessionPath: tab.sessionPath } : {}), lastActivity: tab.lastActivity, unread: tab.unread,
      view, ui: { windowStart: tab.ui.windowStart, scrollTop: tab.ui.scrollTop, nearBottom: tab.ui.nearBottom },
    };
  });
  if (value.activeId !== null && (typeof value.activeId !== 'string' || !ids.has(value.activeId))) throw new Error('工作区当前会话无效。');
  const snapshot: WorkspaceSnapshot = { version: 1, savedAt: value.savedAt, activeId: value.activeId, tabs };
  if (isRecord(value.ui)) snapshot.ui = { ...(typeof value.ui.sidebar === 'boolean' ? { sidebar: value.ui.sidebar } : {}), ...(typeof value.ui.inspector === 'boolean' ? { inspector: value.ui.inspector } : {}) };
  let serialized: string;
  try { serialized = JSON.stringify(snapshot); } catch { throw new Error('工作区缓存无法序列化。'); }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('工作区缓存超过 64 MB 大小限制。');
  return { snapshot, serialized };
}

export function normalizeWorkspace(value: unknown, maxBytes = WORKSPACE_MAX_BYTES): WorkspaceSnapshot { return checkedWorkspace(value, maxBytes).snapshot; }

export class WorkspaceStore {
  private value: WorkspaceSnapshot | null = null;
  private serialized = '';
  private revision = 0;
  private persistedRevision = 0;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly maxBytes = WORKSPACE_MAX_BYTES) {}
  async load(): Promise<WorkspaceSnapshot | null> {
    this.value = null;
    try {
      const metadata = await stat(this.file);
      if (!metadata.isFile() || metadata.size > this.maxBytes) return null;
      const loaded = checkedWorkspace(JSON.parse(await readFile(this.file, 'utf8')), this.maxBytes);
      this.value = loaded.snapshot;
      this.serialized = loaded.serialized;
    } catch { this.value = null; }
    return this.get();
  }
  get(): WorkspaceSnapshot | null { return this.value ? structuredClone(this.value) : null; }
  async save(value: unknown): Promise<void> {
    this.serialized = checkedWorkspace(value, this.maxBytes).serialized;
    // Keep renderer-owned objects isolated from later caller mutations.
    this.value = JSON.parse(this.serialized) as WorkspaceSnapshot;
    this.revision++;
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (this.persistedRevision === this.revision) return;
      // Consecutive queued updates share the latest snapshot. This avoids
      // writing every obsolete streamed intermediate state to disk.
      const revision = this.revision;
      const snapshot = this.serialized;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
      this.persistedRevision = revision;
    });
    await this.writes;
  }
  async flush(): Promise<void> { await this.writes; }
}
