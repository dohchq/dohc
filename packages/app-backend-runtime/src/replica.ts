import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseDatasetRevision, type DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetCursor, DatasetScope, JournalExportRecord } from "./journal.js";
import { equalRecoveryCursor, parseRecoveryCursor, parseRecoveryJournalRecord } from "./recovery-record.js";
import { openPersistentAppBackend, type PersistentAppBackend, type PersistentRuntimeOptions } from "./persistent.js";
import type { JsonValue } from "./protocol.js";
import type { DatasetReplicaCapture, DatasetReplicaPage } from "./replica-host.js";

type Checkpoint = Extract<JournalExportRecord, { kind: "checkpoint" }>;
export interface DatasetReplicaSource {
  capture(signal?: AbortSignal): Promise<DatasetReplicaCapture>;
  page(input: { through: DatasetCursor; after: DatasetCursor; limit: number; signal?: AbortSignal }): Promise<DatasetReplicaPage>;
  blob(input: { record: JournalExportRecord; offset: number; length: number; signal?: AbortSignal }): Promise<Uint8Array>;
}
export interface DatasetReplicaState { cursor: DatasetCursor; checkpoint: Checkpoint; savedAtMs: number }
interface StoredReplica extends DatasetReplicaState { snapshot: string; sha256: string }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex"), CHUNK = 1024 * 1024;
const sameScope = (a: DatasetScope, b: DatasetScope) => a.workspaceId === b.workspaceId && a.datasetId === b.datasetId;
const sameEpoch = (a: DatasetCursor, b: DatasetCursor) => sameScope(a,b) && a.hostEpoch === b.hostEpoch && a.approvedRevisionHash === b.approvedRevisionHash;

