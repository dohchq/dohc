import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedCompilerProcess } from '../src/workspaces/compilerProcessSupervisor.ts';
import { compileClosedAppInProcess } from '../src/workspaces/closedAppCompilerProcess.ts';
import { stageAppCompiler } from './stage-app-compiler.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

// The compile deadline counts from the owner's spawn. Beside other work, one
// Windows owner and worker took 17.6 s to answer, so the deadline is 20 s,
// inside each 30 s test.
const bounds={timeoutMs:20000,maxMemoryBytes:256*1024*1024,maxProcesses:8,maxInputBytes:4096,maxOutputBytes:4096,maxErrorBytes:8192};
const darwin=process.platform==='darwin';
const owned={skip:!['win32','darwin'].includes(process.platform),timeout:30000};
const macos={skip:!darwin,timeout:30000};
// macOS runs the worker under the staged official Node and owner. Seatbelt
// stops any Node that loads libraries from outside its own file.
let staged,stagedRoot;
before(async()=>{
  if(!darwin)return;
  stagedRoot=await mkdtemp(join(tmpdir(),'dohc-compiler-process-staged-'));
  staged=join(stagedRoot,'app-compiler');
  await stageAppCompiler({destination:staged});
});
after(()=>stagedRoot&&rm(stagedRoot,{recursive:true,force:true}));
const runtimeFor=workerPath=>darwin?{nodeExecutable:join(staged,'node'),ownerExecutable:join(staged,'compiler-owner'),workerPath}:{nodeExecutable:process.execPath,workerPath};
const compilerWorker=()=>darwin?join(staged,'worker.mjs'):fileURLToPath(new URL('../src/workspaces/closedAppCompilerWorker.ts',import.meta.url));
// A worker writes its marker into its build directory, the only place macOS
// lets it write, so each test gives the supervisor its own temporary root.
const markerLine=`const marker=process.env.TMPDIR?process.env.TMPDIR+'ready.json':process.argv[2];`;
// On macOS the owner removes the build directory, marker included, as soon as
// the worker ends. A worker that would end on its own waits for the test's go
// file after writing its marker.
const proceedLine=`const proceed=next=>{if(!process.env.TMPDIR)return next();const timer=setInterval(()=>{if(existsSync(process.env.TMPDIR+'go')){clearInterval(timer);next();}},5);};`;
async function fixture(t,source){
  const directory=await mkdtemp(join(tmpdir(),'dohc-compiler-process-test-'));
  const scratch=await mkdtemp(join(tmpdir(),'dohc-compiler-process-builds-'));
  const previous=process.env.TMPDIR;process.env.TMPDIR=scratch;
  t.after(async()=>{
    if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;
    await rm(directory,{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});
  });
  const workerPath=join(directory,'worker.mjs');await writeFile(workerPath,source);
  return {directory,scratch,runtime:runtimeFor(workerPath)};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function readJson(paths,what){
  for(const deadline=Date.now()+20000;Date.now()<deadline;await delay(20)){
    for(const path of await paths()){
      try{return JSON.parse(await readFile(path,'utf8'));}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
  }
  throw new Error(`${what} readiness timed out.`);
}
const waitForFile=path=>readJson(async()=>[path],'Fixture');
// The worker's marker: in its build directory on macOS, at argv[2] elsewhere.
const waitForMarker=({directory,scratch})=>darwin
  ?readJson(async()=>(await readdir(scratch).catch(()=>[])).filter(name=>name.startsWith('dohc-app-compiler-')).map(name=>join(scratch,name,'ready.json')),'Worker')
  :waitForFile(join(directory,'ready.json'));
const proceed=async({scratch})=>{
  if(!darwin)return;
  for(const name of await readdir(scratch))if(name.startsWith('dohc-app-compiler-'))await writeFile(join(scratch,name,'go'),'');
};
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
// macOS still lists a killed process until its parent reaps it, and launchd
// reaps orphans soon after.
const zombie=pid=>{try{return execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim().startsWith('Z');}catch{return false}};
async function exited(pid,ms=5000){
  for(const deadline=Date.now()+ms;Date.now()<deadline;await delay(20))if(!alive(pid)||darwin&&zombie(pid))return true;
  return false;
}
const processGroup=pid=>Number(execFileSync('ps',['-o','pgid=','-p',String(pid)],{encoding:'utf8'}).trim());
const liveGroupMembers=group=>execFileSync('ps',['-A','-o','pgid=,stat='],{encoding:'utf8'}).split('\n').map(line=>line.trim().split(/\s+/)).filter(([pgid,stat])=>Number(pgid)===group&&stat&&!stat.startsWith('Z')).length;

test('snapshots output limits before the caller mutates its request',owned,async t=>{
  const {runtime}=await fixture(t,'process.stdout.write(Buffer.alloc(32768));');
  const mutable={...bounds};
  const running=runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:mutable});
  mutable.maxOutputBytes=1024*1024;
  await assert.rejects(running,{reason:'output'});
});

