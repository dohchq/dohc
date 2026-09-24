import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedCompilerProcess } from '../src/workspaces/compilerProcessSupervisor.ts';
import { compileClosedAppInProcess } from '../src/workspaces/closedAppCompilerProcess.ts';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const bounds={timeoutMs:15000,maxMemoryBytes:256*1024*1024,maxProcesses:8,maxInputBytes:4096,maxOutputBytes:4096,maxErrorBytes:8192};
const windows={skip:process.platform!=='win32',timeout:30000};
async function fixture(t,source){
  const directory=await mkdtemp(join(tmpdir(),'dohc-compiler-process-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const workerPath=join(directory,'worker.mjs');await writeFile(workerPath,source);
  return {directory,runtime:{nodeExecutable:process.execPath,workerPath}};
}
function waitForFile(path){
  const directory=join(path,'..');
  let watcher;
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{watcher.close();reject(new Error('Fixture readiness timed out.'));},10000);
    const read=async()=>{try{const value=JSON.parse(await readFile(path,'utf8'));clearTimeout(timeout);watcher.close();resolve(value);}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)){clearTimeout(timeout);watcher.close();reject(error);}}};
    watcher=watch(directory,read);void read();
  });
}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};

test('snapshots output limits before the caller mutates its request',windows,async t=>{
  const {runtime}=await fixture(t,'process.stdout.write(Buffer.alloc(32768));');
  const mutable={...bounds};
  const running=runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:mutable});
  mutable.maxOutputBytes=1024*1024;
  await assert.rejects(running,{reason:'output'});
});

