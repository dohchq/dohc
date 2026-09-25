import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { approvedTables, boundedText, runtimeLimits } from "./protocol.js";
import type { AppOperationFile, AppOperationRefusal, JsonValue, RuntimeLimits } from "./protocol.js";
import type { GuestRequest } from "./guest.js";
import type { WorkerOwnership } from "./worker-ownership.js";
import type { MigrationPreviewTableSummary } from "./migration-preview-report.js";
import type { DatabaseSync } from "node:sqlite";

export interface DatasetScope { workspaceId: string; datasetId: string; hostEpoch: string; approvedRevisionHash: string }
export interface DatasetCursor { revision: number; digest: string }
export interface PersistentOpenInput {
  directory: string;
  ownership?: WorkerOwnership;
  checkpointPath?: string;
  requireCheckpointCursor?: boolean;
  schemaSql: string;
  tables: string[];
  scope: DatasetScope;
  cursor: DatasetCursor;
  databaseBytes?: number;
  limits?: Partial<Omit<RuntimeLimits, "databaseBytes">>;
  queueDeadlineMs?: number;
}
export interface PersistentPrepareInput {
  expected: DatasetCursor;
  source: string;
  operation: string;
  caller: JsonValue;
  input: JsonValue;
  nowMs: number;
  requestId: string;
  secret?: string;
  readOnly?: boolean;
  files?: AppOperationFile[];
}
export interface PreparedOperation {
  proposalId: string;
  readOnly: boolean;
  result: JsonValue;
  changeset: Uint8Array;
  changesetSha256: string;
  attachedFileIds: string[];
  /**
   * Each approved table's column names, in the order a changeset records
   * them. A migration can reorder columns, so reading a changeset needs
   * these; the reader checks them against the approved definition.
   */
  columns: Record<string, string[]>;
}
export interface FinalizeOperation extends DatasetCursor {
  proposalId: string;
  previousDigest: string;
  changesetSha256: string;
}
export interface CommittedChangeset extends DatasetCursor {
  previousDigest: string;
  changesetSha256: string;
  changeset: Uint8Array;
}
export const REPLAY_BATCH_EVENTS=64;
export const REPLAY_BATCH_BYTES=32*1024*1024;
export interface MigrateCheckpointInput { path:string; schemaSql:string; tables:string[]; migrationSql:string; reportPath?:string }
export interface MigratedCheckpoint { path:string; cursor:DatasetCursor; report?: { tables:MigrationPreviewTableSummary[]; bytes:number } }
export interface OpenRequest extends Omit<PersistentOpenInput, "limits" | "databaseBytes" | "queueDeadlineMs"> { limits: RuntimeLimits }
export type PersistentCommand = {kind:"open";input:OpenRequest}
  | {kind:"prepare";expected:DatasetCursor;guest:GuestRequest}
  | {kind:"finalize";input:FinalizeOperation}
  | {kind:"discard";proposalId:string}
  | {kind:"apply";input:CommittedChangeset}
  | {kind:"applyBatch";input:CommittedChangeset[]}
  | {kind:"snapshot";path:string}
  | {kind:"migrateCheckpoint";input:MigrateCheckpointInput}
  | {kind:"close"};
export type PersistentResult = DatasetCursor | PreparedOperation | MigratedCheckpoint | null;
export type PersistentReply = {id:number;ok:true;result:PersistentResult}
  | {id:number;ok:false;error:string;code:string;refusal?:AppOperationRefusal};
