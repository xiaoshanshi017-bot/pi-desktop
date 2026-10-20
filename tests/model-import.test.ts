import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { literalApiKey, ModelImportError, ModelImportService } from '../electron/model-import';

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-model-import-'));
  try { await run(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('pi-model-import-'));
    await rm(directory, { recursive: true, force: true });
  }
}

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const body = (models = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]) => Response.json({ data: models });

test('imports only explicit boolean reasoning metadata without guessing from model IDs or copying untrusted capabilities', async () => withDirectory(async directory => {
  const service = new ModelImportService({ fetch: async () => Response.json({ data: [
    { id: 'explicit-on', reasoning: true, compat: { supportsReasoningEffort: false }, headers: { 'x-private': 'ignore' } },
    { id: 'explicit-off', reasoning: false },
    { id: 'gpt-future-thinking', reasoning: 'true' },
    { id: 'deepseek-future-reasoner' },
  ] }) });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1' });
  assert.deepEqual(preview.models, [
    { id: 'explicit-on', name: 'explicit-on', reasoning: true },
    { id: 'explicit-off', name: 'explicit-off', reasoning: false },
    { id: 'gpt-future-thinking', name: 'gpt-future-thinking' },
    { id: 'deepseek-future-reasoner', name: 'deepseek-future-reasoner' },
  ]);
  await service.save(directory, { token: preview.token, provider: 'metadata', modelIds: preview.models.map(model => model.id) });
  const saved = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8'));
  assert.deepEqual(saved.providers.metadata.models, preview.models);
  assert.doesNotMatch(JSON.stringify(preview), /compat|private|supportsReasoningEffort/);
}));

test('configures existing reasoning without requesting a key and preserves credentials, compatibility and unrelated models with a backup', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const config = { unknown: { keep: 1 }, providers: {
    '第三方服务': { api: 'openai-completions', apiKey: '!DO_NOT_EXECUTE_MODEL_REASONING_FIXTURE', baseUrl: 'https://private.example/v1', headers: { 'x-keep': 'keep-header' }, compat: { supportsReasoningEffort: false, customProviderFlag: 2 }, models: [
      { id: 'configured', input: ['text', 'image'], contextWindow: 200000, compat: { supportsDeveloperRole: false, thinkingFormat: 'openai', customModelFlag: 3 }, thinkingLevelMap: { off: null, high: 'high' } },
      { id: 'other', reasoning: true, compat: { supportsReasoningEffort: false } },
    ] },
    unrelated: { apiKey: '$KEEP_REFERENCE', models: [{ id: 'untouched' }] },
  } };
  const original = '\uFEFF' + JSON.stringify(config, null, 4) + '\n';
  await writeFile(source, original);
  const service = new ModelImportService({ fetch: async () => { throw new Error('No network expected'); } });
  const request = { provider: '第三方服务', modelId: 'configured', reasoning: true, supportsReasoningEffort: true };
  const result = await service.configureReasoning(directory, request);
  assert.equal(result.changed, true);
  assert.ok(result.backup);
  assert.equal(await readFile(result.backup, 'utf8'), original);
  const saved = JSON.parse(await readFile(source, 'utf8'));
  const expected = structuredClone(config);
  Object.assign(expected.providers['第三方服务'].models[0], { reasoning: true, compat: { ...config.providers['第三方服务'].models[0].compat, supportsReasoningEffort: true } });
  assert.deepEqual(saved, expected);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXECUTE|KEEP_REFERENCE|keep-header|private.example/);
  const persisted = await readFile(source, 'utf8');
  const files = await readdir(directory);
  const unchanged = await service.configureReasoning(directory, request);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.backup, undefined);
  assert.equal(await readFile(source, 'utf8'), persisted);
  assert.deepEqual(await readdir(directory), files);
  await service.configureReasoning(directory, { ...request, reasoning: false, supportsReasoningEffort: false });
  const disabled = JSON.parse(await readFile(source, 'utf8'));
  assert.equal(disabled.providers['第三方服务'].models[0].reasoning, false);
  assert.equal(disabled.providers['第三方服务'].models[0].compat.supportsReasoningEffort, false);
  assert.deepEqual(disabled.providers.unrelated, config.providers.unrelated);
}));

