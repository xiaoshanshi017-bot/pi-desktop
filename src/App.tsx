import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Code2, FileText, Folder, FolderOpen, GitBranch, Info, ListFilter, LoaderCircle, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Paperclip, Pencil, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, Square, Sun, Terminal, TriangleAlert, X, Zap } from 'lucide-react';
import { MessageView } from './components/MessageView';
import { ModelControls } from './components/ModelControls';
import { ProjectAttribution } from './components/ProjectAttribution';
import type { Bootstrap, Connection, Diagnostics, FileAttachment, Preferences, ProjectMigrationPreview, RpcRecord, SessionInfo } from '../shared/types';
import { applyMessageEvent, basename, compactNumber, errorText, textContent } from './conversation';

const thinkingNames: Record<string, string> = { off: '关闭思考', minimal: '极简思考', low: '轻度思考', medium: '标准思考', high: '深度思考', xhigh: '更深思考', max: '最大思考' };
const starters = [
  { icon: Code2, title: '了解这个项目', description: '梳理结构与运行方式', prompt: '请先阅读这个项目，介绍它的结构、主要功能和本地运行方式。' },
  { icon: Search, title: '一起排查问题', description: '定位原因，验证修复', prompt: '帮我排查这个项目中的问题。先了解项目结构，然后我们一起定位具体问题。' },
  { icon: Sparkles, title: '实现一个想法', description: '把需求变成可用的功能', prompt: '我想为这个项目新增一个功能。请先阅读现有代码，了解项目的技术栈和约定。' },
];
const emptyPreferences: Preferences = { projects: [], theme: 'light' };
type Notice = { text: string; kind: 'error' | 'info' | 'success' };

function PiMark({ small = false }: { small?: boolean }) {
  return <span className={`pi-mark ${small ? 'small' : ''}`} aria-hidden="true">π</span>;
}
function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className="icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}
function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      if (!panel.current || panel.current.contains(document.activeElement)) return;
      const visible = (elements: NodeListOf<HTMLElement>) => [...elements].find(element => element.getClientRects().length > 0);
      const field = visible(panel.current.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)'));
      (field || visible(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), summary')))?.focus();
    }, 30);
    const key = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab' && panel.current) {
        const nodes = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'wide' : ''}`} ref={panel} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></header>{children}</div></div>;
}
function ExtensionDialog({ request, respond }: { request: RpcRecord; respond: (response: RpcRecord) => void }) {
  const [value, setValue] = useState(request.prefill || '');
  const close = useCallback(() => respond({ cancelled: true }), [respond]);
  useEffect(() => {
    if (!request.timeout) return;
    const timer = setTimeout(() => respond({ cancelled: true }), Math.max(0, request.timeout - (Date.now() - (request._received || Date.now()))));
    return () => clearTimeout(timer);
  }, [request, respond]);
  return <Modal title={request.title || '扩展请求'} onClose={close}><div className="modal-body"><div className="eyebrow">PI 扩展</div>{request.message && <p className="dialog-message">{request.message}</p>}{request.method === 'select' ? <div className="option-list">{(request.options || []).map((option: string, index: number) => <button key={index} onClick={() => respond({ value: option })}>{option}<ArrowRight size={16} /></button>)}</div> : request.method === 'editor' ? <textarea autoFocus className="form-input extension-editor" value={value} onChange={event => setValue(event.target.value)} /> : request.method === 'input' ? <input autoFocus className="form-input" placeholder={request.placeholder} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) respond({ value }); }} /> : null}{request.timeout && <p className="muted small-text">此请求将在约 {Math.ceil(request.timeout / 1000)} 秒后过期。</p>}</div><footer className="modal-actions"><button className="button secondary" onClick={close}>{request.method === 'confirm' ? '拒绝' : '取消'}</button>{request.method !== 'select' && <button className="button primary" onClick={() => respond(request.method === 'confirm' ? { confirmed: true } : { value })}>{request.method === 'confirm' ? '确认' : '提交'}</button>}</footer></Modal>;
}

type ProjectLibraryMode = 'library' | 'migration';
function ProjectLibrary({ mode, preferences, currentProject, locked, onModeChange, onClose, onOpen, onChooseFolder, onImported }: {
  mode: ProjectLibraryMode; preferences: Preferences; currentProject: string; locked: boolean;
  onModeChange: (mode: ProjectLibraryMode) => void; onClose: () => void; onOpen: (path: string) => void;
  onChooseFolder: () => void; onImported: (preferences: Preferences) => void;
}) {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<ProjectMigrationPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const normalizedPath = (path: string) => path.replace(/\\/g, '/').toLocaleLowerCase();
  const existing = new Set(preferences.projects.map(item => normalizedPath(item.path)));
  const available = preview?.projects.filter(item => item.available) || [];
  const filtered = preferences.projects.filter(item => `${item.name} ${item.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    if (mode !== 'migration' || !window.pi) return;
    let active = true;
    setLoading(true); setPreview(null); setError('');
    void window.pi.previewProjectMigration().then(value => {
      if (active) { setPreview(value); setSelected(value.projects.filter(item => item.available).map(item => item.path)); }
    }).catch(reason => { if (active) setError(errorText(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode]);
  const importSelected = async () => {
    if (!window.pi || importing || !selected.length) return;
    setImporting(true); setError('');
    try {
      const imported = await window.pi.importProjects(selected);
      onImported(imported.preferences);
      setResult(`已导入 ${imported.imported} 个项目，${imported.alreadyPresent} 个已在项目库${imported.skipped ? `，${imported.skipped} 个已跳过` : ''}。可读取 ${imported.sessionCount} 个历史会话。`);
      setQuery(''); onModeChange('library');
    } catch (reason) { setError(errorText(reason)); }
    finally { setImporting(false); }
  };
  const close = useCallback(() => { if (!importing) onClose(); }, [importing, onClose]);
  return <Modal title={mode === 'migration' ? '导入 Pi Web 项目' : '项目库'} onClose={close} wide>
    <div className="modal-body project-library">
      <div className="project-library-tabs"><button className={mode === 'library' ? 'selected' : ''} disabled={importing} onClick={() => onModeChange('library')}><FolderOpen size={15} />全部项目 <span>{preferences.projects.length}</span></button><button className={`project-migration-button ${mode === 'migration' ? 'selected' : ''}`} disabled={importing || !window.pi} onClick={() => onModeChange('migration')}><ArrowDown size={15} />导入 Pi Web 项目</button></div>
      {error && <div className="project-library-message error-text" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
      {mode === 'library' ? <>
        {result && <div className="project-library-message project-import-result" role="status"><CheckCircle2 size={15} /><span>{result}</span></div>}
        <p className="project-library-description">选择项目后，左侧会显示它的历史会话。项目文件与会话保留在原位置。</p>
        <label className="project-library-search-box"><Search size={16} /><input className="project-library-search" aria-label="搜索项目名称或路径" placeholder="搜索项目名称或完整路径…" value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label="清空项目搜索" onClick={() => setQuery('')}><X size={14} /></IconButton>}</label>
        <div className="project-library-list" aria-label="全部项目">{filtered.map(item => <button className={`project-entry ${normalizedPath(item.path) === normalizedPath(currentProject) ? 'current' : ''}`} data-path={item.path} key={item.path} title={item.path} disabled={locked || !window.pi} onClick={() => onOpen(item.path)}><span className="project-entry-icon"><Folder size={18} /></span><span className="project-entry-text"><strong>{item.name}</strong><small>{item.path}</small></span>{normalizedPath(item.path) === normalizedPath(currentProject) ? <span className="project-entry-badge">当前</span> : <ChevronRight size={15} />}</button>)}{!filtered.length && <div className="project-library-empty"><FolderOpen size={27} /><strong>{query ? '没有找到相关项目' : '把已有项目带到这里'}</strong><p>{query ? '试试项目名称或路径中的其他关键词。' : '导入 Pi Web 项目，或打开一个本地文件夹。'}</p></div>}</div>
        {locked && <p className="project-library-footnote">当前任务结束后即可切换项目。</p>}
        <p className="project-library-footnote">恢复历史会话前，请先结束网页版中的同一会话，避免同时写入。</p>
      </> : <>
        <p className="project-library-description">读取本机 Pi Web 的项目与会话记录，将项目添加到桌面版项目库。</p>
        {loading && <div className="project-migration-loading" role="status"><LoaderCircle size={19} className="spin" />正在查找项目与历史会话…</div>}
        {preview && <div className="project-migration-preview">
          <div className="project-migration-summary"><span><strong>{preview.projects.length}</strong> 个项目</span><span><strong>{preview.sessionCount}</strong> 个历史会话</span><span><strong>{available.length}</strong> 个目录可用</span></div>
          {preview.projects.length > 0 && <label className="project-select-all"><input type="checkbox" checked={available.length > 0 && selected.length === available.length} disabled={importing || !available.length} onChange={event => setSelected(event.target.checked ? available.map(item => item.path) : [])} /><span>选择全部可用项目</span><small>已选 {selected.length} 个</small></label>}
          <div className="project-migration-list" aria-label="待导入项目">{preview.projects.map(item => <label className={`project-migration-entry ${item.available ? '' : 'unavailable'}`} key={item.path} title={item.path}><input type="checkbox" aria-label={`导入 ${item.name}`} disabled={importing || !item.available} checked={selected.includes(item.path)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.path] : previous.filter(path => path !== item.path))} /><span className="project-entry-text"><strong>{item.name}</strong><small>{item.path}</small></span><span className="project-migration-entry-meta"><span>{item.sessionCount} 个会话</span><small>{!item.available ? '目录不存在' : existing.has(normalizedPath(item.path)) ? '已在项目库' : '可导入'}</small></span></label>)}{!preview.projects.length && <div className="project-library-empty"><FolderOpen size={27} /><strong>尚未找到 Pi Web 项目</strong><p>可以直接打开本地项目文件夹。</p></div>}</div>
          {preview.warnings.length > 0 && <div className="project-migration-warnings">{preview.warnings.map((warning, index) => <p key={index}><TriangleAlert size={13} />{warning}</p>)}</div>}
          <p className="project-migration-source"><span>读取位置</span><code>{preview.source}</code></p>
        </div>}
        <p className="project-library-footnote">导入仅添加项目入口，原目录和历史会话保持不变。导入后不会自动打开会话。</p>
      </>}
    </div>
    <footer className="modal-actions">{mode === 'migration' ? <><button className="button secondary" disabled={importing} onClick={() => onModeChange('library')}>返回项目库</button><button className="button primary project-import-button" disabled={loading || importing || !preview || !selected.length} onClick={() => void importSelected()}>{importing ? <LoaderCircle size={15} className="spin" /> : <ArrowDown size={15} />}{importing ? '正在导入…' : `导入 ${selected.length} 个项目`}</button></> : <><span className="muted small-text">共 {preferences.projects.length} 个项目</span><button className="button secondary" onClick={close}>关闭</button><button className="button primary" disabled={locked || !window.pi} onClick={onChooseFolder}><Plus size={15} />打开文件夹</button></>}</footer>
  </Modal>;
}

