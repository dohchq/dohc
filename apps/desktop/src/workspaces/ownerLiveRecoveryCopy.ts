import {createHash} from "node:crypto";
import {z} from "zod";
import {parseLiveObjectBinding, type OwnerYDocOutboxEntry, type OwnerYDocOutboxRecovery} from "@dohc/workspace-engine-client";
import type {DocumentProjection} from "./documentProjection";

export const LIVE_RECOVERY_FORMAT = "dohc.live-recovery";
const OPEN = "Apply checkpoint when present, then base, then each update in order, as Yjs v1 updates to an empty Y.Doc. Each sha256 is the hex SHA-256 of the decoded bytes.";

/** The queue being saved: which file it belongs to, why it waits, and where it is kept. */
export type LiveRecoverySource = {path: string; reason: string; storedOn: "this-computer" | "server"};

/** Workspace-relative paths of what Save recovery copy wrote, and where the kept edits stay. */
export type LiveRecoveryFiles = {copyPath: string | null; packagePath: string; storedOn: LiveRecoverySource["storedOn"]};

/** Where Save recovery copy writes. `create` makes one new file on disk and refuses an existing path with EEXIST. */
export type LiveRecoveryWrites = {
  create(relativePath: string, text: string): Promise<string>;
  exists(relativePath: string): Promise<boolean>;
};

const MAX_NAME_ATTEMPTS = 100;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const isEexist = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

const Bytes = z.object({sha256: z.string().regex(/^[0-9a-f]{64}$/), byteLength: z.number().int().positive(), base64: z.string().min(1)}).strict();
const LiveRecoveryPackage = z.object({
  format: z.literal(LIVE_RECOVERY_FORMAT), version: z.literal(1), open: z.string(), savedAt: z.string(),
  path: z.string().min(1), reason: z.string().min(1), storedOn: z.enum(["this-computer", "server"]),
  outboxId: z.string().min(1), binding: z.unknown().transform(value => parseLiveObjectBinding(value)),
  checkpoint: Bytes.nullable(), base: Bytes,
  updates: z.array(Bytes.extend({sequence: z.number().int().positive(), deliveryId: z.string().min(1), appendKey: z.string().min(1),
    createdAtMs: z.number().int().nonnegative(), author: z.record(z.string(), z.unknown()).nullable(),
    nativeSource: z.record(z.string(), z.unknown()).optional()}).strict()),
}).strict();

/**
 * A lossless copy of a refused queue that rebuilds the document without dohc:
 * the accepted checkpoint its entries build on, the queue's base, and every
 * pending update in order with its digest and recorded author.
 */
export type LiveRecoveryPackage = z.output<typeof LiveRecoveryPackage>;

function bytes(value: Uint8Array) {
  return {sha256: sha256(value), byteLength: value.byteLength, base64: base64(value)};
}

function author(entry: OwnerYDocOutboxEntry) {
  if (entry.agentDeclaration) return {kind: "agent", declaration: entry.agentDeclaration};
  if (entry.automationDeclaration) return {kind: "automation", declaration: entry.automationDeclaration};
  if (entry.personEdit) return {kind: "person"};
  // A native update names the author this computer's journal recorded for it.
  const origin = entry.nativeSource?.origin;
  if (origin?.kind !== "nativeUpdate" || origin.actorKind === null) return null;
  return {kind: origin.actorKind === "human" ? "person" : origin.actorKind, actorOriginId: origin.actorOriginId,
    onBehalfOf: origin.onBehalfOf, chainDepth: origin.chainDepth};
}

/** Packages a refused queue read with its checkpoint. Refuses bytes that do not match their digests. */
export function liveRecoveryPackage(queue: OwnerYDocOutboxRecovery, source: LiveRecoverySource, now = Date.now()): LiveRecoveryPackage {
  if (sha256(queue.baseUpdate) !== queue.baseUpdateDigest || queue.entries.some(entry => sha256(entry.update) !== entry.updateDigest)) {
    throw new Error("dohc could not read your kept edits completely. Try again.");
  }
  return {format: LIVE_RECOVERY_FORMAT, version: 1, open: OPEN, savedAt: new Date(now).toISOString(),
    path: source.path, reason: source.reason, storedOn: source.storedOn, outboxId: queue.outboxId, binding: queue.binding,
    checkpoint: queue.checkpoint === null ? null : bytes(queue.checkpoint), base: bytes(queue.baseUpdate),
    updates: queue.entries.map(entry => ({sequence: entry.sequence, deliveryId: entry.deliveryId, appendKey: entry.appendKey,
      createdAtMs: entry.createdAtMs, ...bytes(entry.update), author: author(entry),
      ...(entry.nativeSource ? {nativeSource: {...entry.nativeSource}} : {})}))};
}

/** The updates a package says to apply, in order. Refuses a part whose bytes do not match its digest. */
export function liveRecoveryUpdates(recovery: LiveRecoveryPackage): Uint8Array[] {
  return [...(recovery.checkpoint ? [recovery.checkpoint] : []), recovery.base, ...recovery.updates].map(part => {
    const decoded = Buffer.from(part.base64, "base64");
    if (decoded.byteLength !== part.byteLength || sha256(decoded) !== part.sha256) {
      throw new Error("dohc could not read your kept edits completely. Try again.");
    }
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  });
}

export function parseLiveRecoveryPackage(text: string): LiveRecoveryPackage {
  const recovery = LiveRecoveryPackage.parse(JSON.parse(text));
  liveRecoveryUpdates(recovery);
  return recovery;
}

function recoveredName(path: string, attempt: number, extension?: string): string {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  return `${stem} (recovered${attempt === 1 ? "" : ` ${attempt}`})${extension ?? ext}`;
}

/**
 * Saves a refused queue next to its file and leaves the queue as it is. The
 * package is written first and always, under the first number whose copy
 * name is free too. The readable copy is projected off main afterwards; when
 * it cannot be made, the saved package is the result.
 */
export async function saveLiveRecoveryCopy(recovery: LiveRecoveryPackage, writes: LiveRecoveryWrites,
  projection: DocumentProjection, now = Date.now()): Promise<LiveRecoveryFiles> {
  const updates = liveRecoveryUpdates(recovery);
  const text = JSON.stringify({...recovery, savedAt: new Date(now).toISOString()}, null, 2);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const copyName = recoveredName(recovery.path, attempt);
    if (await writes.exists(copyName)) continue;
    let packagePath: string;
    try {packagePath = await writes.create(recoveredName(recovery.path, attempt, ".dohc-recovery.json"), text);}
    catch (error) {if (isEexist(error)) continue; throw error;}
    try {
      const markdown = await projection.run({kind: "recover", updates});
      return {copyPath: markdown === null ? null : await writes.create(copyName, markdown), packagePath, storedOn: recovery.storedOn};
    } catch (error) {
      console.error("[desktop] live recovery copy kept only its package:", error);
      return {copyPath: null, packagePath, storedOn: recovery.storedOn};
    }
  }
  throw new Error("dohc could not find a free name for the recovery copy. Rename older recovery copies, then try again.");
}
