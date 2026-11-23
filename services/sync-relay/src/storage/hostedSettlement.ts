import { clientMomentAuthorsRefused, isOwnerLogOrigin } from "../relayLogInputs";
import {
  parseHostControlIdentifier,
  parseHostEpoch,
} from "@dohc/live-session-contract/host-control";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "@dohc/live-session-contract/live-object-binding";
import {
  liveAuthorIdentity,
  parseLiveAuthorSnapshot,
  MAX_LIVE_AUTHOR_BYTES,
  MAX_LIVE_AUTHOR_IDENTITIES,
  type LiveAuthorSnapshot,
  type LiveAuthorEntry,
} from "@dohc/live-session-contract/live-authorship";
import {
  type LiveDocumentKey,
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
} from "@dohc/live-session-contract/live-update-admission";
import { stableJsonStringify } from "../canonicalJson";
import { liveValidation } from "../liveValidation";
import { relayError } from "../errors";
import { initialAcceptedHistoryDigest } from "../liveAcceptedHistory";
import {
  readAcceptedHistoryInterval,
  readAcceptedHistoryDeliveryMetadata,
  RestoreHistoryBudget,
  RestoreHistoryBudgetExceeded,
} from "./liveAcceptedHistory";
import { liveJournalHistoryNamespace } from "./liveJournalHistory";
import { documentParams } from "./liveUpdateJournal";
import { assertWorkspaceQuota } from "./workspaces";
import { SETTLEMENT_BINDINGS, SETTLEMENT_CUTS } from "./hostedSettlementSchema";
import type { StorageContext } from "./context";
import { liveContentAuthors } from "./liveAuthorWindow";
import type { SyncRelayLogInput } from "./types";
export const SETTLEMENT_PUSH_MAX_BYTES = 64_000_000;
export const SETTLEMENT_PUSH_MAX_METADATA_EVENTS = 65_536;
const MAX_SETTLEMENT_STATE_BYTES = 20_971_520;
const where = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
/** A failed proof check. `check` names it in the relay's log; the admission keeps one reason. */
class SettlementProofRefusal extends Error {
  constructor(readonly check: string) {
    super(`Settlement proof check ${check} failed.`);
  }
}
function require(value: unknown, check: string): asserts value {
  if (!value) throw new SettlementProofRefusal(check);
}
// A proof this push's budget could not finish. A larger budget may prove it.
class SettlementProofExhausted extends SettlementProofRefusal {}
function digest(value: unknown) {
  try {
    return parseLiveUpdateDigest(value);
  } catch {
    throw new SettlementProofRefusal("state-blob-digest");
  }
}
export function settlementResponseIdentifier(value: unknown) {
  try {
    return parseLiveUpdateIdentifier(value);
  } catch {
    return "unavailable";
  }
}
const integer = (value: unknown, check: string) => {
  require(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, check);
  return value;
};
const bag = (value: unknown, check: string) => {
  require(value && typeof value === "object" && !Array.isArray(value), check);
  return value as Record<string, unknown>;
};
const exact = (value: unknown, fields: readonly string[], check: string) => {
  const record = bag(value, check);
  require(Object.keys(record).length === fields.length &&
    fields.every((field) => Object.hasOwn(record, field)), check);
  return record;
};
// Native `SettlementRecord` and `ApplicationHostCoordinate` (`settlement_record.rs`), with no optional field.
const SETTLEMENT_RECORD_FIELDS = [
  "settlementId",
  "relayDatabaseNamespace",
  "binding",
  "hostCoordinate",
  "previousCursor",
  "terminalCursor",
  "previousYdocSequence",
  "localYdocSequence",
  "applicationCount",
  "nativeIntervalDigest",
  "acceptedEventCount",
  "acceptedIntervalDigest",
  "momentId",
  "markdownDigest",
  "sourceStateVectorDigest",
  "acceptedStateBlobSha256",
  "recordedAtMs",
  "restoreOperationId",
];
const HOST_COORDINATE_FIELDS = ["hostId", "hostEpoch", "instanceId", "connectionId"];
const BINDING_FIELDS = [
  "workspaceId",
  "mainVersionId",
  "objectId",
  "lineageClaimId",
  "currentPath",
  "selectorPaths",
  "restoreFenceGeneration",
];
const inOrder = (value: unknown, fields: readonly string[]) =>
  Object.fromEntries(fields.map((field) => [field, bag(value, "native-record")[field]]));
