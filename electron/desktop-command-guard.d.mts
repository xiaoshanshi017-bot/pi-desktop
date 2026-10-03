export const DEFAULT_BASH_TIMEOUT_SECONDS: 300;

interface DesktopExtensionAPI {
  on(event: 'tool_call', handler: (event: { toolName: string; input: Record<string, unknown> }) => void): void;
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string }) => { systemPrompt: string }): void;
}

export default function desktopCommandGuard(pi: DesktopExtensionAPI): void;
