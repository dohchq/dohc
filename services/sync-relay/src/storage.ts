import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { shareAccessRank } from "@dohc/security-contract/share-selector";
import {
  conflictResolveBlobShas,
  type ConflictResolveEnvelopeContext,
} from "./conflictResolve";
import { RELAY_ERRORS } from "./errorCodes";

export interface SyncRelayLogInput {
  originSeq: number;
  opKind: string;
  payloadJson: string;
  recordedAtMs: number;
}

export interface SyncRelayLogRow extends SyncRelayLogInput {
  workspaceId: string;
  originId: string;
  relaySeq: number;
}

export interface AppendLogBatchResult {
  inserted: number;
  skipped: number;
  currentMaxOriginSeq: number;
}

export interface FetchLogPageResult {
  rows: SyncRelayLogRow[];
  nextCursor: number;
  hasMore: boolean;
}

export interface PutBlobResult {
  byteLength: number;
  alreadyHad: boolean;
}

export interface CollectUnreferencedBlobsResult {
  removed: number;
  removedSha256s: string[];
}

export interface KeyEnvelopeRow {
  envelopeJson: string;
  sha256: string;
  updatedAtMs: number;
}

export interface KeyEnvelopeHistoryRow {
  envelopeJson: string;
  sha256: string;
  replacedAtMs: number;
  replacedBySha256: string;
}

export interface SyncRelayShareRow {
  shareId: string;
  workspaceId: string;
  granterUserId: string;
  // Validated selector JSON without access. The grant owns access.
  selectorJson: string;
  createdAtMs: number;
}

export type SyncRelayShareGrantStatus = "active" | "revoked";

export interface SyncRelayShareGrantRow {
  grantId: string;
  shareId: string;
  principalKind: "user" | "email" | "link";
  principalUserId: string | null;
  principalEmail: string | null;
  access: string;
  generation: number;
  status: SyncRelayShareGrantStatus;
  createdAtMs: number;
  revokedAtMs: number | null;
  parentGrantId: string | null;
}

export interface SyncRelayLinkCredentialRow {
  credentialId: string;
  grantId: string;
  secretHash: string;
  generation: number;
  mintedAtMs: number;
  retiredAtMs: number | null;
}

export interface SyncRelayLinkCredentialGrantRow {
  credential: SyncRelayLinkCredentialRow;
  grant: SyncRelayShareGrantRow;
}

export interface SyncRelayLinkSessionRow {
  sessionId: string;
  capabilityHash: string;
  grantId: string;
  generation: number;
  mintedAtMs: number;
  expiresAtMs: number;
}

export type ShareGrantTransitionResult =
  | { ok: true; grant: SyncRelayShareGrantRow }
  | { ok: false };

export interface SyncRelayShareWithGrantRow {
  share: SyncRelayShareRow;
  grant: SyncRelayShareGrantRow;
}

// #646 PR3a. A recipient's submitted changes, held at the relay until the
// granter accepts or declines them. `open` is the only state that can change.
export type ShareProposalState = "open" | "accepted" | "declined" | "withdrawn";

export interface ShareProposalRow {
  proposalId: string;
  shareId: string;
  workspaceId: string;
  // SERVER-derived from the authenticated submitter. Never client-supplied.
  proposedByUserId: string;
  // The ONE version the share exposed when this was submitted.
  versionId: string;
  state: ShareProposalState;
  createdAtMs: number;
  settledAtMs: number | null;
}

// One net change to one file. Not a moment: the relay mints the moment from
// the granter's own facts at accept (see `shareProposals.ts`).
export interface ShareProposalOpRow {
  opIndex: number;
  basedOnPath: string | null;
  // WHICH file the change is built on, resolved from `basedOnPath` at submit
  // and followed at accept. null for a file the granter does not have.
  basedOnObjectId: string | null;
  basedOnBlobSha256: string | null;
  operation: "write" | "delete";
  afterPath: string | null;
  afterBlobSha256: string | null;
  afterContentKind: "text" | "binary" | null;
  afterByteLength: number | null;
  recordedAtMs: number;
}

// One moment the granter's log holds for one object, as the base rewrite needs
// to describe it. `path` and `blobSha256` are null when the moment deletes the
// object.
export interface ObjectMomentRow {
  momentId: string;
  versionId: string;
  path: string | null;
  blobSha256: string | null;
  contentKind: string | null;
  byteLength: number | null;
  recordedAtMs: number;
}

export interface WorkspaceSyncIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

export interface WorkspaceBootstrap {
  hasContent: boolean;
  identity: WorkspaceSyncIdentity | null;
}

export type ClaimWorkspaceIdentityResult =
  | "claimed"
  | "matched"
  | "epoch-superseded"
  | "epoch-unknown"
  | "stream-mismatch";

export type VerifyWorkspaceIdentityResult = Exclude<
  ClaimWorkspaceIdentityResult,
  "claimed"
>;

export type EnforceWorkspaceIdentityResult =
  | ClaimWorkspaceIdentityResult
  | "identity-required";

export type RotateWorkspaceIdentityResult =
  | "rotated"
  | "not-owner"
  | "unchanged"
  | "epoch-superseded";