/** The settlement ID native derives from a record's identity fields, with the binding in its native field order. */
export function nativeSettlementId(record: Record<string, unknown>): string {
  return `live-settlement-${hash(
    JSON.stringify([
      record.relayDatabaseNamespace,
      inOrder(record.binding, BINDING_FIELDS),
      record.previousCursor,
      record.terminalCursor,
      record.previousYdocSequence,
      record.localYdocSequence,
      record.nativeIntervalDigest,
      record.momentId,
      record.markdownDigest,
      record.sourceStateVectorDigest,
    ]),
  )}`;
}
/** Native hashes the record as a `serde_json::Value`, whose objects sort their keys. */
export function settlementRecordDigest(record: Record<string, unknown>): string {
  return hash(stableJsonStringify(record));
}
/** What native validation requires of a settlement record before its interval is read. */
function nativeSettlementRecord(record: Record<string, unknown>): LiveObjectBinding {
  exact(record, SETTLEMENT_RECORD_FIELDS, "native-record");
  const host = exact(record.hostCoordinate, HOST_COORDINATE_FIELDS, "native-record");
  let binding: LiveObjectBinding;
  try {
    binding = parseLiveObjectBinding(record.binding);
  } catch {
    throw new SettlementProofRefusal("record-binding");
  }
  require(isDeepStrictEqual(binding, record.binding), "record-binding");
  try {
    for (const value of [
      record.relayDatabaseNamespace,
      host.hostId,
      host.instanceId,
      host.connectionId,
    ])
      parseHostControlIdentifier(value);
    parseHostEpoch(host.hostEpoch);
    parseLiveUpdateIdentifier(record.momentId);
    if (record.restoreOperationId !== null) parseLiveUpdateIdentifier(record.restoreOperationId);
    for (const value of [
      record.nativeIntervalDigest,
      record.acceptedIntervalDigest,
      record.markdownDigest,
      record.sourceStateVectorDigest,
      record.acceptedStateBlobSha256,
    ])
      parseLiveUpdateDigest(value);
  } catch {
    throw new SettlementProofRefusal("native-record");
  }
  const previousCursor = integer(record.previousCursor, "record-previous-cursor"),
    terminalCursor = integer(record.terminalCursor, "record-terminal-cursor");
  const [previousSequence, localSequence, applications, events] = [
    record.previousYdocSequence,
    record.localYdocSequence,
    record.applicationCount,
    record.acceptedEventCount,
  ].map((value) => integer(value, "native-record"));
  integer(record.recordedAtMs, "native-record");
  require(previousCursor <= terminalCursor &&
    previousSequence! <= localSequence! &&
    applications! <= events! &&
    record.settlementId === nativeSettlementId(record), "native-record");
  return binding;
}
export type SettlementAdmission =
  | { status: "accepted"; settlementId: string }
  | { status: "refused"; settlementId: string; reason: "authorship-mismatch" };
export function parseSettlementAuthors(value: unknown): LiveAuthorSnapshot {
  require(Array.isArray(value) &&
    value.length <= MAX_LIVE_AUTHOR_IDENTITIES &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_LIVE_AUTHOR_BYTES, "author-snapshot-bounds");
  return value.map((author) => parseLiveAuthorSnapshot([author])[0]!);
}
type Prepared = {
  baseBindingJson?: string;
  binding: LiveObjectBinding;
  namespace: string;
  previous: number;
  terminal: number;
  settlementId: string;
  momentId: string;
  recordDigest: string;
  state: string;
  markdown: string;
  terminalDigest: string;
  before: string;
  pushMovedFile: boolean;
};
const prepared = new WeakMap<SyncRelayLogInput, Prepared>();
/** What a verified settlement record proves: its binding and accepted interval. */
export interface SettlementProof {
  readonly binding: LiveObjectBinding;
  readonly namespace: string;
  readonly previous: number;
  readonly terminal: number;
  readonly terminalDigest: string;
}
// Verified `live.audit.settlement` records, apart from any companion moment.
const audits = new WeakMap<SyncRelayLogInput, SettlementProof & { payloadJson: string }>();
// Audits a push tried to prove: one whose document began settling after its push was screened never was.
const attemptedAudits = new WeakSet<SyncRelayLogInput>();
const exhaustedProofs = new WeakSet<SyncRelayLogInput>();
/**
 * The settlement a moment or audit proved, "exhausted" when its push's budget
 * ran out first, "unattempted" for an audit nothing tried to prove, or null.
 * Client `settlementAdmission` fields are never proof.
 */
