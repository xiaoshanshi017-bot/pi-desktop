import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGE_PAGE_SIZE, messageWindow } from '../src/message-window';

test('long saved histories mount a bounded recent page and retain the full count', () => {
  const page = messageWindow(1294);
  assert.equal(page.start, 1254);
  assert.equal(page.end, 1294);
  assert.equal(page.total, 1294);
  assert.equal(page.end - page.start, MESSAGE_PAGE_SIZE);
  assert.equal(page.isLatest, true);
  assert.equal(page.newer, null);
});

test('every message remains reachable when paging backwards and forwards', () => {
  for (const total of [0, 1, 40, 41, 81, 232, 1294]) {
    let page = messageWindow(total);
    const visited = new Set<number>();
    while (true) {
      for (let index = page.start; index < page.end; index++) visited.add(index);
      assert.ok(page.end - page.start <= MESSAGE_PAGE_SIZE);
      if (page.older === null) break;
      page = messageWindow(total, page.older);
    }
    assert.equal(visited.size, total);
    while (page.newer !== null) {
      const next = messageWindow(total, page.newer);
      assert.ok(next.start > page.start);
      assert.ok(next.start <= page.end, 'paging never skips messages');
      page = next;
    }
    assert.equal(page.end, total);
  }
});

test('new streaming messages keep the historical page stable and advance the latest page', () => {
  assert.equal(messageWindow(500, 120).start, 120);
  assert.equal(messageWindow(700, 120).start, 120);
  assert.equal(messageWindow(500).end, 500);
  assert.equal(messageWindow(700).end, 700);
});

test('replaced or shorter sessions never produce an empty or invalid history window', () => {
  assert.deepEqual([messageWindow(5, 120).start, messageWindow(5, 120).end], [0, 5]);
  assert.deepEqual([messageWindow(0, 120).start, messageWindow(0, 120).end], [0, 0]);
  assert.equal(messageWindow(90, -5).start, 0);
});
