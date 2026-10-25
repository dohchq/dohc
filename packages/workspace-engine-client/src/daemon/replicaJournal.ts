import type { AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, LiveObjectBinding, LiveUpdateReceipt } from "@dohc/live-session-contract";

export interface ReplicaRestoreAdmission {
  readonly proposalDigest: string;
  readonly candidateDigest: string;
  readonly preparation: {
    readonly fence: {
      readonly operation: {
        readonly operationId: string; readonly relayDatabaseNamespace: string;
        readonly oldBinding: LiveObjectBinding; readonly hostId: string; readonly newFence: number;
        readonly origin: {readonly kind: "bootstrap" | "owner"; readonly id: string};
        readonly terminal: LiveUpdateReceipt | null; readonly appliedSequence: number;
      };
      readonly localHeadSequence: number; readonly recordedAtMs: number;
    };
    readonly point: {readonly journalCursor: number; readonly receiptDigest: string; readonly markdownDigest: string; readonly projectionDigest: string};
  };
  readonly nativeSourceManifestDigest: string;
  readonly admitted: AdmittedLiveUpdateMetadata;
  readonly checkpointDigest: string;
  readonly sourceRanges: readonly {readonly sourceOrdinal: number; readonly clientId: number; readonly startClock: number; readonly endClock: number; readonly sourceDigest: string}[];
  readonly recordedAtMs: number;
}

/** The document's current lineage authority when the relay served the page. */
export interface ReplicaAuthority { readonly lineageClaimId: string; readonly baselineSequence: number; readonly restoreFenceGeneration: number }

export interface ReplicaJournalRow {
  readonly admitted: AdmittedLiveUpdate;
  readonly relayDatabaseNamespace: string;
  readonly evidenceDigest: string;
  readonly journalCursor: number;
  readonly authority: ReplicaAuthority | null;
  readonly restore: { readonly operationId: string; readonly checkpointDigest: string; readonly checkpointBytes: Uint8Array; readonly proof: ReplicaRestoreAdmission } | null;
}
/**
 * A restore the relay declined after the host's native fence committed. The journal keeps it at its own
 * cursor, between deliveries; it is no delivery and carries no bytes. `cancellation` is the host's
 * `fenceCancelled` receipt from `liveApplication.cancelRestoreFence`, unchanged. A replica at exactly the
 * fence's old generation and the receipt's endpoint advances its generation and nothing else. Before the
 * lineage's first accepted event that endpoint is event zero at the lineage's initial digest. The replica
 * keeps the record it applied; a replay at its cursor, of its operation or of its generation must be that
 * record. `authority` is the document's current authority, as rows carry it; the replica neither keeps nor
 * compares it. A lineage the replica held and no longer marks skips the record, and so does one the authority
 * retires as it would retire a row's; any other lineage it never saw blocks.
 */
export interface ReplicaRestoreCancellation {
  readonly relayDatabaseNamespace: string;
  readonly journalCursor: number;
  readonly cancellation: {
    readonly fence: ReplicaRestoreAdmission["preparation"]["fence"];
    readonly binding: LiveObjectBinding;
    readonly endpoint: {readonly terminalReceipt: LiveUpdateReceipt | null; readonly eventCount: number; readonly historyEvidenceDigest: string};
    readonly recordedAtMs: number;
  };
  readonly authority: ReplicaAuthority | null;
}
/** One entry of a replica page, in journal order. */
export type ReplicaJournalEntry = ReplicaJournalRow | ReplicaRestoreCancellation;
export interface ReplicaFrontiers { readonly revision: number; readonly logCursor: number; readonly journalCursor: number }
export interface ReplicaPageResult extends ReplicaFrontiers {
  readonly applied: number; readonly skipped: number; readonly blockedCursor: number | null;
}
export function replicaFrontiers(value: unknown): ReplicaFrontiers {
  const r = value as ReplicaFrontiers;
  if (!r || [r.revision, r.logCursor, r.journalCursor].some(n => !Number.isSafeInteger(n) || n < 0)) throw new TypeError("Invalid replica frontiers.");
  return { revision: r.revision, logCursor: r.logCursor, journalCursor: r.journalCursor };
}
export function replicaPageResult(value: unknown): ReplicaPageResult {
  const r = value as ReplicaPageResult, frontiers = replicaFrontiers(value);
  if (Object.keys(r).sort().join() !== "applied,blockedCursor,journalCursor,logCursor,revision,skipped" ||
    [r.applied, r.skipped].some(n => !Number.isSafeInteger(n) || n < 0 || n > 500) ||
    (r.blockedCursor !== null && (!Number.isSafeInteger(r.blockedCursor) || r.blockedCursor <= r.journalCursor))) throw new TypeError("Invalid replica page result.");
  return { ...frontiers, applied: r.applied, skipped: r.skipped, blockedCursor: r.blockedCursor };
}
/** Metadata, then each row's update and optional checkpoint, with u32 LE length prefixes. */
export function encodeReplicaJournalPage(rows: readonly ReplicaJournalRow[]): Buffer {
  if (rows.length > 500) throw new TypeError("Replica page exceeds row limit.");
  const fields = [Buffer.from(JSON.stringify(rows.map(r => ({ ...r, admitted: { metadata: r.admitted.metadata, updateBytes: [] },
    restore: r.restore ? { ...r.restore, checkpointBytes: [] } : null }))))];
  for (const r of rows) { fields.push(Buffer.from(r.admitted.updateBytes)); if (r.restore) fields.push(Buffer.from(r.restore.checkpointBytes)); }
  return Buffer.concat(fields.flatMap(bytes => {
    if (bytes.length > 0xffff_ffff) throw new TypeError("Replica span exceeds wire limit.");
    const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return [length, bytes];
  }));
}
