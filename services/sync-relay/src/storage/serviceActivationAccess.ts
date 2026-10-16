import { isDeepStrictEqual } from "node:util";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { StorageContext } from "./context";
import type { CurrentLiveBindingRequest, LiveHostConnectionCoordinate } from "./types";
import { SERVICE_ACTIVATIONS, SERVICE_ACTIVATION_HANDOFFS } from "./serviceActivationSchema";
import { LIVE_JOURNAL_TABLE } from "./schema";
import { assertWorkspaceQuota } from "./workspaces";

export interface ServiceActivationAccess { readonly activationId: string }
const capabilities = new WeakMap<ServiceActivationAccess, {
  storage: StorageContext; binding: LiveObjectBinding; host: LiveHostConnectionCoordinate;
}>();

export function readServiceActivation(storage: StorageContext, document: LiveDocumentKey) {
  return storage.db.prepare(`SELECT relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
    source_json,binding_json,state_digest,owner_user_id,share_id,completion_json,accounted_bytes FROM ${SERVICE_ACTIVATIONS}
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`)
    .get(document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId);
}

/** The bytes an activation row accounts for, as preparation and completion charge them. */
export const serviceActivationCharge = (input: {namespace: string; activationId: string; sourceJson: string; bindingJson: string;
  stateDigest: string; stateBytes: number; ownerUserId: string; shareId: string; completion: string | null}) =>
  input.stateBytes + Buffer.byteLength(JSON.stringify([input.namespace,input.activationId,input.sourceJson,input.bindingJson,
    input.stateDigest,input.ownerUserId,input.shareId,null])) + (input.completion === null ? 0 : Buffer.byteLength(input.completion) - 4);
/** The bytes a handoff row accounts for: its metadata, and the successor's state until installation moves it. */
export const serviceActivationHandoffCharge = (input: {namespace: string; successorId: string; predecessorId: string; document: LiveDocumentKey;
  originDigest: string | null; sourceJson: string; stateDigest: string; cutCursor: number; stateBytes: number}) =>
  input.stateBytes + Buffer.byteLength(JSON.stringify([input.namespace,input.successorId,input.predecessorId,input.document.workspaceId,
    input.document.mainVersionId,input.document.objectId,input.document.lineageClaimId,input.originDigest,input.sourceJson,input.stateDigest,input.cutCursor,"installed"]));
/** Moves workspace usage by a signed delta, checking quota for growth. */
export function chargeServiceActivationUsage(storage: StorageContext, workspaceId: string, delta: number): void {
  if (delta > 0) assertWorkspaceQuota(storage, workspaceId, delta);
  if (delta !== 0 && storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=? AND usage_bytes+?>=0")
    .run(delta, workspaceId, delta).changes !== 1) throw new Error("Service activation usage is damaged.");
}

/** The successor a handoff staged for the document and has not installed. Staging keeps at most one. */
export function readStagedServiceActivationHandoff(storage: StorageContext, document: LiveDocumentKey) {
  const rows = storage.db.prepare(`SELECT relay_database_namespace,successor_activation_id,predecessor_activation_id,predecessor_origin_digest,
    successor_source_json,successor_state_digest,successor_state_bytes,cut_cursor,accounted_bytes FROM ${SERVICE_ACTIVATION_HANDOFFS}
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND state='staged' LIMIT 2`)
    .all(document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId);
  if (rows.length > 1) throw new Error("Service activation handoff is damaged.");
  return rows[0];
}

/** Issued only by the private service activation store after source verification. */
export function serviceActivationAccess(storage: StorageContext, activationId: string,
  binding: LiveObjectBinding, host: LiveHostConnectionCoordinate): ServiceActivationAccess {
  const row = readServiceActivation(storage, binding);
  if (!row || row.activation_id !== activationId || row.completion_json !== null ||
      !isDeepStrictEqual(JSON.parse(String(row.binding_json)), binding)) throw new Error("Pending activation is unavailable.");
  const access = Object.freeze({ activationId });
  capabilities.set(access, { storage, binding: structuredClone(binding), host: {...host} });
  return access;
}

export function allowsServiceActivation(storage: StorageContext, request: CurrentLiveBindingRequest,
  host: LiveHostConnectionCoordinate, binding: LiveObjectBinding, access?: ServiceActivationAccess): boolean {
  const row = readServiceActivation(storage, request.document);
  if (!row || row.completion_json !== null) return true;
  const held = access && capabilities.get(access);
  return !!held && held.storage === storage && access!.activationId === row.activation_id &&
    isDeepStrictEqual(held.host, host) && isDeepStrictEqual(held.binding, binding) &&
    request.actor.kind === "owner" && request.actor.userId === row.owner_user_id && request.actor.shareId === row.share_id;
}

export function allowsServiceActivationCandidate(storage: StorageContext, request: CurrentLiveBindingRequest,
  host: LiveHostConnectionCoordinate, binding: LiveObjectBinding, digest: string, deliveryId: string,
  access?: ServiceActivationAccess): boolean {
  const row = readServiceActivation(storage, request.document);
  if (!row || row.completion_json !== null) return true;
  if (!allowsServiceActivation(storage, request, host, binding, access) || digest !== row.state_digest) return false;
  const prior = storage.db.prepare(`SELECT delivery_id,update_digest FROM ${LIVE_JOURNAL_TABLE}
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor LIMIT 2`)
    .all(binding.workspaceId, binding.mainVersionId, binding.objectId, binding.lineageClaimId);
  return prior.length === 0 || (prior.length === 1 && prior[0]!.delivery_id === deliveryId && prior[0]!.update_digest === digest);
}
