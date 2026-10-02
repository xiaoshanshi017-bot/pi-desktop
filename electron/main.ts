import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection, FileAttachment, Preferences, RpcRecord } from '../shared/types';
import { discoverDiagnostics } from './diagnostics';
import { createPiLaunchOptions } from './runtime';
import { readModelConfigSummary } from './model-config';
import { importProjects, previewProjectMigration } from './project-migration';
import { resolveSessionRestore } from './session-restore';
import { PiRpcClient } from './rpc';
import { listSessions, PreferenceStore, readSessionInfo, samePath } from './storage';

if (process.env.PI_DESKTOP_USER_DATA) app.setPath('userData', resolve(process.env.PI_DESKTOP_USER_DATA));
app.setName('Pi Desktop');
let window: BrowserWindow | null = null;
let client: PiRpcClient | undefined;
let currentProject: string | undefined;
let connecting = false;
let rpcMutation = false;
let sessionRevision = 0;
let allowClose = false;
let closePending = false;
let store: PreferenceStore;
const expectedVersion = '0.84.2';
const devUrl = process.env.PI_DESKTOP_DEV_URL;
const runtimeRoot = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), 'build', 'runtime', 'win32-x64');
const sessionCommands = new Set(['new_session', 'switch_session', 'fork', 'clone']);
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
function requireClient(): PiRpcClient {
  if (!client?.running) throw new Error('请先打开项目并连接 Pi。');
  return client;
}
function assertIdle(): void {
  if (connecting || rpcMutation || client?.busy) throw new Error('Pi 正在执行任务或切换会话，请等待完成后再操作。');
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
async function rememberSession(active: PiRpcClient, state?: RpcRecord, revision = sessionRevision): Promise<void> {
  if (client !== active || !currentProject || revision !== sessionRevision) return;
  const project = currentProject;
  const snapshot = state ?? await active.request({ type: 'get_state' });
  if (client !== active || currentProject !== project || revision !== sessionRevision || typeof snapshot.sessionFile !== 'string') return;
  const prefs = store.get();
  if (prefs.lastSessions?.[project] !== snapshot.sessionFile) {
    // Pi assigns a session filename before the first durable message exists.
    // Do not save an uncreated session as a restore target.
    if (!(await readSessionInfo(snapshot.sessionFile, project)) || client !== active || currentProject !== project || revision !== sessionRevision) return;
    await store.save({ lastSessions: { ...store.get().lastSessions, [project]: snapshot.sessionFile } });
  }
}
async function connect(projectValue: unknown, sessionValue?: unknown): Promise<Connection> {
  assertIdle();
  connecting = true;
  sessionRevision++;
  let candidate: PiRpcClient | undefined;
  try {
    const project = await projectPath(projectValue);
    const requestedSession = sessionValue === undefined ? undefined : resolve(text(sessionValue, '会话路径'));
    const restored = await resolveSessionRestore(project, requestedSession);
    const sessionPath = restored.sessionPath;
    const diagnostics = await discoverDiagnostics(store.get(), { runtimeRoot, packaged: app.isPackaged, projectDir: project });
    if (diagnostics.errors.length || !diagnostics.piPath || !diagnostics.nodePath) throw new Error(diagnostics.errors.join('\n'));
    const launch = await createPiLaunchOptions(diagnostics, runtimeRoot, ['--mode', 'rpc', ...(sessionPath ? ['--session', sessionPath] : [])], {
      developmentLauncher: app.isPackaged ? undefined : join(app.getAppPath(), 'electron', 'pi-launcher.mjs'),
    });
    if (client) await client.stop();
    client = undefined;
    currentProject = project;
    emit({ type: 'connection_status', status: 'connecting', project });
    candidate = new PiRpcClient({
      executable: launch.executable,
      args: launch.args,
      cwd: project,
      env: { ...launch.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      requestTimeoutMs: 60_000,
      onEvent: event => {
        if (client !== candidate) return;
        emit({ ...event, ...(event.type === 'connection_status' ? { project } : {}) });
        if (event.type === 'agent_settled') void rememberSession(candidate!).catch(() => {});
      },
    });
    client = candidate;
    candidate.start();
    const [state, messages, models, commandList, stats] = await Promise.all([
      candidate.request({ type: 'get_state' }), candidate.request({ type: 'get_messages' }),
      candidate.request({ type: 'get_available_models' }), candidate.request({ type: 'get_commands' }),
      candidate.request({ type: 'get_session_stats' }),
    ]);
    const persisted = typeof state.sessionFile === 'string' && await readSessionInfo(state.sessionFile, project);
    await store.opened(project, persisted ? state.sessionFile : undefined);
    if (restored.missing) {
      const lastSessions = { ...store.get().lastSessions };
      for (const [savedProject, savedSession] of Object.entries(lastSessions)) {
        if (samePath(savedProject, project) && requestedSession && samePath(savedSession, requestedSession)) delete lastSessions[savedProject];
      }
      await store.save({ lastSessions });
    }
    emit({ type: 'connection_status', status: 'connected', project });
    if (restored.missing) emit({ type: 'diagnostic', level: 'warning', message: '上次保存的会话文件已不存在，已为这个项目建立新会话。' });
    if (diagnostics.piVersion && diagnostics.piVersion !== expectedVersion) emit({ type: 'diagnostic', level: 'warning', message: `当前 Pi 为 ${diagnostics.piVersion}；本客户端已验证的版本为 ${expectedVersion}。` });
    return { project, state: publicRpcData('get_state', state), messages: messages.messages ?? [], models: (models.models ?? []).map(publicModel), commands: commandList.commands ?? [], stats };
  } catch (error) {
    if (candidate) await candidate.stop();
    if (client === candidate) client = undefined;
    emit({ type: 'connection_status', status: 'error', message: (error as Error).message });
    throw error;
  } finally { connecting = false; }
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
  handle('pi:bootstrap', async () => {
    const diagnostics = await discoverDiagnostics(store.get(), { runtimeRoot, packaged: app.isPackaged });
    return { preferences: store.get(), diagnostics, version: app.getVersion(), modelConfig: await readModelConfigSummary(diagnostics.agentDir) };
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
  handle('pi:disconnect', async () => { assertIdle(); sessionRevision++; const old = client; client = undefined; await old?.stop(); emit({ type: 'connection_status', status: 'disconnected' }); });
  handle('pi:listSessions', async value => listSessions(await projectPath(value)));
  handle('pi:savePreferences', async (patch: Partial<Preferences>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。');
    return store.save(patch);
  });
  handle('pi:rpc', async value => {
    const command = validateCommand(value);
    const active = requireClient();
    const exclusive = sessionCommands.has(command.type) || ['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'compact', 'set_session_name'].includes(command.type);
    if (!exclusive && (connecting || rpcMutation) && ['prompt', 'steer', 'follow_up', 'bash'].includes(command.type)) throw new Error('正在切换会话或模型，请等待完成后再发送。');
    if (exclusive) {
      assertIdle();
      rpcMutation = true;
      if (sessionCommands.has(command.type)) sessionRevision++;
    }
    const revision = sessionRevision;
    try {
      if (command.type === 'switch_session') {
        command.sessionPath = resolve(text(command.sessionPath, '会话路径'));
        if (!(await readSessionInfo(command.sessionPath, currentProject))) throw new Error('会话无效，或不属于当前项目。');
      }
      const data = await active.request(command, ['compact', 'bash', 'prompt', 'fork', 'clone', 'new_session', 'switch_session'].includes(command.type) ? 10 * 60_000 : 60_000);
      if (sessionCommands.has(command.type) && !data.cancelled) await rememberSession(active, undefined, revision);
      if (command.type === 'get_state' && !rpcMutation) await rememberSession(active, data, revision);
      return publicRpcData(command.type, data);
    } finally { if (exclusive) rpcMutation = false; }
  });
  handle('pi:respondUI', value => {
    if (!value || typeof value.id !== 'string') throw new Error('扩展回复无效。');
    const response: RpcRecord = { type: 'extension_ui_response', id: value.id };
    if (typeof value.cancelled === 'boolean') response.cancelled = value.cancelled;
    if (typeof value.confirmed === 'boolean') response.confirmed = value.confirmed;
    if (typeof value.value === 'string') response.value = value.value.slice(0, 2 * 1024 * 1024);
    requireClient().send(response);
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
      if (client?.busy || connecting) {
        const result = await dialog.showMessageBox(window!, { type: 'question', title: '任务仍在运行', message: '停止任务并退出 Pi Desktop？', detail: 'Pi 会保留已经保存的会话。', buttons: ['继续运行', '停止并退出'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) { closePending = false; return; }
      }
      await client?.stop();
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
    await store.load();
    registerIpc();
    await createWindow();
  }).catch(error => { dialog.showErrorBox('Pi Desktop 启动失败', (error as Error).message); app.quit(); });
  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => { if (client?.running && !window) void client.stop(); });
}
