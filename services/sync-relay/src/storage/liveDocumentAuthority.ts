import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { validateUserWritePath } from "@dohc/workspace-core";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import {
  parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier,
  parseLiveUpdateStructRange, parseServerDerivedLiveUpdateAuthority,
  type LiveDocumentKey, type ServerDerivedLiveUpdateAuthority,
} from "@dohc/live-session-contract/live-update-admission";
import type { HostControlSnapshot } from "@dohc/live-session-contract/host-control";
import { authorizeNamedLiveEditShareGrant } from "../shareAuthorization";
import {
  effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson,
  visibleSharePath, type ShareSelector,
} from "../shareFilter";
import type { SqliteDb, SyncRelayShareRow, CurrentLiveBindingRequest, CurrentLiveBindingResult } from "./types";
import type { StorageContext } from "./context";
import { SESSION_HOST_CONTROL_TABLE } from "./schema";
import { readLiveHostControl } from "./hostControl";

function snapshotAuthorityRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value) || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("live authority input must be a record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("live authority input has unexpected fields");
  }
  const copy: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("live authority input must contain own data fields");
    }
    copy[field] = descriptor.value;
  }
  return copy;
}

function snapshotCurrentBindingRequest(input: CurrentLiveBindingRequest): CurrentLiveBindingRequest {
  const outer = snapshotAuthorityRecord(input, ["document", "actor"]);
  const document = parseLiveDocumentKey(snapshotAuthorityRecord(outer.document,
    ["workspaceId", "mainVersionId", "objectId", "lineageClaimId"]));
  if (document.mainVersionId !== "main") throw new TypeError("live authority requires main");
  parseLiveUpdateDigest(document.lineageClaimId);
  if (nodeTypes.isProxy(outer.actor)) throw new TypeError("live authority actor must not be a proxy");
  const kind = typeof outer.actor === "object" && outer.actor !== null
    ? Object.getOwnPropertyDescriptor(outer.actor, "kind") : undefined;
  if (!kind || !Object.hasOwn(kind, "value") || (kind.value !== "owner" && kind.value !== "named")) {
    throw new TypeError("live authority requires an owner or named actor");
  }
  const actor = snapshotAuthorityRecord(outer.actor,
    kind.value === "owner" ? ["kind", "userId", "shareId"] : ["kind", "userId", "grantId"]);
  if (actor.kind !== kind.value) throw new TypeError("live authority actor changed during capture");
  const userId = parseLiveUpdateIdentifier(actor.userId, "actor user ID");
  return { document, actor: kind.value === "owner"
    ? { kind: "owner", userId, shareId: parseLiveUpdateIdentifier(actor.shareId, "share ID") }
    : { kind: "named", userId, grantId: parseLiveUpdateIdentifier(actor.grantId, "grant ID") } };
}

function authorityIntegrity(condition: unknown): asserts condition {
  if (!condition) throw new Error("stored live document authority is damaged");
}

