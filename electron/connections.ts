import { randomUUID } from 'node:crypto';
import type { ConnectOptions, Connection, ConnectionSummary, RedirectPrompt, RedirectResult, RpcRecord } from '../shared/types';
import type { PiRpcClient } from './rpc';
import { samePath } from './storage';

export type ConnectionClient = Pick<PiRpcClient, 'running' | 'busy' | 'hasSessionControls' | 'waitForIdle' | 'start' | 'stop' | 'request' | 'send'>;
interface RedirectRequest {
  id: string; prompt: RedirectPrompt; signature: string; promise: Promise<RedirectResult>;
  resolve(result: RedirectResult): void; reject(error: Error): void;
}
interface RedirectControl {
  latest: RedirectRequest; signal: AbortController; phase: 'stopping' | 'submitting';
  revision: number; extraAbort?: Promise<RpcRecord>;
}
export interface ManagedConnection {
  readonly id: string;
  readonly project: string;
  sessionPath?: string;
  sessionName?: string;
  status: string;
  lastActivity: number;
  selectionOrder: number;
  revision: number;
  client?: ConnectionClient;
  connecting?: Promise<Connection>;
  mutation: boolean;
  mutationType?: string;
  mutationDone?: Promise<void>;
  changingSession?: boolean;
  reservedSessionPaths?: string[];
  closing: boolean;
  closingPromise?: Promise<void>;
  redirect?: RedirectControl;
}
interface ConnectionPoolOptions {
  createClient(project: string, sessionPath: string | undefined, onEvent: (event: RpcRecord) => void): Promise<ConnectionClient> | ConnectionClient;
  onEvent(event: RpcRecord): void;
  onState?(connection: ManagedConnection, state: RpcRecord, revision: number): Promise<void> | void;
}
const sessionCommands = new Set(['new_session', 'switch_session', 'fork', 'clone']);
const exclusiveCommands = new Set([...sessionCommands, 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'compact', 'set_session_name']);
const longCommands = new Set(['compact', 'bash', 'prompt', 'fork', 'clone', 'new_session', 'switch_session']);
const activityEvents = new Set(['agent_start', 'agent_end', 'agent_settled', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end']);

/** Each chat owns a Pi process. Selecting a chat never interrupts another one. */
export class ConnectionPool {
  private entries = new Map<string, ManagedConnection>();
  private activeId?: string;
  private selectionOrder = 0;
  private stopping = false;
  constructor(private readonly options: ConnectionPoolOptions) {}
  get activeConnectionId(): string | undefined { return this.activeId; }
  isLatestSelection(entry: ManagedConnection): boolean {
    return entry.selectionOrder > 0 && ![...this.entries.values()].some(other => samePath(other.project, entry.project) && other.selectionOrder > entry.selectionOrder);
  }
  get busyCount(): number { return this.list().filter(connection => connection.busy).length; }
  private summary(entry: ManagedConnection): ConnectionSummary {
    return {
      id: entry.id, project: entry.project, sessionPath: entry.sessionPath, sessionName: entry.sessionName,
      status: entry.status, busy: this.isBusy(entry), lastActivity: entry.lastActivity,
    };
  }
  list(): ConnectionSummary[] {
    return [...this.entries.values()].map(entry => this.summary(entry));
  }
  get(id = this.activeId): ManagedConnection {
    const entry = id && this.entries.get(id);
    if (!entry || entry.closing || !entry.client?.running) throw new Error('请先打开项目并连接 Pi。');
    return entry;
  }
  private isBusy(entry: ManagedConnection): boolean { return Boolean(entry.connecting || entry.mutation || entry.redirect || entry.client?.busy); }
  private changed(): void { this.options.onEvent({ type: 'connections_changed', connections: this.list(), activeConnectionId: this.activeId }); }
  private emit(entry: ManagedConnection, event: RpcRecord): void {
    if (this.entries.get(entry.id) !== entry) return;
    entry.lastActivity = Date.now();
    if (event.type === 'connection_status') entry.status = event.status;
    this.options.onEvent({ ...event, connectionId: entry.id, project: entry.project });
    if (event.type === 'agent_start' && entry.redirect?.phase === 'stopping' && !entry.redirect.signal.signal.aborted && !entry.redirect.extraAbort) {
      // A prompt that was still in preflight when Stop arrived can start late.
      // Interrupt that old run too; the replacement prompt uses submitting phase.
      const control = entry.redirect;
      control.extraAbort = entry.client!.request({ type: 'abort' }, 60_000);
      void control.extraAbort.catch(() => {});
    }
    if (event.type === 'connection_status' || activityEvents.has(event.type)) this.changed();
    if (event.type === 'agent_settled' && !entry.closing) {
      const revision = entry.revision;
      void this.refreshState(entry, revision).catch(() => {});
    }
  }
  private async refreshState(entry: ManagedConnection, revision = entry.revision, state?: RpcRecord): Promise<RpcRecord> {
    const snapshot = state ?? await entry.client!.request({ type: 'get_state' });
    if (this.entries.get(entry.id) !== entry || entry.closing || revision !== entry.revision) return snapshot;
    const sessionPath = typeof snapshot.sessionFile === 'string' ? snapshot.sessionFile : undefined;
    const sessionName = typeof snapshot.sessionName === 'string' ? snapshot.sessionName : undefined;
    if (sessionPath !== entry.sessionPath || sessionName !== entry.sessionName) {
      entry.sessionPath = sessionPath;
      entry.sessionName = sessionName;
      this.changed();
    }
    await this.options.onState?.(entry, snapshot, revision);
    return snapshot;
  }
  private async snapshot(entry: ManagedConnection): Promise<Connection> {
    if (entry.changingSession && entry.mutationDone) await entry.mutationDone;
    const revision = entry.revision;
    const [state, messages, models, commands, stats] = await Promise.all([
      entry.client!.request({ type: 'get_state' }), entry.client!.request({ type: 'get_messages' }),
      entry.client!.request({ type: 'get_available_models' }), entry.client!.request({ type: 'get_commands' }),
      entry.client!.request({ type: 'get_session_stats' }),
    ]);
    if (entry.closing || this.entries.get(entry.id) !== entry) throw new Error('会话已断开。');
    await this.refreshState(entry, revision, state);
    return { connectionId: entry.id, project: entry.project, state, messages: messages.messages ?? [], models: models.models ?? [], commands: commands.commands ?? [], stats };
  }
  async connect(project: string, sessionPath?: string, options: ConnectOptions = {}): Promise<Connection> {
    if (this.stopping) throw new Error('Pi Desktop 正在退出。');
    if (options.connectionId) {
      const named = this.entries.get(options.connectionId);
      if (named && sessionPath && named.changingSession && named.mutationDone) {
        await named.mutationDone;
        return this.connect(project, sessionPath, options);
      }
      if (named && (!samePath(named.project, project) || (sessionPath && !this.ownsSession(named, sessionPath)) || options.newSession)) throw new Error('这个缓存会话 ID 已被另一个项目或会话使用。');
      if (named?.closingPromise) {
        await named.closingPromise;
        return this.connect(project, sessionPath, options);
      }
      if (named && (named.connecting || named.client?.running)) return options.background ? named.connecting ?? this.snapshot(named) : this.activate(named.id);
    }
    if (!options.newSession) {
      if (sessionPath) {
        const closing = [...this.entries.values()].find(entry => entry.closing && this.ownsSession(entry, sessionPath!));
        if (closing?.closingPromise) {
          await closing.closingPromise;
          return this.connect(project, sessionPath, options);
        }
      }
      const candidates = [...this.entries.values()].filter(entry => !entry.closing && samePath(entry.project, project) && (entry.connecting || entry.client?.running));
      const targetSession = sessionPath;
      const existing = targetSession
        ? candidates.find(entry => this.ownsSession(entry, targetSession))
        : options.connectionId ? undefined : candidates.find(entry => entry.id === this.activeId) ?? candidates.sort((a, b) => b.selectionOrder - a.selectionOrder)[0];
      if (existing) {
        if (targetSession && existing.changingSession && existing.mutationDone) {
          await existing.mutationDone;
          return this.connect(project, targetSession, options);
        }
        if (options.restoring && options.connectionId && existing.id !== options.connectionId) throw new Error('同一会话已由另一标签恢复，请切换到该标签；本地视图缓存仍会保留。');
        return options.background ? existing.connecting ?? this.snapshot(existing) : this.activate(existing.id);
      }
    } else sessionPath = undefined;
    const entry: ManagedConnection = { id: options.connectionId ?? randomUUID(), project, sessionPath, status: 'connecting', lastActivity: Date.now(), selectionOrder: options.background ? 0 : ++this.selectionOrder, revision: 0, mutation: false, closing: false };
    this.entries.set(entry.id, entry);
    if (!options.background) this.activeId = entry.id;
    // Reserve the session path synchronously before invoking an asynchronous launcher.
    entry.connecting = Promise.resolve().then(() => this.start(entry));
    this.changed();
    try { return await entry.connecting; }
    finally { entry.connecting = undefined; this.changed(); }
  }
  private async start(entry: ManagedConnection): Promise<Connection> {
    this.emit(entry, { type: 'connection_status', status: 'connecting' });
    try {
      entry.client = await this.options.createClient(entry.project, entry.sessionPath, event => this.emit(entry, event));
      if (entry.closing || this.stopping) throw new Error('连接已取消。');
      entry.client.start();
      const result = await this.snapshot(entry);
      this.emit(entry, { type: 'connection_status', status: 'connected' });
      return result;
    } catch (error) {
      await entry.client?.stop();
      this.emit(entry, { type: 'connection_status', status: 'error', message: (error as Error).message });
      this.entries.delete(entry.id);
      if (this.activeId === entry.id) this.activeId = this.fallbackActive();
      this.changed();
      throw error;
    }
  }
  /** Select an already cached chat without transferring its history or waiting for Pi. */
  select(id: string): ConnectionSummary {
    const entry = this.entries.get(id);
    if (!entry || entry.closing || (!entry.connecting && !entry.client?.running)) throw new Error('这个会话已经断开，请重新打开。');
    this.activeId = entry.id;
    entry.selectionOrder = ++this.selectionOrder;
    this.changed();
    return this.summary(entry);
  }
  async activate(id: string): Promise<Connection> {
    this.select(id);
    const entry = this.entries.get(id)!;
    return entry.connecting ?? this.snapshot(entry);
  }
  private fallbackActive(): string | undefined {
    return [...this.entries.values()].filter(entry => !entry.closing && (entry.connecting || entry.client?.running)).sort((a, b) => b.selectionOrder - a.selectionOrder)[0]?.id;
  }
  assertIdle(entry: ManagedConnection): void {
    if (this.isBusy(entry)) throw new Error('这个会话正在执行任务或切换设置，请等待完成后再操作。');
  }
  private ownsSession(entry: ManagedConnection, path: string): boolean {
    return [entry.sessionPath, ...(entry.reservedSessionPaths ?? [])].some(candidate => Boolean(candidate && samePath(candidate, path)));
  }
  private redirectEvent(entry: ManagedConnection, request: RedirectRequest, status: string, error?: string): void {
    this.emit(entry, { type: 'redirect_update', requestId: request.id, status, message: request.prompt.message, ...(error ? { error } : {}) });
    this.changed();
  }
  async redirect(prompt: RedirectPrompt, id?: string): Promise<RedirectResult> {
    const entry = this.get(id);
    if (entry.connecting || (entry.mutation && entry.mutationType !== 'compact')) throw new Error('这个会话正在切换设置，请等待完成后再调整。');
    if (!entry.client!.hasSessionControls) throw new Error('当前 Pi 连接未加载桌面中断适配器，无法保证清除旧排队要求。请使用新版内置 Pi 重新连接后立即调整。');
    const signature = JSON.stringify(prompt);
    if (entry.redirect?.latest.signature === signature && !entry.redirect.signal.signal.aborted) return entry.redirect.latest.promise;
    let resolve!: (result: RedirectResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RedirectResult>((yes, no) => { resolve = yes; reject = no; });
    const request: RedirectRequest = { id: randomUUID(), prompt, signature, promise, resolve, reject };
    let control = entry.redirect;
    if (control) {
      control.latest.resolve({ requestId: control.latest.id, status: 'superseded', superseded: true });
      control.latest = request;
    } else {
      control = { latest: request, signal: new AbortController(), phase: 'stopping', revision: entry.revision };
      entry.redirect = control;
      const worker = control;
      void Promise.resolve().then(() => this.runRedirect(entry, worker));
    }
    // Every accepted ticket first announces itself, including an idle session.
    this.redirectEvent(entry, request, 'stopping');
    return promise;
  }
  private validRedirect(entry: ManagedConnection, control: RedirectControl): boolean {
    return !control.signal.signal.aborted && !entry.closing && this.entries.get(entry.id) === entry && entry.redirect === control && entry.revision === control.revision && Boolean(entry.client?.running);
  }
  private ensureRedirect(entry: ManagedConnection, control: RedirectControl): boolean {
    if (control.signal.signal.aborted || entry.redirect !== control) return false;
    if (!this.validRedirect(entry, control)) throw new Error('会话已断开或变更；新的要求尚未发送。');
    return true;
  }
  private async runRedirect(entry: ManagedConnection, control: RedirectControl): Promise<void> {
    try {
      while (this.ensureRedirect(entry, control)) {
        control.phase = 'stopping';
        await entry.client!.request({ type: 'abort' }, 60_000);
        if (!this.ensureRedirect(entry, control)) return;
        await entry.client!.waitForIdle({ signal: control.signal.signal, timeoutMs: 60_000 });
        if (control.extraAbort) { await control.extraAbort; control.extraAbort = undefined; }
        if (entry.mutationDone) await entry.mutationDone;
        if (!this.ensureRedirect(entry, control)) return;
        const request = control.latest;
        control.phase = 'submitting';
        this.redirectEvent(entry, request, 'submitting');
        if (!this.ensureRedirect(entry, control)) return;
        await entry.client!.request({ type: 'prompt', message: request.prompt.message, ...(request.prompt.images?.length ? { images: request.prompt.images } : {}) }, 10 * 60_000);
        if (!this.ensureRedirect(entry, control)) return;
        if (control.latest !== request) continue;
        request.resolve({ requestId: request.id, status: 'submitted' });
        this.redirectEvent(entry, request, 'submitted');
        if (control.latest !== request) continue;
        return;
      }
    } catch (error) {
      if (entry.redirect === control && !control.signal.signal.aborted) {
        const failure = error instanceof Error ? error : new Error(String(error));
        control.latest.reject(failure);
        this.redirectEvent(entry, control.latest, 'error', failure.message);
      }
    } finally {
      if (entry.redirect === control) { entry.redirect = undefined; this.changed(); }
    }
  }
  private cancelRedirect(entry: ManagedConnection): void {
    const control = entry.redirect;
    if (!control) return;
    control.signal.abort();
    entry.redirect = undefined;
    control.latest.resolve({ requestId: control.latest.id, status: 'cancelled', cancelled: true });
    this.redirectEvent(entry, control.latest, 'cancelled');
  }
  async rpc(command: RpcRecord, id?: string): Promise<RpcRecord> {
    const entry = this.get(id);
    if (command.type === 'abort') this.cancelRedirect(entry);
    if (entry.redirect && ['prompt', 'steer', 'follow_up', 'bash'].includes(command.type)) throw new Error('正在中断并调整当前任务，请等待交接完成后再发送。');
    const exclusive = exclusiveCommands.has(command.type);
    let finishMutation: (() => void) | undefined;
    if (!exclusive && (entry.connecting || entry.mutation) && ['prompt', 'steer', 'follow_up', 'bash'].includes(command.type)) throw new Error('这个会话正在切换设置，请等待完成后再发送。');
    if (exclusive) {
      this.assertIdle(entry);
      if (command.type === 'switch_session' && typeof command.sessionPath === 'string') {
        const owner = [...this.entries.values()].find(other => other !== entry && (other.connecting || other.client?.running || other.closingPromise) && this.ownsSession(other, command.sessionPath));
        if (owner) throw new Error('目标会话已经打开，请切换到该会话，避免重复写入。');
      }
      entry.mutation = true;
      entry.mutationType = command.type;
      entry.mutationDone = new Promise<void>(resolve => { finishMutation = resolve; });
      if (sessionCommands.has(command.type)) {
        entry.changingSession = true;
        entry.revision++;
        // Reserve the target while Pi switches, closing a concurrent connect race.
        if (command.type === 'switch_session') entry.reservedSessionPaths = [command.sessionPath];
      }
    }
    const revision = entry.revision;
    entry.lastActivity = Date.now();
    try {
      const pending = entry.client!.request(command, longCommands.has(command.type) ? 10 * 60_000 : 60_000);
      this.changed();
      const data = await pending;
      if (sessionCommands.has(command.type) || command.type === 'set_session_name') await this.refreshState(entry, revision);
      if (command.type === 'get_state' && !entry.mutation) await this.refreshState(entry, revision, data);
      return data;
    } catch (error) {
      if (sessionCommands.has(command.type) && entry.client?.running) await this.refreshState(entry, revision).catch(() => {});
      throw error;
    } finally {
      if (exclusive) {
        entry.mutation = false;
        entry.mutationType = undefined;
        entry.changingSession = false;
        entry.reservedSessionPaths = undefined;
        entry.mutationDone = undefined;
        finishMutation?.();
      }
      this.changed();
    }
  }
  respondUI(response: RpcRecord, id?: string): void { this.get(id).client!.send(response); }
  async disconnect(id = this.activeId): Promise<void> {
    const entry = id && this.entries.get(id);
    if (!entry) return;
    if (entry.closingPromise) return entry.closingPromise;
    this.cancelRedirect(entry);
    entry.closing = true;
    entry.revision++;
    entry.closingPromise = Promise.resolve().then(async () => {
      this.emit(entry, { type: 'connection_status', status: 'disconnecting' });
      if (entry.connecting) await entry.connecting.catch(() => {});
      await entry.client?.stop();
      this.entries.delete(entry.id);
      if (this.activeId === entry.id) this.activeId = this.fallbackActive();
      this.changed();
    });
    return entry.closingPromise;
  }
  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.entries.keys()].map(id => this.disconnect(id)));
  }
}
