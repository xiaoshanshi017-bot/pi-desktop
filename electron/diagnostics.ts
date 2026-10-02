import { stat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Diagnostics, Preferences, RuntimeSource } from '../shared/types';
import { expandPath } from './storage';
import { bundledRuntimePaths, createPiEnvironment, environmentPathDirectories } from './runtime';

const execute = promisify(execFile);
export interface DiagnosticsContext {
  runtimeRoot?: string;
  packaged?: boolean;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  projectDir?: string;
  runNodeVersion?: (nodePath: string, environment: NodeJS.ProcessEnv) => Promise<string>;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try { if ((await stat(candidate)).isFile()) return resolve(candidate); } catch { /* Continue discovery. */ }
  }
  return null;
}

function validNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function discoverDiagnostics(preferences: Preferences, context: DiagnosticsContext = {}): Promise<Diagnostics> {
  const environment = context.environment ?? process.env;
  const platform = context.platform ?? process.platform;
  const home = context.homeDir ?? homedir();
  const projectDir = context.projectDir ?? preferences.lastProject ?? process.cwd();
  const profile = environment.PI_CODING_AGENT_DIR ? expandPath(environment.PI_CODING_AGENT_DIR, projectDir) : join(home, '.pi', 'agent');
  const dirs = environmentPathDirectories(environment, platform);
  const win = platform === 'win32';
  const runtimeRoot = context.runtimeRoot ? resolve(context.runtimeRoot) : undefined;
  const bundled = runtimeRoot ? bundledRuntimePaths(runtimeRoot) : undefined;
  const childEnvironment = await createPiEnvironment(runtimeRoot, environment, platform);
  const runNodeVersion = context.runNodeVersion ?? (async (nodePath: string, env: NodeJS.ProcessEnv) => {
    const { stdout } = await execute(nodePath, ['--version'], { timeout: 5000, windowsHide: true, env });
    return stdout.trim();
  });
  const systemNodeCandidates = [
    ...dirs.map(path => join(path, win ? 'node.exe' : 'node')),
    ...(environment.NVM_SYMLINK ? [join(environment.NVM_SYMLINK, 'node.exe')] : []),
    ...(win ? [join(environment.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')] : ['/usr/local/bin/node', '/usr/bin/node']),
  ];
  const roots = [
    ...(environment.APPDATA ? [join(environment.APPDATA, 'npm', 'node_modules')] : []),
    ...dirs.flatMap(path => [join(path, 'node_modules'), join(path, '..', 'lib', 'node_modules')]),
    join(home, '.npm-global', 'lib', 'node_modules'),
  ];
  const systemPiCandidates = roots.flatMap(path => ['@earendil-works', '@mariozechner'].map(scope => join(path, scope, 'pi-coding-agent', 'dist', 'cli.js')));
  const knownBashCandidates = win ? [
    ...(environment.ProgramFiles ? [join(environment.ProgramFiles, 'Git', 'bin', 'bash.exe')] : []),
    ...(environment['ProgramFiles(x86)'] ? [join(environment['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe')] : []),
  ] : ['/bin/bash'];
  const pathBashCandidates = dirs.map(path => join(path, win ? 'bash.exe' : 'bash'));

  const [bundledNode, bundledPi, bundledBash] = await Promise.all([
    firstExisting(bundled ? [bundled.node] : []), firstExisting(bundled ? [bundled.pi] : []), firstExisting(bundled ? [bundled.bash, bundled.bashFallback] : []),
  ]);
  let nodePath = await firstExisting(preferences.nodePath ? [expandPath(preferences.nodePath)] : [bundledNode ?? '', ...systemNodeCandidates]);
  let nodeSource: RuntimeSource | undefined = nodePath ? preferences.nodePath ? 'custom' : nodePath === bundledNode ? 'bundled' : 'system' : undefined;
  let piCandidates: string[];
  if (preferences.piPath) {
    const chosen = expandPath(preferences.piPath);
    if (/\.(cmd|ps1)$/i.test(chosen)) {
      piCandidates = ['@earendil-works', '@mariozechner'].map(scope => join(dirname(chosen), 'node_modules', scope, 'pi-coding-agent', 'dist', 'cli.js'));
    } else if (!extname(chosen)) piCandidates = [join(chosen, 'dist', 'cli.js'), chosen];
    else piCandidates = [chosen];
  } else piCandidates = [bundledPi ?? '', ...systemPiCandidates];
  const [piPath, automaticBashPath] = await Promise.all([
    firstExisting(piCandidates), firstExisting([...knownBashCandidates, bundledBash ?? '', ...pathBashCandidates]),
  ]);
  // Pi gives an explicit shellPath precedence over automatic shell discovery.
  // Validate it without changing settings or replacing the configured shell.
  let configuredShell: unknown;
  for (const settingsFile of [join(profile, 'settings.json'), join(projectDir, '.pi', 'settings.json')]) {
    try {
      const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
      if (settings && Object.prototype.hasOwnProperty.call(settings, 'shellPath')) configuredShell = settings.shellPath;
    } catch { /* Pi reports malformed settings itself; missing files are normal. */ }
  }
  let customShellPath: string | undefined;
  if (typeof configuredShell === 'string' && configuredShell) {
    let normalized = configuredShell;
    if (win && normalized.startsWith('/') && !normalized.startsWith('//') && !normalized.includes('\\')) {
      const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
      if (match) normalized = `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}`;
    }
    if (normalized === '~') normalized = home;
    else if (/^~[\\/]/.test(normalized)) normalized = join(home, normalized.slice(2));
    try { if (normalized.startsWith('file://')) normalized = fileURLToPath(normalized); } catch { /* Invalid URL fails the file check. */ }
    customShellPath = resolve(projectDir, normalized);
  }
  const bashPath = customShellPath ? await firstExisting([customShellPath]) : automaticBashPath;
  const diagnostics: Diagnostics = {
    piPath, nodePath, bashPath, nodeVersion: null, piVersion: null,
    agentDir: profile,
    errors: [], warnings: [],
    ...(runtimeRoot ? { runtimeRoot } : {}),
    ...(piPath ? { piSource: preferences.piPath ? 'custom' as const : piPath === bundledPi ? 'bundled' as const : 'system' as const } : {}),
    ...(nodeSource ? { nodeSource } : {}),
    ...(bashPath ? { bashSource: customShellPath ? 'custom' as const : bashPath === bundledBash ? 'bundled' as const : 'system' as const } : {}),
  };
  const repair = '请重新运行安装程序修复，或重新安装 Pi Desktop。';
  if (context.packaged && runtimeRoot) {
    const missing = [!preferences.nodePath && !bundledNode ? 'Node.js' : '', !preferences.piPath && !bundledPi ? 'Pi' : '', !bundledBash ? 'Git Bash' : ''].filter(Boolean);
    if (missing.length) diagnostics.warnings!.push(`内置 ${missing.join('、')} 文件缺失，当前可用的系统组件将作为回退。${repair}`);
  }
  if (!bashPath && customShellPath) diagnostics.errors.push('Pi settings.json 中的 shellPath 不存在或不可用，请修正该设置。');
  else if (win && !bashPath) diagnostics.errors.push(context.packaged ? `未找到可用的 Git Bash 运行环境。${repair}` : '未找到可用的 Git Bash。请准备内置运行环境，或安装 Git for Windows，也可在 Pi settings.json 中设置有效的 shellPath。');
  if (!nodePath) diagnostics.errors.push(preferences.nodePath ? '设置中的 Node.js 路径不存在，请检查路径或清空以恢复自动选择。' : context.packaged ? `未找到可用的 Node.js。${repair}` : '未找到 Node.js。请准备内置运行环境，或在设置中填写 node.exe 的完整路径。');
  else {
    let versionError = '';
    try {
      diagnostics.nodeVersion = (await runNodeVersion(nodePath, childEnvironment)).trim();
      if (!validNodeVersion(diagnostics.nodeVersion)) versionError = 'Pi 0.84.2 需要 Node.js 22.19.0 或更新版本。';
    } catch { versionError = 'Node.js 路径无法执行，请检查设置。'; }
    if (versionError && nodeSource === 'bundled') {
      const fallback = await firstExisting(systemNodeCandidates.filter(candidate => resolve(candidate) !== bundledNode));
      if (fallback) {
        try {
          const fallbackVersion = (await runNodeVersion(fallback, childEnvironment)).trim();
          if (validNodeVersion(fallbackVersion)) {
            nodePath = fallback;
            nodeSource = 'system';
            diagnostics.nodePath = fallback;
            diagnostics.nodeSource = 'system';
            diagnostics.nodeVersion = fallbackVersion;
            diagnostics.warnings!.push(`内置 Node.js 无法使用，已回退到系统 Node.js。${repair}`);
            versionError = '';
          }
        } catch { /* Report the unusable bundled runtime below. */ }
      }
    }
    if (versionError) diagnostics.errors.push(nodeSource === 'bundled' ? `内置运行环境异常：${versionError}${repair}` : versionError);
  }
  if (!piPath) diagnostics.errors.push(preferences.piPath ? '设置中的 Pi 路径不存在，请检查路径或清空以恢复自动选择。' : context.packaged ? `未找到可用的 Pi。${repair}` : '未找到 Pi。请准备内置运行环境，或在设置中填写 Pi 的 dist/cli.js 完整路径。');
  else {
    try {
      const version = JSON.parse(await readFile(join(dirname(piPath), '..', 'package.json'), 'utf8')).version;
      diagnostics.piVersion = typeof version === 'string' ? version : null;
    } catch { /* Custom executable can have no adjacent package metadata. */ }
    if (diagnostics.piSource === 'bundled' && diagnostics.piVersion !== '0.84.2') diagnostics.errors.push(`内置 Pi 文件不完整或版本异常。${repair}`);
  }
  return diagnostics;
}