test('bounded input round trips in a separate process without inherited preloads',owned,async t=>{
  const {runtime}=await fixture(t,`let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({input,pid:process.pid,preload:process.env.NODE_OPTIONS??null,secret:process.env.DOHC_SYNTHETIC_SECRET??null}));`);
  const old=process.env.NODE_OPTIONS,secret=process.env.DOHC_SYNTHETIC_SECRET;
  process.env.NODE_OPTIONS='--require=missing-untrusted-preload';process.env.DOHC_SYNTHETIC_SECRET='do-not-inherit';
  t.after(()=>{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;if(secret===undefined)delete process.env.DOHC_SYNTHETIC_SECRET;else process.env.DOHC_SYNTHETIC_SECRET=secret;});
  const result=await runOwnedCompilerProcess(runtime,{input:Buffer.from('captured bytes'),bounds});
  const value=JSON.parse(Buffer.from(result.stdout).toString());assert.equal(value.input,'captured bytes');assert.notEqual(value.pid,process.pid);assert.equal(value.preload,null);assert.equal(value.secret,null);assert.equal(alive(value.pid),false);
});
test('refuses input overflow and prior cancellation before spawning',owned,async t=>{
  const {runtime}=await fixture(t,'throw Error("must not start")');let spawned=false;runtime.onOwnerSpawn=()=>{spawned=true;};
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(4097),bounds}),{reason:'input'});
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds,signal:AbortSignal.abort()}),{reason:'cancelled'});assert.equal(spawned,false);
});
for(const [stream,reason] of [['stdout','output'],['stderr','stderr']])test(`bounds ${stream} and closes the owner`,owned,async t=>{
  const {runtime}=await fixture(t,`process.${stream}.write(Buffer.alloc(32768));setInterval(()=>{},1000)`);let owner;runtime.onOwnerSpawn=pid=>{owner=pid;};
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds}),{reason});assert.equal(alive(owner),false);
});
// Timeout mode waits out the full 20 s deadline after a loaded start, so these get 60 s.
for(const mode of ['cancel','timeout','normal-exit'])test(`${mode} closes owned descendants after their direct parent exits`,{...owned,timeout:60000},async t=>{
  const context=await fixture(t,`import {spawn}from'node:child_process';import{existsSync,writeFileSync}from'node:fs';${markerLine}${proceedLine}const child=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',chunk=>{writeFileSync(marker,JSON.stringify({worker:process.pid,descendant:Number(chunk.toString())}));${mode==='normal-exit'?'proceed(()=>process.exit(0))':'setInterval(()=>{},1000)'}});`);
  const {directory,runtime}=context;runtime.workerArgs=[join(directory,'ready.json')];let owner;runtime.onOwnerSpawn=pid=>{owner=pid;};const controller=new AbortController();
  const running=runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds,signal:controller.signal});
  const outcome=mode==='normal-exit'?running:assert.rejects(running,{reason:mode==='cancel'?'cancelled':'timeout'});
  const identities=await waitForMarker(context);await proceed(context);if(mode==='cancel')controller.abort();await outcome;
  for(const pid of [owner,identities.worker,identities.descendant])assert.equal(await exited(pid),true,`process ${pid} exited`);
});
test('aggregate memory covers two sub-limit native allocations',owned,async t=>{
  const {runtime}=await fixture(t,`import{spawn}from'node:child_process';globalThis.held=Buffer.alloc(160*1024*1024,1);const child=spawn(process.execPath,['-e','try{globalThis.held=Buffer.alloc(160*1024*1024,1);setInterval(()=>{},1000)}catch{process.exit(42)}'],{windowsHide:true,stdio:'inherit'});child.once('exit',code=>process.exit(code??1));`);
  // Each process's 160 MiB allocation fits 320 MiB alone. Together with the
  // Node runtimes, only the aggregate exceeds the bound. Windows refuses the
  // allocation. macOS samples the sum, so the child holds its allocation:
  // a peak shorter than one sample can pass unseen.
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:{...bounds,maxMemoryBytes:320*1024*1024}}),darwin?{reason:'memory'}:error=>error.reason==='exit'&&/\(42\)/.test(error.message));
});
test('compiles captured app bytes in the job and snapshots before caller mutation',owned,async()=>{
  const bytes=Buffer.from('document.body.textContent="before";');
  const request={entryPath:'main.js',inputs:[{path:'main.js',bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],bounds:{maxInputFiles:8,maxInputBytes:4096,maxOutputBytes:4096}};
  const pending=compileClosedAppInProcess(runtimeFor(compilerWorker()),request,{...bounds,maxInputBytes:8192,maxOutputBytes:8192});
  bytes.fill(0);request.entryPath='changed.js';
  const result=await pending;assert.equal(result.compiler.recipe,'dohc-closed-app-v3');assert.equal(result.files[0].path,'bundle.js');assert.match(Buffer.from(result.files[0].bytes).toString(),/before/);
});
test('abrupt caller death closes its job and descendants',owned,async t=>{
  const context=await fixture(t,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';${markerLine}const child=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',chunk=>writeFileSync(marker,JSON.stringify({worker:process.pid,descendant:Number(chunk.toString())})));setInterval(()=>{},1000);`);
  const {directory,runtime}=context;
  const ownerMarker=join(directory,'owner.json'),callerPath=join(directory,'caller.mjs');
  const supervisor=new URL('../src/workspaces/compilerProcessSupervisor.ts',import.meta.url).href;
  await writeFile(callerPath,`import{runOwnedCompilerProcess}from${JSON.stringify(supervisor)};import{writeFileSync}from'node:fs';const runtime=${JSON.stringify({...runtime,workerArgs:[join(directory,'ready.json')]})};runtime.onOwnerSpawn=pid=>writeFileSync(${JSON.stringify(ownerMarker)},JSON.stringify({pid}));await runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:${JSON.stringify(bounds)}});`);
  const caller=spawn(process.execPath,[callerPath],{windowsHide:true,stdio:'ignore'});t.after(()=>caller.kill());const closed=once(caller,'close');
  const ids=await waitForMarker(context),owner=await waitForFile(ownerMarker);caller.kill('SIGKILL');await closed;
  for(const pid of [owner.pid,ids.worker,ids.descendant])assert.equal(await exited(pid,16000),true,`process ${pid} exited`);
});
// The owner's deadline is the same 20 s as every other compile here, so a loaded
// start of the worker still writes its marker first. The 20 s marker wait, the
// 40 s exit wait and startup nest inside 90 s.
test('owner deadline still kills the build while the caller event loop is blocked',{...owned,timeout:90000},async t=>{
  const context=await fixture(t,`import{writeFileSync}from'node:fs';${markerLine}writeFileSync(marker,JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  const {directory,runtime}=context;
  const ownerMarker=join(directory,'owner.json'),callerPath=join(directory,'blocked-caller.mjs');
  const supervisor=new URL('../src/workspaces/compilerProcessSupervisor.ts',import.meta.url).href;
  await writeFile(callerPath,`import{runOwnedCompilerProcess}from${JSON.stringify(supervisor)};import{writeFileSync}from'node:fs';const runtime=${JSON.stringify({...runtime,workerArgs:[join(directory,'ready.json')]})};runtime.onOwnerSpawn=pid=>{writeFileSync(${JSON.stringify(ownerMarker)},JSON.stringify({pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};void runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:${JSON.stringify(bounds)}});`);
  const caller=spawn(process.execPath,[callerPath],{windowsHide:true,stdio:'ignore'});t.after(()=>caller.kill());const closed=once(caller,'close');
  const worker=await waitForMarker(context),owner=await waitForFile(ownerMarker);
  // The blocked caller cannot reap its owner, which stays a zombie on macOS.
  for(const pid of [owner.pid,worker.pid])assert.equal(await exited(pid,40000),true,`process ${pid} exited`);
  assert.equal(alive(caller.pid),true);caller.kill();await closed;
});
// Six real compiles, each under its own 20 s deadline. Beside other work, all
// six took over 30 s.
test('parent rejects forged worker file and build identities',{...owned,timeout:150000},async t=>{
  const bytes=Buffer.from('document.body.textContent="identity";');
  const request={entryPath:'main.js',inputs:[{path:'main.js',bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],bounds:{maxInputFiles:8,maxInputBytes:4096,maxOutputBytes:4096}};
  const processBounds={...bounds,maxInputBytes:8192,maxOutputBytes:8192};
  const good=await compileClosedAppInProcess(runtimeFor(compilerWorker()),request,processBounds);
  const {directory,runtime}=await fixture(t,'');
  // The adapter owns worker arguments, so a forged worker names its fixed test response in its own source.
  const responsePath=join(directory,'response.json');await writeFile(runtime.workerPath,`import{readFileSync}from'node:fs';for await(const chunk of process.stdin){}process.stdout.write(readFileSync(${JSON.stringify(responsePath)}));`);
  const original={...good,files:good.files.map(file=>({...file,bytes:Buffer.from(file.bytes).toString('base64')}))};
  for(const change of [value=>{value.files[0].path='../outside.js'},value=>{value.files[0].contentType='text/html'},value=>{value.files[0].sha256='0'.repeat(64)},value=>{value.bundleDigest='0'.repeat(64)},value=>{value.dependencyLock[0].path='private.js'}]){
    const forged=structuredClone(original);change(forged);await writeFile(responsePath,JSON.stringify(forged));await assert.rejects(compileClosedAppInProcess(runtime,request,processBounds),/compiler|Compiler/);
  }
});

test('macOS memory bound stops an allocator and the process it started',macos,async t=>{
  const context=await fixture(t,`import{spawn}from'node:child_process';import{existsSync,writeFileSync}from'node:fs';${markerLine}${proceedLine}const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>{writeFileSync(marker,JSON.stringify({worker:process.pid,descendant:child.pid}));proceed(()=>{const held=[];for(;;)held.push(Buffer.alloc(32<<20,1));});});`);
  const running=runOwnedCompilerProcess(context.runtime,{input:Buffer.alloc(0),bounds});
  const ids=await waitForMarker(context);await proceed(context);
  await assert.rejects(running,{reason:'memory'});
  for(const pid of [ids.worker,ids.descendant])assert.equal(await exited(pid),true,`process ${pid} exited`);
});
test('macOS process bound stops a spawn loop and leaves no member of the group',macos,async t=>{
  const {runtime}=await fixture(t,`import{spawn}from'node:child_process';const go=()=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setImmediate(go);};go();`);
  let owner;runtime.onOwnerSpawn=pid=>{owner=pid;};
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:{...bounds,maxMemoryBytes:4*1024*1024*1024}}),{reason:'processes'});
  // One kill round can miss a fork in flight. The owner repeats until none is left.
  assert.equal(liveGroupMembers(owner),0);
});
test('macOS sandbox keeps the worker inside its compiler and build directory',macos,async t=>{
  const outside=await mkdtemp(join(tmpdir(),'dohc-compiler-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'canary.txt'),'secret');
  let connections=0;const server=createServer(socket=>{connections++;socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const {directory,runtime}=await fixture(t,`import{readFileSync,writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{connect}from'node:net';
const [canary,escape,outsideWrite,port]=process.argv.slice(2);
const attempt=work=>{try{work();return'allowed';}catch(error){return error.code??error.message;}};
const tcp=await new Promise(resolve=>{const socket=connect(Number(port),'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve('allowed');});socket.once('error',error=>resolve(error.code));});
console.log(JSON.stringify({env:Object.keys(process.env),
  ownSource:attempt(()=>readFileSync(new URL(import.meta.url))),
  buildWrite:attempt(()=>writeFileSync(process.env.TMPDIR+'scratch.txt','x')),
  canary:attempt(()=>readFileSync(canary)),symlinkEscape:attempt(()=>readFileSync(escape)),
  outsideWrite:attempt(()=>writeFileSync(outsideWrite,'x')),shell:attempt(()=>execFileSync('/bin/sh',['-c','true'])),tcp}));`);
  await symlink(outside,join(directory,'escape'));
  runtime.workerArgs=[join(outside,'canary.txt'),join(directory,'escape','canary.txt'),join(outside,'written.txt'),String(server.address().port)];
  const result=JSON.parse(Buffer.from((await runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds})).stdout).toString());
  assert.deepEqual(result.env,['TMPDIR']);
  assert.equal(result.ownSource,'allowed');assert.equal(result.buildWrite,'allowed');
  for(const name of ['canary','symlinkEscape','outsideWrite','shell','tcp'])assert.equal(result[name],'EPERM',name);
  assert.equal(connections,0);
  await assert.rejects(readFile(join(outside,'written.txt')),{code:'ENOENT'});
});
test('macOS worker cannot stop or kill its owner',macos,async t=>{
  const {runtime}=await fixture(t,`import{writeSync}from'node:fs';const attempt=signal=>{try{process.kill(process.ppid,signal);return'sent';}catch(error){return error.code;}};
writeSync(2,JSON.stringify({stop:attempt('SIGSTOP'),kill:attempt('SIGKILL')})+'\\n');process.kill(0,'SIGKILL');`);
  // A killed or stopped owner could not report the worker's own exit.
  const error=await runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds}).then(()=>assert.fail('the worker killed itself'),error=>error);
  assert.equal(error.reason,'exit');assert.equal(error.message,'Compiler exited (1).');
  assert.deepEqual(JSON.parse(error.diagnostics.split('\n')[0]),{stop:'EPERM',kill:'EPERM'});
});
test('macOS teardown kills a descendant that left the group while its parent lives',macos,async t=>{
  const context=await fixture(t,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';${markerLine}const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.once('spawn',()=>writeFileSync(marker,JSON.stringify({descendant:child.pid})));setInterval(()=>{},1000);`);
  let owner;context.runtime.onOwnerSpawn=pid=>{owner=pid;};const controller=new AbortController();
  const running=assert.rejects(runOwnedCompilerProcess(context.runtime,{input:Buffer.alloc(0),bounds,signal:controller.signal}),{reason:'cancelled'});
  const {descendant}=await waitForMarker(context);
  // setsid moved it out of the owner's group, so a group kill alone misses it.
  assert.notEqual(processGroup(descendant),owner);
  controller.abort();await running;
  assert.equal(await exited(descendant),true);
});
test('macOS owner leads its own group when started inside the caller group',macos,async t=>{
  const context=await fixture(t,`import{writeFileSync}from'node:fs';${markerLine}writeFileSync(marker,JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  const build=await mkdtemp(join(context.scratch,'dohc-app-compiler-'));
  const {runtime}=context;
  const owner=spawn(runtime.ownerExecutable,[String(bounds.maxMemoryBytes),'8','20000','0',context.directory,build,runtime.nodeExecutable,runtime.workerPath],{env:{},stdio:['pipe','ignore','ignore']});
  const closed=once(owner,'close');t.after(()=>owner.kill('SIGKILL'));
  const {pid}=await waitForMarker(context);
  assert.equal(processGroup(pid),owner.pid);assert.notEqual(processGroup(pid),processGroup(process.pid));
  owner.stdin.end();
  assert.equal((await closed)[0],125,'stdin EOF ends the build as a lost caller');
  assert.equal(await exited(pid),true);
});
test('macOS sandbox accepts quoted and symlinked compiler paths',macos,async t=>{
  // Node refuses a module path with a backslash; the owner's own tests cover escaping one.
  const quoted=await mkdtemp(join(tmpdir(),'dohc "quoted" root-'));t.after(()=>rm(quoted,{recursive:true,force:true}));
  await writeFile(join(quoted,'worker.mjs'),`let input='';for await(const chunk of process.stdin)input+=chunk;console.log(input);`);
  const linked=join(await mkdtemp(join(tmpdir(),'dohc-compiler-link-')),'root');await symlink(quoted,linked);t.after(()=>rm(join(linked,'..'),{recursive:true,force:true}));
  for(const workerPath of [join(quoted,'worker.mjs'),join(linked,'worker.mjs')]){
    const result=await runOwnedCompilerProcess(runtimeFor(workerPath),{input:Buffer.from('through the sandbox'),bounds});
    assert.equal(Buffer.from(result.stdout).toString().trim(),'through the sandbox');
  }
});
test('macOS spawn failure removes its build directory',macos,async t=>{
  const {scratch,runtime}=await fixture(t,'');
  await assert.rejects(runOwnedCompilerProcess({...runtime,ownerExecutable:join(scratch,'missing-owner')},{input:Buffer.alloc(0),bounds}),{reason:'spawn'});
  assert.deepEqual(await readdir(scratch),[]);
});
