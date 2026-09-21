import { createHash, randomUUID } from "node:crypto";
import { parseAppBackendCapability, type AppBackendCaller, type AppBackendCapability } from "@dohc/security-contract/app-backend";
import { parseAppPublicationCandidate, type AppPublicationCandidate, type AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { notFound, relayError } from "./errors";
import { authorizeShareAction } from "./shareAuthorization";
import { effectiveShareSelector, parseStoredAnyShareSelectorJson, targetVersionId, visibleSharePath } from "./shareFilter";
import type { StorageContext } from "./storage/context";
import { requireLinkAppPublication } from "./storage/publications";
import { commitLinkEnrollment, linkPrincipalLimitReached, linkPrincipalStorageBytes, linkWriteRefusal, readLinkEnrollment } from "./storage/linkEnrollment";
import { assertWorkspaceQuota } from "./storage/workspaces";
import { isAppBackendHelper } from "./storage/appBackendData";

export type AppBackendAuth =
  | { kind: "link"; capabilityHash: string; profileTokenHash: string }
  | { kind: "named"; workspaceId: string; userId: string; grantId?: string };
export interface BackendAuthority {
  workspaceId: string;
  publicationId: string;
  authorityRevision: number;
  candidate: AppPublicationCandidate;
  capability: AppBackendCapability;
  caller: AppBackendCaller;
  receiptCaller: { grantId: string; principalId: string };
}
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export function backendCapability(candidate: AppPublicationCandidate): AppBackendCapability {
  const requested = (candidate.capabilities as readonly {kind: string}[]).find(value => value.kind === "app-backend");
  if (!requested) throw notFound();
  return parseAppBackendCapability(requested);
}

/** Call inside the host's transaction. Enrollment is allowed only in a write transaction. */
export function requireBackendAuthority(storage: StorageContext, limits: AppPublicationLimits, auth: AppBackendAuth,
  publicationId: string, authorityRevision: number | undefined, nowMs: number, enroll = false): BackendAuthority {
  if (auth.kind === "link") {
    const input = {...auth, publicationId, limits, nowMs, expectedAuthorityRevision: authorityRevision};
    const publication = requireLinkAppPublication(storage, input);
    const capability = backendCapability(publication.candidate);
    const enrollment = readLinkEnrollment(storage, auth, nowMs);
    if (!enrollment || linkWriteRefusal(enrollment)) throw notFound();
    let principal = enrollment.principal;
    if (!principal && enroll) {
      if (linkPrincipalLimitReached(storage, enrollment)) throw relayError("quota_exceeded", "App participant limit reached.");
      const principalId = randomUUID();
      assertWorkspaceQuota(storage, publication.workspaceId, linkPrincipalStorageBytes(principalId, publication.result.grantId, auth.profileTokenHash));
      principal = commitLinkEnrollment(storage, {...auth, enrollment, principalId, displayName: null,
        createdAtMs: nowMs, discussionRevision: Number(enrollment.authority.discussion_revision)});
    }
    if (!principal) throw notFound();
    return {workspaceId: publication.workspaceId, publicationId, authorityRevision: publication.result.descriptor.authorityRevision,
      candidate: publication.candidate, capability, caller: {kind: "link", principalId: principal.principalId, grantId: publication.result.grantId},
      receiptCaller: {grantId: publication.result.grantId, principalId: principal.principalId}};
  }
  const row = storage.db.prepare("SELECT * FROM sync_relay_app_publications WHERE publication_id=? AND workspace_id=?")
    .get(publicationId, auth.workspaceId);
  if (!row) throw notFound();
  const owner = {workspaceId: auth.workspaceId, shareId: String(row.share_id), grantId: String(row.grant_id), generation: Number(row.grant_generation), ownerUserId: String(row.owner_user_id)};
  if (!storage.workspaceIsOwnedBy(owner.workspaceId, owner.ownerUserId)) throw notFound();
  const manifest = storage.getBlob(auth.workspaceId, String(row.manifest_sha256));
  if (!manifest || manifest.byteLength > limits.maxMetadataBytes || sha(manifest) !== row.manifest_sha256) throw notFound();
  const candidate = parseAppPublicationCandidate(JSON.parse(Buffer.from(manifest).toString("utf8")), limits);
  const publication = {active: row.active === 1, authorityRevision: Number(row.authority_revision)};
  const share = storage.getShare(owner.shareId), grant = storage.getShareGrant(owner.grantId);
  const parsed = share && parseStoredAnyShareSelectorJson(share.selectorJson);
  const selector = parsed && grant && effectiveShareSelector(parsed, grant.access);
  if (!publication.active || (authorityRevision !== undefined && publication.authorityRevision !== authorityRevision) ||
      !share || share.workspaceId !== auth.workspaceId || share.granterUserId !== owner.ownerUserId ||
      !grant || grant.shareId !== share.shareId || grant.status !== "active" || grant.revokedAtMs !== null || grant.generation !== owner.generation ||
      !selector || "kind" in selector || targetVersionId(selector) !== candidate.versionId ||
      visibleSharePath(selector, candidate.appRoot) !== candidate.appRoot || candidate.inputs.some(file => visibleSharePath(selector, file.path) !== file.path)) throw notFound();
  const manifestHash = sha(JSON.stringify(candidate));
  if (sha(JSON.stringify(["dohc-app-publication-v1", owner, manifestHash])) !== publicationId) throw notFound();
  const capability = backendCapability(candidate);
  let caller: AppBackendCaller;
  if (auth.userId === owner.ownerUserId && storage.workspaceIsOwnedBy(auth.workspaceId, auth.userId)) caller = {kind: "owner", userId: auth.userId};
  else {
    const authorized = authorizeShareAction({storage, actorUserId: auth.userId, shareId: owner.shareId, action: "read"});
    if (!authorized.ok || (auth.grantId !== undefined && auth.grantId !== authorized.grant.grantId) ||
        "kind" in authorized.effectiveSelector || targetVersionId(authorized.effectiveSelector) !== candidate.versionId ||
        visibleSharePath(authorized.effectiveSelector, candidate.appRoot) !== candidate.appRoot) throw notFound();
    const access = authorized.grant.access;
    if (access !== "view" && access !== "comment" && access !== "edit") throw notFound();
    caller = {kind: "named", userId: auth.userId, grantId: authorized.grant.grantId, access,
      helper: isAppBackendHelper(storage, {workspaceId: auth.workspaceId, dataPath: capability.dataPath, grantId: authorized.grant.grantId})};
  }
  return {workspaceId: auth.workspaceId, publicationId, authorityRevision: publication.authorityRevision, candidate, capability, caller,
    receiptCaller: {grantId: caller.kind === "owner" ? "owner" : caller.grantId, principalId: auth.userId}};
}

export function requireBackendOwner(authority: BackendAuthority): void {
  if (authority.caller.kind !== "owner") throw notFound();
}

export function backendArtifact(storage: StorageContext, authority: BackendAuthority, path: string, expectedHash: string): string {
  const file = authority.candidate.files.find(file => file.path === path && file.sha256 === expectedHash);
  if (!file || file.byteLength > 1024 * 1024) throw notFound();
  const bytes = storage.getBlob(authority.workspaceId, expectedHash);
  if (!bytes || bytes.byteLength !== file.byteLength || sha(bytes) !== expectedHash) throw notFound();
  return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
}
