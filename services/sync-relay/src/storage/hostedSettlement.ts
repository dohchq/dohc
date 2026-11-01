import { clientMomentAuthorsRefused } from "../relayLogInputs";
import { parseHostControlIdentifier, parseHostEpoch } from "@dohc/live-session-contract/host-control";
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
  LIVE_UPDATE_IDENTIFIER_MAX_BYTES,
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
} from "@dohc/live-session-contract/live-update-admission";
import { stableJsonStringify } from "../canonicalJson";
import { MAX_ORIGIN_ID_CHARS, MAX_PAYLOAD_JSON_BYTES } from "../wireLimits";
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
import { readRestoreAdmission } from "./liveRestoreCheckpoint";
import { acrossDeclinedRestores } from "./liveRestoreLifecycleStorage";
import {
  LIVE_RESTORE_LIFECYCLES,
  LIVE_RESTORE_OPERATIONS,
  UNFINISHED_RESTORE,
} from "./liveRestoreOperationSchema";
import type { StorageContext } from "./context";
import { liveContentAuthors } from "./liveAuthorWindow";
import type { SyncRelayLogInput } from "./types";
export const SETTLEMENT_PUSH_MAX_BYTES = 64_000_000;
export const SETTLEMENT_PUSH_MAX_METADATA_EVENTS = 65_536;
const MAX_SETTLEMENT_STATE_BYTES = 20_971_520;
const where =
  "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
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
  require(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    check,
  );
  return value;
};
const bag = (value: unknown, check: string) => {
  require(value && typeof value === "object" && !Array.isArray(value), check);
  return value as Record<string, unknown>;
};
const exact = (value: unknown, fields: readonly string[], check: string) => {
  const record = bag(value, check);
  require(Object.keys(record).length === fields.length && fields.every((field) => Object.hasOwn(record, field)), check);
  return record;
};
// Native `SettlementRecord` and `ApplicationHostCoordinate` (`settlement_record.rs`), with no optional field.
const SETTLEMENT_RECORD_FIELDS = ["settlementId", "relayDatabaseNamespace", "binding", "hostCoordinate", "previousCursor",
  "terminalCursor", "previousYdocSequence", "localYdocSequence", "applicationCount", "nativeIntervalDigest", "acceptedEventCount",
  "acceptedIntervalDigest", "momentId", "markdownDigest", "sourceStateVectorDigest", "acceptedStateBlobSha256", "recordedAtMs",
  "restoreOperationId"];
const HOST_COORDINATE_FIELDS = ["hostId", "hostEpoch", "instanceId", "connectionId"];
const BINDING_FIELDS = ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"];
const inOrder = (value: unknown, fields: readonly string[]) => Object.fromEntries(fields.map((field) => [field, bag(value, "native-record")[field]]));
/** The settlement ID native derives from a record's identity fields, with the binding in its native field order. */
export function nativeSettlementId(record: Record<string, unknown>): string {
  return `live-settlement-${hash(JSON.stringify([record.relayDatabaseNamespace, inOrder(record.binding, BINDING_FIELDS),
    record.previousCursor, record.terminalCursor, record.previousYdocSequence, record.localYdocSequence,
    record.nativeIntervalDigest, record.momentId, record.markdownDigest, record.sourceStateVectorDigest]))}`;
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
    for (const value of [record.relayDatabaseNamespace, host.hostId, host.instanceId, host.connectionId]) parseHostControlIdentifier(value);
    parseHostEpoch(host.hostEpoch);
    parseLiveUpdateIdentifier(record.momentId);
    if (record.restoreOperationId !== null) parseLiveUpdateIdentifier(record.restoreOperationId);
    for (const value of [record.nativeIntervalDigest, record.acceptedIntervalDigest, record.markdownDigest,
      record.sourceStateVectorDigest, record.acceptedStateBlobSha256]) parseLiveUpdateDigest(value);
  } catch {
    throw new SettlementProofRefusal("native-record");
  }
  const previousCursor = integer(record.previousCursor, "record-previous-cursor"),
    terminalCursor = integer(record.terminalCursor, "record-terminal-cursor");
  const [previousSequence, localSequence, applications, events] = [record.previousYdocSequence, record.localYdocSequence, record.applicationCount, record.acceptedEventCount].map(value => integer(value, "native-record"));
  integer(record.recordedAtMs, "native-record");
  require(previousCursor <= terminalCursor && previousSequence! <= localSequence! &&
    applications! <= events! && record.settlementId === nativeSettlementId(record), "native-record");
  return binding;
}
/** Whether native would accept `record` as a settlement record, under the settlement ID it derives. */
export function isNativeSettlementRecord(record: unknown): boolean {
  try {
    nativeSettlementRecord(bag(record, "native-record"));
    return true;
  } catch (error) {
    if (error instanceof SettlementProofRefusal) return false;
    throw error;
  }
}
export type SettlementAdmission =
  | { status: "accepted"; settlementId: string }
  | { status: "refused"; settlementId: string; reason: "authorship-mismatch" };
