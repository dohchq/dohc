import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireSupervisorOwnership, acquireWorkerLease, type SupervisorOwnership } from "./worker-ownership.ts";

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"dohc-worker-ownership-"));cleanups.push(()=>rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:25}));return root;}
function owned(owner:SupervisorOwnership){cleanups.push(async()=>owner.close());return owner;}
async function child(code:string):Promise<{child:ChildProcess;message:any}> {
  const processChild=spawn(process.execPath,["--disable-warning=ExperimentalWarning","--input-type=module","--eval",code],{stdio:["ignore","pipe","pipe","ipc"],serialization:"advanced",windowsHide:true});
  let stderr="";processChild.stderr?.on("data",chunk=>{stderr+=chunk;});
  const exited=once(processChild,"exit");
  cleanups.push(async()=>{if(processChild.exitCode===null&&processChild.signalCode===null){processChild.kill("SIGKILL");await exited;}});
  const message=await Promise.race([once(processChild,"message").then(([message])=>message),exited.then(()=>{throw Error(`Ownership child stopped: ${stderr}`);})]);
  return {child:processChild,message};
}
const moduleUrl=new URL("./worker-ownership.ts",import.meta.url).href;
it("prevents two supervisors from owning the same canonical root",async()=>{
  const root=await fixture(),owner=owned(await acquireSupervisorOwnership(root));
  await expect(acquireSupervisorOwnership(root)).rejects.toThrow("busy or unavailable");
  owner.close();owned(await acquireSupervisorOwnership(root));
});
it("recovers and removes a dead host's validated worker directory after a real process kill",async()=>{
  const root=await fixture();
  const run=await child(`import {acquireSupervisorOwnership} from ${JSON.stringify(moduleUrl)};import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
    const owner=await acquireSupervisorOwnership(${JSON.stringify(root)});const path=await owner.createDirectory();await writeFile(join(path,'app.sqlite'),'private data');process.send({path});process.on('message',()=>{});`);
  const exit=once(run.child,"exit");run.child.kill("SIGKILL");await exit;
  owned(await acquireSupervisorOwnership(root));
  expect((await readdir(root)).filter(name=>name.startsWith("worker-"))).toEqual([]);
});
it("refuses startup while an orphan worker still owns its local lock",async()=>{
  const root=await fixture(),owner=owned(await acquireSupervisorOwnership(root)),path=await owner.createDirectory();
  await writeFile(join(path,"app.sqlite"),"must survive");
  const run=await child(`import {acquireWorkerLease} from ${JSON.stringify(moduleUrl)};const lease=acquireWorkerLease(${JSON.stringify(path)},${JSON.stringify({root:owner.root,session:owner.session})});process.send('locked');process.on('message',()=>lease.close());`);
  owner.close();
  await expect(acquireSupervisorOwnership(root).then(owned)).rejects.toThrow("busy or unavailable");expect(await readFile(join(path,"app.sqlite"),"utf8")).toBe("must survive");
  const exit=once(run.child,"exit");run.child.kill("SIGKILL");await exit;
  owned(await acquireSupervisorOwnership(root));expect((await readdir(root)).filter(name=>name.startsWith("worker-"))).toEqual([]);
});
it("rejects a delayed child from an expired host session before it can use data",async()=>{
  const root=await fixture(),old=owned(await acquireSupervisorOwnership(root)),oldPath=await old.createDirectory(),stale={root:old.root,session:old.session};old.close();
  const next=owned(await acquireSupervisorOwnership(root)),path=await next.createDirectory();
  expect(()=>acquireWorkerLease(path,stale)).toThrow("expired host session");
  expect(()=>acquireWorkerLease(oldPath,stale)).toThrow();
  const lease=acquireWorkerLease(path,next);lease.close();await next.removeDirectory(path);
});
it("never deletes a directory whose ownership manifest is unknown",async()=>{
  const root=await fixture(),owner=owned(await acquireSupervisorOwnership(root)),path=await owner.createDirectory();await writeFile(join(path,"app.sqlite"),"keep");owner.close();
  await writeFile(join(path,".dohc-worker.json"),'{}');
  await expect(acquireSupervisorOwnership(root)).rejects.toThrow("inspect it before cleanup");expect(await readFile(join(path,"app.sqlite"),"utf8")).toBe("keep");
});
it("refuses unexpected worker folders and preserves unrelated host files",async()=>{
  const root=await fixture();await writeFile(join(root,"owner-notes.txt"),"keep");await mkdir(join(root,"worker-unknown"));
  await expect(acquireSupervisorOwnership(root)).rejects.toThrow("outside its owned root");expect(await readFile(join(root,"owner-notes.txt"),"utf8")).toBe("keep");
});
it("holds child ownership until explicit close and supports Windows cleanup afterward",async()=>{
  const root=await fixture(),owner=owned(await acquireSupervisorOwnership(root)),path=await owner.createDirectory(),lease=acquireWorkerLease(path,owner);
  await expect(owner.removeDirectory(path)).rejects.toThrow("busy or unavailable");lease.close();await owner.removeDirectory(path);
  expect((await readdir(root)).filter(name=>name.startsWith("worker-"))).toEqual([]);
});
it("reclaims actual supervisor materialization after host death and IPC worker exit",async()=>{
  const directory=await fixture(),root=join(directory,"workers");
  const supervisorUrl=new URL("../dist/supervisor.mjs",import.meta.url).href,journalUrl=new URL("../dist/journal.mjs",import.meta.url).href;
  const childSource=JSON.stringify("globalThis.operations={run(){return 'saved';}};");
  const run=await child(`import {createDatasetSupervisor} from ${JSON.stringify(supervisorUrl)};import {createDatasetJournal} from ${JSON.stringify(journalUrl)};
    import {DatabaseSync} from 'node:sqlite';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {spawn} from 'node:child_process';
    const directory=${JSON.stringify(directory)},root=${JSON.stringify(root)};const schemaSql='CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL);';
    const seed=new DatabaseSync(join(directory,'seed.sqlite'));seed.exec(schemaSql);seed.close();const db=new DatabaseSync(join(directory,'authority.sqlite'));
    function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
    const journal=createDatasetJournal({db,transaction}),scope={workspaceId:'workspace',datasetId:'data'};
    journal.initialize({scope,hostEpoch:'host',approvedRevisionHash:'a'.repeat(64),source:${childSource},schemaSql,definitionJson:'{}',checkpoint:await readFile(join(directory,'seed.sqlite')),authorize(){}});
    let workerPid;
    const supervisor=await createDatasetSupervisor({journal,directory:root,runtime:{launch(options){
      const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true});workerPid=child.pid;
      child.on('message',options.onMessage);child.on('error',options.onError);child.on('close',options.onExit);return{postMessage(message){child.send(message);},kill(){child.kill('SIGKILL');}};
    }}});
    await supervisor.invoke({scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:null,idempotencyKey:'retry',payloadSha256:'b'.repeat(64),readOnly:false,authorize(){}});
    process.send({workerPid});process.on('message',()=>{});`);
  expect((await readdir(root)).filter(name=>name.startsWith("worker-"))).toHaveLength(1);
  const exit=once(run.child,"exit");run.child.kill("SIGKILL");await exit;
  await vi.waitFor(()=>{try{process.kill(run.message.workerPid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return;throw error;}throw Error("Worker still exiting after IPC disconnect.");},{timeout:10000});
  owned(await acquireSupervisorOwnership(root));expect((await readdir(root)).filter(name=>name.startsWith("worker-"))).toEqual([]);
  expect((await readFile(join(directory,"authority.sqlite"))).length).toBeGreaterThan(0);
});
