import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Connection } from '../shared/types';
import { applyConversationEvent, emptyConversation, findOpenConversation, receiveConnection } from '../src/workspace';

function snapshot(id = 'A', sessionId = 'session-A'): Connection {
  return { connectionId: id, project: 'C:/project', state: { sessionId, sessionFile: `C:/sessions/${sessionId}.jsonl`, isStreaming: false }, messages: [], models: [], commands: [], stats: {} };
}

test('interleaved conversation deltas, tools and completion notices remain in their own view', () => {
  let a = receiveConnection(undefined, snapshot());
  let b = receiveConnection(undefined, snapshot('B', 'session-B'));
  a = applyConversationEvent(a, { type: 'agent_start' }, 100, true);
  a = applyConversationEvent(a, { type: 'message_start', message: { role: 'assistant', timestamp: 101, content: [] } }, 101, true);
  b = applyConversationEvent(b, { type: 'message_start', message: { role: 'assistant', timestamp: 102, content: [] } }, 102);
  a = applyConversationEvent(a, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Only A' } }, 103, true);
  b = applyConversationEvent(b, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Only B' } }, 104);
  a = applyConversationEvent(a, { type: 'tool_execution_start', toolCallId: 'tool-A', toolName: 'bash', args: { command: 'command A' } }, 105, true);
  a = applyConversationEvent(a, { type: 'tool_execution_update', toolCallId: 'tool-A', partialResult: { content: [{ type: 'text', text: 'A log' }] } }, 106, true);
  assert.equal(a.messages[0].content[0].text, 'Only A');
  assert.equal(b.messages[0].content[0].text, 'Only B');
  assert.ok(a.tools['tool-A']);
  assert.deepEqual(b.tools, {});
  assert.equal(a.unread, false);
  a = applyConversationEvent(a, { type: 'agent_settled' }, 110, true);
  assert.equal(a.unread, true);
  assert.equal(a.busy, false);
  assert.equal(b.unread, false);
});

test('switching back merges live text with authoritative history and preserves draft, attachments and execution records', () => {
  let previous = receiveConnection(undefined, snapshot(), 'Draft A');
  previous.attachments = [{ name: 'local.txt', path: 'local.txt', type: 'text', content: 'attached' }];
  previous = applyConversationEvent(previous, { type: 'agent_start' }, 100);
  previous = applyConversationEvent(previous, { type: 'message_start', message: { role: 'assistant', timestamp: 101, content: [{ type: 'text', text: 'streamed text' }] } }, 101);
  const connection = snapshot();
  connection.state.isStreaming = true;
  connection.messages = [{ role: 'user', timestamp: 90, content: [{ type: 'text', text: 'history' }] }];
  const next = receiveConnection(previous, connection, 'Stale disk draft');
  assert.equal(next.messages.length, 2);
  assert.equal(next.messages[0].content[0].text, 'history');
  assert.equal(next.messages[1].content[0].text, 'streamed text');
  assert.equal(next.draft, 'Draft A');
  assert.deepEqual(next.attachments, previous.attachments);
  assert.deepEqual(next.progress, previous.progress);
  connection.messages.push({ role: 'assistant', timestamp: 101, content: [] });
  assert.equal(receiveConnection(previous, connection).messages.length, 2, 'already-present assistant is replaced, not duplicated');
});

test('restoring a session keeps cached reply and tool records missing from the native JSONL history', () => {
  const previous = receiveConnection(undefined, snapshot(), 'Unsent draft');
  previous.restoring = true;
  previous.messages = [
    { role: 'user', timestamp: 90, content: [{ type: 'text', text: 'saved user' }] },
    { role: 'assistant', timestamp: 91, content: [{ type: 'text', text: 'reply received before JSONL write' }, { type: 'toolCall', id: 'cache-tool', name: 'bash', arguments: { command: 'recorded only' } }] },
    { role: 'toolResult', timestamp: 92, toolCallId: 'cache-tool', content: [{ type: 'text', text: 'saved tool output' }] },
  ];
  const connection = snapshot();
  connection.messages = [{ role: 'user', timestamp: 90, content: [{ type: 'text', text: 'authoritative user' }] }];
  const restored = receiveConnection(previous, connection);
  assert.equal(restored.messages.length, 3);
  assert.equal(restored.messages[0].content[0].text, 'authoritative user');
  assert.equal(restored.messages[0]._cachedOnly, undefined);
  assert.equal(restored.messages[1].content[0].text, 'reply received before JSONL write');
  assert.equal(restored.messages[1]._cachedOnly, true);
  assert.equal(restored.messages[1]._streaming, false);
  assert.equal(restored.messages[1].stopReason, 'aborted');
  assert.equal(restored.messages[2].toolCallId, 'cache-tool');
  assert.equal(restored.messages[2]._cachedOnly, true);
  assert.equal(restored.busy, false);
  assert.deepEqual(restored.queue, { steering: [], followUp: [] });
  assert.deepEqual(restored.dialogs, []);
});

test('cached-only history survives later idle refreshes and yields to native records when they arrive', () => {
  const previous = receiveConnection(undefined, snapshot());
  previous.restoring = true;
  previous.messages = [{ role: 'assistant', timestamp: 91, content: [{ type: 'text', text: 'cached partial reply' }] }];
  const connection = snapshot();
  let restored = receiveConnection(previous, connection);
  restored.restoring = false;
  restored = receiveConnection(restored, connection);
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0]._cachedOnly, true);
  connection.messages = [{ role: 'assistant', timestamp: 91, content: [{ type: 'text', text: 'completed native reply' }], stopReason: 'stop' }];
  const reconciled = receiveConnection(restored, connection, '', true);
  assert.equal(reconciled.messages.length, 1);
  assert.equal(reconciled.messages[0].content[0].text, 'completed native reply');
  assert.equal(reconciled.messages[0]._cachedOnly, undefined);
  assert.equal(reconciled.messages[0].stopReason, 'stop');
});