export function preparedSettlement(
  op: SyncRelayLogInput,
): SettlementProof | "exhausted" | "unattempted" | null {
  if (exhaustedProofs.has(op)) return "exhausted";
  if (op.opKind === "moment.append") return prepared.get(op) ?? null;
  if (!attemptedAudits.has(op)) return "unattempted";
  const audit = audits.get(op);
  return audit && audit.payloadJson === op.payloadJson ? audit : null;
}
/** Whether the writer recorded the moment's proved settlement. */
export function settlementCommitted(op: SyncRelayLogInput): boolean {
  return op.settlementAdmission?.status === "accepted" && prepared.has(op);
}
/** Under the writer: the proof's terminal still ends the same accepted history in this relay's namespace. */
export function settlementProofCurrent(storage: StorageContext, proof: SettlementProof): boolean {
  try {
    return (
      liveJournalHistoryNamespace(storage) === proof.namespace &&
      endpoint(storage, proof.binding, proof.namespace, proof.terminal).evidenceDigest ===
        proof.terminalDigest
    );
  } catch (error) {
    if (error instanceof SettlementProofRefusal) return false;
    throw error;
  }
}
function withoutClientAuthors(payloadJson: string): string {
  const payload = bag(JSON.parse(payloadJson), "payload-object");
  if (!Object.hasOwn(payload, "authors")) return payloadJson;
  delete payload.authors;
  return stableJsonStringify(payload);
}
function refuseSettlement(
  op: SyncRelayLogInput,
  refusal: {
    workspaceId: string;
    settlementId: string;
    check: string;
    stage: "prepare" | "commit";
  },
) {
  const { workspaceId, settlementId, check, stage } = refusal;
  console.error(
    `[sync-relay] live settlement refused at ${stage}: workspace ${workspaceId}, settlement ${settlementId}, check ${check}.`,
  );
  prepared.delete(op);
  op.payloadJson = withoutClientAuthors(op.payloadJson);
  op.admittedAuthorSnapshot = undefined;
  op.settlementAdmission = { status: "refused", settlementId, reason: "authorship-mismatch" };
}
function endpoint(
  storage: StorageContext,
  document: LiveDocumentKey,
  namespace: string,
  cursor: number,
) {
  if (cursor === 0)
    return {
      eventCount: 0,
      evidenceDigest: initialAcceptedHistoryDigest(namespace, document),
      terminal: null,
    };
  const row = storage.db
    .prepare(
      `SELECT accepted_event_count,accepted_evidence_digest,relay_database_namespace,delivery_id,update_digest,accepting_host_epoch FROM sync_relay_live_update_journal WHERE ${where} AND journal_cursor=?`,
    )
    .get(...documentParams(document), cursor);
  require(row && row.relay_database_namespace === namespace, "journal-endpoint");
  return {
    eventCount: integer(row.accepted_event_count, "journal-event-count"),
    evidenceDigest: parseLiveUpdateDigest(row.accepted_evidence_digest),
    terminal: {
      journalCursor: cursor,
      deliveryId: String(row.delivery_id),
      updateDigest: parseLiveUpdateDigest(row.update_digest),
      acceptingHostEpoch: parseHostEpoch(row.accepting_host_epoch),
    },
  };
}
function prepareBindingBase(storage: StorageContext, p: Prepared, budget: RestoreHistoryBudget) {
  const selected = endpoint(storage, p.binding, p.namespace, p.previous);
  require(selected.terminal, "base-terminal");
  const metadata = readAcceptedHistoryDeliveryMetadata(
    storage,
    {
      document: p.binding,
      namespace: p.namespace,
      through: p.previous,
      eventCount: selected.eventCount,
      deliveryId: selected.terminal.deliveryId,
    },
    budget,
  );
  require(metadata, "base-metadata");
  require(metadata.accepted.binding.restoreFenceGeneration === p.binding.restoreFenceGeneration &&
    !isDeepStrictEqual(metadata.accepted.binding, p.binding), "base-binding-change");
  p.baseBindingJson = stableJsonStringify(metadata.accepted.binding);
}
function ownerSavedSince(
  storage: StorageContext,
  p: Prepared,
  settled: { originId: string; originSeq: number },
): boolean {
  const stored = storage.db
    .prepare(
      `SELECT f.blob_sha256,l.relay_seq,l.origin_id,json_extract(l.payload_json,'$.objectId') AS object_id,
        (SELECT s.relay_seq FROM sync_relay_log s WHERE s.workspace_id=f.workspace_id AND s.origin_id=? AND s.origin_seq=?) AS settled_seq
        FROM sync_relay_current_files f JOIN sync_relay_log l ON l.relay_seq=f.state_relay_seq
        WHERE f.workspace_id=? AND f.version_id='main' AND f.path=?`,
    )
    .get(settled.originId, settled.originSeq, p.binding.workspaceId, p.binding.currentPath);
  return (
    !p.pushMovedFile &&
    p.before === p.markdown &&
    stored?.blob_sha256 === p.before &&
    stored.object_id === p.binding.objectId &&
    typeof stored.origin_id === "string" &&
    isOwnerLogOrigin(stored.origin_id) &&
    typeof stored.settled_seq === "number" &&
    Number(stored.relay_seq) > stored.settled_seq
  );
}
function requirePublicationPredecessor(
  storage: StorageContext,
  p: Prepared,
  prior: {
    terminal: number;
    markdown: string;
    namespace: string;
    settled?: { originId: string; originSeq: number };
  },
) {
  require(prior.terminal <= p.previous, "predecessor-published-past");
  require(prior.markdown === p.before ||
    (prior.settled !== undefined &&
      ownerSavedSince(storage, p, prior.settled)), "predecessor-markdown");
  require(prior.namespace === p.namespace, "predecessor-namespace");
  if (prior.terminal === p.previous) return;
  const b = p.binding;
  // No-change settlements consume their interval without another moment.
  // Only relay-computed cuts can advance that unchanged artifact's anchor:
  // the relay's own Markdown at both ends, compared with itself.
  const cut = storage.db
    .prepare(
      `SELECT j.relay_database_namespace,j.current_path,j.selector_paths_json,j.restore_fence_generation,c.markdown_sha256,
      (SELECT prior.markdown_sha256 FROM ${SETTLEMENT_CUTS} prior WHERE prior.journal_cursor=?) AS prior_markdown,
      EXISTS(SELECT 1 FROM sync_relay_live_update_journal gap
        WHERE gap.workspace_id=j.workspace_id AND gap.main_version_id=j.main_version_id
          AND gap.object_id=j.object_id AND gap.lineage_claim_id=j.lineage_claim_id
          AND gap.journal_cursor>? AND gap.journal_cursor<=j.journal_cursor
          AND (gap.relay_database_namespace<>? OR gap.current_path<>? OR json(gap.selector_paths_json)<>json(?)
            OR gap.restore_fence_generation<>? OR gap.restore_operation_id IS NOT NULL)) AS changed_binding
      FROM sync_relay_live_update_journal j JOIN ${SETTLEMENT_CUTS} c USING(journal_cursor)
      WHERE j.workspace_id=? AND j.main_version_id=? AND j.object_id=? AND j.lineage_claim_id=? AND j.journal_cursor=?`,
    )
    .get(
      prior.terminal,
      prior.terminal,
      p.namespace,
      b.currentPath,
      JSON.stringify(b.selectorPaths),
      b.restoreFenceGeneration,
      ...documentParams(b),
      p.previous,
    );
  require(cut &&
    !cut.changed_binding &&
    cut.relay_database_namespace === p.namespace &&
    cut.current_path === b.currentPath &&
    cut.restore_fence_generation === b.restoreFenceGeneration &&
    isDeepStrictEqual(JSON.parse(String(cut.selector_paths_json)), b.selectorPaths) &&
    cut.prior_markdown != null &&
    cut.markdown_sha256 === cut.prior_markdown, "predecessor-unchanged-gap");
}
function anchor(storage: StorageContext, p: Prepared, budget?: RestoreHistoryBudget) {
  const prior = storage.db
    .prepare(
      `SELECT * FROM ${SETTLEMENT_BINDINGS} WHERE ${where} ORDER BY terminal_cursor DESC LIMIT 1`,
    )
    .get(...documentParams(p.binding));
  if (prior && prior.binding_json === stableJsonStringify(p.binding)) {
    requirePublicationPredecessor(storage, p, {
      terminal: integer(prior.terminal_cursor, "published-terminal-cursor"),
      markdown: String(prior.markdown_sha256),
      namespace: String(prior.namespace),
      settled: { originId: String(prior.origin_id), originSeq: Number(prior.origin_seq) },
    });
    return;
  }
  if (p.previous === 0) {
    const baseline = storage.db
      .prepare(`SELECT * FROM sync_relay_live_documents WHERE ${where}`)
      .get(...documentParams(p.binding));
    require(!prior, "first-already-published");
    require(baseline, "first-live-document");
    return;
  }
  if (budget) prepareBindingBase(storage, p, budget);
  const base = storage.db
    .prepare(`SELECT j.relay_database_namespace,j.current_path,j.selector_paths_json,j.restore_fence_generation,c.markdown_sha256
      FROM sync_relay_live_update_journal j JOIN ${SETTLEMENT_CUTS} c USING(journal_cursor)
      WHERE j.workspace_id=? AND j.main_version_id=? AND j.object_id=? AND j.lineage_claim_id=? AND j.journal_cursor=?`)
    .get(...documentParams(p.binding), p.previous);
  require(p.baseBindingJson && base, "base-cut");
  require(base.relay_database_namespace === p.namespace, "base-namespace");
  require(!prior ||
    integer(prior.terminal_cursor, "published-terminal-cursor") <=
      p.previous, "base-published-past");
  require(stableJsonStringify({
    ...p.binding,
    currentPath: base.current_path,
    selectorPaths: JSON.parse(String(base.selector_paths_json)),
    restoreFenceGeneration: base.restore_fence_generation,
  }) === p.baseBindingJson, "base-binding");
}
type ProvedSettlement = Omit<Prepared, "before" | "pushMovedFile"> & {
  events: ReturnType<typeof readAcceptedHistoryInterval>;
};
/**
 * Verifies a settlement record by the relay's journal, cut and the full state
 * it names alone. `check` sees the parsed record before any history or state
 * is read.
 */
