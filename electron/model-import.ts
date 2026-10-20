import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface ImportableModel { id: string; name: string; reasoning?: boolean }
export interface ModelImportPreview {
  token: string;
  baseUrl: string;
  provider: string;
  models: ImportableModel[];
  expiresAt: number;
}
export interface ModelImportSaveRequest { token: string; provider: string; modelIds: string[]; updateExisting?: boolean }
export interface ModelImportSaveResult { provider: string; source: string; backup?: string; added: number; skipped: number; updated?: boolean; changedFields?: string[] }
export interface ModelReasoningRequest { provider: string; modelId: string; reasoning: boolean; supportsReasoningEffort: boolean }
export interface ModelReasoningSaveResult { provider: string; modelId: string; source: string; backup?: string; changed: boolean }
export interface ModelImportTarget { providerExists: boolean; conflicts: Array<'baseUrl' | 'apiKey' | 'api'>; suggestedProvider?: string }
export class ModelImportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ModelImportError'; }
}
interface PendingImport { apiKey: string; baseUrl: string; models: ImportableModel[]; expiresAt: number }
interface ServiceOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  tokenTtlMs?: number;
  maxResponseBytes?: number;
  maxModels?: number;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: RecordValue, name: string) => Object.hasOwn(value, name);
const configurationError = () => new ModelImportError('CONFIG_INVALID', '现有 models.json 无法读取或格式不正确，请先修复配置文件。');

/** Escape Pi 0.84.2 config templates; never interpret a pasted key as a command or environment reference. */
export function literalApiKey(value: string): string {
  const escaped = value.replaceAll('$', () => '$$');
  return escaped.startsWith('!') ? `$!${escaped.slice(1)}` : escaped;
}

function endpoint(input: string): { baseUrl: string; modelsUrl: string } {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\u0000-\u001f\u007f]/.test(input)) throw new Error('请输入有效的 HTTP 或 HTTPS API 地址。');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入有效的 HTTP 或 HTTPS API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址只支持 HTTP 或 HTTPS。');
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段；请在 Key 输入框单独填写密钥。');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/models')) {
    url.pathname = pathname;
    const modelsUrl = url.href;
    url.pathname = pathname.slice(0, -'/models'.length) || '/';
    return { baseUrl: url.href.replace(/\/$/, ''), modelsUrl };
  }
  url.pathname = pathname || '/v1';
  const baseUrl = url.href.replace(/\/$/, '');
  url.pathname += '/models';
  return { baseUrl, modelsUrl: url.href };
}

function validateProvider(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9\u4e00-\u9fff._-]{1,64}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error('服务名称请使用 1–64 个中文、字母、数字、点、横线或下划线。');
  return value;
}

async function readConfiguration(agentDir: string): Promise<{ source: string; original: Buffer | null; config: RecordValue; providers: RecordValue }> {
  const source = join(agentDir, 'models.json');
  let original: Buffer | null = null;
  let config: RecordValue;
  try {
    original = await readFile(source);
    if (original.byteLength > 8 * 1024 * 1024) throw configurationError();
    const parsed: unknown = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
    if (!record(parsed) || (own(parsed, 'providers') && !record(parsed.providers))) throw configurationError();
    config = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') config = {};
    else throw configurationError();
  }
  return { source, original, config, providers: record(config.providers) ? config.providers : {} };
}

function targetDefinition(providers: RecordValue, provider: string): { providerExists: boolean; definition: RecordValue; models: RecordValue[] } {
  const providerExists = own(providers, provider);
  const existing = providerExists ? providers[provider] : undefined;
  if (providerExists && !record(existing)) throw configurationError();
  const definition = record(existing) ? existing : {};
  if ((definition.apiKey !== undefined && typeof definition.apiKey !== 'string') || (definition.api !== undefined && typeof definition.api !== 'string') || (definition.baseUrl !== undefined && typeof definition.baseUrl !== 'string')) throw configurationError();
  if (definition.models !== undefined && !Array.isArray(definition.models)) throw configurationError();
  const models = Array.isArray(definition.models) ? definition.models : [];
  if (models.some(model => !record(model) || typeof model.id !== 'string')) throw configurationError();
  return { providerExists, definition, models: models as RecordValue[] };
}

