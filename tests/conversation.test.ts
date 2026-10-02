import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMessageEvent, textContent } from '../src/conversation';
import type { RpcRecord } from '../shared/types';

test('message assembler preserves interleaved text, thinking and tool arguments from indexed Pi 0.84 deltas', () => {
  let messages: RpcRecord[] = [];
  const apply = (event: RpcRecord) => { messages = applyMessageEvent(messages, event); };
  const delta = (type: string, contentIndex: number, value: RpcRecord = {}) => apply({ type: 'message_update', assistantMessageEvent: { type, contentIndex, ...value } });
  apply({ type: 'message_start', message: { role: 'assistant', timestamp: 10, content: [] } });
  const original = messages;
  delta('thinking_start', 0);
  delta('thinking_delta', 0, { delta: '先检查' });
  delta('text_start', 1);
  delta('text_delta', 1, { delta: '你好' });
  delta('thinking_delta', 0, { delta: '文件。' });
  delta('text_delta', 1, { delta: ' 😀\u2028下一行' });
  delta('toolcall_start', 2);
  delta('toolcall_delta', 2, { delta: '{"path":' });
  delta('toolcall_delta', 2, { delta: '"中文 文件.txt"}' });
  const toolCall = { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '中文 文件.txt' } };
  delta('toolcall_end', 2, { toolCall });
  apply({ type: 'message_update', usage: { totalTokens: 37 }, assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: '最终文本' } });
  assert.equal(messages[0].content[0].thinking, '先检查文件。');
  assert.equal(textContent(messages[0]), '最终文本');
  assert.deepEqual(messages[0].content[2].arguments, toolCall.arguments);
  assert.equal(messages[0].usage.totalTokens, 37);
  assert.deepEqual(original[0].content, [], 'previous render state must remain immutable');
  const authoritative = { role: 'assistant', timestamp: 10, content: [{ type: 'text', text: '完整最终回复' }], stopReason: 'stop' };
  apply({ type: 'message_end', message: authoritative });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { ...authoritative, _streaming: false });
});

test('message assembler keeps user, assistant and tool results distinct, including extension messages without a start', () => {
  let messages: RpcRecord[] = [];
  const apply = (event: RpcRecord) => { messages = applyMessageEvent(messages, event); };
  const user = { role: 'user', content: '需求', timestamp: 10 };
  const assistant = { role: 'assistant', content: [{ type: 'text', text: '回应' }], timestamp: 20 };
  const tool = { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: '完成' }], timestamp: 30 };
  for (const message of [user, assistant, tool]) {
    apply({ type: 'message_start', message });
    apply({ type: 'message_end', message });
  }
  apply({ type: 'message_end', message: tool });
  assert.equal(messages.length, 3, 'a repeated completed snapshot should not duplicate a message');
  apply({ type: 'message_end', message: { role: 'custom', customType: 'notice', content: '扩展信息', timestamp: 40 } });
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'toolResult', 'custom']);
  assert.equal(textContent(messages[0]), '需求');
});
