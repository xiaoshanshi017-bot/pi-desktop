export type RpcRecord = Record<string, any>;
export interface Project { path: string; name: string; lastOpened: string }
export interface ProjectMigrationCandidate extends Project { sessionCount: number; available: boolean }
export interface ProjectMigrationPreview { source: string; projects: ProjectMigrationCandidate[]; sessionCount: number; warnings: string[] }
export interface ProjectMigrationResult { preferences: Preferences; imported: number; alreadyPresent: number; skipped: number; sessionCount: number }
export interface SessionInfo { path: string; id: string; cwd: string; name?: string; firstMessage: string; modified: string; messageCount: number }
export interface Preferences { projects: Project[]; lastProject?: string; piPath?: string; nodePath?: string; theme: 'light' | 'dark'; lastSessions?: Record<string, string> }
export type RuntimeSource = 'bundled' | 'system' | 'custom';
export interface Diagnostics { piPath: string | null; piVersion: string | null; nodePath: string | null; nodeVersion: string | null; bashPath: string | null; agentDir: string; errors: string[]; piSource?: RuntimeSource; nodeSource?: RuntimeSource; bashSource?: RuntimeSource; runtimeRoot?: string; warnings?: string[] }
export interface ConfiguredModel { provider: string; id: string; name: string }
export interface ModelConfigSummary { source: string; models: ConfiguredModel[]; defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string; error?: string }
export interface Bootstrap { preferences: Preferences; diagnostics: Diagnostics; version: string; modelConfig: ModelConfigSummary }
export interface Connection { connectionId?: string; project: string; state: RpcRecord; messages: RpcRecord[]; models: RpcRecord[]; commands: RpcRecord[]; stats: RpcRecord }
export interface ConnectionSummary { id: string; project: string; sessionPath?: string; sessionName?: string; status: string; busy: boolean; lastActivity: number }
export interface FileAttachment { name: string; path: string; type: 'text' | 'image'; content?: string; data?: string; mimeType?: string }
export interface PiDesktopApi {
  bootstrap(): Promise<Bootstrap>;
  chooseProject(): Promise<string | null>;
  previewProjectMigration(): Promise<ProjectMigrationPreview>;
  importProjects(paths: string[]): Promise<ProjectMigrationResult>;
  connect(project: string, sessionPath?: string, options?: { newSession?: boolean }): Promise<Connection>;
  activateConnection(id: string): Promise<Connection>;
  selectConnection(id: string): Promise<ConnectionSummary>;
  listConnections(): Promise<ConnectionSummary[]>;
  disconnect(connectionId?: string): Promise<void>;
  listSessions(project: string): Promise<SessionInfo[]>;
  rpc(command: RpcRecord, connectionId?: string): Promise<RpcRecord>;
  respondUI(response: RpcRecord, connectionId?: string): Promise<void>;
  onEvent(callback: (event: RpcRecord) => void): () => void;
  savePreferences(patch: Partial<Preferences>): Promise<Preferences>;
  chooseFiles(): Promise<FileAttachment[]>;
  openExternal(url: string): Promise<void>;
  revealFile(path: string): Promise<void>;
}
declare global { interface Window { pi: PiDesktopApi } }
