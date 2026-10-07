// Desktop adapter for the pinned Pi 0.84.2 CLI. Only bundled Pi uses this file.
// An absolute default shell avoids Windows where.exe code-page conversion when
// the installed application path contains Chinese or other non-ASCII text.
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDesktopSessionControls } from './desktop-session-controls.mjs';

try {
  const cliPath = process.argv[2];
  const defaultShell = process.env.PI_DESKTOP_BASH_PATH;
  delete process.env.PI_DESKTOP_BASH_PATH;
  if (!cliPath || !isAbsolute(cliPath)) throw new Error('内置 Pi CLI 路径无效。');
  if (!defaultShell || !isAbsolute(defaultShell) || !(await stat(defaultShell)).isFile()) throw new Error('内置 Pi 的默认 shell 路径无效，请修复运行环境。');
  const commandGuard = fileURLToPath(new URL('./desktop-command-guard.mjs', import.meta.url));
  if (!(await stat(commandGuard)).isFile()) throw new Error('内置 Pi 的命令超时扩展缺失，请修复运行环境。');
  const packageRoot = dirname(dirname(cliPath));
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version !== '0.84.2') throw new Error('内置 Pi 版本不匹配，请修复安装。');
  const { AgentSession } = await import(pathToFileURL(join(packageRoot, 'dist', 'core', 'agent-session.js')).href);
  installDesktopSessionControls(AgentSession);

  const { SettingsManager } = await import(pathToFileURL(join(packageRoot, 'dist', 'core', 'settings-manager.js')).href);
  const descriptor = Object.getOwnPropertyDescriptor(SettingsManager?.prototype ?? {}, 'getShellPath');
  const original = descriptor?.value;
  if (typeof original !== 'function') throw new Error('内置 Pi shell 设置接口不可用，请修复安装。');
  // Pi's own merged global/project setting always wins, including future edits.
  // No setting is written: the fallback exists only inside this Pi process.
  Object.defineProperty(SettingsManager.prototype, 'getShellPath', {
    ...descriptor,
    value: function (...args) { return Reflect.apply(original, this, args) || defaultShell; },
  });
  process.argv.splice(1, 2, cliPath, '--extension', commandGuard);
  const modeIndex = process.argv.indexOf('--mode');
  if (modeIndex >= 0 && process.argv[modeIndex + 1] === 'rpc') process.stdout.write(JSON.stringify({ type: 'desktop_capabilities', sessionControls: true }) + '\n');
  await import(pathToFileURL(cliPath).href);
} catch (error) {
  process.stderr.write(`Pi Desktop 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
