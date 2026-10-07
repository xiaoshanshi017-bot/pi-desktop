import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionSummary, WorkspaceSnapshot } from '../shared/types';
import { applyConversationEvent, emptyConversation } from '../src/workspace';
import { createWorkspaceSnapshot, hydrateWorkspace, normalizeConversationUi, persistConversationView } from '../src/workspace-persistence';

function conversation(id: string, project = 'C:/中文项目') {
  const view = emptyConversation(id, project);
  view.status = 'connected';
  view.state = { sessionId: `session-${id}`, sessionFile: `C:/sessions/${id}.jsonl`, sessionName: `会话 ${id}`, model: { id: 'offline', provider: 'fixture', name: '离线模型' }, thinkingLevel: 'high' };
  view.messages = [{ role: 'user', timestamp: 10, content: [{ type: 'text', text: `原始消息 ${id}` }] }];
  return view;
}

test('workspace snapshot restores all tabs, active selection, history pages and independent unsent content', () => {
  const a = conversation('stable-A');
  const b = conversation('stable-B');
  a.messages = Array.from({ length: 1294 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', timestamp: index + 1, content: [{ type: 'text', text: `历史 ${index}` }] }));
  a.draft = '未发送草稿 A';
  b.draft = '未发送草稿 B';
  a.attachments = [{ name: '记录.txt', path: 'C:/记录.txt', type: 'text', content: '原始附件内容' }, { name: '截图.png', path: 'clipboard.png', type: 'image', mimeType: 'image/png', data: 'c2FtcGxl' }];
  a.sendMode = 'followUp';
  a.widgets = { details: ['已保存 widget'] };
  a.statuses = { extension: '已保存状态' };
  a.unread = true;
  a.stats = { totalMessages: 1294, cost: .25, tokens: { input: 4000 }, contextUsage: { percent: 14 } };
  const connections: ConnectionSummary[] = [a, b].map((view, index) => ({ id: view.id, project: view.project, sessionPath: view.state.sessionFile, status: 'connected', busy: false, lastActivity: 100 + index }));
  const snapshot = createWorkspaceSnapshot({ welcome: emptyConversation('welcome'), [a.id]: a, [b.id]: b }, connections, b.id, { [a.id]: { windowStart: 120, scrollTop: 385, nearBottom: false } }, 1000, { sidebar: false, inspector: true });
  const restored = hydrateWorkspace(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(snapshot.tabs.length, 2);
  assert.equal(restored.activeId, b.id);
  assert.deepEqual(restored.ui, { sidebar: false, inspector: true });
  assert.deepEqual(restored.uiById[a.id], { windowStart: 120, scrollTop: 385, nearBottom: false });
  assert.equal(restored.views[a.id].messages.length, 1294, 'mounted page size does not truncate saved history');
  assert.equal(restored.views[a.id].messages[0].content[0].text, '历史 0');
  assert.equal(restored.views[a.id].messages[1293].content[0].text, '历史 1293');
  assert.equal(restored.views[a.id].draft, a.draft);
  assert.equal(restored.views[b.id].draft, b.draft);
  assert.deepEqual(restored.views[a.id].attachments, a.attachments);
  assert.equal(restored.views[a.id].sendMode, 'followUp');
  assert.deepEqual(restored.views[a.id].widgets, a.widgets);
  assert.deepEqual(restored.views[a.id].statuses, a.statuses);
  assert.deepEqual(restored.views[a.id].stats, a.stats);
  assert.equal(restored.views[a.id].unread, true);
  assert.equal(restored.connections[1].lastActivity, 101);
  assert.equal(restored.views[a.id].status, 'restoring');
});

test('a persisted running task becomes interrupted and cannot revive old prompts or confirmation requests', () => {
  let view = conversation('cached');
  view = applyConversationEvent(view, { type: 'agent_start' }, 100);
  view = applyConversationEvent(view, { type: 'message_start', message: { role: 'assistant', timestamp: 101, content: [{ type: 'text', text: '正在执行的输出' }] } }, 101);
  view = applyConversationEvent(view, { type: 'tool_execution_start', toolCallId: 'tool-A', toolName: 'bash', args: { command: 'node long-job.js' } }, 102);
  view = applyConversationEvent(view, { type: 'tool_execution_update', toolCallId: 'tool-A', partialResult: { content: [{ type: 'text', text: '实时日志已收到' }] } }, 103);
  view.state.isCompacting = true;
  view.state.pendingMessageCount = 2;
  view.mutating = true;
  view.queue = { steering: ['旧任务追加'], followUp: ['旧自动执行提示'] };
  view.dialogs = [{ id: 'old-confirmation', method: 'confirm', title: '过去的请求' }];
  view.sessionControls = true;
  view.redirect = { requestId: 'pending-redirect', status: 'stopping', message: 'old in-flight instruction' };
  const sourceBefore = JSON.stringify(view);
  const cached = persistConversationView(view, 200);
  const snapshot: WorkspaceSnapshot = { version: 1, savedAt: 200, activeId: view.id, tabs: [{ id: view.id, project: view.project, sessionPath: view.state.sessionFile, lastActivity: 103, unread: false, view: cached, ui: { windowStart: null, scrollTop: 0, nearBottom: true } }] };
  const restored = hydrateWorkspace(JSON.parse(JSON.stringify(snapshot))).views[view.id];
  assert.equal(JSON.stringify(view), sourceBefore, 'saving does not mutate the running renderer view');
  for (const field of ['busy', 'mutating', 'queue', 'dialogs', 'notice', 'id', 'status', 'redirect', 'sessionControls']) assert.equal(Object.hasOwn(cached, field), false, `${field} is not persisted`);
  assert.equal(restored.redirect, null);
  assert.equal(restored.sessionControls, false);
  assert.equal(restored.busy, false);
  assert.equal(restored.mutating, false);
  assert.deepEqual(restored.queue, { steering: [], followUp: [] });
  assert.deepEqual(restored.dialogs, []);
  assert.equal(restored.state.isStreaming, false);
  assert.equal(restored.state.isCompacting, false);
  assert.equal(restored.state.pendingMessageCount, 0);
  assert.equal(restored.messages[1]._streaming, false);
  assert.equal(restored.messages[1].stopReason, 'aborted');
  assert.equal(restored.messages[1].content[0].text, '正在执行的输出');
  assert.equal(restored.tools['tool-A'].status, 'interrupted');
  assert.equal(restored.tools['tool-A'].endedAt, 200);
  assert.equal(restored.tools['tool-A'].result.content[0].text, '实时日志已收到');
  assert.equal(restored.progress?.phase, 'interrupted');
  assert.equal(restored.progress?.endedAt, 200);
  assert.deepEqual(restored.progress?.activeTools, {});
  assert.ok(restored.progress?.steps.every(step => step.status !== 'running'));
  assert.match(restored.notice?.text || '', /重新发送指令/);
});

test('completed messages and finished tool records keep their outcomes and avoid unnecessary deep copies', () => {
  let view = conversation('finished');
  view = applyConversationEvent(view, { type: 'agent_start' }, 10);
  view = applyConversationEvent(view, { type: 'tool_execution_start', toolCallId: 'finished-tool', toolName: 'read', args: { path: 'result.txt' } }, 11);
  view = applyConversationEvent(view, { type: 'tool_execution_end', toolCallId: 'finished-tool', result: { content: [{ type: 'text', text: '完整读取结果' }] } }, 12);
  view = applyConversationEvent(view, { type: 'agent_settled' }, 13);
  const cached = persistConversationView(view, 200);
  assert.equal(cached.messages[0], view.messages[0]);
  assert.equal(cached.messages[0].content, view.messages[0].content);
  assert.equal(cached.tools['finished-tool'], view.tools['finished-tool']);
  assert.equal(cached.progress?.phase, 'complete');
  assert.equal(cached.progress?.endedAt, 13);
  assert.equal(cached.tools['finished-tool'].status, 'done');
});

test('only model display metadata is cached while legitimate tool parameters remain intact', () => {
  const view = conversation('metadata');
  const model = { id: 'private-model', name: '展示名称', provider: 'configured', api: 'openai-completions', headers: { authorization: 'provider-secret' }, apiKey: 'provider-key', baseUrl: 'private-base-url' };
  view.state.model = model;
  view.state.liveConnectionId = 'old-process';
  view.models = [model];
  view.tools = { done: { status: 'done', args: { apiKey: 'literal-user-tool-argument', command: 'sample command' }, result: { content: [{ type: 'text', text: '完整工具正文' }] } } };
  const cached = persistConversationView(view, 100);
  assert.deepEqual(cached.models, [{ id: model.id, name: model.name, api: model.api, provider: model.provider }]);
  assert.deepEqual(cached.state.model, cached.models[0]);
  assert.equal(cached.state.liveConnectionId, undefined);
  assert.deepEqual(cached.tools.done, view.tools.done, 'display metadata filtering never alters recorded tool content');
});

test('closed tabs stay removed and empty unsent conversations can still restore their drafts', () => {
  const view = emptyConversation('new-tab', 'C:/fresh');
  view.state = { sessionId: 'assigned-but-not-written', sessionFile: 'C:/sessions/not-written.jsonl' };
  view.draft = '还没有发送';
  const snapshot = createWorkspaceSnapshot({ [view.id]: view }, [{ id: 'closed-tab', project: 'C:/closed', busy: false, status: 'connected', lastActivity: 5 }], 'closed-tab', {}, 500);
  assert.equal(snapshot.tabs.length, 1);
  assert.equal(snapshot.tabs[0].sessionPath, undefined);
  assert.equal(snapshot.activeId, null);
  const restored = hydrateWorkspace(snapshot);
  assert.equal(restored.activeId, null, 'explicit welcome selection is preserved');
  assert.equal(restored.views[view.id].draft, view.draft);
  assert.equal(restored.views[view.id].state.sessionFile, view.state.sessionFile, 'display state can retain its previous identity');
  assert.equal(restored.connections[0].sessionPath, undefined, 'restore must not open an unwritten session file');
  assert.deepEqual(restored.views[view.id].messages, []);
});

test('invalid optional cached display fields cannot recreate old running state or invalid scroll values', () => {
  const valid = createWorkspaceSnapshot({ cached: conversation('cached') }, [], 'cached', {}, 1000);
  valid.tabs[0].ui = { windowStart: -4, scrollTop: Infinity, nearBottom: false };
  valid.tabs[0].view = { ...valid.tabs[0].view, busy: true, dialogs: [{ id: 'stale' }], queue: { followUp: ['stale'] }, levels: [null, 'high'], attachments: [null, { type: 'unsupported' }], progress: { phase: 'unknown' }, widgets: { valid: ['text', 1] }, statuses: { good: 'text', bad: {} } };
  const restored = hydrateWorkspace(valid);
  assert.deepEqual(restored.uiById.cached, { windowStart: 0, scrollTop: 0, nearBottom: false });
  assert.equal(restored.views.cached.busy, false);
  assert.deepEqual(restored.views.cached.dialogs, []);
  assert.deepEqual(restored.views.cached.queue.followUp, []);
  assert.deepEqual(restored.views.cached.attachments, []);
  assert.deepEqual(restored.views.cached.levels, ['high']);
  assert.deepEqual(restored.views.cached.widgets, { valid: ['text'] });
  assert.deepEqual(restored.views.cached.statuses, { good: 'text' });
  assert.equal(restored.views.cached.progress, null);
  assert.deepEqual(normalizeConversationUi(), { windowStart: null, scrollTop: 0, nearBottom: true });
  assert.equal(hydrateWorkspace({ version: 9 } as unknown as WorkspaceSnapshot).connections.length, 0);
});

test('welcome stays selected across restart while an invalid active tab falls back to the first saved tab', () => {
  const a = conversation('A');
  const snapshot = createWorkspaceSnapshot({ A: a }, [], 'welcome', {}, 1000);
  assert.equal(snapshot.activeId, null);
  assert.equal(hydrateWorkspace(snapshot).activeId, null);
  snapshot.activeId = 'missing-tab';
  assert.equal(hydrateWorkspace(snapshot).activeId, 'A');
});

test('the saved tab order follows view insertion rather than background connection completion', () => {
  const a = conversation('A');
  const b = conversation('B');
  const connections: ConnectionSummary[] = [b, a].map(view => ({ id: view.id, project: view.project, status: 'connected', busy: false, lastActivity: 100 }));
  const snapshot = createWorkspaceSnapshot({ welcome: emptyConversation('welcome'), A: a, B: b }, connections, a.id, {}, 1000);
  assert.deepEqual(snapshot.tabs.map(tab => tab.id), ['A', 'B']);
  assert.deepEqual(hydrateWorkspace(snapshot).connections.map(connection => connection.id), ['A', 'B']);
});

test('cached send modes migrate the old implicit steering default and preserve explicit queue choices', () => {
  const view = conversation('modes');
  assert.equal(view.sendMode, 'redirect');
  for (const [saved, expected] of [['steer', 'redirect'], ['redirect', 'redirect'], ['afterTool', 'afterTool'], ['followUp', 'followUp'], ['unknown', 'redirect']]) {
    view.sendMode = saved;
    assert.equal(persistConversationView(view, 100).sendMode, expected);
    assert.equal(hydrateWorkspace(createWorkspaceSnapshot({ modes: view }, [], view.id, {}, 100)).views.modes.sendMode, expected);
  }
});
