import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy, FileText, ImagePlus, ListFilter, LoaderCircle, Sparkles, Terminal, TriangleAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { RpcRecord } from '../../shared/types';
import { textContent } from '../conversation';

type ErrorHandler = (error: unknown) => void;
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
const toolNames: Record<string, string> = { read: '读取文件', write: '写入文件', edit: '编辑文件', bash: '执行命令', grep: '搜索内容', find: '查找文件', ls: '浏览目录' };
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

export const ToolCard = memo(function ToolCard({ call, result, live, onError }: { call: RpcRecord; result?: RpcRecord; live?: RpcRecord; onError: ErrorHandler }) {
  const isError = Boolean(live?.isError ?? result?.isError);
  const [open, setOpen] = useState(isError);
  // Open a newly failed call once; later progress must respect the user's choice.
  useEffect(() => { if (isError) setOpen(true); }, [isError]);
  const pending = live?.status !== 'done' && !result;
  const args = call.arguments || live?.args;
  const summary = args?.command || args?.path || args?.pattern || '';
  return <details className={`tool-card ${isError ? 'failed' : ''}`} data-tool-id={call.id} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="tool-icon">{call.name === 'bash' ? <Terminal size={15} /> : <FileText size={15} />}</span><strong>{toolNames[call.name] || call.name || '准备工具'}</strong><span className="tool-summary">{summary}</span><span className={`tool-state ${isError ? 'error-text' : ''}`}>{pending ? <LoaderCircle size={13} className="spin" /> : isError ? <TriangleAlert size={13} /> : <Check size={13} />}{pending ? '运行中' : isError ? '失败' : '完成'}</span><ChevronRight size={14} className="details-chevron" /></summary>{open && <ToolDetails args={args} partialArgs={call._arguments} output={live?.result || result} pending={pending} onError={onError} />}</details>;
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
  return <article className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}><div className="message-avatar">{message.role === 'user' ? <span>你</span> : <span className="pi-mark small" aria-hidden="true">π</span>}</div><div className="message-body"><div className="message-heading"><strong>{message.role === 'user' ? '你' : message.role === 'bashExecution' ? '终端' : 'Pi'}</strong>{message.role === 'assistant' && <span>{modelName}</span>}{message.timestamp && <time>{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}</div><div className="message-content">{typeof message.content === 'string' ? <Markdown text={message.content} onError={onError} /> : (message.content || []).map((part: RpcRecord, partIndex: number) => part.type === 'text' ? <Markdown key={partIndex} text={part.text || ''} onError={onError} /> : part.type === 'thinking' ? <LazyDetails key={partIndex} summary={<><Sparkles size={13} /><span>{message._streaming ? '思考中' : '思考过程'}</span><ChevronRight size={12} /></>}>{() => <div>{part.thinking}</div>}</LazyDetails> : part.type === 'toolCall' ? <ToolCard key={partIndex} call={part} result={resultMap[part.id]} live={tools[part.id]} onError={onError} /> : part.type === 'image' ? <img key={partIndex} className="message-image" src={`data:${part.mimeType || 'image/png'};base64,${part.data}`} alt="用户提供的附件" /> : null)}{message.role === 'bashExecution' && <ToolCard call={bashCall} result={bashResult} onError={onError} />}{message.role === 'compactionSummary' && <LazyDetails summary={<><ListFilter size={14} />上下文摘要<ChevronRight size={12} /></>}>{() => <div><Markdown text={message.summary || ''} onError={onError} /></div>}</LazyDetails>}{message.errorMessage && <p className="message-error"><TriangleAlert size={15} />{message.errorMessage}</p>}{message.stopReason === 'aborted' && <p className="muted small-text">本次回复已停止</p>}</div>{copyText && <div className="message-actions"><button onClick={() => onCopy(copyText)}><Copy size={13} />复制</button></div>}</div></article>;
}, (previous, next) => {
  if (previous.message !== next.message || previous.modelName !== next.modelName || previous.onError !== next.onError || previous.onCopy !== next.onCopy) return false;
  if (previous.resultMap === next.resultMap && previous.tools === next.tools) return true;
  // Updates for unrelated tools must not reparse this message's Markdown.
  const content = previous.message.content;
  return !Array.isArray(content) || content.every((part: RpcRecord) => part.type !== 'toolCall' || (previous.resultMap[part.id] === next.resultMap[part.id] && previous.tools[part.id] === next.tools[part.id]));
});