export interface AppendLogBatchGuardContext {
  enforceWorkspaceIdentity(
    identity: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult;
}

export interface SyncRelayStorage {
  close(): void;
  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner";
  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap;
  getWorkspaceIdentity(workspaceId: string): WorkspaceSyncIdentity | null;
  getEpochLogFloor(workspaceId: string): number;
  verifyWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult;
  claimWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult;
  rotateWorkspaceIdentity(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult;
  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean;
  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult;
  // Async + chunked so a large sweep never monopolizes the event loop on the
  // request path. Only reclaims blobs that are BOTH unreferenced AND older than
  // the retention grace window (created_at_ms <= nowMs - grace), which is what
  // keeps a blob uploaded moments before its referencing log op is appended
  // from being deleted between the two phases.
  collectUnreferencedBlobs(
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult>;
  getBlob(workspaceId: string, sha256: string): Uint8Array | null;
  missingBlobs(workspaceId: string, sha256s: string[]): string[];
  // Create-only on first write (expectedSha256 null), compare-and-swap
  // thereafter: the caller must present the sha256 of the envelope it intends
  // to replace. Replaced envelopes are RETAINED in an append-only history
  // table (audit trail + server-side recovery from a bad overwrite).
  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string };
  getKeyEnvelope(workspaceId: string): KeyEnvelopeRow | null;
  getKeyEnvelopeHistory(workspaceId: string): KeyEnvelopeHistoryRow[];
  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    // MU-C4 revoke-race gate: runs INSIDE the append's BEGIN IMMEDIATE
    // transaction, i.e. under the SQLite write lock that serializes revokes,
    // before anything is inserted. A throwing guard rolls the whole batch
    // back. This is how the member-append route re-verifies the share
    // (recipient-owned, unrevoked, granter in standing) with NO window left
    // between the check and the insert — a route-level re-check alone leaves
    // a gap where a concurrent revoke commits after the check but before the
    // transaction opens.
    guard?: (context: AppendLogBatchGuardContext) => void;
  }): AppendLogBatchResult;
  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult;
  fetchLogCoordinate(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): SyncRelayLogRow | null;
  createShare(input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
  }): void;
  createLinkGrant(input: {
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
  }): boolean;
  getShareGrant(grantId: string): SyncRelayShareGrantRow | null;
  getCurrentLinkCredential(grantId: string): SyncRelayLinkCredentialRow | null;
  findLinkGrantByCredentialHash(
    secretHash: string,
  ): SyncRelayLinkCredentialGrantRow | null;
  rotateLinkGrant(input: {
    shareId: string;
    grantId: string;
    credentialId: string;
    secretHash: string;
    rotatedAtMs: number;
  }): ShareGrantTransitionResult;
  retuneShareGrant(input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    credentialId?: string;
    secretHash?: string;
  }): ShareGrantTransitionResult;
  revokeShareGrant(input: {
    shareId: string;
    grantId: string;
    revokedAtMs: number;
  }): ShareGrantTransitionResult;
  convertLinkGrant(input: {
    shareId: string;
    parentGrantId: string;
    grantId: string;
    principalUserId: string;
    createdAtMs: number;
  }): ShareGrantTransitionResult;
  promoteShareGrant(input: {
    shareId: string;
    grantId: string;
  }): ShareGrantTransitionResult;
  mintLinkSession(input: {
    session: SyncRelayLinkSessionRow;
    guard?: () => void;
  }): boolean;
  findLinkSessionByCapabilityHash(
    capabilityHash: string,
  ): SyncRelayLinkSessionRow | null;
  // Claims any pending email invites addressed to `email` for `userId`,
  // changing the grant principal from email to user. Idempotent; the email
  // match is exact on the normalized (lowercased) address. Returns the number
  // of grants claimed.
  claimPendingSharesForEmail(email: string, userId: string): number;
  getShare(shareId: string): SyncRelayShareRow | null;
  getShareGrantForRecipient(
    shareId: string,
    recipientUserId: string,
  ): SyncRelayShareGrantRow | null;
  listSharesGrantedBy(granterUserId: string): SyncRelayShareWithGrantRow[];
  // Received listings exclude revoked shares entirely: after revocation the
  // recipient must not be able to read even the share's metadata (paths,
  // version names) — a revoked share is indistinguishable from one that
  // never existed.
  listSharesReceivedBy(recipientUserId: string): SyncRelayShareWithGrantRow[];
  // Idempotent; returns false only when the share does not exist.
  revokeShare(shareId: string, revokedAtMs: number): boolean;
  // Candidate rows for the shared-blob allowlist: every log row whose payload
  // MIGHT reference the given sha256 (LIKE pre-filter; the share filter makes
  // the actual decision). sha256 is validated hex upstream, so it cannot
  // carry LIKE wildcards.
  listLogRowsReferencing(workspaceId: string, sha256: string): SyncRelayLogRow[];
  // MU-C4 shared channels: the channelWireId bound by the EARLIEST
  // chat.thread.create op for this threadId in the workspace's log (relay
  // order). undefined means no create exists; null means the earliest create
  // exists but carries no shareable channel binding. Earliest-wins mirrors the
  // engine's insert-if-absent thread apply, so a later forged re-create can
  // never re-bind an existing thread across a share boundary.
  findThreadCreateChannelWireId(
    workspaceId: string,
    threadId: string,
  ): string | null | undefined;
  // The kind claimed by the EARLIEST chat.channel.create op for this wire id.
  // undefined means no create exists; null means the earliest exact create is
  // malformed/unshareable. Later duplicate creates never override the first.
  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined;
  // #646 PR2: the file a thread is about, as claimed by the EARLIEST
  // chat.thread.create for this threadId. Earliest-wins for the same reason
  // the channel binding uses it: a later forged re-create must not re-bind an
  // existing thread into a share. undefined means no create exists; null means
  // the earliest create exists but binds the thread to no file.
  findThreadCreateFileBinding(
    workspaceId: string,
    threadId: string,
  ): ThreadFileBinding | null | undefined;
  // Where this object sits RIGHT NOW. undefined means the relay has never
  // seen the object; null means its latest moment deleted it (or named no
  // readable path). Both deny.
  objectCurrentPath(workspaceId: string, objectId: string): string | null | undefined;
  // The object at this path RIGHT NOW, or undefined when none is. The reverse
  // of the lookup above; a thread bound by path is re-proved through it.
  objectIdAtPath(workspaceId: string, path: string): string | undefined;
  // #646 PR3a. WHICH object sits at this path, in the ONE version a share
  // exposes. `objectIdAtPath` above answers across every version at once, so
  // a path last touched in a side version resolves to an object that share
  // never saw — and every lookup below would then be scoped to a version that
  // object has nothing in. undefined means "nothing is there", which the
  // submit door refuses rather than minting a create.
  objectIdAtPathInVersion(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined;
  // #646 PR3a. The granter's own moment for this object WITHIN one version:
  // the latest one, or the latest that produced `blobSha256` when one is
  // named. The first answers "did this file drift since they sent it?"; the
  // second is the correct three-way base for a change built on that content.
  //
  // The LATEST match wins, because content can return to an earlier state and
  // the recipient started from the most recent moment that produced it. null
  // when no moment did, which reads as an unknown base and opens a conflict.
  //
  // A share exposes exactly ONE version, and the same content can sit under
  // the same object id in another one. An unscoped lookup would hand a main
  // share a base from a side version — a moment the granter's main line never
  // held — so the version is a parameter, never a default.
  objectMoment(input: {
    workspaceId: string;
    objectId: string;
    versionId: string;
    blobSha256?: string;
  }): ObjectMomentRow | null;
  // Store one submit. `submitId` is idempotent per share: a retried POST
  // returns `created: false` and the proposal it already made, so a lost
  // response can never become two proposals for one intent.
  insertShareProposal(input: {
    proposalId: string;
    shareId: string;
    workspaceId: string;
    proposedByUserId: string;
    versionId: string;
    submitId: string;
    createdAtMs: number;
    ops: ShareProposalOpRow[];
    guard?: () => void;
  }): { proposalId: string; created: boolean };
  getShareProposal(
    proposalId: string,
  ): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null;
  listShareProposalsForShare(shareId: string): Array<ShareProposalRow & { opCount: number }>;
  // The granter's OPEN proposals, as counts rather than op rows. The review
  // surface polls this on a timer and renders a sender and a count from it, so
  // serving every op of every open proposal would resolve a base per op on
  // every tick to build rows nobody reads. One proposal's ops come from
  // getShareProposal, when a granter opens it.
  listShareProposalsForWorkspace(
    workspaceId: string,
  ): Array<ShareProposalRow & { opCount: number }>;
  // Move a proposal out of `open`. Returns false when it already moved, which
  // is how a double accept, a decline racing an accept, and a withdraw racing
  // either one all lose without a second check.
  settleShareProposal(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean;
  // The same move, WITHOUT a transaction of its own, for a caller that already
  // holds the write lock. Accept uses it inside appendLogBatch's guard so the
  // release and the settle commit together or not at all.
  settleShareProposalInTransaction(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean;
  // The highest origin_seq this origin holds, or -1 when it holds none. The
  // proposal accept needs it because a proposal's changes carry no
  // coordinates: they were never a log, so the relay numbers them.
  maxOriginSeq(workspaceId: string, originId: string): number;
}

// The two wire shapes a file-linked thread create carries, kept apart because
// they come from opposite ends of a share. `object` is the granter's own op —
// its `linkedObjectId` is a granter-local id the relay resolves to a path.
// `path` is a RECIPIENT's op, pushed back through the share log: a recipient's
// object ids are its own and mean nothing here, so its create names the
// granted path directly, and the relay re-proves that path against the log.
//
// Declared here, where it is read out of the log, and re-exported by
// `shareFilter.ts` for the filter that consumes it.
export type ThreadFileBinding =
  | { kind: "object"; objectId: string }
  | { kind: "path"; path: string };

interface SqliteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

export const SYNC_RELAY_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_WORKSPACE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
// Retention grace for freshly-uploaded blobs (0P sync-hardening item 4). Blob
// upload is two-phase (PUT /blobs/:sha, then POST /log referencing it); GC that
// runs between the two must NOT reclaim the blob just because no log row
// references it yet. Any blob younger than this window is untouchable. Ten
// minutes comfortably covers a slow/retried push.
export const DEFAULT_BLOB_GRACE_MS = 10 * 60 * 1000;
const RETIRED_LINK_CREDENTIAL_HISTORY_LIMIT = 10;

export interface OpenSyncRelayStorageOptions {
  workspaceQuotaBytes?: number;
  blobGraceMs?: number;
}

const NORMALIZED_SHARE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sync_relay_shares (
    share_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    granter_user_id TEXT NOT NULL,
    selector_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (workspace_id)
      REFERENCES sync_relay_workspaces(workspace_id)
      ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_shares_granter
    ON sync_relay_shares(granter_user_id, created_at_ms);

  CREATE TABLE IF NOT EXISTS sync_relay_share_grants (
    grant_id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'email', 'link')),
    principal_user_id TEXT,
    principal_email TEXT,
    access TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    parent_grant_id TEXT,
    CHECK (
      (principal_kind = 'user' AND principal_user_id IS NOT NULL AND principal_email IS NULL)
      OR
      (principal_kind = 'email' AND principal_user_id IS NULL AND principal_email IS NOT NULL)
      OR
      (principal_kind = 'link' AND principal_user_id IS NULL AND principal_email IS NULL)
    ),
    CHECK (
      (status = 'active' AND revoked_at_ms IS NULL)
      OR
      (status = 'revoked' AND revoked_at_ms IS NOT NULL)
    ),
    CHECK (parent_grant_id IS NULL OR principal_kind = 'user'),
    FOREIGN KEY (share_id)
      REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_grant_id)
      REFERENCES sync_relay_share_grants(grant_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_share
    ON sync_relay_share_grants(share_id, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_user
    ON sync_relay_share_grants(principal_user_id, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_email
    ON sync_relay_share_grants(principal_email, created_at_ms);

  CREATE TABLE IF NOT EXISTS sync_relay_link_credentials (
    credential_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    minted_at_ms INTEGER NOT NULL,
    retired_at_ms INTEGER,
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_link_credentials_current
    ON sync_relay_link_credentials(grant_id)
    WHERE retired_at_ms IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_credentials_hash
    ON sync_relay_link_credentials(secret_hash);

  CREATE TABLE IF NOT EXISTS sync_relay_link_sessions (
    session_id TEXT PRIMARY KEY,
    capability_hash TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    minted_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    CHECK (expires_at_ms > minted_at_ms),
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_sessions_grant
    ON sync_relay_link_sessions(grant_id, generation, expires_at_ms);
`;

export function initializeSyncRelaySchema(db: SqliteDb): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_relay_workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        replication_epoch TEXT,
        stream_identity TEXT,
        epoch_log_floor INTEGER
      );

      -- Every epoch that stops being active remains durable here. This makes
      -- stale pre-reset credentials permanently identifiable after rotation.
      CREATE TABLE IF NOT EXISTS sync_relay_epoch_supersessions (
        workspace_id TEXT NOT NULL,
        replication_epoch TEXT NOT NULL,
        stream_identity TEXT NOT NULL,
        superseded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, replication_epoch, stream_identity),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_relay_log (
        workspace_id TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        origin_seq INTEGER NOT NULL,
        op_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recorded_at_ms REAL NOT NULL,
        relay_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        UNIQUE(workspace_id, origin_id, origin_seq),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_page
        ON sync_relay_log(workspace_id, relay_seq);
      -- MU-C4: findThreadCreateChannelWireId's LIKE pre-filter cannot use an
      -- index on payload_json, but this PARTIAL index confines the scan to a
      -- workspace's chat.thread.create rows (a tiny slice of a busy log) in
      -- relay order, instead of every log row. Per-request memoization in the
      -- caller (server.ts chatResolverFor) removes the per-message repeats;
      -- if channel history ever makes even the confined scan hot, the upgrade
      -- path is a dedicated thread_channel_bindings table filled at insert.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_thread_creates
        ON sync_relay_log(workspace_id, relay_seq)
        WHERE op_kind = 'chat.thread.create';
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_channel_creates
        ON sync_relay_log(workspace_id, relay_seq)
        WHERE op_kind = 'chat.channel.create';

      CREATE TABLE IF NOT EXISTS sync_relay_blobs (
        workspace_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, sha256),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_relay_key_envelopes (
        workspace_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      -- Append-only audit trail: every replaced key envelope is retained with
      -- when it was replaced and by what (sha256 of the successor). The
      -- envelope is the only recovery path for the wrapped workspace key, so
      -- an overwrite — even a CAS-correct one — must never destroy the prior
      -- copy; a lockout caused by a bad replacement stays recoverable
      -- server-side.
      CREATE TABLE IF NOT EXISTS sync_relay_key_envelope_history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        replaced_at_ms INTEGER NOT NULL,
        replaced_by_sha256 TEXT NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_key_envelope_history
        ON sync_relay_key_envelope_history(workspace_id, history_seq);

      ${NORMALIZED_SHARE_SCHEMA_SQL}

      -- #646 PR2: where every object the relay has ever seen sits RIGHT NOW,
      -- maintained at insert time by appendLogBatch. The file-chat share
      -- filter resolves a thread's object to its current path and tests that
      -- path against the selector, so this lookup is on the share read path
      -- and must be a primary-key read. A LIKE scan cannot serve it:
      -- moment.append rows are most of a busy log, so the partial-index trick
      -- above would confine nothing.
      --
      -- The path column is NULL when the object's latest moment deletes it,
      -- or when that moment names no readable path. Both read as "deny" — the
      -- filter fails closed on NULL exactly as it does on an absent row.
      CREATE TABLE IF NOT EXISTS sync_relay_object_paths (
        workspace_id TEXT NOT NULL,
        object_id    TEXT NOT NULL,
        path         TEXT,
        relay_seq    INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, object_id),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      -- The reverse lookup: which object sits at this path now. A thread bound
      -- by PATH is re-proved through this on every serve, so it is on the
      -- share read path and must not scan.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_paths_path
        ON sync_relay_object_paths(workspace_id, path);

      -- #646 PR3a: one row per moment the relay has seen for an object, which
      -- is what the base rewrite resolves against. sync_relay_object_paths
      -- above answers "where is this object NOW?"; accept needs the harder
      -- question, "which of your own moments produced the content the
      -- recipient started from?", because that moment is the correct
      -- three-way base. A blob hash is the only identifier both sides of a
      -- share genuinely share, so the hash is what the lookup keys on.
      --
      -- path and blob_sha256 are NULL when the moment deletes the object.
      -- A NULL hash is never a lookup target: an absent base reads as
      -- "unknown", and unknown opens a conflict rather than claiming a base.
      CREATE TABLE IF NOT EXISTS sync_relay_object_moments (
        workspace_id   TEXT NOT NULL,
        object_id      TEXT NOT NULL,
        relay_seq      INTEGER NOT NULL,
        moment_id      TEXT NOT NULL,
        version_id     TEXT NOT NULL,
        path           TEXT,
        blob_sha256    TEXT,
        content_kind   TEXT,
        byte_length    INTEGER,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, object_id, relay_seq),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      -- Base resolution by content hash. Latest matching moment wins, because
      -- content can return to an earlier state and the recipient started from
      -- the most recent moment that produced it.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_moments_blob
        ON sync_relay_object_moments(workspace_id, object_id, blob_sha256, relay_seq);
      -- WHICH object sits at a path IN ONE VERSION. sync_relay_object_paths
      -- answers the same question across every version at once, latest-wins,
      -- so a path last touched in a side version resolves to the wrong object
      -- for a share that exposes another one. The proposal lane asks this
      -- instead, and it must not scan.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_moments_path
        ON sync_relay_object_moments(workspace_id, version_id, path, relay_seq);

      -- #646 PR3a: a recipient's submitted changes, held until the granter
      -- accepts or declines them. Nothing here is in the granter's log: accept
      -- is what releases it, through the same appendLogBatch the chat path
      -- already uses.
      --
      -- workspace_id is denormalized so the granter's owner-scoped read
      -- never joins through a share the granter may have revoked.
      -- submit_id makes one submit idempotent: a retried POST returns the
      -- proposal it already made instead of a second one.
      -- version_id is PINNED at submit from the selector the recipient read.
      -- Accept and the review listing both resolve the granter's moments
      -- within it, so a selector edited mid-flight cannot move a proposal to a
      -- version its author never saw.
      CREATE TABLE IF NOT EXISTS sync_relay_share_proposals (
        proposal_id         TEXT PRIMARY KEY,
        share_id            TEXT NOT NULL,
        workspace_id        TEXT NOT NULL,
        proposed_by_user_id TEXT NOT NULL,
        version_id          TEXT NOT NULL,
        submit_id           TEXT NOT NULL,
        state               TEXT NOT NULL,
        created_at_ms       INTEGER NOT NULL,
        settled_at_ms       INTEGER,
        UNIQUE (share_id, submit_id),
        FOREIGN KEY (share_id)
          REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_sync_relay_share_proposals_workspace
        ON sync_relay_share_proposals(workspace_id, state, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_sync_relay_share_proposals_share
        ON sync_relay_share_proposals(share_id, created_at_ms);

      -- One NET change to one file. Not a moment, and deliberately not shaped
      -- like one: a recipient never learns a granter moment id, so it states
      -- what it read and what it wants, and the relay mints the moment.
      --
      -- based_on_object_id is resolved AT SUBMIT, from the path the recipient
      -- named. The path is where the granter had the file when the recipient
      -- read it; the object id is which file it is. Resolving at accept
      -- instead would follow the path, so a rename between submit and accept
      -- would find a different file and a delete would find none — and a
      -- change whose base resolved to nothing is minted as a create, which
      -- resurrects a file the granter deleted. The object id does not move.
      CREATE TABLE IF NOT EXISTS sync_relay_share_proposal_ops (
        proposal_id          TEXT NOT NULL,
        op_index             INTEGER NOT NULL,
        based_on_path        TEXT,
        based_on_object_id   TEXT,
        based_on_blob_sha256 TEXT,
        operation            TEXT NOT NULL,
        after_path           TEXT,
        after_blob_sha256    TEXT,
        after_content_kind   TEXT,
        after_byte_length    INTEGER,
        recorded_at_ms       INTEGER NOT NULL,
        PRIMARY KEY (proposal_id, op_index),
        FOREIGN KEY (proposal_id)
          REFERENCES sync_relay_share_proposals(proposal_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sync_relay_migrations (
        migration_id TEXT PRIMARY KEY,
        completed_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    const shareColumns = db
      .prepare("PRAGMA table_info(sync_relay_shares)")
      .all()
      .map((row) => String(row.name));
    if (shareColumns.includes("recipient_user_id")) {
      // Pre-launch replacement. Dropping the old parent also clears its
      // proposal rows through the existing cascade. No legacy grant data is
      // carried into the new authority model.
      db.exec(`
        DROP TABLE sync_relay_share_grants;
        DROP TABLE sync_relay_shares;
        ${NORMALIZED_SHARE_SCHEMA_SQL}
      `);
    } else {
      const grantSchema = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_share_grants'")
        .get();
      if (!String(grantSchema?.sql ?? "").includes("'link'")) {
        // Pre-launch replacement of the first normalized grant table. SQLite
        // cannot alter a CHECK constraint in place, and there is no shipped
        // data contract to migrate. Recreate the authority model as one unit.
        db.exec(`
          DROP TABLE sync_relay_link_sessions;
          DROP TABLE sync_relay_link_credentials;
          DROP TABLE sync_relay_share_grants;
          DROP TABLE sync_relay_shares;
          ${NORMALIZED_SHARE_SCHEMA_SQL}
        `);
      }
    }
    // Lazy additive migration (0P sync-hardening item 4): dbs created before the
    // blob retention window gain created_at_ms on open. Existing rows default to
    // 0, so a legacy unreferenced blob is immediately past any grace window and
    // still collectible — the new protection only applies to blobs uploaded
    // with a real timestamp going forward.
    const blobColumns = db
      .prepare("PRAGMA table_info(sync_relay_blobs)")
      .all()
      .map((row) => String(row.name));
    if (!blobColumns.includes("created_at_ms")) {
      db.exec(
        "ALTER TABLE sync_relay_blobs ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0",
      );
    }
    // R10b lazy additive migration: existing relay databases predate sync
    // identity. Both columns stay nullable so legacy workspaces remain unset
    // until the first identity-bearing request claims them.
    const workspaceColumns = db
      .prepare("PRAGMA table_info(sync_relay_workspaces)")
      .all()
      .map((row) => String(row.name));
    if (!workspaceColumns.includes("replication_epoch")) {
      db.exec("ALTER TABLE sync_relay_workspaces ADD COLUMN replication_epoch TEXT");
    }
    if (!workspaceColumns.includes("stream_identity")) {
      db.exec("ALTER TABLE sync_relay_workspaces ADD COLUMN stream_identity TEXT");
    }
    if (!workspaceColumns.includes("epoch_log_floor")) {
      db.exec("ALTER TABLE sync_relay_workspaces ADD COLUMN epoch_log_floor INTEGER");
    }
    const timestampMigrationId = "recorded-at-safe-integer-v1";
    const timestampValidated = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM sync_relay_migrations WHERE migration_id=?) AS complete",
      )
      .get(timestampMigrationId);
    if (Number(timestampValidated?.complete ?? 0) === 0) {
      const invalidTimestamp = db
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM sync_relay_log
             WHERE recorded_at_ms != CAST(recorded_at_ms AS INTEGER)
                OR recorded_at_ms < -9007199254740991
                OR recorded_at_ms > 9007199254740991
           ) AS invalid`,
        )
        .get();
      if (Number(invalidTimestamp?.invalid ?? 0) !== 0) {
        throw new Error("sync relay log contains a timestamp outside the integer wire contract");
      }
      db.prepare(
        "INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)",
      ).run(timestampMigrationId, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  // AFTER the schema transaction commits, in its own. The seed scans every
  // moment.append the log holds, and holding the schema-init write lock for
  // the length of that scan stalls every other opener against
  // SYNC_RELAY_BUSY_TIMEOUT_MS on the first open after a deploy. Its own
  // transaction still makes it atomic — a crash part-way leaves the migration
  // unrecorded and the next open redoes it.
  seedObjectPaths(db);
}

// Where a `moment.append` payload says its object is AFTER the op: the
// destination path of a write or a rename (a rename carries the destination in
// both `path` and `payloadAfterPath`, `crates/dohc-engine-domain/src/store.rs`
// `rename`), or NULL for a delete.
//
// NULL is also the answer for a moment that names an object but no readable
// path. That op moved the object somewhere this table cannot state, and a
// stale row would keep serving the object's chat at a path the relay can no
// longer prove. Unknown denies.
export function objectPathFromMomentPayload(
  payloadJson: string,
): { objectId: string; path: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const record = asObject(parsed);
  if (!record) return null;
  const objectId = record.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) return null;
  if (record.operation === "delete") return { objectId, path: null };
  for (const field of ["path", "payloadAfterPath"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return { objectId, path: value };
  }
  return { objectId, path: null };
}

// #646 PR3a. What one `moment.append` says about its object, in the shape the
// base rewrite reads back. The three fields the read filter already trusts —
// `objectId`, the after path, the after hash — plus the moment's own id, which
// is what `head_fast_forward` compares against on the granter's engine
// (`crates/dohc-engine-sync/src/moment_apply.rs`).
//
// A delete states a null path and a null hash. A moment the relay cannot read
// this far states nothing, and an unindexed moment simply cannot be chosen as
// a base — which fails closed, because an unresolvable base opens a conflict.
export function objectMomentFromMomentPayload(
  payloadJson: string,
): {
  objectId: string;
  momentId: string;
  versionId: string;
  path: string | null;
  blobSha256: string | null;
  contentKind: string | null;
  byteLength: number | null;
  recordedAtMs: number;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const record = asObject(parsed);
  if (!record) return null;
  const objectId = record.objectId;
  const momentId = record.momentId;
  const versionId = record.versionId;
  const recordedAtMs = record.recordedAtMs;
  if (
    typeof objectId !== "string" ||
    objectId.length === 0 ||
    typeof momentId !== "string" ||
    momentId.length === 0 ||
    typeof versionId !== "string" ||
    versionId.length === 0 ||
    typeof recordedAtMs !== "number" ||
    !Number.isSafeInteger(recordedAtMs)
  ) {
    return null;
  }
  const deleted = record.operation === "delete";
  const path = deleted ? null : readableString(record.path) ?? readableString(record.payloadAfterPath);
  const blobSha256 = deleted ? null : readableString(record.payloadAfterBlobSha256);
  const contentKind = deleted ? null : readableString(record.payloadAfterContentKind);
  const byteLength =
    !deleted && typeof record.payloadAfterByteLength === "number" &&
    Number.isSafeInteger(record.payloadAfterByteLength)
      ? record.payloadAfterByteLength
      : null;
  return { objectId, momentId, versionId, path, blobSha256, contentKind, byteLength, recordedAtMs };
}

function readableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const OBJECT_MOMENT_INSERT_SQL = `
  INSERT INTO sync_relay_object_moments (
    workspace_id, object_id, relay_seq, moment_id, version_id,
    path, blob_sha256, content_kind, byte_length, recorded_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace_id, object_id, relay_seq) DO NOTHING`;

// #646 PR2 one-time seed. `sync_relay_object_paths` is maintained at insert
// time, so without this every moment.append already in the log would resolve
// to "the relay has never seen this object" — and the share filter would deny
// chat on every file shared before this deployment, forever. The scan reads
// the log in relay order and lets the LAST moment for each object win, which
// is the same rule the insert-time upsert applies.
function seedObjectPaths(db: SqliteDb): void {
  const migrationId = "object-paths-seed-v1";
  const seeded = db
    .prepare("SELECT EXISTS(SELECT 1 FROM sync_relay_migrations WHERE migration_id=?) AS complete")
    .get(migrationId);
  if (Number(seeded?.complete ?? 0) !== 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: two processes can open the same database
    // at once, both see the marker absent, and only one may do the work.
    const claimed = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM sync_relay_migrations WHERE migration_id=?) AS complete",
      )
      .get(migrationId);
    if (Number(claimed?.complete ?? 0) !== 0) {
      db.exec("COMMIT");
      return;
    }
    const upsert = db.prepare(OBJECT_PATH_UPSERT_SQL);
    const rows = db
      .prepare(
        `SELECT workspace_id, payload_json, relay_seq FROM sync_relay_log
         WHERE op_kind = 'moment.append'
         ORDER BY relay_seq`,
      )
      .all();
    for (const row of rows) {
      const resolved = objectPathFromMomentPayload(String(row.payload_json));
      if (!resolved) continue;
      upsert.run(
        String(row.workspace_id),
        resolved.objectId,
        resolved.path,
        Number(row.relay_seq),
      );
    }
    db.prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)").run(
      migrationId,
      Date.now(),
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

// Latest-wins: a rename is a later fact about the same object, and the share
// must follow the file rather than its history.
//
// The relay_seq guard is defence in depth, and today it is UNREACHABLE: both
// writers walk the log in relay order (appendLogBatch inserts under the write
// lock and reads back the row it just took; the seed scans ORDER BY
// relay_seq), so no upsert here can arrive out of order. Its inverse mutation
// therefore survives, which is recorded rather than papered over. It stays
// because this table decides which chat a share serves, and a path moved
// backwards by a future out-of-order writer would serve a file's discussion at
// a path the relay can no longer prove.
const OBJECT_PATH_UPSERT_SQL = `
  INSERT INTO sync_relay_object_paths (workspace_id, object_id, path, relay_seq)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(workspace_id, object_id) DO UPDATE
    SET path = excluded.path, relay_seq = excluded.relay_seq
    WHERE excluded.relay_seq > sync_relay_object_paths.relay_seq`;

export function openSyncRelayStorage(
  dbPath: string,
  options: OpenSyncRelayStorageOptions = {},
): SyncRelayStorage {
  const resolved = resolve(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const { DatabaseSync } = nodeSqlite();
  const workspaceQuotaBytes =
    options.workspaceQuotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES;
  // Validate the quota HERE, not just in main.ts: this helper is exported and
  // reused (tests, other services). A NaN/Infinity/negative cap would silently
  // disable the quota check (currentUsage + added > NaN is always false), so
  // reject anything that is not a positive safe integer before constructing
  // storage.
  if (!Number.isSafeInteger(workspaceQuotaBytes) || workspaceQuotaBytes <= 0) {
    throw new Error(
      `workspaceQuotaBytes must be a positive safe integer, got ${String(workspaceQuotaBytes)}`,
    );
  }
  const blobGraceMs = options.blobGraceMs ?? DEFAULT_BLOB_GRACE_MS;
  if (!Number.isSafeInteger(blobGraceMs) || blobGraceMs < 0) {
    throw new Error(
      `blobGraceMs must be a non-negative safe integer, got ${String(blobGraceMs)}`,
    );
  }
  const db = new DatabaseSync(resolved);
  try {
    db.exec(`PRAGMA busy_timeout = ${SYNC_RELAY_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeSyncRelaySchema(db);
    return new SqliteSyncRelayStorage(db, workspaceQuotaBytes, blobGraceMs);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

class SqliteSyncRelayStorage implements SyncRelayStorage {
  constructor(
    private readonly db: SqliteDb,
    private readonly workspaceQuotaBytes: number,
    private readonly blobGraceMs: number,
  ) {}

  close(): void {
    this.db.close();
  }

  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      if (typeof existing?.owner_user_id === "string") {
        this.db.exec("COMMIT");
        return existing.owner_user_id === input.ownerUserId ? "owned" : "not-owner";
      }
      this.db
        .prepare(
          `INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms)
           VALUES (?, ?, ?)`,
        )
        .run(input.workspaceId, input.ownerUserId, Math.trunc(input.createdAtMs));
      this.db.exec("COMMIT");
      return "created";
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  getWorkspaceIdentity(workspaceId: string): WorkspaceSyncIdentity | null {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) return null;
    const replicationEpoch = row.replication_epoch;
    const streamIdentity = row.stream_identity;
    if (replicationEpoch == null && streamIdentity == null) return null;
    if (typeof replicationEpoch !== "string" || typeof streamIdentity !== "string") {
      throw new Error("sync relay workspace identity is partially populated");
    }
    return { replicationEpoch, streamIdentity };
  }

  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity,
                EXISTS(
                  SELECT 1 FROM sync_relay_log
                  WHERE sync_relay_log.workspace_id = sync_relay_workspaces.workspace_id
                    AND sync_relay_log.relay_seq >
                      COALESCE(sync_relay_workspaces.epoch_log_floor, 0)
                  LIMIT 1
                ) AS has_content
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) throw new Error("workspace does not exist");
    const hasContent = row.has_content;
    if (hasContent !== 0 && hasContent !== 1) {
      throw new Error("sync relay workspace content state is invalid");
    }
    return {
      hasContent: hasContent === 1,
      identity: workspaceIdentityFromRow(row),
    };
  }

  getEpochLogFloor(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT epoch_log_floor
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) throw new Error("workspace does not exist");
    if (row.epoch_log_floor == null) return 0;
    const floor = Number(row.epoch_log_floor);
    if (!Number.isSafeInteger(floor) || floor < 0) {
      throw new Error("sync relay workspace epoch log floor is invalid");
    }
    return floor;
  }

  verifyWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(input.workspaceId);
    if (row === undefined) {
      throw new Error("cannot verify identity for an absent workspace");
    }
    const current = workspaceIdentityFromRow(row);
    // Reads never establish identity. An identity-bearing GET against an
    // unset workspace has no coordinate to match and is therefore unknown.
    if (current === null) return "epoch-unknown";
    return this.classifyWorkspaceIdentity(input.workspaceId, current, input);
  }

  claimWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult {
    // The common path is verification only. Do this SELECT before taking a
    // write lock so matched identity-bearing pulls/claims do not serialize
    // against relay writers.
    const initial = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(input.workspaceId);
    if (initial === undefined) {
      throw new Error("cannot claim identity for an absent workspace");
    }
    const initialIdentity = workspaceIdentityFromRow(initial);
    if (initialIdentity !== null) {
      return this.classifyWorkspaceIdentity(
        input.workspaceId,
        initialIdentity,
        input,
      );
    }

    // Only first adoption needs a write transaction. Re-read after acquiring
    // the lock to close the race with another claimant.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT replication_epoch, stream_identity
           FROM sync_relay_workspaces
           WHERE workspace_id = ?`,
        )
        .get(input.workspaceId);
      if (row === undefined) {
        throw new Error("cannot claim identity for an absent workspace");
      }
      const current = workspaceIdentityFromRow(row);
      if (current === null) {
        this.db
          .prepare(
            `UPDATE sync_relay_workspaces
             SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = 0
             WHERE workspace_id = ?`,
          )
          .run(input.replicationEpoch, input.streamIdentity, input.workspaceId);
        this.db.exec("COMMIT");
        return "claimed";
      }
      const result = this.classifyWorkspaceIdentity(input.workspaceId, current, input);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  rotateWorkspaceIdentity(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT owner_user_id, replication_epoch, stream_identity
           FROM sync_relay_workspaces
           WHERE workspace_id = ?`,
        )
        .get(input.workspaceId);
      if (row === undefined || row.owner_user_id !== input.ownerUserId) {
        this.db.exec("COMMIT");
        return "not-owner";
      }
      const replicationEpoch = row.replication_epoch;
      const streamIdentity = row.stream_identity;
      if (replicationEpoch == null && streamIdentity != null) {
        throw new Error("sync relay workspace identity is partially populated");
      }
      if (replicationEpoch != null && typeof replicationEpoch !== "string") {
        throw new Error("sync relay workspace identity has an invalid epoch");
      }
      if (streamIdentity == null && replicationEpoch != null) {
        throw new Error("sync relay workspace identity is partially populated");
      }
      if (streamIdentity != null && typeof streamIdentity !== "string") {
        throw new Error("sync relay workspace identity has an invalid stream");
      }
      if (
        replicationEpoch === input.replicationEpoch &&
        streamIdentity === input.streamIdentity
      ) {
        this.db.exec("COMMIT");
        return "unchanged";
      }

      // An epoch number that has entered history must never become active
      // again, even under a freshly minted stream id. This prevents a reset
      // generation from being resurrected by changing only half the coordinate.
      const targetEpochWasSuperseded =
        this.db
          .prepare(
            `SELECT 1 AS ok
             FROM sync_relay_epoch_supersessions
             WHERE workspace_id = ? AND replication_epoch = ?
             LIMIT 1`,
          )
          .get(input.workspaceId, input.replicationEpoch) !== undefined;
      if (targetEpochWasSuperseded) {
        this.db.exec("COMMIT");
        return "epoch-superseded";
      }
      if (typeof replicationEpoch === "string" && typeof streamIdentity === "string") {
        const alreadyRecorded =
          this.db
            .prepare(
              `SELECT 1 AS ok
               FROM sync_relay_epoch_supersessions
               WHERE workspace_id = ? AND replication_epoch = ? AND stream_identity = ?`,
            )
            .get(input.workspaceId, replicationEpoch, streamIdentity) !== undefined;
        if (!alreadyRecorded) {
          this.assertWorkspaceQuota(
            input.workspaceId,
            Buffer.byteLength(replicationEpoch, "utf8") +
              Buffer.byteLength(streamIdentity, "utf8"),
          );
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO sync_relay_epoch_supersessions (
              workspace_id, replication_epoch, stream_identity, superseded_at_ms
          ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            input.workspaceId,
            replicationEpoch,
            streamIdentity,
            Math.trunc(input.rotatedAtMs),
          );
      }
      const floor = Number(
        this.db
          .prepare(
            `SELECT COALESCE(MAX(relay_seq), 0) AS floor
             FROM sync_relay_log
             WHERE workspace_id = ?`,
          )
          .get(input.workspaceId)?.floor ?? 0,
      );
      this.db
        .prepare(
          `UPDATE sync_relay_workspaces
           SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = ?
           WHERE workspace_id = ?`,
        )
        .run(input.replicationEpoch, input.streamIdentity, floor, input.workspaceId);
      this.db.exec("COMMIT");
      return "rotated";
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private classifyWorkspaceIdentity(
    workspaceId: string,
    current: WorkspaceSyncIdentity,
    presented: WorkspaceSyncIdentity,
  ): VerifyWorkspaceIdentityResult {
    if (
      current.replicationEpoch === presented.replicationEpoch &&
      current.streamIdentity === presented.streamIdentity
    ) {
      return "matched";
    }
    const coordinateWasSuperseded =
      this.db
        .prepare(
          `SELECT 1 AS ok
           FROM sync_relay_epoch_supersessions
           WHERE workspace_id = ? AND replication_epoch = ? AND stream_identity = ?`,
        )
        .get(
          workspaceId,
          presented.replicationEpoch,
          presented.streamIdentity,
        ) !== undefined;
    if (coordinateWasSuperseded) return "epoch-superseded";
    if (current.replicationEpoch !== presented.replicationEpoch) {
      return "epoch-unknown";
    }
    return "stream-mismatch";
  }

  private enforceWorkspaceIdentityInTransaction(
    workspaceId: string,
    presented: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) {
      throw new Error("cannot enforce identity for an absent workspace");
    }
    const current = workspaceIdentityFromRow(row);
    if (presented === null) {
      return current === null ? "matched" : "identity-required";
    }
    if (current !== null) {
      return this.classifyWorkspaceIdentity(workspaceId, current, presented);
    }
    this.db
      .prepare(
        `UPDATE sync_relay_workspaces
         SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = 0
         WHERE workspace_id = ?`,
      )
      .run(presented.replicationEpoch, presented.streamIdentity, workspaceId);
    return "claimed";
  }

  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM sync_relay_workspaces
         WHERE workspace_id = ? AND owner_user_id = ?`,
      )
      .get(workspaceId, ownerUserId);
    return row !== undefined;
  }

  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult {
    const byteLength = input.content.byteLength;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT 1 AS ok FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
        )
        .get(input.workspaceId, input.sha256);
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return { byteLength, alreadyHad: true };
      }
      this.assertWorkspaceQuota(input.workspaceId, byteLength);
      this.db
        .prepare(
          `INSERT INTO sync_relay_blobs (workspace_id, sha256, byte_length, content, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          input.sha256,
          byteLength,
          Buffer.from(input.content),
          Math.trunc(input.createdAtMs),
        );
      this.db.exec("COMMIT");
      return { byteLength, alreadyHad: false };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async collectUnreferencedBlobs(
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult> {
    // Grace window (item 4): never reclaim a blob younger than blobGraceMs, so
    // a blob uploaded just before its referencing log op is appended survives
    // the gap between the two phases. cutoff is the newest created_at_ms still
    // eligible for collection.
    //
    // #646 PR3a: an OPEN proposal's content is referenced too, and the log
    // cannot say so — a proposed change is not in the log, which is the whole
    // point of holding it. Without this second clause a proposal left open
    // past the grace window would lose its content to the sweep and could
    // never be accepted, so the granter's only honest answer would be
    // "decline". A settled proposal stops protecting its blobs: an accepted
    // one has them in the log, and a declined one never will.
    const cutoff = options.nowMs - this.blobGraceMs;
    // Phase 1 (read only, no write lock): candidate shas that are unreferenced
    // AND aged past the grace window.
    const candidates = this.db
      .prepare(
        `SELECT b.sha256
         FROM sync_relay_blobs b
         WHERE b.workspace_id = ?
           AND b.created_at_ms <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM sync_relay_log l
             WHERE l.workspace_id = b.workspace_id
               AND l.payload_json LIKE '%' || b.sha256 || '%'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM sync_relay_share_proposal_ops o
             JOIN sync_relay_share_proposals p ON p.proposal_id = o.proposal_id
             WHERE p.workspace_id = b.workspace_id
               AND p.state = 'open'
               AND o.after_blob_sha256 = b.sha256
           )
         ORDER BY b.sha256`,
      )
      .all(workspaceId, cutoff)
      .map((row) => String(row.sha256));
    // Phase 2: delete in bounded chunks, each in its OWN short transaction, and
    // yield the event loop between chunks so a large sweep never monopolizes it
    // (CodeRabbit: keep GC off the single-threaded request path). The delete
    // RE-CHECKS unreferenced + aged so a blob newly referenced (or replaced)
    // between phases is left alone.
    const removedSha256s: string[] = [];
    const deleteStmt = this.db.prepare(
      `DELETE FROM sync_relay_blobs
       WHERE workspace_id = ? AND sha256 = ? AND created_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM sync_relay_log l
           WHERE l.workspace_id = ?
             AND l.payload_json LIKE '%' || ? || '%'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM sync_relay_share_proposal_ops o
           JOIN sync_relay_share_proposals p ON p.proposal_id = o.proposal_id
           WHERE p.workspace_id = ? AND p.state = 'open' AND o.after_blob_sha256 = ?
         )`,
    );
    const CHUNK = 200;
    for (let start = 0; start < candidates.length; start += CHUNK) {
      const chunk = candidates.slice(start, start + CHUNK);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const sha256 of chunk) {
          const result = deleteStmt.run(
            workspaceId,
            sha256,
            cutoff,
            workspaceId,
            sha256,
            workspaceId,
            sha256,
          );
          if (result.changes > 0) removedSha256s.push(sha256);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      if (start + CHUNK < candidates.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { removed: removedSha256s.length, removedSha256s };
  }

  getBlob(workspaceId: string, sha256: string): Uint8Array | null {
    const row = this.db
      .prepare(
        "SELECT content FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
      )
      .get(workspaceId, sha256);
    const content = row?.content;
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    return null;
  }

  missingBlobs(workspaceId: string, sha256s: string[]): string[] {
    if (sha256s.length === 0) return [];
    // Batch the presence check into chunked `IN (...)` queries instead of one
    // point SELECT per hash (was up to ~2,000 sequential round trips). Dedupe
    // the probe set but preserve the caller's order/duplicates in the result.
    const unique = [...new Set(sha256s)];
    const found = new Set<string>();
    // Keep well under SQLite's default 999 bound-variable limit (one slot is
    // taken by workspace_id).
    const CHUNK = 500;
    for (let start = 0; start < unique.length; start += CHUNK) {
      const chunk = unique.slice(start, start + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT sha256 FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 IN (${placeholders})`,
        )
        .all(workspaceId, ...chunk);
      for (const row of rows) {
        if (typeof row.sha256 === "string") found.add(row.sha256);
      }
    }
    return sha256s.filter((sha256) => !found.has(sha256));
  }

  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string } {
    const nextSha256 = sha256HexUtf8(input.envelopeJson);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT envelope_json FROM sync_relay_key_envelopes WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      const currentJson =
        typeof current?.envelope_json === "string" ? current.envelope_json : null;
      if (currentJson === input.envelopeJson) {
        // Byte-identical re-PUT: an idempotent retry (e.g. enroll after a
        // dropped response), not a replacement. No history entry.
        this.db.exec("COMMIT");
        return { sha256: nextSha256 };
      }
      // The envelope + its append-only history count toward the workspace
      // quota (CodeRabbit Stability): each rotation adds roughly the new
      // envelope's size (the prior copy moves into history), so the cap now
      // bounds unbounded rotation growth. workspaceUsageBytes already includes
      // both tables, so the incremental bytes to charge is the new envelope.
      const envelopeAddedBytes = Buffer.byteLength(input.envelopeJson, "utf8");
      if (currentJson === null) {
        if (input.expectedSha256 !== null) {
          throw new SyncRelayConflictError(
            "key envelope does not exist; a conditional replace has nothing to match",
          );
        }
        this.assertWorkspaceQuota(input.workspaceId, envelopeAddedBytes);
        this.db
          .prepare(
            `INSERT INTO sync_relay_key_envelopes (workspace_id, envelope_json, updated_at_ms)
             VALUES (?, ?, ?)`,
          )
          .run(input.workspaceId, input.envelopeJson, Math.trunc(input.updatedAtMs));
        this.db.exec("COMMIT");
        return { sha256: nextSha256 };
      }
      const currentSha256 = sha256HexUtf8(currentJson);
      if (input.expectedSha256 === null) {
        throw new SyncRelayConflictError(
          "key envelope already exists; replacing it requires If-Match with the current sha256",
        );
      }
      if (input.expectedSha256 !== currentSha256) {
        throw new SyncRelayConflictError(
          "key envelope was replaced concurrently; refresh and retry with the current sha256",
        );
      }
      this.assertWorkspaceQuota(input.workspaceId, envelopeAddedBytes);
      this.db
        .prepare(
          `INSERT INTO sync_relay_key_envelope_history (
            workspace_id, envelope_json, envelope_sha256, replaced_at_ms, replaced_by_sha256
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          currentJson,
          currentSha256,
          Math.trunc(input.updatedAtMs),
          nextSha256,
        );
      this.db
        .prepare(
          `UPDATE sync_relay_key_envelopes
           SET envelope_json = ?, updated_at_ms = ?
           WHERE workspace_id = ?`,
        )
        .run(input.envelopeJson, Math.trunc(input.updatedAtMs), input.workspaceId);
      this.db.exec("COMMIT");
      return { sha256: nextSha256 };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  getKeyEnvelope(workspaceId: string): KeyEnvelopeRow | null {
    const row = this.db
      .prepare(
        "SELECT envelope_json, updated_at_ms FROM sync_relay_key_envelopes WHERE workspace_id = ?",
      )
      .get(workspaceId);
    if (typeof row?.envelope_json !== "string") return null;
    return {
      envelopeJson: row.envelope_json,
      sha256: sha256HexUtf8(row.envelope_json),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  getKeyEnvelopeHistory(workspaceId: string): KeyEnvelopeHistoryRow[] {
    return this.db
      .prepare(
        `SELECT envelope_json, envelope_sha256, replaced_at_ms, replaced_by_sha256
         FROM sync_relay_key_envelope_history
         WHERE workspace_id = ?
         ORDER BY history_seq`,
      )
      .all(workspaceId)
      .map((row) => ({
        envelopeJson: String(row.envelope_json),
        sha256: String(row.envelope_sha256),
        replacedAtMs: Number(row.replaced_at_ms),
        replacedBySha256: String(row.replaced_by_sha256),
      }));
  }

  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    guard?: (context: AppendLogBatchGuardContext) => void;
  }): AppendLogBatchResult {
    for (const op of input.ops) {
      if (typeof op.recordedAtMs !== "number" || !Number.isSafeInteger(op.recordedAtMs)) {
        throw new Error("recordedAtMs must be an integer in the safe wire range");
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Authorization re-verification under the write lock (see the interface
      // comment): BEGIN IMMEDIATE serializes writers, so a revoke committed
      // by another writer is either already visible here (guard throws, batch
      // rolls back) or must wait for this COMMIT — there is no in-between.
      input.guard?.({
        enforceWorkspaceIdentity: (identity) =>
          this.enforceWorkspaceIdentityInTransaction(input.workspaceId, identity),
      });
      let inserted = 0;
      let skipped = 0;
      let addedLogBytes = 0;
      const newOps: SyncRelayLogInput[] = [];
      const maxStmt = this.db.prepare(
        `SELECT COALESCE(MAX(origin_seq), -1) AS max_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ?`,
      );
      const existingStmt = this.db.prepare(
        `SELECT op_kind, payload_json, recorded_at_ms
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      );
      // Read the current MAX(origin_seq) once, then track it locally: each
      // insert is exactly currentMax + 1, so re-querying per op (was N extra
      // SELECTs per batch) is unnecessary. Skipped ops leave it unchanged.
      let currentMax = Number(
        maxStmt.get(input.workspaceId, input.originId)?.max_seq ?? -1,
      );
      for (const op of input.ops) {
        if (op.originSeq <= currentMax) {
          const existing = existingStmt.get(
            input.workspaceId,
            input.originId,
            op.originSeq,
          );
          if (
            existing &&
            existing.op_kind === op.opKind &&
            existing.payload_json === op.payloadJson &&
            Number(existing.recorded_at_ms) === op.recordedAtMs
          ) {
            skipped += 1;
            continue;
          }
          throw new SyncRelayConflictError(
            `origin_seq ${op.originSeq} already exists with different content`,
          );
        }
        if (op.originSeq !== currentMax + 1) {
          throw new SyncRelayConflictError(
            `origin_seq gap: expected ${currentMax + 1}, got ${op.originSeq}`,
          );
        }
        currentMax = op.originSeq;
        newOps.push(op);
        addedLogBytes += Buffer.byteLength(op.payloadJson, "utf8");
      }

      this.assertWorkspaceQuota(input.workspaceId, addedLogBytes);

      // Data-integrity gate (0P sync-hardening): a log op must never be made
      // durable while it references a blob the relay does not hold. The blob
      // GC grace window covers the fresh PUT->POST gap, but NOT an old blob
      // that ages past the grace, nor a blob GC'd after a failed /log that a
      // retry then re-references via /blobs/have. Validate every referenced
      // sha IN THIS SAME transaction, before inserting: SQLite serializes
      // writers (BEGIN IMMEDIATE), so a concurrent GC cannot delete a checked
      // blob between this probe and the insert that pins it. Only NEW ops are
      // checked -- a skipped idempotent duplicate is already durable and its
      // blobs were validated at first append. Any missing blob rejects the
      // WHOLE batch atomically (no partial append) with a retryable error the
      // client resolves by re-uploading and re-posting.
      const referencedShas = new Set<string>();
      for (const op of newOps) {
        for (const sha of referencedBlobShas(op.opKind, op.payloadJson, {
          workspaceId: input.workspaceId,
          recordedAtMs: op.recordedAtMs,
        })) {
          referencedShas.add(sha);
        }
      }
      if (referencedShas.size > 0) {
        const missing = this.missingBlobs(input.workspaceId, [...referencedShas]);
        if (missing.length > 0) {
          throw new SyncRelayBlobMissingError(
            `log append references ${missing.length} blob(s) not stored on the relay ` +
              `(first: ${missing[0]}); (re-)upload the blob(s) and retry`,
          );
        }
      }

      const insertStmt = this.db.prepare(
        `INSERT INTO sync_relay_log (
          workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const objectPathStmt = this.db.prepare(OBJECT_PATH_UPSERT_SQL);
      const objectMomentStmt = this.db.prepare(OBJECT_MOMENT_INSERT_SQL);
      for (const op of newOps) {
        const result = insertStmt.run(
          input.workspaceId,
          input.originId,
          op.originSeq,
          op.opKind,
          op.payloadJson,
          op.recordedAtMs,
        );
        inserted += 1;
        // #646 PR2: keep "where is this object now?" answerable by primary
        // key. The relay_seq this row just took IS the order the guard in the
        // upsert compares, so a later moment always wins and an out-of-order
        // one never moves a path backwards.
        if (op.opKind === "moment.append") {
          const resolved = objectPathFromMomentPayload(op.payloadJson);
          if (resolved) {
            objectPathStmt.run(
              input.workspaceId,
              resolved.objectId,
              resolved.path,
              Number(result.lastInsertRowid),
            );
          }
          // #646 PR3a: the same insert, one question deeper. The row above
          // keeps "where is this object now?" answerable; this one keeps
          // "which moment produced this content?" answerable, which is what a
          // proposal's base resolves to at accept.
          const moment = objectMomentFromMomentPayload(op.payloadJson);
          if (moment) {
            objectMomentStmt.run(
              input.workspaceId,
              moment.objectId,
              Number(result.lastInsertRowid),
              moment.momentId,
              moment.versionId,
              moment.path,
              moment.blobSha256,
              moment.contentKind,
              moment.byteLength,
              moment.recordedAtMs,
            );
          }
        }
      }

      this.db.exec("COMMIT");
      return { inserted, skipped, currentMaxOriginSeq: currentMax };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private workspaceUsageBytes(workspaceId: string): number {
    const blobRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(byte_length), 0) AS bytes
         FROM sync_relay_blobs
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    const logRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
         FROM sync_relay_log
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    // Key envelopes count toward the quota too (CodeRabbit Stability): the
    // current envelope plus the append-only history table can otherwise grow
    // without bound across repeated CAS rotations, letting a workspace bypass
    // its cap by replacing the envelope over and over.
    const envelopeRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(CAST(envelope_json AS BLOB))), 0) AS bytes
         FROM sync_relay_key_envelopes
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    const envelopeHistoryRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(CAST(envelope_json AS BLOB))), 0) AS bytes
         FROM sync_relay_key_envelope_history
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    // Epoch supersessions are append-only identity history. Count both
    // identifier payloads so repeated rotations cannot grow the relay DB
    // outside the same per-workspace cap as log/blob/key-envelope history.
    const supersessionRow = this.db
      .prepare(
        `SELECT COALESCE(
           SUM(
             length(CAST(replication_epoch AS BLOB)) +
             length(CAST(stream_identity AS BLOB))
           ),
           0
         ) AS bytes
         FROM sync_relay_epoch_supersessions
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    return (
      Number(blobRow?.bytes ?? 0) +
      Number(logRow?.bytes ?? 0) +
      Number(envelopeRow?.bytes ?? 0) +
      Number(envelopeHistoryRow?.bytes ?? 0) +
      Number(supersessionRow?.bytes ?? 0)
    );
  }

  private assertWorkspaceQuota(workspaceId: string, addedBytes: number): void {
    if (addedBytes <= 0) return;
    const currentUsage = this.workspaceUsageBytes(workspaceId);
    if (currentUsage + addedBytes > this.workspaceQuotaBytes) {
      throw new SyncRelayQuotaExceededError(
        `workspace storage quota exceeded: ${currentUsage + addedBytes} bytes would exceed quota ${this.workspaceQuotaBytes}`,
      );
    }
  }

  createShare(input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
  }): void {
    if (input.grant.shareId !== input.share.shareId) {
      throw new Error("share and grant ids do not match");
    }
    if (input.grant.principalKind === "link") {
      throw new Error("a link grant requires an existing share and a credential");
    }
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO sync_relay_shares (
            share_id, workspace_id, granter_user_id, selector_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.share.shareId,
          input.share.workspaceId,
          input.share.granterUserId,
          input.share.selectorJson,
          Math.trunc(input.share.createdAtMs),
        );
      this.db
        .prepare(
          `INSERT INTO sync_relay_share_grants (
            grant_id, share_id, principal_kind, principal_user_id, principal_email,
            access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.grant.grantId,
          input.grant.shareId,
          input.grant.principalKind,
          input.grant.principalUserId,
          input.grant.principalEmail,
          input.grant.access,
          input.grant.generation,
          input.grant.status,
          Math.trunc(input.grant.createdAtMs),
          input.grant.revokedAtMs,
          input.grant.parentGrantId,
      );
    });
  }

  createLinkGrant(input: {
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
  }): boolean {
    const { grant, credential } = input;
    if (
      grant.principalKind !== "link" ||
      grant.principalUserId !== null ||
      grant.principalEmail !== null ||
      grant.parentGrantId !== null ||
      grant.status !== "active" ||
      grant.revokedAtMs !== null ||
      grant.generation !== 1 ||
      credential.grantId !== grant.grantId ||
      credential.generation !== grant.generation ||
      credential.retiredAtMs !== null ||
      !credential.secretHash
    ) {
      return false;
    }
    return this.tx(() => {
      const activeShare = this.db
        .prepare(
          `SELECT 1 AS active
           FROM sync_relay_share_grants
           WHERE share_id = ? AND status = 'active'
           LIMIT 1`,
        )
        .get(grant.shareId);
      if (!this.getShare(grant.shareId) || !activeShare) return false;
      this.insertShareGrant(grant);
      this.insertLinkCredential(credential);
      return true;
    });
  }

  getShareGrant(grantId: string): SyncRelayShareGrantRow | null {
    const row = this.db
      .prepare(
        `SELECT grant_id, share_id, principal_kind, principal_user_id, principal_email,
                access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         FROM sync_relay_share_grants WHERE grant_id = ?`,
      )
      .get(grantId);
    return row ? rowToShareGrantRow(row) : null;
  }

  getCurrentLinkCredential(grantId: string): SyncRelayLinkCredentialRow | null {
    const row = this.db
      .prepare(
        `SELECT credential_id, grant_id, secret_hash, generation, minted_at_ms, retired_at_ms
         FROM sync_relay_link_credentials
         WHERE grant_id = ? AND retired_at_ms IS NULL
         LIMIT 1`,
      )
      .get(grantId);
    return row ? rowToLinkCredentialRow(row) : null;
  }

  findLinkGrantByCredentialHash(
    secretHash: string,
  ): SyncRelayLinkCredentialGrantRow | null {
    const row = this.db
      .prepare(
        `SELECT c.credential_id, c.grant_id AS credential_grant_id, c.secret_hash,
                c.generation AS credential_generation, c.minted_at_ms, c.retired_at_ms,
                g.grant_id, g.share_id, g.principal_kind, g.principal_user_id,
                g.principal_email, g.access, g.generation, g.status, g.created_at_ms,
                g.revoked_at_ms, g.parent_grant_id
         FROM sync_relay_link_credentials c
         JOIN sync_relay_share_grants g ON g.grant_id = c.grant_id
         WHERE c.secret_hash = ? AND c.retired_at_ms IS NULL
         LIMIT 1`,
      )
      .get(secretHash);
    if (!row) return null;
    return {
      credential: rowToLinkCredentialRow({
        ...row,
        grant_id: row.credential_grant_id,
        generation: row.credential_generation,
      }),
      grant: rowToShareGrantRow(row),
    };
  }

  rotateLinkGrant(input: {
    shareId: string;
    grantId: string;
    credentialId: string;
    secretHash: string;
    rotatedAtMs: number;
  }): ShareGrantTransitionResult {
    if (!input.credentialId || !input.secretHash) return { ok: false };
    return this.tx(() => {
      const grant = this.getShareGrant(input.grantId);
      const current = this.getCurrentLinkCredential(input.grantId);
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.principalKind !== "link" ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null ||
        !current ||
        current.generation !== grant.generation
      ) {
        return { ok: false };
      }
      const generation = grant.generation + 1;
      this.db
        .prepare("UPDATE sync_relay_share_grants SET generation = ? WHERE grant_id = ?")
        .run(generation, grant.grantId);
      this.retireCurrentLinkCredential(grant.grantId, input.rotatedAtMs);
      this.insertLinkCredential({
        credentialId: input.credentialId,
        grantId: grant.grantId,
        secretHash: input.secretHash,
        generation,
        mintedAtMs: input.rotatedAtMs,
        retiredAtMs: null,
      });
      this.pruneRetiredLinkCredentials(grant.grantId);
      this.incrementActiveDependentGenerations(grant.grantId);
      return { ok: true, grant: this.getShareGrant(grant.grantId)! };
    });
  }

  retuneShareGrant(input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    credentialId?: string;
    secretHash?: string;
  }): ShareGrantTransitionResult {
    return this.tx(() => {
      const grant = this.getShareGrant(input.grantId);
      const from = grant ? shareAccessRank(grant.access) : -1;
      const to = shareAccessRank(input.access);
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.principalKind !== "link" ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null ||
        from < 0 ||
        to < 0 ||
        from === to
      ) {
        return { ok: false };
      }

      const widening = to > from;
      const suppliedCredential =
        input.credentialId !== undefined || input.secretHash !== undefined;
      const wideningCredential =
        widening && input.credentialId && input.secretHash
          ? { credentialId: input.credentialId, secretHash: input.secretHash }
          : null;
      const current = this.getCurrentLinkCredential(grant.grantId);
      if (!current || current.generation !== grant.generation) {
        return { ok: false };
      }
      if (widening && !wideningCredential) {
        return { ok: false };
      }
      if (!widening && suppliedCredential) {
        return { ok: false };
      }

      const generation = grant.generation + 1;
      this.db
        .prepare(
          "UPDATE sync_relay_share_grants SET access = ?, generation = ? WHERE grant_id = ?",
        )
        .run(input.access, generation, grant.grantId);

      if (wideningCredential) {
        this.retireCurrentLinkCredential(grant.grantId, input.changedAtMs);
        this.insertLinkCredential({
          credentialId: wideningCredential.credentialId,
          grantId: grant.grantId,
          secretHash: wideningCredential.secretHash,
          generation,
          mintedAtMs: input.changedAtMs,
          retiredAtMs: null,
        });
        this.pruneRetiredLinkCredentials(grant.grantId);
        this.incrementActiveDependentGenerations(grant.grantId);
      } else {
        this.db
          .prepare(
            `UPDATE sync_relay_link_credentials
             SET generation = ?
             WHERE grant_id = ? AND retired_at_ms IS NULL`,
          )
          .run(generation, grant.grantId);
        const dependents = this.activeDependentGrants(grant.grantId);
        for (const dependent of dependents) {
          const dependentRank = shareAccessRank(dependent.access);
          if (dependentRank > to) {
            this.db
              .prepare(
                `UPDATE sync_relay_share_grants
                 SET access = ?
                 WHERE grant_id = ? AND status = 'active'`,
              )
              .run(input.access, dependent.grantId);
          }
        }
        this.incrementActiveDependentGenerations(grant.grantId);
      }
      return { ok: true, grant: this.getShareGrant(grant.grantId)! };
    });
  }

  revokeShareGrant(input: {
    shareId: string;
    grantId: string;
    revokedAtMs: number;
  }): ShareGrantTransitionResult {
    return this.tx(() => {
      const grant = this.getShareGrant(input.grantId);
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null
      ) {
        return { ok: false };
      }
      const revokedAtMs = Math.trunc(input.revokedAtMs);
      this.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET status = 'revoked', generation = generation + 1, revoked_at_ms = ?
           WHERE grant_id = ?`,
        )
        .run(revokedAtMs, grant.grantId);
      if (grant.principalKind === "link") {
        this.retireCurrentLinkCredential(grant.grantId, revokedAtMs);
        this.db
          .prepare(
            `UPDATE sync_relay_share_grants
             SET status = 'revoked', generation = generation + 1, revoked_at_ms = ?
             WHERE parent_grant_id = ? AND status = 'active'`,
          )
          .run(revokedAtMs, grant.grantId);
      }
      return { ok: true, grant: this.getShareGrant(grant.grantId)! };
    });
  }

  convertLinkGrant(input: {
    shareId: string;
    parentGrantId: string;
    grantId: string;
    principalUserId: string;
    createdAtMs: number;
  }): ShareGrantTransitionResult {
    return this.tx(() => {
      const parent = this.getShareGrant(input.parentGrantId);
      if (
        !parent ||
        parent.shareId !== input.shareId ||
        parent.principalKind !== "link" ||
        parent.status !== "active" ||
        parent.revokedAtMs !== null ||
        !input.principalUserId
      ) {
        return { ok: false };
      }
      const grant: SyncRelayShareGrantRow = {
        grantId: input.grantId,
        shareId: input.shareId,
        principalKind: "user",
        principalUserId: input.principalUserId,
        principalEmail: null,
        access: parent.access,
        generation: 1,
        status: "active",
        createdAtMs: Math.trunc(input.createdAtMs),
        revokedAtMs: null,
        parentGrantId: parent.grantId,
      };
      this.insertShareGrant(grant);
      return { ok: true, grant };
    });
  }

  promoteShareGrant(input: {
    shareId: string;
    grantId: string;
  }): ShareGrantTransitionResult {
    return this.tx(() => {
      const grant = this.getShareGrant(input.grantId);
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.principalKind !== "user" ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null ||
        grant.parentGrantId === null
      ) {
        return { ok: false };
      }
      this.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET parent_grant_id = NULL, generation = generation + 1
           WHERE grant_id = ?`,
        )
        .run(grant.grantId);
      return { ok: true, grant: this.getShareGrant(grant.grantId)! };
    });
  }

  mintLinkSession(input: {
    session: SyncRelayLinkSessionRow;
    guard?: () => void;
  }): boolean {
    const { session } = input;
    if (
      !session.capabilityHash ||
      session.expiresAtMs <= session.mintedAtMs ||
      session.generation < 1
    ) {
      return false;
    }
    return this.tx(() => {
      input.guard?.();
      const grant = this.getShareGrant(session.grantId);
      if (
        !grant ||
        grant.principalKind !== "link" ||
        grant.status !== "active" ||
        grant.generation !== session.generation
      ) {
        return false;
      }
      this.db
        .prepare("DELETE FROM sync_relay_link_sessions WHERE expires_at_ms <= ?")
        .run(Math.trunc(session.mintedAtMs));
      this.db
        .prepare(
          `INSERT INTO sync_relay_link_sessions (
             session_id, capability_hash, grant_id, generation, minted_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.sessionId,
          session.capabilityHash,
          session.grantId,
          session.generation,
          Math.trunc(session.mintedAtMs),
          Math.trunc(session.expiresAtMs),
        );
      return true;
    });
  }

  findLinkSessionByCapabilityHash(
    capabilityHash: string,
  ): SyncRelayLinkSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT session_id, capability_hash, grant_id, generation, minted_at_ms, expires_at_ms
         FROM sync_relay_link_sessions WHERE capability_hash = ? LIMIT 1`,
      )
      .get(capabilityHash);
    return row ? rowToLinkSessionRow(row) : null;
  }

  private insertShareGrant(grant: SyncRelayShareGrantRow): void {
    this.db
      .prepare(
        `INSERT INTO sync_relay_share_grants (
           grant_id, share_id, principal_kind, principal_user_id, principal_email,
           access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.grantId,
        grant.shareId,
        grant.principalKind,
        grant.principalUserId,
        grant.principalEmail,
        grant.access,
        grant.generation,
        grant.status,
        Math.trunc(grant.createdAtMs),
        grant.revokedAtMs,
        grant.parentGrantId,
      );
  }

  private insertLinkCredential(credential: SyncRelayLinkCredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO sync_relay_link_credentials (
           credential_id, grant_id, secret_hash, generation, minted_at_ms, retired_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.credentialId,
        credential.grantId,
        credential.secretHash,
        credential.generation,
        Math.trunc(credential.mintedAtMs),
        credential.retiredAtMs,
      );
  }

  private retireCurrentLinkCredential(grantId: string, retiredAtMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE sync_relay_link_credentials
         SET retired_at_ms = ?
         WHERE grant_id = ? AND retired_at_ms IS NULL`,
      )
      .run(Math.trunc(retiredAtMs), grantId);
    return Number(result.changes ?? 0) > 0;
  }

  private pruneRetiredLinkCredentials(grantId: string): void {
    this.db
      .prepare(
        `DELETE FROM sync_relay_link_credentials
         WHERE credential_id IN (
           SELECT credential_id
           FROM sync_relay_link_credentials
           WHERE grant_id = ? AND retired_at_ms IS NOT NULL
           ORDER BY minted_at_ms DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(grantId, RETIRED_LINK_CREDENTIAL_HISTORY_LIMIT);
  }

  private activeDependentGrants(parentGrantId: string): SyncRelayShareGrantRow[] {
    return this.db
      .prepare(
        `SELECT grant_id, share_id, principal_kind, principal_user_id, principal_email,
                access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         FROM sync_relay_share_grants
         WHERE parent_grant_id = ? AND status = 'active'
         ORDER BY grant_id`,
      )
      .all(parentGrantId)
      .map(rowToShareGrantRow);
  }

  private incrementActiveDependentGenerations(parentGrantId: string): void {
    this.db
      .prepare(
        `UPDATE sync_relay_share_grants
         SET generation = generation + 1
         WHERE parent_grant_id = ? AND status = 'active'`,
      )
      .run(parentGrantId);
  }

  claimPendingSharesForEmail(email: string, userId: string): number {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return 0;
    const result = this.db
      .prepare(
        `UPDATE sync_relay_share_grants
         SET principal_kind = 'user', principal_user_id = ?, principal_email = NULL
         WHERE principal_kind = 'email' AND principal_email = ? AND status = 'active'`,
      )
      .run(userId, normalized);
    return Number(result.changes ?? 0);
  }

  getShare(shareId: string): SyncRelayShareRow | null {
    const row = this.db
      .prepare(
        `SELECT share_id, workspace_id, granter_user_id, selector_json, created_at_ms
         FROM sync_relay_shares WHERE share_id = ?`,
      )
      .get(shareId);
    return row ? rowToShareRow(row) : null;
  }

  getShareGrantForRecipient(
    shareId: string,
    recipientUserId: string,
  ): SyncRelayShareGrantRow | null {
    const row = this.db
      .prepare(
        `SELECT grant_id, share_id, principal_kind, principal_user_id, principal_email,
                access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         FROM sync_relay_share_grants
         WHERE share_id = ? AND principal_kind = 'user' AND principal_user_id = ?
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
                  created_at_ms DESC, grant_id
         LIMIT 1`,
      )
      .get(shareId, recipientUserId);
    return row ? rowToShareGrantRow(row) : null;
  }

  listSharesGrantedBy(granterUserId: string): SyncRelayShareWithGrantRow[] {
    return this.db
      .prepare(
        `SELECT s.share_id, s.workspace_id, s.granter_user_id, s.selector_json,
                s.created_at_ms, g.grant_id, g.share_id AS grant_share_id,
                g.principal_kind, g.principal_user_id, g.principal_email, g.access,
                g.generation, g.status, g.created_at_ms AS grant_created_at_ms,
                g.revoked_at_ms, g.parent_grant_id
         FROM sync_relay_shares s
         JOIN sync_relay_share_grants g ON g.share_id = s.share_id
         WHERE s.granter_user_id = ?
         ORDER BY s.created_at_ms DESC, s.share_id, g.created_at_ms, g.grant_id`,
      )
      .all(granterUserId)
      .map(rowToShareWithGrantRow);
  }

  listSharesReceivedBy(recipientUserId: string): SyncRelayShareWithGrantRow[] {
    return this.db
      .prepare(
        `SELECT s.share_id, s.workspace_id, s.granter_user_id, s.selector_json,
                s.created_at_ms, g.grant_id, g.share_id AS grant_share_id,
                g.principal_kind, g.principal_user_id, g.principal_email, g.access,
                g.generation, g.status, g.created_at_ms AS grant_created_at_ms,
                g.revoked_at_ms, g.parent_grant_id
         FROM sync_relay_shares s
         JOIN sync_relay_share_grants g ON g.share_id = s.share_id
         WHERE g.principal_kind = 'user' AND g.principal_user_id = ? AND g.status = 'active'
         ORDER BY s.created_at_ms DESC, s.share_id, g.created_at_ms, g.grant_id`,
      )
      .all(recipientUserId)
      .map(rowToShareWithGrantRow);
  }

  revokeShare(shareId: string, revokedAtMs: number): boolean {
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT 1 AS present FROM sync_relay_shares WHERE share_id = ?")
        .get(shareId);
      if (existing === undefined) return false;
      const revoked = this.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET status = 'revoked', generation = generation + 1, revoked_at_ms = ?
           WHERE share_id = ? AND status = 'active'`,
        )
        .run(Math.trunc(revokedAtMs), shareId);
      this.db
        .prepare(
          `UPDATE sync_relay_link_credentials
           SET retired_at_ms = ?
           WHERE retired_at_ms IS NULL
             AND grant_id IN (
               SELECT grant_id FROM sync_relay_share_grants WHERE share_id = ?
             )`,
        )
        .run(Math.trunc(revokedAtMs), shareId);
      if (Number(revoked.changes ?? 0) > 0) {
        // #646 PR3a: ending a share settles what it was still carrying. An
        // open proposal outlives the grant it came through — the recipient
        // can no longer withdraw it, and its content stays pinned out of the
        // blob sweep for as long as it stays open. Declining is the honest
        // state: the granter ended the share instead of answering, and the
        // recipient's own copy still has the changes.
        this.db
          .prepare(
            `UPDATE sync_relay_share_proposals
             SET state = 'declined', settled_at_ms = ?
             WHERE share_id = ? AND state = 'open'`,
          )
          .run(Math.trunc(revokedAtMs), shareId);
      }
      return true;
    });
  }

  listLogRowsReferencing(workspaceId: string, sha256: string): SyncRelayLogRow[] {
    return this.db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND payload_json LIKE ?
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${sha256}%`)
      .map(rowToLogRow);
  }

  findThreadCreateChannelWireId(
    workspaceId: string,
    threadId: string,
  ): string | null | undefined {
    if (!threadId) return undefined;
    for (const row of this.threadCreateRows(workspaceId, threadId)) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asObject(payload);
      if (!record || record.threadId !== threadId) continue;
      // The EARLIEST matching op is authoritative, whatever it says: a string
      // channelWireId with no linked-file owner is the binding; anything else
      // (a file-linked/both-owned thread or a pre-wire-id slug binding) is "no
      // shareable binding" — fail closed.
      return record.linkedObjectId === undefined &&
        typeof record.channelWireId === "string" &&
        record.channelWireId.length > 0
        ? record.channelWireId
        : null;
    }
    return undefined;
  }

  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined {
    if (!channelWireId) return undefined;
    // Canonical payload JSON sorts keys, so this exact fragment is a useful
    // pre-filter. Escaping LIKE metacharacters prevents a hostile wire id from
    // widening the scan; parsed exact equality below remains authoritative.
    const needle = `"wireId":${JSON.stringify(channelWireId)}`
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'chat.channel.create'
           AND payload_json LIKE ? ESCAPE '\\'
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${needle}%`);
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asObject(payload);
      if (!record || record.wireId !== channelWireId) continue;
      // The earliest exact create is authoritative even when malformed; do not
      // skip forward to a later op that could forge a shareable kind. Require
      // the engine's basic replay shape and reserved agent-wire/kind invariant
      // before trusting a human kind; malformed creates resolve permanently
      // unshareable.
      if (
        typeof record.channelId !== "string" ||
        record.channelId.length === 0 ||
        typeof record.name !== "string" ||
        record.name.length === 0 ||
        typeof record.slug !== "string" ||
        record.slug.length === 0 ||
        (record.kind !== "channel" && record.kind !== "dm" && record.kind !== "agent") ||
        typeof record.createdAtMs !== "number" ||
        !Number.isFinite(record.createdAtMs) ||
        ((record.kind === "agent") !== (record.wireId === AGENT_CHANNEL_WIRE_ID))
      ) {
        return null;
      }
      return record.kind;
    }
    return undefined;
  }

  findThreadCreateFileBinding(
    workspaceId: string,
    threadId: string,
  ): ThreadFileBinding | null | undefined {
    if (!threadId) return undefined;
    for (const row of this.threadCreateRows(workspaceId, threadId)) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asObject(payload);
      if (!record || record.threadId !== threadId) continue;
      // The EARLIEST matching op is authoritative, whatever it says. Exactly
      // one binding shape may be present: an op claiming both is malformed,
      // and reading either half of it would let a crafted create bind a
      // thread twice.
      const objectId = record.linkedObjectId;
      const path = record.linkedPath;
      const hasObject = typeof objectId === "string" && objectId.length > 0;
      const hasPath = typeof path === "string" && path.length > 0;
      if (hasObject && hasPath) return null;
      if (hasObject) return { kind: "object", objectId: objectId as string };
      if (hasPath) return { kind: "path", path: path as string };
      return null;
    }
    return undefined;
  }

  objectIdAtPath(workspaceId: string, path: string): string | undefined {
    if (!path) return undefined;
    const row = this.db
      .prepare(
        "SELECT object_id FROM sync_relay_object_paths \
         WHERE workspace_id = ? AND path = ? LIMIT 1",
      )
      .get(workspaceId, path);
    return typeof row?.object_id === "string" ? row.object_id : undefined;
  }

  objectCurrentPath(workspaceId: string, objectId: string): string | null | undefined {
    if (!objectId) return undefined;
    const row = this.db
      .prepare(
        "SELECT path FROM sync_relay_object_paths WHERE workspace_id = ? AND object_id = ?",
      )
      .get(workspaceId, objectId);
    if (row === undefined) return undefined;
    return typeof row.path === "string" && row.path.length > 0 ? row.path : null;
  }

  objectIdAtPathInVersion(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined {
    if (!input.path || !input.versionId) return undefined;
    // The object whose LATEST moment in this version sits at this path. A
    // moment that moved the object away leaves a newer row naming another
    // path, so that object no longer answers here — which is what makes this
    // "who is at this path now, in this version" rather than "who was ever".
    const row = this.db
      .prepare(
        `SELECT m.object_id
         FROM sync_relay_object_moments m
         WHERE m.workspace_id = ? AND m.version_id = ? AND m.path = ?
           AND m.relay_seq = (
             SELECT MAX(latest.relay_seq)
             FROM sync_relay_object_moments latest
             WHERE latest.workspace_id = m.workspace_id
               AND latest.object_id = m.object_id
               AND latest.version_id = m.version_id
           )
         ORDER BY m.relay_seq DESC
         LIMIT 1`,
      )
      .get(input.workspaceId, input.versionId, input.path);
    return typeof row?.object_id === "string" ? row.object_id : undefined;
  }

  objectMoment(input: {
    workspaceId: string;
    objectId: string;
    versionId: string;
    blobSha256?: string;
  }): ObjectMomentRow | null {
    if (!input.objectId || !input.versionId) return null;
    if (input.blobSha256 !== undefined && !input.blobSha256) return null;
    const params: unknown[] = [input.workspaceId, input.objectId, input.versionId];
    if (input.blobSha256 !== undefined) params.push(input.blobSha256);
    const row = this.db
      .prepare(
        `SELECT moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms
         FROM sync_relay_object_moments
         WHERE workspace_id = ? AND object_id = ? AND version_id = ?
           ${input.blobSha256 === undefined ? "" : "AND blob_sha256 = ?"}
         ORDER BY relay_seq DESC LIMIT 1`,
      )
      .get(...params);
    return row ? rowToObjectMomentRow(row) : null;
  }

  insertShareProposal(input: {
    proposalId: string;
    shareId: string;
    workspaceId: string;
    proposedByUserId: string;
    versionId: string;
    submitId: string;
    createdAtMs: number;
    ops: ShareProposalOpRow[];
    guard?: () => void;
  }): { proposalId: string; created: boolean } {
    return this.tx(() => {
      // The same posture appendLogBatch takes: the caller's authorization is
      // re-run under the write lock, so a revoke or a level narrowed
      // mid-flight loses the race rather than slipping a submit through.
      input.guard?.();
      const existing = this.db
        .prepare(
          "SELECT proposal_id FROM sync_relay_share_proposals WHERE share_id = ? AND submit_id = ?",
        )
        .get(input.shareId, input.submitId);
      if (existing) {
        return { proposalId: String(existing.proposal_id), created: false };
      }
      this.db
        .prepare(
          `INSERT INTO sync_relay_share_proposals (
            proposal_id, share_id, workspace_id, proposed_by_user_id, version_id,
            submit_id, state, created_at_ms, settled_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
        )
        .run(
          input.proposalId,
          input.shareId,
          input.workspaceId,
          input.proposedByUserId,
          input.versionId,
          input.submitId,
          Math.trunc(input.createdAtMs),
        );
      const insertOp = this.db.prepare(
        `INSERT INTO sync_relay_share_proposal_ops (
          proposal_id, op_index, based_on_path, based_on_object_id, based_on_blob_sha256,
          operation, after_path, after_blob_sha256, after_content_kind, after_byte_length,
          recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const op of input.ops) {
        insertOp.run(
          input.proposalId,
          op.opIndex,
          op.basedOnPath,
          op.basedOnObjectId,
          op.basedOnBlobSha256,
          op.operation,
          op.afterPath,
          op.afterBlobSha256,
          op.afterContentKind,
          op.afterByteLength,
          Math.trunc(op.recordedAtMs),
        );
      }
      return { proposalId: input.proposalId, created: true };
    });
  }

  getShareProposal(
    proposalId: string,
  ): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null {
    const row = this.db
      .prepare(
        `SELECT proposal_id, share_id, workspace_id, proposed_by_user_id, version_id,
                state, created_at_ms, settled_at_ms
         FROM sync_relay_share_proposals WHERE proposal_id = ?`,
      )
      .get(proposalId);
    if (!row) return null;
    return { ...rowToProposalRow(row), ops: this.proposalOps(proposalId) };
  }

  listShareProposalsForShare(shareId: string): Array<ShareProposalRow & { opCount: number }> {
    return this.db
      .prepare(
        `SELECT p.proposal_id, p.share_id, p.workspace_id, p.proposed_by_user_id, p.version_id,
                p.state, p.created_at_ms, p.settled_at_ms,
                (SELECT COUNT(*) FROM sync_relay_share_proposal_ops o
                  WHERE o.proposal_id = p.proposal_id) AS op_count
         FROM sync_relay_share_proposals p
         WHERE p.share_id = ?
         ORDER BY p.created_at_ms DESC, p.proposal_id`,
      )
      .all(shareId)
      .map((row) => ({ ...rowToProposalRow(row), opCount: Number(row.op_count ?? 0) }));
  }

  listShareProposalsForWorkspace(
    workspaceId: string,
  ): Array<ShareProposalRow & { opCount: number }> {
    return this.db
      .prepare(
        `SELECT p.proposal_id, p.share_id, p.workspace_id, p.proposed_by_user_id, p.version_id,
                p.state, p.created_at_ms, p.settled_at_ms,
                (SELECT COUNT(*) FROM sync_relay_share_proposal_ops o
                  WHERE o.proposal_id = p.proposal_id) AS op_count
         FROM sync_relay_share_proposals p
         WHERE p.workspace_id = ? AND p.state = 'open'
         ORDER BY p.created_at_ms, p.proposal_id`,
      )
      .all(workspaceId)
      .map((row) => ({ ...rowToProposalRow(row), opCount: Number(row.op_count ?? 0) }));
  }

  settleShareProposal(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean {
    return this.tx(() =>
      this.settleShareProposalInTransaction(proposalId, to, settledAtMs),
    );
  }

  // One write transaction, so a caller states what it writes rather than the
  // BEGIN/COMMIT/ROLLBACK frame around it.
  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  settleShareProposalInTransaction(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean {
    // `state = 'open'` in the WHERE is the whole concurrency answer: the row
    // moves exactly once, and every later mover sees zero changed rows.
    const result = this.db
      .prepare(
        `UPDATE sync_relay_share_proposals
         SET state = ?, settled_at_ms = ?
         WHERE proposal_id = ? AND state = 'open'`,
      )
      .run(to, Math.trunc(settledAtMs), proposalId);
    return Number(result.changes ?? 0) > 0;
  }

  maxOriginSeq(workspaceId: string, originId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(origin_seq), -1) AS max_seq
         FROM sync_relay_log WHERE workspace_id = ? AND origin_id = ?`,
      )
      .get(workspaceId, originId);
    return Number(row?.max_seq ?? -1);
  }

  private proposalOps(proposalId: string): ShareProposalOpRow[] {
    return this.db
      .prepare(
        `SELECT op_index, based_on_path, based_on_object_id, based_on_blob_sha256, operation,
                after_path, after_blob_sha256, after_content_kind, after_byte_length,
                recorded_at_ms
         FROM sync_relay_share_proposal_ops
         WHERE proposal_id = ?
         ORDER BY op_index`,
      )
      .all(proposalId)
      .map(rowToProposalOpRow);
  }

  // The workspace's chat.thread.create rows that MIGHT name this threadId, in
  // relay order. LIKE pre-filter on the exact JSON fragment the canonical
  // (sorted-key, JSON.stringify-escaped) payload stores, wildcards escaped so
  // a hostile threadId cannot widen the match; the caller's JSON.parse
  // comparison makes the real decision.
  private threadCreateRows(
    workspaceId: string,
    threadId: string,
  ): Array<Record<string, unknown>> {
    const needle = `"threadId":${JSON.stringify(threadId)}`
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    return this.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'chat.thread.create'
           AND payload_json LIKE ? ESCAPE '\\'
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${needle}%`);
  }

  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult {
    const rows = this.db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND relay_seq > ?
         ORDER BY relay_seq
         LIMIT ?`,
      )
      .all(input.workspaceId, input.sinceRelaySeq, input.limit + 1);
    const pageRows = rows.slice(0, input.limit).map(rowToLogRow);
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      nextCursor: last?.relaySeq ?? input.sinceRelaySeq,
      hasMore: rows.length > input.limit,
    };
  }

  fetchLogCoordinate(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): SyncRelayLogRow | null {
    const row = this.db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      )
      .get(input.workspaceId, input.originId, input.originSeq);
    return row ? rowToLogRow(row) : null;
  }
}

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function workspaceIdentityFromRow(
  row: Record<string, unknown>,
): WorkspaceSyncIdentity | null {
  const replicationEpoch = row.replication_epoch;
  const streamIdentity = row.stream_identity;
  if (replicationEpoch == null && streamIdentity == null) return null;
  if (typeof replicationEpoch !== "string" || typeof streamIdentity !== "string") {
    throw new Error("sync relay workspace identity is partially populated");
  }
  return { replicationEpoch, streamIdentity };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Every blob sha an op REQUIRES the relay to already hold before the op may be
// durably logged. This MUST mirror dohc-engine-sync collect_blob_refs exactly:
// the push client uploads precisely this set (text + binary) before
// POST /log, so validating the same set neither rejects an honest push nor
// lets a referencing op slip through unvalidated. Enumerated by op kind:
//   - moment.append:      payloadBefore/After/before blob shas (both content
//                         kinds ship as uploaded blobs).
//   - conflict.open:      base/current/incoming state shas, but ONLY for
//                         binary states -- text conflict states carry their
//                         bytes INLINE in the payload and are never uploaded,
//                         so requiring them would wrongly reject a valid op.
//   - version.create:     every forkSnapshot blob sha (both content kinds).
//   - secret.file.put:    the ciphertext blob sha.
//   - secret.version.fork: every row's ciphertext blob sha.
// conflict.resolve formatVersion 1 is the narrow exception to opaque payload
// handling: its compact state transition is parsed strictly so every required
// side and successor blob is pinned before the atomic append. A malformed
// compound payload throws a classified 400 instead of yielding no roots.
// All other kinds (workspace.init, secret.file.delete, chat.*, reserved
// version.rename/chat.thread.update, and any unknown/opaque kind) reference no
// uploaded blobs. Fully defensive: a malformed payload shape yields no refs
// for that branch rather than throwing (the store's apply-time validation is
// the fail-closed backstop for shape).
export function referencedBlobShas(
  opKind: string,
  payloadJson: string,
  context: ConflictResolveEnvelopeContext,
): string[] {
  if (opKind === "conflict.resolve") {
    return conflictResolveBlobShas(payloadJson, context);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  const record = asObject(parsed);
  if (!record) return [];
  const shas: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) shas.push(value);
  };
  if (opKind === "moment.append") {
    push(record.payloadBeforeBlobSha256);
    push(record.payloadAfterBlobSha256);
    push(record.beforeBlobSha256);
  } else if (opKind === "conflict.open") {
    for (const key of ["base", "current", "incoming"] as const) {
      const state = asObject(record[key]);
      if (state && state.exists === true && state.contentKind === "binary") {
        push(state.sha256);
      }
    }
  } else if (opKind === "version.create") {
    const snapshots = Array.isArray(record.forkSnapshots) ? record.forkSnapshots : [];
    for (const raw of snapshots) {
      const snapshot = asObject(raw);
      if (snapshot) push(snapshot.blobSha256);
    }
  } else if (opKind === "ydoc.update") {
    // A ydoc.update's Yjs bytes are content-addressed like any binary blob. The
    // relay stays content-agnostic (dumb log) but must count this reference so
    // (a) append-time validation requires the blob uploaded first, and (b) the
    // blob GC treats a blob a live ydoc.update op references as a ROOT — a live
    // rich-doc update blob is never collected out from under the log.
    push(record.updateBlobSha256);
  } else if (opKind === "secret.file.put") {
    push(record.ciphertextSha256);
  } else if (opKind === "secret.version.fork") {
    const rows = Array.isArray(record.rows) ? record.rows : [];
    for (const raw of rows) {
      const row = asObject(raw);
      if (row) push(row.ciphertextSha256);
    }
  }
  return shas;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function rowToObjectMomentRow(row: Record<string, unknown>): ObjectMomentRow {
  return {
    momentId: String(row.moment_id),
    versionId: String(row.version_id),
    path: nullableText(row.path),
    blobSha256: nullableText(row.blob_sha256),
    contentKind: nullableText(row.content_kind),
    byteLength: nullableInt(row.byte_length),
    recordedAtMs: Number(row.recorded_at_ms),
  };
}

function rowToProposalRow(row: Record<string, unknown>): ShareProposalRow {
  return {
    proposalId: String(row.proposal_id),
    shareId: String(row.share_id),
    workspaceId: String(row.workspace_id),
    proposedByUserId: String(row.proposed_by_user_id),
    versionId: String(row.version_id),
    state: String(row.state) as ShareProposalState,
    createdAtMs: Number(row.created_at_ms),
    settledAtMs: nullableInt(row.settled_at_ms),
  };
}

function rowToProposalOpRow(row: Record<string, unknown>): ShareProposalOpRow {
  return {
    opIndex: Number(row.op_index),
    basedOnPath: nullableText(row.based_on_path),
    basedOnObjectId: nullableText(row.based_on_object_id),
    basedOnBlobSha256: nullableText(row.based_on_blob_sha256),
    operation: String(row.operation) === "delete" ? "delete" : "write",
    afterPath: nullableText(row.after_path),
    afterBlobSha256: nullableText(row.after_blob_sha256),
    afterContentKind:
      row.after_content_kind === "binary"
        ? "binary"
        : row.after_content_kind === "text"
          ? "text"
          : null,
    afterByteLength: nullableInt(row.after_byte_length),
    recordedAtMs: Number(row.recorded_at_ms),
  };
}

function rowToShareRow(row: Record<string, unknown>): SyncRelayShareRow {
  return {
    shareId: String(row.share_id),
    workspaceId: String(row.workspace_id),
    granterUserId: String(row.granter_user_id),
    selectorJson: String(row.selector_json),
    createdAtMs: Number(row.created_at_ms),
  };
}

function rowToShareGrantRow(row: Record<string, unknown>): SyncRelayShareGrantRow {
  const principalKind = String(row.principal_kind);
  const status = String(row.status);
  if (principalKind !== "user" && principalKind !== "email" && principalKind !== "link") {
    throw new Error("stored share grant has an invalid principal kind");
  }
  if (status !== "active" && status !== "revoked") {
    throw new Error("stored share grant has an invalid status");
  }
  return {
    grantId: String(row.grant_id),
    shareId: String(row.share_id),
    principalKind,
    principalUserId: nullableText(row.principal_user_id),
    principalEmail: nullableText(row.principal_email),
    access: String(row.access),
    generation: Number(row.generation),
    status,
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: nullableInt(row.revoked_at_ms),
    parentGrantId: nullableText(row.parent_grant_id),
  };
}

function rowToLinkCredentialRow(
  row: Record<string, unknown>,
): SyncRelayLinkCredentialRow {
  return {
    credentialId: String(row.credential_id),
    grantId: String(row.grant_id),
    secretHash: String(row.secret_hash),
    generation: Number(row.generation),
    mintedAtMs: Number(row.minted_at_ms),
    retiredAtMs: nullableInt(row.retired_at_ms),
  };
}

function rowToLinkSessionRow(row: Record<string, unknown>): SyncRelayLinkSessionRow {
  return {
    sessionId: String(row.session_id),
    capabilityHash: String(row.capability_hash),
    grantId: String(row.grant_id),
    generation: Number(row.generation),
    mintedAtMs: Number(row.minted_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function rowToShareWithGrantRow(
  row: Record<string, unknown>,
): SyncRelayShareWithGrantRow {
  return {
    share: rowToShareRow(row),
    grant: rowToShareGrantRow({
      ...row,
      share_id: row.grant_share_id,
      created_at_ms: row.grant_created_at_ms,
    }),
  };
}

function rowToLogRow(row: Record<string, unknown>): SyncRelayLogRow {
  return {
    workspaceId: String(row.workspace_id),
    originId: String(row.origin_id),
    originSeq: Number(row.origin_seq),
    opKind: String(row.op_kind),
    payloadJson: String(row.payload_json),
    recordedAtMs: Number(row.recorded_at_ms),
    relaySeq: Number(row.relay_seq),
  };
}

export class SyncRelayConflictError extends Error {
  readonly statusCode = RELAY_ERRORS.conflict.status;
  readonly code = RELAY_ERRORS.conflict.code;
}

export class SyncRelayQuotaExceededError extends Error {
  readonly statusCode = RELAY_ERRORS.quota_exceeded.status;
  readonly code = RELAY_ERRORS.quota_exceeded.code;
}

// A log append referenced a blob the relay does not hold. 422 (not 409): the
// push client reserves 409 for same-origin log divergence (rewind/probe
// recovery), so a blob-missing rejection must use a DISTINCT retryable status
// the client surfaces as a generic failure and retries -- its next push
// re-uploads the missing blob (via /blobs/have) before re-posting the batch.
export class SyncRelayBlobMissingError extends Error {
  readonly statusCode = RELAY_ERRORS.blob_missing.status;
  readonly code = RELAY_ERRORS.blob_missing.code;
}
