import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCancelledMessage, SDK_ABORT_ERROR } from '../src/cancellation';

test('the exact observed SDK abort is recognised with empty or partially received content', () => {
  const sample = { role: 'assistant', content: [], api: 'openai-completions', provider: 'redirect-fixture', model: 'redirect-fixture', stopReason: 'error', errorMessage: SDK_ABORT_ERROR, timestamp: 1791370875351 };
  assert.equal(isCancelledMessage(sample), true);
  assert.equal(isCancelledMessage({ ...sample, content: [{ type: 'text', text: 'already received before stopping' }, { type: 'thinking', thinking: 'partial thought' }] }), true);
  assert.equal(isCancelledMessage({ ...sample, stopReason: 'aborted', errorMessage: 'request cancelled' }), true);
});

test('provider failures and strings that merely mention abort are not silently classified as cancellation', () => {
  const sample = { role: 'assistant', stopReason: 'error', errorMessage: SDK_ABORT_ERROR };
  assert.equal(isCancelledMessage({ ...sample, errorMessage: 'Provider aborted the connection unexpectedly' }), false);
  assert.equal(isCancelledMessage({ ...sample, errorMessage: `${SDK_ABORT_ERROR}: provider timeout` }), false);
  assert.equal(isCancelledMessage({ ...sample, errorMessage: 'provider unavailable' }), false);
  assert.equal(isCancelledMessage({ ...sample, role: 'toolResult' }), false);
  assert.equal(isCancelledMessage({ ...sample, stopReason: 'stop' }), false);
  assert.equal(isCancelledMessage(), false);
});
