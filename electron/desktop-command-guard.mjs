// Process-local defaults for the pinned Pi CLI. Pi documents in-place changes
// to tool_call.input; leave the tool implementation and explicit limits intact.
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

export default function desktopCommandGuard(pi) {
  pi.on('tool_call', event => {
    if (event.toolName === 'bash' && event.input.timeout === undefined) {
      event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
    }
  });
  pi.on('before_agent_start', event => ({
    systemPrompt: `${event.systemPrompt}\n桌面命令执行规则：bash 未填写 timeout 时默认在 300 秒后终止并返回超时错误。每次执行命令请显式填写合适的 timeout（秒）；普通诊断或采样通常设为 60–120 秒，确需更久的任务可指定更长时限。一次性脚本保存结果后应清理后台定时器并退出。工具会自动截断过长输出，普通诊断无需接 head；管道可能缓冲输出并等待进程结束。超时后检查原因并调整命令，避免原样反复重试。`,
  }));
}