test('bounded input round trips in a separate process without inherited preloads',windows,async t=>{
  const {runtime}=await fixture(t,`let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({input,pid:process.pid,preload:process.env.NODE_OPTIONS??null,secret:process.env.DOHC_SYNTHETIC_SECRET??null}));`);
  const old=process.env.NODE_OPTIONS,secret=process.env.DOHC_SYNTHETIC_SECRET;
  process.env.NODE_OPTIONS='--require=missing-untrusted-preload';process.env.DOHC_SYNTHETIC_SECRET='do-not-inherit';
  t.after(()=>{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;if(secret===undefined)delete process.env.DOHC_SYNTHETIC_SECRET;else process.env.DOHC_SYNTHETIC_SECRET=secret;});
  const result=await runOwnedCompilerProcess(runtime,{input:Buffer.from('captured bytes'),bounds});
  const value=JSON.parse(Buffer.from(result.stdout).toString());assert.equal(value.input,'captured bytes');assert.notEqual(value.pid,process.pid);assert.equal(value.preload,null);assert.equal(value.secret,null);assert.equal(alive(value.pid),false);
});
test('refuses input overflow and prior cancellation before spawning',windows,async t=>{
  const {runtime}=await fixture(t,'throw Error("must not start")');let spawned=false;runtime.onOwnerSpawn=()=>{spawned=true;};
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(4097),bounds}),{reason:'input'});
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds,signal:AbortSignal.abort()}),{reason:'cancelled'});assert.equal(spawned,false);
});
for(const [stream,reason] of [['stdout','output'],['stderr','stderr']])test(`bounds ${stream} and closes the owner`,windows,async t=>{
  const {runtime}=await fixture(t,`process.${stream}.write(Buffer.alloc(32768));setInterval(()=>{},1000)`);let owner;runtime.onOwnerSpawn=pid=>{owner=pid;};
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds}),{reason});assert.equal(alive(owner),false);
});
for(const mode of ['cancel','timeout','normal-exit'])test(`${mode} closes owned descendants after their direct parent exits`,windows,async t=>{
  const {directory,runtime}=await fixture(t,`import {spawn}from'node:child_process';import{writeFileSync}from'node:fs';const marker=process.argv[2];const child=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',chunk=>{writeFileSync(marker,JSON.stringify({worker:process.pid,descendant:Number(chunk.toString())}));${mode==='normal-exit'?'process.exit(0)':'setInterval(()=>{},1000)'}});`);
  const marker=join(directory,'ready.json');runtime.workerArgs=[marker];let owner;runtime.onOwnerSpawn=pid=>{owner=pid;};const controller=new AbortController();
  const running=runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:{...bounds,timeoutMs:mode==='timeout'?5000:15000},signal:controller.signal});
  const outcome=mode==='normal-exit'?running:assert.rejects(running,{reason:mode==='cancel'?'cancelled':'timeout'});
  const identities=await waitForFile(marker);if(mode==='cancel')controller.abort();await outcome;
  assert.equal(alive(owner),false);assert.equal(alive(identities.worker),false);assert.equal(alive(identities.descendant),false);
});
test('aggregate memory covers two sub-limit native allocations',windows,async t=>{
  const {runtime}=await fixture(t,`import{spawn}from'node:child_process';globalThis.held=Buffer.alloc(160*1024*1024,1);const child=spawn(process.execPath,['-e','try{globalThis.held=Buffer.alloc(160*1024*1024,1);process.exit(0)}catch{process.exit(42)}'],{windowsHide:true,stdio:'inherit'});child.once('exit',code=>process.exit(code??1));`);
  // Each process's 160 MiB allocation fits 320 MiB individually. Together with
  // the two Node runtimes and relay, only the aggregate job exceeds the bound.
  await assert.rejects(runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:{...bounds,maxMemoryBytes:320*1024*1024}}),error=>error.reason==='exit'&&/\(42\)/.test(error.message));
});
test('compiles captured app bytes in the job and snapshots before caller mutation',windows,async()=>{
  const bytes=Buffer.from('document.body.textContent="before";');
  const request={entryPath:'main.js',inputs:[{path:'main.js',bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],bounds:{maxInputFiles:8,maxInputBytes:4096,maxOutputBytes:4096}};
  const pending=compileClosedAppInProcess({nodeExecutable:process.execPath,workerPath:fileURLToPath(new URL('../src/workspaces/closedAppCompilerWorker.ts',import.meta.url))},request,{...bounds,maxInputBytes:8192,maxOutputBytes:8192});
  bytes.fill(0);request.entryPath='changed.js';
  const result=await pending;assert.equal(result.compiler.recipe,'dohc-closed-app-v3');assert.equal(result.files[0].path,'bundle.js');assert.match(Buffer.from(result.files[0].bytes).toString(),/before/);
});
test('abrupt caller death closes its job and descendants',windows,async t=>{
  const {directory,runtime}=await fixture(t,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',chunk=>writeFileSync(process.argv[2],JSON.stringify({worker:process.pid,descendant:Number(chunk.toString())})));setInterval(()=>{},1000);`);
  const marker=join(directory,'ready.json'),ownerMarker=join(directory,'owner.json'),callerPath=join(directory,'caller.mjs');
  const supervisor=new URL('../src/workspaces/compilerProcessSupervisor.ts',import.meta.url).href;
  await writeFile(callerPath,`import{runOwnedCompilerProcess}from${JSON.stringify(supervisor)};import{writeFileSync}from'node:fs';const runtime=${JSON.stringify({...runtime,workerArgs:[marker]})};runtime.onOwnerSpawn=pid=>writeFileSync(${JSON.stringify(ownerMarker)},JSON.stringify({pid}));await runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:${JSON.stringify(bounds)}});`);
  const caller=spawn(process.execPath,[callerPath],{windowsHide:true,stdio:'ignore'});t.after(()=>caller.kill());const closed=once(caller,'close');
  const ids=await waitForFile(marker),owner=await waitForFile(ownerMarker);caller.kill('SIGKILL');await closed;
  const waitScript=`foreach($processId in @(${[owner.pid,ids.worker,ids.descendant].join(',')})){try{$p=[Diagnostics.Process]::GetProcessById($processId);if(-not $p.WaitForExit(5000)){exit 2}}catch [ArgumentException]{}};exit 0`;
  await promisify(execFile)(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',waitScript],{windowsHide:true,timeout:16000});
  for(const pid of [owner.pid,ids.worker,ids.descendant])assert.equal(alive(pid),false);
});
test('owner deadline still kills the build while the caller event loop is blocked',windows,async t=>{
  const {directory,runtime}=await fixture(t,`import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  const marker=join(directory,'ready.json'),ownerMarker=join(directory,'owner.json'),callerPath=join(directory,'blocked-caller.mjs');
  const supervisor=new URL('../src/workspaces/compilerProcessSupervisor.ts',import.meta.url).href;
  await writeFile(callerPath,`import{runOwnedCompilerProcess}from${JSON.stringify(supervisor)};import{writeFileSync}from'node:fs';const runtime=${JSON.stringify({...runtime,workerArgs:[marker]})};runtime.onOwnerSpawn=pid=>{writeFileSync(${JSON.stringify(ownerMarker)},JSON.stringify({pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};void runOwnedCompilerProcess(runtime,{input:Buffer.alloc(0),bounds:${JSON.stringify({...bounds,timeoutMs:2000})}});`);
  const caller=spawn(process.execPath,[callerPath],{windowsHide:true,stdio:'ignore'});t.after(()=>caller.kill());const closed=once(caller,'close');
  const worker=await waitForFile(marker),owner=await waitForFile(ownerMarker);
  const waitScript=`foreach($processId in @(${owner.pid},${worker.pid})){try{$p=[Diagnostics.Process]::GetProcessById($processId);if(-not $p.WaitForExit(5000)){exit 2}}catch [ArgumentException]{}};exit 0`;
  await promisify(execFile)(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',waitScript],{windowsHide:true,timeout:11000});
  assert.equal(alive(owner.pid),false);assert.equal(alive(worker.pid),false);assert.equal(alive(caller.pid),true);caller.kill();await closed;
});
test('parent rejects forged worker file and build identities',windows,async t=>{
  const bytes=Buffer.from('document.body.textContent="identity";');
  const request={entryPath:'main.js',inputs:[{path:'main.js',bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],bounds:{maxInputFiles:8,maxInputBytes:4096,maxOutputBytes:4096}};
  const processBounds={...bounds,maxInputBytes:8192,maxOutputBytes:8192};
  const good=await compileClosedAppInProcess({nodeExecutable:process.execPath,workerPath:fileURLToPath(new URL('../src/workspaces/closedAppCompilerWorker.ts',import.meta.url))},request,processBounds);
  const {directory,runtime}=await fixture(t,`import{readFileSync}from'node:fs';for await(const chunk of process.stdin){}process.stdout.write(readFileSync(process.argv[2]));`);
  // The adapter owns worker arguments, so a forged worker names its fixed test response in its own source.
  const responsePath=join(directory,'response.json');await writeFile(runtime.workerPath,`import{readFileSync}from'node:fs';for await(const chunk of process.stdin){}process.stdout.write(readFileSync(${JSON.stringify(responsePath)}));`);
  const original={...good,files:good.files.map(file=>({...file,bytes:Buffer.from(file.bytes).toString('base64')}))};
  for(const change of [value=>{value.files[0].path='../outside.js'},value=>{value.files[0].contentType='text/html'},value=>{value.files[0].sha256='0'.repeat(64)},value=>{value.bundleDigest='0'.repeat(64)},value=>{value.dependencyLock[0].path='private.js'}]){
    const forged=structuredClone(original);change(forged);await writeFile(responsePath,JSON.stringify(forged));await assert.rejects(compileClosedAppInProcess(runtime,request,processBounds),/compiler|Compiler/);
  }
});
