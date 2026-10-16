import {parseNativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";
import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateDigest, type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {StorageContext} from "./context";
import {readServiceActivation, readStagedServiceActivationHandoff} from "./serviceActivationAccess";

function requireOrigin(condition: unknown): asserts condition {
  if (!condition) throw new Error("Retained service activation origin differs.");
}
function integer(value: unknown, minimum: number): number {
  requireOrigin(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
  return value;
}

// Initial preparation proves the ordinary cut. Later delivery retains that source,
// separately from the original CRDT baseline and from older file snapshots.
// A staged handoff's successor resolves too, so it can adopt before it is installed.
export function readServiceActivationOrigin(storage: StorageContext, namespace: string,
  document: LiveDocumentKey, adoptionId: string) {
  const row = readServiceActivation(storage, document);
  if (!row) return null;
  requireOrigin(row.relay_database_namespace === namespace);
  let sourceJson = row.source_json, stateDigest = row.state_digest;
  if (row.activation_id !== adoptionId) {
    const staged = readStagedServiceActivationHandoff(storage, document);
    requireOrigin(staged && staged.relay_database_namespace === namespace && staged.successor_activation_id === adoptionId &&
      staged.predecessor_activation_id === row.activation_id);
    sourceJson = staged.successor_source_json; stateDigest = staged.successor_state_digest;
  }
  const binding = parseLiveObjectBinding(JSON.parse(String(row.binding_json)));
  const source = parseNativeOwnerActivationSource(JSON.parse(String(sourceJson)), binding.currentPath, 20_971_520);
  requireOrigin(source.relayDatabaseNamespace === namespace && source.workspaceId === document.workspaceId &&
    source.mainVersionId === document.mainVersionId && source.objectId === document.objectId && source.lineageClaimId === document.lineageClaimId &&
    binding.workspaceId === document.workspaceId && binding.mainVersionId === document.mainVersionId &&
    binding.objectId === document.objectId && binding.lineageClaimId === document.lineageClaimId && stateDigest === source.fullStateDigest);
  const baseline = storage.db.prepare(`SELECT baseline_digest,baseline_projected_sha256,baseline_projected_byte_length,
    baseline_moment_relay_seq,registered_at_ms FROM sync_relay_live_documents
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`)
    .get(document.workspaceId,document.mainVersionId,document.objectId,document.lineageClaimId);
  requireOrigin(baseline && baseline.baseline_digest === source.lineageClaimId && baseline.baseline_moment_relay_seq === source.baseRelaySeq);
  return {source, baseline: {
    relaySequence: integer(baseline.baseline_moment_relay_seq, 1),
    projectedDigest: parseLiveUpdateDigest(baseline.baseline_projected_sha256),
    projectedLength: integer(baseline.baseline_projected_byte_length, 0),
    registeredAtMs: integer(baseline.registered_at_ms, 0),
  }};
}
