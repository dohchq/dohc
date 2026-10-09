import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { decodeStateVector } from "yjs";
import type { CaptureRecoveryImportParams, CaptureRecoveryImportResult } from "@dohc/workspace-engine-client";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";

const attribution = z.object({actorKind: z.enum(["human", "agent", "automation"]), onBehalfOf: z.string().optional(), depth: z.number().int().nonnegative().optional(), run: z.object({claimId: z.string(), automationName: z.string()}).strict().optional()}).strict();
const checkpointSchema = z.object({version: z.literal(2), checkpointId: z.string().min(1), workspaceId: z.string().min(1), versionId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), expectedClaimId: z.string().nullable(), expectedStateVectorSha256: z.string().regex(/^[a-f0-9]{64}$/), expectedDiskSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), text: z.string(), updateBase64: z.string(), admittedBaseBase64: z.string(), updates: z.array(z.object({requestId: z.string().min(1), updateBase64: z.string(), actorOriginId: z.string().optional(), attribution: attribution.optional()}).strict()).max(4096)}).strict();
export type OutageTypingCheckpoint = z.infer<typeof checkpointSchema>;
export type TypingRecoveryFailure = {kind: "checkpoint" | "import"; path: string; detail: string; reason?: "author-refused" | "history-missing" | "drawing-unavailable"; retryable?: boolean};
export class DrawingCheckpointUnavailable extends Error {constructor(){super("Drawing changes cannot be kept during an engine outage.");}}
export function typingRecoveryFailure(kind: "checkpoint" | "import", path: string, error: unknown): TypingRecoveryFailure {
 const detail=String(error);
 const reason = error instanceof DrawingCheckpointUnavailable ? "drawing-unavailable" : /remote-human-author|invalid-author/.test(detail) ? "author-refused" : /object-history-missing/.test(detail) ? "history-missing" : undefined;
 return {kind,path,detail,...(reason ? {reason,retryable: reason === "drawing-unavailable"} : {})};
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function typingRecoveryStateVectorSha256(vector: Uint8Array): string {
  const entries = [...decodeStateVector(vector)].sort(([left], [right]) => left - right);
  const bytes: number[] = [];
  const append = (value: number) => {
    while (value >= 128) {
      bytes.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  };
  append(entries.length);
  for (const [client, clock] of entries) { append(client); append(clock); }
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}
const checkpointName = (c: OutageTypingCheckpoint) => digest(JSON.stringify(["outage", c.workspaceId, c.versionId, c.objectId, c.checkpointId])) + ".json";
const fileRevisions = new Map<string, number>();
const fileWrites = new Map<string, Promise<unknown>>();
function withCheckpointFile<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const pending = (fileWrites.get(file) ?? Promise.resolve()).catch(() => undefined).then(operation);
  fileWrites.set(file, pending);
  return pending.finally(() => {if (fileWrites.get(file) === pending) fileWrites.delete(file);});
}
export async function writeTypingCheckpoint(directory: string, checkpoint: OutageTypingCheckpoint): Promise<void> {
  const file=join(directory,checkpointName(checkpoint));
  const revision=(fileRevisions.get(file) ?? 0)+1; fileRevisions.set(file,revision);
  return withCheckpointFile(file, async () => {
  checkpointSchema.parse(checkpoint);
  if (classifyEngineFilePathForRead(checkpoint.path, process.platform).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
  await mkdir(directory, {recursive: true});
  const content = JSON.stringify(checkpoint);
  const temporary = join(directory, checkpointName(checkpoint) + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, content, {encoding: "utf8", flag: "wx", flush: true, mode: 0o600});
    if(fileRevisions.get(file) === revision) renameSync(temporary,file);
  } finally { await rm(temporary, {force: true}).catch(() => undefined); }
  });
}
export async function readTypingCheckpoints(directory: string, workspaceId: string): Promise<{file: string; content: string; checkpoint: OutageTypingCheckpoint}[]> {
  const names = await readdir(directory).catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return []; throw e;});
  const rows = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = join(directory, name);
    const content = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return null; throw e;});
    if (content === null) continue;
    const raw: unknown = JSON.parse(content);
    if (typeof raw !== "object" || raw === null || !("version" in raw) || raw.version !== 2 || !("workspaceId" in raw) || raw.workspaceId !== workspaceId) continue;
    const checkpoint = checkpointSchema.parse(raw);
    if (checkpointName(checkpoint) !== name || classifyEngineFilePathForRead(checkpoint.path, process.platform).kind !== "tracked") throw new Error("Invalid typing recovery record.");
    if (Buffer.byteLength(checkpoint.text) > 16 * 1024 * 1024 || checkpoint.updates.reduce((n, u) => n + Buffer.from(u.updateBase64, "base64").length, 0) > 32 * 1024 * 1024) throw new Error("Typing recovery record exceeds its limit.");
    rows.push({file, content, checkpoint});
  }
  return rows;
}
export async function retireTypingCheckpoint(row: {file: string; content: string}): Promise<void> {
  return withCheckpointFile(row.file, async () => {
  let current: string; try {current=readFileSync(row.file,"utf8");} catch(error) {if((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error;}
  if (current === row.content) rmSync(row.file, {force: true});
  });
}
export async function importTypingCheckpoints(directory: string, workspaceId: string, importer: (input: CaptureRecoveryImportParams) => Promise<CaptureRecoveryImportResult>, failure: (failure: TypingRecoveryFailure) => void, refresh: (path: string) => void): Promise<void> {
  for (const row of await readTypingCheckpoints(directory, workspaceId)) {
    if([...checkpoints.values()].some(owner=>owner.workspaceId === workspaceId && owner.identity?.versionId === row.checkpoint.versionId && (owner.identity.path === row.checkpoint.path || owner.identity.objectId() === row.checkpoint.objectId))) continue;
    try {
      const {version: _version, checkpointId: _checkpointId, workspaceId: _workspace, updateBase64: _update, ...input} = row.checkpoint;
      const result = await importer(input);
      if (result.committed !== true) throw new Error("Recovery was not committed.");
      await retireTypingCheckpoint(row);
      refresh(row.checkpoint.path);
    } catch (error) { failure(typingRecoveryFailure("import",row.checkpoint.path,error)); }
  }
}

export function writeTypingCheckpointSync(directory: string, checkpoint: OutageTypingCheckpoint): void {
 checkpointSchema.parse(checkpoint);
 if(classifyEngineFilePathForRead(checkpoint.path,process.platform).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
 const file=join(directory,checkpointName(checkpoint));
 fileRevisions.set(file,(fileRevisions.get(file) ?? 0)+1);
 mkdirSync(directory,{recursive:true});
 const temporary=file+"."+randomUUID()+".tmp";
 try {writeFileSync(temporary,JSON.stringify(checkpoint),{encoding:"utf8",flag:"wx",flush:true,mode:0o600});renameSync(temporary,file);}
 finally {rmSync(temporary,{force:true});}
}
type CheckpointOwner = {workspaceId:string;flush:()=>Promise<void>;pending:()=>boolean;identity?:{versionId:string;path:string;objectId:()=>string|undefined};flushSync?:()=>void;unresolved:()=>boolean};
const checkpoints = new Map<object, CheckpointOwner>();
export function registerTypingCheckpoint(workspaceId: string, flush: () => Promise<void>, pending: () => boolean = () => true, identity?: CheckpointOwner["identity"], flushSync?:()=>void, unresolved:()=>boolean=pending): () => void {
 const token={}; checkpoints.set(token,{workspaceId,flush,pending,identity,flushSync,unresolved});
 return ()=>checkpoints.delete(token);
}
export async function flushTypingCheckpoints(workspaceId?: string): Promise<void> {
 const results=await Promise.allSettled([...checkpoints.values()].filter(c=>workspaceId === undefined || c.workspaceId === workspaceId).map(c=>c.flush()));
 const failure=results.find((r):r is PromiseRejectedResult=>r.status === "rejected"); if(failure) throw failure.reason;
}
export function flushTypingCheckpointsSync():void {
 let failure:unknown; for(const checkpoint of checkpoints.values()) {try{checkpoint.flushSync?.();}catch(error){failure ??=error;}} if(failure)throw failure;
}
export function hasUnresolvedTypingCheckpoints(): boolean {return [...checkpoints.values()].some(c=>c.pending());}
export function isTypingSessionUnresolved(workspaceId:string,path:string):boolean {return [...checkpoints.values()].some(c=>c.workspaceId === workspaceId && c.identity?.path === path && c.unresolved());}