test('reasoning edits reject invalid targets, unsupported protocols and malformed capabilities without altering the file', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const service = new ModelImportService();
  const request = { provider: 'configured', modelId: 'model', reasoning: true, supportsReasoningEffort: true };
  for (const config of [
    { providers: { configured: { api: 'openai-responses', models: [{ id: 'model' }] } } },
    { providers: { configured: { models: [{ id: 'model' }] } } },
    { providers: { configured: { api: 'openai-completions', models: [{ id: 'model', api: 'anthropic-messages' }] } } },
    { providers: { configured: { api: 'openai-completions', models: [{ id: 'model' }, { id: 'model' }] } } },
    { providers: { configured: { api: 'openai-completions', models: [{ id: 'model', compat: [] }] } } },
    { providers: { configured: { api: 'openai-completions', compat: null, models: [{ id: 'model' }] } } },
    { providers: { other: { api: 'openai-completions', models: [{ id: 'model' }] } } },
  ]) {
    const original = JSON.stringify(config);
    await writeFile(source, original);
    await assert.rejects(service.configureReasoning(directory, request));
    assert.equal(await readFile(source, 'utf8'), original);
  }
  const original = JSON.stringify({ providers: { configured: { api: 'openai-completions', models: [{ id: 'model' }] } } });
  await writeFile(source, original);
  for (const invalid of [
    { ...request, provider: '__proto__' },
    { ...request, modelId: 'model\n' },
    { ...request, reasoning: 'true' },
    { ...request, supportsReasoningEffort: 1 },
  ]) await assert.rejects(service.configureReasoning(directory, invalid as unknown as typeof request));
  assert.equal(await readFile(source, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['models.json']);
  // An explicit per-model protocol is supported even when the provider inherits its default API.
  await writeFile(source, JSON.stringify({ providers: { configured: { models: [{ id: 'model', api: 'openai-completions' }] } } }));
  assert.equal((await service.configureReasoning(directory, request)).changed, true);
}));

test('serializes model imports and capability updates without losing either change', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  await writeFile(source, JSON.stringify({ providers: { existing: { api: 'openai-completions', models: [{ id: 'original' }] } } }));
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1' });
  await Promise.all([
    service.save(directory, { token: preview.token, provider: 'added', modelIds: ['alpha'] }),
    service.configureReasoning(directory, { provider: 'existing', modelId: 'original', reasoning: true, supportsReasoningEffort: true }),
  ]);
  const saved = JSON.parse(await readFile(source, 'utf8'));
  assert.equal(saved.providers.existing.models[0].reasoning, true);
  assert.equal(saved.providers.existing.models[0].compat.supportsReasoningEffort, true);
  assert.deepEqual(saved.providers.added.models, [{ id: 'alpha', name: 'Alpha' }]);
  assert.ok(!(await readdir(directory)).some(file => file.endsWith('.tmp')));
}));

test('reasoning edits detect external file changes before replacement and retain the external edit', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const original = JSON.stringify({ providers: { existing: { api: 'openai-completions', models: [{ id: 'model' }] } } });
  const outside = JSON.stringify({ providers: { outside: { models: [{ id: 'external-edit' }] } } });
  await writeFile(source, original);
  let injectEdit = true;
  const service = new ModelImportService({ now: () => {
    // The backup timestamp is requested after reading the original and before the guarded rename.
    if (injectEdit) { injectEdit = false; writeFileSync(source, outside); }
    return 1000;
  } });
  await assert.rejects(service.configureReasoning(directory, { provider: 'existing', modelId: 'model', reasoning: true, supportsReasoningEffort: true }), error => error instanceof ModelImportError && error.code === 'CONFIG_CHANGED');
  assert.equal(await readFile(source, 'utf8'), outside);
  const files = await readdir(directory);
  assert.equal(files.filter(file => file.includes('.backup-')).length, 1);
  assert.ok(!files.some(file => file.endsWith('.tmp')));
}));

