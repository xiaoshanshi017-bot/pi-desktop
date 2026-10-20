import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Download, LoaderCircle, Search, TriangleAlert, X } from 'lucide-react';
import { errorText } from '../conversation';
import './ModelImport.css';

export interface ModelPreviewInput {
  url: string;
  apiKey?: string;
  provider?: string;
}

export interface ModelImportPreview {
  token: string;
  baseUrl: string;
  provider: string;
  models: { id: string; name?: string; exists?: boolean }[];
  providerExists?: boolean;
  conflicts?: ('baseUrl' | 'apiKey' | 'api')[];
  suggestedProvider?: string;
  expiresAt?: number;
}

export interface ModelImportInput {
  token: string;
  modelIds: string[];
  provider: string;
  updateExisting?: boolean;
}

export interface ModelImportResult {
  added: number;
  skipped: number;
  provider: string;
  summary?: unknown;
  source?: string;
  updated?: boolean;
  changedFields?: string[];
}

export interface ModelImportDraft { url: string; provider: string }
export interface ModelImportState { busy: boolean; hasPending: boolean; selectedCount: number; hasPreview: boolean }
export type ModelImportSaveResult = { status: 'saved'; result: ModelImportResult } | { status: 'unchanged' } | { status: 'needs-selection' };
export interface ModelImportHandle { savePending(): Promise<ModelImportSaveResult> }

export interface ModelImportProps {
  onPreview: (input: ModelPreviewInput) => Promise<ModelImportPreview>;
  onImport: (input: ModelImportInput) => Promise<ModelImportResult>;
  onImported?: (result: ModelImportResult) => void;
  onDiscard?: (token: string) => void | Promise<void>;
  onStateChange?: (state: ModelImportState) => void;
  initialDraft?: ModelImportDraft;
  onDraftChange?: (draft: ModelImportDraft) => void;
  disabled?: boolean;
}

