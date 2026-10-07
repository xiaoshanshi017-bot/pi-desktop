import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { RpcRecord } from '../shared/types';

/** Pi uses LF records, not Unicode line separators. Preserve UTF-8 across chunks. */
export class JsonlDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private readonly onRecord: (line: string) => void) {}
  write(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.flush(false);
    if (this.buffer.length > 64 * 1024 * 1024) throw new Error('Pi RPC 单条消息超过 64 MB。');
  }
  end(): void { this.buffer += this.decoder.end(); this.flush(true); }
  private flush(final: boolean): void {
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.onRecord(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (final && this.buffer) {
      const line = this.buffer;
      this.buffer = '';
      this.onRecord(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }
}

export interface PiRpcOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: RpcRecord) => void;
  requestTimeoutMs?: number;
}
interface Pending {
  command: string;
  resolve: (data: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface IdleWaitOptions { signal?: AbortSignal; timeoutMs?: number }

export class PiRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private streaming = false;
  private unsettled = false;
  private compacting = false;
  private stopped = false;
  private closing?: Promise<void>;
  private stderr = '';
  private alive = false;
  private sessionControls = false;
  private idleWaiters = new Set<{ finish(error?: Error): void }>();
  constructor(private readonly options: PiRpcOptions) {}
  get running(): boolean { return this.alive && !this.stopped; }
  get hasSessionControls(): boolean { return this.sessionControls; }
  get busy(): boolean {
    return this.unsettled || this.streaming || this.compacting || [...this.pending.values()].some(p =>
      ['prompt', 'compact', 'bash', 'fork', 'clone', 'new_session', 'switch_session'].includes(p.command));
  }
  waitForIdle({ signal, timeoutMs = 60_000 }: IdleWaitOptions = {}): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('任务调整已取消。'));
    if (!this.running) return Promise.reject(new Error('Pi 已断开连接。'));
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => waiter.finish(new Error('任务调整已取消。'));
      const timer = setTimeout(() => waiter.finish(new Error('停止旧任务等待超时；新要求尚未发送。')), timeoutMs);
      const waiter = { finish: (error?: Error) => {
        if (!this.idleWaiters.delete(waiter)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      } };
      this.idleWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.checkIdle();
    });
  }
  private checkIdle(): void {
    if (this.running && this.busy) return;
    for (const waiter of [...this.idleWaiters]) waiter.finish(this.running ? undefined : new Error('Pi 已断开连接。'));
  }
  start(): void {
    if (this.child) throw new Error('Pi 进程已经启动。');
    this.stopped = false;
    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd, env: this.options.env ?? process.env,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.alive = true;
    const decoder = new JsonlDecoder(line => this.receive(line));
    child.stdout.on('data', (chunk: Buffer) => {
      try { decoder.write(chunk); } catch (error) { this.fail(error as Error); void this.stop(); }
    });
    child.stdout.on('end', () => {
      try { decoder.end(); } catch (error) { this.fail(error as Error); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => {
      this.alive = false;
      this.fail(new Error(`无法启动 Pi：${error.message}`));
      this.emit({ type: 'connection_status', status: 'error', message: `无法启动 Pi：${error.message}` });
    });
    child.on('close', (code, signal) => {
      const intentional = this.stopped;
      this.alive = false;
      this.streaming = false;
      this.unsettled = false;
      this.compacting = false;
      const detail = this.stderr.trim().replace(/\x1b\[[0-9;]*m/g, '');
      const message = intentional ? 'Pi 已断开连接。' : `Pi 进程退出（${signal ?? code ?? '未知状态'}）。${detail ? `\n${detail}` : ''}`;
      this.fail(new Error(message));
      this.emit({ type: 'connection_status', status: intentional ? 'disconnected' : 'error', message });
    });
  }
  request(command: RpcRecord, timeoutMs = this.options.requestTimeoutMs ?? 45_000): Promise<RpcRecord> {
    if (!this.running || !this.child?.stdin.writable) return Promise.reject(new Error('Pi 尚未连接。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi 指令 ${command.type} 等待超时。任务可能仍在执行，请检查状态或停止任务。`));
        this.checkIdle();
      }, timeoutMs);
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      try { this.send({ ...command, id }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error); this.checkIdle();
      }
    });
  }
  send(command: RpcRecord): void {
    if (!this.running || !this.child?.stdin.writable) throw new Error('Pi 尚未连接。');
    this.child.stdin.write(JSON.stringify(command) + '\n', 'utf8', error => {
      if (error) this.fail(error);
    });
  }
  private receive(line: string): void {
    if (!line.trim()) return;
    let event: RpcRecord;
    try { event = JSON.parse(line); } catch {
      this.emit({ type: 'diagnostic', level: 'warning', message: `忽略了 Pi 的非 JSON 输出：${line.slice(0, 500)}` });
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      if (event.success === false) pending.reject(new Error(event.error || `Pi 指令 ${pending.command} 失败。`));
      else {
        if (pending.command === 'get_state' && event.data) {
          this.streaming = Boolean(event.data.isStreaming);
          this.compacting = Boolean(event.data.isCompacting);
        }
        pending.resolve(event.data ?? {});
      }
      this.checkIdle();
      return;
    }
    if (event.type === 'agent_start') { this.streaming = true; this.unsettled = true; }
    if (event.type === 'desktop_capabilities') this.sessionControls = event.sessionControls === true;
    if (event.type === 'agent_end') this.streaming = false;
    if (event.type === 'agent_settled') { this.streaming = false; this.unsettled = false; }
    if (event.type === 'compaction_start' || event.type === 'auto_compaction_start') this.compacting = true;
    if (event.type === 'compaction_end' || event.type === 'auto_compaction_end') this.compacting = false;
    this.emit(event);
    this.checkIdle();
  }
  private emit(event: RpcRecord): void { this.options.onEvent?.(event); }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of [...this.idleWaiters]) waiter.finish(error);
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.checkIdle();
    const child = this.child;
    if (!child || !this.alive) { this.fail(new Error('Pi 已断开连接。')); return; }
    // Closing stdin lets Pi abort tools, dispose extensions, and save the session.
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 2500); })]);
    if (timer) clearTimeout(timer);
    if (this.alive && child.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill(); resolve(); });
          killer.once('close', () => resolve());
          setTimeout(() => { killer.kill(); resolve(); }, 3000).unref();
        });
      } else child.kill('SIGKILL');
      await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
    }
    this.alive = false;
    this.fail(new Error('Pi 已断开连接。'));
  }
}