test('fetches root /v1/models and exact /models paths with a separate bearer key; returns only safe model previews', async () => {
  const apiKey = '!not-a-command_$MODEL_IMPORT_FIXTURE';
  const requests: { path?: string; authorization?: string }[] = [];
  await withServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [
      { id: 'alpha', name: 'Alpha', apiKey, headers: { Authorization: apiKey }, reasoning: true },
      { id: 'alpha', name: 'Duplicate' }, { id: 'beta', name: apiKey }, { id: apiKey, name: 'Unsafe' },
      { id: 15 }, { id: 'bad\nmodel' },
    ] }));
  }, async baseUrl => {
    const service = new ModelImportService();
    for (const [url, expected] of [[baseUrl, '/v1/models'], [`${baseUrl}/v1/`, '/v1/models'], [`${baseUrl}/custom/models`, '/custom/models']]) {
      const preview = await service.preview({ baseUrl: url, apiKey });
      assert.equal(requests.at(-1)?.path, expected);
      assert.equal(requests.at(-1)?.authorization, `Bearer ${apiKey}`);
      assert.deepEqual(preview.models, [{ id: 'alpha', name: 'Alpha', reasoning: true }, { id: 'beta', name: 'beta' }]);
      assert.ok(!JSON.stringify(preview).includes(apiKey));
      assert.deepEqual(Object.keys(preview.models[0]), ['id', 'name', 'reasoning']);
      service.discard(preview.token);
    }
  });
});

test('does not follow credential-bearing redirects and rejects URL credentials, queries and fragments before HTTP', async () => {
  let redirectedCalls = 0;
  await withServer((_request, response) => { redirectedCalls++; response.end(JSON.stringify({ data: [] })); }, async destination => {
    let originCalls = 0;
    await withServer((_request, response) => { originCalls++; response.writeHead(302, { Location: `${destination}/v1/models` }); response.end(); }, async origin => {
      const service = new ModelImportService();
      await assert.rejects(service.preview({ baseUrl: origin, apiKey: 'fixture-private-key' }), /重定向/);
      assert.equal(redirectedCalls, 0);
      for (const url of [`${origin}?key=fixture-private-key`, `${origin}#private`, origin.replace('http://', 'http://user:password@'), 'file:///tmp/models']) {
        await assert.rejects(service.preview({ baseUrl: url, apiKey: 'fixture-private-key' }), error => !String(error).includes('fixture-private-key'));
      }
      assert.equal(originCalls, 1);
    });
  });
});

test('redacts HTTP, malformed JSON and transport failures and bounds model count, bytes and request duration', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const service = new ModelImportService({ fetch: async () => new Response('credential-canary-123', { status }) });
    await assert.rejects(service.preview({ baseUrl: 'https://fixture.example/v1', apiKey: 'credential-canary-123' }), error => !String(error).includes('credential-canary-123') && /Key|接口|频繁|不可用/.test(String(error)));
  }
  const malformed = new ModelImportService({ fetch: async () => new Response('credential-canary-123') });
  await assert.rejects(malformed.preview({ baseUrl: 'https://fixture.example' }), /JSON/);
  const transport = new ModelImportService({ fetch: async () => { throw new Error('Authorization: credential-canary-123'); } });
  await assert.rejects(transport.preview({ baseUrl: 'https://fixture.example' }), error => /无法连接/.test(String(error)) && !String(error).includes('credential-canary-123'));
  const tooMany = new ModelImportService({ fetch: async () => body(), maxModels: 1 });
  await assert.rejects(tooMany.preview({ baseUrl: 'https://fixture.example' }), /数量过多/);
  const tooLarge = new ModelImportService({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(80))); controller.close(); } })), maxResponseBytes: 32 });
  await assert.rejects(tooLarge.preview({ baseUrl: 'https://fixture.example' }), /响应过大/);
  await withServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"data":'); }, async baseUrl => {
    const service = new ModelImportService({ timeoutMs: 50 });
    await assert.rejects(service.preview({ baseUrl }), /超时/);
  });
});

