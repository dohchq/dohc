import type { StoredLiveDocumentAuthority } from "./types";
import { allowsServiceActivation, type ServiceActivationAccess } from "./serviceActivationAccess";
import type {
  CurrentLiveBindingRequest,
  LiveDocumentBaselineRegistrationInput,
  RelayBaselineRegistrationResult,
  LiveHostConnectionCoordinate,
  SqliteDb,
  SyncRelayShareRow,
  CurrentLiveBindingResult,
  LiveTicketLookup,
  TicketHostReport,
  LiveTicketMint,
  LiveTicketRedemption,
} from "./types";
import {
  ticketRecord,
  snapshotHostCoordinate,
  parseTicketHash,
  snapshotLiveTicketScope,
  snapshotTicketHostReport,
} from "../liveTicketInputs";
import {
  parseLiveDocumentKey,
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  type LiveDocumentKey,
  type LiveUpdateStructRange,
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
import type { LiveBrowserContext } from "../liveBrowserContext";
import { authorizeNamedLiveEditShareGrant } from "../shareAuthorization";
import { readLiveHostControl, parseHostControlTimestamp } from "./hostControl";
import { assertWorkspaceQuota } from "./workspaces";
import { prepareLiveDeliveryWorkspace, registerLiveDeliveryBaseline } from "./liveDeliveryReservations";
import { nextShareDiscussionRevision } from "./discussion";
import { liveBrowserActor } from "../liveBrowserContext";
import { readLinkEnrollment, linkWriteRefusal, linkPrincipalLimitReached, linkPrincipalStorageBytes, commitLinkEnrollment } from "./linkEnrollment";
import { authorizeLinkShareAction } from "../shareAuthorization";

export function snapshotCurrentBindingRequest(input: CurrentLiveBindingRequest): CurrentLiveBindingRequest {
  const outer = ticketRecord(input, ["document", "actor"]);
  const document = parseLiveDocumentKey(ticketRecord(outer.document,
    ["workspaceId", "mainVersionId", "objectId", "lineageClaimId"]));
  if (document.mainVersionId !== "main") throw new TypeError("live authority requires main");
  parseLiveUpdateDigest(document.lineageClaimId);
  if (nodeTypes.isProxy(outer.actor)) throw new TypeError("live authority actor must not be a proxy");
  const kind = typeof outer.actor === "object" && outer.actor !== null
    ? Object.getOwnPropertyDescriptor(outer.actor, "kind") : undefined;
  if (!kind || !Object.hasOwn(kind, "value") || (kind.value !== "owner" && kind.value !== "named" && kind.value !== "link")) {
    throw new TypeError("live authority requires an authenticated actor");
  }
  if (kind.value === "link") {
    const actor = ticketRecord(outer.actor, ["kind", "sessionId", "capabilityHash", "profileTokenHash", "grantId", "workspaceId"]);
    return { document, actor: { kind: "link", sessionId: parseLiveUpdateIdentifier(actor.sessionId, "session ID"),
      capabilityHash: parseTicketHash(actor.capabilityHash), profileTokenHash: parseTicketHash(actor.profileTokenHash),
      grantId: parseLiveUpdateIdentifier(actor.grantId, "grant ID"), workspaceId: parseLiveUpdateIdentifier(actor.workspaceId, "workspace ID") } };
  }
  const actor = ticketRecord(outer.actor,
    kind.value === "owner" ? ["kind", "userId", "shareId"] : ["kind", "userId", "grantId"]);
  if (actor.kind !== kind.value) throw new TypeError("live authority actor changed during capture");
  const userId = parseLiveUpdateIdentifier(actor.userId, "actor user ID");
  return { document, actor: kind.value === "owner"
    ? { kind: "owner", userId, shareId: parseLiveUpdateIdentifier(actor.shareId, "share ID") }
    : { kind: "named", userId, grantId: parseLiveUpdateIdentifier(actor.grantId, "grant ID") } };
}

export function baselineRecord(value: unknown, fields: readonly string[], allowExtra = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value) || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Invalid baseline record.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!allowExtra && (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key)))) {
    throw new TypeError("Invalid baseline fields.");
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid baseline field.");
    result[field] = descriptor.value;
  }
  return result;
}

const baselineBytePrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;

export const baselineByteBuffer = Object.getOwnPropertyDescriptor(baselineBytePrototype, "buffer")!.get!;

