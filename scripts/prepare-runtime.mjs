import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import validation from './runtime-validation.cjs';

const { assertRuntimeInputs, assertRuntimeTree } = validation;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeParent = path.join(root, 'build', 'runtime');
const destination = path.join(runtimeParent, 'win32-x64');
const cache = path.join(root, '.runtime-cache');
const input = path.join(root, 'runtime', 'pi');
const sourcesText = await readFile(path.join(root, 'runtime', 'sources.json'), 'utf8');
const sources = JSON.parse(sourcesText);
if (process.platform !== sources.platform || process.arch !== sources.arch) {
  throw new Error('Bundled runtime preparation currently supports Windows x64.');
}

function within(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe build path: ${target}`);
  return target;
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function exists(file) { try { return (await stat(file)).isFile(); } catch { return false; } }
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited with ${code}`)));
  });
}
async function download(source) {
  const file = within(cache, path.join(cache, path.basename(new URL(source.url).pathname)));
  if (await exists(file) && await hash(file) === source.sha256) return file;
  const partial = within(cache, `${file}.${process.pid}.partial`);
  console.log(`Downloading ${path.basename(file)} (verified official release)`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // .NET respects the user's Windows HTTP proxy; Node fetch does not on
      // some build machines. Download bytes only, then verify the pinned hash.
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'download-runtime.ps1'), '-Uri', source.url, '-Destination', partial]);
      if (await hash(partial) !== source.sha256) throw new Error('Release SHA-256 mismatch');
      await rm(file, { force: true });
      await rename(partial, file);
      return file;
    } catch (error) {
      await rm(partial, { force: true });
      if (attempt === 2) throw new Error(`Could not fetch ${source.url}: ${error.message}`);
      console.log(`Retrying ${path.basename(file)} after a download failure.`);
    }
  }
}

await mkdir(cache, { recursive: true });
await mkdir(runtimeParent, { recursive: true });
const lockText = await readFile(path.join(input, 'package-lock.json'), 'utf8');
const lock = JSON.parse(lockText);
const manifestText = await readFile(path.join(input, 'package.json'), 'utf8');
assertRuntimeInputs(JSON.parse(manifestText), lock);
const lockedPi = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
if (lockedPi.version !== sources.pi.version || lockedPi.integrity !== sources.pi.integrity) throw new Error('Pi lockfile does not match the pinned release.');
const inputFingerprint = createHash('sha256').update(sourcesText).update(manifestText).update(lockText).update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(path.join(root, 'scripts', 'runtime-validation.cjs'))).digest('hex');
const required = [
  'node/node.exe', 'node/npm.cmd', 'node/node_modules/npm/bin/npm-cli.js',
  'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  'pi/node_modules/@earendil-works/pi-coding-agent/package.json',
  'git/bin/bash.exe', 'git/cmd/git.exe', 'git/usr/bin/msys-2.0.dll', 'bin/rg.exe', 'bin/fd.exe',
];
try {
  const previous = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
  if (previous.inputFingerprint === inputFingerprint) {
    const valid = await Promise.all(required.map(async file => await exists(path.join(destination, file)) && await hash(path.join(destination, file)) === previous.files[file]));
    if (valid.every(Boolean)) {
      await assertRuntimeTree(destination);
      console.log('Bundled runtime is ready (pinned files and runtime tree verified).'); process.exit(0);
    }
  }
} catch { /* First preparation or interrupted old build. */ }

