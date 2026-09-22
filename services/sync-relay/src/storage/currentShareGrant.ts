import { SHARE_ACCESS_VALUES, shareAccessRank } from "@dohc/security-contract/share-selector";
import type { SyncRelayShareGrantRow, SyncRelayShareWithGrantRow, SyncRelayStorage } from "./types";

export type CurrentShareGrantStorage = Pick<SyncRelayStorage, "getShare" | "getShareGrant" | "workspaceIsOwnedBy">;

/** Who must hold the grant. An owner acting on its own share names none. */
export type CurrentShareGrantPrincipal = { kind: "link" } | { kind: "user"; userId: string };

export interface CurrentShareGrantQuery {
  grantId: string;
  principal?: CurrentShareGrantPrincipal;
  /** The generation a session, code, or publication was bound to. */
  generation?: number;
}

/**
 * ADR 0005's answer to "is this grant current": the grant is active at a valid
 * generation, the granter still owns the share's workspace, and a dependent
 * grant's parent is an active link on the same share with at least its access.
 * Call inside the transaction that acts on the answer.
 */
export function readCurrentShareGrant(
  storage: CurrentShareGrantStorage,
  query: CurrentShareGrantQuery,
): SyncRelayShareWithGrantRow | null {
  const grant = storage.getShareGrant(query.grantId);
  if (
    !grant ||
    !isActive(grant) ||
    !Number.isSafeInteger(grant.generation) ||
    grant.generation < 1 ||
    !validStoredPrincipal(grant) ||
    (query.principal && !heldBy(grant, query.principal)) ||
    (query.generation !== undefined && grant.generation !== query.generation)
  ) {
    return null;
  }
  const share = storage.getShare(grant.shareId);
  if (!share || !storage.workspaceIsOwnedBy(share.workspaceId, share.granterUserId)) {
    return null;
  }
  if (grant.parentGrantId !== null) {
    const parent = storage.getShareGrant(grant.parentGrantId);
    if (
      grant.principalKind !== "user" ||
      !parent ||
      parent.shareId !== share.shareId ||
      parent.principalKind !== "link" ||
      !isActive(parent) ||
      !accessAtMost(grant.access, parent.access)
    ) {
      return null;
    }
  }
  return { share, grant };
}

/**
 * The same rule as a SQL condition on a `sync_relay_share_grants` alias and its
 * `sync_relay_shares` alias, for a lookup that must stay one statement. The
 * caller adds its own principal and generation terms.
 */
export function currentShareGrantSql(grant: string, share: string): string {
  return `(${grant}.status = 'active' AND ${grant}.revoked_at_ms IS NULL
    AND ${grant}.generation BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
    AND CASE ${grant}.principal_kind
      WHEN 'user' THEN ${grant}.principal_user_id IS NOT NULL AND ${grant}.principal_email IS NULL
      WHEN 'email' THEN ${grant}.principal_user_id IS NULL AND ${grant}.principal_email IS NOT NULL
      WHEN 'link' THEN ${grant}.principal_user_id IS NULL AND ${grant}.principal_email IS NULL
      ELSE 0 END
    AND ${share}.share_id = ${grant}.share_id
    AND EXISTS (SELECT 1 FROM sync_relay_workspaces AS granter_workspace
      WHERE granter_workspace.workspace_id = ${share}.workspace_id
        AND granter_workspace.owner_user_id = ${share}.granter_user_id)
    AND (${grant}.parent_grant_id IS NULL OR (${grant}.principal_kind = 'user' AND EXISTS (
      SELECT 1 FROM sync_relay_share_grants AS parent_grant
      WHERE parent_grant.grant_id = ${grant}.parent_grant_id
        AND parent_grant.share_id = ${share}.share_id
        AND parent_grant.principal_kind = 'link'
        AND parent_grant.status = 'active' AND parent_grant.revoked_at_ms IS NULL
        AND ${accessRankSql(`${grant}.access`)} <= ${accessRankSql("parent_grant.access")}))))`;
}

function isActive(grant: SyncRelayShareGrantRow): boolean {
  return grant.status === "active" && grant.revokedAtMs === null;
}

function heldBy(grant: SyncRelayShareGrantRow, principal: CurrentShareGrantPrincipal): boolean {
  return principal.kind === "user"
    ? grant.principalKind === "user" && grant.principalUserId === principal.userId
    : grant.principalKind === "link";
}

function validStoredPrincipal(grant: SyncRelayShareGrantRow): boolean {
  switch (grant.principalKind) {
    case "user":
      return grant.principalUserId !== null && grant.principalEmail === null;
    case "email":
      return grant.principalUserId === null && grant.principalEmail !== null;
    case "link":
      return grant.principalUserId === null && grant.principalEmail === null;
  }
}

function accessAtMost(access: string, ceiling: string): boolean {
  const accessIndex = shareAccessRank(access);
  const ceilingIndex = shareAccessRank(ceiling);
  return accessIndex >= 0 && ceilingIndex >= 0 && accessIndex <= ceilingIndex;
}

// An unknown level ranks NULL, so the comparison fails as accessAtMost does.
function accessRankSql(column: string): string {
  return `CASE ${column} ${SHARE_ACCESS_VALUES.map((access, rank) => `WHEN '${access}' THEN ${rank}`).join(" ")} END`;
}
