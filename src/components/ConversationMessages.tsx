import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import type { RpcRecord } from '../../shared/types';
import { messageWindow } from '../message-window';
import { MessageView } from './MessageView';
import './ConversationMessages.css';

export interface ConversationMessagesHandle {
  showLatest: () => void;
  isLatest: () => boolean;
}

interface ConversationMessagesProps {
  windowKey: string;
  messages: RpcRecord[];
  modelName: string;
  resultMap: Record<string, RpcRecord>;
  tools: Record<string, RpcRecord>;
  onError: (error: unknown) => void;
  onCopy: (text: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  nearBottomRef: RefObject<boolean>;
  windowsRef: RefObject<Map<string, number | null>>;
  children?: ReactNode;
}

/** Bounded pages avoid parsing the entire saved conversation on every switch. */
export const ConversationMessages = memo(forwardRef<ConversationMessagesHandle, ConversationMessagesProps>(function ConversationMessages({ windowKey, messages, modelName, resultMap, tools, onError, onCopy, scrollRef, nearBottomRef, windowsRef, children }, ref) {
  const [stored, setStored] = useState(() => ({ key: windowKey, start: windowsRef.current.get(windowKey) ?? null }));
  const start = stored.key === windowKey ? stored.start : windowsRef.current.get(windowKey) ?? null;
  const page = messageWindow(messages.length, start);
  const latestRef = useRef(page.isLatest);
  latestRef.current = page.isLatest;
  const moveTo = useRef<'top' | 'bottom' | null>(null);

  function changePage(next: number | null, edge: 'top' | 'bottom') {
    windowsRef.current.set(windowKey, next);
    nearBottomRef.current = next === null;
    moveTo.current = edge;
    if (next === start && scrollRef.current) {
      scrollRef.current.scrollTop = edge === 'bottom' ? scrollRef.current.scrollHeight : 0;
      moveTo.current = null;
    }
    setStored({ key: windowKey, start: next });
  }

  useImperativeHandle(ref, () => ({
    showLatest: () => changePage(null, 'bottom'),
    isLatest: () => latestRef.current,
  }), [windowKey, start, scrollRef, windowsRef, nearBottomRef]);

  useLayoutEffect(() => {
    windowsRef.current.set(windowKey, start);
    // Only explicit page navigation changes scroll. App restores it on tab switches.
    if (moveTo.current && scrollRef.current) {
      scrollRef.current.scrollTop = moveTo.current === 'bottom' ? scrollRef.current.scrollHeight : 0;
      moveTo.current = null;
    }
  }, [windowKey, start, page.start, page.end, scrollRef, windowsRef]);

  const navigation = messages.length > page.limit && <nav className="message-history-nav" aria-label="消息历史分页">
    <button className="text-button history-first" aria-label="查看最早消息" disabled={page.start === 0} onClick={() => changePage(0, 'top')}><ChevronsLeft size={14} />最早</button>
    <button className="text-button history-older" disabled={page.older === null} onClick={() => changePage(page.older, 'bottom')}><ChevronLeft size={14} />更早消息</button>
    <span className="message-history-range" aria-live="polite">{page.start + 1}–{page.end} / {page.total} 条</span>
    <button className="text-button history-newer" disabled={page.isLatest} onClick={() => changePage(page.newer === Math.max(0, page.total - page.limit) ? null : page.newer, 'top')}>较新消息<ChevronRight size={14} /></button>
    {!page.isLatest && <button className="text-button history-latest" onClick={() => changePage(null, 'bottom')}><ArrowDown size={13} />回到最新</button>}
  </nav>;

  return <div className="messages" data-window-start={page.start} data-window-end={page.end} data-message-total={page.total} data-history-latest={page.isLatest}>
    {navigation}
    {page.older !== null && <div className="message-history-boundary"><button className="text-button" onClick={() => changePage(page.older, 'bottom')}><ArrowUp size={13} />查看更早的 {Math.min(page.limit, page.start)} 条消息</button></div>}
    {messages.slice(page.start, page.end).map((message, offset) => <MessageView key={`${message.role}-${message.timestamp || page.start + offset}-${page.start + offset}`} message={message} modelName={message.model || modelName} resultMap={resultMap} tools={tools} onError={onError} onCopy={onCopy} />)}
    {!page.isLatest && <div className="message-history-boundary"><button className="text-button" onClick={() => changePage(page.newer === Math.max(0, page.total - page.limit) ? null : page.newer, 'top')}><ArrowDown size={13} />查看较新的 {Math.min(page.limit, page.total - page.end)} 条消息</button><button className="text-button" onClick={() => changePage(null, 'bottom')}>回到最新</button></div>}
    {page.isLatest && children}
  </div>;
}));
