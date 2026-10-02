const path = require('node:path');
const { readFile, stat } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { assertRuntimeInputs, assertRuntimeTree } = require('./runtime-validation.cjs');

module.exports = async context => {
  const project = context.packager.projectDir;
  const runtime = path.join(project, 'build', 'runtime', 'win32-x64');
  for (const packageRoot of [path.join(project, 'runtime', 'pi'), path.join(runtime, 'pi')]) {
    const [manifestText, lockText] = await Promise.all(['package.json', 'package-lock.json'].map(file => readFile(path.join(packageRoot, file), 'utf8')));
    assertRuntimeInputs(JSON.parse(manifestText), JSON.parse(lockText));
  }
  await assertRuntimeTree(runtime);
  if (!(await stat(path.join(project, 'electron', 'pi-launcher.mjs'))).isFile()) throw new Error('Missing bundled Pi launcher.');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(runtime, 'manifest.json'), 'utf8')); }
  catch { throw new Error('Bundled runtime is missing. Run npm run prepare:runtime before packaging.'); }
  const sources = JSON.parse(await readFile(path.join(project, 'runtime', 'sources.json'), 'utf8'));
  for (const name of ['pi', 'node', 'git', 'rg', 'fd']) {
    if (manifest.versions[name] !== sources[name].version) throw new Error(`Bundled ${name} version is stale. Run npm run prepare:runtime.`);
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(runtime, relative);
    const within = path.relative(runtime, file);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('Invalid bundled runtime manifest path.');
    if (!(await stat(file)).isFile()) throw new Error(`Incomplete bundled runtime: ${relative}`);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== expected) throw new Error(`Bundled runtime changed: ${relative}. Run npm run prepare:runtime to repair.`);
  }
  console.log('Bundled runtime verified for packaging.');
};
