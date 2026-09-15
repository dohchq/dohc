import { isDeepStrictEqual } from "node:util";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { StorageContext } from "./context";
import type { CurrentLiveBindingRequest, LiveHostConnectionCoordinate } from "./types";
import { SERVICE_ACTIVATIONS } from "./serviceActivationSchema";
import { LIVE_JOURNAL_TABLE } from "./schema";

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
