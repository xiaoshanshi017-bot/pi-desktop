// One localhost model and one private profile across several actual app launches.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import electron from 'electron';

const root = path.resolve('.');
const qaRoot = path.join(root,'output','qa','restore');
const runRoot = path.join(qaRoot,`run-${Date.now()}`);
const agent = path.join(runRoot,'agent');
const desktop = path.join(runRoot,'desktop');
const projectA = path.join(runRoot,'恢复项目一');
const projectC = path.join(runRoot,'恢复空会话项目');
const projectD = path.join(runRoot,'即将失效的项目');
const report = {started:new Date().toISOString(),runRoot,phases:[],requests:[],errors:[]};
const manifestFile = path.join(runRoot,'manifest.json');
let server;
let currentPhase;

function within(value,base=runRoot) {
  const target=path.resolve(value);
  const parent=path.resolve(base)+path.sep;
  if(!target.startsWith(parent)) throw new Error(`Fixture target escaped its private directory: ${target}`);
  return target;
}
async function session(name,cwd=projectA,turns=24) {
  const id=crypto.randomUUID();
  const timestamp=new Date().toISOString();
  const encoded=`--${path.resolve(cwd).replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`;
  const directory=path.join(agent,'sessions',encoded);
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,`${name.toLowerCase()}-${id}.jsonl`);
  const entries=[{type:'session',version:3,id,cwd,timestamp}];
  let parentId=null;
  const append=entry=>{const next={id:crypto.randomUUID().slice(0,8),parentId,timestamp,...entry};parentId=next.id;entries.push(next);};
  append({type:'model_change',provider:'restore-fixture',modelId:'restore-fixture'});
  const usage={input:12,output:20,cacheRead:0,cacheWrite:0,totalTokens:32,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const assistant=content=>({role:'assistant',content,api:'openai-completions',provider:'restore-fixture',model:'restore-fixture',stopReason:'stop',usage,timestamp:Date.now()});
  for(let index=0;index<turns;index++) {
    const call=`${name}-call-${index}`;
    append({type:'message',message:{role:'user',content:[{type:'text',text:`RESTORE_${name}_${index===0?'EARLIEST':`USER_${index}`}：这是独立缓存验收历史。`}],timestamp:Date.now()}});
    append({type:'message',message:assistant([{type:'text',text:`正在检查 ${name} 文件 ${index}。`},{type:'toolCall',id:call,name:'read',arguments:{path:`sample-${index}.ts`}}])});
    append({type:'message',message:{role:'toolResult',toolCallId:call,toolName:'read',content:[{type:'text',text:`RESTORE_${name}_TOOL_${index}\n${'cached local tool output\n'.repeat(12)}`}],isError:false,timestamp:Date.now()}});
    append({type:'message',message:assistant([{type:'text',text:`RESTORE_${name}_${index===turns-1?'TAIL':`RESULT_${index}`}\n\n\`\`\`typescript\nconst restored = { session: '${name}', index: ${index} };\nconsole.log(restored);\n\`\`\`\n历史正文、代码与工具结果都保留。`}])});
  }
  append({type:'session_info',name:`RESTORE_${name}`});
  await writeFile(file,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
  return file;
}
async function launch(phase) {
  currentPhase=phase;
  await writeFile(path.join(agent,'boot-ready.jsonl'),'');
  const env={...process.env,PI_RESTORE_SMOKE_ROOT:runRoot,PI_RESTORE_SMOKE_PHASE:phase,PI_RESTORE_SMOKE_DELAY_MS:phase==='seed'?'0':'6000'};
  delete env.ELECTRON_RUN_AS_NODE;delete env.PI_DESKTOP_DEV_URL;
  console.log(`[restore acceptance] Launching ${phase} with the same private profile`);
  const code=await new Promise((resolve,reject)=> {
    const child=spawn(electron,[path.join(root,'scripts','restore-smoke.cjs')],{env,stdio:'inherit',windowsHide:true});
    child.on('error',reject);child.on('exit',code=>resolve(code??1));
  });
  const phaseReport=JSON.parse(await readFile(path.join(runRoot,`${phase}-report.json`),'utf8'));
  report.phases.push(phaseReport);
  if(code!==0||!phaseReport.success) throw new Error(`Restore acceptance phase ${phase} failed`);
}
async function run() {
  await Promise.all([projectA,projectC,projectD,agent,desktop,path.join(agent,'extensions')].map(directory=>mkdir(directory,{recursive:true})));
  const [sessionA,sessionB,sessionD,sessionE]=await Promise.all([session('A'),session('B'),session('D',projectD,3),session('E',projectA,3)]);
  const attachment=path.join(runRoot,'B-缓存附件.txt');
  await writeFile(attachment,'RESTORE_B_ATTACHMENT_CONTENT：独立本地文本附件，恢复时无需重新选择。\n');
  const manifest={root,runRoot,agent,desktop,projectA,projectC,projectD,sessionA,sessionB,sessionD,sessionE,attachment};
  await writeFile(manifestFile,JSON.stringify(manifest,null,2));
  await writeFile(path.join(agent,'extensions','restore-slow-start.js'),`import fs from 'node:fs';\nexport default async function() { const ms = Number(process.env.PI_RESTORE_SMOKE_DELAY_MS || 0); if(ms) await new Promise(resolve=>setTimeout(resolve,ms)); fs.appendFileSync(${JSON.stringify(path.join(agent,'boot-ready.jsonl'))},JSON.stringify({phase:process.env.PI_RESTORE_SMOKE_PHASE,time:Date.now()})+'\\n'); }\n`);
  server=http.createServer(async(request,response)=> {
    try {
      if(request.method!=='POST'||request.url!=='/v1/chat/completions') {response.writeHead(404).end();return;}
      let raw='';for await(const chunk of request) raw+=chunk;
      const body=JSON.parse(raw);
      if(body.model!=='restore-fixture') throw new Error('Fixture requested an unexpected model');
      const index=body.messages.findLastIndex(message=>message.role==='user');
      const prompt=JSON.stringify(body.messages[index]?.content);
      if(!prompt.includes('[restore-long-tool]')) throw new Error('Fixture received an unexpected prompt');
      const toolCount=body.messages.slice(index+1).filter(message=>message.role==='tool').length;
      report.requests.push({phase:currentPhase,time:new Date().toISOString(),model:body.model,toolCount});
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      const emit=(delta,finish_reason=null)=>response.write(`data: ${JSON.stringify({id:'restore-fixture',object:'chat.completion.chunk',created:1,model:'restore-fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
      emit({role:'assistant'});
      if(toolCount===0) {
        emit({content:'启动真实长工具，用于验证退出与恢复不会留下虚假的运行状态。\n'});
        emit({tool_calls:[{index:0,id:'restore_busy_tool',type:'function',function:{name:'bash',arguments:JSON.stringify({command:"printf 'RESTORE_OLD_BUSY_TOOL_BEGIN\\n'; sleep 60; printf 'RESTORE_OLD_BUSY_TOOL_END\\n'",timeout:70})}}]});
        emit({},'tool_calls');
      } else {emit({content:'RESTORE_TOOL_FINISHED'});emit({},'stop');}
      response.end('data: [DONE]\n\n');
    } catch(error) {report.errors.push(error.stack||String(error));response.destroy(error);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(path.join(agent,'models.json'),JSON.stringify({providers:{'restore-fixture':{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'private-local-fixture',models:[{id:'restore-fixture',name:'本地恢复验收模型',reasoning:false,contextWindow:1_000_000,maxTokens:2048}]}}}));
  await writeFile(path.join(agent,'settings.json'),JSON.stringify({defaultProvider:'restore-fixture',defaultModel:'restore-fixture',defaultThinkingLevel:'off'}));
  await writeFile(path.join(desktop,'preferences.json'),JSON.stringify({theme:'light',projects:[{path:projectA,name:path.basename(projectA),lastOpened:new Date().toISOString()},{path:projectC,name:path.basename(projectC),lastOpened:new Date().toISOString()},{path:projectD,name:path.basename(projectD),lastOpened:new Date().toISOString()}],lastProject:projectA,lastSessions:{[projectA]:sessionA,[projectD]:sessionD}}));
  await launch('seed');
  await launch('restore');
  await launch('after-close');
  // Both targets were created by this runner and checked inside this profile.
  await unlink(within(sessionE,agent));
  await rename(within(projectD),within(path.join(runRoot,'已移走的失效项目')));
  await launch('invalid');
  if(report.requests.some(request=>request.phase!=='seed')) throw new Error('Restoring cached busy history started a new model request');
  const sources=new Set(report.phases.map(phase=>JSON.stringify([phase.packageVersion,phase.compiledMainSha256,phase.compiledHtmlSha256,phase.compiledAssets])));
  if(sources.size!==1) throw new Error('Compiled app changed between restore launches; acceptance must use one frozen build');
}
try {await run();} catch(error) {report.errors.push(error.stack||String(error));console.error(error);}
server?.closeAllConnections();if(server) await new Promise(resolve=>server.close(resolve));
report.success=report.errors.length===0;
report.finished=new Date().toISOString();
await mkdir(qaRoot,{recursive:true});
await writeFile(path.join(qaRoot,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({success:report.success,phases:report.phases.map(phase=>({phase:phase.phase,success:phase.success,checks:phase.checks,cacheRenderMs:phase.cacheRenderMs})),errors:report.errors,report:path.join(qaRoot,'report.json')},null,2));
process.exitCode=report.success?0:1;
