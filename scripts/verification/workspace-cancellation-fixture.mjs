import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runCanonicalCancellationFixture(root, sourceRoot) {
  // Keep the owners and process groups real; only external tools and builds
  // use offline adapters. No database or native build starts in this fixture.
  const put = (path, text) => { mkdirSync(dirname(join(root,path)),{recursive:true}); writeFileSync(join(root,path),text); };
  put('package.json','{"type":"module"}');
  for(const file of ['verify.mjs','js-tests.mjs','selection.mjs','process.mjs','cancellation.mjs','timing.mjs'])
    put(`scripts/verification/${file}`,readFileSync(join(sourceRoot,'scripts/verification',file)));
  put('apps/desktop/package.json','{}');
  put('pnpm-workspace.yaml','fixture workspace');
  put('.github/workflows/pr-checks.yml','fixture workflow');
  put('node_modules/js-yaml/index.js',"exports.load=s=>s==='fixture workspace'?{packages:['packages/*']}:s==='fixture workflow'?{jobs:{changes:{steps:[{with:{filters:'fixture filters'}}]}}}:{rust:[],js:['**']};");
  put('node_modules/pnpm/package.json',JSON.stringify({main:'package.json',bin:{pnpm:'fixture.mjs'}}));
  put('scripts/verification/doctor.mjs','export const doctor=()=>({checks:[]});');
  put('scripts/verification/build.mjs',`export const prepare=async()=>{}; export const assertPrepared=()=>({}); export const sourceFingerprint=()=> 'fixture'; export const buildEnvironment=()=>process.env; export const stagedEnginePath='fixture-engine'; export const assertIndependentStagedEngine=()=>{}; export const hashFile=()=>{throw Error('native proof started after cancellation');};`);
  put('tools/rust-engine-program/build-slot.mjs','export const acquireVerificationSlot=()=>null;');
  put('tools/rust-engine-program/tree-provenance.mjs',"export const readTreeState=()=>({head:'fixture'});export const classifyTreeProvenance=()=>({status:'PASS'});");
  const packages = ['ydoc-projection','workspace-auth','z-queued'];
  for(const name of packages) put(`packages/${name}/package.json`,JSON.stringify({name:`@dohc/${name}`,scripts:{test:'vitest run'}}));
  put('bin/git',`#!/usr/bin/env node
const args=process.argv.slice(2);process.stdout.write(args[0]==='status'?'':args[0]==='diff'?'scripts/verification/verify.mjs\\0':'fixture');
`);
  put('bin/docker',`#!/usr/bin/env node
import * as fs from 'node:fs'; import * as path from 'node:path';
const root=process.env.FIXTURE_ROOT,args=process.argv.slice(2);
if(args[0]==='run')process.stdout.write('a'.repeat(64));
else if(args[0]==='inspect')process.stdout.write('healthy');
else if(args[0]==='port')process.stdout.write('127.0.0.1:1234');
else if(args[0]==='rm') {
  const children=fs.readdirSync(root).filter(name=>name.endsWith('.worker.json')).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')));
  const alive=pid=>{try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1][0]!=='Z'}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const report={children,alive:children.filter(child=>alive(child.pid))};
  fs.writeFileSync(path.join(root,'database-cleanup.json'),JSON.stringify(report));
  if(report.alive.length){console.error('database cleanup ran while package groups were alive');process.exitCode=7;}
} else throw Error('unexpected docker '+args.join(' '));
`);
  chmodSync(join(root,'bin/git'),0o755); chmodSync(join(root,'bin/docker'),0o755);
  put('node_modules/pnpm/fixture.mjs',`
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.FIXTURE_ROOT,args=process.argv.slice(2);
appendFileSync(join(root,'commands.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='run' && args[1]==='test') {
  // Bounded scheduler lag makes equal outer/inner escalation deadlines deterministic.
  process.prependListener('SIGTERM',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100));
  const {testWorkspace}=await import(join(root,'scripts/verification/js-tests.mjs'));
  try {await testWorkspace({prepared:true,output:args[args.indexOf('--output')+1]});}
  catch(error){console.error(error.message);process.exitCode??=1;}
} else if(args.includes('list')) {
  process.stdout.write(JSON.stringify(${JSON.stringify(packages)}.map(name=>({name:'@dohc/'+name,path:join(root,'packages',name)}))));
} else if(args[0]==='--filter' && args[2]==='run' && args[3]==='test') {
  const name=args[1].split('/')[1];
  process.on('SIGTERM',()=>appendFileSync(join(root,'terms.jsonl'),JSON.stringify({name,pid:process.pid})+'\\n'));
  setInterval(()=>{},1000);
  writeFileSync(join(root,name+'.worker.json'),JSON.stringify({name,pid:process.pid,env:{POSTGRES_URL:process.env.POSTGRES_URL,DOHC_REQUIRE_POSTGRES:process.env.DOHC_REQUIRE_POSTGRES,DOHC_REQUIRE_ENGINE_E2E:process.env.DOHC_REQUIRE_ENGINE_E2E}}));
}
`);
  put('owner.mjs',`
import {writeFileSync} from 'node:fs';
import {verify} from './scripts/verification/verify.mjs';
let outcome;try{await verify(['pr','--base','fixture','--job','js']);outcome={resolved:true};}catch(error){outcome={error:error.message};}
writeFileSync('owner-result.json',JSON.stringify(outcome));
`);
  let child, closed, stdout='',stderr='';
  const workers=()=>readdirSync(root).filter(name=>name.endsWith('.worker.json')).map(name=>JSON.parse(readFileSync(join(root,name),'utf8')));
  const read = path => existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
  async function until(predicate,message) {
    const deadline=Date.now()+20000;
    while(!predicate()){if(Date.now()>deadline)throw Error(message);await delay(10);}
  }
  const result={};
  try {
    child=spawn(process.execPath,[join(root,'owner.mjs')],{cwd:root,env:{...process.env,FIXTURE_ROOT:root,PATH:join(root,'bin')+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    await until(()=>workers().length===2 || child.exitCode!==null || child.signalCode!==null,'two package groups did not become ready');
    if(workers().length!==2)throw Error('owner exited before two package groups became ready: '+stderr);
    child.kill('SIGTERM');
    await until(()=>child.exitCode!==null || child.signalCode!==null,'owner did not exit after cancellation');
    result.owner=await closed;
    const reports=join(root,'.agent-artifacts/verification');
    const reportDir=join(reports,readdirSync(reports)[0]);
    result.verification=read(join(reportDir,'result.json'));
    result.scheduler=read(join(reportDir,'js-tests/result.json'));
    result.cleanup=read(join(root,'database-cleanup.json'));
    result.workers=workers();
    result.queuedStarted=result.workers.some(worker=>worker.name==='z-queued');
    result.terms=readFileSync(join(root,'terms.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    result.pass=result.cleanup?.alive.length===0 && result.verification?.verdict==='FAIL' && result.scheduler?.verdict==='FAIL' && !result.queuedStarted;
  } catch(error) {result.error=error.stack;}
  finally {
    for(const worker of workers()) {try{process.kill(-worker.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    await closed;
    result.stdout=stdout;result.stderr=stderr;
    put('fixture-result.json',JSON.stringify(result,null,2)+'\n');
  }
  return result;
}