const runtimeSourceNames = { bundled: '应用内置', system: '系统环境', custom: '自定义' };
function RuntimeEnvironment({ diagnostics, piPath, nodePath, onPiPathChange, onNodePathChange }: { diagnostics?: Diagnostics; piPath: string; nodePath: string; onPiPathChange: (path: string) => void; onNodePathChange: (path: string) => void }) {
  const runtimes = [
    { id: 'pi', name: 'Pi', path: diagnostics?.piPath, version: diagnostics?.piVersion, source: diagnostics?.piSource },
    { id: 'node', name: 'Node.js', path: diagnostics?.nodePath, version: diagnostics?.nodeVersion, source: diagnostics?.nodeSource },
    { id: 'bash', name: 'Git Bash', path: diagnostics?.bashPath, version: undefined, source: diagnostics?.bashSource },
  ];
  const allBundled = runtimes.every(runtime => runtime.source === 'bundled');
  return <section className="settings-section runtime-settings">
    <h3>运行环境</h3>
    <p>{allBundled ? 'Pi、Node.js 与 Git Bash 已随应用内置，无需单独安装。' : '默认使用应用内置的 Pi、Node.js 与 Git Bash，也可沿用系统环境或指定其他版本。'}模型配置与历史会话沿用本机 Pi / Pi Web 的数据。</p>
    <div className="diagnostics runtime-diagnostics">{runtimes.map(runtime => <div className="runtime-status" data-runtime={runtime.id} key={runtime.id}><span>{runtime.name}</span><span className="runtime-status-value"><strong>{runtime.path ? runtime.version || '可用' : diagnostics ? '不可用' : '检查中…'}</strong><small className="runtime-source" data-source={runtime.source || 'unknown'}>{runtime.source ? runtimeSourceNames[runtime.source] : runtime.path ? '已检测到' : '未就绪'}</small></span></div>)}</div>
    {diagnostics?.warnings?.map((warning, index) => <p className="runtime-diagnostic-message runtime-warning" role="status" key={index}><Info size={14} /><span>{warning}</span></p>)}
    {diagnostics?.errors.map((error, index) => <p className="runtime-diagnostic-message error-text" role="alert" key={index}><TriangleAlert size={14} /><span>{error}</span></p>)}
    <details className="runtime-details runtime-paths"><summary><ChevronRight size={14} />查看运行路径</summary><dl>{runtimes.map(runtime => <div key={runtime.id}><dt>{runtime.name}</dt><dd><code>{runtime.path || '尚未就绪'}</code></dd></div>)}{diagnostics?.runtimeRoot && <div><dt>内置运行环境</dt><dd><code>{diagnostics.runtimeRoot}</code></dd></div>}{diagnostics?.agentDir && <div><dt>配置与会话目录</dt><dd><code>{diagnostics.agentDir}</code></dd></div>}</dl></details>
    <details className="runtime-details runtime-advanced"><summary><ChevronRight size={14} />高级：指定运行版本{Boolean(piPath || nodePath) && <small>已自定义</small>}</summary><div className="runtime-advanced-body"><p>仅需使用其他版本时填写；留空会优先使用内置环境。保存后在下次连接项目时生效。</p><label className="form-label">Pi 入口路径<input className="form-input" value={piPath} onChange={event => onPiPathChange(event.target.value)} placeholder="留空自动选择（优先内置 Pi）" /></label><label className="form-label">Node.js 路径<input className="form-input" value={nodePath} onChange={event => onNodePathChange(event.target.value)} placeholder="留空自动选择（优先内置 Node.js）" /></label></div></details>
  </section>;
}

