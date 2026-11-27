import { isShareAccessValue, visibleSharePath } from "@dohc/security-contract/share-selector";
import {
  parseApprovalAgent,
  type ApprovalAgent,
} from "@dohc/security-contract/approval-provenance";
import { createHash } from "node:crypto";
import {
  parseAppPublicationCandidate,
  parseAppCollectionCapability,
  type AppCollectionCapability,
  type AppPublicationCandidate,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";
import {
  parseAppDatasetCapability,
  type AppDatasetCapability,
} from "@dohc/security-contract/dataset";

import {
  effectiveShareSelector,
  MAIN_VERSION_ID,
  parseStoredAnyShareSelectorJson,
  targetVersionId,
} from "../shareFilter";
import { getWorkspaceMembership } from "./workspaceMembers";
import { notFound, badRequest, relayError, RelayError } from "../errors";
import { assertWorkspaceQuota } from "./workspaces";
import type { StorageContext } from "./context";
import type { PublicEditRelease } from "@dohc/security-contract";
import { authorizeLinkSession } from "../linkSecurity";
import { readLinkEnrollment } from "./linkEnrollment";
import { readCurrentShareGrant } from "./currentShareGrant";
import { readWorkspaceSecretForExecution } from "./workspaceSecrets";
import { workspaceSecretApprovalBinding } from "@dohc/workspace-contracts/http-step-approvals";

export interface LinkPublicationOwner {
  workspaceId: string;
  shareId: string;
  grantId: string;
  generation: number;
  ownerUserId: string;
}
/** A Workspace Publication's owner: the workspace's own share, which every member reaches through. */
export interface WorkspacePublicationOwner {
  workspaceId: string;
  shareId: string;
  ownerUserId: string;
}
/** An Owner Publication's owner, whose phones alone open it, with no share. */
export interface OwnPublicationOwner {
  workspaceId: string;
  ownerUserId: string;
}
export type PublicationOwner =
  | LinkPublicationOwner
  | WorkspacePublicationOwner
  | OwnPublicationOwner;
export const publicationAudience = (owner: PublicationOwner) =>
  "grantId" in owner
    ? ("link" as const)
    : "shareId" in owner
      ? ("workspace" as const)
      : ("owner" as const);
const OWNER_STATES = ["pending", "current", "replaced"] as const;
export type OwnerPublicationState = (typeof OWNER_STATES)[number];
const PUBLICATION_DOMAINS = {
  link: "dohc-app-publication-v1",
  workspace: "dohc-app-workspace-publication-v1",
  owner: "dohc-app-owner-publication-v1",
};
export function publicationIdOf(owner: PublicationOwner, manifestHash: string): string {
  return sha(
    JSON.stringify([PUBLICATION_DOMAINS[publicationAudience(owner)], owner, manifestHash]),
  );
}
export type PublishAppPublicationInput = PublicationOwner & {
  expectedCurrentPublicationId?: string | null;
  agent?: ApprovalAgent | null;
  candidate: unknown;
  blobs: readonly { sha256: string; bytes: Uint8Array }[];
  limits: AppPublicationLimits;
  nowMs: number;
};
export interface AppPublicationApproval {
  agent: ApprovalAgent | null;
  /** The share's selector, or null for an Owner Publication. */
  selector: unknown;
  /** The link's access, or null for a Workspace or Owner Publication, which each person reaches at their own level. */
  access: "view" | "comment" | "edit" | null;
  committedCandidateDigest: string;
  sourceRevision: string;
  capabilities: AppPublicationCandidate["capabilities"];
}
export interface AppPublicationTakedown {
  actor: "operator";
  disabledAtMs: number;
  reason: string;
}
export interface DisableAppPublicationInput {
  publicationId: string;
  reason: string;
  nowMs: number;
}
export interface AppPublicationRow {
  operatorTakedown?: AppPublicationTakedown;
  approvalProvenance?: AppPublicationApproval;
  publicationId: string;
  candidate: AppPublicationCandidate;
  owner: PublicationOwner;
  active: boolean;
  /** Pending until its Collections are bound; once replaced, kept only for the launch still running it. */
  ownerState?: OwnerPublicationState;
  authorityRevision: number;
  createdAtMs: number;
}
export type AppPublicationState = Omit<AppPublicationRow, "candidate">;
export interface ReadAppPublicationInput {
  workspaceId: string;
  publicationId: string;
  ownerUserId: string;
  limits: AppPublicationLimits;
}
export interface WithdrawAppPublicationInput extends Omit<ReadAppPublicationInput, "limits"> {
  expectedAuthorityRevision: number;
}
export interface ReactivateAppPublicationInput extends ReadAppPublicationInput {
  expectedAuthorityRevision: number;
  agent?: ApprovalAgent | null;
}
export interface LinkAppPublicationInput {
  publicationId: string;
  // Derived from an authenticated link session. Never accepted from a request body.
  capabilityHash: string;
  profileTokenHash: string;
  nowMs: number;
  limits: AppPublicationLimits;
  expectedAuthorityRevision?: number;
  publicEditRelease: PublicEditRelease | undefined;
}
export interface LinkAppPublicationDescriptor {
  publicationId: string;
  authorityRevision: number;
  files: AppPublicationCandidate["files"];
}
export interface LinkAppPublicationAuthority {
  descriptor: LinkAppPublicationDescriptor;
  workspaceId: string;
  /** The Collections the app's backend reads and writes. */
  datasetIds: string[];
  shareId: string;
  grantId: string;
  generation: number;
  sessionId: string;
  principalId: string | null;
  expiresAtMs: number;
}
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const WHOLE_WORKSPACE = { paths: [], versionId: null, wholeWorkspace: true };
const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
export function validateBuildIdentity(candidate: AppPublicationCandidate): void {
  const sourceDigest = digest("dohc-app-source-v2", {
    entry: candidate.entryPath,
    files: candidate.inputs,
    packages: Object.entries(candidate.packageMap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
  const dependencies = new Set(candidate.dependencies);
  const dependencyLockDigest = digest(
    "dohc-app-dependencies-v1",
    candidate.inputs.filter((file) => dependencies.has(file.path)),
  );
  const bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
  const buildDigest = digest("dohc-app-build-v1", {
    sourceDigest,
    dependencyLockDigest,
    compiler: candidate.compilerIdentity,
    bundleDigest,
  });
  if (
    candidate.sourceDigest !== sourceDigest ||
    candidate.dependencyLockDigest !== dependencyLockDigest ||
    candidate.bundleDigest !== bundleDigest ||
    candidate.buildDigest !== buildDigest
  ) {
    throw badRequest("Publication build identity mismatch.");
  }
}
const integer = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest("Invalid publication integer.");
  return value;
};
function authority(
  storage: StorageContext,
  owner: PublicationOwner,
  candidate?: AppPublicationCandidate,
): void {
  if (!("grantId" in owner)) {
    if (
      ("shareId" in owner
        ? getWorkspaceMembership(storage, owner.workspaceId)?.shareId !== owner.shareId ||
          storage.getShare(owner.shareId)?.granterUserId !== owner.ownerUserId
        : !storage.workspaceIsOwnedBy(owner.workspaceId, owner.ownerUserId)) ||
      (candidate &&
        (candidate.versionId !== MAIN_VERSION_ID ||
          [candidate.appRoot, ...candidate.inputs.map((file) => file.path)].some(
            (path) => visibleSharePath(WHOLE_WORKSPACE, path) !== path,
          )))
    )
      throw notFound();
    return;
  }
  const current = readCurrentShareGrant(storage, {
    grantId: owner.grantId,
    generation: owner.generation,
  });
  if (
    !current ||
    current.share.shareId !== owner.shareId ||
    current.share.workspaceId !== owner.workspaceId ||
    current.share.granterUserId !== owner.ownerUserId
  )
    throw notFound();
  const { share, grant } = current;
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson),
    selector = parsed && effectiveShareSelector(parsed, grant.access);
  if (!selector || "kind" in selector) throw notFound();
  if (
    candidate &&
    (targetVersionId(selector) !== candidate.versionId ||
      visibleSharePath(selector, candidate.appRoot) !== candidate.appRoot ||
      candidate.inputs.some((file) => visibleSharePath(selector, file.path) !== file.path))
  )
    throw notFound();
}
export function putPublicationBlob(
  storage: StorageContext,
  workspace: string,
  hash: string,
  bytes: Uint8Array,
  now: number,
): void {
  if (sha(bytes) !== hash) throw badRequest("Publication blob digest mismatch.");
  const old = storage.getBlob(workspace, hash);
  if (old) {
    if (old.byteLength !== bytes.byteLength || sha(old) !== hash)
      throw badRequest("Stored publication blob is corrupt.");
    return;
  }
  assertWorkspaceQuota(storage, workspace, bytes.byteLength);
  storage.db
    .prepare(
      "INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content,created_at_ms) VALUES(?,?,?,?,?)",
    )
    .run(workspace, hash, bytes.byteLength, Buffer.from(bytes), now);
}
function header(
  storage: StorageContext,
  publicationId: string,
  workspaceId: string,
  ownerUserId: string,
  member = false,
) {
  const row = storage.db
    .prepare(
      "SELECT p.*,m.publication_id IS NOT NULL AS member FROM sync_relay_app_publications p LEFT JOIN sync_relay_member_apps m USING(publication_id) WHERE p.publication_id=?",
    )
    .get(publicationId);
  if (
    !row ||
    row.workspace_id !== workspaceId ||
    row.owner_user_id !== ownerUserId ||
    (row.member === 1) !== member ||
    (!member && !storage.workspaceIsOwnedBy(workspaceId, ownerUserId))
  )
    throw notFound();
  const state: AppPublicationState = {
    publicationId,
    owner:
      row.audience === "link"
        ? {
            workspaceId,
            shareId: String(row.share_id),
            grantId: String(row.grant_id),
            generation: Number(row.grant_generation),
            ownerUserId,
          }
        : row.audience === "workspace"
          ? { workspaceId, shareId: String(row.share_id), ownerUserId }
          : { workspaceId, ownerUserId },
    active: row.active === 1,
    ...(row.audience === "owner"
      ? { ownerState: OWNER_STATES.find((state) => state === row.owner_state)! }
      : {}),
    authorityRevision: Number(row.authority_revision),
    createdAtMs: Number(row.created_at_ms),
  };
  const approval = storage.db
    .prepare(
      "SELECT facts_json FROM sync_relay_app_publication_approvals WHERE publication_id=? ORDER BY authority_revision DESC LIMIT 1",
    )
    .get(publicationId);
  if (approval) {
    const { secretBindings: _, ...facts } = JSON.parse(String(approval.facts_json));
    state.approvalProvenance = facts;
  }
  return { row, state };
}
function withOperatorTakedown<State extends AppPublicationState>(
  storage: StorageContext,
  state: State,
): State {
  const takedown = storage.db
    .prepare(
      "SELECT disabled_at_ms,reason FROM sync_relay_app_publication_takedowns WHERE publication_id=?",
    )
    .get(state.publicationId);
  return takedown
    ? {
        ...state,
        operatorTakedown: {
          actor: "operator",
          disabledAtMs: Number(takedown.disabled_at_ms),
          reason: String(takedown.reason),
        },
      }
    : state;
}
class PublicationManifestUnavailable extends RelayError {
  constructor() {
    super("bad_request", "Publication manifest is unavailable.");
  }
}
function stored(storage: StorageContext, input: ReadAppPublicationInput): AppPublicationRow {
  const { row, state } = header(storage, input.publicationId, input.workspaceId, input.ownerUserId);
  const { limits } = input;
  const bytes = storage.getBlob(String(row.workspace_id), String(row.manifest_sha256));
  if (!bytes || bytes.byteLength > limits.maxMetadataBytes || sha(bytes) !== row.manifest_sha256)
    throw new PublicationManifestUnavailable();
  try {
    const candidate = parseAppPublicationCandidate(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
      limits,
    );
    return { ...state, candidate };
  } catch {
    throw new PublicationManifestUnavailable();
  }
}
export function publishAppPublication(
  storage: StorageContext,
  input: PublishAppPublicationInput,
): AppPublicationRow {
  const candidate = parseAppPublicationCandidate(input.candidate, input.limits);
  validateBuildIdentity(candidate);
  const owner: PublicationOwner =
    "grantId" in input
      ? {
          workspaceId: input.workspaceId,
          shareId: input.shareId,
          grantId: input.grantId,
          generation: input.generation,
          ownerUserId: input.ownerUserId,
        }
      : "shareId" in input
        ? { workspaceId: input.workspaceId, shareId: input.shareId, ownerUserId: input.ownerUserId }
        : { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId };
  const own = publicationAudience(owner) === "owner";
  const now = integer(input.nowMs),
    bytes = Buffer.from(JSON.stringify(candidate)),
    manifestHash = sha(bytes);
  const publicationId = publicationIdOf(owner, manifestHash);
  if (!Array.isArray(input.blobs) || input.blobs.length > candidate.files.length)
    throw badRequest("Invalid publication blob inventory.");
  const provided = new Map<string, Uint8Array>();
  for (const blob of input.blobs) {
    const file = candidate.files.find((file) => file.sha256 === blob.sha256);
    if (
      !file ||
      !(blob.bytes instanceof Uint8Array) ||
      blob.bytes.byteLength !== file.byteLength ||
      provided.has(blob.sha256)
    )
      throw badRequest("Invalid publication blob.");
    provided.set(blob.sha256, Uint8Array.from(blob.bytes));
  }
  return storage.tx(() => {
    authority(storage, owner, candidate);
    for (const file of candidate.files) {
      const content = provided.get(file.sha256) ?? storage.getBlob(owner.workspaceId, file.sha256);
      if (!content || content.byteLength !== file.byteLength)
        throw badRequest("Publication bundle is incomplete.");
      putPublicationBlob(storage, owner.workspaceId, file.sha256, content, now);
    }
    const state = candidate.capabilities.length ? "pending" : "current";
    let head: string | null = null;
    if (own) {
      reclaimOwnerPublications(storage, owner.workspaceId, now);
      const row = storage.db
        .prepare(`SELECT publication_id FROM sync_relay_app_publications WHERE workspace_id=? AND owner_user_id=?
        AND audience='owner' AND app_root=? AND active=1 AND owner_state IN ('pending','current')
        ORDER BY owner_state='pending' DESC LIMIT 1`)
        .get(owner.workspaceId, owner.ownerUserId, candidate.appRoot);
      head = row ? String(row.publication_id) : null;
      if (head !== publicationId && head !== input.expectedCurrentPublicationId)
        throw relayError("conflict", "Another version of this app reached your phones first.");
    }
    const existing = storage.db
      .prepare("SELECT active FROM sync_relay_app_publications WHERE publication_id=?")
      .get(publicationId);
    if (existing) {
      if (own && existing.active === 1 && head !== publicationId) {
        assertPublishingNotHeld(storage, owner.ownerUserId);
        placeOwnerPublication(storage, owner, candidate.appRoot, publicationId, state, now);
      }
      return withOperatorTakedown(
        storage,
        stored(storage, { ...owner, publicationId, limits: input.limits }),
      ); // A retry never reactivates a withdrawn publication.
    }
    assertPublishingNotHeld(storage, owner.ownerUserId);
    putPublicationBlob(storage, owner.workspaceId, manifestHash, bytes, now);
    storage.db
      .prepare(`INSERT INTO sync_relay_app_publications(publication_id,workspace_id,share_id,grant_id,grant_generation,owner_user_id,manifest_sha256,created_at_ms,active,authority_revision,audience,app_root,owner_state)
      VALUES(?,?,?,?,?,?,?,?,1,1,?,?,?)`)
      .run(
        publicationId,
        owner.workspaceId,
        "shareId" in owner ? owner.shareId : null,
        "grantId" in owner ? owner.grantId : null,
        "grantId" in owner ? owner.generation : null,
        owner.ownerUserId,
        manifestHash,
        now,
        publicationAudience(owner),
        own ? candidate.appRoot : null,
        own ? state : null,
      );
    for (const hash of new Set([manifestHash, ...candidate.files.map((file) => file.sha256)])) {
      storage.db
        .prepare(
          "INSERT INTO sync_relay_app_publication_blobs(publication_id,workspace_id,sha256) VALUES(?,?,?)",
        )
        .run(publicationId, owner.workspaceId, hash);
    }
    const approvalProvenance = recordApproval(
      storage,
      publicationId,
      1,
      owner,
      candidate,
      input.agent,
    );
    if (own) placeOwnerPublication(storage, owner, candidate.appRoot, publicationId, state, now);
    return {
      publicationId,
      candidate,
      owner,
      active: true,
      ...(own ? { ownerState: state } : {}),
      authorityRevision: 1,
      createdAtMs: now,
      approvalProvenance,
    };
  });
}
function placeOwnerPublication(
  storage: StorageContext,
  owner: PublicationOwner,
  appRoot: string,
  publicationId: string,
  state: "pending" | "current",
  nowMs: number,
): void {
  storage.db
    .prepare(`UPDATE sync_relay_app_publications SET owner_state=CASE WHEN publication_id=?1 THEN ?2 ELSE 'replaced' END
    WHERE workspace_id=?3 AND owner_user_id=?4 AND audience='owner' AND app_root=?5 AND active=1
    AND (?2='current' OR owner_state<>'current')`)
    .run(publicationId, state, owner.workspaceId, owner.ownerUserId, appRoot);
  reclaimOwnerPublications(storage, owner.workspaceId, nowMs);
}

/** Makes a pending Owner Publication current, inside the transaction that binds its Collections. */
export function activateOwnerPublication(
  storage: StorageContext,
  publicationId: string,
  nowMs: number,
): void {
  const row = storage.db
    .prepare(
      "SELECT workspace_id,owner_user_id,app_root,owner_state FROM sync_relay_app_publications WHERE publication_id=? AND audience='owner'",
    )
    .get(publicationId);
  if (!row || row.owner_state === "current") return;
  if (row.owner_state === "replaced")
    throw relayError("conflict", "A newer version of this app reached your phones first.");
  const owner = { workspaceId: String(row.workspace_id), ownerUserId: String(row.owner_user_id) };
  placeOwnerPublication(storage, owner, String(row.app_root), publicationId, "current", nowMs);
}

/** The workspace's Owner Publications that are withdrawn, or replaced with no launch left, so their blobs can go. */
export function reclaimableOwnerPublications(
  storage: StorageContext,
  workspaceId: string,
  nowMs: number,
): string[] {
  return storage.db
    .prepare(`SELECT publication_id FROM sync_relay_app_publications p WHERE workspace_id=? AND audience='owner'
    AND (active=0 OR owner_state='replaced' AND NOT EXISTS (SELECT 1 FROM sync_relay_phone_app_launches l
      WHERE l.publication_id=p.publication_id AND l.authority_revision=p.authority_revision
      AND l.launch_host IS NOT NULL AND l.expires_at_ms>?))
    AND NOT EXISTS (SELECT 1 FROM sync_relay_app_publication_takedowns t WHERE t.publication_id=p.publication_id)`)
    .all(workspaceId, nowMs)
    .map((row) => String(row.publication_id));
}

export function reclaimOwnerPublications(
  storage: StorageContext,
  workspaceId: string,
  nowMs: number,
): void {
  for (const id of reclaimableOwnerPublications(storage, workspaceId, nowMs))
    retirePublication(storage, id);
}

/** Stops a publication and its phone approvals, then deletes it unless an operator took it down. */
export function retirePublication(storage: StorageContext, publicationId: string): void {
  storage.db
    .prepare("DELETE FROM sync_relay_phone_app_approvals WHERE publication_id=?")
    .run(publicationId);
  storage.db
    .prepare(
      "UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1 WHERE publication_id=? AND active=1",
    )
    .run(publicationId);
  storage.db
    .prepare(
      "DELETE FROM sync_relay_app_publications WHERE publication_id=? AND NOT EXISTS (SELECT 1 FROM sync_relay_app_publication_takedowns WHERE publication_id=?)",
    )
    .run(publicationId, publicationId);
}

export function readAppPublication(
  storage: StorageContext,
  input: ReadAppPublicationInput,
): AppPublicationRow & { linkCurrent: boolean } {
  return storage.readTx(() => {
    const row = withOperatorTakedown(storage, stored(storage, input));
    return { ...row, linkCurrent: publicationLinkIsCurrent(storage, row.owner) };
  });
}

export interface ListAppPublicationsInput {
  workspaceId: string;
  ownerUserId: string;
  limits: AppPublicationLimits;
  cursor?: string;
  appRoot?: string;
  /** Owner Publications are left out unless asked for, alone with their pending versions or with the rest. */
  audience?: "owner" | "all";
}
export type AppPublicationListRow = {
  operatorTakedown?: AppPublicationTakedown;
  approvalProvenance?: AppPublicationApproval;
  publicationId: string;
  authorityRevision: number;
  audience: "link" | "workspace" | "owner";
  shareId: string | null;
  grantId: string | null;
  active: boolean;
  linkCurrent: boolean;
  ownerState?: OwnerPublicationState;
  collectionCapability: AppCollectionCapability | "unavailable" | null;
  datasetCapabilities: AppDatasetCapability[] | "unavailable";
} & (
  | { manifestUnavailable: false; appRoot: string; sourceRevision: string }
  | { manifestUnavailable: true }
);

const listedOwner = ({ owner, ownerState }: AppPublicationState) => ({
  audience: publicationAudience(owner),
  shareId: "shareId" in owner ? owner.shareId : null,
  grantId: "grantId" in owner ? owner.grantId : null,
  ...(ownerState ? { ownerState } : {}),
});

export function publicationLinkIsCurrent(
  storage: StorageContext,
  owner: PublicationOwner,
): boolean {
  try {
    authority(storage, owner);
    return true;
  } catch (error) {
    if (error instanceof RelayError && error.code === "not_found") return false;
    throw error;
  }
}

export function listAppPublications(storage: StorageContext, input: ListAppPublicationsInput) {
  return storage.readTx(() => {
    if (!storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) throw notFound();
    const rows = storage.db
      .prepare(`SELECT p.publication_id,a.capability_json FROM sync_relay_app_publications p
      LEFT JOIN sync_relay_app_collection_approvals a ON a.publication_id=p.publication_id AND a.workspace_id=p.workspace_id AND a.active=1
      WHERE p.workspace_id=?1 AND p.owner_user_id=?2 AND p.publication_id>?3
      AND (p.audience<>'owner' OR p.active=1 AND (p.owner_state='current' OR p.owner_state='pending' AND ?5=1))
      AND (?4=1 OR (p.audience='owner')=?5) ORDER BY p.publication_id LIMIT 26`)
      .all(
        input.workspaceId,
        input.ownerUserId,
        input.cursor ?? "",
        input.audience === "all" ? 1 : 0,
        input.audience === "owner" ? 1 : 0,
      );
    const publications = rows.slice(0, 25).flatMap<AppPublicationListRow>((row) => {
      const publicationId = String(row.publication_id);
      let collectionCapability: AppPublicationListRow["collectionCapability"] = null;
      if (row.capability_json !== null) {
        try {
          collectionCapability = parseAppCollectionCapability(
            JSON.parse(String(row.capability_json)),
          );
        } catch {
          collectionCapability = "unavailable";
        }
      }
      try {
        const publication = withOperatorTakedown(
          storage,
          stored(storage, { ...input, publicationId }),
        );
        if (input.appRoot !== undefined && publication.candidate.appRoot !== input.appRoot)
          return [];
        return [
          {
            publicationId,
            ...(publication.operatorTakedown
              ? { operatorTakedown: publication.operatorTakedown }
              : {}),
            approvalProvenance: publication.approvalProvenance,
            authorityRevision: publication.authorityRevision,
            manifestUnavailable: false,
            ...listedOwner(publication),
            appRoot: publication.candidate.appRoot,
            sourceRevision: publication.candidate.sourceRevision,
            active: publication.active,
            linkCurrent: publicationLinkIsCurrent(storage, publication.owner),
            collectionCapability,
            datasetCapabilities: publication.candidate.capabilities.flatMap((capability) =>
              capability.kind === "dataset" ? [parseAppDatasetCapability(capability)] : [],
            ),
          },
        ];
      } catch (error) {
        if (!(error instanceof PublicationManifestUnavailable)) throw error;
        const state = withOperatorTakedown(
          storage,
          header(storage, publicationId, input.workspaceId, input.ownerUserId).state,
        );
        return [
          {
            publicationId,
            ...(state.operatorTakedown ? { operatorTakedown: state.operatorTakedown } : {}),
            approvalProvenance: state.approvalProvenance,
            authorityRevision: state.authorityRevision,
            manifestUnavailable: true,
            ...listedOwner(state),
            active: state.active,
            linkCurrent: publicationLinkIsCurrent(storage, state.owner),
            collectionCapability,
            datasetCapabilities: "unavailable",
          },
        ];
      }
    });
    return { publications, nextCursor: rows.length > 25 ? String(rows[24]!.publication_id) : null };
  });
}
export function withdrawAppPublication(
  storage: StorageContext,
  input: WithdrawAppPublicationInput,
): AppPublicationState {
  return storage.tx(() => {
    const current = withOperatorTakedown(
      storage,
      header(storage, input.publicationId, input.workspaceId, input.ownerUserId).state,
    );
    const share = "shareId" in current.owner ? storage.getShare(current.owner.shareId) : null;
    if (
      "shareId" in current.owner &&
      (!share ||
        share.workspaceId !== current.owner.workspaceId ||
        share.granterUserId !== input.ownerUserId)
    )
      throw notFound();
    if (current.authorityRevision !== input.expectedAuthorityRevision)
      throw relayError("conflict", "Publication authority changed.");
    if (!current.active) return current;
    if (current.authorityRevision >= Number.MAX_SAFE_INTEGER)
      throw relayError("conflict", "Publication authority is exhausted.");
    storage.db
      .prepare(
        "UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1 WHERE publication_id=?",
      )
      .run(input.publicationId);
    if (current.ownerState === "current")
      storage.db
        .prepare(`UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1
        WHERE audience='owner' AND owner_state='pending' AND active=1 AND workspace_id=? AND owner_user_id=?
        AND app_root=(SELECT app_root FROM sync_relay_app_publications WHERE publication_id=?)`)
        .run(input.workspaceId, input.ownerUserId, input.publicationId);
    return { ...current, active: false, authorityRevision: current.authorityRevision + 1 };
  });
}

/** The takedown reply lists at most this many copies, so it fits the operator socket's reply limit. */
export const TAKEDOWN_LISTED_COPIES = 50;
export interface AppPublicationTakedownResult extends AppPublicationState {
  /** The owner's other active publications of the same bundle, such as the app on another share link. */
  otherActiveCopies: { publicationIds: string[]; total: number };
}
export function disableAppPublication(
  storage: StorageContext,
  input: DisableAppPublicationInput,
): AppPublicationTakedownResult {
  if (
    !/^[a-f0-9]{64}$/.test(input.publicationId) ||
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 1024 ||
    Buffer.byteLength(input.reason) > 4096 ||
    input.reason.includes("\0")
  )
    throw badRequest("Invalid publication takedown.");
  const now = integer(input.nowMs);
  return storage.tx(() => {
    const row = storage.db
      .prepare(
        "SELECT workspace_id,owner_user_id,manifest_sha256,EXISTS(SELECT 1 FROM sync_relay_member_apps m WHERE m.publication_id=p.publication_id) AS member FROM sync_relay_app_publications p WHERE publication_id=?",
      )
      .get(input.publicationId);
    if (!row) throw notFound();
    const current = withOperatorTakedown(
      storage,
      header(
        storage,
        input.publicationId,
        String(row.workspace_id),
        String(row.owner_user_id),
        row.member === 1,
      ).state,
    );
    // A takedown holds the owner's app publishing, and a retry after a lift holds it again.
    storage.db
      .prepare(
        "INSERT OR IGNORE INTO sync_relay_app_publishing_holds(publication_id,owner_user_id,held_at_ms) VALUES(?,?,?)",
      )
      .run(input.publicationId, String(row.owner_user_id), now);
    const copies = storage.db
      .prepare(`SELECT publication_id FROM sync_relay_app_publications
      WHERE owner_user_id=? AND manifest_sha256=? AND active=1 AND publication_id<>? ORDER BY publication_id`)
      .all(String(row.owner_user_id), String(row.manifest_sha256), input.publicationId)
      .map((copy) => String(copy.publication_id));
    const otherActiveCopies = {
      publicationIds: copies.slice(0, TAKEDOWN_LISTED_COPIES),
      total: copies.length,
    };
    if (current.operatorTakedown) return { ...current, otherActiveCopies };
    if (current.authorityRevision >= Number.MAX_SAFE_INTEGER)
      throw relayError("conflict", "Publication authority is exhausted.");
    const operatorTakedown: AppPublicationTakedown = {
      actor: "operator",
      disabledAtMs: now,
      reason: input.reason.trim(),
    };
    storage.db
      .prepare(
        "INSERT INTO sync_relay_app_publication_takedowns(publication_id,actor,disabled_at_ms,reason) VALUES(?,'operator',?,?)",
      )
      .run(input.publicationId, now, operatorTakedown.reason);
    storage.db
      .prepare(
        "UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1 WHERE publication_id=?",
      )
      .run(input.publicationId);
    return {
      ...current,
      active: false,
      authorityRevision: current.authorityRevision + 1,
      operatorTakedown,
      otherActiveCopies,
    };
  });
}

export function assertPublishingNotHeld(storage: StorageContext, ownerUserId: string): void {
  if (
    storage.db
      .prepare("SELECT 1 FROM sync_relay_app_publishing_holds WHERE owner_user_id=?")
      .get(ownerUserId)
  ) {
    throw relayError(
      "conflict",
      "The server operator stopped your account from publishing apps. Contact the server operator.",
    );
  }
}

/** Lifts the hold from the owner of any publication taken down since the last lift. False when no hold matches. */
export function liftAppPublishingHold(storage: StorageContext, publicationId: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(publicationId)) throw badRequest("Invalid publication ID.");
  return storage.tx(
    () =>
      storage.db
        .prepare(`DELETE FROM sync_relay_app_publishing_holds
    WHERE owner_user_id=(SELECT owner_user_id FROM sync_relay_app_publishing_holds WHERE publication_id=?)`)
        .run(publicationId).changes > 0,
  );
}

export function recordApproval(
  storage: StorageContext,
  publicationId: string,
  authorityRevision: number,
  owner: PublicationOwner,
  candidate: AppPublicationCandidate,
  agent?: ApprovalAgent | null,
): AppPublicationApproval {
  const facts: AppPublicationApproval = {
    agent: parseApprovalAgent(agent),
    selector: "shareId" in owner ? JSON.parse(storage.getShare(owner.shareId)!.selectorJson) : null,
    access:
      "grantId" in owner
        ? (storage.getShareGrant(owner.grantId)!.access as AppPublicationApproval["access"])
        : null,
    committedCandidateDigest: sha(JSON.stringify(candidate)),
    sourceRevision: candidate.sourceRevision,
    capabilities: candidate.capabilities,
  };
  const secretBindings = candidate.external && {
    secretBindings: Object.fromEntries(
      candidate.external.map(({ host, secret: { name } }) => {
        const stored = readWorkspaceSecretForExecution(storage, owner.workspaceId, name);
        if (
          !stored ||
          stored.summary.usage !== "http-header" ||
          !stored.summary.allowedHosts.includes(host)
        )
          throw relayError(
            "conflict",
            `Add secret ${name} in Settings > Secrets as a header value allowed for ${host}, then share this app again.`,
          );
        return [name, workspaceSecretApprovalBinding(stored.summary)];
      }),
    ),
  };
  storage.db
    .prepare(
      "INSERT INTO sync_relay_app_publication_approvals(publication_id,authority_revision,facts_json) VALUES(?,?,?)",
    )
    .run(publicationId, authorityRevision, JSON.stringify({ ...facts, ...secretBindings }));
  return facts;
}

/** The identity of each secret an app's outside calls use, as the owner approved them at this revision. */
export function approvedSecretBindings(
  storage: StorageContext,
  publicationId: string,
  authorityRevision: number,
): Record<string, string> {
  const row = storage.db
    .prepare(
      "SELECT facts_json FROM sync_relay_app_publication_approvals WHERE publication_id=? AND authority_revision=?",
    )
    .get(publicationId, authorityRevision);
  return (row && JSON.parse(String(row.facts_json)).secretBindings) ?? {};
}

export function reactivateAppPublication(
  storage: StorageContext,
  input: ReactivateAppPublicationInput,
): AppPublicationState {
  return storage.tx(() => {
    const current = withOperatorTakedown(
      storage,
      header(storage, input.publicationId, input.workspaceId, input.ownerUserId).state,
    );
    if (current.operatorTakedown)
      throw relayError(
        "conflict",
        "The server operator disabled this publication. Contact the server operator.",
      );
    if (publicationAudience(current.owner) === "owner") throw notFound();
    if (current.authorityRevision !== input.expectedAuthorityRevision)
      throw relayError("conflict", "Publication authority changed.");
    const candidate = stored(storage, input).candidate;
    authority(storage, current.owner, candidate);
    validateBuildIdentity(candidate);
    if (publicationIdOf(current.owner, sha(JSON.stringify(candidate))) !== current.publicationId)
      throw badRequest("Publication identity mismatch.");
    for (const file of candidate.files) {
      const bytes = storage.getBlob(current.owner.workspaceId, file.sha256);
      if (!bytes || bytes.byteLength !== file.byteLength || sha(bytes) !== file.sha256)
        throw badRequest("Publication bundle is unavailable.");
    }
    if (current.active) return current;
    assertPublishingNotHeld(storage, current.owner.ownerUserId);
    if (current.authorityRevision >= Number.MAX_SAFE_INTEGER)
      throw relayError("conflict", "Publication authority is exhausted.");
    storage.db
      .prepare(
        "UPDATE sync_relay_app_publications SET active=1,authority_revision=authority_revision+1 WHERE publication_id=?",
      )
      .run(input.publicationId);
    const approvalProvenance = recordApproval(
      storage,
      input.publicationId,
      current.authorityRevision + 1,
      current.owner,
      candidate,
      input.agent,
    );
    return {
      ...current,
      active: true,
      authorityRevision: current.authorityRevision + 1,
      approvalProvenance,
    };
  });
}

function currentLinkPublicationPrincipal(
  storage: StorageContext,
  input: Omit<LinkAppPublicationInput, "publicationId">,
) {
  const enrollment = readLinkEnrollment(storage, input, input.nowMs);
  if (!enrollment || enrollment.principal?.blockedAtMs != null) throw notFound();
  const session = storage.findLinkSessionByCapabilityHash(input.capabilityHash);
  if (
    !session ||
    session.capabilityHash !== input.capabilityHash ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0
  )
    throw notFound();
  const authorized = authorizeLinkSession(storage, session, input.nowMs, input.publicEditRelease);
  // A Group link's grant carries chat access, and no app is published to a Group.
  if (!authorized || !isShareAccessValue(authorized.grant.access)) throw notFound();
  return { enrollment, session, authorized };
}

function currentLinkAppPublication(
  storage: StorageContext,
  input: LinkAppPublicationInput,
  verified?: { candidate: AppPublicationCandidate; manifestHash: string },
  principal?: ReturnType<typeof currentLinkPublicationPrincipal>,
) {
  const { enrollment, session, authorized } =
    principal ?? currentLinkPublicationPrincipal(storage, input);
  const lookup = {
    workspaceId: authorized.share.workspaceId,
    ownerUserId: authorized.share.granterUserId,
    publicationId: input.publicationId,
    limits: input.limits,
  };
  const { state: publication, row } = header(
    storage,
    lookup.publicationId,
    lookup.workspaceId,
    lookup.ownerUserId,
  );
  if (
    !publication.active ||
    !("grantId" in publication.owner) ||
    publication.owner.shareId !== authorized.share.shareId ||
    publication.owner.grantId !== authorized.grant.grantId ||
    publication.owner.generation !== authorized.grant.generation ||
    !Number.isSafeInteger(publication.authorityRevision) ||
    publication.authorityRevision < 1 ||
    (input.expectedAuthorityRevision !== undefined &&
      input.expectedAuthorityRevision !== publication.authorityRevision)
  )
    throw notFound();
  let candidate: AppPublicationCandidate;
  if (verified) {
    if (row.manifest_sha256 !== verified.manifestHash) throw notFound();
    candidate = verified.candidate;
  } else {
    try {
      candidate = stored(storage, lookup).candidate;
    } catch (error) {
      if (error instanceof PublicationManifestUnavailable) throw notFound();
      throw error;
    }
  }
  authority(storage, publication.owner, candidate);
  const manifestHash = verified?.manifestHash ?? sha(JSON.stringify(candidate));
  if (publicationIdOf(publication.owner, manifestHash) !== publication.publicationId)
    throw notFound();
  const result: LinkAppPublicationAuthority = {
    descriptor: {
      publicationId: publication.publicationId,
      authorityRevision: publication.authorityRevision,
      files: candidate.files,
    },
    workspaceId: authorized.share.workspaceId,
    datasetIds: candidate.capabilities.flatMap((value) =>
      value.kind === "dataset" ? [value.datasetId] : [],
    ),
    shareId: authorized.share.shareId,
    grantId: session.grantId,
    generation: session.generation,
    sessionId: session.sessionId,
    principalId: enrollment.principal?.principalId ?? null,
    expiresAtMs: session.expiresAtMs,
  };
  return { result, workspaceId: authorized.share.workspaceId, candidate, manifestHash, enrollment };
}

export interface ListLinkAppPublicationsInput extends Omit<
  LinkAppPublicationInput,
  "publicationId" | "expectedAuthorityRevision"
> {
  cursor?: string;
}
export function listLinkAppPublications(
  storage: StorageContext,
  input: ListLinkAppPublicationsInput,
) {
  return storage.readTx(() => {
    const principal = currentLinkPublicationPrincipal(storage, input);
    const { session, authorized } = principal;
    const pinned: { publicationId: string; authorityRevision: number; manifestHash: string }[] = [];
    const rows = storage.db
      .prepare(`SELECT publication_id FROM sync_relay_app_publications
      WHERE workspace_id=? AND grant_id=? AND grant_generation=? AND active=1 AND publication_id>?
      ORDER BY publication_id LIMIT 26`)
      .all(authorized.share.workspaceId, session.grantId, session.generation, input.cursor ?? "");
    const publications = rows.slice(0, 25).flatMap((row) => {
      try {
        const { candidate, result, manifestHash } = currentLinkAppPublication(
          storage,
          { ...input, publicationId: String(row.publication_id) },
          undefined,
          principal,
        );
        const name =
          (candidate.appRoot.split("/").at(-1) ?? "App")
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .slice(0, 128) || "App";
        pinned.push({
          publicationId: result.descriptor.publicationId,
          authorityRevision: result.descriptor.authorityRevision,
          manifestHash,
        });
        return [{ publicationId: result.descriptor.publicationId, name }];
      } catch (error) {
        if (error instanceof RelayError && error.code === "not_found") return [];
        throw error;
      }
    });
    const page = {
      publications,
      nextCursor: rows.length > 25 ? String(rows[24]!.publication_id) : null,
    };
    const capturedInput = { ...input, limits: { ...input.limits } };
    const assertCurrent = (nowMs: number) =>
      storage.readTx(() => {
        const current = currentLinkPublicationPrincipal(storage, { ...capturedInput, nowMs });
        if (
          current.authorized.share.workspaceId !== authorized.share.workspaceId ||
          current.authorized.share.granterUserId !== authorized.share.granterUserId ||
          current.authorized.share.shareId !== authorized.share.shareId ||
          current.authorized.share.selectorJson !== authorized.share.selectorJson ||
          current.authorized.grant.access !== authorized.grant.access ||
          current.session.grantId !== session.grantId ||
          current.session.generation !== session.generation
        )
          throw notFound();
        for (const publication of pinned) {
          const { state, row } = header(
            storage,
            publication.publicationId,
            authorized.share.workspaceId,
            authorized.share.granterUserId,
          );
          if (
            !state.active ||
            state.authorityRevision !== publication.authorityRevision ||
            !("grantId" in state.owner) ||
            state.owner.shareId !== authorized.share.shareId ||
            state.owner.grantId !== session.grantId ||
            state.owner.generation !== session.generation ||
            row.manifest_sha256 !== publication.manifestHash
          )
            throw notFound();
        }
      });
    return { page, assertCurrent };
  });
}

/** Call within the caller's read or write transaction. */
export function requireLinkAppPublication(
  storage: StorageContext,
  input: LinkAppPublicationInput,
  verified?: { candidate: AppPublicationCandidate; manifestHash: string },
) {
  return currentLinkAppPublication(storage, input, verified);
}

/** Retain only verified immutable content; every invocation still rechecks current authority. */
export function createLinkAppPublicationGuard(
  storage: StorageContext,
  input: LinkAppPublicationInput,
): (nowMs: number) => void {
  const capturedInput = { ...input, limits: { ...input.limits } };
  const captured = storage.readTx(() => currentLinkAppPublication(storage, capturedInput));
  const pinned = {
    ...capturedInput,
    expectedAuthorityRevision: captured.result.descriptor.authorityRevision,
  };
  return (nowMs) =>
    storage.readTx(() => {
      currentLinkAppPublication(storage, { ...pinned, nowMs }, captured);
    });
}

/** Shared by launch admission and protected reads; all standing comes from current server state. */
export function authorizeLinkAppPublication(
  storage: StorageContext,
  input: LinkAppPublicationInput,
): LinkAppPublicationAuthority {
  return storage.readTx(() => requireLinkAppPublication(storage, input).result);
}

export function readLinkAppPublicationBlob(
  storage: StorageContext,
  input: LinkAppPublicationInput & {
    sha256: string;
    expectedAuthorityRevision: number;
  },
) {
  return storage.readTx(() => {
    const { result, workspaceId } = requireLinkAppPublication(storage, input);
    const file = result.descriptor.files.find((file) => file.sha256 === input.sha256);
    if (!file) throw notFound();
    const bytes = storage.getBlob(workspaceId, file.sha256);
    if (!bytes || bytes.byteLength !== file.byteLength || sha(bytes) !== file.sha256)
      throw notFound();
    return { ...result, file, bytes };
  });
}