function authorityInteger(value: unknown, minimum = 0): number {
  authorityIntegrity(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
  return value;
}

function assertCurrentAuthorityHost(db: SqliteDb, host: HostControlSnapshot): void {
  authorityIntegrity(host.registeredConnectionId === null || host.registeredInstanceId !== null);
  authorityIntegrity(host.admissionState !== "closed" || host.registeredConnectionId === null);
  authorityIntegrity(host.admissionState !== "open" ||
    (host.registeredInstanceId !== null && host.registeredConnectionId !== null));
  authorityIntegrity(host.lastCompletedTransitionId === null || host.lastTransitionGeneration !== null);
  const transition = host.transition;
  if (transition === null) {
    authorityIntegrity(host.admissionState !== "draining" &&
      (host.admissionState === "open" || host.lastCompletedTransitionId === null));
    const row = db.prepare(`SELECT transition_id, transition_from_mode, transition_from_host_id,
      transition_from_instance_id, transition_from_connection_id, transition_from_epoch,
      transition_to_mode, transition_to_host_id, transition_started_at_ms
      FROM ${SESSION_HOST_CONTROL_TABLE} WHERE singleton_id = 1`).get();
    authorityIntegrity(row && Object.values(row).every(value => value === null));
  } else {
    authorityIntegrity(host.lastCompletedTransitionId === null && transition.fromMode !== transition.toMode);
    if (transition.phase === "draining") {
      authorityIntegrity(host.admissionState === "draining" && host.configuredMode === transition.fromMode &&
        host.configuredHostId === transition.fromHostId && host.registeredInstanceId === transition.fromInstanceId &&
        host.registeredConnectionId === transition.fromConnectionId && host.hostEpoch === transition.fromEpoch);
    } else {
      authorityIntegrity(host.admissionState === "closed" && host.configuredMode === transition.toMode &&
        host.configuredHostId === transition.toHostId && host.registeredInstanceId === null &&
        host.registeredConnectionId === null && host.hostEpoch === transition.fromEpoch + 1);
    }
  }
}

function readLiveDocumentAuthority(db: SqliteDb, document: LiveDocumentKey): {
  binding: LiveObjectBinding;
  current: boolean;
  open: boolean;
} | null {
  const row = db.prepare(`SELECT * FROM sync_relay_live_documents
    WHERE workspace_id = ? AND main_version_id = ? AND object_id = ?
      AND (lineage_state = 'current' OR lineage_claim_id = ?)
    ORDER BY lineage_state = 'current' DESC LIMIT 1`)
    .get(document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId);
  if (!row) return null;
  const storedDocument = parseLiveDocumentKey({
    workspaceId: row.workspace_id, mainVersionId: row.main_version_id,
    objectId: row.object_id, lineageClaimId: row.lineage_claim_id,
  });
  authorityIntegrity(storedDocument.mainVersionId === "main");
  const baselineDigest = parseLiveUpdateDigest(row.baseline_digest);
  authorityIntegrity(parseLiveUpdateDigest(storedDocument.lineageClaimId) === baselineDigest);
  if (row.replaces_lineage_claim_id !== null) {
    authorityIntegrity(parseLiveUpdateDigest(row.replaces_lineage_claim_id) !== baselineDigest);
  }
  const binding = parseLiveObjectBinding({ ...storedDocument, currentPath: row.current_path,
    selectorPaths: [row.current_path], restoreFenceGeneration: row.restore_fence_generation });
  authorityIntegrity(binding.currentPath === row.current_path && liveDocumentKindForPath(binding.currentPath) === "richdoc");
  authorityInteger(row.registered_at_ms);
  authorityIntegrity(row.lineage_state === "current" || row.lineage_state === "retired");
  authorityIntegrity(row.admission_state === "open" || row.admission_state === "closed");
  if (row.lineage_state === "current") authorityIntegrity(row.retired_at_ms === null);
  else { authorityInteger(row.retired_at_ms); authorityIntegrity(row.admission_state === "closed"); }
  const bytes = row.baseline_bytes;
  authorityIntegrity(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20_971_520);
  authorityIntegrity(createHash("sha256").update(bytes).digest("hex") === baselineDigest);
  const projectionDigest = parseLiveUpdateDigest(row.baseline_projected_sha256);
  const projectionLength = authorityInteger(row.baseline_projected_byte_length);
  authorityIntegrity(projectionLength <= 2_097_152);
  const baselineSequence = authorityInteger(row.baseline_moment_relay_seq, 1);
  const sourceMoment = db.prepare(`SELECT version_id, path, content_kind, blob_sha256, byte_length
    FROM sync_relay_object_moments WHERE workspace_id = ? AND object_id = ? AND relay_seq = ?`)
    .get(document.workspaceId, document.objectId, baselineSequence);
  authorityIntegrity(sourceMoment && sourceMoment.version_id === "main" && sourceMoment.path === binding.currentPath &&
    sourceMoment.content_kind === "text" && sourceMoment.blob_sha256 === projectionDigest && sourceMoment.byte_length === projectionLength);
  const ranges = db.prepare(`SELECT * FROM sync_relay_live_document_baseline_ranges
    WHERE workspace_id = ? AND main_version_id = ? AND object_id = ? AND lineage_claim_id = ?
    ORDER BY client_id, start_clock`)
    .all(document.workspaceId, document.mainVersionId, document.objectId, storedDocument.lineageClaimId);
  let previous: ReturnType<typeof parseLiveUpdateStructRange> | null = null;
  for (const raw of ranges) {
    authorityIntegrity(raw.workspace_id === storedDocument.workspaceId && raw.main_version_id === "main" &&
      raw.object_id === storedDocument.objectId && raw.lineage_claim_id === storedDocument.lineageClaimId);
    const range = parseLiveUpdateStructRange({ clientId: raw.client_id, startClock: raw.start_clock, endClock: raw.end_clock });
    authorityIntegrity(previous === null || previous.clientId !== range.clientId || previous.endClock < range.startClock);
    previous = range;
  }
  return { binding, current: row.lineage_state === "current", open: row.admission_state === "open" };
}

function canonicalLiveSelector(share: SyncRelayShareRow, selector: ShareSelector): boolean {
  const raw = JSON.parse(share.selectorJson) as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "paths") || !Object.hasOwn(raw, "versionId")) return false;
  return new Set(selector.paths).size === selector.paths.length && selector.paths.every(path => {
    const checked = validateUserWritePath(path);
    return checked.ok && checked.normalized === path;
  });
}

