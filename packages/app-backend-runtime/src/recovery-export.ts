import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseDatasetRevision } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetCursor, DatasetJournal, DatasetScope, JournalDb, JournalExportRecord } from "./journal.js";
import { encodeRecoveryManifest, RECOVERY_CHUNK_BYTES, writeDatasetRecovery, type DatasetRecoveryManifest, type RecoveryEntry, type RecoveryLimits } from "./recovery.js";

export const RECOVERY_HISTORY_MAGIC = Buffer.from("DOHCDH01");
export interface RecoveryAttachment {
  fileId: string; name: string; contentType: string; byteLength: number; sha256: string;
  /** First committed association; unassociated uploads are excluded. */
  revision: number;
}
export interface DatasetExportOptions {
  db: JournalDb;
  journal: DatasetJournal;
  scope: DatasetScope;
  /** Private host-owned staging directory. */
  directory: string;
  authorize(): void;
  signal?: AbortSignal;
  limits: RecoveryLimits;
  attachments?: {
    /** Synchronous, in the head-capture transaction. Return immutable bytes associated at or before cursor. */
    capture(cursor: DatasetCursor): RecoveryAttachment[];
    open(file: RecoveryAttachment): AsyncIterable<Uint8Array>;
  };
}
export type DatasetRecoveryRecord =
  | { kind: "catalog"; revisionJson: string; artifactsJson: string }
  | { kind: "current-checkpoint"; checkpoint: Extract<JournalExportRecord, { kind: "checkpoint" }> }
  | { kind: "catalog-revision"; revisionJson: string; artifactsJson: string }
  | { kind: "binding"; appId: string; bindingJson: string; token: string }
  | { kind: "grant"; principalKey: string; grantJson: string; token: string }
  | { kind: "attachment"; file: RecoveryAttachment }
  | JournalExportRecord;

function sync<T>(run: () => T): T {
  if (run.constructor.name === "AsyncFunction") throw new Error("Dataset export capture must be synchronous.");
  const value = run();
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) throw new Error("Dataset export capture must be synchronous.");
  return value;
}
/** Each history record is u32 metadata length, UTF-8 JSON, then its declared raw blob bytes. */
export function encodeDatasetRecoveryRecord(record: DatasetRecoveryRecord): Uint8Array {
  const json = Buffer.from(JSON.stringify(record));
  if (json.byteLength > RECOVERY_CHUNK_BYTES) throw new Error("Dataset recovery record exceeds its metadata bound.");
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(json.byteLength);
  return Buffer.concat([prefix, json]);
}

