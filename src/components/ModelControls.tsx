import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, Sparkles, X, Zap } from 'lucide-react';
import type { RpcRecord } from '../../shared/types';

const thinkingLabels: Record<string, string> = { off: '关闭思考', minimal: '极简思考', low: '轻度思考', medium: '标准思考', high: '深度思考', xhigh: '更深思考', max: '最大思考' };
const thinkingEnglish: Record<string, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
const thinkingDescriptions: Record<string, string> = {
  off: '直接生成回复，适合简单问答',
  minimal: '少量推理，优先快速响应',
  low: '轻量推理，适合明确的小任务',
  medium: '兼顾推理深度与响应速度',
  high: '更多推理，适合复杂分析与编码',
  xhigh: '进一步推敲，可能需要更长时间',
  max: '使用最高推理强度，耗时可能增加',
};
type Picker = 'model' | 'thinking';
type Position = { left: number; top: number; width: number; maxHeight: number };

interface ModelControlsProps {
  models: RpcRecord[];
  modelKey: string;
  model?: RpcRecord;
  levels: string[];
  thinkingLevel: string;
  disabled: boolean;
  ready: boolean;
  project: string;
  onModelChange: (key: string) => void;
  onThinkingChange: (level: string) => void;
}

export function ModelControls({ models, modelKey, model, levels, thinkingLevel, disabled, ready, project, onModelChange, onThinkingChange }: ModelControlsProps) {
  const [open, setOpen] = useState<Picker | null>(null);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState('');
  const [position, setPosition] = useState<Position | null>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const thinkingTrigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const thinkingList = useRef<HTMLDivElement>(null);
  const focusAfterSelection = useRef<HTMLButtonElement | null>(null);
  const id = useId().replace(/:/g, '');
  const modelListId = `model-list-${id}`;
  const thinkingListId = `thinking-list-${id}`;
  const groups = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const grouped = new Map<string, RpcRecord[]>();
    for (const item of models) {
      if (term && !`${item.name || ''} ${item.id} ${item.provider}`.toLocaleLowerCase().includes(term)) continue;
      const provider = item.provider || '未命名服务商';
      const entries = grouped.get(provider) || [];
      entries.push(item); grouped.set(provider, entries);
    }
    return [...grouped].map(([provider, entries]) => ({ provider, entries }));
  }, [models, query]);
  const flatModels = useMemo(() => groups.flatMap(group => group.entries), [groups]);
  const modelKeys = useMemo(() => flatModels.map(item => `${item.provider}/${item.id}`), [flatModels]);
  const allModelKeys = useMemo(() => [...new Set(models.map(item => item.provider))].flatMap(provider => models.filter(item => item.provider === provider).map(item => `${item.provider}/${item.id}`)), [models]);
  const keys = open === 'model' ? modelKeys : levels;
  const activeIndex = keys.indexOf(activeKey);
  const activeOptionId = activeIndex >= 0 ? `${open}-option-${id}-${activeIndex}` : undefined;
  const positioned = position !== null;
  const displayName = model?.name || model?.id || (ready ? '请选择模型' : '连接后选择模型');

  const close = useCallback((restoreFocus = false) => {
    if (restoreFocus) (open === 'model' ? modelTrigger : thinkingTrigger).current?.focus();
    setOpen(null); setPosition(null);
  }, [open]);

  const show = (picker: Picker, boundary?: 'first' | 'last', initialQuery = '') => {
    if (disabled) return;
    const options = picker === 'model' ? allModelKeys : levels;
    const selected = picker === 'model' ? modelKey : thinkingLevel;
    setQuery(initialQuery); setPosition(null); setOpen(picker);
    setActiveKey(boundary === 'first' ? options[0] || '' : boundary === 'last' ? options[options.length - 1] || '' : options.includes(selected) ? selected : options[0] || '');
  };

  const select = (key: string) => {
    if (disabled) return;
    const changed = open === 'model' ? key !== modelKey : key !== thinkingLevel;
    focusAfterSelection.current = changed ? (open === 'model' ? modelTrigger : thinkingTrigger).current : null;
    close(true);
    if (open === 'model' && key !== modelKey) onModelChange(key);
    if (open === 'thinking' && key !== thinkingLevel) onThinkingChange(key);
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') {
      // Restore the trigger before the browser performs its normal Tab movement.
      close(true); return;
    }
    if (!keys.length) return;
    let index = activeIndex;
    if (event.key === 'ArrowDown') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowUp') index = index < 0 ? keys.length - 1 : (index - 1 + keys.length) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else if (event.key === 'Enter') { event.preventDefault(); if (index >= 0) select(keys[index]); return; }
    else return;
    event.preventDefault(); setActiveKey(keys[index]);
  };

  const onTriggerKeyDown = (picker: Picker, event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      show(picker, event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
    } else if (picker === 'model' && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); show('model', undefined, event.key);
    }
  };

  useEffect(() => {
    if (disabled) { setOpen(null); setPosition(null); }
    else if (focusAfterSelection.current) {
      const target = focusAfterSelection.current;
      if (!document.activeElement || document.activeElement === document.body || document.activeElement === target) target.focus();
      focusAfterSelection.current = null;
    }
  }, [disabled]);
  useEffect(() => { setOpen(null); setPosition(null); focusAfterSelection.current = null; }, [project]);
  useEffect(() => {
    if (!open) return;
    if (!keys.includes(activeKey)) {
      const selected = open === 'model' ? modelKey : thinkingLevel;
      setActiveKey(keys.includes(selected) ? selected : keys[0] || '');
    }
  }, [open, keys, activeKey, modelKey, thinkingLevel]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = (open === 'model' ? modelTrigger : thinkingTrigger).current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const margin = 12, gap = 8;
      const width = Math.min(open === 'model' ? 370 : 276, window.innerWidth - margin * 2);
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const useAbove = below < 210 && above > below;
      const maxHeight = Math.max(100, Math.min(open === 'model' ? 480 : 490, useAbove ? above : below));
      const height = Math.min(panel.current?.getBoundingClientRect().height || maxHeight, maxHeight);
      const top = Math.max(margin, Math.min(useAbove ? rect.top - gap - height : rect.bottom + gap, window.innerHeight - height - margin));
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      setPosition({ top, left, width, maxHeight });
    };
    update();
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) update(); };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', scroll, true); };
  }, [open, query, flatModels.length]);

  useLayoutEffect(() => {
    if (!positioned) return;
    if (open === 'model') search.current?.focus();
    if (open === 'thinking') thinkingList.current?.focus();
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !modelTrigger.current?.contains(target) && !thinkingTrigger.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open, close]);

  useEffect(() => {
    if (open && activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeOptionId]);

  return <>
    <button id="model-select" ref={modelTrigger} className={`model-picker-trigger ${open === 'model' ? 'picker-open' : ''}`} type="button" aria-label={`选择模型：${displayName}`} aria-haspopup="listbox" aria-expanded={open === 'model'} aria-controls={open === 'model' ? modelListId : undefined} disabled={disabled} title={model ? `${displayName}\n${model.provider} / ${model.id}` : displayName} onClick={() => open === 'model' ? close(true) : show('model')} onKeyDown={event => onTriggerKeyDown('model', event)}><span className="model-spark"><Sparkles size={14} /></span><span className="model-picker-current-name">{displayName}</span>{model?.provider && <span className="model-provider-badge">{model.provider}</span>}<ChevronDown size={13} className="picker-chevron" /></button>
    <span className="toolbar-divider" />
    <button ref={thinkingTrigger} className={`thinking-picker-trigger ${open === 'thinking' ? 'picker-open' : ''}`} type="button" aria-label={`思考强度 Reasoning：${thinkingLabels[thinkingLevel] || thinkingLevel} ${thinkingEnglish[thinkingLevel] || thinkingLevel}`} aria-haspopup="listbox" aria-expanded={open === 'thinking'} aria-controls={open === 'thinking' ? thinkingListId : undefined} disabled={disabled} onClick={() => open === 'thinking' ? close(true) : show('thinking')} onKeyDown={event => onTriggerKeyDown('thinking', event)}><Zap size={14} /><span className="thinking-picker-current"><span>{thinkingLabels[thinkingLevel] || thinkingLevel}</span><small className="thinking-label-en">{thinkingEnglish[thinkingLevel] || thinkingLevel}</small></span><ChevronDown size={12} className="picker-chevron" /></button>
    {open && createPortal(<div ref={panel} className={`picker-panel ${open === 'model' ? 'model-picker-panel' : 'thinking-picker-panel'}`} style={position ? { ...position, visibility: 'visible' } : { visibility: 'hidden' }} onKeyDown={onMenuKeyDown}>
      {open === 'model' ? <>
        <div className="picker-panel-heading"><span>选择模型</span><small>{models.length} 个可用模型</small></div>
        <div className="model-picker-search-wrap"><Search size={15} /><input ref={search} className="model-picker-search" aria-label="搜索模型名称、ID 或服务商" role="combobox" aria-autocomplete="list" aria-controls={modelListId} aria-expanded="true" aria-activedescendant={activeOptionId} value={query} placeholder="搜索名称、ID 或服务商…" onChange={event => { setQuery(event.target.value); setActiveKey(''); }} />{query && <button className="model-picker-search-clear" aria-label="清空模型搜索" onClick={() => { setQuery(''); setActiveKey(modelKey); search.current?.focus(); }}><X size={13} /></button>}</div>
        <div id={modelListId} className="model-picker-list picker-options" role="listbox" aria-label="可用模型">{groups.map(group => <div className="model-picker-group" role="group" aria-label={group.provider} key={group.provider}><div className="model-picker-group-heading"><span>{group.provider}</span><small>{group.entries.length}</small></div>{group.entries.map(item => {
          const key = `${item.provider}/${item.id}`;
          const name = item.name || item.id;
          const selected = key === modelKey;
          return <button key={key} id={`model-option-${id}-${modelKeys.indexOf(key)}`} type="button" className={`model-picker-option picker-option ${activeKey === key ? 'keyboard-active' : ''} ${selected ? 'selected' : ''}`} data-model-key={key} role="option" aria-selected={selected} tabIndex={-1} onMouseMove={() => setActiveKey(key)} onClick={() => select(key)}><span className="model-option-icon"><Sparkles size={15} /></span><span className="model-option-text"><strong>{name}</strong>{item.id !== name && <small>{item.id}</small>}</span>{selected && <Check size={16} className="picker-selected-check" />}</button>;
        })}</div>)}{!flatModels.length && <div className="model-picker-empty"><Search size={23} /><strong>没有找到相关模型</strong><span>试试其他名称、ID 或服务商。</span></div>}</div>
        <div className="picker-keyboard-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 确认</span><span><kbd>Esc</kbd> 关闭</span></div>
      </> : <>
        <div className="picker-panel-heading thinking-picker-heading"><span>思考强度<small className="thinking-title-en">Reasoning</small></span><small>按任务复杂度调整</small></div>
        <div ref={thinkingList} id={thinkingListId} className="thinking-picker-list picker-options" role="listbox" aria-label="可用思考强度 Reasoning" aria-activedescendant={activeOptionId} tabIndex={-1}>{levels.map((level, index) => <button key={level} id={`thinking-option-${id}-${index}`} type="button" className={`thinking-picker-option picker-option ${activeKey === level ? 'keyboard-active' : ''} ${thinkingLevel === level ? 'selected' : ''}`} data-level={level} role="option" aria-label={`${thinkingLabels[level] || level} ${thinkingEnglish[level] || level}：${thinkingDescriptions[level] || '使用模型提供的此档思考强度'}`} aria-selected={thinkingLevel === level} tabIndex={-1} onMouseMove={() => setActiveKey(level)} onClick={() => select(level)}><span className={`thinking-option-icon ${level === 'off' ? 'thinking-off' : ''}`}><Zap size={16} /></span><span className="thinking-option-text"><strong><span>{thinkingLabels[level] || level}</span><span className="thinking-label-en">{thinkingEnglish[level] || level}</span></strong><small>{thinkingDescriptions[level] || '使用模型提供的此档思考强度'}</small></span>{thinkingLevel === level && <Check size={16} className="picker-selected-check" />}</button>)}</div>
        <div className="thinking-picker-note">可选档位由当前模型提供。</div>
      </>}
    </div>, document.body)}
  </>;
}
