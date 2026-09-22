import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetJournal } from "./journal.js";
import { createDatasetReplicaHost } from "./replica-host.js";
import { createDatasetReplica, type DatasetReplica, type DatasetReplicaSource } from "./replica.js";
import type { PersistentRuntimeOptions } from "./persistent.js";
import type { AppRuntimeLauncher } from "./protocol.js";

const hash=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
vi.setConfig({testTimeout:30_000,hookTimeout:30_000});
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={workspaceId:"workspace",datasetId:id(1)};
const schemaSql="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL,secret TEXT NOT NULL);";
const source="globalThis.operations={read(ctx){globalThis.readCount=(globalThis.readCount||0)+1;if(globalThis.readCount!==1)throw Error('read state leaked');return ctx.db.query('SELECT id,value FROM items ORDER BY id')},add(ctx){ctx.db.execute(\"INSERT INTO items VALUES(99,'bad','private')\");}};";
const definition:DatasetDefinition={formatVersion:1,datasetId:id(1),name:"Items",schemaPath:"schema.sql",operationsPath:"operations.js",
 tables:[{tableId:id(2),name:"Items",sqlName:"items",primaryKey:"id",fields:[{fieldId:id(3),name:"ID",sqlColumn:"id",type:"number",required:true,unique:true},{fieldId:id(4),name:"Value",sqlColumn:"value",type:"text",required:true,unique:false},{fieldId:id(7),name:"Secret",sqlColumn:"secret",type:"text",required:true,unique:false}]}],
 operations:[{operationId:id(5),name:"read",label:"Read",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3),id(4)]},{operationId:id(6),name:"add",label:"Add",tableId:id(2),kind:"create",access:"owner",readOnly:false,fieldIds:[id(4)]}]};
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),"dohc-replica-test-")),db=new DatabaseSync(join(directory,"host.sqlite")),seedPath=join(directory,"seed.sqlite"),seed=new DatabaseSync(seedPath);seed.exec(schemaSql);
 const tx=<T>(run:()=>T)=>{db.exec("BEGIN IMMEDIATE");try{const value=run();db.exec("COMMIT");return value;}catch(error){db.exec("ROLLBACK");throw error;}};
 const journal=createDatasetJournal({db,transaction:tx}),approved=describeDatasetRevision({definition,revision:1,schemaSql,operationSource:source});
 let head=journal.initialize({scope,hostEpoch:"host",approvedRevisionHash:approved.revisionSha256,source,schemaSql,definitionJson:JSON.stringify(approved),checkpoint:await readFile(seedPath),authorize(){}});
 let allowed=true,owner=true;
 const host=createDatasetReplicaHost({journal,owner(context:string){if(!allowed||context!=="owner")throw Error("revoked");return {principal:"owner"};}});
 const remote:DatasetReplicaSource={async capture(){return host.replicaCapture("owner",scope);},async page(input){return host.replicaPage("owner",{...scope,...input});},async blob(input){return host.replicaBlob("owner",{...scope,...input});}};
 const copies:DatasetReplica[]=[];
 async function open(runtime?: PersistentRuntimeOptions){const replica=await createDatasetReplica({directory:join(directory,"copy"),scope,ownerKey:"owner",origin:"https://relay",runtime,assertOwner(){if(!owner)throw Error("owner changed");}});copies.push(replica);return replica;}
 cleanups.push(async()=>{for(const copy of copies)await copy.close();seed.close();db.close();await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:25});});
 function add(value:string){const session=seed.createSession({table:"items"});seed.prepare("INSERT INTO items(value,secret) VALUES(?,'private')").run(value);const changeset=session.changeset();session.close();const result=journal.commitOperation({expected:head,proposalId:value,operation:"add",callerKey:"owner",idempotencyKey:value,payloadSha256:hash(value),resultJson:"null",changeset,changesetSha256:hash(changeset),attachedFileIds:[],authorize(){},accountAndAttach(){}});if(result.kind!=="committed")throw Error("replay");head=result.event.cursor;}
 const read={operationId:id(5),revision:1,revisionSha256:approved.revisionSha256,input:{}};
 async function transition(){head=journal.transitionCheckpoint({expected:head,hostEpoch:"new-host",approvedRevisionHash:approved.revisionSha256,source,schemaSql,definitionJson:JSON.stringify(approved),checkpoint:await readFile(seedPath),authorize(){}});}
 return {directory,remote,host,open,add,read,transition,head:()=>head,revoke:()=>{allowed=false;},changeOwner:()=>{owner=false;}};
}
it("inspects approved fields offline after restart, catches up across a writer checkpoint, and refuses writes",async()=>{
 const f=await fixture();f.add("first");const replica=await f.open();await replica.catchUp(f.remote);
 expect(await replica.read(f.read)).toMatchObject({result:[{id:1,value:"first"}],offline:true,revision:1});
 await expect(replica.read({...f.read,operationId:id(6)})).rejects.toThrow("read-only");
 await replica.close();const resumed=await f.open();f.revoke();
 expect((await resumed.read(f.read)).result).toEqual([{id:1,value:"first"}]);
 await expect(resumed.catchUp(f.remote)).rejects.toThrow("revoked");
 await resumed.revoke();await expect(resumed.read(f.read)).rejects.toThrow("unavailable");
});
it("continues through an explicit writer transition without running source actions",async()=>{
 const f=await fixture();f.add("first");const replica=await f.open();await replica.catchUp(f.remote);
 await f.transition();f.add("second");await replica.catchUp(f.remote);
 expect(replica.state()?.cursor).toEqual(f.head());
 expect((await replica.read(f.read)).result).toEqual([{id:1,value:"first"},{id:2,value:"second"}]);
});
it("retains the prior committed page across interruption and retries after restart",async()=>{
 const f=await fixture();f.add("first");const replica=await f.open();await replica.catchUp(f.remote);f.add("second");
 await expect(replica.catchUp({...f.remote,async blob(){throw Error("disconnected");}})).rejects.toThrow("disconnected");
 expect(replica.state()?.cursor.revision).toBe(1);await replica.close();const resumed=await f.open();
 await resumed.catchUp(f.remote);expect((await resumed.read(f.read)).result).toHaveLength(2);
});
it("rejects duplicate pages, changed bytes, and another local owner without advancing",async()=>{
 const f=await fixture();f.add("first");const replica=await f.open();await replica.catchUp(f.remote);f.add("second");
 await expect(replica.catchUp({...f.remote,async page(input){const page=await f.remote.page(input);return {...page,records:[page.records[0]!,page.records[0]!]};}})).rejects.toThrow("out of order");
 expect(replica.state()?.cursor.revision).toBe(1);
 await expect(replica.catchUp({...f.remote,async blob(input){const bytes=await f.remote.blob(input);bytes[0]^=1;return bytes;}})).rejects.toThrow("history changed");
 expect(replica.state()?.cursor.revision).toBe(1);f.changeOwner();await expect(replica.read(f.read)).rejects.toThrow("owner changed");
});
it("never gives a participant the raw replica stream",async()=>{
 const f=await fixture();expect(()=>f.host.replicaCapture("participant",scope)).toThrow("revoked");
});
it("locks one owner copy and prunes snapshots while committing bounded pages",async()=>{
 const f=await fixture(),replica=await f.open();await expect(f.open()).rejects.toThrow(/locked/);
 await replica.catchUp(f.remote);for(let n=0;n<65;n++)f.add(`row-${n}`);
 await replica.catchUp(f.remote);expect(replica.state()?.cursor.revision).toBe(65);
 expect((await readdir(join(f.directory,"copy"))).filter(name=>/^[a-f0-9-]{36}\.sqlite$/.test(name))).toHaveLength(1);
});

