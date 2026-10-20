import {createHash} from "node:crypto";
import {isAsyncFunction} from "node:util/types";
import type {StorageContext} from "./context";
import type {SqliteDb, SyncRelayLogInput} from "./types";
import {accountIsFenced, workspaceIsDeleted} from "./accountDeletion";
import {readServiceHostEnrollment} from "./serviceHostEnrollment";
import {readServiceHostFeedScope} from "./serviceHostFeed";
import {stableJsonStringify} from "../canonicalJson";
import {FIRST_OPEN_ORIGIN_PREFIX} from "../relayLogInputs";
import {FIRST_OPEN_GUARD, firstOpenHead, firstOpenParameters, unknownWorkspace, type FirstOpenHistoryReader, type FirstOpenSource} from "./firstOpenHistory";

declare const proven: unique symbol;
/**
 * Storage's evidence that a source was eligible against its workspace log up to a cutoff.
 * Only storage makes one, from the history reader it was opened with, and a publication uses it once.
 */
export interface FirstOpenProof {readonly [proven]: true}
interface Prepared {
  /** The storage owner's lifetime; a reopened or replaced database has another. */
  readonly lifetime: AbortSignal;
  readonly source: FirstOpenSource;
  readonly identity: string;
  readonly cutoff: number | null;
}
const proofs = new WeakMap<FirstOpenProof, Prepared>();

export type FirstOpenPreparation =
  | {kind: "prepared"; proof: FirstOpenProof}
  | {kind: "refused"; reason: "prior-authority" | "deletion" | "stale-source"}
  | {kind: "busy"};
/** Where a first-open base sits in the relay log: always the first coordinate of its reserved origin. */
export interface FirstOpenReceipt {readonly originId: string; readonly originSeq: 0; readonly relaySeq: number}
export type FirstOpenWrite =
  | {kind: "published"; receipt: FirstOpenReceipt}
  /** The workspace log moved since preparation. Catch up outside the writer, then write again. */
  | {kind: "retry"}
  | {kind: "refused"; reason: "prior-authority" | "stale-source"}
  /** The source's reserved origin already holds rows. */
  | {kind: "occupied"};
