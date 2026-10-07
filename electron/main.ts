import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BootstrapOptions, ConnectOptions, Connection, FileAttachment, Preferences, RpcRecord } from '../shared/types';
import { desktopProgressGuidance } from '../shared/progress-guidance';
import { discoverDiagnostics } from './diagnostics';
import { createPiLaunchOptions } from './runtime';
import { readModelConfigSummary } from './model-config';
import { importProjects, previewProjectMigration } from './project-migration';
import { resolveSessionRestore } from './session-restore';
import { ConnectionPool, type ManagedConnection } from './connections';
import { PiRpcClient } from './rpc';
import { listSessions, PreferenceStore, readSessionHeader, readSessionInfo, samePath } from './storage';
import { WorkspaceStore } from './workspace-store';

if (process.env.PI_DESKTOP_USER_DATA) app.setPath('userData', resolve(process.env.PI_DESKTOP_USER_DATA));
app.setName('Pi Desktop');
let window: BrowserWindow | null = null;
let connections: ConnectionPool;
let allowClose = false;
let closePending = false;
let store: PreferenceStore;
let workspaceStore: WorkspaceStore;
let workspaceFrozen = false;
let pendingWorkspaceFlush: { id: string; done(): void } | undefined;
const expectedVersion = '0.84.2';
const devUrl = process.env.PI_DESKTOP_DEV_URL;
const runtimeRoot = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), 'build', 'runtime', 'win32-x64');
const commands = new Set([
  'prompt', 'steer', 'follow_up', 'abort', 'new_session', 'get_state', 'get_messages',
  'set_model', 'cycle_model', 'get_available_models', 'set_thinking_level', 'cycle_thinking_level',
  'get_available_thinking_levels', 'set_steering_mode', 'set_follow_up_mode', 'compact',
  'set_auto_compaction', 'set_auto_retry', 'abort_retry', 'bash', 'abort_bash',
  'get_session_stats', 'export_html', 'switch_session', 'fork', 'clone', 'get_fork_messages',
  'get_entries', 'get_tree', 'get_last_assistant_text', 'set_session_name', 'get_commands',
]);

