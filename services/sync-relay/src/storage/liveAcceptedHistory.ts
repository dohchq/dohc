import { isDeepStrictEqual } from "node:util";
import {
  parseLiveUpdateDigest,
  type AdmittedLiveUpdate,
  type LiveDocumentKey,
  type LiveUpdateReceipt,
} from "@dohc/live-session-contract/live-update-admission";
import {
  canonicalVersionedAcceptedMetadata,
  nextVersionedAcceptedHistoryDigest,
} from "../liveAcceptedHistory";
import type { StorageContext } from "./context";
import { authorityInteger } from "./liveDocumentAuthority";
import {
  assertJournalCheckpointPosition,
  decodeJournalMetadata,
  decodeJournalRow,
  documentParams,
  verifyJournalHistoryMetadata,
  verifyJournalHistoryRow,
  verifyJournalRow,
} from "./liveUpdateJournal";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { LIVE_JOURNAL_TABLE, LIVE_JOURNAL_PROVENANCE } from "./schema";

const documentWhere = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
function require(value: unknown): asserts value {
  if (!value) throw new Error("Accepted journal history is damaged.");
}

export class RestoreHistoryBudgetExceeded extends Error {}

export class RestoreHistoryBudget {
  bytes: number;
  events: number;
  constructor(maxBytes: number, maxEvents: number) {
    this.bytes = authorityInteger(maxBytes);
    this.events = authorityInteger(maxEvents);
  }
  chargeBytes(value: number) {
    const n = authorityInteger(value);
    if (n > this.bytes)
      throw new RestoreHistoryBudgetExceeded("Restore history exceeds configured byte bounds.");
    this.bytes -= n;
  }
  chargeEvents(value: number) {
    const n = authorityInteger(value);
    if (n > this.events)
      throw new RestoreHistoryBudgetExceeded("Restore history exceeds configured event bounds.");
    this.events -= n;
  }
}

const metadataColumns =
  "journal_cursor,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,delivery_id,update_digest,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,restore_operation_id,validation_checkpoint_sha256,canonical_version,author_context_json,author_snapshot_json,first_seen_deletes_json,checkpoint_coverage_json,seed_first_seen_json";
// Actual stored string lengths, independent of the cached accepted_metadata_bytes.
const metadataLengths = [
  "relay_database_namespace",
  "workspace_id",
  "main_version_id",
  "object_id",
  "lineage_claim_id",
  "current_path",
  "selector_paths_json",
  "delivery_id",
  "update_digest",
  "principal_kind",
  "principal_id",
  "grant_id",
  "accepted_evidence_digest",
  "restore_operation_id",
  "validation_checkpoint_sha256",
  "author_context_json",
  "author_snapshot_json",
  "first_seen_deletes_json",
  "checkpoint_coverage_json",
  "seed_first_seen_json",
]
  .map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`)
  .join("+");
const provenanceLengths =
  "length(CAST(workspace_id AS BLOB))+length(CAST(main_version_id AS BLOB))+length(CAST(object_id AS BLOB))+length(CAST(lineage_claim_id AS BLOB))+8*4";
function chargeStoredMetadata(
  storage: StorageContext,
  where: string,
  params: unknown[],
  budget: RestoreHistoryBudget,
) {
  const metadata = storage.db
    .prepare(
      `SELECT COALESCE(SUM(${metadataLengths}+8*8),0) AS bytes FROM ${LIVE_JOURNAL_TABLE} WHERE ${where}`,
    )
    .get(...params)!;
  const provenance = storage.db
    .prepare(`SELECT COALESCE(SUM(${provenanceLengths}),0) AS bytes FROM ${LIVE_JOURNAL_PROVENANCE}
    WHERE journal_cursor IN (SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${where})`)
    .get(...params)!;
  budget.chargeBytes(authorityInteger(metadata.bytes) + authorityInteger(provenance.bytes));
}
function boundedMetadata(
  storage: StorageContext,
  document: LiveDocumentKey,
  cursor: number,
  budget: RestoreHistoryBudget,
) {
  const params = documentParams(document);
  const header = storage.db
    .prepare(`SELECT ${metadataLengths}+8*8 AS bytes FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor=?`)
    .get(...params, cursor);
  require(header);
  const provenance = storage.db
    .prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(workspace_id AS BLOB))+length(CAST(main_version_id AS BLOB))+
    length(CAST(object_id AS BLOB))+length(CAST(lineage_claim_id AS BLOB))+8*4),0) AS bytes FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor=?`)
    .get(cursor)!;
  budget.chargeBytes(authorityInteger(header.bytes, 1) + authorityInteger(provenance.bytes));
  const raw = storage.db
    .prepare(
      `SELECT ${metadataColumns} FROM ${LIVE_JOURNAL_TABLE} WHERE ${documentWhere} AND journal_cursor=?`,
    )
    .get(...params, cursor)!;
  const ranges = storage.db
    .prepare(
      `SELECT * FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor=? ORDER BY client_id,start_clock`,
    )
    .all(cursor);
  require(ranges.length === provenance.count);
  const metadata = canonicalVersionedAcceptedMetadata(
    decodeJournalMetadata(storage.db, raw, ranges),
  );
  require(raw.accepted_metadata_bytes === Buffer.byteLength(JSON.stringify(metadata)));
  return { raw, metadata };
}

