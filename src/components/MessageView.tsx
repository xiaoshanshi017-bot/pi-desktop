import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy, FileText, ImagePlus, ListFilter, LoaderCircle, Sparkles, Terminal, TriangleAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { RpcRecord } from '../../shared/types';
import { textContent } from '../conversation';
import { formatDuration, outputPreview, toolLabel, toolSummary } from '../progress';
import { useClock } from '../useClock';

type ErrorHandler = (error: unknown) => void;
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
const textPreviewLength = 24_000;

const Markdown = memo(function Markdown({ text, onError }: { text: string; onError: ErrorHandler }) {
  const components = useMemo<React.ComponentProps<typeof ReactMarkdown>['components']>(() => ({
    a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href && window.pi) void window.pi.openExternal(href).catch(onError); }}>{children}</a>,
    img: ({ alt, src }) => <span className="remote-image"><ImagePlus size={14} />{alt || '图片'}{src && <button onClick={() => window.pi && void window.pi.openExternal(src).catch(onError)}>在浏览器查看</button>}</span>,
    pre: ({ children }) => <div className="code-block"><button className="copy-code" title="复制代码" aria-label="复制代码" onClick={event => { const code = event.currentTarget.parentElement?.querySelector('code')?.textContent || ''; void navigator.clipboard.writeText(code).catch(onError); }}><Copy size={13} /></button><pre>{children}</pre></div>,
  }), [onError]);
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{text}</ReactMarkdown>;
});

function ExpandableText({ text, onError }: { text: string; onError: ErrorHandler }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const truncated = text.length > textPreviewLength && !expanded;
  return <div className="tool-text"><pre>{truncated ? text.slice(0, textPreviewLength) : text}</pre>{text.length > textPreviewLength && <div className="tool-text-controls"><span>{truncated ? `先显示 ${textPreviewLength.toLocaleString()} / ${text.length.toLocaleString()} 字符` : `已显示全部 ${text.length.toLocaleString()} 字符`}</span><button className="text-button tool-output-expand" onClick={() => setExpanded(value => !value)}>{expanded ? '收起长内容' : '显示全部'}</button><button className="text-button tool-output-copy" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(onError)}><Copy size={12} />{copied ? '已复制' : '复制完整内容'}</button></div>}</div>;
}

const ToolDetails = memo(function ToolDetails({ args, partialArgs, output, pending, onError }: { args?: RpcRecord; partialArgs?: string; output?: RpcRecord; pending: boolean; onError: ErrorHandler }) {
  const argsText = useMemo(() => args ? JSON.stringify(args, null, 2) : partialArgs || '', [args, partialArgs]);
  const outputText = useMemo(() => textContent(output) || (pending ? '等待工具输出…' : '已完成，无文本输出'), [output, pending]);
  return <div className="tool-detail">{argsText && <><span className="tiny-label">参数</span><ExpandableText text={argsText} onError={onError} /></>}<span className="tiny-label">输出</span><ExpandableText text={outputText} onError={onError} /></div>;
});

function ToolActivity({ live, output, expanded = false, onExpand }: { live: RpcRecord; output?: RpcRecord; expanded?: boolean; onExpand: () => void }) {
  const pending = live.status === 'running';
  const now = useClock(pending);
  const preview = useMemo(() => outputPreview(output), [output]);
  const quietMs = Math.max(0, now - (live.updatedAt ?? now));
  return <div className="tool-live-preview" aria-label={pending ? '工具实时输出' : '工具结果预览'}>
    <div className="tool-live-heading"><span>{pending ? '实时输出' : live.status === 'interrupted' ? '最后收到的输出' : '结果预览'}</span><button className="text-button" onClick={onExpand}>{expanded ? '收起详情' : '查看详情'}<ChevronRight size={12} /></button></div>
    {!expanded && (preview ? <pre>{preview}</pre> : <p>{pending ? '工具已开始，等待输出…' : live.status === 'interrupted' ? '未收到最终结果，执行状态无法确认。' : '已完成，无文本输出'}</p>)}
    {pending && quietMs >= 15_000 && <p className="tool-quiet">{formatDuration(quietMs)}没有新输出，仍在等待工具返回</p>}
  </div>;
}

function ToolDuration({ live }: { live: RpcRecord }) {
  const now = useClock(live.status === 'running');
  return live.startedAt !== undefined ? <span className="tool-duration">{formatDuration((live.endedAt ?? now) - live.startedAt)}</span> : null;
}