function emit(event: RpcRecord): void {
  if (window && !window.isDestroyed()) window.webContents.send('pi:event', event);
}
function publicModel(model: RpcRecord | undefined | null): RpcRecord | null {
  if (!model) return null;
  // Custom provider definitions may contain authentication headers. The renderer
  // needs display metadata only; Pi alone owns provider credentials and transport.
  const fields = ['id', 'name', 'api', 'provider', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost'];
  return Object.fromEntries(fields.filter(key => model[key] !== undefined).map(key => [key, model[key]]));
}
function publicRpcData(command: string, data: RpcRecord): RpcRecord {
  if (command === 'set_model') return publicModel(data) ?? {};
  if (command === 'get_available_models') return { ...data, models: (data.models ?? []).map(publicModel) };
  if (['get_state', 'cycle_model'].includes(command) && 'model' in data) return { ...data, model: publicModel(data.model) };
  return data;
}
function validSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的 IPC 来源。');
  const url = event.senderFrame?.url ?? '';
  if (devUrl) {
    if (new URL(url).origin !== new URL(devUrl).origin) throw new Error('不允许的页面来源。');
  } else {
    if (!url.startsWith('file:') || !samePath(fileURLToPath(url.split('#')[0]), join(__dirname, '..', 'dist', 'index.html'))) throw new Error('不允许的页面来源。');
  }
}
function handle(channel: string, callback: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => { validSender(event); return callback(...args); });
}
function text(value: unknown, name: string, max = 32_768): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效。`);
  return value;
}
async function projectPath(value: unknown): Promise<string> {
  const path = resolve(text(value, '项目路径'));
  if (!(await stat(path)).isDirectory()) throw new Error('项目路径必须是文件夹。');
  return path;
}
async function rememberSession(active: ManagedConnection, snapshot: RpcRecord, revision: number): Promise<void> {
  if (active.closing || revision !== active.revision || !connections.isLatestSelection(active) || typeof snapshot.sessionFile !== 'string') return;
  const project = active.project;
  const prefs = store.get();
  if (prefs.lastSessions?.[project] !== snapshot.sessionFile) {
    // Pi assigns a session filename before the first durable message exists.
    // Do not save an uncreated session as a restore target.
    if (!(await readSessionInfo(snapshot.sessionFile, project)) || active.closing || revision !== active.revision || !connections.isLatestSelection(active)) return;
    await store.save({ lastSessions: { ...store.get().lastSessions, [project]: snapshot.sessionFile } });
  }
}
function publicConnection(value: Connection): Connection {
  return { ...value, state: publicRpcData('get_state', value.state), models: value.models.map(publicModel).filter((model): model is RpcRecord => Boolean(model)) };
}
async function rememberOpened(value: Connection): Promise<void> {
  const sessionFile = typeof value.state.sessionFile === 'string' && await readSessionInfo(value.state.sessionFile, value.project) ? value.state.sessionFile as string : undefined;
  let entry: ManagedConnection;
  try { entry = connections.get(value.connectionId); } catch { return; }
  if (connections.activeConnectionId === value.connectionId) {
    await store.opened(value.project, sessionFile);
    return;
  }
  // A slow startup may finish after the user selected a different chat. Record
  // its project without moving the selected project or restore target backwards.
  const prefs = store.get();
  const project = { path: value.project, name: basename(value.project) || value.project, lastOpened: new Date().toISOString() };
  const exists = prefs.projects.some(saved => samePath(saved.path, value.project));
  await store.save({
    projects: exists ? prefs.projects.map(saved => samePath(saved.path, value.project) ? project : saved) : [...prefs.projects, project],
    ...(sessionFile && connections.isLatestSelection(entry) ? { lastSessions: { ...prefs.lastSessions, [value.project]: sessionFile } } : {}),
  });
}
async function rememberSelected(id: string): Promise<void> {
  let entry: ManagedConnection;
  try { entry = connections.get(id); } catch { return; }
  const { revision, selectionOrder, sessionPath } = entry;
  // Selection needs only the cached chat ID. Validate its restore target from
  // the small header, without scanning a large conversation's message records.
  const header = sessionPath ? await readSessionHeader(sessionPath) : null;
  if (entry.closing || connections.activeConnectionId !== entry.id || revision !== entry.revision || selectionOrder !== entry.selectionOrder || sessionPath !== entry.sessionPath) return;
  await store.opened(entry.project, header && samePath(header.cwd, entry.project) ? sessionPath : undefined);
}
function connectionId(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, '连接 ID', 200);
}
function createConnections(): ConnectionPool {
  return new ConnectionPool({
    onEvent: emit,
    onState: rememberSession,
    createClient: async (project, sessionPath, onEvent) => {
      const diagnostics = await discoverDiagnostics(store.get(), { runtimeRoot, packaged: app.isPackaged, projectDir: project });
      if (diagnostics.errors.length || !diagnostics.piPath || !diagnostics.nodePath) throw new Error(diagnostics.errors.join('\n'));
      const launch = await createPiLaunchOptions(diagnostics, runtimeRoot, ['--mode', 'rpc', '--append-system-prompt', desktopProgressGuidance, ...(sessionPath ? ['--session', sessionPath] : [])], {
        developmentLauncher: app.isPackaged ? undefined : join(app.getAppPath(), 'electron', 'pi-launcher.mjs'),
      });
      if (diagnostics.piVersion && diagnostics.piVersion !== expectedVersion) onEvent({ type: 'diagnostic', level: 'warning', message: `当前 Pi 为 ${diagnostics.piVersion}；本客户端已验证的版本为 ${expectedVersion}。` });
      return new PiRpcClient({
        executable: launch.executable,
        args: launch.args,
        cwd: project,
        env: { ...launch.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        requestTimeoutMs: 60_000,
        onEvent,
      });
    },
  });
}
async function connect(projectValue: unknown, sessionValue?: unknown, optionsValue?: unknown): Promise<Connection> {
  if (optionsValue !== undefined && (!optionsValue || typeof optionsValue !== 'object' || Array.isArray(optionsValue))) throw new Error('新会话选项无效。');
  const options = optionsValue as ConnectOptions | undefined;
  for (const field of ['newSession', 'background', 'restoring'] as const) if (options?.[field] !== undefined && typeof options[field] !== 'boolean') throw new Error('新会话选项无效。');
  if (options?.connectionId !== undefined && (text(options.connectionId, '缓存会话 ID', 200) === 'welcome')) throw new Error('缓存会话 ID 无效。');
  const project = await projectPath(projectValue);
  const requestedSession = options?.newSession || sessionValue === undefined ? undefined : resolve(text(sessionValue, '会话路径'));
  const restored = await resolveSessionRestore(project, requestedSession);
  if (options?.restoring && restored.missing) throw new Error('保存的会话文件已不存在，本地视图缓存仍会保留。');
  const result = await connections.connect(project, restored.sessionPath ? await realpath(restored.sessionPath) : undefined, restored.missing ? { ...options, newSession: true } : options);
  if (!options?.background) await rememberOpened(result);
  if (restored.missing) {
    const lastSessions = { ...store.get().lastSessions };
    for (const [savedProject, savedSession] of Object.entries(lastSessions)) {
      if (samePath(savedProject, project) && requestedSession && samePath(savedSession, requestedSession)) delete lastSessions[savedProject];
    }
    await store.save({ lastSessions });
  }
  if (restored.missing) emit({ type: 'diagnostic', connectionId: result.connectionId, project, level: 'warning', message: '上次保存的会话文件已不存在，已为这个项目建立新会话。' });
  return publicConnection(result);
}

function validateCommand(value: unknown): RpcRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi 指令格式无效。');
  const command = { ...value } as RpcRecord;
  if (!commands.has(command.type)) throw new Error('此 Pi 指令未开放。');
  delete command.id;
  if (JSON.stringify(command).length > 40 * 1024 * 1024) throw new Error('消息过大。');
  if (['prompt', 'steer', 'follow_up'].includes(command.type)) {
    if (typeof command.message !== 'string' || command.message.length > 2 * 1024 * 1024) throw new Error('消息文本无效或超过 2 MB。');
    if (!command.message.trim() && !command.images?.length) throw new Error('请填写消息或添加图片。');
    if (command.streamingBehavior !== undefined && !['steer', 'followUp'].includes(command.streamingBehavior)) throw new Error('消息队列方式无效。');
    if (command.images !== undefined && (!Array.isArray(command.images) || command.images.length > 10 || command.images.some((image: any) => !image || image.type !== 'image' || typeof image.data !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)))) throw new Error('图片附件无效。');
  }
  if (command.type === 'set_model') { text(command.provider, '模型服务商'); text(command.modelId, '模型 ID'); }
  if (command.type === 'set_session_name') text(command.name, '会话名称', 200);
  if (command.type === 'set_thinking_level' && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(command.level)) throw new Error('思考强度无效。');
  if (['set_steering_mode', 'set_follow_up_mode'].includes(command.type) && !['all', 'one-at-a-time'].includes(command.mode)) throw new Error('队列模式无效。');
  if (['set_auto_compaction', 'set_auto_retry'].includes(command.type) && typeof command.enabled !== 'boolean') throw new Error('开关参数无效。');
  if (command.type === 'fork') text(command.entryId, '分支消息 ID');
  if (command.type === 'bash') text(command.command, '终端命令', 100_000);
  return command;
}

function externalUrl(value: unknown): string {
  const url = new URL(text(value, '链接'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许打开 HTTP 或 HTTPS 网页链接。');
  return url.href;
}

async function chooseFiles(): Promise<FileAttachment[]> {
  const selection = await dialog.showOpenDialog(window!, { title: '添加文本文件或图片', properties: ['openFile', 'multiSelections'] });
  if (selection.canceled) return [];
  if (selection.filePaths.length > 10) throw new Error('每次最多添加 10 个附件。');
  const result: FileAttachment[] = [];
  let total = 0;
  const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  for (const file of selection.filePaths) {
    const info = await stat(file);
    const mimeType = imageTypes[extname(file).toLowerCase()];
    const max = mimeType ? 10 * 1024 * 1024 : 512 * 1024;
    if (info.size > max) throw new Error(`${basename(file)} 超过大小限制（文本 512 KB，图片 10 MB）。`);
    total += info.size;
    if (total > 24 * 1024 * 1024) throw new Error('附件总大小不能超过 24 MB。');
    const data = await readFile(file);
    if (mimeType) result.push({ name: basename(file), path: file, type: 'image', mimeType, data: data.toString('base64') });
    else {
      if (data.includes(0)) throw new Error(`${basename(file)} 不是 UTF-8 文本文件。请添加文本或图片。`);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error(`${basename(file)} 不是有效的 UTF-8 文本，请先转换编码。`); }
      result.push({ name: basename(file), path: file, type: 'text', content });
    }
  }
  return result;
}

function registerIpc(): void {
  handle('pi:bootstrap', async (options?: BootstrapOptions) => {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || (options.workspace !== undefined && typeof options.workspace !== 'boolean'))) throw new Error('启动选项无效。');
    const diagnostics = await discoverDiagnostics(store.get(), { runtimeRoot, packaged: app.isPackaged });
    return { preferences: store.get(), diagnostics, version: app.getVersion(), modelConfig: await readModelConfigSummary(diagnostics.agentDir), ...(options?.workspace !== false ? { workspace: workspaceStore.get() } : {}) };
  });
  handle('pi:chooseProject', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '打开项目文件夹', properties: ['openDirectory'], defaultPath: store.get().lastProject });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('pi:previewProjectMigration', () => previewProjectMigration());
  handle('pi:importProjects', async value => {
    if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !isAbsolute(path) || !path.trim() || path.length > 32_768)) throw new Error('待导入项目路径无效。');
    return importProjects(value, store);
  });
  handle('pi:connect', connect);
  handle('pi:activateConnection', async value => {
    const result = await connections.activate(text(value, '连接 ID', 200));
    await rememberOpened(result);
    return publicConnection(result);
  });
  handle('pi:selectConnection', value => {
    const result = connections.select(text(value, '连接 ID', 200));
    // Disk persistence runs after selection; it must not delay the next paint.
    void rememberSelected(result.id).catch(error => emit({ type: 'diagnostic', connectionId: result.id, project: result.project, level: 'warning', message: `保存会话入口失败：${(error as Error).message}` }));
    return result;
  });
  handle('pi:listConnections', () => connections.list());
  handle('pi:disconnect', async value => connections.disconnect(connectionId(value)));
  handle('pi:listSessions', async value => listSessions(await projectPath(value)));
  handle('pi:savePreferences', async (patch: Partial<Preferences>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。');
    return store.save(patch);
  });
  handle('pi:saveWorkspace', async value => {
    // Once the close-time snapshot is durable, disconnect events must not
    // overwrite its open tabs with an empty workspace during shutdown.
    if (!workspaceFrozen) await workspaceStore.save(value);
  });
  handle('pi:workspaceFlushed', value => {
    if (typeof value === 'string' && value === pendingWorkspaceFlush?.id) pendingWorkspaceFlush.done();
  });
  handle('pi:rpc', async (value, idValue) => {
    const command = validateCommand(value);
    const id = connectionId(idValue);
    const active = connections.get(id);
    if (command.type === 'switch_session') {
      command.sessionPath = resolve(text(command.sessionPath, '会话路径'));
      if (!(await readSessionInfo(command.sessionPath, active.project))) throw new Error('会话无效，或不属于当前项目。');
      command.sessionPath = await realpath(command.sessionPath);
    }
    const data = await connections.rpc(command, active.id);
    return publicRpcData(command.type, data);
  });
  handle('pi:redirect', async (value, idValue) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['message', 'images'].includes(key))) throw new Error('任务调整格式无效。');
    const command = validateCommand({ type: 'prompt', message: value.message, ...(value.images !== undefined ? { images: value.images } : {}) });
    return connections.redirect({ message: command.message, ...(command.images ? { images: command.images.map((image: RpcRecord) => ({ type: 'image', data: image.data, mimeType: image.mimeType })) } : {}) }, connectionId(idValue));
  });
  handle('pi:respondUI', (value, idValue) => {
    if (!value || typeof value.id !== 'string') throw new Error('扩展回复无效。');
    const response: RpcRecord = { type: 'extension_ui_response', id: value.id };
    if (typeof value.cancelled === 'boolean') response.cancelled = value.cancelled;
    if (typeof value.confirmed === 'boolean') response.confirmed = value.confirmed;
    if (typeof value.value === 'string') response.value = value.value.slice(0, 2 * 1024 * 1024);
    connections.respondUI(response, connectionId(idValue));
  });
  handle('pi:chooseFiles', chooseFiles);
  handle('pi:openExternal', value => shell.openExternal(externalUrl(value)));
  handle('pi:revealFile', async value => {
    const path = text(value, '文件路径');
    if (!isAbsolute(path)) throw new Error('文件路径必须是绝对路径。');
    await stat(path);
    shell.showItemInFolder(path);
  });
}

async function flushRendererWorkspace(): Promise<void> {
  if (window && !window.isDestroyed()) {
    await new Promise<void>(resolve => {
      const id = randomUUID();
      const done = () => { clearTimeout(timeout); if (pendingWorkspaceFlush?.id === id) pendingWorkspaceFlush = undefined; resolve(); };
      const timeout = setTimeout(done, 2_000);
      pendingWorkspaceFlush = { id, done };
      window!.webContents.send('pi:workspaceFlush', id);
    });
  }
  try {
    await workspaceStore.flush();
  } finally {
    // Preserve the last recoverable cache even when its final write fails.
    workspaceFrozen = true;
  }
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 680,
    title: 'Pi Desktop', icon: join(app.getAppPath(), 'build', 'icon.png'), backgroundColor: '#f6f7f8', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { try { void shell.openExternal(externalUrl(url)).catch(() => {}); } catch { /* Block non-web URLs. */ } return { action: 'deny' }; });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window?.webContents && permission === 'clipboard-sanitized-write'));
  window.on('close', event => {
    if (allowClose) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void (async () => {
      if (connections.busyCount) {
        const result = await dialog.showMessageBox(window!, { type: 'question', title: '任务仍在运行', message: '停止所有任务并退出 Pi Desktop？', detail: `还有 ${connections.busyCount} 个会话正在运行。Pi 会保留已经保存的会话。`, buttons: ['继续运行', '停止并退出'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) { closePending = false; return; }
      }
      try {
        await flushRendererWorkspace();
      } finally {
        // A cache write failure still needs orderly child-process shutdown.
        await connections.stopAll();
      }
      await workspaceStore.flush();
      allowClose = true;
      window?.close();
    })().catch(() => { allowClose = true; window?.close(); });
  });
  window.on('closed', () => { window = null; });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(join(__dirname, '..', 'dist', 'index.html'));
}

const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    store = new PreferenceStore(join(app.getPath('userData'), 'preferences.json'));
    workspaceStore = new WorkspaceStore(join(app.getPath('userData'), 'workspace.json'));
    await Promise.all([store.load(), workspaceStore.load()]);
    connections = createConnections();
    registerIpc();
    await createWindow();
  }).catch(error => { dialog.showErrorBox('Pi Desktop 启动失败', (error as Error).message); app.quit(); });
  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => { if (!window) void connections?.stopAll(); });
}
