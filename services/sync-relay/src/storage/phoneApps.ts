import type { StorageContext } from "./context";
import type { SqliteDb, SyncRelayStorage } from "./types";

const MARKER = "phone-app-launches-v1";
export const PHONE_APP_APPROVALS = "sync_relay_phone_app_approvals";
export const PHONE_APP_LAUNCHES = "sync_relay_phone_app_launches";

// An approval is the owner's yes, from a phone, to one publication at one
// authority revision. A launch row starts as a one-use grant with no host, and
// share-web's redemption swaps the grant's hash for the launch ID's and
// records the launch host. Deleting an approval ends its launches.
const SCHEMA = [
  `CREATE TABLE ${PHONE_APP_APPROVALS} (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK (length(approval_id) = 32),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 1024),
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL CHECK (length(publication_id) = 64),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  approved_at_ms INTEGER NOT NULL,
  UNIQUE (user_id, workspace_id, publication_id)
) STRICT`,
  `CREATE TABLE ${PHONE_APP_LAUNCHES} (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64),
  launch_host TEXT UNIQUE CHECK (launch_host IS NULL OR length(launch_host) BETWEEN 1 AND 253),
  approval_id TEXT NOT NULL REFERENCES ${PHONE_APP_APPROVALS}(approval_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 1024),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 1024),
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL CHECK (length(publication_id) = 64),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  expires_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE INDEX idx_${PHONE_APP_LAUNCHES}_approval ON ${PHONE_APP_LAUNCHES}(approval_id)`,
];

export function initializePhoneAppSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) return;
  for (const sql of SCHEMA) db.exec(sql);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

/** What a grant and the launch it becomes are bound to. */
export interface PhoneAppBinding {
  userId: string;
  sessionId: string;
  workspaceId: string;
  publicationId: string;
  authorityRevision: number;
  approvalId: string;
}

/** Launches to end: every field given must match. */
export interface PhoneAppLaunchScope {
  userId: string;
  sessionId?: string;
  workspaceId?: string;
  publicationId?: string;
}

const db = (storage: SyncRelayStorage) => (storage as StorageContext).db;
const context = (storage: SyncRelayStorage) => storage as StorageContext;

function binding(row: Record<string, unknown>): PhoneAppBinding {
  return {
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    workspaceId: String(row.workspace_id),
    publicationId: String(row.publication_id),
    authorityRevision: Number(row.authority_revision),
    approvalId: String(row.approval_id),
  };
}

/** The account's approval of a publication, at whichever revision it was given. */
export function phoneAppApproval(
  storage: SyncRelayStorage,
  input: { userId: string; workspaceId: string; publicationId: string },
): { approvalId: string; authorityRevision: number; approvedAtMs: number } | null {
  const row = db(storage)
    .prepare(
      `SELECT approval_id, authority_revision, approved_at_ms FROM ${PHONE_APP_APPROVALS}
       WHERE user_id = ? AND workspace_id = ? AND publication_id = ?`,
    )
    .get(input.userId, input.workspaceId, input.publicationId);
  return row
    ? {
        approvalId: String(row.approval_id),
        authorityRevision: Number(row.authority_revision),
        approvedAtMs: Number(row.approved_at_ms),
      }
    : null;
}

/**
 * Approves a publication at one revision, inside the caller's transaction. A
 * retry at the same revision returns the same approval; approving a new
 * revision, or a publication made again since, replaces the old one and ends
 * its launches.
 */
export function approvePhoneApp(
  storage: SyncRelayStorage,
  input: {
    userId: string;
    workspaceId: string;
    publicationId: string;
    authorityRevision: number;
    createdAtMs: number;
    newApprovalId: string;
    nowMs: number;
  },
): { approvalId: string; authorityRevision: number; approvedAtMs: number } {
  const current = phoneAppApproval(storage, input);
  if (
    current?.authorityRevision === input.authorityRevision &&
    current.approvedAtMs >= input.createdAtMs
  )
    return current;
  db(storage)
    .prepare(
      `DELETE FROM ${PHONE_APP_APPROVALS} WHERE user_id = ? AND workspace_id = ? AND publication_id = ?`,
    )
    .run(input.userId, input.workspaceId, input.publicationId);
  db(storage)
    .prepare(`INSERT INTO ${PHONE_APP_APPROVALS} VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      input.newApprovalId,
      input.userId,
      input.workspaceId,
      input.publicationId,
      input.authorityRevision,
      input.nowMs,
    );
  return {
    approvalId: input.newApprovalId,
    authorityRevision: input.authorityRevision,
    approvedAtMs: input.nowMs,
  };
}

/**
 * Deletes the account's approval of a publication, with every grant and launch, and the account's allowing of it
 * as a Member app, which holds on every device.
 */
export function revokePhoneApp(
  storage: SyncRelayStorage,
  input: { userId: string; workspaceId: string; publicationId: string },
): { revoked: boolean; launchHashes: string[] } {
  return context(storage).tx(() => {
    const ended = launchHashes(
      db(storage)
        .prepare(
          `DELETE FROM ${PHONE_APP_LAUNCHES} WHERE user_id = ? AND workspace_id = ? AND publication_id = ?
           RETURNING token_hash, launch_host`,
        )
        .all(input.userId, input.workspaceId, input.publicationId),
    );
    const revoked = [
      `DELETE FROM ${PHONE_APP_APPROVALS} WHERE user_id = ? AND workspace_id = ? AND publication_id = ?`,
      `DELETE FROM sync_relay_app_viewer_consents WHERE viewer_user_id = ? AND workspace_id = ? AND publication_id = ?`,
    ].map(
      (sql) =>
        db(storage).prepare(sql).run(input.userId, input.workspaceId, input.publicationId).changes >
        0,
    );
    return { revoked: revoked.some(Boolean), launchHashes: ended };
  });
}

/** Stores a grant's hash, after clearing every grant and launch that has expired. */
export function issuePhoneAppGrant(
  storage: SyncRelayStorage,
  input: PhoneAppBinding & { grantHash: string; expiresAtMs: number; nowMs: number },
): void {
  context(storage).tx(() => {
    db(storage)
      .prepare(`DELETE FROM ${PHONE_APP_LAUNCHES} WHERE expires_at_ms <= ?`)
      .run(input.nowMs);
    db(storage)
      .prepare(`INSERT INTO ${PHONE_APP_LAUNCHES} VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.grantHash,
        input.approvalId,
        input.userId,
        input.sessionId,
        input.workspaceId,
        input.publicationId,
        input.authorityRevision,
        input.expiresAtMs,
      );
  });
}