const stage = within(runtimeParent, path.join(runtimeParent, `preparing-${process.pid}`));
const scratch = within(stage, path.join(stage, '_extract'));
const sevenZip = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z-x64.exe');
if (!await exists(sevenZip)) throw new Error('Missing archive extractor. Run npm ci for the desktop project first.');
const extract = async (archive, output) => {
  within(stage, output); await mkdir(output, { recursive: true });
  await run(sevenZip, ['x', archive, `-o${output}`, '-y', '-bsp0', '-bso0', '-bse1']);
};
try {
  await mkdir(stage, { recursive: true });
  const names = ['node', 'git', 'rg', 'fd'];
  const archives = Object.fromEntries(await Promise.all(names.map(async name => [name, await download(sources[name])])));
  await extract(archives.node, path.join(scratch, 'node'));
  await rename(path.join(scratch, 'node', sources.node.folder), path.join(stage, 'node'));
  await extract(archives.git, path.join(stage, 'git'));
  await mkdir(path.join(stage, 'bin'), { recursive: true });
  await mkdir(path.join(stage, 'licenses'), { recursive: true });
  for (const name of ['rg', 'fd']) {
    await extract(archives[name], path.join(scratch, name));
    const folder = path.join(scratch, name, sources[name].folder);
    await cp(path.join(folder, `${name}.exe`), path.join(stage, 'bin', `${name}.exe`));
    const notices = (await readdir(folder)).filter(file => /^(license|copying|copyright|notice)/i.test(file));
    await mkdir(path.join(stage, 'licenses', name), { recursive: true });
    for (const notice of notices) await cp(path.join(folder, notice), path.join(stage, 'licenses', name, notice), { recursive: true });
  }
  const piRoot = path.join(stage, 'pi');
  await mkdir(piRoot, { recursive: true });
  await cp(path.join(input, 'package.json'), path.join(piRoot, 'package.json'));
  await cp(path.join(input, 'package-lock.json'), path.join(piRoot, 'package-lock.json'));
  const env = { ...process.env };
  const pathKeys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
  const oldPath = pathKeys.map(key => env[key]).filter(Boolean).join(path.delimiter);
  for (const key of pathKeys) delete env[key];
  env.Path = [path.join(stage, 'node'), oldPath].filter(Boolean).join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  await run(path.join(stage, 'node', 'node.exe'), [path.join(stage, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { env, cwd: piRoot });
  const piPackage = JSON.parse(await readFile(path.join(piRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  if (piPackage.version !== sources.pi.version) throw new Error('Installed Pi version does not match the pinned release.');
  await rm(within(stage, scratch), { recursive: true, force: true });
  await writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), [
    'Pi Desktop bundled runtime components', '',
    `Pi ${sources.pi.version} (MIT): ${sources.pi.source}`,
    'Pi and its dependency licenses are retained beside their packages in pi/node_modules.',
    `Node.js ${sources.node.version}: ${sources.node.source}`,
    'Node.js and bundled npm licenses/notices are retained in node/.',
    `Portable Git for Windows ${sources.git.version}: ${sources.git.source}`,
    'Portable Git is redistributed unmodified. Its original licenses, source information and notices are retained in git/.',
    `ripgrep ${sources.rg.version}: ${sources.rg.source} (licenses/rg)`,
    `fd ${sources.fd.version}: ${sources.fd.source} (licenses/fd)`, '',
  ].join('\n'));
  const files = Object.fromEntries(await Promise.all(required.map(async file => {
    if (!await exists(path.join(stage, file))) throw new Error(`Incomplete runtime: ${file}`);
    return [file, await hash(path.join(stage, file))];
  })));
  await assertRuntimeTree(stage);
  await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ inputFingerprint, platform: sources.platform, arch: sources.arch, versions: Object.fromEntries(['pi', ...names].map(name => [name, sources[name].version])), sources, files }, null, 2));
  await rm(within(runtimeParent, destination), { recursive: true, force: true });
  // Windows can briefly keep npm's executable or scanner handles open even
  // after process exit. Retry publication instead of discarding valid files.
  let published = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try { await rename(stage, destination); published = true; break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!published) {
    await cp(stage, destination, { recursive: true });
    await rm(within(runtimeParent, stage), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`Bundled runtime ready: Pi ${sources.pi.version}, Node ${sources.node.version}, Git ${sources.git.version}, rg ${sources.rg.version}, fd ${sources.fd.version}`);
} catch (error) {
  await rm(within(runtimeParent, stage), { recursive: true, force: true });
  throw error;
}
