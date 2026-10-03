import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import type { Connection, ConnectionSummary, PiDesktopApi, RpcRecord } from '../shared/types';
import { applyConversationEvent, draftKey, emptyConversation, receiveConnection, type ConversationView } from './workspace';

type ViewSetter<K extends keyof ConversationView> = (value: SetStateAction<ConversationView[K]>) => void;
const WELCOME = 'welcome';

export function useWorkspace(api: PiDesktopApi | undefined) {
  const [activeId, setActiveId] = useState(WELCOME);
  const activeIdRef = useRef(activeId);
  const [views, setViews] = useState<Record<string, ConversationView>>({ [WELCOME]: emptyConversation(WELCOME) });
  const viewsRef = useRef(views);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const epochs = useRef(new Map<string, number>());
  const eventRevisions = useRef(new Map<string, number>());
  const connectionRevision = useRef(0);
  const refreshView = useRef<(id: string) => Promise<void>>(async () => {});
  const dialogTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const renderFrame = useRef<number | null>(null);
  const publish = useCallback((all: Record<string, ConversationView>, deferred = false) => {
    viewsRef.current = all;
    if (deferred) {
      if (renderFrame.current === null) renderFrame.current = requestAnimationFrame(() => {
        renderFrame.current = null;
        setViews(viewsRef.current);
      });
    } else {
      if (renderFrame.current !== null) { cancelAnimationFrame(renderFrame.current); renderFrame.current = null; }
      setViews(all);
    }
  }, []);
  useEffect(() => () => { if (renderFrame.current !== null) cancelAnimationFrame(renderFrame.current); }, []);
  const update = useCallback((id: string, change: Partial<ConversationView> | ((view: ConversationView) => ConversationView), deferred = false) => {
    const previous = viewsRef.current[id];
    if (!previous) return;
    const next = typeof change === 'function' ? change(previous) : { ...previous, ...change };
    const all = { ...viewsRef.current, [id]: next };
    publish(all, deferred);
    if (next.draft !== previous.draft && next.project && next.state.sessionId) {
      try { localStorage.setItem(draftKey(next.project, next.state.sessionId), next.draft); } catch { /* Optional persistent draft cache. */ }
    }
  }, [publish]);
  const select = useCallback((id: string) => {
    if (!viewsRef.current[id]) return;
    activeIdRef.current = id;
    setActiveId(id);
    update(id, { unread: false });
  }, [update]);
  const load = useCallback((connection: Connection, activate = true, requestRevision?: number) => {
    const id = connection.connectionId || 'legacy';
    let savedDraft = '';
    try { savedDraft = localStorage.getItem(draftKey(connection.project, connection.state.sessionId)) || ''; } catch { /* Optional draft cache. */ }
    const newerEvents = requestRevision !== undefined && (eventRevisions.current.get(id) || 0) !== requestRevision;
    epochs.current.set(id, (epochs.current.get(id) || 0) + 1);
    const next = receiveConnection(viewsRef.current[id], connection, savedDraft, newerEvents);
    if (!activate) next.unread = viewsRef.current[id]?.unread || false;
    const all = { ...viewsRef.current, [id]: next };
    publish(all);
    if (activate) { activeIdRef.current = id; setActiveId(id); }
    if (newerEvents) void refreshView.current(id);
    return id;
  }, [publish]);
  const forget = useCallback((id: string) => {
    epochs.current.set(id, (epochs.current.get(id) || 0) + 1);
    const all = { ...viewsRef.current };
    delete all[id]; publish(all);
    if (activeIdRef.current === id) { activeIdRef.current = WELCOME; setActiveId(WELCOME); }
  }, [publish]);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const refresh = async (id: string) => {
      const epoch = (epochs.current.get(id) || 0) + 1;
      epochs.current.set(id, epoch);
      const revision = eventRevisions.current.get(id) || 0;
      try {
        const [state, stats, messages] = await Promise.all([
          api.rpc({ type: 'get_state' }, id), api.rpc({ type: 'get_session_stats' }, id), api.rpc({ type: 'get_messages' }, id),
        ]);
        if (disposed || epochs.current.get(id) !== epoch || !viewsRef.current[id]) return;
        update(id, previous => ({
          ...receiveConnection(previous, { connectionId: id, project: previous.project, state, stats, messages: messages.messages || [], models: previous.models, commands: previous.commands }, previous.draft, (eventRevisions.current.get(id) || 0) !== revision),
          unread: previous.unread,
        }));
      } catch (error) {
        if (!disposed && epochs.current.get(id) === epoch) update(id, { notice: { kind: 'error', text: error instanceof Error ? error.message : String(error) } });
      }
    };
    refreshView.current = refresh;
    const unsubscribe = api.onEvent(event => {
      if (event.type === 'connections_changed') { connectionRevision.current++; setConnections(event.connections || []); return; }
      const id = event.connectionId || (activeIdRef.current !== WELCOME ? activeIdRef.current : undefined);
      if (!id) return;
      if (!viewsRef.current[id]) {
        const all = { ...viewsRef.current, [id]: emptyConversation(id, event.project || '') };
        viewsRef.current = all;
      }
      const disconnected = event.type === 'connection_status' && ['error', 'disconnected'].includes(event.status);
      if (event.type === 'agent_start' || disconnected) epochs.current.set(id, (epochs.current.get(id) || 0) + 1);
      if ((event.type !== 'connection_status' && event.type !== 'diagnostic') || disconnected) eventRevisions.current.set(id, (eventRevisions.current.get(id) || 0) + 1);
      // Keep event state current synchronously, but paint streamed bursts once
      // per frame so parallel output does not flood the renderer with commits.
      update(id, previous => applyConversationEvent(previous, event, Date.now(), id !== activeIdRef.current), event.type === 'message_update' || event.type === 'tool_execution_update');
      if (event.type === 'extension_ui_request' && event.method === 'setTitle' && id === activeIdRef.current) document.title = event.title || 'Pi Desktop';
      if (event.type === 'agent_settled') void refresh(id);
    });
    const initialRevision = connectionRevision.current;
    void api.listConnections().then(items => { if (!disposed && connectionRevision.current === initialRevision) setConnections(items); }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, [api, update]);

  useEffect(() => {
    if (!api) return;
    const pending = new Set<string>();
    for (const view of Object.values(views)) {
      for (const request of view.dialogs) {
        if (typeof request.timeout !== 'number' || !Number.isFinite(request.timeout) || request.timeout <= 0) continue;
        const key = `${view.id}:${request.id}`;
        pending.add(key);
        if (dialogTimers.current.has(key)) continue;
        const delay = Math.max(0, request.timeout - (Date.now() - request._received));
        dialogTimers.current.set(key, setTimeout(() => {
          if (!viewsRef.current[view.id]?.dialogs.some(item => item.id === request.id)) return;
          void api.respondUI({ id: request.id, cancelled: true }, view.id).then(() => {
            update(view.id, previous => ({ ...previous, dialogs: previous.dialogs.filter(item => item.id !== request.id) }));
          }).catch(error => update(view.id, { notice: { text: error instanceof Error ? error.message : String(error), kind: 'error' } }));
        }, delay));
      }
    }
    for (const [key, timer] of dialogTimers.current) {
      if (!pending.has(key)) { clearTimeout(timer); dialogTimers.current.delete(key); }
    }
  }, [api, views, update]);
  useEffect(() => () => { for (const timer of dialogTimers.current.values()) clearTimeout(timer); }, []);

  const setters = useMemo(() => {
    const field = <K extends keyof ConversationView>(key: K): ViewSetter<K> => value => update(activeId, previous => ({ ...previous, [key]: typeof value === 'function' ? (value as (current: ConversationView[K]) => ConversationView[K])(previous[key]) : value }));
    return { setStatus: field('status'), setProject: field('project'), setState: field('state'), setMessages: field('messages'), setModels: field('models'), setCommands: field('commands'), setStats: field('stats'), setLevels: field('levels'), setBusy: field('busy'), setMutating: field('mutating'), setProgress: field('progress'), setDraft: field('draft'), setAttachments: field('attachments'), setSendMode: field('sendMode'), setQueue: field('queue'), setTools: field('tools'), setNotice: field('notice'), setDialogs: field('dialogs'), setWidgets: field('widgets'), setStatuses: field('statuses') };
  }, [activeId, update]);
  return { activeId, activeIdRef, views, viewsRef, eventRevisions, snapshotEpochs: epochs, view: views[activeId] || views[WELCOME], connections, setters, update, load, select, forget };
}
