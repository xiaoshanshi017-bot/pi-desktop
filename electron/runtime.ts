import { stat } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import type { Diagnostics } from '../shared/types';

export function bundledRuntimePaths(runtimeRoot: string) {
  const root = resolve(runtimeRoot);
  return {
    node: join(root, 'node', 'node.exe'),
    pi: join(root, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    launcher: join(root, 'pi-launcher.mjs'),
    bash: join(root, 'git', 'bin', 'bash.exe'),
    bashFallback: join(root, 'git', 'usr', 'bin', 'bash.exe'),
    pathDirectories: [
      join(root, 'node'), join(root, 'git', 'bin'), join(root, 'git', 'cmd'),
      join(root, 'git', 'usr', 'bin'), join(root, 'git', 'ucrt64', 'bin'), join(root, 'git', 'mingw64', 'bin'), join(root, 'bin'),
    ],
  };
}

function uniqueDirectories(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return paths.map(path => path.replace(/^"|"$/g, '')).filter(path => {
    if (!path) return false;
    const key = platform === 'win32' ? win32.normalize(path).toLowerCase().replace(/\\$/, '') : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function environmentPathDirectories(environment: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const pathValues = Object.entries(environment).filter(([key]) => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
  return uniqueDirectories(pathValues.flatMap(([, value]) => (value ?? '').split(platform === 'win32' ? ';' : ':')), platform);
}

/** Build only the Pi child's environment; the parent and Windows PATH stay untouched. */
export async function createPiEnvironment(runtimeRoot?: string, inherited: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  const bundled = runtimeRoot ? bundledRuntimePaths(runtimeRoot).pathDirectories : [];
  const existing = await Promise.all(bundled.map(async directory => {
    try { return (await stat(directory)).isDirectory() ? directory : null; } catch { return null; }
  }));
  const directories = uniqueDirectories([...existing.filter((directory): directory is string => directory !== null), ...environmentPathDirectories(inherited, platform)], platform);
  for (const key of Object.keys(environment)) {
    if (platform === 'win32' ? ['path', 'electron_run_as_node', 'pi_desktop_bash_path'].includes(key.toLowerCase()) : ['PATH', 'ELECTRON_RUN_AS_NODE', 'PI_DESKTOP_BASH_PATH'].includes(key)) delete environment[key];
  }
  environment[platform === 'win32' ? 'Path' : 'PATH'] = directories.join(platform === 'win32' ? ';' : ':');
  return environment;
}

export async function createPiLaunchOptions(
  diagnostics: Diagnostics,
  runtimeRoot: string,
  args: string[],
  options: { developmentLauncher?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> {
  if (!diagnostics.piPath || !diagnostics.nodePath) throw new Error('Pi 或 Node.js 运行环境不可用。');
  const env = await createPiEnvironment(runtimeRoot, options.environment);
  if (diagnostics.piSource === 'bundled') {
    const candidates = [bundledRuntimePaths(runtimeRoot).launcher, ...(options.developmentLauncher ? [options.developmentLauncher] : [])];
    let launcher: string | undefined;
    for (const candidate of candidates) {
      try { if ((await stat(candidate)).isFile()) { launcher = candidate; break; } } catch { /* Try the development source fallback. */ }
    }
    if (!launcher) throw new Error('内置 Pi 启动器缺失，请重新运行安装程序修复，或重新安装 Pi Desktop。');
    if (diagnostics.bashPath) env.PI_DESKTOP_BASH_PATH = diagnostics.bashPath;
    return { executable: diagnostics.nodePath, args: [launcher, diagnostics.piPath, ...args], env };
  }
  const script = /\.[cm]?js$/i.test(diagnostics.piPath);
  return { executable: script ? diagnostics.nodePath : diagnostics.piPath, args: [...(script ? [diagnostics.piPath] : []), ...args], env };
}
