import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { JsonlDecoder, PiRpcClient } from '../electron/rpc';
import type { RpcRecord } from '../shared/types';

test('JSONL framing preserves multibyte characters and Unicode separators across every byte boundary', () => {
  const values = [{ message: '中文 😀\u2028line\u2029paragraph\ninside' }, { answer: 42 }];
  const input = Buffer.from(values.map(value => JSON.stringify(value)).join('\r\n') + '\n');
  const records: string[] = [];
  const decoder = new JsonlDecoder(line => records.push(line));
  for (const byte of input) decoder.write(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(records.map(line => JSON.parse(line)), values);
});

test('JSONL decoder waits for LF, flushes the final unterminated record once, and accepts string chunks', () => {
  const records: string[] = [];
  const decoder = new JsonlDecoder(line => records.push(line));
  decoder.write('{"one":');
  assert.deepEqual(records, []);
  decoder.write('1}\n{"two":2}');
  assert.deepEqual(records, ['{"one":1}']);
  decoder.end();
  decoder.end();
  assert.deepEqual(records, ['{"one":1}', '{"two":2}']);
});

function startFixture(onEvent?: (event: RpcRecord) => void) {
  const client = new PiRpcClient({
    executable: process.execPath,
    args: [path.resolve('tests/fixtures/fake-rpc.mjs')],
    cwd: process.cwd(),
    onEvent,
    requestTimeoutMs: 4_000,
  });
  client.start();
  return client;
}

test('RPC correlates overlapping responses by id even when the same command finishes out of order', async t => {
  const client = startFixture();
  t.after(() => client.stop());
  const first = client.request({ type: 'echo', marker: 'first', delay: 50 });
  const second = client.request({ type: 'echo', marker: 'second', delay: 1 });
  assert.deepEqual(await second, { marker: 'second' });
  assert.deepEqual(await first, { marker: 'first' });
});

test('RPC routes unsolicited events separately and preserves extension UI response ids', async t => {
  const events: RpcRecord[] = [];
  const client = startFixture(event => events.push(event));
  t.after(() => client.stop());
  assert.deepEqual(await client.request({ type: 'event' }), {});
  assert.ok(events.some(event => event.type === 'fixture_event' && event.message === '中文\u2028line\u2029paragraph'));
  client.send({ type: 'extension_ui_response', id: 'dialog-123', confirmed: true });
  await client.request({ type: 'echo' });
  assert.ok(events.some(event => event.type === 'fixture_ui_received' && event.id === 'dialog-123' && event.confirmed));
});

test('RPC command failure rejects only the matching request and the connection remains usable', async t => {
  const client = startFixture();
  t.after(() => client.stop());
  await assert.rejects(client.request({ type: 'fail' }), /fixture rejected command/);
  assert.deepEqual(await client.request({ type: 'echo', marker: 'still alive' }), { marker: 'still alive' });
});

test('RPC timeout rejects without poisoning a later request', async t => {
  const client = startFixture();
  t.after(() => client.stop());
  await client.request({ type: 'echo' });
  await assert.rejects(client.request({ type: 'hang' }, 30));
  assert.deepEqual(await client.request({ type: 'echo', marker: 'after timeout' }), { marker: 'after timeout' });
});

test('RPC child crash promptly rejects all pending requests instead of waiting for timeouts', async t => {
  const client = startFixture();
  t.after(() => client.stop());
  await client.request({ type: 'echo' });
  const started = Date.now();
  const outcomes = await Promise.allSettled([
    client.request({ type: 'hang' }),
    client.request({ type: 'crash' }),
  ]);
  assert.ok(outcomes.every(result => result.status === 'rejected'));
  assert.ok(Date.now() - started < 2_000, 'pending requests should reject on child exit');
  assert.equal(client.running, false);
});

test('RPC remains busy after prompt acceptance and low-level agent_end until agent_settled', { timeout: 5_000 }, async t => {
  const snapshots: { type: string; busy: boolean }[] = [];
  let settled!: () => void;
  const settledPromise = new Promise<void>(resolve => { settled = resolve; });
  const client = startFixture(event => {
    snapshots.push({ type: event.type, busy: client.busy });
    if (event.type === 'agent_settled') settled();
  });
  t.after(() => client.stop());
  await client.request({ type: 'prompt', message: 'fixture only' });
  assert.equal(client.busy, true);
  await settledPromise;
  assert.equal(snapshots.find(event => event.type === 'agent_end')?.busy, true);
  assert.equal(client.busy, false);
});

test('idle barrier waits for preflight responses, compaction responses and agent_settled rather than early end events', async t => {
  const endedBusy: boolean[] = [];
  const client = startFixture(event => {
    if (event.type === 'agent_end' || event.type === 'compaction_end') endedBusy.push(client.busy);
  });
  t.after(() => client.stop());
  const preflight = client.request({ type: 'prompt', preflightOnly: true });
  assert.equal(client.busy, true);
  await client.waitForIdle(); await preflight;
  const compact = client.request({ type: 'compact' });
  await client.waitForIdle(); await compact;
  await client.request({ type: 'prompt' });
  await client.waitForIdle();
  assert.deepEqual(endedBusy, [true, true]);
  assert.equal(client.busy, false);
});

test('idle barrier cancellation and child exit reject without sending any replacement prompt', async t => {
  const client = startFixture();
  t.after(() => client.stop());
  await client.request({ type: 'prompt' });
  const controller = new AbortController();
  const cancelled = assert.rejects(client.waitForIdle({ signal: controller.signal }), /取消/);
  controller.abort(); await cancelled;
  const crashed = assert.rejects(client.waitForIdle(), /进程退出/);
  await assert.rejects(client.request({ type: 'crash' }));
  await crashed;
});

test('RPC shutdown rejects pending requests and is idempotent', async () => {
  const client = startFixture();
  await client.request({ type: 'echo' });
  const pending = assert.rejects(client.request({ type: 'hang' }));
  await client.stop();
  await pending;
  await client.stop();
  assert.equal(client.running, false);
  await assert.rejects(client.request({ type: 'echo' }));
});
