import type { Connection, ConnectionSummary, FileAttachment, RpcRecord } from '../shared/types';
import { applyMessageEvent, errorText } from './conversation';
import { applyProgressEvent, applyToolEvent, interruptTools, type RunProgress } from './progress';
import { isCancelledMessage, SDK_ABORT_ERROR } from './cancellation';

export type Notice = { text: string; kind: 'error' | 'info' | 'success' };
export interface RedirectState {
  requestId: string;
  status: 'stopping' | 'submitting' | 'submitted' | 'cancelled' | 'error';
  message: string;
  error?: string;
}
export interface ConversationView {
  id: string;
  project: string;
  status: string;
  state: RpcRecord;
  messages: RpcRecord[];
  models: RpcRecord[];
  commands: RpcRecord[];
  stats: RpcRecord;
  levels: string[];
  busy: boolean;
  mutating: boolean;
  progress: RunProgress | null;
  draft: string;
  attachments: FileAttachment[];
  sendMode: string;
  queue: { steering: string[]; followUp: string[] };
  tools: Record<string, RpcRecord>;
  notice: Notice | null;
  dialogs: RpcRecord[];
  widgets: Record<string, string[]>;
  statuses: Record<string, string>;
  unread: boolean;
  restoring?: boolean;
  sessionControls?: boolean;
  redirect?: RedirectState | null;
}

export function emptyConversation(id: string, project = ''): ConversationView {
  return { id, project, status: 'disconnected', state: {}, messages: [], models: [], commands: [], stats: {}, levels: ['off', 'minimal', 'low', 'medium', 'high'], busy: false, mutating: false, progress: null, draft: '', attachments: [], sendMode: 'redirect', queue: { steering: [], followUp: [] }, tools: {}, notice: null, dialogs: [], widgets: {}, statuses: {}, unread: false, redirect: null, sessionControls: false };
}

export function draftKey(project: string, sessionId?: string): string {
  return `pi-desktop:draft:${project}:${sessionId || 'new'}`;
}

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();

/** Route an already hydrated conversation directly to its local view. */
export function findOpenConversation(views: Record<string, ConversationView>, connections: ConnectionSummary[], project: string, sessionPath?: string, activeId?: string): string | undefined {
  const candidates = connections.filter(connection => {
    const view = views[connection.id];
    return view?.status === 'connected' && Boolean(view.state.sessionId) && pathKey(connection.project) === pathKey(project)
      && (!sessionPath || pathKey(view.state.sessionFile || connection.sessionPath || '') === pathKey(sessionPath));
  });
  return candidates.find(connection => connection.id === activeId)?.id ?? candidates.sort((a, b) => b.lastActivity - a.lastActivity)[0]?.id;
}

export function receiveConnection(previous: ConversationView | undefined, connection: Connection, savedDraft = '', liveEventsSinceRequest = false): ConversationView {
  const id = connection.connectionId || 'legacy';
  const sameSession = previous && (!previous.state.sessionId || previous.state.sessionId === connection.state.sessionId);
  const base = sameSession ? previous : emptyConversation(id, connection.project);
  const newerEvents = Boolean(sameSession && liveEventsSinceRequest);
  const busy = newerEvents ? previous!.busy : Boolean(connection.state.isStreaming || connection.state.isCompacting);
  const messages = [...connection.messages];
  const cachedHistory = Boolean(sameSession && (previous.restoring || previous.messages.some(message => message._cachedOnly)));
  if (sameSession && (busy || newerEvents || cachedHistory)) {
    const identity = (message: RpcRecord) => JSON.stringify([message.role, message.timestamp, message.toolCallId]);
    const positions = new Map(messages.map((message, index) => [identity(message), index]));
    for (const live of previous.messages.filter(message => previous.restoring || message._cachedOnly || newerEvents || message._streaming)) {
      const key = identity(live);
      const index = positions.get(key);
      if (index === undefined) {
        positions.set(key, messages.length);
        // A last reply may have reached the desktop before Pi wrote it to JSONL.
        // Keep that saved display record, without treating it as a live response.
        const cachedOnly = previous.restoring || live._cachedOnly;
        messages.push(cachedOnly ? { ...live, _cachedOnly: true, _streaming: false, ...(live.role === 'assistant' ? { stopReason: 'aborted' } : {}) } : live);
      } else if (!previous.restoring && !live._cachedOnly && (newerEvents || live._streaming)) {
        messages[index] = live;
      }
    }
  }
  return {
    ...base, id, project: connection.project, status: newerEvents ? previous!.status : 'connected', state: newerEvents ? { ...connection.state, ...previous!.state } : connection.state,
    // get_messages may omit the in-flight assistant; keep its streamed text.
    messages,
    models: connection.models, commands: connection.commands, stats: newerEvents ? previous!.stats : connection.stats, busy,
    draft: sameSession ? (previous.state.sessionId ? previous.draft : previous.draft || savedDraft) : savedDraft, unread: false,
    // Capability belongs to the Pi process, including a new session in that process.
    sessionControls: previous?.id === id ? previous.sessionControls : false,
  };
}

