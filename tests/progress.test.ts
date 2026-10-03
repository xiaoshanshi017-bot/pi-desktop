import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProgressEvent, applyToolEvent, interruptTools, outputPreview, type RunProgress } from '../src/progress';
import type { RpcRecord } from '../shared/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCard } from '../src/components/MessageView';

function run() {
  let progress: RunProgress | null = null;
  return (event: RpcRecord, now = 1000) => {
    progress = applyProgressEvent(progress, event, now);
    assert.ok(progress);
    return progress;
  };
}

test('progress distinguishes real thinking, prose and tool preparation deltas and preserves a queued run', () => {
  const apply = run();
  const first = apply({ type: 'prompt_submitted' }, 100);
  assert.equal(apply({ type: 'agent_start' }, 200).startedAt, first.startedAt);
  const delta = (type: string) => apply({ type: 'message_update', assistantMessageEvent: { type, delta: 'private draft' } });
  assert.equal(delta('thinking_delta').phase, 'thinking');
  assert.equal(delta('text_delta').phase, 'responding');
  const preparing = delta('toolcall_delta');
  assert.equal(preparing.phase, 'preparing');
  assert.equal(delta('thinking_end').phase, 'preparing', 'trailing block-end markers cannot revive a completed thinking phase');
  assert.ok(!JSON.stringify(preparing).includes('private draft'), 'internal reasoning must not become a progress report');
  assert.equal(apply({ type: 'queue_update', steering: ['adjust'] }), preparing);
  assert.equal(first.phase, 'thinking', 'old render state stays immutable');
});

test('parallel tool progress remains active until every actual result is received, and failures may be recovered', () => {
  const apply = run();
  apply({ type: 'agent_start' });
  apply({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'read', args: { path: '中文.txt' } });
  const before = apply({ type: 'tool_execution_start', toolCallId: 'two', toolName: 'bash', args: { command: 'test' } });
  const result = apply({ type: 'tool_execution_end', toolCallId: 'two', isError: true }, 2200);
  assert.equal(result.phase, 'tool');
  assert.equal(result.detail, '中文.txt');
  assert.equal(result.completedTools, 1);
  assert.equal(result.failedTools, 1);
  assert.equal(before.steps.find(step => step.id === 'two')?.status, 'running');
  assert.equal(apply({ type: 'tool_execution_end', toolCallId: 'two', isError: true }).completedTools, 1, 'duplicate final events do not inflate counts');
  assert.equal(apply({ type: 'tool_execution_end', toolCallId: 'one', isError: false }).phase, 'waiting');
  const settled = apply({ type: 'agent_settled' }, 3000);
  assert.equal(settled.phase, 'complete', 'a recovered tool error does not mean the entire run failed');
  assert.equal(settled.completedTools, 2);
  assert.equal(settled.endedAt, 3000);
});

test('stop and disconnect leave unfinished tools unconfirmed, never completed or spinning forever', () => {
  for (const ending of [{ type: 'connection_status', status: 'error' }, { type: 'agent_settled' }]) {
    const apply = run();
    apply({ type: 'agent_start' });
    apply({ type: 'tool_execution_start', toolCallId: 'pending', toolName: 'bash', args: {} });
    apply({ type: 'stop_requested' });
    assert.equal(apply({ type: 'tool_execution_update', toolCallId: 'pending' }).phase, 'stopping');
    const stopped = apply(ending, 2000);
    assert.equal(stopped.phase, 'interrupted');
    assert.equal(stopped.completedTools, 0);
    assert.equal(stopped.steps.find(step => step.id === 'pending')?.status, 'interrupted');
    assert.equal(apply({ type: 'agent_settled' }, 2200), stopped, 'late events cannot turn an interruption into success');
  }
});

test('tool updates use cumulative snapshots, preserve timestamps and replace partial output with authoritative results', () => {
  let tools: Record<string, RpcRecord> = {};
  tools = applyToolEvent(tools, { type: 'tool_execution_start', toolCallId: 'one', toolName: 'bash' }, 100);
  tools = applyToolEvent(tools, { type: 'tool_execution_update', toolCallId: 'one', partialResult: { content: [{ type: 'text', text: 'line 1' }] } }, 200);
  const old = tools;
  tools = applyToolEvent(tools, { type: 'tool_execution_update', toolCallId: 'one', partialResult: { content: [{ type: 'text', text: 'line 1\nline 2' }] } }, 300);
  assert.equal(outputPreview(tools.one.result), 'line 1\nline 2');
  assert.equal(outputPreview(old.one.result), 'line 1');
  tools = applyToolEvent(tools, { type: 'tool_execution_end', toolCallId: 'one', result: { content: [] }, isError: false }, 400);
  assert.equal(outputPreview(tools.one.result), '', 'empty final output still replaces partial output');
  assert.equal(tools.one.startedAt, 100);
  assert.equal(tools.one.endedAt, 400);
  assert.equal(tools.one.status, 'done');
  assert.equal(applyToolEvent(tools, { type: 'tool_execution_update', toolCallId: 'one', partialResult: { content: [] } }, 450), tools, 'late updates cannot reopen a finished tool');
  tools = applyToolEvent(tools, { type: 'tool_execution_start', toolCallId: 'two' }, 500);
  tools = interruptTools(tools, 600);
  assert.equal(tools.one.status, 'done');
  assert.equal(tools.two.status, 'interrupted');
  assert.equal(tools.two.endedAt, 600);
});

test('retry, manual compaction and final provider errors report their actual states', () => {
  const apply = run();
  assert.equal(apply({ type: 'compaction_start' }).phase, 'compacting');
  assert.equal(apply({ type: 'compaction_end' }).phase, 'waiting');
  assert.equal(apply({ type: 'manual_compaction_end' }).phase, 'complete');
  apply({ type: 'agent_start' }, 2000);
  const retry = apply({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 5000 });
  assert.equal(retry.phase, 'retrying');
  assert.match(retry.detail, /2.*3.*5/);
  apply({ type: 'auto_retry_end', finalError: 'provider unavailable' });
  assert.equal(apply({ type: 'agent_settled' }).phase, 'error');
});

test('live output previews are bounded, show newest lines and remove terminal color escapes', () => {
  const output = { content: [{ type: 'text', text: 'old\n' + 'a'.repeat(30_000) + '\n1\n2\n3\n4\n\x1b[32m中文结果\x1b[0m\n' }] };
  assert.equal(outputPreview(output), '1\n2\n3\n4\n中文结果');
});

test('restored tool calls without a result do not look like active executions, while active tools show live output', () => {
  const call = { id: 'old', name: 'bash', arguments: { command: 'example' } };
  const props = { call, onError: () => {} };
  const historical = renderToStaticMarkup(createElement(ToolCard, props));
  assert.match(historical, /未记录结果/);
  assert.doesNotMatch(historical, /运行中|class="spin"/);
  const live = renderToStaticMarkup(createElement(ToolCard, { ...props, live: { status: 'running', result: { content: [{ type: 'text', text: '真实实时日志' }] } } }));
  assert.match(live, /运行中/);
  assert.match(live, /真实实时日志/);
  assert.doesNotMatch(live, /class="tool-detail"/, 'collapsed details stay unmounted while the preview is visible');
});
