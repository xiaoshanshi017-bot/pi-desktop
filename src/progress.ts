import type { RpcRecord } from '../shared/types';
import { textContent } from './conversation';

export const toolNames: Record<string, string> = { read: '读取文件', write: '写入文件', edit: '编辑文件', bash: '执行命令', grep: '搜索内容', find: '查找文件', ls: '浏览目录' };
export const toolLabel = (name: string) => toolNames[name] || name || '执行工具';
export const toolSummary = (args?: RpcRecord): string => args?.command || args?.path || args?.pattern || '';

export type ProgressPhase = 'thinking' | 'preparing' | 'responding' | 'tool' | 'waiting' | 'compacting' | 'retrying' | 'stopping' | 'complete' | 'error' | 'interrupted';
export interface ProgressStep {
  id: string;
  kind: 'stage' | 'tool';
  label: string;
  detail: string;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  startedAt: number;
  endedAt?: number;
}
export interface RunProgress {
  phase: ProgressPhase;
  label: string;
  detail: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  steps: ProgressStep[];
  sequence: number;
  activeTools: Record<string, { name: string; detail: string }>;
  completedTools: number;
  failedTools: number;
  stopRequested?: boolean;
  assistantError?: string;
  aborted?: boolean;
}

const finishStages = (steps: ProgressStep[], now: number) => steps.map(step => step.kind === 'stage' && step.status === 'running' ? { ...step, status: 'done' as const, endedAt: now } : step);

function stage(progress: RunProgress, phase: ProgressPhase, label: string, detail: string, now: number): RunProgress {
  if (progress.stopRequested && phase !== 'stopping') return progress;
  if (progress.phase === phase && progress.label === label) return { ...progress, detail, updatedAt: now };
  const sequence = progress.sequence + 1;
  return { ...progress, phase, label, detail, updatedAt: now, sequence, steps: [...finishStages(progress.steps, now), { id: `stage-${sequence}`, kind: 'stage' as const, label, detail, status: 'running' as const, startedAt: now }].slice(-40) };
}

function start(now: number): RunProgress {
  return { phase: 'thinking', label: '正在分析请求', detail: '等待 Pi 返回进展或工具调用', startedAt: now, updatedAt: now, steps: [{ id: 'stage-0', kind: 'stage', label: '正在分析请求', detail: '', status: 'running', startedAt: now }], sequence: 0, activeTools: {}, completedTools: 0, failedTools: 0 };
}

function finish(progress: RunProgress, phase: 'complete' | 'error' | 'interrupted', detail: string, now: number): RunProgress {
  const label = phase === 'complete' ? '本轮已结束' : phase === 'error' ? '本轮出错' : '本轮已停止';
  // A missing tool result is never evidence of success.
  const steps = finishStages(progress.steps, now).map(step => step.status === 'running' ? { ...step, status: 'interrupted' as const, endedAt: now } : step);
  return { ...progress, phase, label, detail, updatedAt: now, endedAt: now, activeTools: {}, steps };
}