test('cached-only records stay out of a new session or fork sharing the same desktop connection', () => {
  const previous = receiveConnection(undefined, snapshot());
  previous.restoring = true;
  previous.messages = [{ role: 'assistant', timestamp: 91, _cachedOnly: true, content: [{ type: 'text', text: 'original-session-only' }] }];
  const replacement = snapshot('A', 'another-session');
  replacement.messages = [{ role: 'user', timestamp: 92, content: [{ type: 'text', text: 'new-session-only' }] }];
  const next = receiveConnection(previous, replacement);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].content[0].text, 'new-session-only');
  assert.equal(next.messages[0]._cachedOnly, undefined);
});

test('a different session in the same runtime starts with its own stored draft and clears prior tool and queue state', () => {
  const previous = receiveConnection(undefined, snapshot(), 'Previous draft');
  previous.attachments = [{ name: 'private.txt', path: 'private.txt', type: 'text', content: 'prior attachment' }];
  previous.tools = { old: { status: 'running' } };
  previous.queue = { steering: ['old request'], followUp: [] };
  const next = receiveConnection(previous, snapshot('A', 'forked-session'), 'Fork draft');
  assert.equal(next.draft, 'Fork draft');
  assert.deepEqual(next.attachments, []);
  assert.deepEqual(next.tools, {});
  assert.deepEqual(next.queue.steering, []);
});

test('background confirmation and disconnect preserve another conversation and mark only the requesting one', () => {
  const a = receiveConnection(undefined, snapshot());
  const b = receiveConnection(undefined, snapshot('B', 'session-B'), 'B draft');
  const waiting = applyConversationEvent(a, { type: 'extension_ui_request', id: 'confirm-A', method: 'confirm', title: 'Continue A?' }, 100, true);
  assert.equal(waiting.dialogs[0].id, 'confirm-A');
  assert.equal(waiting.unread, true);
  assert.equal(b.dialogs.length, 0);
  const disconnected = applyConversationEvent(waiting, { type: 'connection_status', status: 'disconnected' }, 200, true);
  assert.equal(disconnected.busy, false);
  assert.deepEqual(disconnected.dialogs, []);
  assert.equal(b.draft, 'B draft');
  assert.equal(b.status, 'connected');
});

