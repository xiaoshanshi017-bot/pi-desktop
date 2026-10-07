import { LoaderCircle, Square, Undo2, Zap } from 'lucide-react';
import type { ConversationView } from '../workspace';

export function TaskRedirect({ request, onStop, onRecover, canRecover }: {
  request: ConversationView['redirect']; onStop: () => void; onRecover: () => void; canRecover: boolean;
}) {
  if (!request || request.status === 'submitted') return null;
  const pending = request.status === 'stopping' || request.status === 'submitting';
  const Icon = pending ? LoaderCircle : Zap;
  return <div className={pending ? 'redirect-pending' : 'redirect-result'} role="status" data-phase={request.status}>
    <Icon size={14} className={pending ? 'spin' : ''} />
    <div className="redirect-copy"><strong>{request.status === 'stopping' ? '正在停止当前执行' : request.status === 'submitting' ? '正在应用新要求' : request.status === 'cancelled' ? '调整已取消，新要求没有发送' : '新要求尚未送达'}</strong><p title={request.message}>{request.message}</p></div>
    {pending ? <button className="text-button" aria-label="取消本次调整" onClick={onStop}><Square size={12} />取消</button> : <button className="text-button" disabled={!canRecover} onClick={onRecover} title={canRecover ? '恢复刚才的要求和附件' : '要求已在输入框中，或输入框已有新草稿'}><Undo2 size={12} />恢复到输入框</button>}
  </div>;
}
