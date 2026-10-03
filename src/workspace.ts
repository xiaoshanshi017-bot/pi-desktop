import type { Connection, ConnectionSummary, FileAttachment, RpcRecord } from '../shared/types';
import { applyMessageEvent, errorText } from './conversation';
import { applyProgressEvent, applyToolEvent, interruptTools, type RunProgress } from './progress';

export type Notice = { text: string; kind: 'error' | 'info' | 'success' };
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
}

export function emptyConversation(id: string, project = ''): ConversationView {
  return { id, project, status: 'disconnected', state: {}, messages: [], models: [], commands: [], stats: {}, levels: ['off', 'minimal', 'low', 'medium', 'high'], busy: false, mutating: false, progress: null, draft: '', attachments: [], sendMode: 'steer', queue: { steering: [], followUp: [] }, tools: {}, notice: null, dialogs: [], widgets: {}, statuses: {}, unread: false };
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
  if (sameSession && (busy || newerEvents)) {
    const identity = (message: RpcRecord) => JSON.stringify([message.role, message.timestamp, message.toolCallId]);
    const positions = new Map(messages.map((message, index) => [identity(message), index]));
    for (const live of previous.messages.filter(message => newerEvents || message._streaming)) {
      const key = identity(live);
      const index = positions.get(key);
      if (index === undefined) { positions.set(key, messages.length); messages.push(live); } else messages[index] = live;
    }
  }
  return {
    ...base, id, project: connection.project, status: newerEvents ? previous!.status : 'connected', state: newerEvents ? { ...connection.state, ...previous!.state } : connection.state,
    // get_messages may omit the in-flight assistant; keep its streamed text.
    messages,
    models: connection.models, commands: connection.commands, stats: newerEvents ? previous!.stats : connection.stats, busy,
    draft: sameSession ? (previous.state.sessionId ? previous.draft : previous.draft || savedDraft) : savedDraft, unread: false,
  };
}

export function applyConversationEvent(previous: ConversationView, event: RpcRecord, now: number, background = false): ConversationView {
  let next = { ...previous, progress: applyProgressEvent(previous.progress, event, now) };
  const error = (value: unknown) => { next.notice = { text: errorText(value), kind: 'error' }; };
  if (event.type === 'connection_status') {
    next.status = event.status;
    if (event.status === 'error' || event.status === 'disconnected') {
      next.busy = false; next.mutating = false; next.dialogs = [];
      next.messages = previous.messages.map(message => message._streaming ? { ...message, _streaming: false, stopReason: 'aborted' } : message);
      next.tools = interruptTools(previous.tools, now);
      next.state = { ...previous.state, isStreaming: false, isCompacting: false };
    }
    if (event.status === 'error' && (event.message || event.error)) error(event.message || event.error);
  }
  if (event.type === 'diagnostic') next.notice = { text: event.message, kind: event.level === 'error' ? 'error' : 'info' };
  if (['message_start', 'message_update', 'message_end'].includes(event.type)) next.messages = applyMessageEvent(previous.messages, event);
  if (event.type === 'agent_start') { next.busy = true; next.state = { ...previous.state, isStreaming: true }; }
  if (event.type === 'agent_settled') {
    next.busy = false; next.tools = interruptTools(previous.tools, now);
    next.state = { ...previous.state, isStreaming: false, isCompacting: false };
  }
  if (event.type === 'message_end' && event.message?.errorMessage) error(event.message.errorMessage);
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
