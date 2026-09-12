import { createHash } from "node:crypto";
import { parseAppPublicationCandidate, type AppPublicationCandidate, type AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { effectiveShareSelector, parseStoredAnyShareSelectorJson, targetVersionId, visibleSharePath } from "../shareFilter";
import { notFound, badRequest, relayError } from "../errors";
import { assertWorkspaceQuota } from "./workspaces";
import type { StorageContext } from "./context";

export interface PublicationOwner { workspaceId: string; shareId: string; grantId: string; generation: number; ownerUserId: string }
export interface PublishAppPublicationInput extends PublicationOwner {
  candidate: unknown;
  blobs: readonly { sha256: string; bytes: Uint8Array }[];
  limits: AppPublicationLimits;
  nowMs: number;
}
export interface AppPublicationRow {
  publicationId: string; candidate: AppPublicationCandidate; owner: PublicationOwner;
  active: boolean; authorityRevision: number; createdAtMs: number;
}
export type AppPublicationState = Omit<AppPublicationRow, "candidate">;
export interface ReadAppPublicationInput { workspaceId: string; publicationId: string; ownerUserId: string; limits: AppPublicationLimits }
export interface WithdrawAppPublicationInput extends Omit<ReadAppPublicationInput, "limits"> { expectedAuthorityRevision: number }
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
function validateBuildIdentity(candidate: AppPublicationCandidate): void {
  const sourceDigest = digest("dohc-app-source-v2", {entry: candidate.entryPath, files: candidate.inputs,
    packages: Object.entries(candidate.packageMap).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)});
  const dependencies = new Set(candidate.dependencies);
  const dependencyLockDigest = digest("dohc-app-dependencies-v1", candidate.inputs.filter(file => dependencies.has(file.path)));
  const bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
  const buildDigest = digest("dohc-app-build-v1", {sourceDigest, dependencyLockDigest, compiler: candidate.compilerIdentity, bundleDigest});
  if (candidate.sourceDigest !== sourceDigest || candidate.dependencyLockDigest !== dependencyLockDigest || candidate.bundleDigest !== bundleDigest || candidate.buildDigest !== buildDigest) {
    throw badRequest("Publication build identity mismatch.");
  }
}
const integer = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw badRequest("Invalid publication integer.");return value; };
function authority(storage: StorageContext, owner: PublicationOwner, candidate?: AppPublicationCandidate): void {
  const share = storage.getShare(owner.shareId), grant = storage.getShareGrant(owner.grantId);
  if (!share || !grant || !storage.workspaceIsOwnedBy(owner.workspaceId, owner.ownerUserId) || share.workspaceId !== owner.workspaceId ||
      share.granterUserId !== owner.ownerUserId || grant.shareId !== share.shareId || grant.status !== "active" || grant.revokedAtMs !== null ||
      grant.generation !== owner.generation || !Number.isSafeInteger(owner.generation) || owner.generation < 1) throw notFound();
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson), selector = parsed && effectiveShareSelector(parsed, grant.access);
  if (!selector || "kind" in selector) throw notFound();
  if (candidate && (targetVersionId(selector) !== candidate.versionId || visibleSharePath(selector, candidate.appRoot) !== candidate.appRoot ||
      candidate.inputs.some(file => visibleSharePath(selector, file.path) !== file.path))) throw notFound();
}
function put(storage: StorageContext, workspace: string, hash: string, bytes: Uint8Array, now: number): void {
  if (sha(bytes) !== hash) throw badRequest("Publication blob digest mismatch.");
  const old = storage.getBlob(workspace, hash);
  if (old) {if (old.byteLength !== bytes.byteLength || sha(old) !== hash) throw badRequest("Stored publication blob is corrupt.");return;}
  assertWorkspaceQuota(storage, workspace, bytes.byteLength);
  storage.db.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content,created_at_ms) VALUES(?,?,?,?,?)").run(workspace, hash, bytes.byteLength, Buffer.from(bytes), now);
}
function header(storage: StorageContext, publicationId: string, workspaceId: string, ownerUserId: string) {
  const row = storage.db.prepare("SELECT * FROM sync_relay_app_publications WHERE publication_id=?").get(publicationId);
  if (!row || row.workspace_id !== workspaceId || row.owner_user_id !== ownerUserId || !storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
  const state: AppPublicationState = {publicationId,
    owner: {workspaceId,shareId: String(row.share_id),grantId: String(row.grant_id),generation: Number(row.grant_generation),ownerUserId},
    active: row.active === 1,authorityRevision: Number(row.authority_revision),createdAtMs: Number(row.created_at_ms)};
  return {row, state};
}
function stored(storage: StorageContext, input: ReadAppPublicationInput): AppPublicationRow {
  const {row, state} = header(storage, input.publicationId, input.workspaceId, input.ownerUserId);
  const {limits} = input;
  const bytes = storage.getBlob(String(row.workspace_id), String(row.manifest_sha256));
  if (!bytes || bytes.byteLength > limits.maxMetadataBytes || sha(bytes) !== row.manifest_sha256) throw badRequest("Publication manifest is unavailable.");
  return {...state, candidate: parseAppPublicationCandidate(JSON.parse(Buffer.from(bytes).toString("utf8")), limits)};
}
export function publishAppPublication(storage: StorageContext, input: PublishAppPublicationInput): AppPublicationRow {
  const candidate = parseAppPublicationCandidate(input.candidate, input.limits);
  validateBuildIdentity(candidate);
  const owner = {workspaceId: input.workspaceId,shareId: input.shareId,grantId: input.grantId,generation: input.generation,ownerUserId: input.ownerUserId};
  const now = integer(input.nowMs), bytes = Buffer.from(JSON.stringify(candidate)), manifestHash = sha(bytes);
  const publicationId = sha(JSON.stringify(["dohc-app-publication-v1", owner, manifestHash]));
  if (!Array.isArray(input.blobs) || input.blobs.length > candidate.files.length) throw badRequest("Invalid publication blob inventory.");
  const provided = new Map<string, Uint8Array>();
  for (const blob of input.blobs) {
    const file = candidate.files.find(file => file.sha256 === blob.sha256);
    if (!file || !(blob.bytes instanceof Uint8Array) || blob.bytes.byteLength !== file.byteLength || provided.has(blob.sha256)) throw badRequest("Invalid publication blob.");
    provided.set(blob.sha256, Uint8Array.from(blob.bytes));
  }
  return storage.tx(() => {
    authority(storage, owner, candidate);
    for (const file of candidate.files) {
      const content = provided.get(file.sha256) ?? storage.getBlob(owner.workspaceId, file.sha256);
      if (!content || content.byteLength !== file.byteLength) throw badRequest("Publication bundle is incomplete.");
      put(storage, owner.workspaceId, file.sha256, content, now);
    }
    const existing = storage.db.prepare("SELECT 1 FROM sync_relay_app_publications WHERE publication_id=?").get(publicationId);
    if (existing) return stored(storage, {...owner, publicationId, limits: input.limits}); // A retry never reactivates a withdrawn publication.
    put(storage, owner.workspaceId, manifestHash, bytes, now);
    storage.db.prepare(`INSERT INTO sync_relay_app_publications(publication_id,workspace_id,share_id,grant_id,grant_generation,owner_user_id,manifest_sha256,created_at_ms,active,authority_revision)
      VALUES(?,?,?,?,?,?,?,?,1,1)`).run(publicationId,owner.workspaceId,owner.shareId,owner.grantId,owner.generation,owner.ownerUserId,manifestHash,now);
    for (const hash of new Set([manifestHash, ...candidate.files.map(file => file.sha256)])) {
      storage.db.prepare("INSERT INTO sync_relay_app_publication_blobs(publication_id,workspace_id,sha256) VALUES(?,?,?)").run(publicationId,owner.workspaceId,hash);
    }
    return {publicationId,candidate,owner,active:true,authorityRevision:1,createdAtMs:now};
  });
}
export function readAppPublication(storage: StorageContext, input: ReadAppPublicationInput): AppPublicationRow {
  return storage.readTx(() => stored(storage, input));
}
export function withdrawAppPublication(storage: StorageContext, input: WithdrawAppPublicationInput): AppPublicationState {
  return storage.tx(() => {
    const {state: current} = header(storage,input.publicationId,input.workspaceId,input.ownerUserId);
    const share = storage.getShare(current.owner.shareId);
    if (!share || share.workspaceId !== current.owner.workspaceId || share.granterUserId !== input.ownerUserId) throw notFound();
    if (current.authorityRevision !== input.expectedAuthorityRevision) throw relayError("conflict","Publication authority changed.");
    if (!current.active) return current;
    if (current.authorityRevision >= Number.MAX_SAFE_INTEGER) throw relayError("conflict","Publication authority is exhausted.");
    storage.db.prepare("UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1 WHERE publication_id=?").run(input.publicationId);
    return {...current,active:false,authorityRevision:current.authorityRevision+1};
  });
}