test('saves selected models atomically with an exact backup, literal key, and unchanged existing capabilities and unknown fields', async () => withDirectory(async directory => {
  const apiKey = '!never_execute_$SECRET_${OTHER}_$!_$$';
  const existing = {
    customRoot: { keep: true },
    providers: {
      unrelated: { apiKey: 'keep-private', opaque: [1, 2, 3] },
      imported: { baseUrl: 'https://fixture.example/v1/', api: 'openai-completions', headers: { 'x-private': 'keep-header' }, compat: { supportsDeveloperRole: false },
        models: [{ id: 'alpha', name: 'Original Alpha', api: 'openai-responses', reasoning: true, input: ['text', 'image'], contextWindow: 200000, custom: 'keep' }] },
    },
  };
  const original = JSON.stringify(existing);
  await writeFile(join(directory, 'models.json'), original);
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1', apiKey });
  preview.models[1].name = 'Renderer must not override preview authority';
  const result = await service.save(directory, { token: preview.token, provider: 'imported', modelIds: ['alpha', 'beta', 'beta'], updateExisting: true });
  assert.equal(result.added, 1); assert.equal(result.skipped, 1);
  assert.ok(result.backup);
  assert.equal(await readFile(result.backup, 'utf8'), original);
  const saved = JSON.parse(await readFile(result.source, 'utf8'));
  assert.deepEqual(saved.customRoot, existing.customRoot);
  assert.deepEqual(saved.providers.unrelated, existing.providers.unrelated);
  assert.deepEqual(saved.providers.imported.models[0], existing.providers.imported.models[0]);
  assert.deepEqual(saved.providers.imported.models[1], { id: 'beta', name: 'Beta' });
  assert.deepEqual(saved.providers.imported.headers, existing.providers.imported.headers);
  assert.deepEqual(saved.providers.imported.compat, existing.providers.imported.compat);
  assert.equal(saved.providers.imported.apiKey, '$!never_execute_$$SECRET_$${OTHER}_$$!_$$$$');
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.tmp')));
  await assert.rejects(service.save(directory, { token: preview.token, provider: 'imported', modelIds: ['alpha'] }), /失效/);
}));

test('serializes concurrent imports without losing either provider and supports keyless local servers', async () => withDirectory(async directory => {
  const seenHeaders: HeadersInit[] = [];
  const service = new ModelImportService({ fetch: async (_url, init) => { seenHeaders.push(init?.headers ?? {}); return body(); } });
  const a = await service.preview({ baseUrl: 'http://localhost:11434/v1' });
  const b = await service.preview({ baseUrl: 'http://localhost:1234/models' });
  assert.ok(seenHeaders.every(headers => !new Headers(headers).has('Authorization')));
  await Promise.all([
    service.save(directory, { token: a.token, provider: 'local-a', modelIds: ['alpha'] }),
    service.save(directory, { token: b.token, provider: 'local-b', modelIds: ['beta'] }),
  ]);
  const saved = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8'));
  assert.deepEqual(saved.providers['local-a'].models, [{ id: 'alpha', name: 'Alpha' }]);
  assert.deepEqual(saved.providers['local-b'].models, [{ id: 'beta', name: 'Beta' }]);
  assert.equal(saved.providers['local-b'].baseUrl, 'http://localhost:1234');
  assert.equal(saved.providers['local-a'].apiKey, 'pi-desktop-local');
  assert.equal(saved.providers['local-a'].authHeader, false);
  // An explicitly supplied root /models endpoint must match its saved root base URL on a later import.
  const again = await service.preview({ baseUrl: 'http://localhost:1234/models' });
  await service.save(directory, { token: again.token, provider: 'local-b', modelIds: ['alpha'] });
}));

