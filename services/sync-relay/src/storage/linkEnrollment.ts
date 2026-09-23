import type { StorageContext } from "./context";
import type { SyncRelayLinkPrincipalRow } from "./types";
import { nullableText, rowToLinkPrincipalRow } from "./rows";
import { LINK_DISCUSSION_PRINCIPAL_FIXED_STORAGE_BYTES } from "./limits";
import { currentShareGrantSql } from "./currentShareGrant";

export interface LinkSessionCredentials {
  readonly capabilityHash: string;
  readonly profileTokenHash: string;
}

/** Call inside the caller's transaction; reading never enrolls a principal. */
export function readLinkEnrollment(storage: StorageContext, input: LinkSessionCredentials, now: number) {
  const authority = storage.db.prepare(`SELECT session.session_id, session.principal_id AS session_principal_id,
      session.grant_id, session.minted_at_ms, session.expires_at_ms,
      grant.share_id, grant.generation AS grant_generation, grant.access,
      share.workspace_id, share.link_writes_paused_at_ms, share.discussion_revision
    FROM sync_relay_link_sessions AS session
    JOIN sync_relay_share_grants AS grant ON grant.grant_id = session.grant_id
    JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
    WHERE session.capability_hash = ? AND grant.principal_kind = 'link' AND grant.generation = session.generation
      AND ${currentShareGrantSql("grant", "share")}
    LIMIT 1`).get(input.capabilityHash);
  if (!authority || Number(authority.minted_at_ms) > now || Number(authority.expires_at_ms) <= now) return null;
  const row = storage.db.prepare(`SELECT principal_id, grant_id, mint_generation, profile_token_hash,
      display_name, created_at_ms, blocked_at_ms, discussion_revision, storage_bytes
    FROM sync_relay_link_principals WHERE grant_id = ? AND profile_token_hash = ? LIMIT 1`)
    .get(authority.grant_id, input.profileTokenHash);
  const principal = row ? rowToLinkPrincipalRow(row) : null;
  const sessionPrincipalId = nullableText(authority.session_principal_id);
  if (sessionPrincipalId !== null && sessionPrincipalId !== principal?.principalId) return null;
  return { authority, principal, sessionPrincipalId };
}

export type LinkEnrollment = NonNullable<ReturnType<typeof readLinkEnrollment>>;

export function linkWriteRefusal(enrollment: LinkEnrollment): "blocked" | "paused" | null {
  if (enrollment.principal?.blockedAtMs != null) return "blocked";
  if (enrollment.authority.link_writes_paused_at_ms !== null) return "paused";
  return null;
}

export function linkPrincipalLimitReached(storage: StorageContext, enrollment: LinkEnrollment): boolean {
  if (enrollment.principal) return false;
  const count = storage.db.prepare(`SELECT COUNT(*) AS count FROM sync_relay_link_principals
    WHERE grant_id = ? AND mint_generation = ?`)
    .get(enrollment.authority.grant_id, enrollment.authority.grant_generation)?.count;
  return Number(count ?? 0) >= storage.options.linkDiscussionPrincipalLimit;
}

export function linkPrincipalStorageBytes(principalId: string, grantId: string, profileTokenHash: string): number {
  return Buffer.byteLength(principalId) + Buffer.byteLength(grantId) + Buffer.byteLength(profileTokenHash) +
    LINK_DISCUSSION_PRINCIPAL_FIXED_STORAGE_BYTES;
}

/** The caller checks its combined quota before the first write and rolls back later refusals. */
export function commitLinkEnrollment(storage: StorageContext, input: LinkSessionCredentials & {
  enrollment: LinkEnrollment;
  principalId: string;
  displayName: string | null;
  createdAtMs: number;
  discussionRevision: number;
}): SyncRelayLinkPrincipalRow {
  const { enrollment, principalId, displayName, createdAtMs, discussionRevision } = input;
  let principal = enrollment.principal;
  if (!principal) {
    storage.db.prepare(`INSERT INTO sync_relay_link_principals (
      principal_id, grant_id, mint_generation, profile_token_hash, display_name, created_at_ms,
      blocked_at_ms, discussion_revision, storage_bytes) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(principalId, enrollment.authority.grant_id, enrollment.authority.grant_generation,
        input.profileTokenHash, displayName, createdAtMs, discussionRevision,
        linkPrincipalStorageBytes(principalId, String(enrollment.authority.grant_id), input.profileTokenHash));
    principal = storage.getLinkPrincipal(principalId)!;
  } else if (principal.displayName === null && displayName !== null) {
    storage.db.prepare(`UPDATE sync_relay_link_principals SET display_name = ?, discussion_revision = ?
      WHERE principal_id = ? AND display_name IS NULL`).run(displayName, discussionRevision, principal.principalId);
    principal = storage.getLinkPrincipal(principal.principalId)!;
  }
  if (enrollment.sessionPrincipalId === null) {
    const bound = storage.db.prepare(`UPDATE sync_relay_link_sessions SET principal_id = ?
      WHERE session_id = ? AND capability_hash = ? AND principal_id IS NULL`)
      .run(principal.principalId, enrollment.authority.session_id, input.capabilityHash);
    if (Number(bound.changes ?? 0) !== 1) throw new Error("Link session binding changed inside transaction.");
  }
  return principal;
}
