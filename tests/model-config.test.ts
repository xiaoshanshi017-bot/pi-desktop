import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { readModelConfigSummary } from '../electron/model-config';

test('model summaries expose display metadata and defaults without credentials or endpoint details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-model-summary-'));
  try {
    await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: {
      custom: { apiKey: 'secret-value-do-not-expose', baseUrl: 'https://secret-endpoint.invalid', headers: { authorization: 'hidden-auth-header' }, models: [{ id: 'test-model', name: '示例模型', headers: { 'x-api-key': 'hidden-model-header' }, cost: { input: 1 } }, { id: 'fallback-name' }, null] },
      builtin: { apiKey: 'another-secret' },
    } }));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'custom', defaultModel: 'test-model', defaultThinkingLevel: 'high', unrelated: 'private-setting' }));
    const summary = await readModelConfigSummary(directory);
    assert.deepEqual(summary, { source: join(directory, 'models.json'), models: [{ provider: 'custom', id: 'test-model', name: '示例模型' }, { provider: 'custom', id: 'fallback-name', name: 'fallback-name' }], defaultProvider: 'custom', defaultModel: 'test-model', defaultThinkingLevel: 'high' });
    assert.doesNotMatch(JSON.stringify(summary), /secret|hidden|private-setting|apiKey|baseUrl|headers/);
    await writeFile(join(directory, 'models.json'), '{"apiKey":"secret-value-do-not-expose",');
    const invalid = await readModelConfigSummary(directory);
    assert.equal(invalid.models.length, 0);
    assert.ok(invalid.error);
    assert.doesNotMatch(JSON.stringify(invalid), /secret-value/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('pi-model-summary-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing optional model configuration produces an empty summary', async () => {
  const directory = join(tmpdir(), `pi-model-summary-missing-${crypto.randomUUID()}`);
  assert.deepEqual(await readModelConfigSummary(directory), { source: join(directory, 'models.json'), models: [] });
});