test('keeps malformed JSON and conflicting providers intact; rejects fabricated selection and unsafe provider names', async () => withDirectory(async directory => {
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1', apiKey: 'fixture-secret' });
  const source = join(directory, 'models.json');
  for (const original of ['{"apiKey":"fixture-secret"', '{"providers":[]}', '{"providers":null}']) {
    await writeFile(source, original);
    await assert.rejects(service.save(directory, { token: preview.token, provider: 'imported', modelIds: ['alpha'] }), error => /格式/.test(String(error)) && !String(error).includes('fixture-secret'));
    assert.equal(await readFile(source, 'utf8'), original);
  }
  for (const definition of [{ baseUrl: 'https://different.example/v1', api: 'openai-completions' }, { baseUrl: preview.baseUrl, api: 'anthropic-messages' }]) {
    const original = JSON.stringify({ providers: { imported: definition } });
    await writeFile(source, original);
    await assert.rejects(service.save(directory, { token: preview.token, provider: 'imported', modelIds: ['alpha'] }), /其他|另一个/);
    assert.equal(await readFile(source, 'utf8'), original);
  }
  await assert.rejects(service.save(directory, { token: preview.token, provider: '__proto__', modelIds: ['alpha'] }), /服务名称/);
  await assert.rejects(service.save(directory, { token: preview.token, provider: 'safe', modelIds: ['fabricated'] }), /不属于/);
  assert.ok(!(await readdir(directory)).some(name => name.includes('backup') || name.endsWith('.tmp')));
  service.discard(preview.token);
}));

test('tokens expire, can be discarded, and bound the number of retained credential sessions', async () => withDirectory(async directory => {
  let now = 1000;
  const service = new ModelImportService({ fetch: async () => body(), now: () => now, tokenTtlMs: 100 });
  const first = await service.preview({ baseUrl: 'https://fixture.example' });
  now += 101;
  await assert.rejects(service.save(directory, { token: first.token, provider: 'safe', modelIds: ['alpha'] }), /失效/);
  const tokens = [];
  for (let index = 0; index < 8; index++) tokens.push((await service.preview({ baseUrl: 'https://fixture.example' })).token);
  await assert.rejects(service.preview({ baseUrl: 'https://fixture.example' }), /过多/);
  service.discard(tokens[0]);
  await assert.rejects(service.save(directory, { token: tokens[0], provider: 'safe', modelIds: ['alpha'] }), /失效/);
  const next = await service.preview({ baseUrl: 'https://fixture.example' });
  for (const token of [...tokens, next.token]) service.discard(token);
  assert.deepEqual(await readdir(directory), []);
}));

test('literal key encoding preserves dollar and bang characters without introducing Pi command references', () => {
  assert.equal(literalApiKey('sk-literal'), 'sk-literal');
  assert.equal(literalApiKey('$TOKEN'), '$$TOKEN');
  assert.equal(literalApiKey('!echo sensitive'), '$!echo sensitive');
  assert.equal(literalApiKey('prefix${TOKEN}$$!suffix'), 'prefix$${TOKEN}$$$$!suffix');
});

test('duplicate-only imports leave the exact original bytes, credentials and backup directory unchanged', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const original = '{\n "providers": { "existing": { "baseUrl": "https://fixture.example/v1", "api": "openai-completions", "apiKey": "$EXISTING_KEY", "models": [{"id":"alpha","reasoning":true}] } }, "unknown": "preserve spacing"\n}\n';
  await writeFile(source, original);
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1' });
  const result = await service.save(directory, { token: preview.token, provider: 'existing', modelIds: ['alpha'] });
  assert.equal(result.added, 0); assert.equal(result.skipped, 1); assert.equal(result.backup, undefined);
  assert.equal(await readFile(source, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['models.json']);
  await assert.rejects(service.save(directory, { token: preview.token, provider: 'existing', modelIds: ['beta'] }), /失效/);
}));

test('keyless append preserves the existing Pi key reference without evaluating or replacing it', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const existing = { providers: { existing: { baseUrl: 'https://fixture.example/v1', api: 'openai-completions', apiKey: '!do-not-execute-this-command', models: [{ id: 'alpha' }] } } };
  await writeFile(source, JSON.stringify(existing));
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1' });
  const result = await service.save(directory, { token: preview.token, provider: 'existing', modelIds: ['beta'] });
  assert.equal(result.added, 1);
  const saved = JSON.parse(await readFile(source, 'utf8'));
  assert.equal(saved.providers.existing.apiKey, existing.providers.existing.apiKey);
  assert.deepEqual(saved.providers.existing.models, [{ id: 'alpha' }, { id: 'beta', name: 'Beta' }]);
}));

