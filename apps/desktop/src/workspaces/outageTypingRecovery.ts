import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { decodeStateVector } from "yjs";
import type { CaptureRecoveryImportParams, CaptureRecoveryImportResult } from "@dohc/workspace-engine-client";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";

const attribution = z.object({actorKind: z.enum(["human", "agent", "automation"]), onBehalfOf: z.string().optional(), depth: z.number().int().nonnegative().optional(), run: z.object({claimId: z.string(), automationName: z.string()}).strict().optional()}).strict();
const checkpointSchema = z.object({version: z.literal(2), workspaceId: z.string().min(1), versionId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), expectedClaimId: z.string().nullable(), expectedStateVectorSha256: z.string().regex(/^[a-f0-9]{64}$/), expectedDiskSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), text: z.string(), updateBase64: z.string(), admittedBaseBase64: z.string(), updates: z.array(z.object({requestId: z.string().min(1), updateBase64: z.string(), actorOriginId: z.string().optional(), attribution: attribution.optional()}).strict()).max(4096)}).strict();
export type OutageTypingCheckpoint = z.infer<typeof checkpointSchema>;
export type TypingRecoveryFailure = {kind: "checkpoint" | "import"; path: string; detail: string};
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
const checkpointName = (c: OutageTypingCheckpoint) => digest(JSON.stringify(["outage", c.workspaceId, c.versionId, c.objectId])) + ".json";
const fileWrites = new Map<string, Promise<unknown>>();
function withCheckpointFile<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const pending = (fileWrites.get(file) ?? Promise.resolve()).catch(() => undefined).then(operation);
  fileWrites.set(file, pending);
  return pending.finally(() => {if (fileWrites.get(file) === pending) fileWrites.delete(file);});
}
export async function writeTypingCheckpoint(directory: string, checkpoint: OutageTypingCheckpoint): Promise<void> {
  return withCheckpointFile(join(directory, checkpointName(checkpoint)), async () => {
  checkpointSchema.parse(checkpoint);
  if (classifyEngineFilePathForRead(checkpoint.path, process.platform).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
  await mkdir(directory, {recursive: true});
  const content = JSON.stringify(checkpoint);
  const temporary = join(directory, checkpointName(checkpoint) + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, content, {encoding: "utf8", flag: "wx", flush: true, mode: 0o600});
    await rename(temporary, join(directory, checkpointName(checkpoint)));
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
  const current = await readFile(row.file, "utf8").catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return null; throw e;});
  if (current === row.content) await rm(row.file, {force: true});
  });
}
export async function importTypingCheckpoints(directory: string, workspaceId: string, importer: (input: CaptureRecoveryImportParams) => Promise<CaptureRecoveryImportResult>, failure: (failure: TypingRecoveryFailure) => void, refresh: (path: string) => void): Promise<void> {
  for (const row of await readTypingCheckpoints(directory, workspaceId)) {
    try {
      const {version: _version, workspaceId: _workspace, updateBase64: _update, admittedBaseBase64: _base, ...input} = row.checkpoint;
      const result = await importer(input);
      if (result.committed !== true) throw new Error("Recovery was not committed.");
      await retireTypingCheckpoint(row);
      refresh(row.checkpoint.path);
    } catch (error) { failure({kind: "import", path: row.checkpoint.path, detail: String(error)}); }
  }
}

const checkpoints = new Map<object, {workspaceId: string; flush: () => Promise<void>; pending: () => boolean}>();
export function registerTypingCheckpoint(workspaceId: string, flush: () => Promise<void>, pending: () => boolean = () => true): () => void {
  const token = {};
  checkpoints.set(token, {workspaceId, flush, pending});
  return () => checkpoints.delete(token);
}
export async function flushTypingCheckpoints(workspaceId?: string): Promise<void> {
  await Promise.all([...checkpoints.values()].filter(c => workspaceId === undefined || c.workspaceId === workspaceId).map(c => c.flush()));
}

export function hasUnresolvedTypingCheckpoints(): boolean {return [...checkpoints.values()].some(c => c.pending());}
