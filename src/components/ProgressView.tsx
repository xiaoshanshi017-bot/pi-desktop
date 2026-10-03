import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock3, LoaderCircle, Square, TriangleAlert } from 'lucide-react';
import { formatDuration, type RunProgress } from '../progress';
import { useClock } from '../useClock';

export function ProgressView({ progress, onStop }: { progress: RunProgress; onStop: () => void }) {
  const active = progress.endedAt === undefined;
  const now = useClock(active);
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  const stepsRef = useRef<HTMLOListElement>(null);
  const followSteps = useRef(true);
  useEffect(() => {
    if (expanded && followSteps.current && stepsRef.current) stepsRef.current.scrollTop = stepsRef.current.scrollHeight;
  }, [expanded, progress.steps]);
  const quietMs = Math.max(0, now - progress.updatedAt);
  const Icon = active ? LoaderCircle : progress.phase === 'complete' ? CheckCircle2 : TriangleAlert;
  return <section className={`run-progress ${active ? 'active' : 'finished'} ${expanded ? 'expanded' : ''}`} aria-label="任务进度" data-phase={progress.phase}>
    <div className="progress-heading">
      <span className="progress-current" role="status"><Icon size={14} className={active ? 'spin' : ''} /><strong>{progress.label}</strong></span>
      <span className="progress-current-detail" title={progress.detail}>{progress.detail}</span>
      {active && quietMs >= 15_000 && <span className="progress-quiet" title={`${formatDuration(quietMs)}没有新输出${progress.phase === 'tool' ? '，工具仍在执行' : '，正在等待 Pi'}`}>静默 {formatDuration(quietMs)}</span>}
      <span className="progress-elapsed" title="本轮耗时"><Clock3 size={12} />{formatDuration((progress.endedAt ?? now) - progress.startedAt)}</span>
      <button className="progress-toggle" aria-expanded={expanded} aria-controls={expanded ? stepsId : undefined} onClick={() => setExpanded(value => !value)}>执行记录<ChevronDown size={13} /></button>
      {active && progress.phase !== 'stopping' && <button className="progress-stop" aria-label="停止当前任务" title="停止当前任务" onClick={onStop}><Square size={11} /></button>}
    </div>
    {expanded && <div className="progress-expanded" id={stepsId}><div className="progress-detail" title={progress.detail}>{progress.detail}</div><div className="progress-meta"><span>已结束 {progress.completedTools} 次工具调用{progress.failedTools > 0 && ` · ${progress.failedTools} 次返回错误`}</span>{active && quietMs >= 15_000 && <span>{formatDuration(quietMs)}没有新输出{progress.phase === 'tool' ? '，工具仍在执行' : '，正在等待 Pi'}</span>}</div><ol className="progress-steps" ref={stepsRef} onScroll={event => { const list = event.currentTarget; followSteps.current = list.scrollHeight - list.scrollTop - list.clientHeight < 30; }}>{progress.steps.map(step => <li key={step.id} data-status={step.status}><span className="progress-step-dot" /><div><strong>{step.label}</strong>{step.detail && <span title={step.detail}>{step.detail}</span>}</div><span className="progress-step-state">{step.status === 'running' ? '进行中' : step.status === 'failed' ? '失败' : step.status === 'interrupted' ? '未确认结果' : '已结束'}</span><time>{formatDuration((step.endedAt ?? now) - step.startedAt)}</time></li>)}</ol></div>}
  </section>;
}
