import { createHash } from "node:crypto";
import { parseAppBackendCapability, parseAppBackendFile, parseAppBackendJson } from "@dohc/security-contract/app-backend";

export interface LocalBackendRecovery {
  formatVersion: 1;
  integritySha256: string;
  snapshot: {workspaceId:string;dataPath:string;appRoot:string;publicationId:string;publicationRevision:number;
    schemaSha256:string;schemaVersion:number;sourceSha256:string;source:string;capabilityJson:string;revision:number;
    databaseBase64:string;updatedAtMs:number};
  history: Record<string,unknown>[];
  receipts: Record<string,unknown>[];
  files: Record<string,unknown>[];
}
export const recoveryHash = (value:string|Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(value:unknown, depth=0):string {
  if(depth>32)throw new Error("Recovery JSON is nested too deeply.");
  if(Array.isArray(value))return `[${value.map(item=>canonical(item,depth+1)).join(",")}]`;
  if(value && typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item,depth+1)}`).join(",")}}`;
  const encoded=JSON.stringify(value);if(encoded===undefined)throw new Error("Invalid recovery JSON.");return encoded;
}
export function signLocalBackendRecovery(value:Omit<LocalBackendRecovery,"integritySha256">):LocalBackendRecovery {
  const encoded=canonical(value);
  if(Buffer.byteLength(encoded)>128*1024*1024)throw new Error("The app recovery bundle is too large.");
  return {...value,integritySha256:recoveryHash(encoded)};
}
export function recoveryBytes(value:unknown, max=16*1024*1024):Uint8Array {
  if(typeof value!=="string" || value.length>Math.ceil(max/3)*4)throw new Error("Invalid recovery bytes.");
  const bytes=Buffer.from(value,"base64");
  if(bytes.byteLength>max || bytes.toString("base64")!==value)throw new Error("Invalid recovery bytes.");return bytes;
}
function text(value:unknown,max=512):string {
  if(typeof value!=="string" || !value || Buffer.byteLength(value)>max || value.includes("\0"))throw new Error("Invalid recovery text.");return value;
}
function integer(value:unknown,min=0):number {
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<min)throw new Error("Invalid recovery revision.");return value;
}
function digest(value:unknown):string {
  if(typeof value!=="string" || !/^[a-f0-9]{64}$/.test(value))throw new Error("Invalid recovery digest.");return value;
}
export function parseLocalBackendRecovery(raw:unknown):LocalBackendRecovery {
  const encoded=JSON.stringify(raw);
  if(!encoded || Buffer.byteLength(encoded)>128*1024*1024)throw new Error("The app recovery bundle is too large.");
  const bundle=JSON.parse(encoded) as LocalBackendRecovery;
  if(!bundle || bundle.formatVersion!==1 || !bundle.snapshot || Object.keys(bundle).sort().join()!=="files,formatVersion,history,integritySha256,receipts,snapshot")throw new Error("Invalid app recovery bundle.");
  const {integritySha256,...payload}=bundle;
  if(signLocalBackendRecovery(payload).integritySha256!==digest(integritySha256))throw new Error("The app recovery integrity check failed.");
  const snapshot=bundle.snapshot;
  text(snapshot.workspaceId);text(snapshot.dataPath,1024);text(snapshot.appRoot,1024);text(snapshot.publicationId);
  integer(snapshot.revision,1);integer(snapshot.publicationRevision,1);integer(snapshot.schemaVersion,1);integer(snapshot.updatedAtMs);
  digest(snapshot.schemaSha256);digest(snapshot.sourceSha256);
  if(recoveryHash(text(snapshot.source,256*1024))!==snapshot.sourceSha256)throw new Error("The recovery source digest differs.");
  const capability=parseAppBackendCapability(JSON.parse(text(snapshot.capabilityJson,65536)));
  if(capability.dataPath!==snapshot.dataPath || capability.schemaSha256!==snapshot.schemaSha256 || capability.schemaVersion!==snapshot.schemaVersion || capability.backendSha256!==snapshot.sourceSha256)throw new Error("The recovery capability differs.");
  const database=recoveryBytes(snapshot.databaseBase64);
  for(const rows of [bundle.history,bundle.receipts,bundle.files])if(!Array.isArray(rows)||rows.length>100000)throw new Error("Invalid app recovery inventory.");
  const scoped=(row:Record<string,unknown>)=>{if(!row || row.workspace_id!==snapshot.workspaceId || row.data_path!==snapshot.dataPath)throw new Error("The recovery row belongs to another app.");};
  bundle.history.forEach((row,index)=>{
    scoped(row);
    if(integer(row.revision,1)!==index+1 || !["activate","operation","restore"].includes(String(row.kind)))throw new Error("The recovery history is incomplete.");
    text(row.publication_id);integer(row.publication_revision,1);digest(row.source_sha256);digest(row.database_sha256);integer(row.recorded_at_ms);
    const bytes=recoveryBytes(row.changeset_base64);
    if(row.kind==="operation"){text(row.grant_id);text(row.principal_id);}
    else if(row.grant_id!=="" || row.principal_id!=="" || bytes.byteLength!==0)throw new Error("Invalid recovery approval history.");
  });
  const last=bundle.history.at(-1);
  if(bundle.history.length!==snapshot.revision || last?.database_sha256!==recoveryHash(database) || last.publication_id!==snapshot.publicationId ||
    last.publication_revision!==snapshot.publicationRevision || last.source_sha256!==snapshot.sourceSha256 || last.recorded_at_ms!==snapshot.updatedAtMs)throw new Error("The recovery database differs from its history.");
  const receiptKeys=new Set<string>(),receiptRevisions=new Set<number>();
  bundle.receipts.forEach(row=>{
    scoped(row);text(row.grant_id);text(row.principal_id);text(row.idempotency_key,128);digest(row.payload_sha256);
    if(!/^[A-Za-z0-9._:-]+$/.test(String(row.idempotency_key)))throw new Error("Invalid recovery retry key.");
    const revision=integer(row.revision,1),history=bundle.history[revision-1],key=JSON.stringify([row.grant_id,row.principal_id,row.idempotency_key]);
    if(receiptKeys.has(key)||receiptRevisions.has(revision)||history?.kind!=="operation"||history.grant_id!==row.grant_id||history.principal_id!==row.principal_id)throw new Error("Invalid recovery receipt history.");
    parseAppBackendJson(JSON.parse(text(row.result_json,256*1024)));integer(row.recorded_at_ms);receiptKeys.add(key);receiptRevisions.add(revision);
  });
  if(bundle.history.filter(row=>row.kind==="operation").length!==receiptRevisions.size)throw new Error("The recovery receipts are incomplete.");
  const fileIds=new Set<string>(),uploadKeys=new Set<string>();
  bundle.files.forEach(row=>{
    scoped(row);const content=recoveryBytes(row.content_base64,5*1024*1024);
    parseAppBackendFile({fileId:row.file_id,name:row.name,contentType:row.content_type,byteLength:content.byteLength,sha256:row.sha256});
    text(row.grant_id);text(row.principal_id);text(row.idempotency_key,128);
    const attached=integer(row.attached_revision,1),history=bundle.history[attached-1],key=JSON.stringify([row.grant_id,row.principal_id,row.idempotency_key]);
    if(recoveryHash(content)!==row.sha256 || fileIds.has(String(row.file_id)) || uploadKeys.has(key) || history?.kind!=="operation" ||
      history.grant_id!==row.grant_id || history.principal_id!==row.principal_id || integer(row.expires_at_ms)<=integer(row.created_at_ms))throw new Error("Invalid recovery file history.");
    fileIds.add(String(row.file_id));uploadKeys.add(key);
  });
  return bundle;
}