async function proveSettlementRecord(
  storage: StorageContext,
  workspaceId: string,
  reference: unknown,
  budget: RestoreHistoryBudget,
  batched: boolean,
  signal: AbortSignal | undefined,
  check: (record: Record<string, unknown>, binding: LiveObjectBinding) => void = () => {},
): Promise<ProvedSettlement> {
  const ref = exact(reference, ["formatVersion", "recordDigest", "record"], "settlement-reference"),
    record = bag(ref.record, "settlement-record");
  require(ref.formatVersion === 1 &&
    ref.recordDigest === settlementRecordDigest(record), "record-digest");
  const binding = nativeSettlementRecord(record),
    settlementId = String(record.settlementId);
  const document = binding;
  const namespace = String(record.relayDatabaseNamespace);
  require(binding.workspaceId === workspaceId, "record-workspace");
  require(namespace === liveJournalHistoryNamespace(storage), "record-namespace");
  check(record, binding);
  const previous = integer(record.previousCursor, "record-previous-cursor"),
    terminal = integer(record.terminalCursor, "record-terminal-cursor");
  require(terminal > previous, "record-interval");
  const selected = endpoint(storage, document, namespace, previous),
    accepted = endpoint(storage, document, namespace, terminal);
  require(record.acceptedEventCount ===
    accepted.eventCount - selected.eventCount, "accepted-event-count");
  require(record.acceptedIntervalDigest ===
    hash(
      JSON.stringify([
        "live-settlement-accepted-interval-v1",
        [namespace, ...documentParams(document)],
        [selected.eventCount, previous, selected.evidenceDigest],
        [accepted.eventCount, terminal, accepted.evidenceDigest],
      ]),
    ), "accepted-interval-digest");
  let events: ReturnType<typeof readAcceptedHistoryInterval>;
  try {
    events = readAcceptedHistoryInterval(
      storage,
      { document, namespace, selected, accepted },
      budget,
    );
  } catch (error) {
    if (error instanceof Error && DAMAGED_HISTORY.includes(error.message))
      throw new SettlementProofRefusal("accepted-history");
    throw error;
  }
  require(record.restoreOperationId === null, "native-record");
  for (const event of events)
    require(event.restoreOperationId === null &&
      isDeepStrictEqual(event.metadata.accepted.binding, binding), "accepted-event-binding");
  const cut = storage.db
    .prepare(`SELECT * FROM ${SETTLEMENT_CUTS} WHERE journal_cursor=?`)
    .get(terminal);
  require(cut, "terminal-cut");
  const stateBlob = digest(record.acceptedStateBlobSha256);
  const header = storage.db
    .prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?")
    .get(workspaceId, stateBlob);
  if (!header) throw relayError("blob_missing");
  require(integer(header.byte_length, "state-blob-length") <=
    MAX_SETTLEMENT_STATE_BYTES, "state-blob-size");
  budget.chargeBytes(integer(header.byte_length, "state-blob-length"));
  const bytes = storage.getBlob(workspaceId, stateBlob);
  require(bytes && hash(bytes) === stateBlob, "state-blob-bytes");
  const normalized = await liveValidation
    .normalizeSettlement(
      {
        document: {
          workspaceId: binding.workspaceId,
          mainVersionId: binding.mainVersionId,
          objectId: binding.objectId,
          lineageClaimId: binding.lineageClaimId,
        },
        currentPath: binding.currentPath,
        checkpoint: bytes,
      },
      signal,
    )
    .catch((error: unknown) => {
      // A worker past its heap limit runs out the same way for the same state.
      if (error instanceof Error && "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY")
        return { kind: "refused", reason: "capacity-refused", source: "call" } as const;
      throw error;
    });
  if (normalized.kind === "retry") throw relayError("settlement_proof_budget");
  if (normalized.kind === "refused" && normalized.reason === "capacity-refused") {
    if (batched) throw relayError("settlement_proof_budget");
    throw new SettlementProofExhausted("state-capacity");
  }
  require(normalized.kind === "accepted", "state-normalized");
  require(normalized.evidence.stateUpdateSha256 === cut.state_sha256, "state-digest");
  require(normalized.evidence.projectedMarkdownSha256 === cut.markdown_sha256, "state-markdown");
  return {
    binding,
    namespace,
    previous,
    terminal,
    settlementId,
    momentId: String(record.momentId),
    recordDigest: String(ref.recordDigest),
    state: String(cut.state_sha256),
    // The owner engine's file. The state digest proved what it holds; only
    // that writer's own digests are compared with it.
    markdown: String(record.markdownDigest),
    terminalDigest: accepted.evidenceDigest,
    events,
  };
}
const DAMAGED_HISTORY = ["Accepted journal history is damaged."];
/**
 * Proves each `live.audit.settlement` record on its own; its companion moment
 * may arrive in a later push. An unproved record keeps no proof.
 */