/** The bytes a publication commits, and the trusted coordinates they are bound to. */
export interface FirstOpenBase {
  /** The relay database namespace. */
  readonly namespace: string;
  readonly bytes: Uint8Array;
  /** The source moment's timestamp. */
  readonly recordedAtMs: number;
}
/** What a publisher commits: the blob, then the one base row at its reserved coordinate. */
export interface FirstOpenPublication {
  readonly source: FirstOpenSource;
  readonly originId: string;
  readonly op: SyncRelayLogInput;
  readonly blob: {readonly sha256: string; readonly content: Uint8Array};
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/**
 * The origin only the relay writes a source's first live base under. A JSON
 * array of strings is one unambiguous ordered encoding of the source's identity.
 */
export function firstOpenOrigin(namespace: string, source: FirstOpenSource, identity: {replicationEpoch: string; streamIdentity: string}): string {
  return FIRST_OPEN_ORIGIN_PREFIX + sha256(JSON.stringify(["dohc-first-open-v1", namespace, source.workspaceId, "main", source.objectId,
    identity.replicationEpoch, identity.streamIdentity, source.path, source.sourceMomentId, source.sourceDigest]));
}

/** An ordinary base with no author: the ordinary write that made the source keeps its own. */
export function firstOpenBasePayload(source: FirstOpenSource, updateBlobSha256: string): string {
  return stableJsonStringify({versionId: "main", objectId: source.objectId, path: source.path, contentKind: "richdoc",
    updateBlobSha256, lineageClaimId: updateBlobSha256, isBaseState: true});
}

/** One main moment of an object, as the relay projected it. */
export interface FirstOpenMoment {
  readonly sourceMomentId: string;
  readonly path: string | null;
  readonly sourceDigest: string | null;
  readonly contentKind: string | null;
  readonly sourceByteLength: number | null;
  readonly recordedAtMs: number;
}

/** The object's latest main moment, or the main moment named `momentId`. */
export function readFirstOpenMoment(storage: StorageContext, workspaceId: string, objectId: string, momentId?: string): FirstOpenMoment | null {
  const row = momentId === undefined
    ? storage.db.prepare(`SELECT moment_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms FROM sync_relay_object_moments INDEXED BY idx_sync_relay_object_moments_latest
      WHERE workspace_id=? AND version_id='main' AND object_id=? ORDER BY relay_seq DESC LIMIT 1`).get(workspaceId, objectId)
    : storage.db.prepare(`SELECT moment_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms FROM sync_relay_object_moments
      WHERE workspace_id=? AND object_id=? AND version_id='main' AND moment_id=? ORDER BY relay_seq LIMIT 1`).get(workspaceId, objectId, momentId);
  const text = (value: unknown) => typeof value === "string" ? value : null;
  return row ? Object.freeze({sourceMomentId: String(row.moment_id), path: text(row.path), sourceDigest: text(row.blob_sha256), contentKind: text(row.content_kind),
    sourceByteLength: typeof row.byte_length === "number" ? row.byte_length : null, recordedAtMs: Number(row.recorded_at_ms)}) : null;
}

export type FirstOpenStoredReceipt =
  | {kind: "absent"}
  | {kind: "receipt"; receipt: FirstOpenReceipt; updateBlobSha256: string}
  /** Anything but exactly one accepted first-open base for the source, recorded at `recordedAtMs`, with its bytes. */
  | {kind: "occupied"};

/** What the source's reserved origin holds. Never rewrites it. */
export function readFirstOpenReceipt(storage: StorageContext, originId: string, source: FirstOpenSource, recordedAtMs: number): FirstOpenStoredReceipt {
  const rows = storage.db.prepare(`SELECT origin_seq,relay_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json,settlement_admission_json,relay_admission
    FROM sync_relay_log WHERE workspace_id=? AND origin_id=? ORDER BY origin_seq LIMIT 2`).all(source.workspaceId, originId);
  if (!rows.length) return {kind: "absent"};
  const [row] = rows;
  if (rows.length > 1 || row!.origin_seq !== 0 || row!.op_kind !== "ydoc.update" || row!.recorded_at_ms !== recordedAtMs ||
    row!.admitted_author_snapshot_json !== null || row!.settlement_admission_json !== null || row!.relay_admission !== null) return {kind: "occupied"};
  let digest: unknown;
  try { digest = (JSON.parse(String(row!.payload_json)) as {updateBlobSha256?: unknown}).updateBlobSha256; } catch { return {kind: "occupied"}; }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || row!.payload_json !== firstOpenBasePayload(source, digest) ||
    !storage.db.prepare("SELECT 1 FROM sync_relay_blobs WHERE workspace_id=? AND sha256=? AND byte_length=length(content)").get(source.workspaceId, digest)) {
    return {kind: "occupied"};
  }
  return {kind: "receipt", receipt: Object.freeze({originId, originSeq: 0, relaySeq: Number(row!.relay_seq)}), updateBlobSha256: digest};
}

/**
 * The enrolled document at `path` while the service host may start it live:
 * enabled, not retired, paused or stopped, still at its enrolled path, covered
 * by an active Edit grant now, in an open workspace of an unfenced owner.
 * Null otherwise. Safe both on the request path and inside the writer.
 */
export function readFirstOpenStanding(storage: StorageContext, input: {workspaceId: string; ownerUserId: string; path: string}): string | null {
  if (workspaceIsDeleted(storage, input.workspaceId) || accountIsFenced(storage, input.ownerUserId)) return null;
  const enrollment = readServiceHostEnrollment(storage, input.workspaceId, input.path);
  if (!enrollment || enrollment.ownerUserId !== input.ownerUserId || !enrollment.enabled || enrollment.retired || enrollment.ownerStop !== null) return null;
  if (storage.objectIdAtPathInVersion({workspaceId: input.workspaceId, versionId: "main", path: input.path}) !== enrollment.objectId) return null;
  // Settlement authority outlives the grant; starting a document needs Edit coverage now.
  return readServiceHostFeedScope(storage, input.workspaceId)?.shared.get(enrollment.objectId) === input.path ? enrollment.objectId : null;
}

function prepared(storage: StorageContext, proof: FirstOpenProof): Prepared {
  const state = proofs.get(proof);
  if (!state || state.lifetime !== storage.unavailable) throw new Error("This first-open preparation was used or belongs to another relay storage.");
  return state;
}

async function readHistory(storage: StorageContext, source: FirstOpenSource, previous: Prepared | null,
  read: FirstOpenHistoryReader, signal?: AbortSignal): Promise<FirstOpenPreparation> {
  const lifetime = storage.unavailable, cancelled = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
  storage.captureStanding();
  cancelled.throwIfAborted();
  const history = await read({...source, database: storage.databasePath, afterRelaySeq: previous?.cutoff ?? 0}, cancelled);
  storage.captureStanding();
  // A read that finished just before cancellation still prepares nothing.
  cancelled.throwIfAborted();
  if (history.kind === "busy") return history;
  if (history.eligibility !== "eligible") return {kind: "refused", reason: history.eligibility};
  if (!history.current || (previous && history.identity !== previous.identity)) return {kind: "refused", reason: "stale-source"};
  const proof = Object.freeze({}) as FirstOpenProof;
  proofs.set(proof, Object.freeze({lifetime, source, identity: history.identity, cutoff: history.head}));
  return {kind: "prepared", proof};
}