export function parseSettlementAuthors(value: unknown): LiveAuthorSnapshot {
  require(
    Array.isArray(value) &&
      value.length <= MAX_LIVE_AUTHOR_IDENTITIES &&
      Buffer.byteLength(JSON.stringify(value)) <= MAX_LIVE_AUTHOR_BYTES,
    "author-snapshot-bounds",
  );
  return value.map((author) => parseLiveAuthorSnapshot([author])[0]!);
}
type RestoreCheck = {
  operationId: string;
  admissionDigest: string;
  terminal: number;
  newFence: number;
};
type Prepared = {
  initialBinding: LiveObjectBinding;
  baseBindingJson?: string;
  restores: RestoreCheck[];
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
export function preparedSettlement(op: SyncRelayLogInput): SettlementProof | "exhausted" | "unattempted" | null {
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
    return liveJournalHistoryNamespace(storage) === proof.namespace &&
      endpoint(storage, proof.binding, proof.namespace, proof.terminal).evidenceDigest === proof.terminalDigest;
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
/** The interval a moment's settlement record names in `workspaceId`, or null. */
function settledInterval(workspaceId: string, payload: Record<string, unknown>) {
  try {
    const record = bag(bag(payload.settlementReference, "settlement-reference").record, "settlement-record");
    const namespace = parseHostControlIdentifier(record.relayDatabaseNamespace), binding = parseLiveObjectBinding(record.binding);
    const [previous, terminal] = [record.previousCursor, record.terminalCursor].map(value => integer(value, "settlement-interval")) as [number, number];
    return binding.workspaceId === workspaceId ? { namespace, binding, previous, terminal } : null;
  } catch {
    return null;
  }
}
/**
 * Whether admission bounded what this interval's proof reads: it ends at the
 * row of a restore whose publication is still funded, and starts no earlier
 * than where `restorePublicationFits` measured from.
 */
function publicationBounded(storage: StorageContext, interval: NonNullable<ReturnType<typeof settledInterval>>): boolean {
  const { namespace, binding, previous, terminal } = interval;
  const funded = storage.db.prepare(`SELECT j.restore_operation_id FROM sync_relay_live_update_journal j JOIN ${LIVE_RESTORE_LIFECYCLES} l
    ON l.relay_database_namespace=j.relay_database_namespace AND l.operation_id=j.restore_operation_id
    WHERE j.workspace_id=? AND j.main_version_id=? AND j.object_id=? AND j.lineage_claim_id=? AND j.journal_cursor=?
      AND j.relay_database_namespace=? AND l.publication_reservation_bytes>0`).get(...documentParams(binding), terminal, namespace);
  if (!funded) return false;
  const budget = publicationBudget();
  try {
    const { oldBinding } = readRestoreAdmission(storage.db, namespace, String(funded.restore_operation_id), Number.MAX_SAFE_INTEGER,
      (value) => budget.chargeBytes(value)).preparation.fence.operation;
    return previous >= publicationStart(storage, namespace, oldBinding, terminal, budget);
  } catch (error) {
    if (error instanceof RestoreHistoryBudgetExceeded || error instanceof SettlementProofRefusal ||
      (error instanceof Error && DAMAGED_HISTORY.includes(error.message))) return false;
    throw error;
  }
}
function refuseSettlement(
  op: SyncRelayLogInput,
  refusal: { workspaceId: string; settlementId: string; check: string; stage: "prepare" | "commit" },
) {
  const { workspaceId, settlementId, check, stage } = refusal;
  console.error(`[sync-relay] live settlement refused at ${stage}: workspace ${workspaceId}, settlement ${settlementId}, check ${check}.`);
  prepared.delete(op);
  op.payloadJson = withoutClientAuthors(op.payloadJson);
  op.admittedAuthorSnapshot = undefined;
  op.settlementAdmission = {status:"refused",settlementId,reason:"authorship-mismatch"};
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
function restoreChecks(
  storage: StorageContext,
  namespace: string,
  binding: LiveObjectBinding,
  previous: number,
  events: ReturnType<typeof readAcceptedHistoryInterval>,
  budget: RestoreHistoryBudget,
) {
  let expected = binding;
  const restores: RestoreCheck[] = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    require(isDeepStrictEqual(event.metadata.accepted.binding, expected), "accepted-event-binding");
    if (event.restoreOperationId === null) continue;
    let admission;
    try {
      admission = readRestoreAdmission(
        storage.db,
        namespace,
        event.restoreOperationId,
        Number.MAX_SAFE_INTEGER,
        (value) => budget.chargeBytes(value),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Retained restore evidence is damaged."
      )
        throw new SettlementProofRefusal("restore-evidence");
      throw error;
    }
    require(isDeepStrictEqual(admission.admitted, event.metadata), "restore-admission");
    const operation = admission.preparation.fence.operation;
    require(
      isDeepStrictEqual(
        { ...operation.oldBinding, restoreFenceGeneration: operation.newFence },
        expected,
      ),
      "restore-binding",
    );
    restores.push({
      operationId: event.restoreOperationId,
      admissionDigest: String(
        storage.db
          .prepare(
            `SELECT admission_sha256 FROM ${LIVE_RESTORE_LIFECYCLES}
        WHERE relay_database_namespace=? AND operation_id=?`,
          )
          .get(namespace, event.restoreOperationId)!.admission_sha256,
      ),
      terminal: event.metadata.accepted.receipt.journalCursor,
      newFence: operation.newFence,
    });
    const before = acrossDeclinedRestores(storage.db, namespace, operation.oldBinding,
      index === 0 ? previous : events[index - 1]!.metadata.accepted.receipt.journalCursor, (value) => budget.chargeBytes(value));
    require(before, "restore-declined-binding");
    expected = before;
  }
  return { initialBinding: expected, restores };
}
/** What one push has left to prove a restore's publication once its state blob is charged. */
const publicationBudget = () =>
  new RestoreHistoryBudget(SETTLEMENT_PUSH_MAX_BYTES - MAX_SETTLEMENT_STATE_BYTES, SETTLEMENT_PUSH_MAX_METADATA_EVENTS);
/**
 * The earliest cursor a proof of the restore row at `terminal` can start from.
 * No binding commits at the old generation after the fence, and every event a
 * proof reads after its base shares one binding, so it starts no earlier than
 * the latest binding's terminal or the last row accepted at another binding.
 */
function publicationStart(storage: StorageContext, namespace: string, oldBinding: LiveObjectBinding, terminal: number,
  budget: RestoreHistoryBudget): number {
  const prior = storage.db.prepare(`SELECT terminal_cursor FROM ${SETTLEMENT_BINDINGS} WHERE ${where} ORDER BY terminal_cursor DESC LIMIT 1`)
    .get(...documentParams(oldBinding));
  const start = prior ? integer(prior.terminal_cursor, "publication-base-cursor") : 0;
  const last = storage.db.prepare(`SELECT journal_cursor FROM sync_relay_live_update_journal WHERE ${where} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`)
    .get(...documentParams(oldBinding), terminal);
  if (!last) return start;
  const initial = acrossDeclinedRestores(storage.db, namespace, oldBinding, integer(last.journal_cursor, "publication-last-cursor"), (value) => budget.chargeBytes(value));
  require(initial, "publication-initial-binding");
  const changed = storage.db.prepare(`SELECT journal_cursor FROM sync_relay_live_update_journal WHERE ${where} AND journal_cursor>? AND journal_cursor<?
    AND (current_path<>? OR json(selector_paths_json)<>json(?) OR restore_fence_generation<>?) ORDER BY journal_cursor DESC LIMIT 1`)
    .get(...documentParams(oldBinding), start, terminal, initial.currentPath, JSON.stringify(initial.selectorPaths), initial.restoreFenceGeneration);
  return changed ? integer(changed.journal_cursor, "publication-changed-cursor") : start;
}
/**
 * Under the admission writer, after the restore's row: whether one push can
 * prove its publication from `publicationStart`. Its state blob is within its
 * bound. A contradiction is the publication's to refuse.
 */
export function restorePublicationFits(storage: StorageContext, namespace: string, oldBinding: LiveObjectBinding, binding: LiveObjectBinding,
  terminal: number): boolean {
  const budget = publicationBudget();
  try {
    const previous = publicationStart(storage, namespace, oldBinding, terminal, budget);
    const selected = endpoint(storage, binding, namespace, previous), accepted = endpoint(storage, binding, namespace, terminal);
    const events = readAcceptedHistoryInterval(storage, { document: binding, namespace, selected, accepted }, budget);
    restoreChecks(storage, namespace, binding, previous, events, budget);
    if (selected.terminal) {
      require(readAcceptedHistoryDeliveryMetadata(storage, { document: binding, namespace, through: previous,
        eventCount: selected.eventCount, deliveryId: selected.terminal.deliveryId }, budget), "publication-base-metadata");
      const row = storage.db.prepare(`SELECT restore_operation_id FROM sync_relay_live_update_journal WHERE ${where} AND journal_cursor=?`)
        .get(...documentParams(binding), previous)!;
      if (row.restore_operation_id !== null)
        readRestoreAdmission(storage.db, namespace, String(row.restore_operation_id), Number.MAX_SAFE_INTEGER, value => budget.chargeBytes(value));
    }
    return true;
  } catch (error) {
    if (error instanceof RestoreHistoryBudgetExceeded) return false;
    if (error instanceof SettlementProofRefusal || (error instanceof Error && DAMAGED_HISTORY.includes(error.message))) return true;
    throw error;
  }
}
function prepareBindingBase(
  storage: StorageContext,
  p: Prepared,
  budget: RestoreHistoryBudget,
) {
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
  const row = storage.db
    .prepare(`SELECT restore_operation_id FROM sync_relay_live_update_journal WHERE ${where} AND journal_cursor=?`)
    .get(...documentParams(p.binding), p.previous)!;
  if (row.restore_operation_id !== null) {
    const admission = readRestoreAdmission(
      storage.db,
      p.namespace,
      String(row.restore_operation_id),
      Number.MAX_SAFE_INTEGER,
      value => budget.chargeBytes(value),
    );
    require(
      isDeepStrictEqual(admission.admitted, metadata) &&
      isDeepStrictEqual(metadata.accepted.binding, p.initialBinding),
      "base-restore-admission",
    );
    const operation = admission.preparation.fence.operation;
    require(isDeepStrictEqual(
      {...operation.oldBinding, restoreFenceGeneration: operation.newFence},
      p.initialBinding,
    ), "base-restore-binding");
    p.restores.push({
      operationId: String(row.restore_operation_id),
      terminal: p.previous,
      newFence: operation.newFence,
      admissionDigest: String(storage.db
        .prepare(`SELECT admission_sha256 FROM ${LIVE_RESTORE_LIFECYCLES} WHERE relay_database_namespace=? AND operation_id=?`)
        .get(p.namespace, row.restore_operation_id)!.admission_sha256),
    });
  } else {
    require(
      metadata.accepted.binding.restoreFenceGeneration === p.initialBinding.restoreFenceGeneration &&
      !isDeepStrictEqual(metadata.accepted.binding, p.initialBinding),
      "base-binding-change",
    );
  }
  p.baseBindingJson = stableJsonStringify(metadata.accepted.binding);
}
function requirePublicationPredecessor(
  storage: StorageContext,
  p: Prepared,
  prior: { terminal: number; markdown: string; namespace: string },
) {
  require(prior.terminal <= p.previous, "predecessor-published-past");
  require(prior.markdown === p.before, "predecessor-markdown");
  require(prior.namespace === p.namespace, "predecessor-namespace");
  if (prior.terminal === p.previous) return;
  const b = p.initialBinding;
  // No-change settlements consume their interval without another moment.
  // Only relay-computed cuts can advance that unchanged artifact's anchor.
  const cut = storage.db.prepare(
    `SELECT j.relay_database_namespace,j.current_path,j.selector_paths_json,j.restore_fence_generation,c.markdown_sha256,
      EXISTS(SELECT 1 FROM sync_relay_live_update_journal gap
        WHERE gap.workspace_id=j.workspace_id AND gap.main_version_id=j.main_version_id
          AND gap.object_id=j.object_id AND gap.lineage_claim_id=j.lineage_claim_id
          AND gap.journal_cursor>? AND gap.journal_cursor<=j.journal_cursor
          AND (gap.relay_database_namespace<>? OR gap.current_path<>? OR json(gap.selector_paths_json)<>json(?)
            OR gap.restore_fence_generation<>? OR gap.restore_operation_id IS NOT NULL)) AS changed_binding
      FROM sync_relay_live_update_journal j JOIN ${SETTLEMENT_CUTS} c USING(journal_cursor)
      WHERE j.workspace_id=? AND j.main_version_id=? AND j.object_id=? AND j.lineage_claim_id=? AND j.journal_cursor=?`,
  ).get(prior.terminal, p.namespace, b.currentPath, JSON.stringify(b.selectorPaths), b.restoreFenceGeneration,
    ...documentParams(b), p.previous);
  require(cut && !cut.changed_binding && cut.relay_database_namespace === p.namespace &&
    cut.current_path === b.currentPath && cut.restore_fence_generation === b.restoreFenceGeneration &&
    isDeepStrictEqual(JSON.parse(String(cut.selector_paths_json)), b.selectorPaths) && cut.markdown_sha256 === prior.markdown,
    "predecessor-unchanged-gap");
}
function anchor(storage: StorageContext, p: Prepared, budget?: RestoreHistoryBudget) {
  const prior = storage.db
    .prepare(`SELECT * FROM ${SETTLEMENT_BINDINGS} WHERE ${where} ORDER BY terminal_cursor DESC LIMIT 1`)
    .get(...documentParams(p.binding));
  if (prior && prior.binding_json === stableJsonStringify(p.initialBinding)) {
    requirePublicationPredecessor(storage, p, {
      terminal: integer(prior.terminal_cursor, "published-terminal-cursor"),
      markdown: String(prior.markdown_sha256), namespace: String(prior.namespace),
    });
    return;
  }
  if (p.previous === 0) {
    const baseline = storage.db
      .prepare(`SELECT * FROM sync_relay_live_documents WHERE ${where}`)
      .get(...documentParams(p.binding));
    require(!prior, "first-already-published");
    require(baseline, "first-live-document");
    require(baseline.baseline_projected_sha256 === p.before, "first-baseline-markdown");
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
  require(base.markdown_sha256 === p.before, "base-markdown");
  require(!prior || integer(prior.terminal_cursor, "published-terminal-cursor") <= p.previous, "base-published-past");
  require(
    stableJsonStringify({
      ...p.binding,
      currentPath: base.current_path,
      selectorPaths: JSON.parse(String(base.selector_paths_json)),
      restoreFenceGeneration: base.restore_fence_generation,
    }) === p.baseBindingJson,
    "base-binding",
  );
}
type ProvedSettlement = Omit<Prepared, "before"> & {
  markdownByteLength: number;
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
  require(ref.formatVersion === 1 && ref.recordDigest === settlementRecordDigest(record), "record-digest");
  const binding = nativeSettlementRecord(record), settlementId = String(record.settlementId);
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
  require(record.acceptedEventCount === accepted.eventCount - selected.eventCount, "accepted-event-count");
  require(
    record.acceptedIntervalDigest === hash(JSON.stringify([
      "live-settlement-accepted-interval-v1",
      [namespace, ...documentParams(document)],
      [selected.eventCount, previous, selected.evidenceDigest],
      [accepted.eventCount, terminal, accepted.evidenceDigest],
    ])),
    "accepted-interval-digest",
  );
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
  // A record naming a restore names the one its terminal applied, as native requires.
  require(record.restoreOperationId === null || events.at(-1)?.restoreOperationId === record.restoreOperationId, "native-record");
  const transitions = restoreChecks(
    storage,
    namespace,
    binding,
    previous,
    events,
    budget,
  );
  const cut = storage.db
    .prepare(`SELECT * FROM ${SETTLEMENT_CUTS} WHERE journal_cursor=?`)
    .get(terminal);
  require(cut, "terminal-cut");
  const stateBlob = digest(record.acceptedStateBlobSha256);
  const header = storage.db
    .prepare(
      "SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?",
    )
    .get(workspaceId, stateBlob);
  if (!header) throw relayError("blob_missing");
  require(integer(header.byte_length, "state-blob-length") <= MAX_SETTLEMENT_STATE_BYTES, "state-blob-size");
  budget.chargeBytes(integer(header.byte_length, "state-blob-length"));
  const bytes = storage.getBlob(workspaceId, stateBlob);
  require(bytes && hash(bytes) === stateBlob, "state-blob-bytes");
  const normalized = await liveValidation.normalizeSettlement(
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
  ).catch((error: unknown) => {
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
  require(record.markdownDigest === cut.markdown_sha256, "record-markdown");
  return {
    ...transitions,
    binding,
    namespace,
    previous,
    terminal,
    settlementId,
    momentId: String(record.momentId),
    recordDigest: String(ref.recordDigest),
    state: String(cut.state_sha256),
    markdown: String(cut.markdown_sha256),
    terminalDigest: accepted.evidenceDigest,
    markdownByteLength: integer(cut.markdown_byte_length, "markdown-length"),
    events,
  };
}
const DAMAGED_HISTORY = [
  "Accepted journal history is damaged.",
  "Retained restore evidence is damaged.",
];
/**
 * Proves each `live.audit.settlement` record on its own; its companion moment
 * may arrive in a later push. An unproved record keeps no proof.
 */
export async function prepareSettlementAudits(
  storage: StorageContext,
  input: { workspaceId: string; ops: SyncRelayLogInput[]; batched: boolean },
  budget = new RestoreHistoryBudget(
    SETTLEMENT_PUSH_MAX_BYTES,
    SETTLEMENT_PUSH_MAX_METADATA_EVENTS,
  ),
  signal?: AbortSignal,
) {
  for (const op of input.ops) {
    if (op.opKind !== "live.audit.settlement") continue;
    audits.delete(op);
    exhaustedProofs.delete(op);
    attemptedAudits.add(op);
    try {
      const { binding, namespace, previous, terminal, terminalDigest } =
        await proveSettlementRecord(storage, input.workspaceId, JSON.parse(op.payloadJson), budget, input.batched, signal);
      audits.set(op, { binding, namespace, previous, terminal, terminalDigest, payloadJson: op.payloadJson });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof RestoreHistoryBudgetExceeded || error instanceof SettlementProofExhausted) {
        exhaustedProofs.add(op);
        continue;
      }
      if (
        !(error instanceof SettlementProofRefusal) &&
        !(error instanceof Error && DAMAGED_HISTORY.includes(error.message))
      ) throw error;
    }
  }
}
export async function prepareHostedSettlements(
  storage: StorageContext,
  input: { workspaceId: string; originId: string; ops: SyncRelayLogInput[] },
  budget = new RestoreHistoryBudget(
    SETTLEMENT_PUSH_MAX_BYTES,
    SETTLEMENT_PUSH_MAX_METADATA_EVENTS,
  ),
  signal?: AbortSignal,
) {
  const provisional = new Map<string, Prepared>();
  for (const op of input.ops) {
    if (op.opKind !== "moment.append") continue;
    const payload = bag(JSON.parse(op.payloadJson), "payload-object");
    if (!Object.hasOwn(payload, "settlementReference")) {
      if (clientMomentAuthorsRefused(payload.authors))
        refuseSettlement(op, {workspaceId: input.workspaceId, settlementId: "unavailable",
          check: "client-moment-authors", stage: "prepare"});
      continue;
    }
    const existing = storage.fetchLogCoordinate({
      workspaceId: input.workspaceId,
      originId: input.originId,
      originSeq: op.originSeq,
    });
    if (
      existing &&
      existing.payloadJson === (existing.settlementAdmission?.status === "refused"
        ? withoutClientAuthors(op.payloadJson) : op.payloadJson) &&
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
      settlementId = settlementResponseIdentifier(bag(bag(payload.settlementReference, "settlement-reference").record, "settlement-record").settlementId);
      const { events, ...proved } = await proveSettlementRecord(storage, input.workspaceId,
        payload.settlementReference, budget, input.ops.length > 1, signal, (record, binding) => require(
          payload.momentId === record.momentId &&
            payload.objectId === binding.objectId &&
            payload.versionId === binding.mainVersionId &&
            payload.operation === "write" &&
            payload.path === binding.currentPath &&
            payload.payloadAfterPath === binding.currentPath &&
            payload.payloadBeforePath === binding.currentPath &&
            payload.payloadAfterContentKind === "text" &&
            payload.payloadBeforeContentKind === "text" &&
            payload.payloadAfterBlobSha256 === record.markdownDigest, "moment-payload",
        ));
      require(payload.payloadAfterByteLength === proved.markdownByteLength, "markdown-length");
      const { markdownByteLength: _length, ...settled } = proved;
      const p: Prepared = { ...settled, before: String(payload.payloadBeforeBlobSha256) };
      const document = p.binding;
      const key = JSON.stringify(documentParams(document)),
        prior = provisional.get(key);
      if (prior && isDeepStrictEqual(prior.binding, p.initialBinding))
        requirePublicationPredecessor(storage, p, prior);
      else anchor(storage, p, budget);
      const authors = new Map<string, LiveAuthorEntry>();
      for (const { metadata } of events) {
        if (
          metadata.firstSeen.length === 0 &&
          (metadata.firstSeenDeletes?.length ?? 0) === 0
        )
          continue;
        for (const author of liveContentAuthors(metadata.authorSnapshot)) {
          const key = liveAuthorIdentity(author),
            prior = authors.get(key);
          authors.set(
            key,
            prior?.kind === "agent" && author.kind === "agent"
              ? {
                  ...prior,
                  ...((author.depth ?? 0) > (prior.depth ?? 0)
                    ? { depth: author.depth }
                    : {}),
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
      const exhausted = error instanceof RestoreHistoryBudgetExceeded || error instanceof SettlementProofExhausted;
      // A batch's host halves it, and a restore's host retries the publication admission bounded. Any other single
      // proof gets the same answer again, so it falls back to an unattributed moment.
      const interval = settledInterval(input.workspaceId, payload);
      if (exhausted && (input.ops.length > 1 ||
        (error instanceof RestoreHistoryBudgetExceeded && interval !== null && publicationBounded(storage, interval))))
        throw relayError("settlement_proof_budget");
      if (exhausted) exhaustedProofs.add(op);
      if (
        !(error instanceof SettlementProofRefusal) &&
        !(error instanceof RestoreHistoryBudgetExceeded) &&
        !(error instanceof Error && DAMAGED_HISTORY.includes(error.message))
      ) throw error;
      refuseSettlement(op, {workspaceId: input.workspaceId, settlementId, stage: "prepare",
        check: error instanceof SettlementProofRefusal ? error.check
          : error instanceof RestoreHistoryBudgetExceeded ? "proof-budget" : "history-damaged"});
    }
  }
}
type BindingFields = Pick<Prepared, "binding" | "namespace" | "previous" | "terminal" | "settlementId" | "momentId" | "recordDigest" | "state" | "markdown">;
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
const LIMIT_DIGEST = "f".repeat(64);
// A moment's accepted settlement admission, whose ID native derives as `live-settlement-` and a digest.
const MAX_ADMISSION_JSON_BYTES = Buffer.byteLength(JSON.stringify({ status: "accepted", settlementId: `live-settlement-${LIMIT_DIGEST}` }));
/** The largest binding a publication at `binding` can store. */
export function maximumBindingBytes(namespace: string, binding: LiveObjectBinding): number {
  // Identifiers refuse controls, so a backslash is their costliest byte. An origin ID can hold lone surrogates.
  return Buffer.byteLength(JSON.stringify(bindingValues({
    binding, namespace, previous: Number.MAX_SAFE_INTEGER, terminal: Number.MAX_SAFE_INTEGER,
    settlementId: `live-settlement-${LIMIT_DIGEST}`, momentId: "\\".repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES),
    recordDigest: LIMIT_DIGEST, state: LIMIT_DIGEST, markdown: LIMIT_DIGEST,
  }, "\ud800".repeat(MAX_ORIGIN_ID_CHARS), Number.MAX_SAFE_INTEGER)));
}
/** What a restore's publication at `binding` can charge: its moment's log row and its binding, each at their limits. */
export function restorePublicationReservation(namespace: string, binding: LiveObjectBinding): number {
  return MAX_PAYLOAD_JSON_BYTES + MAX_LIVE_AUTHOR_BYTES + MAX_ADMISSION_JSON_BYTES + maximumBindingBytes(namespace, binding);
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
  require(
    isDeepStrictEqual(
      JSON.parse(String(current.selector_paths_json)),
      p.binding.selectorPaths,
    ),
    "selector-paths",
  );
  for (const restore of p.restores) {
    const retained = storage.db
      .prepare(
        `SELECT l.admission_sha256,o.workspace_id,o.main_version_id,o.object_id,o.lineage_claim_id,o.new_fence,o.phase FROM ${LIVE_RESTORE_LIFECYCLES} l JOIN ${LIVE_RESTORE_OPERATIONS} o USING(relay_database_namespace,operation_id) WHERE l.relay_database_namespace=? AND l.operation_id=?`,
      )
      .get(p.namespace, restore.operationId);
    require(
      retained &&
        retained.admission_sha256 === restore.admissionDigest &&
        retained.workspace_id === workspaceId &&
        retained.main_version_id === p.binding.mainVersionId &&
        retained.object_id === p.binding.objectId &&
        retained.lineage_claim_id === p.binding.lineageClaimId &&
        retained.new_fence === restore.newFence &&
        ["relay-admitted", "native-applied", "settled", "resumed"].includes(
          String(retained.phase),
        ),
      "restore-retained",
    );
  }
  if (current.admission_state !== "open") {
    const terminalRestore = p.restores.find(
      (restore) =>
        restore.terminal === p.terminal &&
        restore.newFence === p.binding.restoreFenceGeneration,
    );
    const active = storage.db
      .prepare(
        `SELECT operation_id FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND ${UNFINISHED_RESTORE}`,
      )
      .get(...documentParams(p.binding));
    require(
      current.admission_state === "closed" &&
        terminalRestore &&
        active?.operation_id === terminalRestore.operationId,
      "admission-closed",
    );
  }
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
  // Admission funded each restore's publication, which must charge no more than is held. A restore at the base
  // can't publish once this lands, so it releases too. A STRICT integer column, read before any release.
  const reserved = p.restores.map((restore) => ({
    ...restore,
    held: Number(storage.db
      .prepare(`SELECT publication_reservation_bytes FROM ${LIVE_RESTORE_LIFECYCLES} WHERE relay_database_namespace=? AND operation_id=?`)
      .get(p.namespace, restore.operationId)!.publication_reservation_bytes),
  })).filter((restore) => restore.held > 0);
  if (reserved.length > 0) {
    const logBytes = Buffer.byteLength(op.payloadJson) +
      (op.admittedAuthorSnapshot === undefined ? 0 : Buffer.byteLength(JSON.stringify(op.admittedAuthorSnapshot))) +
      Buffer.byteLength(JSON.stringify(op.settlementAdmission));
    require(storageBytes + logBytes <= reserved.reduce((bytes, restore) => bytes + restore.held, 0), "publication-reservation");
  }
  // The append's rollback restores a release, and a replay finds none.
  for (const { operationId, held } of reserved) {
    if (
      storage.db.prepare(`UPDATE ${LIVE_RESTORE_LIFECYCLES} SET publication_reservation_bytes=0,accounted_bytes=accounted_bytes-?
        WHERE relay_database_namespace=? AND operation_id=? AND publication_reservation_bytes=?`)
        .run(held, p.namespace, operationId, held).changes !== 1 ||
      storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?")
        .run(held, workspaceId, held).changes !== 1
    ) throw new Error("Retained restore evidence is damaged.");
  }
  assertWorkspaceQuota(storage, workspaceId, storageBytes);
  storage.db
    .prepare(
      `INSERT INTO ${SETTLEMENT_BINDINGS} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
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
    refuseSettlement(op, {workspaceId, settlementId: op.settlementAdmission?.settlementId ?? "unavailable",
      check: error.check, stage: "commit"});
  }
  if (op.settlementAdmission?.status !== "refused") return;
  op.payloadJson = withoutClientAuthors(op.payloadJson);
  if (op.opKind !== "moment.append") return;
  // Its host falls back to an unattributed moment instead of offering this interval again. The restore that opened
  // the interval's generation keeps the furthest refused terminal, which the next restore reports as needing repair.
  const interval = settledInterval(workspaceId, bag(JSON.parse(op.payloadJson), "settlement-payload"));
  if (!interval) return;
  storage.db.prepare(`UPDATE ${LIVE_RESTORE_LIFECYCLES} SET refused_terminal_cursor=MAX(refused_terminal_cursor,?)
    WHERE relay_database_namespace=? AND operation_id=(SELECT o.operation_id FROM ${LIVE_RESTORE_OPERATIONS} o JOIN sync_relay_live_update_journal j
      ON j.relay_database_namespace=o.relay_database_namespace AND j.workspace_id=o.workspace_id AND j.main_version_id=o.main_version_id
        AND j.object_id=o.object_id AND j.lineage_claim_id=o.lineage_claim_id AND j.restore_fence_generation=o.new_fence
      WHERE o.relay_database_namespace=? AND o.workspace_id=? AND o.main_version_id=? AND o.object_id=? AND o.lineage_claim_id=? AND j.journal_cursor=?)`)
    .run(interval.terminal, interval.namespace, interval.namespace, ...documentParams(interval.binding), interval.terminal);
}