export async function prepareSettlementAudits(
  storage: StorageContext,
  input: { workspaceId: string; ops: SyncRelayLogInput[]; batched: boolean },
  budget = new RestoreHistoryBudget(SETTLEMENT_PUSH_MAX_BYTES, SETTLEMENT_PUSH_MAX_METADATA_EVENTS),
  signal?: AbortSignal,
) {
  for (const op of input.ops) {
    if (op.opKind !== "live.audit.settlement") continue;
    audits.delete(op);
    exhaustedProofs.delete(op);
    attemptedAudits.add(op);
    try {
      const { binding, namespace, previous, terminal, terminalDigest } =
        await proveSettlementRecord(
          storage,
          input.workspaceId,
          JSON.parse(op.payloadJson),
          budget,
          input.batched,
          signal,
        );
      audits.set(op, {
        binding,
        namespace,
        previous,
        terminal,
        terminalDigest,
        payloadJson: op.payloadJson,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        error instanceof RestoreHistoryBudgetExceeded ||
        error instanceof SettlementProofExhausted
      ) {
        exhaustedProofs.add(op);
        continue;
      }
      if (
        !(error instanceof SettlementProofRefusal) &&
        !(error instanceof Error && DAMAGED_HISTORY.includes(error.message))
      )
        throw error;
    }
  }
}
export async function prepareHostedSettlements(
  storage: StorageContext,
  input: { workspaceId: string; originId: string; ops: SyncRelayLogInput[] },
  budget = new RestoreHistoryBudget(SETTLEMENT_PUSH_MAX_BYTES, SETTLEMENT_PUSH_MAX_METADATA_EVENTS),
  signal?: AbortSignal,
) {
  const provisional = new Map<string, Prepared>();
  for (const [index, op] of input.ops.entries()) {
    if (op.opKind !== "moment.append") continue;
    const payload = bag(JSON.parse(op.payloadJson), "payload-object");
    if (!Object.hasOwn(payload, "settlementReference")) {
      if (clientMomentAuthorsRefused(payload.authors))
        refuseSettlement(op, {
          workspaceId: input.workspaceId,
          settlementId: "unavailable",
          check: "client-moment-authors",
          stage: "prepare",
        });
      continue;
    }
    const existing = storage.fetchLogCoordinate({
      workspaceId: input.workspaceId,
      originId: input.originId,
      originSeq: op.originSeq,
    });
    if (
      existing &&
      existing.payloadJson ===
        (existing.settlementAdmission?.status === "refused"
          ? withoutClientAuthors(op.payloadJson)
          : op.payloadJson) &&
      existing.opKind === op.opKind &&
      existing.recordedAtMs === op.recordedAtMs
    ) {
      op.payloadJson = existing.payloadJson;
      op.admittedAuthorSnapshot = existing.admittedAuthorSnapshot;
      op.settlementAdmission = existing.settlementAdmission;
      continue;
    }
    let settlementId = "unavailable";
    try {
      require(!Object.hasOwn(payload, "authors"), "client-authors");
      settlementId = settlementResponseIdentifier(
        bag(bag(payload.settlementReference, "settlement-reference").record, "settlement-record")
          .settlementId,
      );
      const { events, ...proved } = await proveSettlementRecord(
        storage,
        input.workspaceId,
        payload.settlementReference,
        budget,
        input.ops.length > 1,
        signal,
        (record, binding) =>
          require(payload.momentId === record.momentId &&
            payload.objectId === binding.objectId &&
            payload.versionId === binding.mainVersionId &&
            payload.operation === "write" &&
            payload.path === binding.currentPath &&
            payload.payloadAfterPath === binding.currentPath &&
            payload.payloadBeforePath === binding.currentPath &&
            payload.payloadAfterContentKind === "text" &&
            payload.payloadBeforeContentKind === "text" &&
            payload.payloadAfterBlobSha256 === record.markdownDigest, "moment-payload"),
      );
      // The declared length must be the owner's own blob's, which activation later reads.
      const after = storage.db
        .prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?")
        .get(input.workspaceId, proved.markdown);
      if (!after) throw relayError("blob_missing");
      require(payload.payloadAfterByteLength ===
        integer(after.byte_length, "markdown-length"), "markdown-length");
      const p: Prepared = {
        ...proved,
        before: String(payload.payloadBeforeBlobSha256),
        pushMovedFile: input.ops
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.opKind === "moment.append" &&
              JSON.parse(earlier.payloadJson).path === proved.binding.currentPath,
          ),
      };
      const document = p.binding;
      const key = JSON.stringify(documentParams(document)),
        prior = provisional.get(key);
      if (prior && isDeepStrictEqual(prior.binding, p.binding))
        requirePublicationPredecessor(storage, p, prior);
      else anchor(storage, p, budget);
      const authors = new Map<string, LiveAuthorEntry>();
      for (const { metadata } of events) {
        if (metadata.firstSeen.length === 0 && (metadata.firstSeenDeletes?.length ?? 0) === 0)
          continue;
        for (const author of liveContentAuthors(metadata.authorSnapshot)) {
          const key = liveAuthorIdentity(author),
            prior = authors.get(key);
          authors.set(
            key,
            prior?.kind === "agent" && author.kind === "agent"
              ? {
                  ...prior,
                  ...((author.depth ?? 0) > (prior.depth ?? 0) ? { depth: author.depth } : {}),
                }
              : prior?.kind === "automation" && author.kind === "automation"
                ? {
                    ...prior,
                    attribution: {
                      ...prior.attribution,
                      depth: Math.max(prior.attribution.depth, author.attribution.depth),
                    },
                  }
                : (prior ?? author),
          );
        }
      }
      op.admittedAuthorSnapshot = parseSettlementAuthors([...authors.values()]);
      op.settlementAdmission = { status: "accepted", settlementId };
      prepared.set(op, p);
      provisional.set(key, p);
    } catch (error) {
      if (signal?.aborted) throw error;
      const exhausted =
        error instanceof RestoreHistoryBudgetExceeded || error instanceof SettlementProofExhausted;
      // A batch's host halves it. Any other single proof gets the same answer again, so it falls back to an
      // unattributed moment.
      if (exhausted && input.ops.length > 1) throw relayError("settlement_proof_budget");
      if (exhausted) exhaustedProofs.add(op);
      if (
        !(error instanceof SettlementProofRefusal) &&
        !(error instanceof RestoreHistoryBudgetExceeded) &&
        !(error instanceof Error && DAMAGED_HISTORY.includes(error.message))
      )
        throw error;
      refuseSettlement(op, {
        workspaceId: input.workspaceId,
        settlementId,
        stage: "prepare",
        check:
          error instanceof SettlementProofRefusal
            ? error.check
            : error instanceof RestoreHistoryBudgetExceeded
              ? "proof-budget"
              : "history-damaged",
      });
    }
  }
}
type BindingFields = Pick<
  Prepared,
  | "binding"
  | "namespace"
  | "previous"
  | "terminal"
  | "settlementId"
  | "momentId"
  | "recordDigest"
  | "state"
  | "markdown"