// Sent by the worker as each step of a command starts, so the host can tell
// slow work from a worker that stopped. A step that runs under a CPU budget of
// its own and reports nothing inside, such as the integrity check, names that
// budget, and the host lets the step stay quiet long enough to use it.
export type PersistentProgress = {id:number;progress:string;cpuBudgetMs?:number};
// Written into the dataset directory by the worker's CPU budget watch just
// before it ends the worker, so the host can say why the worker stopped. It
// holds the budget that ran out and its size: "app 5000" or "checks 9000".
export const CPU_BUDGET_MARKER="cpu-budget-exceeded";
// Runs a step of the dataset worker under one of its CPU budgets: the app's
// code, or a check over `bytes` of data.
export interface CpuBudgets {
  appCode<T>(run:()=>T):T;
  datasetCheck<T>(bytes:number, run:()=>T):T;
}
export const unbudgeted:CpuBudgets={appCode:run=>run(),datasetCheck:(_bytes,run)=>run()};
// Free pages are left out, so deleting rows cannot raise a check's allowance.
export function databaseBytes(db:DatabaseSync):number {
  return Number(db.prepare("SELECT (page_count-freelist_count)*page_size AS bytes FROM pragma_page_count(),pragma_freelist_count(),pragma_page_size()").get()!.bytes);
}
// A whole-dataset loop reports its step again after this many rows, so the
// host's silence limit sees progress and the CPU budget decides how long it runs.
export const HEARTBEAT_ROWS=1000;

export class PersistentRuntimeError extends Error {
  /** Set by the supervisor when this failure makes the dataset wait before it reopens. */
  retryAfterMs?: number;
  constructor(readonly code:string, message:string) { super(message); this.name="PersistentRuntimeError"; }
}
export function reject(code:string, message:string):never { throw new PersistentRuntimeError(code,message); }
export function digest(bytes:Uint8Array):string { return createHash("sha256").update(bytes).digest("hex"); }
export function checkDigest(value:string):void { if (!/^[a-f0-9]{64}$/.test(value)) reject("invalid_input","Invalid dataset digest."); }
export function checkCursor(cursor:DatasetCursor):void {
  if (!cursor || !Number.isSafeInteger(cursor.revision) || cursor.revision<0) reject("invalid_input","Invalid dataset revision.");
  checkDigest(cursor.digest);
}
export function trustedPath(path:string):string {
  if (typeof path!=="string" || !isAbsolute(path) || path.includes("\0")) reject("invalid_input","Dataset paths must be absolute.");
  return path;
}
export function openRequest(input:PersistentOpenInput):OpenRequest {
  trustedPath(input.directory);
  if(input.ownership) {
    trustedPath(input.ownership.root);
    if(typeof input.ownership.session!=="string" || !/^[a-f0-9-]{36}$/.test(input.ownership.session)) reject("invalid_input","Invalid worker ownership session.");
  }
  if (input.checkpointPath) trustedPath(input.checkpointPath);
  checkCursor(input.cursor);
  if (input.cursor.revision>0 && !input.checkpointPath) reject("invalid_input","A committed dataset requires a checkpoint.");
  for (const value of [input.scope.workspaceId,input.scope.datasetId,input.scope.hostEpoch]) {
    if (typeof value!=="string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) reject("invalid_input","Invalid dataset scope.");
  }
  checkDigest(input.scope.approvedRevisionHash);
  const databaseBytes=input.databaseBytes ?? 128*1024*1024;
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes<4096 || databaseBytes>128*1024*1024) reject("invalid_input","Invalid dataset storage reservation.");
  const limits={...runtimeLimits(input.limits),databaseBytes};
  return {directory:input.directory,checkpointPath:input.checkpointPath,
    requireCheckpointCursor:input.requireCheckpointCursor===true,
    ...(input.ownership ? {ownership:{root:input.ownership.root,session:input.ownership.session}} : {}),
    tables:approvedTables(input.tables),schemaSql:boundedText(input.schemaSql,limits.sourceBytes,"Database schema"),
    scope:{workspaceId:input.scope.workspaceId,datasetId:input.scope.datasetId,hostEpoch:input.scope.hostEpoch,approvedRevisionHash:input.scope.approvedRevisionHash},
    cursor:{revision:input.cursor.revision,digest:input.cursor.digest},limits};
}
