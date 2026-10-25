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

/**
 * The lineage's chain tail: its activation no other names as predecessor.
 * That is the one that has not retired, else the retired one no successor follows yet.
 */
export function readServiceActivation(storage: StorageContext, document: LiveDocumentKey) {
  return storage.db.prepare(`SELECT relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
    predecessor_activation_id,source_json,binding_json,state_digest,owner_user_id,share_id,completion_json,accounted_bytes,
    retire_requested_at_ms,retire_restore_generation,retire_accepted_cursor,retired_at_ms FROM ${SERVICE_ACTIVATIONS} a
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND NOT EXISTS (SELECT 1 FROM ${SERVICE_ACTIVATIONS} s
      WHERE s.relay_database_namespace=a.relay_database_namespace AND s.predecessor_activation_id=a.activation_id)
    ORDER BY retired_at_ms IS NOT NULL LIMIT 1`)
    .get(document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId);
}

/**
 * Where the lineage's service activation stands. A retiring activation, and a
 * retired one no successor follows yet, admit no live update.
 */
export type ServiceActivationState = "absent" | "pending" | "completed" | "retiring" | "retired";
export function serviceActivationState(row: ReturnType<typeof readServiceActivation>): ServiceActivationState {
  if (!row) return "absent";
  if (row.retired_at_ms !== null) return "retired";
  if (row.retire_requested_at_ms !== null) return "retiring";
  return row.completion_json === null ? "pending" : "completed";
}

/** Issued only by the private service activation store after source verification. */
export function serviceActivationAccess(storage: StorageContext, activationId: string,
  binding: LiveObjectBinding, host: LiveHostConnectionCoordinate): ServiceActivationAccess {
  const row = readServiceActivation(storage, binding);
  if (serviceActivationState(row) !== "pending" || row!.activation_id !== activationId ||
      !isDeepStrictEqual(JSON.parse(String(row!.binding_json)), binding)) throw new Error("Pending activation is unavailable.");
  const access = Object.freeze({ activationId });
  capabilities.set(access, { storage, binding: structuredClone(binding), host: {...host} });
  return access;
}

export function allowsServiceActivation(storage: StorageContext, request: CurrentLiveBindingRequest,
  host: LiveHostConnectionCoordinate, binding: LiveObjectBinding, access?: ServiceActivationAccess): boolean {
  const row = readServiceActivation(storage, request.document), state = serviceActivationState(row);
  if (state === "absent" || state === "completed") return true;
  if (state !== "pending") return false;
  const held = access && capabilities.get(access);
  return !!held && held.storage === storage && access!.activationId === row!.activation_id &&
    isDeepStrictEqual(held.host, host) && isDeepStrictEqual(held.binding, binding) &&
    request.actor.kind === "owner" && request.actor.userId === row!.owner_user_id && request.actor.shareId === row!.share_id;
}

/**
 * F, the live-journal cursor the activation's retired predecessor accepted
 * through before Stop, or 0 for a first activation. Rows after it are this
 * activation's own.
 */
export function predecessorAcceptedThrough(storage: StorageContext, row: NonNullable<ReturnType<typeof readServiceActivation>>): number {
  if (row.predecessor_activation_id === null) return 0;
  const predecessor = storage.db.prepare(`SELECT retire_accepted_cursor FROM ${SERVICE_ACTIVATIONS}
    WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NOT NULL`).get(row.relay_database_namespace, row.predecessor_activation_id);
  const cursor = predecessor?.retire_accepted_cursor;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Service activation predecessor is unavailable.");
  return cursor;
}

export function allowsServiceActivationCandidate(storage: StorageContext, request: CurrentLiveBindingRequest,
  host: LiveHostConnectionCoordinate, binding: LiveObjectBinding, digest: string, deliveryId: string,
  access?: ServiceActivationAccess): boolean {
  const row = readServiceActivation(storage, request.document), state = serviceActivationState(row);
  if (state === "absent" || state === "completed") return true;
  if (!allowsServiceActivation(storage, request, host, binding, access) || digest !== row!.state_digest) return false;
  // A pending activation admits only its own seed after what its predecessor accepted.
  const prior = storage.db.prepare(`SELECT delivery_id,update_digest FROM ${LIVE_JOURNAL_TABLE}
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND journal_cursor>? ORDER BY journal_cursor LIMIT 2`)
    .all(binding.workspaceId, binding.mainVersionId, binding.objectId, binding.lineageClaimId, predecessorAcceptedThrough(storage, row!));
  return prior.length === 0 || (prior.length === 1 && prior[0]!.delivery_id === deliveryId && prior[0]!.update_digest === digest);
}
