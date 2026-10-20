// Native Electron acceptance. The harness owns its profile and localhost API.
import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_DESKTOP_DEV_URL;
const child = spawn(electron, [path.join(root, 'scripts', 'model-import-smoke.cjs'), ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