function ModelConfiguration({ summary, ready, runtimeCount, refreshing, refreshStatus, onRefresh, onReveal }: { summary?: Bootstrap['modelConfig']; ready: boolean; runtimeCount: number; refreshing: boolean; refreshStatus: string; onRefresh: () => void; onReveal?: () => void }) {
  const configured = summary?.models || [];
  const defaultModel = configured.find(model => model.provider === summary?.defaultProvider && model.id === summary?.defaultModel);
  return <section className="settings-section model-settings">
    <h3>模型与登录</h3>
    <p>沿用本机 Pi / Pi Web 的模型配置和登录信息。首次使用模型仍需有效的 API 密钥或服务商登录。</p>
    {summary?.error && <div className="model-config-error" role="alert"><TriangleAlert size={15} /><span>{summary.error}</span></div>}
    <div className="model-config-heading"><strong>已读取 {configured.length} 项模型配置</strong><button className="text-button" disabled={refreshing} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? 'spin' : ''} />{refreshing ? '正在读取…' : '重新读取配置'}</button></div>
    {configured.length > 0 ? <ul className="configured-model-list">{configured.map(model => <li className="configured-model" key={`${model.provider}/${model.id}`} data-provider={model.provider} data-model-id={model.id}><span><strong>{model.name || model.id}</strong><small>{model.provider} / {model.id}</small></span>{model === defaultModel && <span className="default-model-badge">默认</span>}</li>)}</ul> : <p className="muted small-text">{summary ? '尚未读取到自定义模型。可打开下方 Pi 配置目录，添加服务商与模型配置；已有的登录信息会继续使用。' : '连接桌面应用后读取模型配置。'}</p>}
    {summary?.defaultModel && <p className="model-default-note">Pi 默认模型：{defaultModel?.name || summary.defaultModel}{summary.defaultThinkingLevel ? ` · ${thinkingNames[summary.defaultThinkingLevel] || summary.defaultThinkingLevel}` : ''}</p>}
    <p className="model-availability-note">{ready ? `当前项目可选 ${runtimeCount} 项模型，包含已启用的内置模型。实际可选项以顶部菜单为准。` : '打开项目文件夹后，即可在顶部菜单选择模型。'}配置列表仅表示本机已配置，服务是否可用需以实际请求为准。</p>
    {summary?.source && <div className="model-config-source"><span>配置来源</span><code>{summary.source}</code></div>}
    <p className="model-reload-note">在 Pi Web 或配置文件中修改模型后，先重新读取配置，再于任务结束后重新连接 Pi，使当前项目加载新配置。</p>
    {refreshStatus && <p className="model-refresh-status" role="status">{refreshStatus}</p>}
    {onReveal && <button className="button secondary" onClick={onReveal}><FolderOpen size={15} />打开 Pi 配置目录</button>}
  </section>;
}