export const ModelImport = forwardRef<ModelImportHandle, ModelImportProps>(function ModelImport({ onPreview, onImport, onImported, onDiscard, onStateChange, initialDraft, onDraftChange, disabled = false }, ref) {
  const [url, setUrl] = useState(initialDraft?.url || '');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState(initialDraft?.provider || '');
  const [preview, setPreview] = useState<ModelImportPreview | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [operation, setOperation] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [result, setResult] = useState<ModelImportResult | null>(null);
  const [dirty, setDirty] = useState(Boolean(initialDraft?.url || initialDraft?.provider));
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const importing = useRef(false);
  const previewToken = useRef<string | null>(null);
  const saving = useRef<Promise<ModelImportSaveResult> | null>(null);
  const discardRef = useRef(onDiscard);
  discardRef.current = onDiscard;
  const stateCallback = useRef(onStateChange);
  stateCallback.current = onStateChange;
  const draftCallback = useRef(onDraftChange);
  draftCallback.current = onDraftChange;
  const selectAll = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const previewPanel = useRef<HTMLDivElement>(null);
  const id = useId();
  const locked = disabled || operation !== null;
  const models = useMemo(() => [...new Map(preview?.models.map(model => [model.id, model]) || []).values()], [preview]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return models.filter(model => `${model.id} ${model.name || ''}`.toLocaleLowerCase().includes(term));
  }, [models, query]);
  const available = filtered.filter(model => !model.exists);
  const visibleSelected = available.filter(model => selected.has(model.id)).length;
  const allSelected = available.length > 0 && visibleSelected === available.length;
  const existingCount = models.filter(model => model.exists).length;
  const conflicts = preview?.conflicts || [];
  const protocolConflict = conflicts.includes('api');
  const canUpdate = Boolean(preview?.providerExists && !protocolConflict);
  const updating = canUpdate && updateExisting;
  const hasPending = dirty || selected.size > 0 || updateExisting;
  const busy = operation !== null;
  const hasPreview = preview !== null;

  const discard = (token: string) => {
    try { void Promise.resolve(discardRef.current?.(token)).catch(() => {}); } catch { /* The backend also expires unused previews. */ }
  };

  const discardCurrent = () => {
    const token = previewToken.current;
    previewToken.current = null;
    if (token) discard(token);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!importing.current) discardCurrent();
    };
  }, []);

  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = visibleSelected > 0 && !allSelected;
  }, [visibleSelected, allSelected]);

  useEffect(() => {
    stateCallback.current?.({ busy, hasPending, selectedCount: selected.size, hasPreview });
  }, [busy, hasPending, selected.size, hasPreview]);

  useEffect(() => {
    if (!error && !info && !result) return;
    const frame = requestAnimationFrame(() => {
      feedback.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      feedback.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [error, info, result, feedbackVersion]);

  const rememberDraft = (nextUrl: string, nextProvider: string) => {
    draftCallback.current?.({ url: nextUrl, provider: nextProvider });
  };

  const resetPreview = (resetSelection = false) => {
    discardCurrent();
    setPreview(null); if (resetSelection) setSelected(new Set());
    setUpdateExisting(false); setNeedsRefresh(false); setQuery(''); setError(''); setInfo(''); setResult(null); setDirty(true);
  };

  const readableError = (reason: unknown, fallback: string) => {
    let message = errorText(reason);
    for (const secret of [apiKey.trim(), preview?.token]) {
      if (secret) message = message.split(secret).join('••••');
    }
    return message ? `${fallback}：${message}` : `${fallback}，请重试。`;
  };

  const loadPreview = async (keep: Set<string>, keepUpdate = false, nextProvider = provider) => {
    if (!url.trim()) throw new Error('请先填写 API 地址。');
    if (nextProvider.trim() && !/^[a-zA-Z0-9\u4e00-\u9fff._-]{1,64}$/.test(nextProvider.trim())) throw new Error('服务商 ID 请使用 1–64 个中文、英文字母、数字、点、横线或下划线。');
    discardCurrent(); setOperation('preview'); setNeedsRefresh(true); setResult(null); setError(''); setInfo('');
    const value = await onPreview({ url: url.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(nextProvider.trim() ? { provider: nextProvider.trim() } : {}) });
    if (!mounted.current) { discard(value.token); throw new Error('设置已关闭，模型尚未保存。'); }
    const ids = new Set(value.models.filter(model => !model.exists && keep.has(model.id)).map(model => model.id));
    const keepConsent = Boolean(keepUpdate && value.providerExists && !value.conflicts?.includes('api'));
    previewToken.current = value.token;
    setPreview(value); setSelected(ids); setProvider(value.provider); setUpdateExisting(keepConsent); setNeedsRefresh(false); setDirty(true);
    requestAnimationFrame(() => {
      const panel = previewPanel.current;
      (panel?.querySelector<HTMLElement>('.model-import-service') || panel?.querySelector<HTMLElement>('.model-import-summary'))?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
    return { value, ids, update: keepConsent };
  };

  const fetchModels = async (event?: FormEvent, nextProvider = provider) => {
    event?.preventDefault();
    if (disabled || pending.current) return;
    pending.current = true;
    try {
      await loadPreview(selected, nextProvider === provider && updateExisting, nextProvider);
    } catch (reason) {
      if (mounted.current) { setError(readableError(reason, '获取模型失败')); setFeedbackVersion(value => value + 1); }
    } finally {
      pending.current = false;
      if (mounted.current) setOperation(null);
    }
  };

  const needsSelection = (value: ModelImportPreview): ModelImportSaveResult => {
    setInfo(value.models.length === 0 ? '服务商未返回模型，请检查 API 地址或向服务商确认模型列表。' : value.models.every(model => model.exists) ? '这些模型已经保存在该服务中。若需更换地址或 Key，请勾选“更新此服务的 API 地址和 Key”。' : '模型列表已就绪。请先勾选需要保存的模型，再点击“保存所选模型”。');
    setFeedbackVersion(value => value + 1);
    return { status: 'needs-selection' };
  };

  const save = async (): Promise<ModelImportSaveResult> => {
    if (!hasPending) return { status: 'unchanged' };
    if (pending.current) throw new Error('模型配置正在处理，请稍候再保存。');
    pending.current = true; importing.current = true; setError(''); setInfo(''); setResult(null);
    try {
      if (disabled) throw new Error('连接桌面应用后才能保存模型。');
      let value = preview;
      let ids = new Set(selected);
      let consent = updateExisting;
      let refreshed = false;
      if (!value || needsRefresh || (value.expiresAt !== undefined && value.expiresAt <= Date.now())) {
        const loaded = await loadPreview(ids, consent);
        value = loaded.value; ids = loaded.ids; consent = loaded.update; refreshed = true;
      }
      let imported: ModelImportResult;
      while (true) {
        if (value.conflicts?.includes('api')) throw new Error('此服务商 ID 已使用另一种 API 协议，无法更新。请更换服务商 ID 后重新获取模型。');
        if (value.conflicts?.length && !consent) throw new Error('此服务已配置其他 API 地址或 Key。请勾选“更新此服务的 API 地址和 Key”，或使用新的服务商 ID。');
        const modelIds = value.models.filter(model => !model.exists && ids.has(model.id)).map(model => model.id);
        const update = Boolean(consent && value.providerExists);
        if (!modelIds.length && !update) return needsSelection(value);
        setOperation('import');
        try {
          imported = await onImport({ token: value.token, modelIds, provider: value.provider, ...(update ? { updateExisting: true } : {}) });
          break;
        } catch (reason) {
          if (refreshed || !/模型预览已失效|预览.*过期/.test(errorText(reason))) throw reason;
          const loaded = await loadPreview(ids, consent);
          value = loaded.value; ids = loaded.ids; consent = loaded.update; refreshed = true;
        }
      }
      previewToken.current = null;
      if (mounted.current) {
        setApiKey(''); setPreview(null); setSelected(new Set()); setUpdateExisting(false); setNeedsRefresh(false); setQuery(''); setDirty(false); setResult(imported);
      }
      // The disk write still matters if Settings was closed while saving.
      try { onImported?.(imported); } catch { /* A refresh callback cannot undo the completed disk write. */ }
      return { status: 'saved', result: imported };
    } catch (reason) {
      const message = readableError(reason, '保存模型失败');
      if (mounted.current) { setError(message); setFeedbackVersion(value => value + 1); }
      throw new Error(message);
    } finally {
      pending.current = false;
      importing.current = false;
      if (!mounted.current) discardCurrent();
      if (mounted.current) setOperation(null);
    }
  };

  const savePending = () => {
    if (saving.current) return saving.current;
    const promise = save();
    saving.current = promise;
    void promise.then(() => { if (saving.current === promise) saving.current = null; }, () => { if (saving.current === promise) saving.current = null; });
    return promise;
  };

  useImperativeHandle(ref, () => ({ savePending }));

  const useSuggestedProvider = () => {
    if (!preview || locked) return;
    const suggested = preview.suggestedProvider && preview.suggestedProvider !== preview.provider ? preview.suggestedProvider : `${preview.provider.slice(0, 59)}-new`;
    setProvider(suggested); resetPreview(); rememberDraft(url, suggested);
    void fetchModels(undefined, suggested);
  };

  return <section className="settings-section model-import" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>通过 API 地址添加模型</h3>
    <p>填写兼容 OpenAI 的 API 地址和 Key，获取列表、勾选模型，然后保存到本机 Pi 配置。</p>
    <form className="model-import-form" onSubmit={event => void fetchModels(event)} autoComplete="off">
      <label className="form-label" htmlFor={`${id}-url`}>API 地址<input className="form-input" id={`${id}-url`} name="model-api-url" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://api.example.com/v1" value={url} disabled={locked} required onChange={event => { setUrl(event.target.value); resetPreview(true); rememberDraft(event.target.value, provider); }} /></label>
      <label className="form-label" htmlFor={`${id}-key`}>API Key <span className="model-import-optional">可选</span><input className="form-input" id={`${id}-key`} name="model-api-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="需要密钥的服务请填写" value={apiKey} disabled={locked} onChange={event => { setApiKey(event.target.value); resetPreview(); rememberDraft(url, provider); }} /></label>
      <label className="form-label" htmlFor={`${id}-provider`}>服务商 ID <span className="model-import-optional">可选</span><input className="form-input" id={`${id}-provider`} name="model-api-provider" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="留空时根据 API 地址自动生成" value={provider} maxLength={64} disabled={locked} onChange={event => { setProvider(event.target.value); resetPreview(); rememberDraft(url, event.target.value); }} /><small className="model-import-field-help">支持中文、英文字母、数字、点、横线或下划线（1–64 个字符）。</small></label>
      <div className="model-import-fetch"><span>获取列表后还需勾选并保存。更换已有服务的地址或 Key 时，需要明确确认更新。</span><button className="button secondary" type="submit" disabled={locked || !url.trim()}>{operation === 'preview' ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{operation === 'preview' ? '正在获取…' : needsRefresh && preview ? '重新获取并保留选择' : '获取模型'}</button></div>
    </form>
    {operation === 'preview' && <div className="model-import-loading" role="status"><LoaderCircle size={16} className="spin" /><span>正在连接服务商，获取可选模型…</span></div>}
    {(error || info) && <div ref={feedback} tabIndex={-1} className={`model-import-feedback ${error ? 'model-import-error' : 'model-import-info'}`} role={error ? 'alert' : 'status'}><TriangleAlert size={15} /><span>{error || info}</span></div>}
    {preview && <div ref={previewPanel} className="model-import-preview" aria-busy={operation !== null}>
      <div className="model-import-summary"><span><strong>{preview.provider}</strong><small>{preview.baseUrl}</small></span><span className="model-import-count">{models.length} 个模型{existingCount ? ` · ${existingCount} 个已添加` : ''}</span></div>
      {preview.providerExists && <div className={`model-import-service${conflicts.length ? ' conflict' : ''}`} role="group" aria-label="已有服务设置">
        {protocolConflict ? <p>此服务商 ID 使用另一种 API 协议，不能更新。请使用新的服务商 ID，原配置会保留。</p> : <><p>{conflicts.length ? `此服务已存在，${conflicts.includes('baseUrl') ? 'API 地址' : ''}${conflicts.includes('baseUrl') && conflicts.includes('apiKey') ? '和' : ''}${conflicts.includes('apiKey') ? 'Key' : ''}与本次输入不同。` : '此服务已存在。可继续添加模型，也可更新该服务的连接设置。'}</p><label className="model-import-update"><input type="checkbox" name="model-update-existing" checked={updateExisting} disabled={locked} onChange={event => { setUpdateExisting(event.target.checked); setDirty(true); setError(''); setInfo(''); rememberDraft(url, provider); }} /><span>更新此服务的 API 地址和 Key</span></label><small>勾选后更新此服务的连接设置，保留已有模型；不勾选时可换一个服务商 ID 单独保存。</small></>}
        {conflicts.length > 0 && <button className="text-button model-import-new-provider" type="button" disabled={locked} onClick={useSuggestedProvider}>使用新的服务商 ID 并重新获取</button>}
      </div>}
      {models.length > 0 ? <>
        <div className="model-import-search"><Search size={15} /><input id={`${id}-search`} aria-label="搜索 API 模型" type="search" placeholder="搜索模型名称或 ID…" value={query} disabled={locked} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清空模型搜索" title="清空模型搜索" disabled={locked} onClick={() => setQuery('')}><X size={14} /></button>}</div>
        <div className="model-import-selection"><label><input ref={selectAll} type="checkbox" checked={allSelected} disabled={locked || !available.length || protocolConflict} onChange={event => { const checked = event.target.checked; setDirty(true); setResult(null); setSelected(previous => { const next = new Set(previous); for (const model of available) { if (checked) next.add(model.id); else next.delete(model.id); } return next; }); }} /><span>{query.trim() ? '全选搜索结果' : '全选可添加模型'}</span></label><span aria-live="polite">已选 {selected.size} 个</span></div>
        <div className="model-import-list" role="group" aria-label="API 模型列表">{filtered.map(model => <label className={`model-import-model${model.exists ? ' existing' : ''}`} key={model.id}><input type="checkbox" aria-label={`添加模型 ${model.id}`} checked={selected.has(model.id)} disabled={locked || model.exists || protocolConflict} onChange={event => { const checked = event.target.checked; setDirty(true); setResult(null); setSelected(previous => { const next = new Set(previous); if (checked) next.add(model.id); else next.delete(model.id); return next; }); }} /><span className="model-import-model-text"><strong>{model.name || model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}</span>{model.exists && <span className="model-import-existing">已添加</span>}</label>)}{!filtered.length && <div className="model-import-empty">没有找到匹配的模型，试试其他关键词。</div>}</div>
      </> : <div className="model-import-empty">服务商未返回模型。请检查 API 地址，或向服务商确认是否支持模型列表。</div>}
      <div className="model-import-actions"><span>{updating ? '将保存服务设置，并添加本次勾选的模型。' : existingCount === models.length && models.length > 0 ? '已有模型会保留；只更新地址或 Key 也可保存。' : '只保存本次勾选的模型，已有模型会保留。'}</span><button className="button primary" type="button" disabled={locked || protocolConflict || (!selected.size && !updating)} onClick={() => void savePending().catch(() => {})}>{operation === 'import' ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{operation === 'import' ? '正在保存…' : updating && !selected.size ? '保存服务设置' : `保存所选模型${selected.size ? `（${selected.size}）` : ''}`}</button></div>
    </div>}
    {result && <div ref={feedback} tabIndex={-1} className="model-import-feedback model-import-success" role="status"><CheckCircle2 size={16} /><span><strong>已保存到 Pi 模型配置。</strong><small>服务商：{result.provider} · 新增 {result.added} 个模型{result.skipped ? ` · 跳过 ${result.skipped} 个已有模型` : ''}{result.updated ? ' · 已更新服务设置' : ''}</small>{result.source && <code>{result.source}</code>}<small>新会话可直接使用；当前会话空闲时可刷新模型，正在运行的任务会继续执行。</small></span></div>}
  </section>;
});