export const ToolCard = memo(function ToolCard({ call, result, live, preparing, onError }: { call: RpcRecord; result?: RpcRecord; live?: RpcRecord; preparing?: boolean; onError: ErrorHandler }) {
  const isError = Boolean(live?.isError ?? result?.isError);
  const [open, setOpen] = useState(isError);
  // Open a newly failed call once; later progress must respect the user's choice.
  useEffect(() => { if (isError) setOpen(true); }, [isError]);
  const pending = live?.status === 'running';
  const preparingCall = !live && !result && preparing;
  const unknown = !live && !result && !preparingCall;
  const interrupted = live?.status === 'interrupted';
  const args = call.arguments || live?.args;
  const summary = toolSummary(args);
  const output = result || live?.result;
  return <div className="tool-entry"><details className={`tool-card ${isError ? 'failed' : ''}`} data-tool-id={call.id} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="tool-icon">{call.name === 'bash' ? <Terminal size={15} /> : <FileText size={15} />}</span><strong>{call.name ? toolLabel(call.name) : '准备工具'}</strong><span className="tool-summary" title={summary}>{summary}</span>{live && <ToolDuration live={live} />}<span className={`tool-state ${isError ? 'error-text' : interrupted || unknown || preparingCall ? 'muted' : ''}`}>{pending || preparingCall ? <LoaderCircle size={13} className="spin" /> : isError || interrupted || unknown ? <TriangleAlert size={13} /> : <Check size={13} />}{pending ? '运行中' : preparingCall ? '准备中' : interrupted ? '已中断' : unknown ? '未记录结果' : isError ? '失败' : '完成'}</span><ChevronRight size={14} className="details-chevron" /></summary>{open && <><ToolDetails args={args} partialArgs={call._arguments} output={output ?? (interrupted || unknown ? { content: [{ type: 'text', text: '未收到最终结果，执行状态无法确认。' }] } : undefined)} pending={Boolean(pending || preparingCall)} onError={onError} />{live && pending && <ToolActivity live={live} output={output} expanded onExpand={() => setOpen(false)} />}</>}</details>{live && !open && <ToolActivity live={live} output={output} onExpand={() => setOpen(true)} />}</div>;
});

function LazyDetails({ summary, children }: { summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="thinking-block" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{summary}</summary>{open && children()}</details>;
}

interface MessageViewProps {
  message: RpcRecord;
  modelName: string;
  resultMap: Record<string, RpcRecord>;
  tools: Record<string, RpcRecord>;
  onError: ErrorHandler;
  onCopy: (text: string) => void;
}

export const MessageView = memo(function MessageView({ message, modelName, resultMap, tools, onError, onCopy }: MessageViewProps) {
  const copyText = useMemo(() => message.role === 'assistant' && !message._streaming ? textContent(message) : '', [message]);
  const bashCall = useMemo(() => ({ name: 'bash', arguments: { command: message.command } }), [message.command]);
  const bashResult = useMemo(() => ({ content: [{ type: 'text', text: message.output }], isError: message.exitCode !== 0 }), [message.output, message.exitCode]);
  return <article className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}>
    <div className="message-avatar">{message.role === 'user' ? <span>你</span> : <span className="pi-mark small" aria-hidden="true">π</span>}</div>
    <div className="message-body">
      <div className="message-heading"><strong>{message.role === 'user' ? '你' : message.role === 'bashExecution' ? '终端' : 'Pi'}</strong>{message.role === 'assistant' && <span>{modelName}</span>}{message.timestamp && <time>{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}</div>
      <div className="message-content">
        {typeof message.content === 'string' ? <Markdown text={message.content} onError={onError} /> : (message.content || []).map((part: RpcRecord, partIndex: number) => {
          if (part.type === 'text') return <Markdown key={partIndex} text={part.text || ''} onError={onError} />;
          if (part.type === 'thinking') return <LazyDetails key={partIndex} summary={<><Sparkles size={13} /><span>{message._streaming && !part._complete ? '思考中' : '思考过程'}</span><ChevronRight size={12} /></>}>{() => <div>{part.thinking}</div>}</LazyDetails>;
          if (part.type === 'toolCall') return <ToolCard key={partIndex} call={part} result={resultMap[part.id]} live={tools[part.id]} preparing={message._streaming} onError={onError} />;
          if (part.type === 'image') return <img key={partIndex} className="message-image" src={`data:${part.mimeType || 'image/png'};base64,${part.data}`} alt="用户提供的附件" />;
          return null;
        })}
        {message.role === 'bashExecution' && <ToolCard call={bashCall} result={bashResult} onError={onError} />}
        {message.role === 'compactionSummary' && <LazyDetails summary={<><ListFilter size={14} />上下文摘要<ChevronRight size={12} /></>}>{() => <div><Markdown text={message.summary || ''} onError={onError} /></div>}</LazyDetails>}
        {message.errorMessage && <p className="message-error"><TriangleAlert size={15} />{message.errorMessage}</p>}
        {message.stopReason === 'aborted' && <p className="muted small-text">本次回复已停止</p>}
      </div>
      {copyText && <div className="message-actions"><button onClick={() => onCopy(copyText)}><Copy size={13} />复制</button></div>}
    </div>
  </article>;
}, (previous, next) => {
  if (previous.message !== next.message || previous.modelName !== next.modelName || previous.onError !== next.onError || previous.onCopy !== next.onCopy) return false;
  if (previous.resultMap === next.resultMap && previous.tools === next.tools) return true;
  // Updates for unrelated tools must not reparse this message's Markdown.
  const content = previous.message.content;
  return !Array.isArray(content) || content.every((part: RpcRecord) => part.type !== 'toolCall' || (previous.resultMap[part.id] === next.resultMap[part.id] && previous.tools[part.id] === next.tools[part.id]));
});
