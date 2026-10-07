import { useEffect, useRef, type KeyboardEvent } from 'react';
import { CircleCheck, LoaderCircle, MessageSquare, TriangleAlert, X } from 'lucide-react';

export interface ActiveConversationItem {
  id: string;
  project: string;
  sessionName?: string;
  status: string;
  busy: boolean;
  lastActivity: number;
  unread?: boolean;
}

export interface ActiveConversationsProps {
  items: ActiveConversationItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
}

function projectName(project: string) {
  return project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '工作空间';
}

function conversationStatus(item: ActiveConversationItem) {
  if (item.status === 'attention') return '待确认';
  if (item.status === 'error') return '连接出错';
  if (item.status === 'restoring') return '恢复连接中';
  if (item.status === 'starting' || item.status === 'connecting') return '连接中';
  if (item.busy) return '运行中';
  if (item.unread) return '已完成';
  return item.status === 'ready' || item.status === 'connected' ? '就绪' : '未连接';
}

export function ActiveConversations({ items, activeId, onSelect, onClose }: ActiveConversationsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const running = items.filter(item => item.busy).length;
  const focusableId = items.some(item => item.id === activeId) ? activeId : items[0]?.id;
  useEffect(() => {
    const tab = activeId && tabs.current.get(activeId);
    if (!tab || !listRef.current) return;
    const tabRect = tab.getBoundingClientRect();
    const listRect = listRef.current.getBoundingClientRect();
    if (tabRect.left < listRect.left) listRef.current.scrollLeft -= listRect.left - tabRect.left + 8;
    else if (tabRect.right > listRect.right) listRef.current.scrollLeft += tabRect.right - listRect.right + 8;
  }, [activeId, items.length]);

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, item: ActiveConversationItem) {
    const index = items.findIndex(current => current.id === item.id);
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else if (event.key === 'Delete' && onClose) { event.preventDefault(); onClose(item.id); return; }
    else return;
    event.preventDefault();
    const next = items[nextIndex];
    tabs.current.get(next.id)?.focus();
    onSelect(next.id);
  }

  if (!items.length) return null;
  return <div className="active-conversations" aria-label="已开启的会话">
    <div className="conversation-tabs" ref={listRef} role="tablist" aria-label="切换会话" aria-orientation="horizontal">
      {items.map(item => {
        const name = item.sessionName?.trim() || '新会话';
        const project = projectName(item.project);
        const status = conversationStatus(item);
        const selected = item.id === activeId;
        const attention = item.status === 'attention' || item.status === 'error';
        const Icon = attention ? TriangleAlert : item.busy || item.status === 'connecting' || item.status === 'starting' ? LoaderCircle : item.unread ? CircleCheck : MessageSquare;
        return <div className={`conversation-tab-wrap ${selected ? 'selected' : ''}`} key={item.id} data-connection-id={item.id} data-status={item.status} data-busy={item.busy || undefined}>
          <button ref={element => { if (element) tabs.current.set(item.id, element); else tabs.current.delete(item.id); }} className="conversation-tab" role="tab" aria-selected={selected} aria-label={`开启会话 ${name}，${project}，${status}`} tabIndex={item.id === focusableId ? 0 : -1} title={`${project} · ${name}\n${status}`} onClick={() => onSelect(item.id)} onKeyDown={event => handleKey(event, item)}>
            <Icon size={13} className={!attention && (item.busy || item.status === 'connecting' || item.status === 'starting') ? 'spin' : ''} />
            <span className="conversation-tab-label"><strong>{name}</strong><small>{project}</small></span>
            {item.status === 'attention' && <span className="conversation-tab-status">待确认</span>}
            {item.unread && !selected && <span className="conversation-unread" aria-label="有新消息" />}
          </button>
          {onClose && <button className="conversation-tab-close" aria-label={`关闭会话 ${name}`} title={`关闭会话 ${name}`} onClick={() => onClose(item.id)}><X size={12} /></button>}
        </div>;
      })}
    </div>
    <span className={`conversations-running ${running ? 'has-running' : ''}`} role="status" aria-live="polite">{running ? <><LoaderCircle size={12} className="spin" />{running} 个运行中</> : `${items.length} 个会话`}</span>
  </div>;
}