/** Stages one pinned revision without holding a transaction across asynchronous file writes. */
export async function prepareDatasetRecoveryExport(options: DatasetExportOptions) {
  const { db, journal } = options, scope={...options.scope};
  if(!Number.isSafeInteger(options.limits.maxTotalBytes)||options.limits.maxTotalBytes<1)throw new Error("Invalid dataset export storage reservation.");
  const authorize = () => { options.signal?.throwIfAborted(); sync(options.authorize); };
  const pinned = journal.captureExport({ scope, authorize, capture(cursor) {
    const catalog = db.prepare("SELECT revision_json,artifacts_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(scope.workspaceId,scope.datasetId);
    if (!catalog) throw new Error("Dataset catalog is missing.");
    const revisionJson = String(catalog.revision_json), artifactsJson = String(catalog.artifacts_json);
    const revision = verifyDatasetArtifacts({ revision: parseDatasetRevision(JSON.parse(revisionJson)), ...JSON.parse(artifactsJson) });
    // Mutable permissions are copied once; histories and data blobs remain immutable and paged.
    const sizes = db.prepare(`SELECT COALESCE(SUM(n),0) AS bytes,COALESCE(SUM(c),0) AS count FROM (
      SELECT SUM(length(CAST(binding_json AS BLOB))+length(CAST(app_id AS BLOB))+length(CAST(token AS BLOB))) AS n,COUNT(*) AS c
      FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? UNION ALL
      SELECT SUM(length(CAST(grant_json AS BLOB))+length(CAST(principal_key AS BLOB))+length(CAST(token AS BLOB))),COUNT(*)
      FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=?)`).get(scope.workspaceId,scope.datasetId,scope.workspaceId,scope.datasetId)!;
    if (Number(sizes.bytes) > 8*1024*1024 || Number(sizes.count) > 4096) throw new Error("Dataset export permission snapshot exceeds its bound.");
    const bindings = db.prepare("SELECT app_id,binding_json,token FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? ORDER BY app_id").all(scope.workspaceId,scope.datasetId)
      .map(row => ({ kind: "binding" as const, appId:String(row.app_id),bindingJson:String(row.binding_json),token:String(row.token) }));
    const grants = db.prepare("SELECT principal_key,grant_json,token FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? ORDER BY principal_key").all(scope.workspaceId,scope.datasetId)
      .map(row => ({ kind: "grant" as const, principalKey:String(row.principal_key),grantJson:String(row.grant_json),token:String(row.token) }));
    const files=options.attachments ? sync(()=>options.attachments!.capture(cursor)) : [];
    if(!Array.isArray(files)||files.length>4096)throw new Error("Dataset export attachment count exceeds its bound.");
    const attachments=files.map(file=>({...file}));
    return { revision, revisionJson, artifactsJson, bindings, grants, attachments };
  } });
  if (pinned.captured.revision.revisionSha256 !== pinned.cursor.approvedRevisionHash) throw new Error("Dataset catalog and journal approval differ.");
  const attachments = pinned.captured.attachments;
  if (!Array.isArray(attachments) || attachments.length > (options.limits.maxEntries ?? 4096)-5) throw new Error("Dataset export attachment count exceeds its bound.");
  const seen = new Set<string>();
  for (const file of attachments) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(file.fileId) || seen.has(file.fileId) || !Number.isSafeInteger(file.revision) || file.revision<1 || file.revision>pinned.cursor.revision ||
      !Number.isSafeInteger(file.byteLength) || file.byteLength<0 || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.name!=="string" || Buffer.byteLength(file.name)>1024 || typeof file.contentType!=="string" || Buffer.byteLength(file.contentType)>256) throw new Error("Invalid dataset export attachment metadata.");
    seen.add(file.fileId);
  }
  await mkdir(options.directory,{recursive:true});const parent=await realpath(options.directory),directory=await mkdtemp(join(parent,"export-"));
  const entries:RecoveryEntry[]=[],paths=new Map<string,string>(),attachedReferences=new Set<string>();let total=0,disposed=false;
  const dispose=async()=>{if(!disposed){disposed=true;await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:25});}};
  async function save(entry:Omit<RecoveryEntry,"byteLength"|"sha256">,chunks:AsyncIterable<Uint8Array>) {
    authorize();const path=join(directory,`${entries.length}.bin`),file=await open(path,"wx",0o600),hash=createHash("sha256");let size=0;
    try {for await(const chunk of chunks){authorize();if(!(chunk instanceof Uint8Array)||chunk.byteLength>RECOVERY_CHUNK_BYTES+4)throw new Error("Dataset export chunk exceeds its bound.");
      total+=chunk.byteLength;size+=chunk.byteLength;if(total>options.limits.maxTotalBytes)throw new Error("Dataset export exceeds its storage reservation.");
      hash.update(chunk);let offset=0;while(offset<chunk.byteLength){const wrote=await file.write(chunk,offset,chunk.byteLength-offset);if(!wrote.bytesWritten)throw new Error("Dataset export write stopped.");offset+=wrote.bytesWritten;}
    }}finally{await file.close();}
    const completed={...entry,byteLength:size,sha256:hash.digest("hex")};entries.push(completed);paths.set(entry.id,path);return completed;
  }
  async function* bytes(value:Uint8Array){for(let offset=0;offset<value.byteLength;offset+=RECOVERY_CHUNK_BYTES)yield value.subarray(offset,offset+RECOVERY_CHUNK_BYTES);}
  async function* blob(record:JournalExportRecord){const hash=createHash("sha256");for(let offset=0;offset<record.byteLength;offset+=RECOVERY_CHUNK_BYTES){const chunk=journal.exportBlob({scope,record,offset,authorize});hash.update(chunk);yield chunk;}
    if(hash.digest("hex")!==(record.kind==="checkpoint"?record.sha256:record.changesetSha256))throw new Error("Dataset export history blob hash differs.");}
  async function* records(after:number,through:number){let previous=after;
    while(previous<through){const page=journal.exportPage({scope,through:pinned.cursor,afterRevision:previous,authorize});if(!page.length)throw new Error("Dataset export history is incomplete.");
      for(const record of page){if(record.cursor.revision>through)return;if(record.kind==="event")for(const fileId of record.attachedFileIds)attachedReferences.add(fileId);
        yield encodeDatasetRecoveryRecord(record);yield*blob(record);previous=record.cursor.revision;}}
  }
  try {
    const checkpoint=await save({id:"checkpoint",kind:"checkpoint"},blob(pinned.checkpoint));
    if(checkpoint.sha256!==pinned.checkpoint.sha256)throw new Error("Dataset export checkpoint hash differs.");
    const original=JSON.parse(pinned.captured.artifactsJson) as {schemaSql:string;operationSource:string};
    await save({id:"artifact:source",kind:"artifact",role:"source"},bytes(Buffer.from(original.operationSource)));
    await save({id:"artifact:schema",kind:"artifact",role:"schema"},bytes(Buffer.from(original.schemaSql)));
    await save({id:"artifact:definition",kind:"artifact",role:"definition"},bytes(Buffer.from(pinned.captured.revisionJson)));
    async function* history(){
      yield RECOVERY_HISTORY_MAGIC;
      yield encodeDatasetRecoveryRecord({kind:"catalog",revisionJson:pinned.captured.revisionJson,artifactsJson:pinned.captured.artifactsJson});
      yield encodeDatasetRecoveryRecord({kind:"current-checkpoint",checkpoint:pinned.checkpoint});
      for(const row of [...pinned.captured.bindings,...pinned.captured.grants])yield encodeDatasetRecoveryRecord(row);
      let after=0;
      for(;;){authorize();const row=db.prepare("SELECT revision,revision_json,artifacts_json FROM dohc_dataset_catalog_history WHERE workspace_id=? AND dataset_id=? AND revision>? AND revision<? ORDER BY revision LIMIT 1")
          .get(scope.workspaceId,scope.datasetId,after,pinned.captured.revision.revision);
        if(!row)break;yield encodeDatasetRecoveryRecord({kind:"catalog-revision",revisionJson:String(row.revision_json),artifactsJson:String(row.artifacts_json)});after=Number(row.revision);}
      for(const file of attachments)yield encodeDatasetRecoveryRecord({kind:"attachment",file});
      yield*records(-1,pinned.checkpoint.cursor.revision-1);
    }
    await save({id:"history",kind:"history"},history());
    if(pinned.cursor.revision>pinned.checkpoint.cursor.revision)await save({id:"events",kind:"events",afterRevision:pinned.checkpoint.cursor.revision,throughRevision:pinned.cursor.revision},records(pinned.checkpoint.cursor.revision,pinned.cursor.revision));
    if([...attachedReferences].some(fileId=>!seen.has(fileId))||attachments.some(file=>!attachedReferences.has(file.fileId)))throw new Error("Dataset export attachment inventory does not match its committed history.");
    for(const file of attachments){const saved=await save({id:`attachment:${file.fileId}`,kind:"attachment"},options.attachments!.open(file));if(saved.byteLength!==file.byteLength||saved.sha256!==file.sha256)throw new Error("Dataset export attachment hash differs.");}
    const manifest:DatasetRecoveryManifest={format:"dohc-dataset-recovery-v1",cursor:pinned.cursor,checkpoint:pinned.checkpoint.cursor,entries};encodeRecoveryManifest(manifest,options.limits);authorize();
    return {manifest,directory,dispose,stream(){if(disposed)throw new Error("Dataset export was disposed.");return writeDatasetRecovery({manifest,limits:options.limits,signal:options.signal,authorize,
      open(entry){return createReadStream(paths.get(entry.id)!,{highWaterMark:RECOVERY_CHUNK_BYTES});}});}};
  }catch(error){await dispose();throw error;}
}
