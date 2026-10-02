import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
await build({ entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true });
const server = await createServer();
await server.listen();
const env = { ...process.env, PI_DESKTOP_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: true });
let closing = false;
async function stop(code = 0) { if (closing) return; closing = true; child.kill(); await server.close(); process.exit(code); }
child.on('exit', code => void stop(code ?? 0));
child.on('error', error => { console.error(error); void stop(1); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
