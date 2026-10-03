import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';
const env = { ...process.env, PI_SWITCH_STAGE: process.argv.includes('--baseline') ? 'baseline' : 'final' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_DESKTOP_DEV_URL;
const child = spawn(electron,[path.resolve('scripts/switch-smoke.cjs')],{env,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exit(1);});
child.on('exit',code=>process.exit(code??1));
