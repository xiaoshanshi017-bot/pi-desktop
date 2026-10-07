// Process-local controls for the pinned Pi 0.84.2 session implementation.
// The installed SDK and user settings stay untouched.
import { AsyncLocalStorage } from 'node:async_hooks';
const installed = Symbol.for('pi-desktop.session-controls');

export function installDesktopSessionControls(AgentSession) {
  const prototype = AgentSession?.prototype;
  if (!prototype || ['abort', 'clearQueue', 'abortCompaction', 'abortBash', 'prompt', '_runAgentPrompt'].some(name => typeof prototype[name] !== 'function')) throw new Error('内置 Pi 的任务中断接口不兼容，请修复运行环境。');
  if (prototype[installed]) return;
  const abort = prototype.abort;
  const prompt = prototype.prompt;
  const runPrompt = prototype._runAgentPrompt;
  const scopes = new AsyncLocalStorage();
  const generations = new WeakMap();
  Object.defineProperty(prototype, 'prompt', {
    configurable: true, writable: true,
    value: function (...args) {
      return scopes.run({ session: this, generation: generations.get(this) || 0 }, () => Reflect.apply(prompt, this, args));
    },
  });
  Object.defineProperty(prototype, '_runAgentPrompt', {
    configurable: true, writable: true,
    value: async function (...args) {
      const scope = scopes.getStore();
      if (scope?.session === this && scope.generation !== (generations.get(this) || 0)) throw new Error('任务已停止，未开始的旧请求已取消。');
      return await Reflect.apply(runPrompt, this, args);
    },
  });
  Object.defineProperty(prototype, 'abort', {
    configurable: true, writable: true,
    value: async function (...args) {
      generations.set(this, (generations.get(this) || 0) + 1);
      // Stop cancels queued work as well as the current agent turn. Compaction
      // and direct RPC Bash use separate abort controllers in Pi 0.84.2.
      this.clearQueue();
      this.abortCompaction();
      this.abortBash();
      return await Reflect.apply(abort, this, args);
    },
  });
  Object.defineProperty(prototype, installed, { value: true });
}
