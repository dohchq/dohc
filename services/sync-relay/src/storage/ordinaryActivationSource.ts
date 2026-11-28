import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NativeOwnerActivationSource } from "@dohc/workspace-engine-client/daemon";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveDocumentBaselineRegistrationInput, SqliteDb } from "./types";
import type { StorageContext } from "./context";
import { ORDINARY_ACTIVATION_BASES, beginsLineage } from "./ordinaryActivationBasis";
import { ServerLogError } from "../serverLogWords";
import { parseConflictResolve } from "../conflictResolve";
import type { OrdinaryActivationBaseline } from "./ordinaryActivationValidation";

export class ServiceActivationStaleCut extends Error {
  constructor() {
    super("Ordinary replication advanced before service activation.");
  }
}
/** The note's last lineage is still retiring, restoring, saving room edits or paused. A later pass captures it again. */
export class ServiceActivationLineageEnding extends ServiceActivationStaleCut {
  constructor() {
    super();
    this.message = "The note's last live session is still ending.";
  }
}
/** Live validation had no slot free for the capture. A later pass captures it again. */
export class ServiceActivationBusy extends Error {
  constructor() {
    super("Live validation is busy.");
  }
}
/** Validating the capture ran its validation process out of memory, as the same capture would again. */
export class ServiceActivationTooLarge extends Error {
  constructor() {
    super("Native activation is too large to validate.");
  }
}
export interface OrdinaryActivationBounds {
  maxCaptureBytes: number;
  maxBytesPerDrain: number;
}
export interface VerifiedOrdinaryActivationCut {
  readonly verified: true;
}
const cuts = new WeakMap<
  VerifiedOrdinaryActivationCut,
  {
    storage: StorageContext;
    source: NativeOwnerActivationSource;
    baseRelaySeq: number;
    baseline: LiveDocumentBaselineRegistrationInput["evidence"];
  }
>();
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
// Each message is a fixed sentence, so the server log shows it whole.
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new ServerLogError(message);
}
/** The log position of the row that began the source's lineage. */
export function sourceBaseRelaySeq(db: SqliteDb, source: NativeOwnerActivationSource) {
  if (source.baseRelaySeq !== null) return source.baseRelaySeq;
  const row = db
    .prepare(
      "SELECT relay_seq FROM sync_relay_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
    )
    .get(source.workspaceId, source.baseOriginId, source.baseOriginSeq);
  return typeof row?.relay_seq === "number" ? row.relay_seq : null;
}
function currentCut(storage: StorageContext, source: NativeOwnerActivationSource): number {
  const current = storage.db
    .prepare(
      "SELECT replication_epoch,stream_identity FROM sync_relay_workspaces WHERE workspace_id=?",
    )
    .get(source.workspaceId);
  const high = storage.db
    .prepare("SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?")
    .get(source.workspaceId);
  const base = sourceBaseRelaySeq(storage.db, source);
  if (
    current?.replication_epoch !== source.replicationEpoch ||
    current.stream_identity !== source.streamIdentity ||
    high?.cursor !== source.committedCursor ||
    base === null ||
    base > source.committedCursor ||
    base <= storage.getEpochLogFloor(source.workspaceId)
  )
    throw new ServiceActivationStaleCut();
  return base;
}
/**
 * Accepts a validated capture in the transaction that registers it. The capture stands when the relay's cursor, epoch
 * and stream are the ones it was taken at, and the row at its base position began this lineage, as its base state or
 * as the conflict resolve that installed it, at the capture's origin coordinates, with the baseline's bytes. That row
 * may name a path the note has since left; registration checks where the note is now.
 * Anything else refuses it, so the transaction never registers evidence for another cut.
 */