it("reuses one read worker and fresh guest contexts, replaces it after catch-up, and clears it on revoke",async()=>{
 const launch=vi.fn<AppRuntimeLauncher>(options=>{
  const child=spawn(process.execPath,["--disable-warning=ExperimentalWarning",options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
  child.on("message",options.onMessage);child.on("error",options.onError);child.on("close",options.onExit);
  return {postMessage(message){child.send(message as object,error=>{if(error)options.onError(error);});},kill(){child.kill("SIGKILL");}};
 });
 const f=await fixture();f.add("first");const replica=await f.open({launch});await replica.catchUp(f.remote);launch.mockClear();
 expect((await replica.read(f.read)).result).toEqual([{id:1,value:"first"}]);
 expect((await replica.read(f.read)).result).toEqual([{id:1,value:"first"}]);
 expect(launch).toHaveBeenCalledOnce();
 expect((await readdir(join(f.directory,"copy"))).filter(name=>name.startsWith("read-"))).toHaveLength(1);
 // An unchanged head keeps the warm read worker.
 await replica.catchUp(f.remote);await replica.read(f.read);expect(launch).toHaveBeenCalledOnce();
 f.add("second");await replica.catchUp(f.remote);
 expect((await readdir(join(f.directory,"copy"))).filter(name=>name.startsWith("read-"))).toHaveLength(0);
 expect((await replica.read(f.read)).result).toHaveLength(2);expect(launch).toHaveBeenCalledTimes(3);
 await replica.revoke();
 expect((await readdir(join(f.directory,"copy"))).filter(name=>name.startsWith("read-")||/^[a-f0-9-]{36}\.sqlite$/.test(name))).toHaveLength(0);
 await expect(replica.read(f.read)).rejects.toThrow("unavailable");
});

it("closes a warm read worker and refuses new reads immediately",async()=>{
 const f=await fixture(), replica=await f.open();await replica.catchUp(f.remote);await replica.read(f.read);
 const closing=replica.close();
 await expect(replica.read(f.read)).rejects.toThrow("unavailable");await closing;
 expect((await readdir(join(f.directory,"copy"))).filter(name=>name.startsWith("read-"))).toHaveLength(0);
 const resumed=await f.open();expect((await resumed.read(f.read)).result).toEqual([]);
});