/** One owner-bound, read-only downloaded copy. Catch-up replays committed bytes, never backend actions. */
export async function createDatasetReplica(options: {
  directory: string; scope: DatasetScope; ownerKey: string; origin: string;
  assertOwner(): void; runtime?: PersistentRuntimeOptions; maxCheckpointBytes?: number;
}) {
  options.assertOwner();
  const root = resolve(options.directory);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || resolve(await realpath(root)) !== root) throw Error("Collection copy storage changed.");
  const db = new DatabaseSync(join(root, "replica.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS copy(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,state TEXT NOT NULL) STRICT;");
  const binding = hash(JSON.stringify([options.scope, options.ownerKey, new URL(options.origin).origin]));
  const maximum = options.maxCheckpointBytes ?? 128 * CHUNK;
  let closed = false, revoked = false, pending: Promise<unknown> = Promise.resolve();
  function authorize(signal?: AbortSignal) {
    if (closed || revoked) throw Error("This Collection copy is unavailable. Download it again after restoring access.");
    options.assertOwner(); signal?.throwIfAborted();
  }
  function read(): StoredReplica | null {
    authorize(); const row = db.prepare("SELECT binding,state FROM copy WHERE id=1").get();
    if (!row) return null;
    if (row.binding !== binding) throw Error("This Collection copy belongs to another owner or server.");
    const value = JSON.parse(String(row.state)) as StoredReplica;
    const cursor = parseRecoveryCursor(value.cursor), checkpoint = parseRecoveryJournalRecord(value.checkpoint);
    if (checkpoint.kind !== "checkpoint" || !sameScope(cursor,options.scope) || !sameEpoch(cursor,checkpoint.cursor) || cursor.revision < checkpoint.cursor.revision ||
        !/^[a-f0-9-]{36}\.sqlite$/.test(value.snapshot) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error("The Collection copy is damaged. Download it again.");
    return {...value,cursor,checkpoint};
  }
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run,run); pending = result.catch(() => {}); return result;
  }
  async function digestFile(path: string, signal?: AbortSignal) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw Error("Invalid Collection copy file.");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(path, { highWaterMark: CHUNK })) { authorize(signal); digest.update(bytes); }
    return digest.digest("hex");
  }
  function revision(checkpoint: Checkpoint): DatasetRevision {
    const value = parseDatasetRevision(JSON.parse(checkpoint.definitionJson));
    if (value.datasetId !== options.scope.datasetId || value.revisionSha256 !== checkpoint.cursor.approvedRevisionHash) throw Error("The Collection copy rules do not match its checkpoint.");
    return value;
  }
  async function worker(checkpoint: Checkpoint, cursor: DatasetCursor, path: string, directory: string) {
    const approved = revision(checkpoint);
    return openPersistentAppBackend({ directory, checkpointPath:path,schemaSql:checkpoint.schemaSql,
      tables:approved.definition.tables.map(table=>table.sqlName),scope:cursor,cursor,databaseBytes:checkpoint.capacityBytes },options.runtime);
  }
  async function download(source: DatasetReplicaSource, record: JournalExportRecord, directory: string, signal?: AbortSignal): Promise<string> {
    const path = join(directory, `${randomUUID()}.sqlite`), file = await open(path,"wx",0o600), digest = createHash("sha256");
    try {
      for (let offset=0;offset<record.byteLength;) {
        authorize(signal); const length = Math.min(CHUNK, record.byteLength-offset);
        const bytes = await source.blob({record,offset,length,signal}); authorize(signal);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength!==length) throw Error("The Collection download was interrupted. Retry it.");
        digest.update(bytes); await file.writeFile(bytes); offset+=bytes.byteLength;
      }
      if(digest.digest("hex")!==(record.kind==="checkpoint"?record.sha256:record.changesetSha256)) throw Error("The Collection download changed. Retry it.");
      await file.sync(); return path;
    } finally {await file.close();}
  }
  async function persist(active: PersistentAppBackend, checkpoint: Checkpoint, cursor: DatasetCursor, signal?: AbortSignal): Promise<StoredReplica> {
    authorize(signal); const snapshot = `${randomUUID()}.sqlite`, path=join(root,snapshot);
    await active.snapshot(path);
    const sha256=await digestFile(path,signal), value={snapshot,sha256,checkpoint,cursor,savedAtMs:Date.now()};
    authorize(signal);
    db.prepare("INSERT INTO copy VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET binding=excluded.binding,state=excluded.state").run(binding,JSON.stringify(value));
    return value;
  }
  async function cleanup() {
    const kept=read()?.snapshot;
    for(const name of await readdir(root)) if (/^[a-f0-9-]{36}\.sqlite$/.test(name) && name!==kept) await rm(join(root,name),{force:true});
  }
  return {
    state(): DatasetReplicaState|null { const value=read(); return value ? {cursor:value.cursor,checkpoint:value.checkpoint,savedAtMs:value.savedAtMs} : null; },
    catchUp(source: DatasetReplicaSource, signal?: AbortSignal) {
      return enqueue(async()=>{
        authorize(signal); const capture=await source.capture(signal); authorize(signal);
        const through=parseRecoveryCursor(capture.head), initial=parseRecoveryJournalRecord(capture.checkpoint);
        if(!sameScope(through,options.scope)||initial.kind!=="checkpoint"||!sameEpoch(initial.cursor,through)||initial.cursor.revision>through.revision||initial.byteLength>maximum) throw Error("The server returned another Collection checkpoint.");
        let saved=read();
        if(saved && saved.cursor.revision>through.revision) throw Error("The sharing server is behind this Collection copy.");
        const scratch=await mkdtemp(join(root,"work-"));
        let active:PersistentAppBackend|undefined, checkpoint=saved?.checkpoint??initial, cursor=saved?.cursor??initial.cursor;
        try {
          if(saved) {
            if(await digestFile(join(root,saved.snapshot),signal)!==saved.sha256) throw Error("The Collection copy changed. Download it again.");
            const directory=await mkdtemp(join(scratch,"worker-")); active=await worker(checkpoint,cursor,join(root,saved.snapshot),directory);
          } else {
            checkpoint=initial;cursor=initial.cursor;
            const path=await download(source,checkpoint,scratch,signal),directory=await mkdtemp(join(scratch,"worker-"));
            active=await worker(checkpoint,cursor,path,directory); saved=await persist(active,checkpoint,cursor,signal);
          }
          while(!equalRecoveryCursor(cursor,through)) {
            const page=await source.page({through,after:cursor,limit:32,signal}); authorize(signal);
            if(!equalRecoveryCursor(parseRecoveryCursor(page.through),through)||!equalRecoveryCursor(parseRecoveryCursor(page.after),cursor)||!Array.isArray(page.records)||!page.records.length||page.records.length>64||Buffer.byteLength(JSON.stringify(page.records))>CHUNK) throw Error("The Collection history has a gap. Download it again.");
            for(const raw of page.records) {
              const record=parseRecoveryJournalRecord(raw);
              if(!sameScope(record.cursor,options.scope)||record.cursor.revision!==cursor.revision+1||record.cursor.revision>through.revision) throw Error("The Collection history is out of order.");
              if(record.kind==="checkpoint") {
                if(!record.previous||!equalRecoveryCursor(record.previous,cursor)||record.byteLength>maximum) throw Error("The Collection checkpoint does not continue this copy.");
                const path=await download(source,record,scratch,signal),directory=await mkdtemp(join(scratch,"worker-"));
                const next=await worker(record,record.cursor,path,directory); await active.close();active=next;checkpoint=record;
              } else {
                if(!sameEpoch(record.cursor,cursor)||record.previousDigest!==cursor.digest) throw Error("The Collection writer changed without a checkpoint.");
                const bytes=new Uint8Array(record.byteLength);let offset=0;
                while(offset<bytes.length){authorize(signal);const length=Math.min(CHUNK,bytes.length-offset),chunk=await source.blob({record,offset,length,signal});authorize(signal);
                  if(!(chunk instanceof Uint8Array)||chunk.length!==length)throw Error("The Collection download was interrupted. Retry it.");bytes.set(chunk,offset);offset+=length;}
                if(hash(bytes)!==record.changesetSha256)throw Error("The Collection history changed. Retry it.");
                await active.apply({...record.cursor,previousDigest:record.previousDigest,changesetSha256:record.changesetSha256,changeset:bytes});
              }
              cursor=record.cursor;
            }
            saved=await persist(active,checkpoint,cursor,signal);
          }
          await cleanup();return {cursor: saved!.cursor,checkpoint:saved!.checkpoint,savedAtMs:saved!.savedAtMs};
        } finally {await active?.close();await rm(scratch,{recursive:true,force:true});}
      });
    },
    read(input:{operationId:string;revision:number;revisionSha256:string;input:JsonValue;signal?:AbortSignal}) {
      return enqueue(async()=>{
        authorize(input.signal);const state=read();if(!state)throw Error("Download this Collection before opening it offline.");
        const approved=revision(state.checkpoint),operation=approved.definition.operations.find(item=>item.operationId===input.operationId);
        if(approved.revision!==input.revision||approved.revisionSha256!==input.revisionSha256||!operation?.readOnly)throw Error("This Collection copy is read-only. Reconnect to make changes.");
        if(await digestFile(join(root,state.snapshot),input.signal)!==state.sha256)throw Error("The Collection copy changed. Download it again.");
        const directory=await mkdtemp(join(root,"read-"));let active:PersistentAppBackend|undefined;
        try {active=await worker(state.checkpoint,state.cursor,join(root,state.snapshot),directory);
          const value=await active.prepare({expected:state.cursor,source:state.checkpoint.source,operation:operation.name,caller:{kind:"owner"},input:input.input,nowMs:Date.now(),requestId:randomUUID(),readOnly:true});
          authorize(input.signal);return {result:value.result,revision:state.cursor.revision,replayed:false as const,offline:true as const,savedAtMs:state.savedAtMs};
        } finally {await active?.close();await rm(directory,{recursive:true,force:true});}
      });
    },
    async revoke() { revoked=true;await pending;db.prepare("DELETE FROM copy").run();for(const name of await readdir(root))if(/^[a-f0-9-]{36}\.sqlite$/.test(name))await rm(join(root,name),{force:true}); },
    async close() {await pending;if(!closed){closed=true;db.close();}},
  };
}
export type DatasetReplica = Awaited<ReturnType<typeof createDatasetReplica>>;