export const baselineByteOffset = Object.getOwnPropertyDescriptor(baselineBytePrototype, "byteOffset")!.get!;

export const baselineByteLength = Object.getOwnPropertyDescriptor(baselineBytePrototype, "byteLength")!.get!;

export const baselineBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;

export const baselineBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;

function snapshotBaseline(outer: Record<string, unknown>, host: LiveHostConnectionCoordinate): LiveDocumentBaselineRegistrationInput {
  const evidence = baselineRecord(outer.evidence,
    ["version", "document", "currentPath", "checkpoint", "projectedMarkdownSha256", "projectedMarkdownByteLength"], true);
  if (evidence.version !== 1) throw new TypeError("Unknown baseline evidence version.");
  const document = parseLiveDocumentKey(baselineRecord(evidence.document,
    ["workspaceId", "mainVersionId", "objectId", "lineageClaimId"]));
  const currentPath = evidence.currentPath;
  const binding = parseLiveObjectBinding({ ...document, currentPath, selectorPaths: [currentPath], restoreFenceGeneration: 1 });
  if (document.mainVersionId !== "main" || binding.currentPath !== currentPath || liveDocumentKindForPath(currentPath) !== "richdoc") {
    throw new TypeError("Invalid baseline path.");
  }
  const checkpoint = baselineRecord(evidence.checkpoint, ["updateDigest", "ranges"], true);
  const updateDigest = parseLiveUpdateDigest(checkpoint.updateDigest);
  if (parseLiveUpdateDigest(document.lineageClaimId) !== updateDigest) throw new TypeError("Baseline lineage mismatch.");
  const bytes = outer.baselineBytes;
  if (!nodeTypes.isUint8Array(bytes)) throw new TypeError("Invalid baseline bytes.");
  const buffer = Reflect.apply(baselineByteBuffer, bytes, []) as ArrayBuffer;
  const offset = Reflect.apply(baselineByteOffset, bytes, []) as number;
  const length = Reflect.apply(baselineByteLength, bytes, []) as number;
  const backingLength = Reflect.apply(baselineBufferLength, buffer, []) as number;
  if (length < 1 || length > 20_971_520 || offset > backingLength || length > backingLength - offset ||
    (baselineBufferResizable !== undefined && Reflect.apply(baselineBufferResizable, buffer, []))) {
    throw new TypeError("Invalid baseline bytes.");
  }
  const baselineBytes = new Uint8Array(new Uint8Array(buffer, offset, length));
  if (createHash("sha256").update(baselineBytes).digest("hex") !== updateDigest) throw new TypeError("Baseline digest mismatch.");
  const rawRanges = checkpoint.ranges;
  if (!Array.isArray(rawRanges) || nodeTypes.isProxy(rawRanges) || Object.getPrototypeOf(rawRanges) !== Array.prototype) {
    throw new TypeError("Invalid baseline ranges.");
  }
  const rangeCount = Object.getOwnPropertyDescriptor(rawRanges, "length")!.value as number;
  if (Reflect.ownKeys(rawRanges).length !== rangeCount + 1) throw new TypeError("Invalid baseline ranges.");
  const ranges: LiveUpdateStructRange[] = [];
  for (let index = 0; index < rangeCount; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(rawRanges, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid baseline range.");
    const range = parseLiveUpdateStructRange(baselineRecord(descriptor.value, ["clientId", "startClock", "endClock"]));
    const previous = ranges.at(-1);
    if (previous && (range.clientId < previous.clientId ||
      (range.clientId === previous.clientId && range.startClock <= previous.endClock))) throw new TypeError("Noncanonical baseline ranges.");
    ranges.push(range);
  }
  const projectedMarkdownSha256 = parseLiveUpdateDigest(evidence.projectedMarkdownSha256);
  const projectedMarkdownByteLength = parseHostControlTimestamp(evidence.projectedMarkdownByteLength, "projection length");
  if (projectedMarkdownByteLength > 2_097_152) throw new TypeError("Invalid baseline projection length.");
  const registeredAtMs = parseHostControlTimestamp(outer.registeredAtMs, "registration timestamp");
  return { host, baselineBytes, registeredAtMs, evidence: { version: 1, document, currentPath,
    checkpoint: { updateDigest, ranges }, projectedMarkdownSha256, projectedMarkdownByteLength } };
}

export function authorityIntegrity(condition: unknown): asserts condition {
  if (!condition) throw new Error("stored live document authority is damaged");
}

export function authorityInteger(value: unknown, minimum = 0): number {
  authorityIntegrity(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
  return value;
}

export function assertCurrentAuthorityHost(db: SqliteDb, host: HostControlSnapshot): void {
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

function readLiveDocumentAuthority(db: SqliteDb, document: LiveDocumentKey): StoredLiveDocumentAuthority | null {
  const row = db.prepare(`SELECT * FROM sync_relay_live_documents
    WHERE workspace_id = ? AND main_version_id = ? AND object_id = ?
      AND (lineage_state = 'current' OR lineage_claim_id = ?)
    ORDER BY lineage_state = 'current' DESC LIMIT 1`)
    .get(document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId);
  if (!row) return null;
  return decodeLiveDocumentAuthority(db, document, row);
}

export function decodeLiveDocumentAuthority(db: SqliteDb, document: LiveDocumentKey, row: Record<string, unknown>): StoredLiveDocumentAuthority {
  const stored = decodeLiveDocumentAuthorityStructure(db, document, row);
  authorityIntegrity(createHash("sha256").update(stored.baselineBytes).digest("hex") === stored.baselineDigest);
  return stored;
}

// The caller must verify copied baseline bytes against the digest outside its writer transaction.
export function decodeLiveDocumentAuthorityStructure(db: SqliteDb, document: LiveDocumentKey, row: Record<string, unknown>): StoredLiveDocumentAuthority {
  const storedDocument = parseLiveDocumentKey({
    workspaceId: row.workspace_id, mainVersionId: row.main_version_id,
    objectId: row.object_id, lineageClaimId: row.lineage_claim_id,
  });
  authorityIntegrity(storedDocument.mainVersionId === "main");
  authorityIntegrity(storedDocument.workspaceId === document.workspaceId && storedDocument.objectId === document.objectId);
  const baselineDigest = parseLiveUpdateDigest(row.baseline_digest);
  authorityIntegrity(parseLiveUpdateDigest(storedDocument.lineageClaimId) === baselineDigest);
  if (row.replaces_lineage_claim_id !== null) {
    authorityIntegrity(parseLiveUpdateDigest(row.replaces_lineage_claim_id) !== baselineDigest);
  }
  const binding = parseLiveObjectBinding({ ...storedDocument, currentPath: row.current_path,
    selectorPaths: [row.current_path], restoreFenceGeneration: row.restore_fence_generation });
  authorityIntegrity(binding.currentPath === row.current_path && liveDocumentKindForPath(binding.currentPath) === "richdoc");
  const registeredAtMs = authorityInteger(row.registered_at_ms);
  authorityIntegrity(row.lineage_state === "current" || row.lineage_state === "retired");
  authorityIntegrity(row.admission_state === "open" || row.admission_state === "closed");
  if (row.lineage_state === "current") authorityIntegrity(row.retired_at_ms === null);
  else { authorityInteger(row.retired_at_ms); authorityIntegrity(row.admission_state === "closed"); }
  const bytes = row.baseline_bytes;
  authorityIntegrity(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20_971_520);
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
  const decodedRanges: LiveUpdateStructRange[] = [];
  for (const raw of ranges) {
    authorityIntegrity(raw.workspace_id === storedDocument.workspaceId && raw.main_version_id === "main" &&
      raw.object_id === storedDocument.objectId && raw.lineage_claim_id === storedDocument.lineageClaimId);
    const range = parseLiveUpdateStructRange({ clientId: raw.client_id, startClock: raw.start_clock, endClock: raw.end_clock });
    authorityIntegrity(previous === null || previous.clientId !== range.clientId || previous.endClock < range.startClock);
    previous = range;
    decodedRanges.push(range);
  }
  return { binding, current: row.lineage_state === "current", open: row.admission_state === "open",
    replacesLineageClaimId: row.replaces_lineage_claim_id as string | null,
    baselineSequence, baselineDigest, baselineBytes: bytes, projectedDigest: projectionDigest,
    projectedLength: projectionLength, ranges: decodedRanges, registeredAtMs };
}

export function canonicalLiveSelector(share: SyncRelayShareRow, selector: ShareSelector): boolean {
  const raw = JSON.parse(share.selectorJson) as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "paths") || !Object.hasOwn(raw, "versionId")) return false;
  return new Set(selector.paths).size === selector.paths.length && selector.paths.every(path => {
    const checked = validateUserWritePath(path);
    return checked.ok && checked.normalized === path;
  });
}

export function resolveCurrentLiveDocumentBinding(storage: StorageContext, input: CurrentLiveBindingRequest, activation?: ServiceActivationAccess): CurrentLiveBindingResult {
    const request = snapshotCurrentBindingRequest(input);
    return storage.readLiveAuthority(() => currentLiveDocumentBinding(storage, request, activation));
  }

export type LiveObjectHostBindingResult =
  | { readonly kind: "current"; readonly binding: LiveObjectBinding; readonly host: LiveHostConnectionCoordinate }
  | Extract<CurrentLiveBindingResult, { kind: "refused" }>;

export function resolveLiveObjectHostBinding(storage: StorageContext, value: LiveBrowserContext, requestedObjectId: string): LiveObjectHostBindingResult {
  const scope = snapshotLiveTicketScope(value), objectId = parseLiveUpdateIdentifier(requestedObjectId, "object ID");
  return storage.readLiveAuthority(() => {
    if (!ticketScopeIsCurrent(storage, scope)) return { kind: "refused", reason: "not-authorized" };
    const row = storage.db.prepare(`SELECT lineage_claim_id FROM sync_relay_live_documents
      WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current' LIMIT 1`).get(scope.workspaceId, objectId);
    if (!row) return { kind: "refused", reason: "stale-document" };
    const document = { workspaceId: scope.workspaceId, mainVersionId: "main", objectId,
      lineageClaimId: parseLiveUpdateDigest(row.lineage_claim_id) };
    if (scope.kind === "named") {
      const current = currentLiveDocumentBinding(storage, { document, actor: liveBrowserActor(scope) });
      return current.kind === "current" ? { kind: "current", binding: current.binding, host: current.host } : current;
    }
    const host = readLiveHostControl(storage.db);
    if (host !== null) assertCurrentAuthorityHost(storage.db, host);
    if (host === null || host.admissionState !== "open" || host.transition !== null) return { kind: "refused", reason: "host-unavailable" };
    const link = currentLinkEdit(storage, liveBrowserActor(scope));
    if (!link) return { kind: "refused", reason: "not-authorized" };
    const bound = bindLiveDocument(storage, document, readLiveDocumentAuthority(storage.db, document), link.share, link.effectiveSelector);
    if (bound.kind !== "bound") return bound;
    return { kind: "current", binding: bound.binding,
      host: { mode: host.configuredMode, hostId: host.configuredHostId, hostEpoch: host.hostEpoch,
        instanceId: host.registeredInstanceId!, connectionId: host.registeredConnectionId! } };
  });
}

function currentLinkEdit(storage: StorageContext, actor: Extract<CurrentLiveBindingRequest["actor"], { kind: "link" }>) {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid link authority clock.");
  const enrollment = readLinkEnrollment(storage, actor, now);
  if (!enrollment || enrollment.authority.session_id !== actor.sessionId || enrollment.authority.grant_id !== actor.grantId ||
    enrollment.authority.workspace_id !== actor.workspaceId || linkWriteRefusal(enrollment)) return null;
  const authorized = authorizeLinkShareAction({ storage, grantId: actor.grantId, action: "live-edit" });
  if (!authorized.ok || !isLiveEditShareSelector(authorized.effectiveSelector)) return null;
  return { ...authorized, enrollment };
}

function parseStoredLiveTicket(row: Record<string, unknown>): { claims: LiveTicketClaims; redeemedAtMs: number | null } {
  try {
    for (const column of LIVE_TICKET_COLUMNS) {
      const value = row[column];
      if ((column === "redeemed_at_ms" || column === "link_session_id") && value === null) continue;
      if (LIVE_TICKET_INTEGER_COLUMNS.has(column)) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
      } else if (typeof value !== "string") throw new Error();
    }
    parseTicketHash(row.token_hash);
    if ((row.principal_kind !== "named" && row.principal_kind !== "link") || row.main_version_id !== "main" || Number(row.restore_fence_generation) < 1) throw new Error();
    if (row.principal_kind === "named" ? row.link_session_id !== null :
      parseLiveUpdateIdentifier(row.link_session_id, "link session ID") !== row.link_session_id) throw new Error();
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

function snapshotTicketLookup(input: Record<string, unknown>): LiveTicketLookup {
  return { tokenHash: parseTicketHash(input.tokenHash), audience: parseLiveTicketAudience(input.audience),
    scope: snapshotLiveTicketScope(input.scope) };
}

export function ticketScopeIsCurrent(storage: StorageContext, scope: LiveBrowserContext): boolean {
    const grant = storage.getShareGrant(scope.grantId);
    const share = grant && storage.getShare(grant.shareId);
    return !!grant && grant.shareId === scope.shareId && !!share && share.workspaceId === scope.workspaceId &&
      (scope.kind === "named" ? authorizeNamedLiveEditShareGrant({ storage: storage, actorUserId: scope.userId, grantId: scope.grantId }).ok :
        currentLinkEdit(storage, liveBrowserActor(scope)) !== null);
  }

export function currentTicketAuthority(storage: StorageContext, scope: LiveBrowserContext, objectId: string, report: TicketHostReport):
    Extract<CurrentLiveBindingResult, { kind: "current" }> {
    if (report.binding.workspaceId !== scope.workspaceId || report.binding.objectId !== objectId ||
      !ticketScopeIsCurrent(storage, scope)) throw LIVE_TICKET_REFUSED;
    const current = currentLiveDocumentBinding(storage, {
      document: { workspaceId: scope.workspaceId, objectId, mainVersionId: "main", lineageClaimId: report.binding.lineageClaimId },
      actor: liveBrowserActor(scope),
    });
    if (current.kind !== "current" || current.authority.principalKind !== scope.kind || current.binding.restoreFenceGeneration === 0 ||
      JSON.stringify(current.binding) !== JSON.stringify(report.binding) ||
      JSON.stringify(current.host) !== JSON.stringify(report.connection)) throw LIVE_TICKET_REFUSED;
    return current;
  }

export function matchingTicket(storage: StorageContext, input: LiveTicketLookup, now: number): LiveTicketClaims {
    const row = storage.db.prepare(`SELECT * FROM ${LIVE_TICKET_TABLE} WHERE token_hash = ?`).get(input.tokenHash);
    if (!row) throw LIVE_TICKET_REFUSED;
    const { claims, redeemedAtMs } = parseStoredLiveTicket(row);
    if (redeemedAtMs !== null || now < claims.mintedAtMs || now >= claims.expiresAtMs || claims.audience !== input.audience ||
      claims.binding.workspaceId !== input.scope.workspaceId || claims.authority.principalKind !== input.scope.kind ||
      (input.scope.kind === "named" ? claims.authority.principalId !== input.scope.userId :
        row.link_session_id !== input.scope.sessionId ||
        currentLinkEdit(storage, liveBrowserActor(input.scope))?.enrollment.principal?.principalId !== claims.authority.principalId) ||
      claims.authority.grantId !== input.scope.grantId ||
      !ticketScopeIsCurrent(storage, input.scope)) throw LIVE_TICKET_REFUSED;
    return claims;
  }

export function readLiveTicketTarget(storage: StorageContext, input: LiveTicketLookup): { workspaceId: string; objectId: string } | null {
    const owned = snapshotTicketLookup(ticketRecord(input, ["tokenHash", "scope", "audience"]));
    return storage.ticketTransaction(now => {
      const claims = matchingTicket(storage, owned, now);
      return { workspaceId: claims.binding.workspaceId, objectId: claims.binding.objectId };
    });
  }

export function mintLiveTicket(storage: StorageContext, input: LiveTicketMint): { expiresAtMs: number } | null {
    const raw = ticketRecord(input, ["tokenHash", "scope", "audience", "objectId", "ticketId", "report"]);
    const owned = snapshotTicketLookup(raw);
    const objectId = parseLiveUpdateIdentifier(raw.objectId, "object ID");
    const ticketId = parseLiveUpdateIdentifier(raw.ticketId, "ticket ID");
    const report = snapshotTicketHostReport(raw.report);
    return storage.ticketTransaction((now, policy) => {
      if (now > Number.MAX_SAFE_INTEGER - LIVE_TICKET_LIFETIME_MS) throw LIVE_TICKET_REFUSED;
      if (owned.scope.kind === "link") {
        const actor = liveBrowserActor(owned.scope);
        const link = currentLinkEdit(storage, actor);
        if (!link || !ticketScopeIsCurrent(storage, owned.scope) || linkPrincipalLimitReached(storage, link.enrollment)) throw LIVE_TICKET_REFUSED;
        const principalId = link.enrollment.principal?.principalId ?? parseLiveUpdateIdentifier(storage.newDiscussionId(), "link principal ID");
        if (!link.enrollment.principal) assertWorkspaceQuota(storage, owned.scope.workspaceId,
          linkPrincipalStorageBytes(principalId, owned.scope.grantId, owned.scope.profileTokenHash));
        commitLinkEnrollment(storage, { ...owned.scope, enrollment: link.enrollment, principalId,
          displayName: null, createdAtMs: now, discussionRevision: link.enrollment.principal ? Number(link.enrollment.authority.discussion_revision) : nextShareDiscussionRevision(storage, owned.scope.shareId) });
      }
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
        WHERE workspace_id = ? AND principal_kind = ? AND principal_id = ? AND grant_id = ? AND expires_at_ms > ?
        ORDER BY expires_at_ms, ticket_id LIMIT ?
      )`).get(owned.scope.workspaceId, claims.authority.principalKind, claims.authority.principalId, owned.scope.grantId, now, policy.retainedTicketsPerPrincipalGrant);
      if (!count || Number(count.retained_count) >= policy.retainedTicketsPerPrincipalGrant) throw LIVE_TICKET_REFUSED;
      storage.db.prepare(`INSERT INTO ${LIVE_TICKET_TABLE} (${LIVE_TICKET_COLUMNS.join(", ")})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
        claims.ticketId, owned.tokenHash, claims.audience, claims.binding.workspaceId, claims.binding.mainVersionId,
        claims.binding.objectId, claims.binding.lineageClaimId, claims.binding.currentPath, JSON.stringify(claims.binding.selectorPaths),
        claims.binding.restoreFenceGeneration, claims.authority.principalKind, claims.authority.principalId,
        claims.authority.grantId, claims.authority.grantGeneration, claims.hostEpoch, claims.mintedAtMs, claims.expiresAtMs,
        owned.scope.kind === "link" ? owned.scope.sessionId : null,
      );
      return { expiresAtMs: claims.expiresAtMs };
    });
  }

