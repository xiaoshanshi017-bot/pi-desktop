import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelConfigSummary } from '../shared/types';

/** Configuration metadata only. Never expose API keys, headers, or endpoint URLs. */
export async function readModelConfigSummary(directory: string): Promise<ModelConfigSummary> {
  const source = join(directory, 'models.json');
  const summary: ModelConfigSummary = { source, models: [] };
  try {
    const config = JSON.parse(await readFile(source, 'utf8'));
    if (config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)) {
      for (const [provider, definition] of Object.entries(config.providers)) {
        if (!definition || typeof definition !== 'object' || !Array.isArray((definition as { models?: unknown }).models)) continue;
        for (const model of (definition as { models: unknown[] }).models) {
          if (!model || typeof model !== 'object') continue;
          const entry = model as { id?: unknown; name?: unknown };
          if (typeof entry.id !== 'string' || !entry.id) continue;
          summary.models.push({ provider, id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id });
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') summary.error = '无法读取模型配置，请检查 models.json 的格式和文件权限。';
  }
  try {
    const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
    for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'] as const) {
      if (typeof settings[key] === 'string') summary[key] = settings[key];
    }
  } catch { /* Defaults are optional; never include raw parser errors or file content. */ }
  return summary;
}
