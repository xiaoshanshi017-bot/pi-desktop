import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDesktopSessionControls } from '../electron/desktop-session-controls.mjs';

test('process-local Stop clears queued work and cancels separate operations before awaiting real idle', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  class Session {
    clearQueue() { calls.push('clearQueue'); }
    abortCompaction() { calls.push('compact'); }
    abortBash() { calls.push('bash'); }
    async abort() { calls.push('abort'); await new Promise<void>(resolve => { finish = resolve; }); calls.push('idle'); }
    async prompt() {}
    async _runAgentPrompt() {}
  }
  installDesktopSessionControls(Session);
  const wrapped = Session.prototype.abort;
  installDesktopSessionControls(Session);
  assert.equal(Session.prototype.abort, wrapped, 'installer wraps a process only once');
  const session = new Session();
  let done = false;
  const stopping = session.abort().then(() => { done = true; });
  assert.deepEqual(calls, ['clearQueue', 'compact', 'bash', 'abort']);
  assert.equal(done, false);
  finish(); await stopping;
  assert.deepEqual(calls, ['clearQueue', 'compact', 'bash', 'abort', 'idle']);
});

test('Stop during asynchronous prompt preflight blocks only the old session prompt and permits a fresh prompt', async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  class Session {
    clearQueue() {} abortCompaction() {} abortBash() {} async abort() {}
    async prompt(message: string) { await new Promise<void>(resolve => { releases.set(message, resolve); }); return this._runAgentPrompt(message); }
    async _runAgentPrompt(message: string) { started.push(message); }
  }
  installDesktopSessionControls(Session);
  const a = new Session(); const b = new Session();
  const old = a.prompt('old A'); const other = b.prompt('B');
  const rejected = assert.rejects(old, /旧请求已取消/);
  await a.abort();
  releases.get('old A')!(); releases.get('B')!();
  await Promise.all([rejected, other]);
  const fresh = a.prompt('fresh A'); releases.get('fresh A')!(); await fresh;
  assert.deepEqual(started, ['B', 'fresh A']);
});