>;
/** A settlement binding's row, charged at its JSON length. */
function bindingValues(p: BindingFields, originId: string, originSeq: number) {
  return [
    ...documentParams(p.binding),
    p.namespace,
    p.binding.restoreFenceGeneration,
    stableJsonStringify(p.binding),
    p.previous,
    p.terminal,
    p.settlementId,
    p.momentId,
    p.recordDigest,
    p.state,
    p.markdown,
    originId,
    originSeq,
  ];
}
function commitPreparedHostedSettlement(
  storage: StorageContext,
  op: SyncRelayLogInput,
  workspaceId: string,
  originId: string,
) {
  if (op.opKind !== "moment.append") return;
  if (op.settlementAdmission?.status !== "accepted") {
    const payload = bag(JSON.parse(op.payloadJson), "payload-object");
    if (
      op.opKind === "moment.append" &&
      Object.hasOwn(payload, "settlementReference") &&
      op.settlementAdmission === undefined
    )
      throw new SettlementProofRefusal("unprepared");
    return;
  }
  const p = prepared.get(op);
  require(p && p.binding.workspaceId === workspaceId, "prepared-proof");
  const current = storage.db
    .prepare(
      `SELECT d.restore_fence_generation,d.lineage_state,d.admission_state,d.current_path,j.selector_paths_json FROM sync_relay_live_documents d
 JOIN sync_relay_live_update_journal j ON j.journal_cursor=? AND j.workspace_id=d.workspace_id AND j.main_version_id=d.main_version_id AND j.object_id=d.object_id AND j.lineage_claim_id=d.lineage_claim_id
 WHERE d.workspace_id=? AND d.main_version_id=? AND d.object_id=? AND d.lineage_claim_id=?`,
    )
    .get(p.terminal, ...documentParams(p.binding));
  require(current && current.lineage_state === "current", "lineage-current");
  require(current.restore_fence_generation === p.binding.restoreFenceGeneration, "restore-fence");
  require(current.current_path === p.binding.currentPath, "current-path");
  require(isDeepStrictEqual(
    JSON.parse(String(current.selector_paths_json)),
    p.binding.selectorPaths,
  ), "selector-paths");
  require(current.admission_state === "open", "admission-closed");
  const end = endpoint(storage, p.binding, p.namespace, p.terminal);
  require(end.evidenceDigest === p.terminalDigest, "terminal-evidence");
  require(liveJournalHistoryNamespace(storage) === p.namespace, "namespace-current");
  anchor(storage, p);
  const conflict = storage.db
    .prepare(
      `SELECT settlement_id,moment_id FROM ${SETTLEMENT_BINDINGS} WHERE workspace_id=? AND (settlement_id=? OR moment_id=? OR (main_version_id=? AND object_id=? AND lineage_claim_id=? AND previous_cursor<? AND terminal_cursor>?))`,
    )
    .get(
      workspaceId,
      p.settlementId,
      p.momentId,
      p.binding.mainVersionId,
      p.binding.objectId,
      p.binding.lineageClaimId,
      p.terminal,
      p.previous,
    );
  require(conflict?.settlement_id !== p.settlementId, "settlement-published");
  require(conflict?.moment_id !== p.momentId, "moment-published");
  require(!conflict, "settlement-overlap");
  const values = bindingValues(p, originId, op.originSeq);
  const storageBytes = Buffer.byteLength(JSON.stringify(values));
  assertWorkspaceQuota(storage, workspaceId, storageBytes);
  storage.db
    .prepare(`INSERT INTO ${SETTLEMENT_BINDINGS} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...values, storageBytes);
}

export function commitHostedSettlement(
  storage: StorageContext,
  op: SyncRelayLogInput,
  workspaceId: string,
  originId: string,
) {
  try {
    commitPreparedHostedSettlement(storage, op, workspaceId, originId);
  } catch (error) {
    if (!(error instanceof SettlementProofRefusal)) throw error;
    refuseSettlement(op, {
      workspaceId,
      settlementId: op.settlementAdmission?.settlementId ?? "unavailable",
      check: error.check,
      stage: "commit",
    });
  }
  if (op.settlementAdmission?.status === "refused")
    op.payloadJson = withoutClientAuthors(op.payloadJson);
}
