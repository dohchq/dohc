import type {
  CurrentLiveBindingRequest,
  SqliteDb,
  SyncRelayShareRow,
  CurrentLiveBindingResult,
  NamedLiveTicketLookup,
  TicketHostReport,
  NamedLiveTicketMint,
  NamedLiveTicketRedemption,
} from "./types";
import {
  ticketRecord,
  parseTicketHash,
  snapshotNamedTicketScope,
  snapshotTicketHostReport,
} from "../liveTicketInputs";
import {
  parseLiveDocumentKey,
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  type LiveDocumentKey,
  parseLiveUpdateStructRange,
  type ServerDerivedLiveUpdateAuthority,
  parseServerDerivedLiveUpdateAuthority,
} from "@dohc/live-session-contract/live-update-admission";
import { types as nodeTypes } from "node:util";
import type { HostControlSnapshot } from "@dohc/live-session-contract/host-control";
import {
  SESSION_HOST_CONTROL_TABLE,
  LIVE_TICKET_COLUMNS,
  LIVE_TICKET_INTEGER_COLUMNS,
  LIVE_TICKET_TABLE,
} from "./schema";
import { type LiveObjectBinding, parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { createHash } from "node:crypto";
import {
  type ShareSelector,
  parseStoredAnyShareSelectorJson,
  effectiveShareSelector,
  isLiveEditShareSelector,
  visibleSharePath,
} from "../shareFilter";
import { validateUserWritePath } from "@dohc/workspace-core";
import type { StorageContext } from "./context";
import {
  type LiveTicketClaims,
  parseLiveTicketClaims,
  parseRedeemedLiveTicket,
  parseLiveTicketAudience,
  LIVE_TICKET_LIFETIME_MS,
  type RedeemedLiveTicket,
} from "@dohc/live-session-contract/live-ticket";
import type { NamedLiveBrowserContext } from "../namedLiveBrowserAuth";
import { authorizeNamedLiveEditShareGrant } from "../shareAuthorization";
import { readLiveHostControl } from "./hostControl";

function snapshotCurrentBindingRequest(input: CurrentLiveBindingRequest): CurrentLiveBindingRequest {
  const outer = ticketRecord(input, ["document", "actor"]);
  const document = parseLiveDocumentKey(ticketRecord(outer.document,
    ["workspaceId", "mainVersionId", "objectId", "lineageClaimId"]));
  if (document.mainVersionId !== "main") throw new TypeError("live authority requires main");
  parseLiveUpdateDigest(document.lineageClaimId);
  if (nodeTypes.isProxy(outer.actor)) throw new TypeError("live authority actor must not be a proxy");
  const kind = typeof outer.actor === "object" && outer.actor !== null
    ? Object.getOwnPropertyDescriptor(outer.actor, "kind") : undefined;
  if (!kind || !Object.hasOwn(kind, "value") || (kind.value !== "owner" && kind.value !== "named")) {
    throw new TypeError("live authority requires an owner or named actor");
  }
  const actor = ticketRecord(outer.actor,
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
    const request = snapshotCurrentBindingRequest(input);
    return storage.tx(() => currentLiveDocumentBinding(storage, request));
  }

function parseStoredLiveTicket(row: Record<string, unknown>): { claims: LiveTicketClaims; redeemedAtMs: number | null } {
  try {
    for (const column of LIVE_TICKET_COLUMNS) {
      const value = row[column];
      if (column === "redeemed_at_ms" && value === null) continue;
      if (LIVE_TICKET_INTEGER_COLUMNS.has(column)) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
      } else if (typeof value !== "string") throw new Error();
    }
    parseTicketHash(row.token_hash);
    if (row.principal_kind !== "named" || row.main_version_id !== "main" || Number(row.restore_fence_generation) < 1) throw new Error();
    parseLiveUpdateDigest(row.lineage_claim_id);
    const claims = parseLiveTicketClaims({
      ticketId: row.ticket_id, audience: row.audience,
      binding: { workspaceId: row.workspace_id, mainVersionId: row.main_version_id, objectId: row.object_id,
        lineageClaimId: row.lineage_claim_id, currentPath: row.current_path,
        selectorPaths: JSON.parse(row.selector_paths_json as string), restoreFenceGeneration: row.restore_fence_generation },
      authority: { principalKind: row.principal_kind, principalId: row.principal_id, grantId: row.grant_id, grantGeneration: row.grant_generation },
      hostEpoch: row.host_epoch, mintedAtMs: row.minted_at_ms, expiresAtMs: row.expires_at_ms,
    });
    if (claims.ticketId !== row.ticket_id || claims.audience !== row.audience || claims.binding.workspaceId !== row.workspace_id ||
      claims.binding.objectId !== row.object_id || claims.binding.lineageClaimId !== row.lineage_claim_id ||
      claims.binding.currentPath !== row.current_path || JSON.stringify(claims.binding.selectorPaths) !== row.selector_paths_json ||
      claims.authority.principalId !== row.principal_id || claims.authority.grantId !== row.grant_id) throw new Error();
    const redeemedAtMs = row.redeemed_at_ms as number | null;
    if (redeemedAtMs !== null) parseRedeemedLiveTicket({ ...claims, redeemedAtMs });
    return { claims, redeemedAtMs };
  } catch { throw new Error("stored live ticket is damaged"); }
}

export const LIVE_TICKET_REFUSED = Symbol("live-ticket refused");

function snapshotTicketLookup(input: Record<string, unknown>): NamedLiveTicketLookup {
  return { tokenHash: parseTicketHash(input.tokenHash), audience: parseLiveTicketAudience(input.audience),
    scope: snapshotNamedTicketScope(input.scope) };
}

export function ticketScopeIsCurrent(storage: StorageContext, scope: NamedLiveBrowserContext): boolean {
    const grant = storage.getShareGrant(scope.grantId);
    const share = grant && storage.getShare(grant.shareId);
    return !!grant && grant.shareId === scope.shareId && !!share && share.workspaceId === scope.workspaceId &&
      authorizeNamedLiveEditShareGrant({ storage: storage, actorUserId: scope.userId, grantId: scope.grantId }).ok;
  }

export function currentTicketAuthority(storage: StorageContext, scope: NamedLiveBrowserContext, objectId: string, report: TicketHostReport):
    Extract<CurrentLiveBindingResult, { kind: "current" }> {
    if (report.binding.workspaceId !== scope.workspaceId || report.binding.objectId !== objectId ||
      !ticketScopeIsCurrent(storage, scope)) throw LIVE_TICKET_REFUSED;
    const current = currentLiveDocumentBinding(storage, {
      document: { workspaceId: scope.workspaceId, objectId, mainVersionId: "main", lineageClaimId: report.binding.lineageClaimId },
      actor: { kind: "named", userId: scope.userId, grantId: scope.grantId },
    });
    if (current.kind !== "current" || current.authority.principalKind !== "named" || current.binding.restoreFenceGeneration === 0 ||
      JSON.stringify(current.binding) !== JSON.stringify(report.binding) ||
      JSON.stringify(current.host) !== JSON.stringify(report.connection)) throw LIVE_TICKET_REFUSED;
    return current;
  }

export function matchingTicket(storage: StorageContext, input: NamedLiveTicketLookup, now: number): LiveTicketClaims {
    const row = storage.db.prepare(`SELECT * FROM ${LIVE_TICKET_TABLE} WHERE token_hash = ?`).get(input.tokenHash);
    if (!row) throw LIVE_TICKET_REFUSED;
    const { claims, redeemedAtMs } = parseStoredLiveTicket(row);
    if (redeemedAtMs !== null || now < claims.mintedAtMs || now >= claims.expiresAtMs || claims.audience !== input.audience ||
      claims.binding.workspaceId !== input.scope.workspaceId || claims.authority.principalKind !== "named" ||
      claims.authority.principalId !== input.scope.userId || claims.authority.grantId !== input.scope.grantId ||
      !ticketScopeIsCurrent(storage, input.scope)) throw LIVE_TICKET_REFUSED;
    return claims;
  }

export function readNamedLiveTicketTarget(storage: StorageContext, input: NamedLiveTicketLookup): { workspaceId: string; objectId: string } | null {
    const owned = snapshotTicketLookup(ticketRecord(input, ["tokenHash", "scope", "audience"]));
    return storage.ticketTransaction(now => {
      const claims = matchingTicket(storage, owned, now);
      return { workspaceId: claims.binding.workspaceId, objectId: claims.binding.objectId };
    });
  }

export function mintNamedLiveTicket(storage: StorageContext, input: NamedLiveTicketMint): { expiresAtMs: number } | null {
    const raw = ticketRecord(input, ["tokenHash", "scope", "audience", "objectId", "ticketId", "report"]);
    const owned = snapshotTicketLookup(raw);
    const objectId = parseLiveUpdateIdentifier(raw.objectId, "object ID");
    const ticketId = parseLiveUpdateIdentifier(raw.ticketId, "ticket ID");
    const report = snapshotTicketHostReport(raw.report);
    return storage.ticketTransaction((now, policy) => {
      if (now > Number.MAX_SAFE_INTEGER - LIVE_TICKET_LIFETIME_MS) throw LIVE_TICKET_REFUSED;
      const current = currentTicketAuthority(storage, owned.scope, objectId, report);
      const claims = parseLiveTicketClaims({ ticketId, audience: owned.audience, authority: current.authority,
        binding: current.binding, hostEpoch: current.host.hostEpoch, mintedAtMs: now, expiresAtMs: now + LIVE_TICKET_LIFETIME_MS });
      if (storage.db.prepare(`SELECT 1 FROM ${LIVE_TICKET_TABLE} WHERE ticket_id = ? OR token_hash = ? LIMIT 1`).get(ticketId, owned.tokenHash)) {
        throw LIVE_TICKET_REFUSED;
      }
      storage.db.prepare(`DELETE FROM ${LIVE_TICKET_TABLE} WHERE ticket_id IN (
        SELECT ticket_id FROM ${LIVE_TICKET_TABLE} WHERE expires_at_ms <= ? ORDER BY expires_at_ms, ticket_id LIMIT ?
      )`).run(now, policy.expiredTicketCleanupBatchSize);
      const count = storage.db.prepare(`SELECT count(*) AS retained_count FROM (
        SELECT ticket_id FROM ${LIVE_TICKET_TABLE}
        WHERE workspace_id = ? AND principal_kind = 'named' AND principal_id = ? AND grant_id = ? AND expires_at_ms > ?
        ORDER BY expires_at_ms, ticket_id LIMIT ?
      )`).get(owned.scope.workspaceId, owned.scope.userId, owned.scope.grantId, now, policy.retainedTicketsPerPrincipalGrant);
      if (!count || Number(count.retained_count) >= policy.retainedTicketsPerPrincipalGrant) throw LIVE_TICKET_REFUSED;
      storage.db.prepare(`INSERT INTO ${LIVE_TICKET_TABLE} (${LIVE_TICKET_COLUMNS.join(", ")})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        claims.ticketId, owned.tokenHash, claims.audience, claims.binding.workspaceId, claims.binding.mainVersionId,
        claims.binding.objectId, claims.binding.lineageClaimId, claims.binding.currentPath, JSON.stringify(claims.binding.selectorPaths),
        claims.binding.restoreFenceGeneration, claims.authority.principalKind, claims.authority.principalId,
        claims.authority.grantId, claims.authority.grantGeneration, claims.hostEpoch, claims.mintedAtMs, claims.expiresAtMs,
      );
      return { expiresAtMs: claims.expiresAtMs };
    });
  }

export function redeemNamedLiveTicket(storage: StorageContext, input: NamedLiveTicketRedemption): RedeemedLiveTicket | null {
    const raw = ticketRecord(input, ["tokenHash", "scope", "audience", "report"]);
    const owned = snapshotTicketLookup(raw);
    const report = snapshotTicketHostReport(raw.report);
    return storage.ticketTransaction(now => {
      const claims = matchingTicket(storage, owned, now);
      const current = currentTicketAuthority(storage, owned.scope, claims.binding.objectId, report);
      if (JSON.stringify(current.binding) !== JSON.stringify(claims.binding) ||
        JSON.stringify(current.authority) !== JSON.stringify(claims.authority) || current.host.hostEpoch !== claims.hostEpoch) {
        throw LIVE_TICKET_REFUSED;
      }
      const redeemed = parseRedeemedLiveTicket({ ...claims, redeemedAtMs: now });
      const updated = storage.db.prepare(`UPDATE ${LIVE_TICKET_TABLE} SET redeemed_at_ms = ?
        WHERE ticket_id = ? AND token_hash = ? AND redeemed_at_ms IS NULL AND minted_at_ms <= ? AND expires_at_ms > ?`)
        .run(now, claims.ticketId, owned.tokenHash, now, now);
      if (updated.changes !== 1) throw LIVE_TICKET_REFUSED;
      return redeemed;
    });
  }

export function currentLiveDocumentBinding(storage: StorageContext, { document, actor }: CurrentLiveBindingRequest): CurrentLiveBindingResult {
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
  }
