import { HOST_CONTROL_IDENTIFIER_MAX_BYTES } from "@dohc/live-session-contract/host-control";
import { LIVE_UPDATE_IDENTIFIER_MAX_BYTES, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { LIVE_OBJECT_BINDING_PATH_MAX_BYTES } from "@dohc/live-session-contract/live-object-binding";
import type { StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";
import { LIVE_DELIVERY_BOOTSTRAPS, LIVE_DELIVERY_EDGES, LIVE_DELIVERY_HOSTS, LIVE_DELIVERY_RESERVATIONS, LIVE_DELIVERY_DOCUMENTS } from "./liveCommittedDeliverySchema";

const WHERE_DOCUMENT = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
const parameters = (document: LiveDocumentKey) => [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
// These contracts refuse control characters; quotes and backslashes cost two JSON bytes.
const identifier = "\\".repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES);
const hostIdentifier = "\\".repeat(HOST_CONTROL_IDENTIFIER_MAX_BYTES);
const path = "\\".repeat(LIVE_OBJECT_BINDING_PATH_MAX_BYTES);
const maximum = Number.MAX_SAFE_INTEGER;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const acknowledgementBytes = bytes([maximum, "service", maximum, hostIdentifier, hostIdentifier]);
function integrity(condition: unknown): asserts condition {
  if (!condition) throw new Error("Live delivery reservation is missing or damaged.");
}
function charge(storage: StorageContext, workspaceId: string, amount: number): void {
  integrity(Number.isSafeInteger(amount) && amount > 0);
  assertWorkspaceQuota(storage, workspaceId, amount);
  const result = storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(amount, workspaceId);
  integrity(result.changes === 1);
}
function reserve(storage: StorageContext, document: LiveDocumentKey, hostId: string, cursor: number, amount: number): void {
  const overhead = bytes([...parameters(document), hostId, cursor, maximum]);
  charge(storage, document.workspaceId, amount + overhead);
  storage.db.prepare(`INSERT INTO ${LIVE_DELIVERY_RESERVATIONS}(workspace_id,main_version_id,object_id,lineage_claim_id,host_id,journal_cursor,reserved_bytes,accounted_bytes) VALUES (?,?,?,?,?,?,?,?)`)
    .run(...parameters(document), hostId, cursor, amount, overhead);
}
function documentFrom(row: Record<string, unknown>): LiveDocumentKey {
  return { workspaceId: String(row.workspace_id), mainVersionId: "main", objectId: String(row.object_id), lineageClaimId: String(row.lineage_claim_id) };
}
export function prepareLiveDeliveryWorkspace(storage: StorageContext, workspaceId: string, hostId: string): void {
  if (storage.db.prepare(`SELECT 1 FROM ${LIVE_DELIVERY_HOSTS} WHERE workspace_id=? AND host_id=?`).get(workspaceId, hostId)) return;
  integrity(!storage.db.prepare("SELECT 1 FROM sync_relay_live_documents WHERE workspace_id=? LIMIT 1").get(workspaceId));
  provisionWorkspaceHost(storage, hostId, workspaceId);
}
export function bindLiveDeliveryHostNamespace(storage: StorageContext, workspaceId: string, hostId: string, namespace: string): void {
  const row = storage.db.prepare(`SELECT history_namespace FROM ${LIVE_DELIVERY_HOSTS} WHERE host_id=? AND workspace_id=?`).get(hostId, workspaceId);
  integrity(row && (row.history_namespace === null || row.history_namespace === namespace));
  if (row.history_namespace === null) storage.db.prepare(`UPDATE ${LIVE_DELIVERY_HOSTS} SET history_namespace=? WHERE host_id=? AND workspace_id=?`).run(namespace, hostId, workspaceId);
}
function reserveLiveDeliveryBaseline(storage: StorageContext, document: LiveDocumentKey, hostId: string): void {
  const row = storage.db.prepare(`SELECT baseline_moment_relay_seq,registered_at_ms,baseline_digest,length(baseline_bytes) AS baseline_length,baseline_projected_sha256,baseline_projected_byte_length FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`).get(...parameters(document));
  integrity(row);
  const binding = { ...document, currentPath: path, selectorPaths: [path], restoreFenceGeneration: maximum };
  const amount = bytes([identifier, identifier, identifier, ...parameters(document), hostId, JSON.stringify(binding),
    row.baseline_moment_relay_seq, row.registered_at_ms, row.baseline_digest, row.baseline_length,
    row.baseline_projected_sha256, row.baseline_projected_byte_length]) + acknowledgementBytes;
  reserve(storage, document, hostId, 0, amount);
}
function reserveLiveDeliveryEvent(storage: StorageContext, document: LiveDocumentKey, hostId: string, row: Record<string, unknown>): void {
  const amount = bytes([identifier, document.workspaceId, row.journal_cursor, maximum, row.delivery_id, row.update_digest,
    row.accepting_host_epoch, maximum, "service", maximum, hostIdentifier, hostIdentifier]);
  reserve(storage, document, hostId, Number(row.journal_cursor), amount);
}
export function registerLiveDeliveryBaseline(storage: StorageContext, document: LiveDocumentKey, hostId: string): void {
  const overhead = bytes([maximum, ...parameters(document)]);
  charge(storage, document.workspaceId, overhead);
  const inserted = storage.db.prepare(`INSERT INTO ${LIVE_DELIVERY_DOCUMENTS}(workspace_id,main_version_id,object_id,lineage_claim_id,accounted_bytes) VALUES (?,?,?,?,?)`).run(...parameters(document), overhead);
  reserveLiveDeliveryBaseline(storage, document, hostId);
  const sequence = Number(inserted.lastInsertRowid);
  integrity(Number.isSafeInteger(sequence) && sequence > 0);
  const advanced = storage.db.prepare(`UPDATE ${LIVE_DELIVERY_HOSTS} SET funded_document_sequence=? WHERE host_id=? AND workspace_id=? AND funded_document_sequence<?`).run(sequence, hostId, document.workspaceId, sequence);
  integrity(advanced.changes === 1);
}
export function registerLiveDeliveryEvent(storage: StorageContext, document: LiveDocumentKey, hostId: string, row: Record<string, unknown>): void {
  reserveLiveDeliveryEvent(storage, document, hostId, row);
  const cursor = Number(row.journal_cursor);
  const advanced = storage.db.prepare(`UPDATE ${LIVE_DELIVERY_HOSTS} SET funded_journal_cursor=? WHERE host_id=? AND workspace_id=? AND funded_journal_cursor<?`).run(cursor, hostId, document.workspaceId, cursor);
  integrity(advanced.changes === 1);
}

/** Runs in the transaction that provisions or changes the configured host. */
export function provisionLiveDeliveryHost(storage: StorageContext, hostId: string, fundNewHost = false): void {
  for (const workspace of storage.db.prepare("SELECT DISTINCT workspace_id FROM sync_relay_live_documents").all()) {
    provisionWorkspaceHost(storage, hostId, String(workspace.workspace_id), fundNewHost);
  }
}
function provisionWorkspaceHost(storage: StorageContext, hostId: string, workspaceId: string, fundNewHost = false): void {
  const known = storage.db.prepare(`SELECT funded_document_sequence,funded_journal_cursor FROM ${LIVE_DELIVERY_HOSTS} WHERE host_id=? AND workspace_id=?`).get(hostId, workspaceId);
  if (!known) {
    integrity(fundNewHost || !storage.db.prepare("SELECT 1 FROM sync_relay_live_documents WHERE workspace_id=? LIMIT 1").get(workspaceId));
    integrity(!storage.db.prepare(`SELECT 1 FROM ${LIVE_DELIVERY_BOOTSTRAPS} WHERE workspace_id=? AND host_id=? LIMIT 1`).get(workspaceId, hostId));
    integrity(!storage.db.prepare(`SELECT 1 FROM ${LIVE_DELIVERY_RESERVATIONS} WHERE workspace_id=? AND host_id=? LIMIT 1`).get(workspaceId, hostId));
    const overhead = bytes([hostId, workspaceId, identifier, maximum, maximum]);
    charge(storage, workspaceId, overhead);
    storage.db.prepare(`INSERT INTO ${LIVE_DELIVERY_HOSTS}(host_id,workspace_id,funded_document_sequence,funded_journal_cursor,accounted_bytes) VALUES (?,?,0,0,?)`).run(hostId, workspaceId, overhead);
  }
  const fundedDocument = Number(known?.funded_document_sequence ?? 0), fundedCursor = Number(known?.funded_journal_cursor ?? 0);
  integrity(Number.isSafeInteger(fundedDocument) && fundedDocument >= 0 && Number.isSafeInteger(fundedCursor) && fundedCursor >= 0);
  const missingDocument = storage.db.prepare(`SELECT 1 FROM sync_relay_live_documents d LEFT JOIN ${LIVE_DELIVERY_DOCUMENTS} f USING (workspace_id,main_version_id,object_id,lineage_claim_id) WHERE d.workspace_id=? AND f.registration_sequence IS NULL LIMIT 1`).get(workspaceId);
  integrity(!missingDocument);
  const documents = storage.db.prepare(`SELECT workspace_id,main_version_id,object_id,lineage_claim_id,registration_sequence FROM ${LIVE_DELIVERY_DOCUMENTS} WHERE workspace_id=?`).all(workspaceId);
  let documentHighWater = fundedDocument, journalHighWater = fundedCursor;
  for (const raw of documents) {
    const document = documentFrom(raw);
    const documentSequence = Number(raw.registration_sequence);
    documentHighWater = Math.max(documentHighWater, documentSequence);
    const bootstrap = storage.db.prepare(`SELECT bootstrap_id,local_ydoc_sequence FROM ${LIVE_DELIVERY_BOOTSTRAPS} WHERE ${WHERE_DOCUMENT} AND host_id=?`).all(...parameters(document), hostId);
    integrity(bootstrap.length <= 1);
    const reserved = storage.db.prepare(`SELECT journal_cursor,reserved_bytes FROM ${LIVE_DELIVERY_RESERVATIONS} WHERE ${WHERE_DOCUMENT} AND host_id=?`).all(...parameters(document), hostId);
    const cursors = new Set(reserved.map(row => Number(row.journal_cursor)));
    if (!bootstrap[0] || bootstrap[0].local_ydoc_sequence === null) {
      if (!cursors.has(0)) {
        integrity(documentSequence > fundedDocument);
        reserveLiveDeliveryBaseline(storage, document, hostId);
      }
    } else integrity(!cursors.has(0));
    const edges = bootstrap[0] ? storage.db.prepare(`SELECT journal_cursor FROM ${LIVE_DELIVERY_EDGES} WHERE bootstrap_id=?`).all(bootstrap[0].bootstrap_id) : [];
    const acknowledged = new Set(edges.map(row => Number(row.journal_cursor)));
    const events = storage.db.prepare(`SELECT journal_cursor,delivery_id,update_digest,accepting_host_epoch FROM sync_relay_live_update_journal WHERE ${WHERE_DOCUMENT}`).all(...parameters(document));
    for (const event of events) {
      const cursor = Number(event.journal_cursor);
      journalHighWater = Math.max(journalHighWater, cursor);
      if (acknowledged.has(cursor)) { integrity(!cursors.has(cursor)); continue; }
      if (!cursors.has(cursor)) {
        integrity(cursor > fundedCursor);
        reserveLiveDeliveryEvent(storage, document, hostId, event);
      }
    }
  }
  storage.db.prepare(`UPDATE ${LIVE_DELIVERY_HOSTS} SET funded_document_sequence=?,funded_journal_cursor=? WHERE host_id=? AND workspace_id=?`).run(documentHighWater, journalHighWater, hostId, workspaceId);
}

/** Transfer a precharged reservation into durable progress without another quota decision. */
export function consumeLiveDeliveryReservation(storage: StorageContext, document: LiveDocumentKey, hostId: string, cursor: number, amount: number, complete: boolean): void {
  const params = [...parameters(document), hostId, cursor];
  const row = storage.db.prepare(`SELECT reserved_bytes,accounted_bytes FROM ${LIVE_DELIVERY_RESERVATIONS} WHERE ${WHERE_DOCUMENT} AND host_id=? AND journal_cursor=?`).get(...params);
  integrity(row && typeof row.reserved_bytes === "number" && Number.isSafeInteger(row.reserved_bytes) && row.reserved_bytes >= amount && amount > 0);
  const remaining = row.reserved_bytes - amount;
  if (complete) {
    storage.db.prepare(`DELETE FROM ${LIVE_DELIVERY_RESERVATIONS} WHERE ${WHERE_DOCUMENT} AND host_id=? AND journal_cursor=?`).run(...params);
    integrity(typeof row.accounted_bytes === "number" && Number.isSafeInteger(row.accounted_bytes) && row.accounted_bytes > 0);
    const refund = remaining + row.accounted_bytes;
    if (refund > 0) {
      const refunded = storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?").run(refund, document.workspaceId, refund);
      integrity(refunded.changes === 1);
    }
  } else {
    integrity(remaining >= acknowledgementBytes);
    storage.db.prepare(`UPDATE ${LIVE_DELIVERY_RESERVATIONS} SET reserved_bytes=? WHERE ${WHERE_DOCUMENT} AND host_id=? AND journal_cursor=?`).run(remaining, ...params);
  }
}
