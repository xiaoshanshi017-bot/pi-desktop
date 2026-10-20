import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { LoaderCircle, TriangleAlert, X, Zap } from 'lucide-react';
import type { RpcRecord } from '../../shared/types';
import { errorText } from '../conversation';
import './ModelReasoning.css';

export interface ModelReasoningValue { reasoning: boolean; supportsReasoningEffort: boolean }
export interface ModelReasoningProps {
  model: RpcRecord;
  onSave: (value: ModelReasoningValue) => Promise<void>;
  onClose: () => void;
  disabled?: boolean;
}

export function ModelReasoning({ model, onSave, onClose, disabled = false }: ModelReasoningProps) {
  const [reasoning, setReasoning] = useState(model.reasoning === true);
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(model.supportsReasoningEffort !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  const dialog = useRef<HTMLFormElement>(null);
  const enable = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const id = useId();
  const locked = disabled || busy;

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    const keepFocus = (event: FocusEvent) => {
      const panels = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (panels[panels.length - 1] !== dialog.current || dialog.current?.contains(event.target as Node)) return;
      const first = dialog.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)');
      (first || dialog.current)?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    enable.current?.focus();
    return () => {
      mounted.current = false;
      document.removeEventListener('focusin', keepFocus);
      if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled')) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    feedback.current?.focus();
    feedback.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!locked) onClose();
    }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])];
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true); setError('');
    try {
      await onSave({ reasoning, supportsReasoningEffort });
      if (mounted.current) onClose();
    } catch (failure) {
      if (mounted.current) setError(errorText(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <div className="modal-backdrop model-reasoning-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !locked) onClose(); }}>
    <form ref={dialog} className="modal model-reasoning-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1} onSubmit={event => void save(event)} onKeyDown={onKeyDown}>
      <header><h2 id={`${id}-title`}><Zap size={17} />配置思考能力</h2><button type="button" className="icon-button" aria-label="关闭思考能力设置" disabled={locked} onClick={onClose}><X size={17} /></button></header>
      <div className="modal-body">
        <div className="model-reasoning-model"><strong>{model.name || model.id}</strong><small>{model.provider} / {model.id}</small></div>
        <p id={`${id}-description`} className="model-reasoning-description">模型列表可能没有提供思考能力信息。请按服务商说明设置，无需重新填写 API Key。</p>
        <label className="model-reasoning-option" htmlFor={`${id}-enable`}><input ref={enable} id={`${id}-enable`} data-testid="model-reasoning-enabled" type="checkbox" checked={reasoning} disabled={locked} onChange={event => setReasoning(event.target.checked)} /><span><strong>启用思考</strong><small>仅在模型支持推理时启用。</small></span></label>
        <label className={`model-reasoning-option model-reasoning-effort ${!reasoning ? 'inactive' : ''}`} htmlFor={`${id}-effort`}><input id={`${id}-effort`} data-testid="model-reasoning-effort" type="checkbox" checked={supportsReasoningEffort} disabled={locked || !reasoning} onChange={event => setSupportsReasoningEffort(event.target.checked)} /><span><strong>允许调整思考强度</strong><small>服务需要支持 reasoning_effort 参数；取消后由服务端控制。</small></span></label>
        <p className="model-reasoning-note">思考档位控制推理投入，实际速度由服务商和模型决定。</p>
        {error && <div ref={feedback} className="model-reasoning-error" role="alert" tabIndex={-1}><TriangleAlert size={16} /><span>{error}</span></div>}
      </div>
      <footer className="modal-actions"><button className="button" type="button" disabled={locked} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={locked}>{busy && <LoaderCircle size={14} className="spin" />}{busy ? '正在保存…' : '保存思考设置'}</button></footer>
    </form>
  </div>;
}
