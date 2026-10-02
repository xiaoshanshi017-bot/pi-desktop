// Local-only model fixture for manual desktop acceptance checks. Never shipped.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('output/qa');
const project = path.join(root, '离线验收项目');
const agent = path.join(root, 'agent');
const desktop = path.join(root, 'desktop');
await Promise.all([mkdir(project, { recursive: true }), mkdir(agent, { recursive: true }), mkdir(desktop, { recursive: true })]);
await writeFile(path.join(desktop, 'preferences.json'), JSON.stringify({ theme: 'light', projects: [{ path: project, name: '离线验收项目', lastOpened: new Date().toISOString() }], lastProject: project }), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
await writeFile(path.join(project, '说明.txt'), '这是 Pi Desktop 的本地验收文件。此项目不连接外部模型。\n', 'utf8');
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'local-qa', object: 'chat.completion.chunk', created: 1, model: 'local-qa', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 48, completion_tokens: 36, total_tokens: 84 } } : {}) })}\n\n`);
  const last = body.messages.at(-1);
  if (last?.role !== 'tool') {
    emit({ role: 'assistant', content: '我先读取项目中的说明文件。\n' });
    emit({ tool_calls: [{ index: 0, id: `qa_read_${Date.now()}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: '说明.txt' }) } }] });
    emit({}, 'tool_calls');
  } else {
    emit({ role: 'assistant' });
    for (const text of ['已读取 **说明.txt**。\n\n', '这是本地模拟模型的验收回复，用于检查桌面客户端。\n\n', '- 中文与 Markdown 显示正常\n', '- 工具执行结果已返回\n', '- 会话可在关闭应用后恢复\n\n', '```ts\nconst status = "ready";\n```']) {
      emit({ content: text });
      await new Promise(resolve => setTimeout(resolve, 130));
    }
    emit({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
});
server.listen(19427, '127.0.0.1', async () => {
  await writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'local-qa': { baseUrl: 'http://127.0.0.1:19427/v1', api: 'openai-completions', apiKey: 'local-fixture', models: [{ id: 'local-qa', name: '本地验收模型', reasoning: false, contextWindow: 32000, maxTokens: 2048 }] } } }, null, 2));
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local-qa', defaultModel: 'local-qa', defaultThinkingLevel: 'off' }));
  console.log(JSON.stringify({ project, agent, userData: path.join(root, 'desktop') }));
});