/**
 * Consumes a grant: one statement turns it into a launch for `launchHost`, so
 * of two redemptions one wins. A grant that has expired, or that names another
 * workspace or publication, is consumed and refused.
 */
export function redeemPhoneAppGrant(
  storage: SyncRelayStorage,
  input: {
    grantHash: string;
    launchHash: string;
    launchHost: string;
    workspaceId: string;
    publicationId: string;
    nowMs: number;
    expiresAtMs: number;
  },
): PhoneAppBinding | null {
  return context(storage).tx(() => {
    const row = db(storage)
      .prepare(
        `UPDATE ${PHONE_APP_LAUNCHES} SET token_hash = ?, launch_host = ?
         WHERE token_hash = ? AND launch_host IS NULL RETURNING *`,
      )
      .get(input.launchHash, input.launchHost, input.grantHash);
    if (!row) return null;
    if (
      Number(row.expires_at_ms) <= input.nowMs ||
      row.workspace_id !== input.workspaceId ||
      row.publication_id !== input.publicationId
    ) {
      db(storage)
        .prepare(`DELETE FROM ${PHONE_APP_LAUNCHES} WHERE token_hash = ?`)
        .run(input.launchHash);
      return null;
    }
    db(storage)
      .prepare(`UPDATE ${PHONE_APP_LAUNCHES} SET expires_at_ms = ? WHERE token_hash = ?`)
      .run(input.expiresAtMs, input.launchHash);
    return binding(row);
  });
}

/**
 * An unexpired launch whose approval still stands at the launch's revision,
 * for the account's publication or a Member app in its workspace, while it is
 * active at that revision and was made before the approval. One statement and
 * no transaction of its own, so it runs inside a commit.
 */
export function phoneAppLaunch(
  storage: SyncRelayStorage,
  launchHash: string,
  nowMs: number,
): PhoneAppBinding | null {
  const row = db(storage)
    .prepare(
      `SELECT l.* FROM ${PHONE_APP_LAUNCHES} l JOIN ${PHONE_APP_APPROVALS} a USING (approval_id)
       JOIN sync_relay_app_publications p ON p.publication_id = l.publication_id
       WHERE l.token_hash = ? AND l.launch_host IS NOT NULL AND l.expires_at_ms > ?
         AND a.authority_revision = l.authority_revision AND a.approved_at_ms >= p.created_at_ms
         AND p.workspace_id = l.workspace_id
         AND p.active = 1 AND p.authority_revision = l.authority_revision
         AND (p.owner_user_id = l.user_id OR EXISTS (SELECT 1 FROM sync_relay_member_apps m
           WHERE m.publication_id = p.publication_id AND m.workspace_id = l.workspace_id))`,
    )
    .get(launchHash, nowMs);
  return row ? binding(row) : null;
}

// The hashes of the redeemed launch IDs a deletion removed. An unredeemed grant has no app session to end.
function launchHashes(rows: Record<string, unknown>[]): string[] {
  return rows.flatMap((row) => (row.launch_host === null ? [] : [String(row.token_hash)]));
}

/** Deletes the grants and launches in `scope`, and answers the launch IDs' hashes it ended. */
export function endPhoneAppLaunches(
  storage: SyncRelayStorage,
  scope: PhoneAppLaunchScope,
): string[] {
  return context(storage).tx(() => deletePhoneAppLaunches(storage, scope));
}

export function deletePhoneAppLaunches(
  storage: SyncRelayStorage,
  scope: PhoneAppLaunchScope,
): string[] {
  return launchHashes(
    db(storage)
      .prepare(
        `DELETE FROM ${PHONE_APP_LAUNCHES} WHERE user_id = ?1
       AND (?2 IS NULL OR session_id = ?2) AND (?3 IS NULL OR workspace_id = ?3) AND (?4 IS NULL OR publication_id = ?4)
       RETURNING token_hash, launch_host`,
      )
      .all(
        scope.userId,
        scope.sessionId ?? null,
        scope.workspaceId ?? null,
        scope.publicationId ?? null,
      ),
  );
}