function sameBaseUrl(value: unknown, baseUrl: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.search && !url.hash && !url.username && !url.password && url.href.replace(/\/+$/, '') === baseUrl;
  } catch { return false; }
}

function targetConflicts(definition: RecordValue, session: PendingImport, providerExists: boolean): ModelImportTarget['conflicts'] {
  const conflicts: ModelImportTarget['conflicts'] = [];
  if (Object.keys(definition).length && !sameBaseUrl(definition.baseUrl, session.baseUrl)) conflicts.push('baseUrl');
  if (providerExists && session.apiKey && definition.apiKey !== literalApiKey(session.apiKey)) conflicts.push('apiKey');
  if (definition.api !== undefined && definition.api !== 'openai-completions') conflicts.push('api');
  return conflicts;
}

function availableProvider(seed: string, providers: RecordValue): string {
  for (let suffix = 2; ; suffix++) {
    const ending = `-${suffix}`;
    const candidate = `${seed.slice(0, 64 - ending.length)}${ending}`;
    if (!own(providers, candidate)) return candidate;
  }
}

function suggestedProvider(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 56);
  return host && !['constructor', 'prototype'].includes(host) ? host : 'custom-api';
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Do not expose service response data. */ }
}

async function limitedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) { await cancelBody(response); throw new Error('模型列表响应过大，请使用更精简的模型接口。'); }
  if (!response.body) throw new Error('服务没有返回有效的模型列表。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { try { await reader.cancel(); } catch { /* Transport may already be closed. */ } throw new Error('模型列表响应过大，请使用更精简的模型接口。'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('服务返回的内容不是有效的 JSON 模型列表。'); }
}

function safeModels(value: unknown, apiKey: string, limit: number): ImportableModel[] {
  const data = record(value) ? value.data : undefined;
  if (!Array.isArray(data)) throw new Error('服务未返回 OpenAI 兼容模型列表，请检查 API 地址。');
  if (data.length > limit) throw new Error('模型数量过多，请使用更精简的模型接口。');
  const secrets = apiKey ? [apiKey, encodeURIComponent(apiKey)] : [];
  const exposesSecret = (text: string) => secrets.some(secret => text.includes(secret));
  const seen = new Set<string>();
  const models: ImportableModel[] = [];
  for (const item of data) {
    if (!record(item) || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || exposesSecret(id) || seen.has(id)) continue;
    seen.add(id);
    const candidate = typeof item.name === 'string' ? item.name.trim() : '';
    const name = candidate && candidate.length <= 256 && !/[\u0000-\u001f\u007f]/.test(candidate) && !exposesSecret(candidate) ? candidate : id;
    // Only trust an explicit boolean capability, never infer support from a model name.
    models.push({ id, name, ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}) });
  }
  if (!models.length) throw new Error('服务没有返回可添加的模型。');
  return models;
}

