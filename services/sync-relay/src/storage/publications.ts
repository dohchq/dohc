import { createHash } from "node:crypto";
import { parseAppPublicationCandidate, parseAppCollectionCapability, type AppCollectionCapability, type AppPublicationCandidate, type AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { parseAppDatasetCapability, type AppDatasetCapability } from "@dohc/security-contract/dataset";

import { effectiveShareSelector, parseStoredAnyShareSelectorJson, targetVersionId, visibleSharePath } from "../shareFilter";
import { notFound, badRequest, relayError, RelayError } from "../errors";
import { assertWorkspaceQuota } from "./workspaces";
import type { StorageContext } from "./context";
import type { PublicEditRelease } from "@dohc/security-contract";
import { authorizeLinkShareAction } from "../shareAuthorization";
import { isPublicLinkAccess } from "../linkSecurity";
import { readLinkEnrollment } from "./linkEnrollment";
import { readCurrentShareGrant } from "./currentShareGrant";

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
export interface ReactivateAppPublicationInput extends ReadAppPublicationInput { expectedAuthorityRevision: number }
export interface LinkAppPublicationInput {
  publicationId: string;
  // Derived from an authenticated link session. Never accepted from a request body.
  capabilityHash: string;
  profileTokenHash: string;
  nowMs: number;
  limits: AppPublicationLimits;
  expectedAuthorityRevision?: number;
  publicEditRelease?: PublicEditRelease;
}
export interface LinkAppPublicationDescriptor {
  publicationId: string;
  authorityRevision: number;
  files: AppPublicationCandidate["files"];
}
export interface LinkAppPublicationAuthority {
  descriptor: LinkAppPublicationDescriptor;
  shareId: string;
  grantId: string;
  generation: number;
  sessionId: string;
  principalId: string | null;
  expiresAtMs: number;
}
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
  const current = readCurrentShareGrant(storage, {grantId: owner.grantId, generation: owner.generation});
  if (!current || current.share.shareId !== owner.shareId || current.share.workspaceId !== owner.workspaceId ||
      current.share.granterUserId !== owner.ownerUserId) throw notFound();
  const {share, grant} = current;
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
class PublicationManifestUnavailable extends RelayError {
  constructor() {super("bad_request", "Publication manifest is unavailable.");}
}
function stored(storage: StorageContext, input: ReadAppPublicationInput): AppPublicationRow {
  const {row, state} = header(storage, input.publicationId, input.workspaceId, input.ownerUserId);
  const {limits} = input;
  const bytes = storage.getBlob(String(row.workspace_id), String(row.manifest_sha256));
  if (!bytes || bytes.byteLength > limits.maxMetadataBytes || sha(bytes) !== row.manifest_sha256) throw new PublicationManifestUnavailable();
  try {return {...state, candidate: parseAppPublicationCandidate(JSON.parse(Buffer.from(bytes).toString("utf8")), limits)};}
  catch {throw new PublicationManifestUnavailable();}
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

export interface ListAppPublicationsInput {
  workspaceId: string;
  ownerUserId: string;
  limits: AppPublicationLimits;
  cursor?: string;
  appRoot?: string;
}
export type AppPublicationListRow = {
  publicationId: string; authorityRevision: number; shareId: string; grantId: string; active: boolean; linkCurrent: boolean; collectionCapability: AppCollectionCapability | "unavailable" | null; datasetCapability: AppDatasetCapability | "unavailable" | null;
} & ({manifestUnavailable: false; appRoot: string; sourceRevision: string} | {manifestUnavailable: true});

function publicationLinkIsCurrent(storage: StorageContext, owner: PublicationOwner): boolean {
  try { authority(storage, owner); return true; }
  catch (error) { if (error instanceof RelayError && error.code === "not_found") return false; throw error; }
}

export function listAppPublications(storage: StorageContext, input: ListAppPublicationsInput) {
  return storage.readTx(() => {
    if (!storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) throw notFound();
    const rows = storage.db.prepare(`SELECT p.publication_id,a.capability_json FROM sync_relay_app_publications p
      LEFT JOIN sync_relay_app_collection_approvals a ON a.publication_id=p.publication_id AND a.workspace_id=p.workspace_id AND a.active=1
      WHERE p.workspace_id=? AND p.owner_user_id=? AND p.publication_id>? ORDER BY p.publication_id LIMIT 26`)
      .all(input.workspaceId, input.ownerUserId, input.cursor ?? "");
    const publications = rows.slice(0, 25).flatMap<AppPublicationListRow>(row => {
      const publicationId = String(row.publication_id);
      let collectionCapability: AppPublicationListRow["collectionCapability"] = null;

      let datasetCapability: AppPublicationListRow["datasetCapability"] = null;
      if (row.capability_json !== null) {
        try { collectionCapability = parseAppCollectionCapability(JSON.parse(String(row.capability_json))); }
        catch { collectionCapability = "unavailable"; }
      }
      try {
        const publication = stored(storage, {...input, publicationId});
        if (input.appRoot !== undefined && publication.candidate.appRoot !== input.appRoot) return [];
        const capability = publication.candidate.capabilities[0];

        if (capability?.kind === "dataset") datasetCapability = parseAppDatasetCapability(capability);
        return [{publicationId, authorityRevision: publication.authorityRevision, manifestUnavailable: false,
          shareId: publication.owner.shareId, grantId: publication.owner.grantId, appRoot: publication.candidate.appRoot,
          sourceRevision: publication.candidate.sourceRevision, active: publication.active, linkCurrent: publicationLinkIsCurrent(storage, publication.owner), collectionCapability, datasetCapability}];
      } catch (error) {
        if (!(error instanceof PublicationManifestUnavailable)) throw error;
        const {state} = header(storage, publicationId, input.workspaceId, input.ownerUserId);
        return [{publicationId, authorityRevision: state.authorityRevision, manifestUnavailable: true,
          shareId: state.owner.shareId, grantId: state.owner.grantId, active: state.active, linkCurrent: publicationLinkIsCurrent(storage, state.owner), collectionCapability, datasetCapability: null}];
      }
    });
    return {publications, nextCursor: rows.length > 25 ? String(rows[24]!.publication_id) : null};
  });
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

export function reactivateAppPublication(storage: StorageContext, input: ReactivateAppPublicationInput): AppPublicationState {
  return storage.tx(() => {
    const {state: current} = header(storage, input.publicationId, input.workspaceId, input.ownerUserId);
    if (current.authorityRevision !== input.expectedAuthorityRevision) throw relayError("conflict", "Publication authority changed.");
    const candidate = stored(storage, input).candidate;
    authority(storage, current.owner, candidate);
    validateBuildIdentity(candidate);
    const manifestHash = sha(JSON.stringify(candidate));
    if (sha(JSON.stringify(["dohc-app-publication-v1", current.owner, manifestHash])) !== current.publicationId) throw badRequest("Publication identity mismatch.");
    for (const file of candidate.files) {
      const bytes = storage.getBlob(current.owner.workspaceId, file.sha256);
      if (!bytes || bytes.byteLength !== file.byteLength || sha(bytes) !== file.sha256) throw badRequest("Publication bundle is unavailable.");
    }
    if (current.active) return current;
    if (current.authorityRevision >= Number.MAX_SAFE_INTEGER) throw relayError("conflict", "Publication authority is exhausted.");
    storage.db.prepare("UPDATE sync_relay_app_publications SET active=1,authority_revision=authority_revision+1 WHERE publication_id=?").run(input.publicationId);
    return {...current, active: true, authorityRevision: current.authorityRevision + 1};
  });
}

function currentLinkPublicationPrincipal(storage: StorageContext, input: Omit<LinkAppPublicationInput, "publicationId">) {
  const enrollment = readLinkEnrollment(storage, input, input.nowMs);
  if (!enrollment || enrollment.principal?.blockedAtMs != null) throw notFound();
  const session = storage.findLinkSessionByCapabilityHash(input.capabilityHash);
  if (!session || session.capabilityHash !== input.capabilityHash || !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < 0 || session.expiresAtMs <= input.nowMs) throw notFound();
  const authorized = authorizeLinkShareAction({storage, grantId: session.grantId, action: "read"});
  if (!authorized.ok || authorized.grant.generation !== session.generation ||
      !isPublicLinkAccess(authorized.grant.access, input.publicEditRelease)) throw notFound();
  return {enrollment, session, authorized};
}

function currentLinkAppPublication(storage: StorageContext, input: LinkAppPublicationInput,
  verified?: {candidate: AppPublicationCandidate; manifestHash: string},
  principal?: ReturnType<typeof currentLinkPublicationPrincipal>) {
  const {enrollment, session, authorized} = principal ?? currentLinkPublicationPrincipal(storage, input);
  const lookup = {workspaceId: authorized.share.workspaceId, ownerUserId: authorized.share.granterUserId,
    publicationId: input.publicationId, limits: input.limits};
  const {state: publication, row} = header(storage, lookup.publicationId, lookup.workspaceId, lookup.ownerUserId);
  if (!publication.active || publication.owner.shareId !== authorized.share.shareId ||
      publication.owner.grantId !== authorized.grant.grantId || publication.owner.generation !== authorized.grant.generation ||
      !Number.isSafeInteger(publication.authorityRevision) || publication.authorityRevision < 1 ||
      (input.expectedAuthorityRevision !== undefined && input.expectedAuthorityRevision !== publication.authorityRevision)) throw notFound();
  let candidate: AppPublicationCandidate;
  if (verified) {
    if (row.manifest_sha256 !== verified.manifestHash) throw notFound();
    candidate = verified.candidate;
  } else {
    try { candidate = stored(storage, lookup).candidate; } catch (error) {
      if (error instanceof PublicationManifestUnavailable) throw notFound();
      throw error;
    }
  }
  authority(storage, publication.owner, candidate);
  const manifestHash = verified?.manifestHash ?? sha(JSON.stringify(candidate));
  if (sha(JSON.stringify(["dohc-app-publication-v1", publication.owner, manifestHash])) !== publication.publicationId) throw notFound();
  const result: LinkAppPublicationAuthority = {
    descriptor: {publicationId: publication.publicationId, authorityRevision: publication.authorityRevision,
      files: candidate.files},
    shareId: authorized.share.shareId, grantId: session.grantId, generation: session.generation,
    sessionId: session.sessionId, principalId: enrollment.principal?.principalId ?? null, expiresAtMs: session.expiresAtMs,
  };
  return {result, workspaceId: authorized.share.workspaceId, candidate, manifestHash};
}

export interface ListLinkAppPublicationsInput extends Omit<LinkAppPublicationInput, "publicationId" | "expectedAuthorityRevision"> {cursor?: string}
export function listLinkAppPublications(storage: StorageContext, input: ListLinkAppPublicationsInput) {
  return storage.readTx(() => {
    const principal = currentLinkPublicationPrincipal(storage, input);
    const {session, authorized} = principal;
    const pinned: {publicationId: string; authorityRevision: number; manifestHash: string}[] = [];
    const rows = storage.db.prepare(`SELECT publication_id FROM sync_relay_app_publications
      WHERE workspace_id=? AND grant_id=? AND grant_generation=? AND active=1 AND publication_id>?
      ORDER BY publication_id LIMIT 26`).all(authorized.share.workspaceId, session.grantId, session.generation, input.cursor ?? "");
    const publications = rows.slice(0, 25).flatMap(row => {
      try {
        const {candidate, result, manifestHash} = currentLinkAppPublication(storage, {...input, publicationId: String(row.publication_id)}, undefined, principal);
        const name = (candidate.appRoot.split("/").at(-1) ?? "App").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128) || "App";
        pinned.push({publicationId: result.descriptor.publicationId, authorityRevision: result.descriptor.authorityRevision, manifestHash});
        return [{publicationId: result.descriptor.publicationId, name}];
      } catch (error) {
        if (error instanceof RelayError && error.code === "not_found") return [];
        throw error;
      }
    });
    const page = {publications, nextCursor: rows.length > 25 ? String(rows[24]!.publication_id) : null};
    const capturedInput = {...input, limits: {...input.limits}};
    const assertCurrent = (nowMs: number) => storage.readTx(() => {
      const current = currentLinkPublicationPrincipal(storage, {...capturedInput, nowMs});
      if (current.authorized.share.workspaceId !== authorized.share.workspaceId ||
          current.authorized.share.granterUserId !== authorized.share.granterUserId ||
          current.authorized.share.shareId !== authorized.share.shareId ||
          current.authorized.share.selectorJson !== authorized.share.selectorJson ||
          current.authorized.grant.access !== authorized.grant.access ||
          current.session.grantId !== session.grantId || current.session.generation !== session.generation) throw notFound();
      for (const publication of pinned) {
        const {state, row} = header(storage, publication.publicationId, authorized.share.workspaceId, authorized.share.granterUserId);
        if (!state.active || state.authorityRevision !== publication.authorityRevision ||
            state.owner.shareId !== authorized.share.shareId || state.owner.grantId !== session.grantId ||
            state.owner.generation !== session.generation || row.manifest_sha256 !== publication.manifestHash) throw notFound();
      }
    });
    return {page, assertCurrent};
  });
}

/** Call within the caller's read or write transaction. */
export function requireLinkAppPublication(storage: StorageContext, input: LinkAppPublicationInput) {
  return currentLinkAppPublication(storage, input);
}

/** Retain only verified immutable content; every invocation still rechecks current authority. */
export function createLinkAppPublicationGuard(storage: StorageContext, input: LinkAppPublicationInput): (nowMs: number) => void {
  const capturedInput = {...input, limits: {...input.limits}};
  const captured = storage.readTx(() => currentLinkAppPublication(storage, capturedInput));
  const pinned = {...capturedInput, expectedAuthorityRevision: captured.result.descriptor.authorityRevision};
  return nowMs => storage.readTx(() => {
    currentLinkAppPublication(storage, {...pinned, nowMs}, captured);
  });
}

/** Shared by launch admission and protected reads; all standing comes from current server state. */
export function authorizeLinkAppPublication(storage: StorageContext, input: LinkAppPublicationInput): LinkAppPublicationAuthority {
  return storage.readTx(() => requireLinkAppPublication(storage, input).result);
}

export function readLinkAppPublicationBlob(storage: StorageContext, input: LinkAppPublicationInput & {
  sha256: string; expectedAuthorityRevision: number;
}) {
  return storage.readTx(() => {
    const {result, workspaceId} = requireLinkAppPublication(storage, input);
    const file = result.descriptor.files.find(file => file.sha256 === input.sha256);
    if (!file) throw notFound();
    const bytes = storage.getBlob(workspaceId, file.sha256);
    if (!bytes || bytes.byteLength !== file.byteLength || sha(bytes) !== file.sha256) throw notFound();
    return {...result, file, bytes};
  });
}