/** Metadata lookup for native-source association; does not load historical update/checkpoint blobs. */
export function readAcceptedHistoryDeliveryMetadata(
  storage: StorageContext,
  input: HistoryDeliveryInput,
  budget: RestoreHistoryBudget,
) {
  const header = storage.db
    .prepare(
      `SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=? AND ${documentWhere}`,
    )
    .get(input.deliveryId, ...documentParams(input.document));
  if (!header) return null;
  budget.chargeEvents(1);
  const { raw, metadata } = boundedMetadata(
    storage,
    input.document,
    authorityInteger(header.journal_cursor, 1),
    budget,
  );
  const history = {
    namespace: parseLiveUpdateIdentifier(raw.relay_database_namespace),
    eventCount: authorityInteger(raw.accepted_event_count, 1),
    evidenceDigest: parseLiveUpdateDigest(raw.accepted_evidence_digest),
    metadataBytes: authorityInteger(raw.accepted_metadata_bytes, 1),
  };
  require(
    history.namespace === input.namespace &&
      metadata.accepted.receipt.journalCursor <= input.through &&
      history.eventCount <= input.eventCount,
  );
  verifyJournalHistoryMetadata(storage.db, metadata, history);
  return metadata;
}

type HistoryEndpoint = {
  eventCount: number;
  terminal: LiveUpdateReceipt | null;
  evidenceDigest: string;
};
/** Complete metadata between authenticated cuts, including events folded into checkpoints. */
export function readAcceptedHistoryInterval(
  storage: StorageContext,
  input: {
    document: LiveDocumentKey;
    namespace: string;
    selected: HistoryEndpoint;
    accepted: HistoryEndpoint;
  },
  budget: RestoreHistoryBudget,
) {
  const { document, namespace, selected, accepted } = input,
    params = documentParams(document);
  const from = selected.terminal?.journalCursor ?? 0,
    through = accepted.terminal?.journalCursor ?? 0;
  const count = authorityInteger(accepted.eventCount - selected.eventCount);
  require(from <= through);
  const actual = storage.db
    .prepare(`SELECT COUNT(*) AS count FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor>? AND journal_cursor<=?`)
    .get(...params, from, through)!;
  require(actual.count === count);
  budget.chargeEvents(count);
  let cursor = from,
    eventCount = selected.eventCount,
    evidenceDigest = selected.evidenceDigest,
    terminal = selected.terminal;
  const preceding =
    from === 0
      ? null
      : storage.db
          .prepare(`SELECT canonical_version FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor=?`)
          .get(...params, from);
  require(from === 0 || preceding);
  let canonicalVersion = preceding?.canonical_version ?? 1;
  require(canonicalVersion === 1 || canonicalVersion === 2);
  const events: { metadata: AdmittedLiveUpdate["metadata"] }[] = [];
  for (let index = 0; index < count; index++) {
    const header = storage.db
      .prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE}
      WHERE ${documentWhere} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 1`)
      .get(...params, cursor, through);
    require(header);
    const next = authorityInteger(header.journal_cursor, 1);
    const { raw, metadata } = boundedMetadata(storage, document, next, budget);
    require(canonicalVersion !== 2 || metadata.canonicalVersion === 2);
    canonicalVersion = metadata.canonicalVersion ?? 1;
    require(raw.relay_database_namespace === namespace);
    require(raw.restore_operation_id === null);
    if (raw.validation_checkpoint_sha256 !== null)
      assertJournalCheckpointPosition(storage.db, {
        admitted: { metadata },
        history: { namespace },
        checkpoint: { digest: parseLiveUpdateDigest(raw.validation_checkpoint_sha256) },
      });
    evidenceDigest = nextVersionedAcceptedHistoryDigest(evidenceDigest, ++eventCount, metadata);
    require(
      raw.accepted_event_count === eventCount && raw.accepted_evidence_digest === evidenceDigest,
    );
    terminal = metadata.accepted.receipt;
    cursor = terminal.journalCursor;
    events.push({ metadata });
  }
  require(
    eventCount === accepted.eventCount &&
      evidenceDigest === accepted.evidenceDigest &&
      isDeepStrictEqual(terminal, accepted.terminal),
  );
  return events;
}

type HistoryDeliveryInput = {
  document: LiveDocumentKey;
  namespace: string;
  through: number;
  eventCount: number;
  deliveryId: string;
};
export function readAcceptedHistoryDelivery(
  storage: StorageContext,
  input: HistoryDeliveryInput,
  budget: RestoreHistoryBudget,
) {
  const header = storage.db
    .prepare(`SELECT length(update_bytes) AS bytes,COALESCE(length(validation_checkpoint_bytes),0) AS checkpoint_bytes,
    accepted_metadata_bytes FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=? AND ${documentWhere}`)
    .get(input.deliveryId, ...documentParams(input.document));
  if (!header) return null;
  budget.chargeBytes(authorityInteger(header.bytes, 1) + authorityInteger(header.checkpoint_bytes));
  chargeStoredMetadata(
    storage,
    `delivery_id=? AND ${documentWhere}`,
    [input.deliveryId, ...documentParams(input.document)],
    budget,
  );
  const raw = storage.db
    .prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=? AND ${documentWhere}`)
    .get(input.deliveryId, ...documentParams(input.document))!;
  const row = decodeJournalRow(storage.db, raw);
  verifyJournalRow(row);
  verifyJournalHistoryRow(storage.db, row);
  const { binding, receipt } = row.admitted.metadata.accepted;
  require(
    isDeepStrictEqual(documentParams(binding), documentParams(input.document)) &&
      row.history.namespace === input.namespace &&
      receipt.journalCursor <= input.through &&
      row.history.eventCount <= input.eventCount,
  );
  return canonicalVersionedAcceptedMetadata(row.admitted.metadata);
}