/** Main-process-only short-lived credentials. Public results contain display metadata, never keys or headers. */
export class ModelImportService {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly options: Required<Omit<ServiceOptions, 'fetch' | 'now'>>;
  private readonly pending = new Map<string, PendingImport>();
  private readonly expiration = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: ServiceOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.options = { timeoutMs: options.timeoutMs ?? 15_000, tokenTtlMs: options.tokenTtlMs ?? 5 * 60_000, maxResponseBytes: options.maxResponseBytes ?? 2 * 1024 * 1024, maxModels: options.maxModels ?? 2000 };
  }

  private prune(): void {
    for (const [token, value] of this.pending) if (value.expiresAt <= this.now()) this.discard(token);
  }

  discard(token: string): void {
    this.pending.delete(token);
    const timer = this.expiration.get(token);
    if (timer) clearTimeout(timer);
    this.expiration.delete(token);
  }

  private getSession(token: string): PendingImport {
    this.prune();
    const session = this.pending.get(token);
    if (!session) throw new ModelImportError('PREVIEW_EXPIRED', '模型预览已失效，请重新获取模型列表。');
    return session;
  }

  async describeTarget(agentDir: string, token: string, providerInput: string): Promise<ModelImportTarget> {
    const session = this.getSession(token);
    const provider = validateProvider(providerInput);
    const { providers } = await readConfiguration(agentDir);
    const { providerExists, definition } = targetDefinition(providers, provider);
    const seed = session.apiKey && provider.includes(session.apiKey) ? suggestedProvider(session.baseUrl) : provider;
    return { providerExists, conflicts: targetConflicts(definition, session, providerExists), ...(providerExists ? { suggestedProvider: availableProvider(seed, providers) } : {}) };
  }

  async preview(request: { baseUrl: string; apiKey?: string }): Promise<ModelImportPreview> {
    const addresses = endpoint(request?.baseUrl);
    if (request.apiKey !== undefined && typeof request.apiKey !== 'string') throw new Error('请输入有效的 API Key。');
    const apiKey = request.apiKey?.trim() ?? '';
    if (apiKey.length > 8192 || /[^\x20-\x7e]/.test(apiKey)) throw new Error('API Key 含有无效字符，请重新填写。');
    if (apiKey && (addresses.baseUrl.includes(apiKey) || addresses.baseUrl.includes(encodeURIComponent(apiKey)))) throw new Error('请从 API 地址中移除密钥，并在 Key 输入框单独填写。');
    this.prune();
    if (this.pending.size + this.inFlight >= 8) throw new Error('待添加的服务过多，请先完成或关闭已有模型预览。');
    this.inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(addresses.modelsUrl, { method: 'GET', headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, redirect: 'manual', signal: controller.signal });
      } catch { throw new Error(controller.signal.aborted ? '获取模型列表超时，请稍后重试。' : '无法连接模型服务，请检查 API 地址和网络。'); }
      if (!response.ok) {
        await cancelBody(response);
        if (response.status === 401 || response.status === 403) throw new Error('模型服务拒绝访问，请检查 API Key 和访问权限。');
        if (response.status === 404) throw new Error('找不到模型列表接口，请检查 API 地址是否包含正确的 /v1 路径。');
        if (response.status >= 300 && response.status < 400) throw new Error('模型接口返回重定向，请填写最终的 API 地址后重试。');
        if (response.status === 429) throw new Error('模型服务请求过于频繁，请稍后重试。');
        throw new Error('模型服务暂时不可用，请稍后重试。');
      }
      let value: unknown;
      try { value = await limitedJson(response, this.options.maxResponseBytes); }
      catch (error) {
        if (controller.signal.aborted) throw new Error('获取模型列表超时，请稍后重试。');
        if (error instanceof Error && ['模型列表响应过大，请使用更精简的模型接口。', '服务没有返回有效的模型列表。', '服务返回的内容不是有效的 JSON 模型列表。'].includes(error.message)) throw error;
        throw new Error('无法读取模型服务返回的列表，请稍后重试。');
      }
      const models = safeModels(value, apiKey, this.options.maxModels);
      const token = randomUUID();
      const expiresAt = this.now() + this.options.tokenTtlMs;
      this.pending.set(token, { apiKey, baseUrl: addresses.baseUrl, models, expiresAt });
      const expiration = setTimeout(() => this.discard(token), this.options.tokenTtlMs);
      expiration.unref();
      this.expiration.set(token, expiration);
      return { token, baseUrl: addresses.baseUrl, provider: suggestedProvider(addresses.baseUrl), models: models.map(model => ({ ...model })), expiresAt };
    } finally { clearTimeout(timer); this.inFlight--; }
  }

  save(agentDir: string, request: ModelImportSaveRequest): Promise<ModelImportSaveResult> {
    const operation = this.writes.then(() => this.saveSerial(agentDir, request));
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  configureReasoning(agentDir: string, request: ModelReasoningRequest): Promise<ModelReasoningSaveResult> {
    const operation = this.writes.then(() => this.configureReasoningSerial(agentDir, request));
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  private async configureReasoningSerial(agentDir: string, request: ModelReasoningRequest): Promise<ModelReasoningSaveResult> {
    const provider = validateProvider(request?.provider);
    const modelId = request.modelId;
    if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 256 || /[\u0000-\u001f\u007f]/.test(modelId)) throw new Error('模型 ID 无效。');
    if (typeof request.reasoning !== 'boolean' || typeof request.supportsReasoningEffort !== 'boolean') throw new Error('思考能力设置无效。');
    const { source, original, config, providers } = await readConfiguration(agentDir);
    const { providerExists, definition, models } = targetDefinition(providers, provider);
    const matches = models.filter(model => model.id === modelId);
    if (!providerExists || matches.length !== 1) throw new ModelImportError('MODEL_NOT_CONFIGURED', '找不到唯一的已配置模型，请重新加载模型配置。');
    const model = matches[0];
    if ((model.api ?? definition.api) !== 'openai-completions') throw new ModelImportError('MODEL_API_UNSUPPORTED', '此功能适用于 OpenAI 兼容接口接入的模型。请保留当前模型的原有协议配置。');
    if ((model.compat !== undefined && !record(model.compat)) || (definition.compat !== undefined && !record(definition.compat))) throw configurationError();
    const compat = record(model.compat) ? model.compat : {};
    const nextModel = { ...model, reasoning: request.reasoning, compat: { ...compat, supportsReasoningEffort: request.supportsReasoningEffort } };
    if (model.reasoning === request.reasoning && compat.supportsReasoningEffort === request.supportsReasoningEffort) return { provider, modelId, source, changed: false };
    const updated = { ...config, providers: { ...providers, [provider]: { ...definition, models: models.map(entry => entry === model ? nextModel : entry) } } };
    const backup = await this.writeConfiguration(agentDir, source, original, updated);
    return { provider, modelId, source, ...(backup ? { backup } : {}), changed: true };
  }

  private async saveSerial(agentDir: string, request: ModelImportSaveRequest): Promise<ModelImportSaveResult> {
    const session = this.getSession(request?.token);
    const provider = validateProvider(request.provider);
    if (request.updateExisting !== undefined && typeof request.updateExisting !== 'boolean') throw new Error('服务更新选项无效。');
    if (!Array.isArray(request.modelIds) || request.modelIds.length > this.options.maxModels || request.modelIds.some(id => typeof id !== 'string')) throw new Error('请至少选择一个有效的模型。');
    const byId = new Map(session.models.map(model => [model.id, model]));
    const ids = [...new Set(request.modelIds)];
    if (ids.some(id => !byId.has(id))) throw new Error('所选模型不属于当前预览，请重新获取模型列表。');
    const { source, original, config, providers } = await readConfiguration(agentDir);
    const { providerExists, definition, models: existingModels } = targetDefinition(providers, provider);
    if (!ids.length && !(request.updateExisting && providerExists)) throw new Error('请至少选择一个有效的模型。');
    const conflicts = targetConflicts(definition, session, providerExists);
    if (conflicts.includes('api')) throw new ModelImportError('PROVIDER_API_CONFLICT', '此服务已有其他 API 协议，请使用另一个服务名称以保留原配置。');
    if (!request.updateExisting && conflicts.includes('baseUrl')) throw new ModelImportError('PROVIDER_BASE_URL_CONFLICT', '此服务名称已有其他 API 地址或配置，请勾选更新已有服务，或使用另一个服务名称。');
    if (!request.updateExisting && conflicts.includes('apiKey')) throw new ModelImportError('PROVIDER_API_KEY_CONFLICT', '此服务名称已使用其他密钥，请勾选更新已有服务，或使用另一个服务名称。');
    const known = new Set(existingModels.map(model => model.id));
    const additions = ids.filter(id => !known.has(id)).map(id => ({ ...byId.get(id)!, ...(providerExists && definition.api === undefined ? { api: 'openai-completions' } : {}) }));
    const encodedKey = literalApiKey(session.apiKey || 'pi-desktop-local');
    const apiKey = !session.apiKey && providerExists ? definition.apiKey : encodedKey;
    const changedFields: string[] = [];
    if (providerExists && !sameBaseUrl(definition.baseUrl, session.baseUrl)) changedFields.push('baseUrl');
    if (providerExists && definition.apiKey !== apiKey) changedFields.push('apiKey');
    if (!additions.length && !changedFields.length) {
      this.discard(request.token);
      return { provider, source, added: 0, skipped: ids.length, updated: false, changedFields: [] };
    }
    const next = {
      ...definition,
      baseUrl: sameBaseUrl(definition.baseUrl, session.baseUrl) ? definition.baseUrl : session.baseUrl,
      ...(!providerExists ? { api: 'openai-completions' } : {}),
      apiKey,
      ...(definition.authHeader === undefined ? { authHeader: !!session.apiKey } : {}),
      models: [...existingModels, ...additions],
    };
    const updated = { ...config, providers: { ...providers, [provider]: next } };
    const backup = await this.writeConfiguration(agentDir, source, original, updated, () => {
      if (this.pending.get(request.token) !== session) throw new ModelImportError('PREVIEW_EXPIRED', '模型预览已失效，请重新获取模型列表。');
    });
    this.discard(request.token);
    return { provider, source, ...(backup ? { backup } : {}), added: additions.length, skipped: ids.length - additions.length, updated: providerExists && changedFields.length > 0, changedFields };
  }

  private async writeConfiguration(agentDir: string, source: string, original: Buffer | null, updated: RecordValue, beforeReplace?: () => void): Promise<string | undefined> {
    const contents = Buffer.from(JSON.stringify(updated, null, 2) + '\n', 'utf8');
    const temp = join(agentDir, `.models-import-${randomUUID()}.tmp`);
    let backup: string | undefined;
    try {
      await mkdir(agentDir, { recursive: true });
      if (original) {
        backup = `${source}.backup-${this.now()}-${randomUUID()}`;
        const backupFile = await open(backup, 'wx', 0o600);
        try { await backupFile.writeFile(original); await backupFile.sync(); }
        finally { await backupFile.close(); }
      }
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(contents); await file.sync(); }
      finally { await file.close(); }
      // Protect edits made outside this serialized service while the new file was prepared.
      const current = await readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if ((original === null) !== (current === null) || (original && current && !original.equals(current))) throw new ModelImportError('CONFIG_CHANGED', '模型配置刚刚发生变化，请重新读取后保存。');
      beforeReplace?.();
      await rename(temp, source);
      let verified: Buffer;
      try { verified = await readFile(source); }
      catch { throw new ModelImportError('VERIFY_FAILED', '配置已写入，但无法回读确认，请重新加载模型配置检查结果。'); }
      if (!verified.equals(contents)) throw new ModelImportError('VERIFY_FAILED', '保存后的配置与预期不一致，请重新加载模型配置检查结果。');
    } catch (error) {
      if (error instanceof ModelImportError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new ModelImportError('WRITE_PERMISSION_DENIED', '无法写入模型配置，请检查配置目录和文件的写入权限。');
      if (code === 'ENOSPC') throw new ModelImportError('WRITE_DISK_FULL', '无法保存模型配置，磁盘空间不足。');
      throw new ModelImportError('WRITE_FAILED', '无法保存模型配置，请检查文件权限和可用空间后重试。');
    } finally { await unlink(temp).catch(() => {}); }
    return backup;
  }
}