/** Progress is derived only from observed events, never from hidden reasoning or a guessed percentage. */
export function applyProgressEvent(previous: RunProgress | null, event: RpcRecord, now = Date.now()): RunProgress | null {
  if (event.type === 'prompt_submitted' || event.type === 'agent_start') return previous && previous.endedAt === undefined ? previous : start(now);
  if ((!previous || previous.endedAt !== undefined) && ['compaction_start', 'auto_compaction_start'].includes(event.type)) previous = start(now);
  if (!previous || previous.endedAt !== undefined) return previous;
  let progress = previous;
  if (event.type === 'connection_status' && ['error', 'disconnected'].includes(event.status)) return finish(progress, 'interrupted', 'Pi 连接已断开，未返回的工具结果无法确认。', now);
  if (event.type === 'prompt_error') return finish(progress, 'error', event.message || '请求未能送达 Pi', now);
  if (event.type === 'stop_requested') return { ...stage(progress, 'stopping', '正在停止任务', '等待当前操作中止并保存会话', now), stopRequested: true };
  if (event.type === 'stop_failed') {
    const active = Object.values(progress.activeTools).at(-1);
    return stage({ ...progress, stopRequested: false }, active ? 'tool' : 'waiting', active ? toolLabel(active.name) : '等待 Pi 继续', active?.detail || '停止请求失败，当前任务仍在运行', now);
  }
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    progress = { ...progress, assistantError: undefined };
    return Object.keys(progress.activeTools).length ? progress : stage(progress, 'thinking', '正在分析下一步', '等待 Pi 返回进展或工具调用', now);
  }
  if (event.type === 'message_update' && !Object.keys(progress.activeTools).length) {
    const type = event.assistantMessageEvent?.type || '';
    if (/^thinking_(start|delta)$/.test(type)) return stage(progress, 'thinking', '正在思考', 'Pi 正在分析，尚未返回新的操作说明', now);
    if (/^text_(start|delta)$/.test(type)) return stage(progress, 'responding', '正在输出说明', '进展与回复正在显示到会话中', now);
    if (/^toolcall_(start|delta)$/.test(type)) return stage(progress, 'preparing', '正在准备工具调用', '正在生成工具参数，尚未开始执行', now);
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') return { ...progress, assistantError: event.message.errorMessage, aborted: progress.aborted || event.message.stopReason === 'aborted', updatedAt: now };
  if (event.type === 'tool_execution_start') {
    const id = event.toolCallId;
    if (!id) return progress;
    const label = toolLabel(event.toolName);
    const detail = toolSummary(event.args);
    const activeTools = { ...progress.activeTools, [id]: { name: event.toolName, detail } };
    const steps = progress.steps.some(step => step.id === id) ? progress.steps : [...finishStages(progress.steps, now), { id, kind: 'tool' as const, label, detail, status: 'running' as const, startedAt: now }].slice(-40);
    return { ...progress, activeTools, steps, updatedAt: now, ...(progress.stopRequested ? {} : { phase: 'tool', label, detail }) };
  }
  if (event.type === 'tool_execution_update') return { ...progress, updatedAt: now };
  if (event.type === 'tool_execution_end') {
    const id = event.toolCallId;
    const wasActive = Boolean(progress.activeTools[id]);
    const activeTools = { ...progress.activeTools };
    delete activeTools[id];
    const steps = progress.steps.map(step => step.id === id ? { ...step, status: event.isError ? 'failed' as const : 'done' as const, endedAt: now } : step);
    progress = { ...progress, activeTools, steps, updatedAt: now, completedTools: progress.completedTools + (wasActive ? 1 : 0), failedTools: progress.failedTools + (wasActive && event.isError ? 1 : 0) };
    const active = Object.values(activeTools).at(-1);
    if (progress.stopRequested) return progress;
    if (active) return { ...progress, phase: 'tool', label: toolLabel(active.name), detail: active.detail };
    return stage(progress, 'waiting', '等待 Pi 继续', event.isError ? '工具返回错误，等待 Pi 处理结果' : '工具结果已返回，等待下一步操作或回复', now);
  }
  if (['compaction_start', 'auto_compaction_start'].includes(event.type)) return stage(progress, 'compacting', '正在压缩上下文', '整理历史消息，保留后续任务所需信息', now);
  if (['compaction_end', 'auto_compaction_end'].includes(event.type)) return stage(progress, 'waiting', '等待 Pi 继续', event.errorMessage || '上下文整理结束', now);
  if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') return stage(progress, 'retrying', '正在等待重试', `第 ${event.attempt ?? '?'} / ${event.maxAttempts ?? '?'} 次${event.delayMs ? `，约 ${Math.ceil(event.delayMs / 1000)} 秒后重试` : ''}`, now);
  if (event.type === 'auto_retry_end' && event.finalError) return { ...progress, assistantError: event.finalError, updatedAt: now };
  if (event.type === 'agent_settled' || event.type === 'manual_compaction_end') {
    const phase = progress.stopRequested || progress.aborted || Object.keys(progress.activeTools).length ? 'interrupted' : progress.assistantError ? 'error' : 'complete';
    return finish(progress, phase, progress.assistantError || (phase === 'interrupted' ? '当前操作已结束，未返回的工具结果无法确认。' : '本轮执行记录已保留，可继续发送消息'), now);
  }
  return progress;
}

export function applyToolEvent(tools: Record<string, RpcRecord>, event: RpcRecord, now = Date.now()): Record<string, RpcRecord> {
  const id = event.toolCallId;
  if (!id || !event.type.startsWith('tool_execution_')) return tools;
  const previous = tools[id];
  const done = event.type === 'tool_execution_end';
  if (!done && previous?.endedAt !== undefined) return tools;
  return { ...tools, [id]: { ...previous, ...event, result: event.result ?? event.partialResult ?? previous?.result, status: done ? 'done' : 'running', startedAt: previous?.startedAt ?? now, updatedAt: now, ...(done ? { endedAt: now } : {}) } };
}

export function interruptTools(tools: Record<string, RpcRecord>, now = Date.now()): Record<string, RpcRecord> {
  return Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, tool.status === 'running' ? { ...tool, status: 'interrupted', endedAt: now } : tool]));
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分`;
}

export function outputPreview(output?: RpcRecord): string {
  // Bound work and display size even when a tool produces a very large result.
  return textContent(output).slice(-2400).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd().split(/\r\n|\n|\r/).slice(-5).join('\n');
}