export function applyConversationEvent(previous: ConversationView, event: RpcRecord, now: number, background = false): ConversationView {
  if (event.type === 'redirect_update') {
    if (typeof event.requestId !== 'string' || !event.requestId || !['stopping', 'submitting', 'submitted', 'cancelled', 'error'].includes(event.status)) return previous;
    if (event.status !== 'stopping' && previous.redirect?.requestId !== event.requestId) return previous;
    if (previous.redirect?.requestId === event.requestId && ['submitted', 'cancelled', 'error'].includes(previous.redirect.status)) return previous;
  }
  let next = { ...previous, progress: applyProgressEvent(previous.progress, event, now) };
  const error = (value: unknown) => { next.notice = { text: errorText(value), kind: 'error' }; };
  if (event.type === 'connection_status') {
    next.status = event.status;
    if (['connecting', 'error', 'disconnected'].includes(event.status)) next.sessionControls = false;
    if (event.status === 'error' || event.status === 'disconnected') {
      next.busy = false; next.mutating = false; next.dialogs = [];
      next.messages = previous.messages.map(message => message._streaming ? { ...message, _streaming: false, stopReason: 'aborted' } : message);
      next.tools = interruptTools(previous.tools, now);
      next.state = { ...previous.state, isStreaming: false, isCompacting: false };
    }
    if (event.status === 'error' && (event.message || event.error)) error(event.message || event.error);
  }
  if (event.type === 'desktop_capabilities') next.sessionControls = event.sessionControls === true;
  if (event.type === 'redirect_update') {
    next.redirect = {
      requestId: event.requestId, status: event.status,
      message: typeof event.message === 'string' ? event.message : previous.redirect?.message || '',
      ...(typeof event.error === 'string' ? { error: event.error } : {}),
    };
    if (event.status === 'error') error(event.error || '未能调整当前任务，请重试。');
  }
  if (event.type === 'diagnostic') next.notice = { text: event.message, kind: event.level === 'error' ? 'error' : 'info' };
  if (['message_start', 'message_update', 'message_end'].includes(event.type)) next.messages = applyMessageEvent(previous.messages, event);
  if (event.type === 'agent_start') {
    next.busy = true; next.state = { ...previous.state, isStreaming: true };
    const lastAssistant = previous.messages.findLast(message => message.role === 'assistant');
    if (previous.notice?.kind === 'error' && previous.notice.text === SDK_ABORT_ERROR && isCancelledMessage(lastAssistant)) next.notice = null;
  }
  if (event.type === 'agent_settled') {
    next.busy = false; next.tools = interruptTools(previous.tools, now);
    next.state = { ...previous.state, isStreaming: false, isCompacting: false };
  }
  if (event.type === 'message_end' && event.message?.errorMessage) {
    if (!isCancelledMessage(event.message)) error(event.message.errorMessage);
    else if (previous.notice?.kind === 'error' && previous.notice.text === event.message.errorMessage) next.notice = null;
  }
  if (event.type.startsWith('tool_execution_')) next.tools = applyToolEvent(previous.tools, event, now);
  if (event.type === 'queue_update') next.queue = { steering: event.steering || [], followUp: event.followUp || [] };
  if (['compaction_start', 'auto_compaction_start', 'auto_retry_start', 'summarization_retry_scheduled'].includes(event.type)) next.busy = true;
  if (['compaction_end', 'auto_compaction_end'].includes(event.type) && event.errorMessage) error(event.errorMessage);
  if (event.type === 'auto_retry_end' && event.finalError) error(event.finalError);
  if (event.type === 'extension_error') error(event.error);
  if (event.type === 'extension_ui_request') {
    if (['select', 'confirm', 'input', 'editor'].includes(event.method)) next.dialogs = [...previous.dialogs, { ...event, _received: now }];
    if (event.method === 'notify') next.notice = { text: event.message, kind: event.notifyType === 'error' ? 'error' : 'info' };
    if (event.method === 'setStatus') next.statuses = { ...previous.statuses, [event.statusKey]: event.statusText || '' };
    if (event.method === 'setWidget') next.widgets = { ...previous.widgets, [event.widgetKey]: event.widgetLines || [] };
    if (event.method === 'set_editor_text') next.draft = event.text || '';
  }
  if (background && (event.type === 'agent_settled' || next.notice?.kind === 'error' || next.dialogs.length > previous.dialogs.length)) next.unread = true;
  return next;
}