export function verifyOrdinaryActivationCut(
  storage: StorageContext,
  input: {
    source: NativeOwnerActivationSource;
    document: LiveDocumentKey;
    baselineBytes: Uint8Array;
    baseline: OrdinaryActivationBaseline;
  },
): VerifiedOrdinaryActivationCut {
  const { source, document, baselineBytes, baseline } = input;
  const baseRelaySeq = currentCut(storage, source);
  const base = storage.db
    .prepare(
      "SELECT origin_id,origin_seq,op_kind,payload_json,settlement_admission_json FROM sync_relay_log WHERE workspace_id=? AND relay_seq=?",
    )
    .get(document.workspaceId, baseRelaySeq);
  requireValue(
    base && typeof base.payload_json === "string",
    "Ordinary activation base history is unavailable.",
  );
  const admission =
    typeof base.settlement_admission_json === "string"
      ? (JSON.parse(base.settlement_admission_json) as { status?: unknown } | null)
      : null;
  requireValue(admission?.status !== "refused", "Ordinary activation base history is unavailable.");
  requireValue(
    base.origin_id === source.baseOriginId &&
      base.origin_seq === source.baseOriginSeq &&
      beginsLineage(base.op_kind, base.payload_json, document, baseline.lineageEpoch),
    "Native activation base coordinate differs from ordinary history.",
  );
  requireValue(
    storage.db
      .prepare(
        "SELECT content=? AS matches FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?",
      )
      .get(baselineBytes, document.workspaceId, document.lineageClaimId)?.matches === 1,
    "Ordinary activation base bytes differ.",
  );
  const evidence = {
    version: 1 as const,
    document: structuredClone(document),
    currentPath: source.currentPath,
    checkpoint: {
      updateDigest: baseline.checkpoint.updateDigest,
      ranges: baseline.checkpoint.ranges.map((row) => ({ ...row })),
    },
    projectedMarkdownSha256: baseline.projectedMarkdownSha256,
    projectedMarkdownByteLength: baseline.projectedMarkdownByteLength,
  };
  const cut = Object.freeze({ verified: true as const });
  cuts.set(cut, { storage, source: structuredClone(source), baseRelaySeq, baseline: evidence });
  return cut;
}
export function ordinaryActivationBaseline(
  storage: StorageContext,
  input: LiveDocumentBaselineRegistrationInput,
  cut: VerifiedOrdinaryActivationCut,
) {
  const held = cuts.get(cut);
  requireValue(held && held.storage === storage, "Ordinary activation source was not verified.");
  currentCut(storage, held.source);
  requireValue(
    isDeepStrictEqual(input.evidence, held.baseline) &&
      hash(input.baselineBytes) === held.source.lineageClaimId,
    "Ordinary activation baseline differs from its verified source.",
  );
  return {
    relay_seq: held.baseRelaySeq,
    blob_sha256: held.baseline.projectedMarkdownSha256,
    byte_length: held.baseline.projectedMarkdownByteLength,
  };
}
export function ordinaryActivationResolves(
  storage: StorageContext,
  cut: VerifiedOrdinaryActivationCut,
  current: { lineageClaimId: string; baselineSequence: number },
): boolean {
  const held = cuts.get(cut);
  requireValue(held && held.storage === storage, "Ordinary activation source was not verified.");
  const { source } = held;
  const resolves = storage.db
    .prepare(
      `SELECT relay_seq,payload_json,recorded_at_ms,settlement_admission_json FROM sync_relay_log
       WHERE workspace_id=? AND relay_seq>? AND relay_seq<=? AND op_kind='conflict.resolve' AND relay_admission IS NULL
       ORDER BY relay_seq DESC`,
    )
    .all(source.workspaceId, current.baselineSequence, held.baseRelaySeq);
  let claim = source.lineageClaimId;
  for (const row of resolves) {
    if (row.relay_seq !== held.baseRelaySeq && claim === source.lineageClaimId) return false;
    const admission = row.settlement_admission_json;
    if (admission !== null && JSON.parse(String(admission)).status === "refused") continue;
    const resolve = parseConflictResolve(String(row.payload_json), {
      workspaceId: source.workspaceId,
      recordedAtMs: Number(row.recorded_at_ms),
    });
    const transition = resolve.lineageTransition;
    if (
      !transition ||
      !resolve.current.present ||
      resolve.targetVersionId !== source.mainVersionId ||
      resolve.current.objectId !== source.objectId ||
      transition.successor?.lineageClaimId !== claim
    )
      continue;
    claim = transition.predecessorClaimId;
    if (claim === current.lineageClaimId) return true;
  }
  return false;
}
function basisValues(
  storage: StorageContext,
  input: LiveDocumentBaselineRegistrationInput,
  cut: VerifiedOrdinaryActivationCut,
) {
  ordinaryActivationBaseline(storage, input, cut);
  const { source, baseRelaySeq, baseline } = cuts.get(cut)!;
  return [
    source.workspaceId,
    source.mainVersionId,
    source.objectId,
    source.lineageClaimId,
    baseRelaySeq,
    source.baseOriginId,
    source.baseOriginSeq,
    source.replicationEpoch,
    source.streamIdentity,
    source.currentPath,
    baseline.projectedMarkdownSha256,
    baseline.projectedMarkdownByteLength,
  ];
}
export function ordinaryActivationBasisCharge(
  storage: StorageContext,
  input: LiveDocumentBaselineRegistrationInput,
  cut: VerifiedOrdinaryActivationCut,
) {
  return Buffer.byteLength(JSON.stringify(basisValues(storage, input, cut)));
}
export function persistOrdinaryActivationBasis(
  storage: StorageContext,
  input: LiveDocumentBaselineRegistrationInput,
  cut: VerifiedOrdinaryActivationCut,
) {
  const values = basisValues(storage, input, cut),
    charge = Buffer.byteLength(JSON.stringify(values));
  storage.db
    .prepare(`INSERT INTO ${ORDINARY_ACTIVATION_BASES} (workspace_id,main_version_id,object_id,lineage_claim_id,base_relay_seq,base_origin_id,base_origin_seq,
    replication_epoch,stream_identity,current_path,projected_sha256,projected_byte_length,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...values, charge);
}