test('different keys and built-in provider overrides without a base URL require another service name', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1', apiKey: 'new-fixture-key' });
  for (const definition of [
    { baseUrl: preview.baseUrl, api: 'openai-completions', apiKey: 'old-fixture-key' },
    { baseUrl: preview.baseUrl, api: 'openai-completions', apiKey: '$EXISTING_KEY' },
    { baseUrl: preview.baseUrl, api: 'openai-completions', apiKey: '!do-not-execute-this-command' },
    { headers: { 'x-provider': 'built-in-override' }, apiKey: 'existing-key' },
  ]) {
    const original = JSON.stringify({ providers: { existing: definition } });
    await writeFile(source, original);
    await assert.rejects(service.save(directory, { token: preview.token, provider: 'existing', modelIds: ['beta'] }), /另一个服务名称/);
    assert.equal(await readFile(source, 'utf8'), original);
    assert.deepEqual(await readdir(directory), ['models.json']);
  }
  service.discard(preview.token);
}));

test('describes existing service conflicts and a free Chinese service name without exposing stored credentials or addresses', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const original = JSON.stringify({ providers: {
    '已有服务': { baseUrl: 'https://old-private-address.invalid/v1', api: 'openai-completions', apiKey: '!private-command-must-not-run', headers: { 'x-private': 'private-header' }, models: [{ id: 'alpha' }] },
    '已有服务-2': {},
    '其他协议': { baseUrl: 'https://fixture.example/v1', api: 'anthropic-messages', models: [] },
    '原生覆盖': { models: [{ id: 'alpha' }] },
  } });
  await writeFile(source, original);
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1', apiKey: 'new-fixture-private-key' });
  const existing = await service.describeTarget(directory, preview.token, '已有服务');
  assert.deepEqual(existing, { providerExists: true, conflicts: ['baseUrl', 'apiKey'], suggestedProvider: '已有服务-3' });
  assert.doesNotMatch(JSON.stringify(existing), /private|invalid|headers|Authorization|command/);
  assert.deepEqual(await service.describeTarget(directory, preview.token, '新服务'), { providerExists: false, conflicts: [] });
  assert.ok((await service.describeTarget(directory, preview.token, '其他协议')).conflicts.includes('api'));
  assert.ok((await service.describeTarget(directory, preview.token, '原生覆盖')).conflicts.includes('baseUrl'));
  await assert.rejects(service.save(directory, { token: preview.token, provider: '其他协议', modelIds: [], updateExisting: true }), error => error instanceof ModelImportError && error.code === 'PROVIDER_API_CONFLICT');
  assert.equal(await readFile(source, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['models.json']);
  service.discard(preview.token);
  await assert.rejects(service.describeTarget(directory, preview.token, '已有服务'), error => error instanceof ModelImportError && error.code === 'PREVIEW_EXPIRED');
}));

test('explicit update-only saves verified endpoint and literal key with a backup while preserving all models and unknown fields', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const config = { unknownRoot: { retain: 1 }, providers: {
    '中文服务_1': { baseUrl: 'https://old.example/v1', api: 'openai-completions', apiKey: 'old-literal-key', headers: { 'x-keep': 'keep' }, custom: { retain: true }, models: [{ id: 'alpha', api: 'openai-responses', reasoning: true, input: ['text', 'image'], contextWindow: 200000, customModel: 5 }] },
    other: { apiKey: '$KEEP_REFERENCE', models: [{ id: 'unchanged' }] },
  } };
  const original = '\uFEFF' + JSON.stringify(config, null, 4) + '\n';
  await writeFile(source, original);
  const service = new ModelImportService({ fetch: async () => body() });
  const newKey = '!echo fixture_$TOKEN';
  const preview = await service.preview({ baseUrl: 'https://new.example/v1', apiKey: newKey });
  const result = await service.save(directory, { token: preview.token, provider: '中文服务_1', modelIds: [], updateExisting: true });
  assert.equal(result.added, 0); assert.equal(result.skipped, 0); assert.equal(result.updated, true);
  assert.deepEqual(result.changedFields, ['baseUrl', 'apiKey']);
  assert.ok(result.backup);
  assert.equal(await readFile(result.backup, 'utf8'), original);
  const persisted = await readFile(source, 'utf8');
  const saved = JSON.parse(persisted);
  assert.equal(saved.providers['中文服务_1'].baseUrl, 'https://new.example/v1');
  assert.equal(saved.providers['中文服务_1'].apiKey, '$!echo fixture_$$TOKEN');
  assert.deepEqual(saved.providers['中文服务_1'].models, config.providers['中文服务_1'].models);
  assert.deepEqual(saved.providers['中文服务_1'].custom, config.providers['中文服务_1'].custom);
  assert.deepEqual(saved.providers['中文服务_1'].headers, config.providers['中文服务_1'].headers);
  assert.deepEqual(saved.providers.other, config.providers.other);
  assert.deepEqual(saved.unknownRoot, config.unknownRoot);
  assert.ok(!JSON.stringify(result).includes(newKey));
  const files = await readdir(directory);
  const again = await service.preview({ baseUrl: 'https://new.example/v1/', apiKey: newKey });
  const unchanged = await service.save(directory, { token: again.token, provider: '中文服务_1', modelIds: [], updateExisting: true });
  assert.equal(unchanged.updated, false);
  assert.deepEqual(unchanged.changedFields, []);
  assert.equal(unchanged.backup, undefined);
  assert.equal(await readFile(source, 'utf8'), persisted);
  assert.deepEqual(await readdir(directory), files);
}));