test('redirect lifecycle follows only the newest request and preserves a fresh editor on cancellation or failure', () => {
  let view = receiveConnection(undefined, snapshot());
  view.draft = 'new draft typed after the redirect';
  view.attachments = [{ name: 'new.txt', path: 'new.txt', type: 'text', content: 'fresh attachment' }];
  view = applyConversationEvent(view, { type: 'redirect_update', requestId: 'old', status: 'stopping', message: 'older instruction' }, 100);
  view = applyConversationEvent(view, { type: 'redirect_update', requestId: 'latest', status: 'stopping', message: 'latest instruction' }, 110);
  const newest = view;
  for (const status of ['submitting', 'submitted', 'cancelled', 'error']) {
    assert.equal(applyConversationEvent(view, { type: 'redirect_update', requestId: 'old', status, message: 'outdated instruction', error: 'old failure' }, 120), newest);
  }
  view = applyConversationEvent(view, { type: 'redirect_update', requestId: 'latest', status: 'error', error: 'cannot stop command' }, 130);
  assert.equal(view.redirect?.status, 'error');
  assert.equal(view.redirect?.message, 'latest instruction');
  assert.equal(view.redirect?.error, 'cannot stop command');
  assert.equal(view.draft, newest.draft);
  assert.equal(view.attachments, newest.attachments);
  assert.equal(view.notice?.kind, 'error');
  assert.equal(applyConversationEvent(view, { type: 'redirect_update', requestId: 'latest', status: 'submitting' }, 140), view, 'terminal requests cannot become pending again');
  view = applyConversationEvent(view, { type: 'redirect_update', requestId: 'next', status: 'stopping', message: 'next instruction' }, 150);
  view = applyConversationEvent(view, { type: 'redirect_update', requestId: 'next', status: 'cancelled' }, 160);
  assert.equal(view.redirect?.status, 'cancelled');
  assert.equal(view.redirect?.message, 'next instruction');
  assert.equal(view.draft, newest.draft);
  assert.equal(view.attachments, newest.attachments);
});

test('normal assistant aborts retain their history while genuine errors still create an error notice', () => {
  let view = receiveConnection(undefined, snapshot());
  view = applyConversationEvent(view, { type: 'agent_start' }, 100);
  view = applyConversationEvent(view, { type: 'message_end', message: { role: 'assistant', timestamp: 101, content: [], stopReason: 'aborted', errorMessage: 'Request aborted by user' } }, 101);
  assert.equal(view.notice, null);
  assert.equal(view.messages[0].errorMessage, 'Request aborted by user', 'the original SDK record stays available');
  assert.equal(view.progress?.assistantError, undefined);
  view = applyConversationEvent(view, { type: 'agent_settled' }, 102);
  assert.equal(view.progress?.phase, 'interrupted');
  view = applyConversationEvent(view, { type: 'agent_start' }, 103);
  view = applyConversationEvent(view, { type: 'message_end', message: { role: 'assistant', timestamp: 104, content: [], stopReason: 'error', errorMessage: 'provider unavailable' } }, 104);
  assert.equal(view.notice?.kind, 'error');
  assert.equal(view.notice?.text, 'provider unavailable');
});

test('the real SDK error-shaped cancellation never leaves a red notice across the fresh redirected run', () => {
  let view = receiveConnection(undefined, snapshot());
  view = applyConversationEvent(view, { type: 'agent_start' }, 100);
  view = applyConversationEvent(view, { type: 'redirect_update', requestId: 'sample-redirect', status: 'stopping', message: 'new requirement' }, 101);
  const sdkMessage = { role: 'assistant', content: [{ type: 'text', text: 'received partial reply' }], api: 'openai-completions', provider: 'redirect-fixture', model: 'redirect-fixture', stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 102 };
  view = applyConversationEvent(view, { type: 'message_end', message: sdkMessage }, 102);
  assert.equal(view.notice, null);
  assert.equal(view.messages[0].stopReason, 'error', 'the original SDK outcome remains in its history record');
  assert.equal(view.messages[0].content[0].text, 'received partial reply');
  assert.equal(view.progress?.assistantError, undefined);
  view = applyConversationEvent(view, { type: 'agent_settled' }, 103);
  assert.equal(view.progress?.phase, 'interrupted');
  // A desktop upgraded during an existing run may still hold the old notice.
  view.notice = { kind: 'error', text: 'This operation was aborted' };
  view = applyConversationEvent(view, { type: 'agent_start' }, 104);
  assert.equal(view.notice, null);
  view = applyConversationEvent(view, { type: 'message_end', message: { role: 'assistant', timestamp: 105, content: [{ type: 'text', text: 'new task completed' }], stopReason: 'stop' } }, 105);
  view = applyConversationEvent(view, { type: 'agent_settled' }, 106);
  assert.equal(view.notice, null);
  assert.equal(view.progress?.phase, 'complete');
  view.notice = { kind: 'error', text: 'provider unavailable' };
  view = applyConversationEvent(view, { type: 'agent_start' }, 107);
  assert.equal(view.notice?.text, 'provider unavailable', 'normal continuation does not erase another real error');
});

