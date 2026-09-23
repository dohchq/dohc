import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface WorkerOwnership { root: string; session: string }
export interface WorkerLease { close(): void }
export interface SupervisorOwnership extends WorkerOwnership {
  createDirectory(): Promise<string>;
  removeDirectory(directory:string): Promise<void>;
  close(): void;
}
const SESSION=".dohc-worker-session.json", MANIFEST=".dohc-worker.json", LOCK=".dohc-worker-lock.sqlite";
const format="dohc-dataset-worker-v1";
function regular(path:string, optional=false):void {
  let info;
  try{info=lstatSync(path);}catch(error){if(optional&&(error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(!info.isFile()||info.isSymbolicLink())throw new Error(`Dataset ownership path is not a regular file: ${path}`);
}
function canonical(path:string):string {
  if(typeof path!=="string"||!isAbsolute(path)||path.includes("\0"))throw new Error("Invalid dataset worker path.");
  const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error(`Dataset worker directory is not a regular directory: ${path}`);
  return realpathSync(path);
}
function child(root:string,directory:string):string {
  const dir=canonical(directory),name=relative(root,dir);
  if(!/^worker-[a-f0-9-]{36}$/.test(name))throw new Error(`Dataset worker directory is outside its owned root: ${directory}`);
  return dir;
}
function readJson(path:string):Record<string,unknown> {
  regular(path);
  if(lstatSync(path).size>4096)throw new Error(`Dataset ownership record exceeds its limit: ${path}`);
  try {const value=JSON.parse(readFileSync(path,"utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw Error();return value;}
  catch{throw new Error(`Dataset ownership record is damaged; inspect it before cleanup: ${path}`);}
}
function durableJson(path:string,value:unknown):void {
  const temporary=`${path}.${randomUUID()}.tmp`,fd=openSync(temporary,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(value),"utf8");fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);
}
function lock(path:string,create:boolean):WorkerLease {
  for(const candidate of [path,`${path}-journal`,`${path}-wal`,`${path}-shm`])regular(candidate,true);
  if(!create)regular(path);
  const db=new DatabaseSync(path,{allowExtension:false});
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;");
    if(create)db.exec("CREATE TABLE IF NOT EXISTS ownership(singleton INTEGER PRIMARY KEY CHECK(singleton=1));");
    db.exec("BEGIN EXCLUSIVE");
    let closed=false;
    return {close(){if(closed)return;closed=true;try{db.exec("ROLLBACK");}finally{db.close();}}};
  }catch(error){db.close();throw new Error(`Dataset worker ownership is busy or unavailable: ${path}`,{cause:error});}
}
function manifest(root:string,directory:string):Record<string,unknown> {
  let value:Record<string,unknown>;
  try{value=readJson(join(directory,MANIFEST));}catch(error){throw new Error(`Dataset worker ownership is missing or damaged; inspect it before cleanup: ${directory}`,{cause:error});}
  if(value.format!==format||value.root!==root||value.directory!==basename(directory)||typeof value.session!=="string"||!/^[a-f0-9-]{36}$/.test(value.session))
    throw new Error(`Unknown dataset worker directory; inspect it before cleanup: ${directory}`);
  return value;
}
function current(ownership:WorkerOwnership):void {
  const value=readJson(join(ownership.root,SESSION));
  if(value.format!==format||value.root!==ownership.root||value.session!==ownership.session)throw new Error("Dataset worker belongs to an expired host session.");
}

/** Child holds this OS-backed SQLite lock until it closes. PIDs and expiry timers are not authority. */
export function acquireWorkerLease(directory:string,ownership:WorkerOwnership):WorkerLease {
  const root=canonical(ownership.root),dir=child(root,directory),expected={root,session:ownership.session};
  const lease=lock(join(dir,LOCK),false);
  try {
    // Check after locking: a delayed child cannot open old data after startup cleanup has begun.
    current(expected);
    if(manifest(root,dir).session!==expected.session)throw new Error("Dataset worker manifest belongs to another session.");
    return lease;
  }catch(error){lease.close();throw error;}
}

/** One supervisor owns this root. Startup removes only validated, unlocked worker directories. */
export async function acquireSupervisorOwnership(directory:string):Promise<SupervisorOwnership> {
  const root=canonical(directory),lease=lock(join(root,LOCK),true),session=randomUUID();
  let closed=false;
  const ownership={root,session};
  function standing(){if(closed)throw new Error("Dataset worker ownership is closed.");current(ownership);}
  async function removeDirectory(path:string):Promise<void> {
    standing();const dir=child(root,path);manifest(root,dir);
    const orphan=lock(join(dir,LOCK),false);orphan.close();
    // Only old-session children can race startup cleanup; their session check now fails.
    await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:25});
  }
  try {
    regular(join(root,SESSION),true);
    durableJson(join(root,SESSION),{format,root,session});
    const names=await readdir(root);
    for(const name of names){
      if(name.startsWith("worker-"))await removeDirectory(join(root,name));
      else if(name.startsWith(`${SESSION}.`)&&name.endsWith(".tmp")){
        const path=join(root,name),pending=readJson(path);
        if(pending.format!==format||pending.root!==root||typeof pending.session!=="string"||!/^[a-f0-9-]{36}$/.test(pending.session))throw new Error(`Unknown dataset ownership file; inspect it before cleanup: ${path}`);
        await rm(path);
      }
    }
    return {...ownership,
      async createDirectory(){
        standing();const path=join(root,`worker-${randomUUID()}`);await mkdir(path);standing();
        durableJson(join(path,MANIFEST),{format,root,session,directory:basename(path)});
        const worker=lock(join(path,LOCK),true);worker.close();return path;
      },
      removeDirectory,
      close(){if(closed)return;closed=true;lease.close();}
    };
  }catch(error){closed=true;lease.close();throw error;}
}
