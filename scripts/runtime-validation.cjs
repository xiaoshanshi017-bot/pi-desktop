const { lstat, readdir } = require('node:fs/promises');
const path = require('node:path');

const piPackage = '@earendil-works/pi-coding-agent';
const localReference = /^(?:file:|link:|workspace:|git\+file:|\.{1,2}(?:[\\/]|$)|[\\/]|[a-z]:[\\/])/i;

function assertRuntimeInputs(manifest, lock) {
  const dependencies = manifest?.dependencies;
  if (!dependencies || Object.keys(dependencies).length !== 1 || typeof dependencies[piPackage] !== 'string') {
    throw new Error(`Bundled runtime must have exactly one direct dependency: ${piPackage}.`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(dependencies[piPackage])) throw new Error('Bundled Pi version must be pinned exactly.');
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] && Object.keys(manifest[field]).length) throw new Error(`Bundled runtime must not contain direct ${field}.`);
  }
  if (manifest.workspaces !== undefined) throw new Error('Bundled runtime must not use workspace dependencies.');
  const packages = lock?.packages;
  const root = packages?.[''];
  if (!packages || typeof packages !== 'object' || Array.isArray(packages) || !root) throw new Error('Bundled runtime lockfile must contain package metadata.');
  if (!root.dependencies || Object.keys(root.dependencies).length !== 1 || root.dependencies[piPackage] !== dependencies[piPackage]) {
    throw new Error('Bundled runtime lockfile direct dependencies must match the Pi-only manifest.');
  }
  if (packages[`node_modules/${piPackage}`]?.version !== dependencies[piPackage]) throw new Error('Bundled Pi lockfile version does not match the manifest.');
  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (packagePath && (!packagePath.startsWith('node_modules/') || packagePath.includes('\\') || packagePath.split('/').some(part => part === '..' || part === '.'))) {
      throw new Error('Bundled runtime lockfile contains a package outside its node_modules directory.');
    }
    if (!metadata || typeof metadata !== 'object' || metadata.link) throw new Error(`Bundled runtime lockfile contains an invalid or linked package: ${packagePath || '(root)'}.`);
    if (typeof metadata.resolved === 'string' && localReference.test(metadata.resolved)) throw new Error(`Bundled runtime lockfile contains a local package reference: ${packagePath}.`);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const reference of Object.values(metadata[field] || {})) {
        if (typeof reference === 'string' && localReference.test(reference)) throw new Error(`Bundled runtime lockfile contains a local dependency in ${packagePath || '(root)'}.`);
      }
    }
    if (!packagePath) {
      for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (metadata[field] && Object.keys(metadata[field]).length) throw new Error(`Bundled runtime lockfile must not contain direct ${field}.`);
      }
    }
  }
}

// Windows npm .bin launchers are ordinary files. Reject links of every kind so
// archives never follow a junction into the build tree (or any external path).
async function assertRuntimeTree(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error(`Runtime root must be a real directory: ${root}`);
  const directories = [root];
  let directoryCount = 0;
  let fileCount = 0;
  while (directories.length) {
    const directory = directories.pop();
    directoryCount++;
    const entries = await readdir(directory);
    for (let start = 0; start < entries.length; start += 32) {
      const batch = await Promise.all(entries.slice(start, start + 32).map(async name => {
        const file = path.join(directory, name);
        return { file, metadata: await lstat(file) };
      }));
      for (const { file, metadata } of batch) {
        if (metadata.isSymbolicLink()) throw new Error(`Runtime contains a symbolic link or directory junction; rebuild without local dependencies: ${path.relative(root, file)}`);
        if (metadata.isDirectory()) directories.push(file);
        else if (metadata.isFile()) fileCount++;
        else throw new Error(`Runtime contains an unsupported filesystem entry: ${path.relative(root, file)}`);
      }
    }
  }
  return { files: fileCount, directories: directoryCount };
}

module.exports = { assertRuntimeInputs, assertRuntimeTree };