export function redeemLiveTicket(storage: StorageContext, input: LiveTicketRedemption): RedeemedLiveTicket | null {
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

export function registerLiveDocumentBaseline(storage: StorageContext, input: LiveDocumentBaselineRegistrationInput): RelayBaselineRegistrationResult {
    return registerBaseline(storage, input, operation => storage.tx(operation));
  }

export function registerLiveDocumentBaselineInTransaction(storage: StorageContext, input: LiveDocumentBaselineRegistrationInput): RelayBaselineRegistrationResult {
    return registerBaseline(storage, input, operation => operation());
  }

function registerBaseline(storage: StorageContext, input: LiveDocumentBaselineRegistrationInput, run: (operation: () => RelayBaselineRegistrationResult) => RelayBaselineRegistrationResult): RelayBaselineRegistrationResult {
    let outer: Record<string, unknown>;
    try { outer = baselineRecord(input, ["host", "evidence", "baselineBytes", "registeredAtMs"]); }
    catch { return { kind: "refused", reason: "invalid-baseline" }; }
    let coordinate: LiveHostConnectionCoordinate;
    try { coordinate = snapshotHostCoordinate(baselineRecord(outer.host, ["mode", "hostId", "hostEpoch", "instanceId", "connectionId"])); }
    catch { return { kind: "refused", reason: "stale-host" }; }
    let owned: LiveDocumentBaselineRegistrationInput;
    try { owned = snapshotBaseline(outer, coordinate); }
    catch { return { kind: "refused", reason: "invalid-baseline" }; }
    const { evidence, baselineBytes, registeredAtMs } = owned;
    const { document, currentPath, checkpoint } = evidence;
    return run(() => {
      const host = readLiveHostControl(storage.db);
      if (host !== null) assertCurrentAuthorityHost(storage.db, host);
      if (host === null || host.admissionState !== "open" || host.transition !== null) {
        return { kind: "refused", reason: "host-unavailable" };
      }
      if (host.configuredMode !== coordinate.mode || host.configuredHostId !== coordinate.hostId ||
        host.hostEpoch !== coordinate.hostEpoch || host.registeredInstanceId !== coordinate.instanceId ||
        host.registeredConnectionId !== coordinate.connectionId) return { kind: "refused", reason: "stale-host" };
      const latest = currentLiveDocumentMoment(storage, document, currentPath);
      if (!latest || latest.blob_sha256 !== evidence.projectedMarkdownSha256 ||
        latest.byte_length !== evidence.projectedMarkdownByteLength) return { kind: "refused", reason: "stale-document" };
      const history = storage.db.prepare(`SELECT * FROM sync_relay_live_documents
        WHERE workspace_id = ? AND main_version_id = ? AND object_id = ? ORDER BY lineage_claim_id`)
        .all(document.workspaceId, document.mainVersionId, document.objectId)
        .map(row => decodeLiveDocumentAuthority(storage.db, document, row));
      const current = history.find(row => row.current);
      if (history.length > 0) {
        if (!current || current.binding.lineageClaimId !== document.lineageClaimId) {
          return { kind: "refused", reason: "lineage-conflict" };
        }
        if (!current.open || current.replacesLineageClaimId !== null || current.binding.currentPath !== currentPath ||
          current.baselineSequence !== latest.relay_seq || current.projectedDigest !== evidence.projectedMarkdownSha256 ||
          current.projectedLength !== evidence.projectedMarkdownByteLength || current.baselineDigest !== checkpoint.updateDigest ||
          Buffer.compare(current.baselineBytes, baselineBytes) !== 0 ||
          current.ranges.length !== checkpoint.ranges.length || current.ranges.some((range, index) => {
            const expected = checkpoint.ranges[index]!;
            return range.clientId !== expected.clientId || range.startClock !== expected.startClock || range.endClock !== expected.endClock;
          })) return { kind: "refused", reason: "baseline-conflict" };
        return { kind: "registered", document: { ...document }, currentPath,
          restoreFenceGeneration: current.binding.restoreFenceGeneration, registeredAtMs: current.registeredAtMs, replayed: true };
      }
      prepareLiveDeliveryWorkspace(storage, document.workspaceId, coordinate.hostId);
      const metadata = [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId,
        null, currentPath, latest.relay_seq as number, evidence.projectedMarkdownSha256,
        evidence.projectedMarkdownByteLength, checkpoint.updateDigest, 'current', 'open', 1, registeredAtMs, null];
      const rangePrefix = [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
      const rangeBytes = checkpoint.ranges.reduce((sum, range) => sum + Buffer.byteLength(JSON.stringify([
        ...rangePrefix, range.clientId, range.startClock, range.endClock,
      ])), 0);
      // Charge logical stored values, excluding SQLite pages and indexes.
      const charge = baselineBytes.byteLength + Buffer.byteLength(JSON.stringify(metadata)) + rangeBytes;
      assertWorkspaceQuota(storage, document.workspaceId, charge);
      storage.db.prepare(`INSERT INTO sync_relay_live_documents (
        workspace_id, main_version_id, object_id, lineage_claim_id, replaces_lineage_claim_id, current_path,
        baseline_moment_relay_seq, baseline_projected_sha256, baseline_projected_byte_length, baseline_digest,
        lineage_state, admission_state, restore_fence_generation, registered_at_ms, retired_at_ms, baseline_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...metadata, baselineBytes);
      const insertRange = storage.db.prepare(`INSERT INTO sync_relay_live_document_baseline_ranges
        (workspace_id, main_version_id, object_id, lineage_claim_id, client_id, start_clock, end_clock)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const range of checkpoint.ranges) {
        insertRange.run(...rangePrefix, range.clientId, range.startClock, range.endClock);
      }
      storage.db.prepare(`UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + ? WHERE workspace_id = ?`)
        .run(charge, document.workspaceId);
      registerLiveDeliveryBaseline(storage, document, coordinate.hostId);
      return { kind: "registered", document: { ...document }, currentPath,
        restoreFenceGeneration: 1, registeredAtMs, replayed: false };
    });
  }

export function currentLiveDocumentMoment(storage: StorageContext, document: LiveDocumentKey, currentPath: string): Record<string, unknown> | undefined {
    const latest = storage.db.prepare(`SELECT path, content_kind, blob_sha256, byte_length, relay_seq, recorded_at_ms FROM sync_relay_object_moments
      WHERE workspace_id = ? AND object_id = ? AND version_id = 'main' ORDER BY relay_seq DESC LIMIT 1`)
      .get(document.workspaceId, document.objectId);
    if (!latest || latest.path !== currentPath || latest.content_kind !== "text" ||
      typeof latest.blob_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(latest.blob_sha256) ||
      typeof latest.byte_length !== "number" || !Number.isSafeInteger(latest.byte_length) || latest.byte_length < 0 ||
      typeof latest.relay_seq !== "number" || !Number.isSafeInteger(latest.relay_seq) || latest.relay_seq <= storage.getEpochLogFloor(document.workspaceId) ||
      typeof latest.recorded_at_ms !== "number" || !Number.isSafeInteger(latest.recorded_at_ms) || latest.recorded_at_ms < 0 ||
      storage.objectIdAtPathInVersion({ workspaceId: document.workspaceId, versionId: "main", path: currentPath }) !== document.objectId) return undefined;
    return latest;
  }

export function currentLiveDocumentBinding(storage: StorageContext, { document, actor }: CurrentLiveBindingRequest, activation?: ServiceActivationAccess): CurrentLiveBindingResult {
    const host = readLiveHostControl(storage.db);
    if (host !== null) assertCurrentAuthorityHost(storage.db, host);
    if (host === null || host.admissionState !== "open" || host.transition !== null) {
      return { kind: "refused", reason: "host-unavailable" };
    }
    authorityIntegrity(host.registeredInstanceId !== null && host.registeredConnectionId !== null);
    const stored = readLiveDocumentAuthority(storage.db, document);
    return authorizeLiveDocument(storage, { document, actor }, host, stored, activation);
  }

export function authorizeLiveDocument(storage: StorageContext, { document, actor }: CurrentLiveBindingRequest, host: HostControlSnapshot,
    stored: Pick<StoredLiveDocumentAuthority,"binding"|"current"|"open"|"baselineSequence"> | null, activation?: ServiceActivationAccess): CurrentLiveBindingResult {
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
    } else if (actor.kind === "link") {
      const link = currentLinkEdit(storage, actor);
      if (!link?.enrollment.principal || link.enrollment.sessionPrincipalId !== link.enrollment.principal.principalId) {
        return { kind: "refused", reason: "not-authorized" };
      }
      share = link.share;
      selector = link.effectiveSelector;
      authority = parseServerDerivedLiveUpdateAuthority({ principalKind: "link", principalId: link.enrollment.principal.principalId,
        grantId: link.grant.grantId, grantGeneration: link.grant.generation });
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
    const bound = bindLiveDocument(storage, document, stored, share, selector);
    if (bound.kind !== "bound") return bound;
    const { binding } = bound;
    const coordinate = { mode: host.configuredMode, hostId: host.configuredHostId, hostEpoch: host.hostEpoch,
      instanceId: host.registeredInstanceId!, connectionId: host.registeredConnectionId! };
    if (!allowsServiceActivation(storage, {document, actor}, coordinate, binding, activation)) return {kind: "refused", reason: "host-unavailable"};
    return { kind: "current", binding, authority, host: coordinate };
  }

function bindLiveDocument(storage: StorageContext, document: LiveDocumentKey,
  stored: Pick<StoredLiveDocumentAuthority, "binding" | "current" | "open" | "baselineSequence"> | null,
  share: SyncRelayShareRow, selector: ShareSelector):
  { kind: "bound"; binding: LiveObjectBinding } | Extract<CurrentLiveBindingResult, { kind: "refused" }> {
    if (!stored || !stored.current || !stored.open || stored.binding.lineageClaimId !== document.lineageClaimId ||
      stored.baselineSequence <= storage.getEpochLogFloor(document.workspaceId)) {
      return { kind: "refused", reason: "stale-document" };
    }
    if (!currentLiveDocumentMoment(storage, document, stored.binding.currentPath)) {
      return { kind: "refused", reason: "stale-document" };
    }
    if (share.workspaceId !== document.workspaceId) return { kind: "refused", reason: "not-authorized" };
    if (!canonicalLiveSelector(share, selector) || visibleSharePath(selector, stored.binding.currentPath) !== stored.binding.currentPath) {
      return { kind: "refused", reason: "stale-selector" };
    }
    let binding: LiveObjectBinding;
    try { binding = parseLiveObjectBinding({ ...stored.binding, selectorPaths: selector.paths }); }
    catch { return { kind: "refused", reason: "stale-selector" }; }
    return { kind: "bound", binding };
}
