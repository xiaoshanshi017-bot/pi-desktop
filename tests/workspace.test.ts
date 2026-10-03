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