export function resolveCurrentLiveDocumentBinding(storage: StorageContext, input: CurrentLiveBindingRequest): CurrentLiveBindingResult {
    const { document, actor } = snapshotCurrentBindingRequest(input);
    return storage.tx<CurrentLiveBindingResult>(() => {
      const host = readLiveHostControl(storage.db);
      if (host !== null) assertCurrentAuthorityHost(storage.db, host);
      if (host === null || host.admissionState !== "open" || host.transition !== null) {
        return { kind: "refused", reason: "host-unavailable" };
      }
      authorityIntegrity(host.registeredInstanceId !== null && host.registeredConnectionId !== null);
      const stored = readLiveDocumentAuthority(storage.db, document);
      if (!stored || !stored.current || !stored.open || stored.binding.lineageClaimId !== document.lineageClaimId) {
        return { kind: "refused", reason: "stale-document" };
      }
      const latest = storage.db.prepare(`SELECT path, content_kind, blob_sha256, byte_length, relay_seq, recorded_at_ms FROM sync_relay_object_moments
        WHERE workspace_id = ? AND object_id = ? AND version_id = 'main' ORDER BY relay_seq DESC LIMIT 1`)
        .get(document.workspaceId, document.objectId);
      if (!latest || latest.path !== stored.binding.currentPath || latest.content_kind !== "text" ||
          typeof latest.blob_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(latest.blob_sha256) ||
          typeof latest.byte_length !== "number" || !Number.isSafeInteger(latest.byte_length) || latest.byte_length < 0 ||
          typeof latest.relay_seq !== "number" || !Number.isSafeInteger(latest.relay_seq) || latest.relay_seq < 1 ||
          typeof latest.recorded_at_ms !== "number" || !Number.isSafeInteger(latest.recorded_at_ms) || latest.recorded_at_ms < 0 ||
          storage.objectIdAtPathInVersion({ workspaceId: document.workspaceId, versionId: "main", path: stored.binding.currentPath }) !== document.objectId) {
        return { kind: "refused", reason: "stale-document" };
      }
      let share: SyncRelayShareRow;
      let selector: ShareSelector;
      let authority: ServerDerivedLiveUpdateAuthority;
      if (actor.kind === "named") {
        const named = authorizeNamedLiveEditShareGrant({ storage: storage, actorUserId: actor.userId, grantId: actor.grantId });
        if (!named.ok) return { kind: "refused", reason: named.reason };
        share = named.share;
        selector = named.effectiveSelector;
        authority = parseServerDerivedLiveUpdateAuthority({ principalKind: "named", principalId: actor.userId,
          grantId: named.grant.grantId, grantGeneration: named.grant.generation });
      } else {
        const owned = storage.getShare(actor.shareId);
        if (!owned || owned.granterUserId !== actor.userId || !storage.workspaceIsOwnedBy(owned.workspaceId, actor.userId)) {
          return { kind: "refused", reason: "not-authorized" };
        }
        share = owned;
        const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
        const effective = parsed && effectiveShareSelector(parsed, "edit");
        if (!effective || !isLiveEditShareSelector(effective)) return { kind: "refused", reason: "stale-selector" };
        selector = effective;
        authority = parseServerDerivedLiveUpdateAuthority({ principalKind: "owner", principalId: actor.userId,
          grantId: null, grantGeneration: null });
      }
      if (share.workspaceId !== document.workspaceId) return { kind: "refused", reason: "not-authorized" };
      if (!canonicalLiveSelector(share, selector) || visibleSharePath(selector, stored.binding.currentPath) !== stored.binding.currentPath) {
        return { kind: "refused", reason: "stale-selector" };
      }
      let binding: LiveObjectBinding;
      try { binding = parseLiveObjectBinding({ ...stored.binding, selectorPaths: selector.paths }); }
      catch { return { kind: "refused", reason: "stale-selector" }; }
      return { kind: "current", binding, authority,
        host: { mode: host.configuredMode, hostId: host.configuredHostId, hostEpoch: host.hostEpoch,
          instanceId: host.registeredInstanceId, connectionId: host.registeredConnectionId } };
    });
  }
