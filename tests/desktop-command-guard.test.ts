import assert from 'node:assert/strict';
import { test } from 'node:test';
import guard, { DEFAULT_BASH_TIMEOUT_SECONDS } from '../electron/desktop-command-guard.mjs';

function fixture() {
  const handlers = new Map<string, Function>();
  guard({ on: (name: string, handler: Function) => handlers.set(name, handler) });
  return handlers;
}

test('desktop default bounds missing Bash limits without overriding explicit long tasks or validation errors', () => {
  const onCall = fixture().get('tool_call')!;
  const missing = { toolName: 'bash', input: { command: 'node sample.js' } };
  onCall(missing);
  assert.equal((missing.input as any).timeout, 300);
  assert.equal(DEFAULT_BASH_TIMEOUT_SECONDS, 300);
  for (const timeout of [0.25, 1800, 0, -1, null]) {
    const event = { toolName: 'bash', input: { command: 'original command', timeout } };
    onCall(event);
    assert.deepEqual(event.input, { command: 'original command', timeout });
  }
  const read = { toolName: 'read', input: { path: 'test.txt' } };
  onCall(read);
  assert.deepEqual(read.input, { path: 'test.txt' });
});

test('command limits are disclosed to the model without replacing its existing instructions', () => {
  const result = fixture().get('before_agent_start')!({ systemPrompt: 'Keep existing project instructions.' });
  assert.ok(result.systemPrompt.startsWith('Keep existing project instructions.\n'));
  assert.match(result.systemPrompt, /300 秒/);
  assert.match(result.systemPrompt, /更长时限/);
});