export default function App() {
  const api = window.pi;
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(emptyPreferences);
  const [status, setStatus] = useState(api ? 'initializing' : 'disconnected');
  const [project, setProject] = useState('');
  const [state, setState] = useState<RpcRecord>({});
  const [messages, setMessages] = useState<RpcRecord[]>([]);
  const [models, setModels] = useState<RpcRecord[]>([]);
  const [commands, setCommands] = useState<RpcRecord[]>([]);
  const [stats, setStats] = useState<RpcRecord>({});
  const [levels, setLevels] = useState<string[]>(['off', 'minimal', 'low', 'medium', 'high']);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [activity, setActivity] = useState('');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [sendMode, setSendMode] = useState('steer');
  const [queue, setQueue] = useState<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  const [tools, setTools] = useState<Record<string, RpcRecord>>({});
  const [notice, setNotice] = useState<Notice | null>(api ? null : { text: '桌面连接未就绪。请从 Pi Desktop 应用打开此界面。', kind: 'info' });
  const [inspector, setInspector] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [settings, setSettings] = useState(false);
  const [projectLibrary, setProjectLibrary] = useState<ProjectLibraryMode | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelRefreshStatus, setModelRefreshStatus] = useState('');
  const [rename, setRename] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [forks, setForks] = useState<RpcRecord[] | null>(null);
  const [dialogs, setDialogs] = useState<RpcRecord[]>([]);
  const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [showCommands, setShowCommands] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showScroll, setShowScroll] = useState(false);
  const [piPath, setPiPath] = useState('');
  const [nodePath, setNodePath] = useState('');
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const projectRef = useRef(project);
  const currentDraftKey = useRef('');
  const draftRef = useRef(draft);
  const pendingDraft = useRef<string | null>(null);
  const sendLock = useRef(false);
  const reconnectSession = useRef<string | undefined>(undefined);
  const sessionGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const settingsOpened = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  projectRef.current = project;
  draftRef.current = draft;
  const ready = status === 'connected';
  const locked = busy || mutating || status === 'connecting';
  const reportError = useCallback((error: unknown) => setNotice({ text: errorText(error), kind: 'error' }), []);
  const inform = (text: string, kind: Notice['kind'] = 'info') => setNotice({ text, kind });
  const copyMessage = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice({ text: '已复制回复', kind: 'success' })).catch(reportError);
  }, [reportError]);

  const loadConfiguredModels = useCallback((boot: Bootstrap) => {
    // Summary data may name a default before the first project starts. Once a
    // project exists, its RPC state owns the active model and thinking level.
    if (projectRef.current || !boot.modelConfig) return;
    const config = boot.modelConfig;
    setModels(config.models);
    const configuredDefault = config.models.find(model => model.provider === config.defaultProvider && model.id === config.defaultModel);
    const defaultModel = configuredDefault || (config.defaultProvider && config.defaultModel ? { provider: config.defaultProvider, id: config.defaultModel, name: config.defaultModel } : undefined);
    setState(previous => ({ ...previous, model: defaultModel, thinkingLevel: config.defaultThinkingLevel || 'off' }));
    if (config.defaultThinkingLevel) setLevels(previous => previous.includes(config.defaultThinkingLevel!) ? previous : [...previous, config.defaultThinkingLevel!]);
  }, []);

  const refresh = useCallback(async (reloadMessages = false) => {
    if (!api) return;
    const generation = sessionGeneration.current;
    const request = ++refreshGeneration.current;
    const historyRequest = ++historyGeneration.current;
    const path = projectRef.current;
    setRefreshingHistory(false);
    const current = () => generation === sessionGeneration.current && request === refreshGeneration.current && path === projectRef.current;
    try {
      const results = await Promise.all([api.rpc({ type: 'get_state' }), api.rpc({ type: 'get_session_stats' }), api.listSessions(path), ...(reloadMessages ? [api.rpc({ type: 'get_messages' })] : [])]);
      if (!current()) return;
      setState(results[0]); setStats(results[1]);
      if (historyRequest === historyGeneration.current) setSessions(results[2] as SessionInfo[]);
      reconnectSession.current = (results[2] as SessionInfo[]).some(session => session.path === (results[0] as RpcRecord).sessionFile) ? (results[0] as RpcRecord).sessionFile : undefined;
      if (reloadMessages) setMessages((results[3] as RpcRecord).messages || []);
      return results[0] as RpcRecord;
    } catch (error) { if (current()) throw error; }
  }, [api]);

  const refreshHistory = useCallback(async () => {
    const path = projectRef.current;
    if (!api || !path) return;
    const generation = sessionGeneration.current;
    const request = ++historyGeneration.current;
    const current = () => request === historyGeneration.current && generation === sessionGeneration.current && path === projectRef.current;
    setRefreshingHistory(true);
    try { const history = await api.listSessions(path); if (current()) setSessions(history); }
    catch (error) { if (current()) reportError(error); }
    finally { if (current()) setRefreshingHistory(false); }
  }, [api, reportError]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);
  useEffect(() => {
    const key = `pi-desktop:draft:${project}:${state.sessionId || 'new'}`;
    if (key === currentDraftKey.current) return;
    try {
      if (currentDraftKey.current) localStorage.setItem(currentDraftKey.current, draftRef.current);
      currentDraftKey.current = key;
      setDraft(pendingDraft.current ?? localStorage.getItem(key) ?? '');
      pendingDraft.current = null;
    } catch { /* The editor remains usable if storage is unavailable. */ }
    setAttachments([]);
  }, [project, state.sessionId]);
  useEffect(() => { try { if (currentDraftKey.current) localStorage.setItem(currentDraftKey.current, draft); } catch { /* Optional draft cache. */ } }, [draft]);
  useEffect(() => {
    if (composeRef.current) { composeRef.current.style.height = 'auto'; composeRef.current.style.height = `${Math.min(composeRef.current.scrollHeight, 190)}px`; }
  }, [draft]);
  useEffect(() => {
    if (nearBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, tools, activity]);
  useEffect(() => {
    if (!notice || notice.kind === 'error') return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadConnection = useCallback(async (connection: Connection, generation: number) => {
    if (generation !== sessionGeneration.current) return;
    const historyRequest = ++historyGeneration.current;
    setProject(connection.project); projectRef.current = connection.project;
    setState(connection.state); setMessages(connection.messages); setModels(connection.models); setCommands(connection.commands); setStats(connection.stats);
    setTools({}); setQueue({ steering: [], followUp: [] }); setBusy(Boolean(connection.state.isStreaming || connection.state.isCompacting)); setActivity(''); setStatus('connected');
    nearBottom.current = true;
    const [history, supported] = await Promise.all([api.listSessions(connection.project), api.rpc({ type: 'get_available_thinking_levels' })]);
    if (generation !== sessionGeneration.current) return;
    if (historyRequest === historyGeneration.current) setSessions(history);
    setLevels(supported.levels || ['off']);
    reconnectSession.current = history.some(session => session.path === connection.state.sessionFile) ? connection.state.sessionFile : undefined;
  }, [api]);

  const connect = useCallback(async (path: string, sessionPath?: string) => {
    if (!api) return;
    const generation = ++sessionGeneration.current;
    refreshGeneration.current++; historyGeneration.current++; setRefreshingHistory(false);
    reconnectSession.current = sessionPath;
    setMutating(true); setStatus('connecting'); setNotice(null); setDialogs([]); setWidgets({}); setStatuses({});
    if (path !== projectRef.current) { setState({}); setMessages([]); setStats({}); setSessions([]); setTools({}); }
    setProject(path); projectRef.current = path;
    try {
      await loadConnection(await api.connect(path, sessionPath), generation);
      if (generation !== sessionGeneration.current) return;
      const boot = await api.bootstrap();
      if (generation === sessionGeneration.current) { setBootstrap(boot); setPreferences(boot.preferences); }
    } catch (error) { if (generation === sessionGeneration.current) { setStatus('error'); setProject(path); reportError(error); } }
    finally { if (generation === sessionGeneration.current) setMutating(false); }
  }, [api, loadConnection, reportError]);

  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onEvent(event => {
      if (event.type === 'connection_status') {
        setStatus(event.status);
        if (event.status === 'error' || event.status === 'disconnected') {
          setBusy(false); setActivity(''); setDialogs([]);
          setMessages(previous => previous.map(message => message._streaming ? { ...message, _streaming: false, stopReason: 'aborted' } : message));
          setTools(previous => Object.fromEntries(Object.entries(previous).map(([key, tool]) => [key, tool.status === 'running' ? { ...tool, status: 'done', isError: true, result: { content: [{ type: 'text', text: 'Pi 连接已断开，工具执行状态无法继续确认。' }] } } : tool])));
        }
        if (event.status === 'error' && (event.message || event.error)) reportError(event.message || event.error);
      }
      if (event.type === 'diagnostic') setNotice({ text: event.message, kind: event.level === 'error' ? 'error' : 'info' });
      if (['message_start', 'message_update', 'message_end'].includes(event.type)) setMessages(previous => applyMessageEvent(previous, event));
      if (event.type === 'agent_start') { refreshGeneration.current++; setBusy(true); setActivity('Pi 正在思考'); }
      if (event.type === 'agent_settled') { setBusy(false); setActivity(''); void refresh(true).catch(reportError); }
      if (event.type === 'message_end' && event.message?.errorMessage) reportError(event.message.errorMessage);
      if (event.type === 'message_update') setActivity('Pi 正在回复');
      if (event.type.startsWith('tool_execution_')) {
        setTools(previous => ({ ...previous, [event.toolCallId]: { ...previous[event.toolCallId], ...event, result: event.result || event.partialResult || previous[event.toolCallId]?.result, status: event.type === 'tool_execution_end' ? 'done' : 'running' } }));
        if (event.type === 'tool_execution_start') setActivity(`正在执行 ${event.toolName}`);
      }
      if (event.type === 'queue_update') setQueue({ steering: event.steering || [], followUp: event.followUp || [] });
      if (event.type === 'compaction_start') { setBusy(true); setActivity('正在压缩上下文'); }
      if (event.type === 'compaction_end') {
        if (event.errorMessage) reportError(event.errorMessage);
        // Automatic compaction may be followed by another model turn. Only agent_settled
        // (or the completed manual compact command) releases the operation lock.
      }
      if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') { setBusy(true); setActivity(`连接暂时失败，准备重试 ${event.attempt}/${event.maxAttempts}`); }
      if (event.type === 'auto_retry_end' && event.finalError) reportError(event.finalError);
      if (event.type === 'extension_error') reportError(event.error);
      if (event.type === 'extension_ui_request') {
        if (['select', 'confirm', 'input', 'editor'].includes(event.method)) setDialogs(previous => [...previous, { ...event, _received: Date.now() }]);
        if (event.method === 'notify') setNotice({ text: event.message, kind: event.notifyType === 'error' ? 'error' : 'info' });
        if (event.method === 'setStatus') setStatuses(previous => ({ ...previous, [event.statusKey]: event.statusText || '' }));
        if (event.method === 'setWidget') setWidgets(previous => ({ ...previous, [event.widgetKey]: event.widgetLines || [] }));
        if (event.method === 'setTitle') document.title = event.title || 'Pi Desktop';
        if (event.method === 'set_editor_text') setDraft(event.text || '');
      }
    });
    void api.bootstrap().then(async boot => {
      setBootstrap(boot); setPreferences(boot.preferences); setPiPath(boot.preferences.piPath || ''); setNodePath(boot.preferences.nodePath || '');
      loadConfiguredModels(boot);
      setStatus('disconnected');
      if (boot.preferences.lastProject) await connect(boot.preferences.lastProject, boot.preferences.lastSessions?.[boot.preferences.lastProject]);
    }).catch(reportError);
    return unsubscribe;
  }, [api, connect, refresh, reportError, loadConfiguredModels]);

  const openProject = async () => { if (!api || locked) return; try { const path = await api.chooseProject(); if (path) await connect(path, preferences.lastSessions?.[path]); } catch (error) { reportError(error); } };
  const mutateSession = async (command: RpcRecord) => {
    if (!api || locked || !ready) return;
    const generation = ++sessionGeneration.current;
    refreshGeneration.current++; historyGeneration.current++; setRefreshingHistory(false);
    setMutating(true);
    try {
      const result = await api.rpc(command);
      if (generation !== sessionGeneration.current) return;
      if (result.cancelled) { await refresh(true); inform('操作已被 Pi 扩展取消。'); return; }
      setTools({}); setQueue({ steering: [], followUp: [] }); setAttachments([]);
      if (command.type === 'fork') pendingDraft.current = result.text || '';
      await refresh(true); nearBottom.current = true;
      if (generation !== sessionGeneration.current) return;
      if (command.type === 'fork') { setForks(null); inform('已创建分支。原会话已保留，磁盘文件不会回滚。', 'success'); }
    } catch (error) { if (generation === sessionGeneration.current) reportError(error); }
    finally { if (generation === sessionGeneration.current) setMutating(false); }
  };
  const newSession = () => ready ? void mutateSession({ type: 'new_session' }) : project && api ? void connect(project) : void openProject();
  const switchModel = async (key: string) => {
    const selected = models.find(model => `${model.provider}/${model.id}` === key);
    if (!selected || locked) return;
    refreshGeneration.current++;
    setMutating(true);
    try { await api.rpc({ type: 'set_model', provider: selected.provider, modelId: selected.id }); const next = await api.rpc({ type: 'get_state' }); setState(next); const supported = await api.rpc({ type: 'get_available_thinking_levels' }); setLevels(supported.levels || ['off']); } catch (error) { reportError(error); } finally { setMutating(false); }
  };
  const changeThinking = async (level: string) => { if (locked) return; refreshGeneration.current++; setMutating(true); try { await api.rpc({ type: 'set_thinking_level', level }); setState(await api.rpc({ type: 'get_state' })); } catch (error) { reportError(error); } finally { setMutating(false); } };
  const beginFork = async () => { try { const result = await api.rpc({ type: 'get_fork_messages' }); setForks(result.messages || []); } catch (error) { reportError(error); } };
  const saveRename = async () => { if (!sessionName.trim()) return; refreshGeneration.current++; try { await api.rpc({ type: 'set_session_name', name: sessionName.trim() }); await refresh(); setRename(false); } catch (error) { reportError(error); } };

  const addBrowserFiles = async (files: File[]) => {
    try {
      if (attachments.length + files.length > 10) throw new Error('每条消息最多添加 10 个附件，请先移除一些附件。');
      const added: FileAttachment[] = [];
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB，请选择更小的文件。`);
        const isImage = /image\/(png|jpeg|webp|gif)/.test(file.type);
        if (isImage) {
          const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(`无法读取 ${file.name}`)); reader.readAsDataURL(file); });
          added.push({ name: file.name, path: file.name, type: 'image', mimeType: file.type, data });
        } else {
          const content = await file.text();
          if (content.includes('\0')) throw new Error(`${file.name} 不是可读取的文本文件。首版支持文本、代码和图片。`);
          if (file.size > 1024 * 1024) throw new Error(`${file.name} 文本超过 1 MB，请先缩小内容范围。`);
          added.push({ name: file.name, path: file.name, type: 'text', content });
        }
      }
      setAttachments(previous => [...previous, ...added]);
    } catch (error) { reportError(error); }
  };
  const chooseFiles = async () => { try { const files = await api.chooseFiles(); if (attachments.length + files.length > 10) throw new Error('每条消息最多添加 10 个附件，请先移除一些附件。'); setAttachments(previous => [...previous, ...files]); } catch (error) { reportError(error); } };
  const send = async () => {
    if (!ready || mutating || sendLock.current || (!draft.trim() && !attachments.length)) return;
    const prompt = draft.trim();
    const commandName = /^\/([^\s]+)/.exec(prompt)?.[1];
    if (commandName && !commands.some(command => command.name.replace(/^\//, '') === commandName)) {
      const supported: Record<string, () => void> = { new: newSession, fork: () => void beginFork(), compact: () => void compact(), model: () => document.getElementById('model-select')?.click(), settings: () => setSettings(true) };
      if (supported[commandName]) { if (locked && commandName !== 'settings') { inform('请先停止当前任务，再执行此命令。'); return; } setDraft(''); supported[commandName](); return; }
      reportError(`/${commandName} 未被当前 Pi 注册。终端专用命令请使用对应的界面入口，或在 Pi 终端中运行。`); return;
    }
    const images = attachments.filter(file => file.type === 'image').map(file => ({ type: 'image', data: file.data, mimeType: file.mimeType }));
    if (images.length && state.model?.input && !state.model.input.includes('image')) { reportError('当前模型不支持图片，请切换支持图片的模型。'); return; }
    const textFiles = attachments.filter(file => file.type === 'text').map(file => `\n\n<attached_file path=${JSON.stringify(file.path)}>\n${file.content || ''}\n</attached_file>`).join('');
    const message = (prompt || '请查看附件。') + textFiles;
    const previousDraft = draft;
    const previousAttachments = attachments;
    sendLock.current = true;
    refreshGeneration.current++;
    setDraft(''); setAttachments([]); setShowCommands(false); nearBottom.current = true;
    setMutating(true);
    try { await api.rpc({ type: 'prompt', message, ...(images.length ? { images } : {}), ...(busy ? { streamingBehavior: sendMode } : {}) }); }
    catch (error) { setDraft(previousDraft); setAttachments(previousAttachments); reportError(error); }
    finally { sendLock.current = false; setMutating(false); composeRef.current?.focus(); }
  };
  const stop = async () => { try { setActivity('正在停止…'); await api.rpc({ type: 'abort' }); } catch (error) { reportError(error); } };
  const compact = async () => { if (locked) return; setMutating(true); try { await api.rpc({ type: 'compact' }); const nextState = await refresh(true); setBusy(Boolean(nextState?.isStreaming || nextState?.isCompacting)); setActivity(''); inform('上下文已压缩。', 'success'); } catch (error) { reportError(error); setBusy(false); setActivity(''); } finally { setMutating(false); } };
  const saveSettings = async () => {
    try {
      const saved = await api.savePreferences({ piPath: piPath.trim(), nodePath: nodePath.trim() });
      setPreferences(saved); const boot = await api.bootstrap(); setBootstrap(boot); inform('设置已保存。路径修改会在下次连接项目时生效。', 'success');
    } catch (error) { reportError(error); }
  };
  const refreshModelConfiguration = async () => {
    if (!api || refreshingModels) return;
    setRefreshingModels(true); setModelRefreshStatus('');
    try {
      const boot = await api.bootstrap();
      setBootstrap(boot); loadConfiguredModels(boot);
      setModelRefreshStatus(boot.modelConfig?.error ? '读取配置时发现问题，请查看上方提示。' : projectRef.current ? '配置已重新读取。当前会话保持运行，任务结束后重新连接 Pi 即可加载变更。' : '配置已重新读取，打开项目后即可选择模型。');
    } catch (error) { setModelRefreshStatus(errorText(error)); }
    finally { setRefreshingModels(false); }
  };
  const respond = useCallback((response: RpcRecord) => {
    const request = dialogs[0]; if (!request) return;
    void api.respondUI({ id: request.id, ...response }).catch(reportError);
    setDialogs(previous => previous.filter(item => item.id !== request.id));
  }, [api, dialogs, reportError]);
  const closeSettings = useCallback(() => setSettings(false), []);
  const closeProjectLibrary = useCallback(() => setProjectLibrary(null), []);
  const closeRename = useCallback(() => setRename(false), []);
  const closeForks = useCallback(() => setForks(null), []);
  const filteredSessions = useMemo(() => sessions.filter(session => `${session.name || ''} ${session.firstMessage || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [sessions, search]);
  const resultMap = useMemo(() => Object.fromEntries(messages.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message])), [messages]);
  const visibleMessages = useMemo(() => messages.filter(message => message.role !== 'toolResult'), [messages]);
  const title = state.sessionName || (textContent(messages.find(message => message.role === 'user')).split('\n')[0]?.slice(0, 36)) || '新会话';
  const commandMatches = commands.filter(command => command.name.toLowerCase().includes(draft.replace(/^\//, '').split(' ')[0].toLowerCase())).slice(0, 8);
  const contextPercent = stats.contextUsage?.percent;
  const currentModelKey = state.model ? `${state.model.provider}/${state.model.id}` : '';
  const modelOptions = state.model && !models.some(model => `${model.provider}/${model.id}` === currentModelKey) ? [state.model, ...models] : models;
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); void addBrowserFiles([...event.dataTransfer.files]); };

  useEffect(() => {
    if (settings && !settingsOpened.current) { setPiPath(preferences.piPath || ''); setNodePath(preferences.nodePath || ''); }
    settingsOpened.current = settings;
  }, [settings, preferences]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettings(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); composeRef.current?.focus(); setShowCommands(value => !value); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, []);

  return <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${inspector ? '' : 'inspector-hidden'}`}>
    {sidebar && <aside className="sidebar"><div className="brand"><PiMark small /><span className="brand-name"><span>Pi <span className="brand-light">Desktop</span></span><small className="brand-subtitle">Pi 非官方客户端</small></span><span className="preview-tag">BETA</span><IconButton label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={17} /></IconButton></div><button className="new-chat" disabled={locked} onClick={newSession}><Plus size={17} />新建会话<span>开始探索</span></button><div className="sidebar-section-heading"><span>工作空间</span><IconButton label="打开项目文件夹" disabled={locked || !api} onClick={() => void openProject()}><Plus size={15} /></IconButton></div><button className={`project-item ${project ? 'active' : ''}`} disabled={locked || !api} onClick={() => void openProject()}><span className="project-symbol"><FolderOpen size={17} /></span><span><strong>{project ? basename(project) : '打开项目'}</strong><small>{project ? '当前工作目录' : '选择一个本地文件夹'}</small></span><ChevronDown size={14} /></button>{preferences.projects.filter(item => item.path !== project).slice(0, 3).map(item => <button key={item.path} className="recent-project" disabled={locked} onClick={() => void connect(item.path, preferences.lastSessions?.[item.path])}><Folder size={15} /><span>{item.name}</span></button>)}<div className="project-sidebar-actions"><button className="project-library-button" onClick={() => setProjectLibrary('library')}><BookOpen size={14} /><span>全部项目</span><span className="count-label">{preferences.projects.length}</span><ChevronRight size={13} /></button><button className="project-migration-button" disabled={!api} onClick={() => setProjectLibrary('migration')}><ArrowDown size={14} /><span>导入 Pi Web 项目</span></button></div><div className="sidebar-section-heading history-heading"><span>最近会话</span><span className="history-heading-actions"><span className="count-label">{sessions.length || '—'}</span><IconButton className="icon-button history-refresh-button" label="刷新历史会话" disabled={!project || refreshingHistory || mutating || status === 'connecting'} onClick={() => void refreshHistory()}><RefreshCw size={13} className={refreshingHistory ? 'spin' : ''} /></IconButton></span></div><label className="search-box"><Search size={14} /><input aria-label="搜索会话" placeholder="搜索会话…" value={search} onChange={event => setSearch(event.target.value)} />{search ? <IconButton className="icon-button history-search-clear" label="清空会话搜索" onClick={() => setSearch('')}><X size={13} /></IconButton> : <kbd>⌕</kbd>}</label><nav className="session-list" aria-label="历史会话">{filteredSessions.map(session => <button key={session.path} className={`session-item ${session.path === state.sessionFile ? 'selected' : ''}`} disabled={locked} onClick={() => void mutateSession({ type: 'switch_session', sessionPath: session.path })}><MessageSquare size={15} /><span><strong>{session.name || session.firstMessage?.slice(0, 45) || '未命名会话'}</strong><small>{new Date(session.modified).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} · {session.messageCount} 条消息</small></span></button>)}{!filteredSessions.length && <div className="no-sessions"><MessageSquare size={21} /><p>{search ? '没有找到相关会话' : '每一个想法，都有迹可循'}</p><span>{search ? '试试其他关键词' : '开始对话后，会话会保存在这里'}</span></div>}</nav><div className="sidebar-bottom"><div className="local-note"><span className={`status-dot ${ready ? 'online' : ''}`} /><span>{ready ? 'Pi 已连接 · 本地会话' : status === 'connecting' ? '正在连接 Pi…' : '在你的电脑上工作'}</span></div><button className="settings-button" onClick={() => setSettings(true)}><Settings size={17} /><span>设置与连接</span><kbd>Ctrl ,</kbd></button></div></aside>}
    <div className="workspace"><header className="topbar"><div className="breadcrumb">{!sidebar && <IconButton label="展开侧栏" onClick={() => setSidebar(true)}><PanelLeftOpen size={18} /></IconButton>}<span className="project-breadcrumb"><Folder size={15} />{project ? basename(project) : '工作空间'}</span><span className="breadcrumb-slash">/</span><span className="current-title" title={title}>{title}</span>{ready && <IconButton label="重命名会话" disabled={locked} onClick={() => { setSessionName(state.sessionName || title); setRename(true); }}><Pencil size={13} /></IconButton>}</div><div className="topbar-actions"><span className={`connection-pill ${ready ? 'connected' : ''}`}><span className={`status-dot ${ready ? 'online' : ''}`} />{ready ? '已连接' : status === 'connecting' || status === 'initializing' ? '连接中' : '未连接'}</span><IconButton label={inspector ? '收起会话详情' : '展开会话详情'} onClick={() => setInspector(value => !value)}>{inspector ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</IconButton></div></header>
      <main className="chat-main"><div className="chat-toolbar"><ModelControls models={modelOptions} modelKey={currentModelKey} model={state.model} levels={levels} thinkingLevel={state.thinkingLevel || 'off'} disabled={!ready || locked} ready={ready} project={project} onModelChange={key => void switchModel(key)} onThinkingChange={level => void changeThinking(level)} /><div className="toolbar-spacer" />{messages.length > 0 && <button className="text-button fork-button" disabled={locked} onClick={() => void beginFork()}><GitBranch size={14} />创建分支</button>}</div>
        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <TriangleAlert size={16} /> : notice.kind === 'success' ? <CheckCircle2 size={16} /> : <Info size={16} />}<span>{notice.text}</span>{status === 'error' && project && <button disabled={locked} onClick={() => void connect(project, reconnectSession.current)}>重试</button>}<IconButton label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></IconButton></div>}
        <div className="conversation-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) { nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 110; setShowScroll(!nearBottom.current); } }}>
          {!visibleMessages.length ? <div className="empty-state"><div className="welcome-label"><span />你的本地 AI 编程伙伴</div><div className="hero-mark"><PiMark /><span className="hero-orbit orbit-one" /><span className="hero-orbit orbit-two" /><span className="hero-dot" /></div><h1>从一个想法开始。</h1><p>读懂代码，解决问题，让想法落地。<br />Pi 和你一起，在自己的工作空间里完成。</p>{!ready ? <button className="button primary open-project-hero" disabled={locked || !api} onClick={() => void openProject()}>{status === 'connecting' ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={17} />}{status === 'connecting' ? '正在连接项目…' : '打开项目文件夹'}<ArrowRight size={16} /></button> : <div className="project-ready"><span className="status-dot online" />已准备好在 <strong>{basename(project)}</strong> 中工作</div>}{!ready && bootstrap?.diagnostics && !bootstrap.diagnostics.errors.length && bootstrap.diagnostics.piPath && bootstrap.diagnostics.nodePath && bootstrap.diagnostics.bashPath && <div className="runtime-ready-note" data-runtime-mode={[bootstrap.diagnostics.piSource, bootstrap.diagnostics.nodeSource, bootstrap.diagnostics.bashSource].every(source => source === 'bundled') ? 'bundled' : 'local'}><CheckCircle2 size={13} /><span>{[bootstrap.diagnostics.piSource, bootstrap.diagnostics.nodeSource, bootstrap.diagnostics.bashSource].every(source => source === 'bundled') ? '内置运行环境已就绪，无需单独安装' : '本地运行环境已就绪'}</span><button className="text-button" onClick={() => setSettings(true)}>查看环境</button></div>}{!ready && bootstrap?.modelConfig && !bootstrap.modelConfig.error && !bootstrap.modelConfig.models.length && <div className="model-setup-welcome"><span>使用模型需要 API 密钥或服务商登录。</span><button className="text-button" onClick={() => setSettings(true)}>模型设置<ArrowRight size={12} /></button></div>}{Boolean(bootstrap?.modelConfig?.models.length) && !bootstrap?.modelConfig?.error && <div className="model-config-welcome"><span><CheckCircle2 size={14} />已接入 {bootstrap?.modelConfig?.models.length} 项模型配置<button className="text-button" onClick={() => setSettings(true)}>查看模型<ArrowRight size={12} /></button></span>{!ready && <small>打开项目后，即可选择并使用已有模型。</small>}</div>}{bootstrap?.modelConfig?.error && <button className="text-button model-config-welcome-error" onClick={() => setSettings(true)}><TriangleAlert size={14} />模型配置读取异常，查看设置</button>}{!ready && preferences.projects.length > 0 && <button className="text-button project-library-welcome project-library-button" onClick={() => setProjectLibrary('library')}><BookOpen size={14} />从 {preferences.projects.length} 个已有项目中选择<ArrowRight size={13} /></button>}<div className="starter-grid">{starters.map(({ icon: Icon, title: starterTitle, description, prompt }) => <button key={starterTitle} className="starter-card" onClick={() => { setDraft(prompt); composeRef.current?.focus(); }}><Icon size={19} /><strong>{starterTitle}</strong><span>{description}</span><ArrowRight size={14} className="starter-arrow" /></button>)}</div></div> : <div className="messages">{visibleMessages.map((message, index) => <MessageView key={`${message.role}-${message.timestamp || index}-${index}`} message={message} modelName={message.model || state.model?.name || 'Assistant'} resultMap={resultMap} tools={tools} onError={reportError} onCopy={copyMessage} />)}{busy && <div className="activity-line"><span className="pulse-dots"><i /><i /><i /></span>{activity || 'Pi 正在处理任务'}</div>}</div>}
        </div>
        {showScroll && <button className="jump-bottom" onClick={() => { nearBottom.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={15} />回到最新</button>}
        <div className="composer-area">{Object.entries(widgets).filter(([, lines]) => lines.length).map(([key, lines]) => <div className="extension-widget" key={key}>{lines.join('\n')}</div>)}{(queue.steering.length > 0 || queue.followUp.length > 0) && <div className="queue-list">{queue.steering.map((text, index) => <div key={`s${index}`}><Zap size={13} /><span>调整当前任务</span><p>{text}</p></div>)}{queue.followUp.map((text, index) => <div key={`f${index}`}><ListFilter size={13} /><span>完成后继续</span><p>{text}</p></div>)}</div>}
          {(showCommands || (draft.startsWith('/') && !draft.includes(' '))) && ready && <div className="command-menu"><div className="command-menu-heading"><span>可用命令</span><IconButton label="关闭命令" onClick={() => setShowCommands(false)}><X size={13} /></IconButton></div>{commandMatches.length ? commandMatches.map(command => <button key={command.name} onClick={() => { setDraft(`/${command.name.replace(/^\//, '')} `); setShowCommands(false); composeRef.current?.focus(); }}><Terminal size={15} /><span><strong>/{command.name.replace(/^\//, '')}</strong><small>{command.description || command.source}</small></span><span className="command-source">{command.source}</span></button>) : <p>暂无匹配的扩展、技能或提示模板。<br />使用界面入口管理模型、会话与设置。</p>}</div>}
          <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop}>{attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <div className="attachment" key={`${attachment.name}-${index}`}>{attachment.type === 'image' ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <FileText size={16} />}<span>{attachment.name}</span><button aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments(previous => previous.filter((_, i) => i !== index))}><X size={12} /></button></div>)}</div>}<textarea ref={composeRef} disabled={mutating} aria-label="输入消息" rows={2} value={draft} placeholder={ready ? '你想一起完成什么？输入 / 查看命令' : '先打开一个项目，让 Pi 了解你的工作空间…'} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }} onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addBrowserFiles(files); } }} /><div className="composer-bottom"><div className="composer-tools"><IconButton label="添加图片或文本文件" disabled={!api || mutating} onClick={() => void chooseFiles()}><Paperclip size={17} /></IconButton><button className="command-trigger" title="命令面板 Ctrl K" disabled={!ready} onClick={() => setShowCommands(value => !value)}><span>/</span><span>命令</span></button><span className="attachment-hint">支持拖入文件、粘贴图片</span></div><div className="send-controls">{busy && <select className="queue-mode" aria-label="消息发送方式" value={sendMode} onChange={event => setSendMode(event.target.value)}><option value="steer">调整当前任务</option><option value="followUp">完成后继续</option></select>}{busy && <button className="stop-button" onClick={() => void stop()} title="停止任务"><Square size={13} fill="currentColor" /></button>}<button className="send-button" aria-label={busy ? '追加消息' : '发送消息'} title={busy ? '追加消息' : '发送消息 Enter'} disabled={!ready || mutating || (!draft.trim() && !attachments.length)} onClick={() => void send()}>{mutating ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}</button></div></div>{dragging && <div className="drop-overlay"><Paperclip size={24} />松开以添加文件</div>}</div><div className="composer-caption"><span>{busy ? '追加指令将在工具执行边界送入' : '在当前项目中读取文件、编辑代码与执行命令'}</span><span><kbd>Enter</kbd> 发送 <span className="caption-dot">·</span> <kbd>Shift Enter</kbd> 换行</span></div></div>
      </main><footer className="statusbar"><span className="status-directory" title={project}><Folder size={12} />{project || '尚未选择项目'}</span><div>{Object.values(statuses).filter(Boolean).map((text, index) => <span key={index}>{text}</span>)}{busy && <span><LoaderCircle size={11} className="spin" />正在工作</span>}<span>本地保存</span><span className="version-label">Pi {bootstrap?.diagnostics.piVersion || 'Desktop'}</span></div></footer></div>
    {inspector && <aside className="inspector"><div className="inspector-header"><SlidersHorizontal size={15} /><strong>会话详情</strong></div><div className="inspector-content"><div className="inspector-heading">工作空间</div><div className="workspace-card"><span className="folder-tile"><FolderOpen size={21} /></span><strong>{project ? basename(project) : '等待连接项目'}</strong><p title={project}>{project || '选择文件夹后，Pi 会在这里工作'}</p>{project && <button className="text-button" onClick={() => void api.revealFile(project).catch(reportError)}>在资源管理器打开<ArrowRight size={12} /></button>}</div><div className="inspector-heading context-heading"><span>上下文</span><span>{contextPercent == null ? '—' : `${Math.round(contextPercent)}%`}</span></div><div className="context-track"><div style={{ width: `${Math.min(contextPercent || 0, 100)}%` }} /></div><div className="context-caption"><span>{stats.contextUsage?.tokens == null ? '等待首条回复' : `${compactNumber(stats.contextUsage.tokens)} 已使用`}</span><span>{stats.contextUsage?.contextWindow ? `${compactNumber(stats.contextUsage.contextWindow)} 上限` : '—'}</span></div><button className="compact-button" disabled={!ready || locked || !messages.length} onClick={() => void compact()}><ListFilter size={14} />压缩上下文</button><div className="inspector-heading usage-heading">本次会话</div><div className="stat-row"><span>消息</span><strong>{stats.totalMessages ?? messages.length}</strong></div><div className="stat-row"><span>工具调用</span><strong>{stats.toolCalls ?? 0}</strong></div><div className="stat-row"><span>输入 Token</span><strong>{compactNumber(stats.tokens?.input || 0)}</strong></div><div className="stat-row"><span>输出 Token</span><strong>{compactNumber(stats.tokens?.output || 0)}</strong></div><div className="stat-row"><span>缓存读取</span><strong>{compactNumber(stats.tokens?.cacheRead || 0)}</strong></div><div className="stat-row cost-row"><span>估算费用 <Info size={11} /></span><strong>${Number(stats.cost || 0).toFixed(4)}</strong></div><p className="cost-note">根据模型定价与用量估算，实际费用以服务商账单为准。</p><div className="inspector-heading quick-heading">会话操作</div><button className="inspector-action" disabled={!ready || locked || !messages.length} onClick={() => void beginFork()}><GitBranch size={15} />从历史消息创建分支<ChevronRight size={13} /></button><button className="inspector-action" disabled={!ready || locked} onClick={() => { setSessionName(state.sessionName || title); setRename(true); }}><Pencil size={14} />重命名会话<ChevronRight size={13} /></button><button className="inspector-action" disabled={locked || !project} onClick={() => void connect(project, reconnectSession.current)}><RefreshCw size={14} />重新连接 Pi<ChevronRight size={13} /></button></div><div className="inspector-tip"><BookOpen size={17} /><strong>给想法一点上下文</strong><p>把文件拖到输入框，或说出目标。Pi 会先了解项目，再与你一起推进。</p><span>你的工作空间，你的节奏。</span></div></aside>}
    {projectLibrary && <ProjectLibrary mode={projectLibrary} preferences={preferences} currentProject={project} locked={locked} onModeChange={setProjectLibrary} onClose={closeProjectLibrary} onOpen={path => { if (!locked) { setProjectLibrary(null); void connect(path, preferences.lastSessions?.[path]); } }} onChooseFolder={() => { setProjectLibrary(null); void openProject(); }} onImported={setPreferences} />}
    {settings && <Modal title="设置与连接" onClose={closeSettings} wide><div className="modal-body settings-body"><div className="settings-section"><h3>外观</h3><div className="theme-buttons"><button className={preferences.theme === 'light' ? 'selected' : ''} onClick={() => { if (api) void api.savePreferences({ theme: 'light' }).then(setPreferences).catch(reportError); else setPreferences(previous => ({ ...previous, theme: 'light' })); }}><Sun size={18} />浅色</button><button className={preferences.theme === 'dark' ? 'selected' : ''} onClick={() => { if (api) void api.savePreferences({ theme: 'dark' }).then(setPreferences).catch(reportError); else setPreferences(previous => ({ ...previous, theme: 'dark' })); }}><Moon size={18} />深色</button></div></div><ProjectAttribution /><RuntimeEnvironment diagnostics={bootstrap?.diagnostics} piPath={piPath} nodePath={nodePath} onPiPathChange={setPiPath} onNodePathChange={setNodePath} /><ModelConfiguration summary={bootstrap?.modelConfig} ready={ready} runtimeCount={models.length} refreshing={refreshingModels} refreshStatus={modelRefreshStatus} onRefresh={() => void refreshModelConfiguration()} onReveal={bootstrap?.diagnostics.agentDir && api ? () => void api.revealFile(bootstrap.diagnostics.agentDir).catch(reportError) : undefined} /><div className="settings-section compatibility-note"><Info size={16} /><p>普通扩展弹窗、技能和模板可直接使用。依赖终端绘制的扩展界面需要单独适配。会话分支保留对话，不会回滚磁盘文件。</p></div></div><footer className="modal-actions"><span className="muted small-text">Pi Desktop {bootstrap?.version || '0.1.0'}</span><button className="button secondary" onClick={closeSettings}>关闭</button><button className="button primary" disabled={!api} onClick={() => void saveSettings()}>保存设置</button></footer></Modal>}
    {rename && <Modal title="重命名会话" onClose={closeRename}><div className="modal-body"><label className="form-label">会话名称<input autoFocus className="form-input" value={sessionName} onChange={event => setSessionName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void saveRename(); }} maxLength={160} /></label></div><footer className="modal-actions"><button className="button secondary" onClick={closeRename}>取消</button><button className="button primary" disabled={!sessionName.trim()} onClick={() => void saveRename()}>保存名称</button></footer></Modal>}
    {forks && <Modal title="从历史消息创建分支" onClose={closeForks}><div className="modal-body"><p className="muted">选择一个起点，保留此前的对话并编辑这条消息。原会话会保留，磁盘文件不会回滚。</p><div className="fork-list">{forks.map((fork, index) => <button key={fork.entryId} disabled={locked} onClick={() => void mutateSession({ type: 'fork', entryId: fork.entryId })}><span>{String(index + 1).padStart(2, '0')}</span><p>{fork.text}</p><GitBranch size={16} /></button>)}{!forks.length && <p className="muted">暂无可以创建分支的用户消息。</p>}</div></div></Modal>}
    {dialogs[0] && <ExtensionDialog key={dialogs[0].id} request={dialogs[0]} respond={respond} />}
  </div>;
}
