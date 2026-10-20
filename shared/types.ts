export type RpcRecord = Record<string, any>;
export interface Project { path: string; name: string; lastOpened: string }
export interface ProjectMigrationCandidate extends Project { sessionCount: number; available: boolean }
export interface ProjectMigrationPreview { source: string; projects: ProjectMigrationCandidate[]; sessionCount: number; warnings: string[] }
export interface ProjectMigrationResult { preferences: Preferences; imported: number; alreadyPresent: number; skipped: number; sessionCount: number }
export interface SessionInfo { path: string; id: string; cwd: string; name?: string; firstMessage: string; modified: string; messageCount: number }
export interface Preferences { projects: Project[]; lastProject?: string; piPath?: string; nodePath?: string; theme: 'light' | 'dark'; lastSessions?: Record<string, string> }
export type RuntimeSource = 'bundled' | 'system' | 'custom';
export interface Diagnostics { piPath: string | null; piVersion: string | null; nodePath: string | null; nodeVersion: string | null; bashPath: string | null; agentDir: string; errors: string[]; piSource?: RuntimeSource; nodeSource?: RuntimeSource; bashSource?: RuntimeSource; runtimeRoot?: string; warnings?: string[] }
export interface ConfiguredModel { provider: string; id: string; name: string; api?: string; reasoning?: boolean; supportsReasoningEffort?: boolean }
export interface ModelConfigSummary { source: string; models: ConfiguredModel[]; defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string; error?: string }
export interface ModelPreviewInput { url: string; apiKey?: string; provider?: string }
export interface ModelImportPreview { token: string; baseUrl: string; provider: string; models: Array<{ id: string; name: string; exists?: boolean; reasoning?: boolean }>; expiresAt: number; providerExists?: boolean; conflicts?: Array<'baseUrl' | 'apiKey' | 'api'>; suggestedProvider?: string }
export interface ModelImportInput { token: string; provider: string; modelIds: string[]; updateExisting?: boolean }
export interface ModelImportResult { provider: string; source: string; backup?: string; added: number; skipped: number; summary: ModelConfigSummary; updated?: boolean; changedFields?: string[] }
export interface ModelReasoningInput { provider: string; modelId: string; reasoning: boolean; supportsReasoningEffort: boolean }
export interface ModelReasoningResult { provider: string; modelId: string; source: string; backup?: string; changed: boolean; summary: ModelConfigSummary }
export interface CachedConversationTab {
  id: string; project: string; sessionPath?: string; lastActivity: number; unread: boolean;
  view: RpcRecord;
  ui: { windowStart: number | null; scrollTop: number; nearBottom: boolean };
}
export interface WorkspaceSnapshot {
  version: 1; savedAt: number; activeId: string | null; tabs: CachedConversationTab[];
  ui?: { sidebar?: boolean; inspector?: boolean };
}
export interface Bootstrap { preferences: Preferences; diagnostics: Diagnostics; version: string; modelConfig: ModelConfigSummary; workspace?: WorkspaceSnapshot | null }
export interface ConnectOptions { newSession?: boolean; connectionId?: string; background?: boolean; restoring?: boolean }
export interface BootstrapOptions { workspace?: boolean }
export interface Connection { connectionId?: string; project: string; state: RpcRecord; messages: RpcRecord[]; models: RpcRecord[]; commands: RpcRecord[]; stats: RpcRecord }
export interface ConnectionSummary { id: string; project: string; sessionPath?: string; sessionName?: string; status: string; busy: boolean; lastActivity: number }
export interface FileAttachment { name: string; path: string; type: 'text' | 'image'; content?: string; data?: string; mimeType?: string }
export interface RedirectPrompt { message: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
export interface RedirectResult { requestId: string; status: 'submitted' | 'superseded' | 'cancelled'; cancelled?: boolean; superseded?: boolean }
export interface PiDesktopApi {
  bootstrap(options?: BootstrapOptions): Promise<Bootstrap>;
  chooseProject(): Promise<string | null>;
  previewProjectMigration(): Promise<ProjectMigrationPreview>;
  importProjects(paths: string[]): Promise<ProjectMigrationResult>;
  previewModels(input: ModelPreviewInput): Promise<ModelImportPreview>;
  importModels(input: ModelImportInput): Promise<ModelImportResult>;
  configureModelReasoning(input: ModelReasoningInput): Promise<ModelReasoningResult>;
  discardModelPreview(token: string): Promise<void>;
  reloadModels(connectionId?: string): Promise<Connection>;
  connect(project: string, sessionPath?: string, options?: ConnectOptions): Promise<Connection>;
  activateConnection(id: string): Promise<Connection>;
  selectConnection(id: string): Promise<ConnectionSummary>;
  listConnections(): Promise<ConnectionSummary[]>;
  disconnect(connectionId?: string): Promise<void>;
  listSessions(project: string): Promise<SessionInfo[]>;
  rpc(command: RpcRecord, connectionId?: string): Promise<RpcRecord>;
  redirect(prompt: RedirectPrompt, connectionId?: string): Promise<RedirectResult>;
  respondUI(response: RpcRecord, connectionId?: string): Promise<void>;
  onEvent(callback: (event: RpcRecord) => void): () => void;
  savePreferences(patch: Partial<Preferences>): Promise<Preferences>;
  saveWorkspace(snapshot: WorkspaceSnapshot): Promise<void>;
  onWorkspaceFlush(callback: () => void | Promise<void>): () => void;
  chooseFiles(): Promise<FileAttachment[]>;
  openExternal(url: string): Promise<void>;
  revealFile(path: string): Promise<void>;
}
declare global { interface Window { pi: PiDesktopApi } }