test('session controls capability belongs to the current process and is retained across a session change', () => {
  let view = receiveConnection(undefined, snapshot());
  assert.equal(view.sessionControls, false);
  view = applyConversationEvent(view, { type: 'desktop_capabilities', sessionControls: true }, 100);
  assert.equal(view.sessionControls, true);
  const replacement = receiveConnection(view, snapshot('A', 'new-session'));
  assert.equal(replacement.sessionControls, true);
  assert.equal(replacement.sendMode, 'redirect');
  assert.equal(applyConversationEvent(replacement, { type: 'connection_status', status: 'connecting' }, 101).sessionControls, false);
  assert.equal(applyConversationEvent(replacement, { type: 'connection_status', status: 'disconnected' }, 101).sessionControls, false);
});

test('events received before the connection snapshot keep real progress while hydrating the saved draft', () => {
  const pending = applyConversationEvent(emptyConversation('A', 'C:/project'), { type: 'agent_start' }, 100, true);
  const connection = snapshot();
  connection.state.isStreaming = true;
  const loaded = receiveConnection(pending, connection, 'Stored draft');
  assert.equal(loaded.progress?.startedAt, 100);
  assert.equal(loaded.draft, 'Stored draft');
});

test('activation snapshots captured before completion cannot revive busy state or erase the final result', () => {
  let previous = receiveConnection(undefined, snapshot());
  previous = applyConversationEvent(previous, { type: 'agent_start' }, 100);
  const stale = snapshot();
  stale.state.isStreaming = true;
  stale.messages = [{ role: 'assistant', timestamp: 101, content: [{ type: 'text', text: 'old partial' }] }];
  previous = applyConversationEvent(previous, { type: 'message_end', message: { role: 'assistant', timestamp: 101, content: [{ type: 'text', text: 'final complete result' }] } }, 150, true);
  previous = applyConversationEvent(previous, { type: 'agent_settled' }, 151, true);
  const loaded = receiveConnection(previous, stale, '', true);
  assert.equal(loaded.busy, false);
  assert.equal(loaded.state.isStreaming, false);
  assert.equal(loaded.messages[0].content[0].text, 'final complete result');
  assert.equal(loaded.progress?.endedAt, 151);
});

test('opened history and project navigation reuse only hydrated live conversations', () => {
  const a = receiveConnection(undefined, snapshot());
  const b = receiveConnection(undefined, snapshot('B', 'session-B'));
  const loading = emptyConversation('loading', 'C:/project');
  loading.status = 'connected';
  const views = { A: a, B: b, loading };
  const connections = Object.values(views).map((view, index) => ({ id: view.id, project: view.project, sessionPath: view.state.sessionFile, status: view.status, busy: false, lastActivity: index }));
  assert.equal(findOpenConversation(views, connections, 'c:\\PROJECT', 'c:\\sessions\\session-A.jsonl'), 'A');
  assert.equal(findOpenConversation(views, connections, 'C:/project', undefined, 'A'), 'A');
  assert.equal(findOpenConversation(views, connections, 'C:/project', undefined, 'welcome'), 'B');
  assert.equal(findOpenConversation(views, connections, 'C:/different'), undefined);
  assert.equal(findOpenConversation(views, connections, 'C:/project', 'C:/sessions/unopened.jsonl'), undefined);
  a.status = 'disconnected';
  assert.equal(findOpenConversation(views, connections, 'C:/project', a.state.sessionFile), undefined);
});

test('large stale history hydration keeps every newer message and tool result without duplicates', () => {
  const connection = snapshot();
  connection.messages = Array.from({ length: 2_000 }, (_, timestamp) => ({ role: timestamp % 2 ? 'assistant' : 'user', timestamp, content: [{ type: 'text', text: `snapshot ${timestamp}` }] }));
  const previous = receiveConnection(undefined, connection);
  previous.messages = previous.messages.map(message => ({ ...message, content: [{ type: 'text', text: `live ${message.timestamp}` }] }));
  const tool = { role: 'toolResult', timestamp: 2001, toolCallId: 'final-tool', content: [{ type: 'text', text: 'complete tool result' }] };
  previous.messages.push(tool);
  const merged = receiveConnection(previous, connection, '', true);
  assert.equal(merged.messages.length, 2_001);
  assert.equal(merged.messages[0], previous.messages[0]);
  assert.equal(merged.messages[1999], previous.messages[1999]);
  assert.equal(merged.messages[2000], tool);
});
