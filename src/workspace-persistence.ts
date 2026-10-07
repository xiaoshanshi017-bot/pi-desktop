import type { CachedConversationTab, ConnectionSummary, FileAttachment, RpcRecord, WorkspaceSnapshot } from '../shared/types';
import type { ProgressPhase, ProgressStep, RunProgress } from './progress';
import { emptyConversation, type ConversationView } from './workspace';

export type PersistedConversationView = Pick<ConversationView, 'state' | 'messages' | 'models' | 'commands' | 'stats' | 'levels' | 'progress' | 'draft' | 'attachments' | 'sendMode' | 'tools' | 'widgets' | 'statuses'>;
export type ConversationUiSnapshot = CachedConversationTab['ui'];

const record = (value: unknown): RpcRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcRecord : {};
const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const records = (value: unknown): RpcRecord[] => Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const phases = new Set<ProgressPhase>(['thinking', 'preparing', 'responding', 'tool', 'waiting', 'compacting', 'retrying', 'stopping', 'complete', 'error', 'interrupted']);
const terminalPhases = new Set<ProgressPhase>(['complete', 'error', 'interrupted']);
const modelFields = ['id', 'name', 'api', 'provider', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost'];
const stateFields = ['sessionId', 'sessionFile', 'sessionName', 'thinkingLevel', 'autoCompactionEnabled', 'messageCount', 'steeringMode', 'followUpMode'];

function displayModel(value: unknown): RpcRecord | undefined {
  const model = record(value);
  if (!Object.keys(model).length) return undefined;
  return Object.fromEntries(modelFields.filter(key => model[key] !== undefined).map(key => [key, model[key]]));
}

function stoppedProgress(value: unknown, now: number): RunProgress | null {
  const source = record(value);
  if (!phases.has(source.phase) || !Number.isFinite(source.startedAt)) return null;
  const active = !terminalPhases.has(source.phase) || source.endedAt === undefined;
  const steps = records(source.steps).filter(step => typeof step.id === 'string' && ['stage', 'tool'].includes(step.kind) && ['running', 'done', 'failed', 'interrupted'].includes(step.status)).map(step => ({
    id: step.id, kind: step.kind, label: text(step.label), detail: text(step.detail),
    status: step.status === 'running' ? 'interrupted' : step.status,
    startedAt: finite(step.startedAt, source.startedAt),
    ...(step.status === 'running' ? { endedAt: now } : typeof step.endedAt === 'number' ? { endedAt: finite(step.endedAt, now) } : {}),
  } as ProgressStep));
  return {
    phase: active ? 'interrupted' : source.phase,
    label: active ? '上次任务已中断' : text(source.label),
    detail: active ? '重启前未完成的操作已停止，已收到的输出保留；需要继续时请重新发送指令。' : text(source.detail),
    startedAt: source.startedAt, updatedAt: active ? now : finite(source.updatedAt, now), endedAt: finite(source.endedAt, now),
    steps, sequence: finite(source.sequence), activeTools: {}, completedTools: finite(source.completedTools), failedTools: finite(source.failedTools),
    ...(typeof source.assistantError === 'string' ? { assistantError: source.assistantError } : {}),
    ...(active || source.aborted ? { aborted: true } : {}),
  };
}

function readPersistedView(value: unknown, now: number): PersistedConversationView {
  const source = record(value);
  const oldState = record(source.state);
  const model = displayModel(oldState.model);
  const state = { ...Object.fromEntries(stateFields.filter(key => oldState[key] !== undefined).map(key => [key, oldState[key]])), ...(model ? { model } : {}), isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  const messages = records(source.messages).map(message => message._streaming ? { ...message, _streaming: false, ...(message.role === 'assistant' ? { stopReason: 'aborted' } : {}) } : message);
  const tools = Object.fromEntries(Object.entries(record(source.tools)).map(([id, value]) => {
    const tool = record(value);
    return [id, tool.status === 'running' ? { ...tool, status: 'interrupted', endedAt: now } : tool];
  }));
  const attachments: FileAttachment[] = records(source.attachments).filter(item => ['text', 'image'].includes(item.type) && typeof item.name === 'string' && typeof item.path === 'string').map(item => ({
    name: item.name, path: item.path, type: item.type,
    ...(typeof item.content === 'string' ? { content: item.content } : {}),
    ...(typeof item.data === 'string' ? { data: item.data } : {}),
    ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
  }));
  const base = emptyConversation('cached');
  return {
    state, messages, models: records(source.models).map(displayModel).filter((model): model is RpcRecord => Boolean(model)),
    commands: records(source.commands), stats: record(source.stats), levels: Array.isArray(source.levels) ? strings(source.levels) : base.levels,
    progress: stoppedProgress(source.progress, now), draft: text(source.draft), attachments,
    sendMode: source.sendMode === 'followUp' ? 'followUp' : source.sendMode === 'afterTool' ? 'afterTool' : 'redirect', tools,
    widgets: Object.fromEntries(Object.entries(record(source.widgets)).map(([key, value]) => [key, strings(value)])),
    statuses: Object.fromEntries(Object.entries(record(source.statuses)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}

/** Only cached display data is saved; live prompts, queues and UI requests are excluded. */
export function persistConversationView(view: ConversationView, now = Date.now()): PersistedConversationView {
  return readPersistedView(view, now);
}

export function normalizeConversationUi(value?: Partial<ConversationUiSnapshot>): ConversationUiSnapshot {
  return { windowStart: value?.windowStart == null || !Number.isFinite(value.windowStart) ? null : Math.max(0, Math.floor(value.windowStart)), scrollTop: Math.max(0, finite(value?.scrollTop)), nearBottom: value?.nearBottom !== false };
}

/** Build a structured snapshot at a debounce/flush boundary, never for each token. */
export function createWorkspaceSnapshot(
  views: Record<string, ConversationView>, connections: ConnectionSummary[], activeId: string | null,
  uiById: Record<string, ConversationUiSnapshot> = {}, now = Date.now(), ui?: WorkspaceSnapshot['ui'],
): WorkspaceSnapshot {
  const summaries = new Map(connections.map(connection => [connection.id, connection]));
  const ids = [...new Set([...Object.keys(views), ...connections.map(connection => connection.id)])];
  const tabs: CachedConversationTab[] = [];
  for (const id of ids) {
    const view = views[id];
    if (!view?.project || id === 'welcome') continue;
    const connection = summaries.get(id);
    const lastMessage = view.messages.at(-1);
    const messageTime = lastMessage?.timestamp ? new Date(lastMessage.timestamp).getTime() : NaN;
    // Pi assigns a path before the first message creates the actual JSONL file.
    const sessionPath = view.messages.length ? text(view.state.sessionFile) || connection?.sessionPath : undefined;
    tabs.push({
      id, project: view.project, ...(sessionPath ? { sessionPath } : {}),
      lastActivity: finite(connection?.lastActivity, finite(view.progress?.updatedAt, Number.isFinite(messageTime) ? messageTime : now)),
      unread: Boolean(view.unread), view: persistConversationView(view, now), ui: normalizeConversationUi(uiById[id]),
    });
  }
  return { version: 1, savedAt: now, activeId: activeId && tabs.some(tab => tab.id === activeId) ? activeId : null, tabs, ...(ui ? { ui } : {}) };
}

export interface HydratedWorkspace {
  views: Record<string, ConversationView>;
  connections: ConnectionSummary[];
  activeId: string | null;
  uiById: Record<string, ConversationUiSnapshot>;
  ui: WorkspaceSnapshot['ui'];
}

/** Cached tab IDs identify views only; no connection is running until it is restored. */
export function hydrateWorkspace(snapshot?: WorkspaceSnapshot | null): HydratedWorkspace {
  const result: HydratedWorkspace = { views: {}, connections: [], activeId: null, uiById: {}, ui: undefined };
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tabs)) return result;
  const savedAt = finite(snapshot.savedAt, Date.now());
  for (const tab of snapshot.tabs) {
    if (!tab || typeof tab.id !== 'string' || !tab.id || tab.id === 'welcome' || typeof tab.project !== 'string' || !tab.project || result.views[tab.id]) continue;
    const cached = readPersistedView(tab.view, savedAt);
    if (!cached.state.sessionFile && typeof tab.sessionPath === 'string') cached.state.sessionFile = tab.sessionPath;
    const base = emptyConversation(tab.id, tab.project);
    result.views[tab.id] = {
      ...base, ...cached, status: 'restoring', unread: Boolean(tab.unread),
      notice: cached.progress?.phase === 'interrupted' ? { kind: 'info', text: '会话记录已恢复。上次未完成的任务已中断，需要继续时请重新发送指令。' } : null,
    };
    result.connections.push({ id: tab.id, project: tab.project, sessionPath: text(tab.sessionPath) || undefined, sessionName: text(cached.state.sessionName) || undefined, status: 'restoring', busy: false, lastActivity: finite(tab.lastActivity, savedAt) });
    result.uiById[tab.id] = normalizeConversationUi(tab.ui);
  }
  result.activeId = snapshot.activeId === null ? null : snapshot.activeId && result.views[snapshot.activeId] ? snapshot.activeId : result.connections[0]?.id || null;
  const globalUi = record(snapshot.ui);
  result.ui = { ...(typeof globalUi.sidebar === 'boolean' ? { sidebar: globalUi.sidebar } : {}), ...(typeof globalUi.inspector === 'boolean' ? { inspector: globalUi.inspector } : {}) };
  return result;
}