test('duplicate IDs with a different key require explicit update and then save the key rather than silently skipping it', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const original = JSON.stringify({ providers: { existing: { baseUrl: 'https://fixture.example/v1', api: 'openai-completions', apiKey: 'old-fixture-key', models: [{ id: 'alpha', reasoning: true }] } } });
  await writeFile(source, original);
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'https://fixture.example/v1', apiKey: 'new-fixture-key' });
  await assert.rejects(service.save(directory, { token: preview.token, provider: 'existing', modelIds: ['alpha'] }), error => error instanceof ModelImportError && error.code === 'PROVIDER_API_KEY_CONFLICT');
  assert.equal(await readFile(source, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['models.json']);
  const result = await service.save(directory, { token: preview.token, provider: 'existing', modelIds: ['alpha'], updateExisting: true });
  assert.equal(result.added, 0); assert.equal(result.skipped, 1); assert.equal(result.updated, true);
  assert.deepEqual(result.changedFields, ['apiKey']);
  const saved = JSON.parse(await readFile(source, 'utf8'));
  assert.equal(saved.providers.existing.apiKey, 'new-fixture-key');
  assert.deepEqual(saved.providers.existing.models, [{ id: 'alpha', reasoning: true }]);
}));

test('explicit address updates preserve empty-key auth references and inherited model API capabilities', async () => withDirectory(async directory => {
  const source = join(directory, 'models.json');
  const oldModel = { id: 'alpha', reasoning: true, unknown: { keep: true } };
  const original = { providers: { '本地服务': { apiKey: '!do-not-execute', modelOverrides: { alpha: { maxTokens: 123 } }, models: [oldModel] } } };
  await writeFile(source, JSON.stringify(original));
  const service = new ModelImportService({ fetch: async () => body() });
  const preview = await service.preview({ baseUrl: 'http://localhost:11434/v1' });
  const result = await service.save(directory, { token: preview.token, provider: '本地服务', modelIds: ['beta'], updateExisting: true });
  assert.equal(result.added, 1); assert.equal(result.updated, true);
  assert.deepEqual(result.changedFields, ['baseUrl']);
  const saved = JSON.parse(await readFile(source, 'utf8'));
  assert.equal(saved.providers['本地服务'].apiKey, '!do-not-execute');
  assert.equal(saved.providers['本地服务'].api, undefined);
  assert.deepEqual(saved.providers['本地服务'].models[0], oldModel);
  assert.deepEqual(saved.providers['本地服务'].models[1], { id: 'beta', name: 'Beta', api: 'openai-completions' });
  assert.deepEqual(saved.providers['本地服务'].modelOverrides, original.providers['本地服务'].modelOverrides);
  const newService = await service.preview({ baseUrl: 'http://localhost:11434/v1' });
  await assert.rejects(service.save(directory, { token: newService.token, provider: '全新服务', modelIds: [], updateExisting: true }), /至少选择/);
  service.discard(newService.token);
}));