/** Reads the whole history off the writer. A reader failure rejects; it never prepares. */
export function prepareFirstOpen(storage: StorageContext, source: FirstOpenSource, read: FirstOpenHistoryReader, signal?: AbortSignal) {
  const {workspaceId, objectId, path, sourceMomentId, sourceDigest, sourceByteLength} = source;
  return readHistory(storage, Object.freeze({workspaceId, objectId, path, sourceMomentId, sourceDigest, sourceByteLength}), null, read, signal);
}

/** Reads only the rows after the proof's cutoff, and moves the cutoff to this read's head. */
export async function catchUpFirstOpen(storage: StorageContext, proof: FirstOpenProof, read: FirstOpenHistoryReader, signal?: AbortSignal) {
  const state = prepared(storage, proof);
  return readHistory(storage, state.source, state, read, signal);
}

const guards = new WeakMap<SqliteDb, ReturnType<SqliteDb["prepare"]>>();
const asynchronous = () => new TypeError("First-open publication must be synchronous.");
const notPublished = () => new Error("First-open publication did not write its proven base.");

/**
 * Publishes the proven source's base in the writer only while the proof still
 * holds; otherwise appends nothing. A workspace closed by account deletion is
 * one the relay no longer holds. Commits only when the publisher wrote exactly
 * the base row at its reserved coordinate, with its bytes, and nothing else.
 * Never retries itself.
 */
export function writeFirstOpen(storage: StorageContext, proof: FirstOpenProof, base: FirstOpenBase,
  publish: (publication: FirstOpenPublication) => void): FirstOpenWrite {
  // The transaction would commit before an asynchronous publication settled.
  if (isAsyncFunction(publish)) throw asynchronous();
  const state = prepared(storage, proof), {source} = state;
  const written = storage.tx((): FirstOpenWrite => {
    let guard = guards.get(storage.db);
    if (!guard) guards.set(storage.db, guard = storage.db.prepare(FIRST_OPEN_GUARD));
    const row = guard.get(...firstOpenParameters(source, 0));
    // Account deletion keeps a closed workspace's rows until purge.
    if (!row || workspaceIsDeleted(storage, source.workspaceId) || accountIsFenced(storage, String(row.owner))) throw unknownWorkspace();
    if (row.authority === 1) return {kind: "refused", reason: "prior-authority"};
    if (row.current !== 1 || row.identity !== state.identity) return {kind: "refused", reason: "stale-source"};
    if (firstOpenHead(row) !== state.cutoff) return {kind: "retry"};
    const [, replicationEpoch, streamIdentity] = JSON.parse(state.identity) as [string, string, string];
    const originId = firstOpenOrigin(base.namespace, source, {replicationEpoch, streamIdentity});
    if (storage.maxOriginSeq(source.workspaceId, originId) >= 0) return {kind: "occupied"};
    if (readFirstOpenMoment(storage, source.workspaceId, source.objectId)?.recordedAtMs !== base.recordedAtMs) {
      throw new Error("A first-open base takes its source moment's timestamp.");
    }
    const content = new Uint8Array(base.bytes), digest = sha256(content);
    const result: unknown = publish(Object.freeze({source, originId,
      op: Object.freeze({originSeq: 0, opKind: "ydoc.update", payloadJson: firstOpenBasePayload(source, digest), recordedAtMs: base.recordedAtMs}),
      blob: Object.freeze({sha256: digest, content})}));
    if (result !== null && (typeof result === "object" || typeof result === "function") &&
      typeof (result as {then?: unknown}).then === "function") throw asynchronous();
    // The proven document's base, and the only row this transaction appended.
    const stored = readFirstOpenReceipt(storage, originId, source, base.recordedAtMs);
    const appended = storage.db.prepare("SELECT count(*) AS n FROM sync_relay_log WHERE workspace_id=? AND relay_seq>?").get(source.workspaceId, state.cutoff ?? 0);
    if (stored.kind !== "receipt" || stored.updateBlobSha256 !== digest || appended?.n !== 1) throw notPublished();
    return {kind: "published", receipt: stored.receipt};
  });
  if (written.kind === "published") proofs.delete(proof);
  return written;
}
