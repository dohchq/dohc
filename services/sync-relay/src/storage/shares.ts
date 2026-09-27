import {
  type SyncRelayShareGrantRow,
  type SyncRelayShareRow,
  type SyncRelayLinkCredentialRow,
  type SyncRelayLinkCredentialGrantRow,
  type SyncRelayLinkCredentialMint,
  type LinkGrantTransitionResult,
  type ShareGrantTransitionResult,
  type SyncRelayLinkSessionRow,
  type SyncRelayShareWithGrantRow,
  type SyncRelayLinkInventoryCursor,
  type SyncRelayLinkInventoryPage,
  type SyncRelayLinkInventoryRow,
  type SyncRelayIndependentGrantInventoryCursor,
  type SyncRelayIndependentGrantInventoryPage,
} from "./types";
import { type StorageContext } from "./context";
import { nextShareDiscussionRevision } from "./discussion";
import { readCurrentShareGrant } from "./currentShareGrant";
import {
  rowToShareGrantRow,
  rowToLinkCredentialRow,
  rowToLinkSessionRow,
  rowToShareRow,
  rowToShareWithGrantRow,
} from "./rows";
import { shareAccessRank } from "@dohc/security-contract/share-selector";
import { LINK_SESSION_RENEWAL_GRACE_MS } from "../linkSecurity";
import { RETIRED_LINK_CREDENTIAL_HISTORY_LIMIT, LINK_INVENTORY_PAGE_SIZE, LINK_INVENTORY_INDEPENDENT_GRANT_LIMIT } from "./limits";

function dependentGrantIdsMatch(
  dependents: readonly SyncRelayShareGrantRow[],
  expectedGrantIds: readonly string[],
): boolean {
  if (!Array.isArray(expectedGrantIds) || expectedGrantIds.some((id) => typeof id !== "string")) {
    return false;
  }
  const expected = new Set(expectedGrantIds);
  return (
    expected.size === dependents.length &&
    dependents.every((dependent) => expected.has(dependent.grantId))
  );
}

export function createShare(storage: StorageContext, input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
  }): void {
    if (input.grant.shareId !== input.share.shareId) {
      throw new Error("share and grant ids do not match");
    }
    if (input.grant.principalKind === "link") {
      throw new Error("a link grant requires an existing share and a credential");
    }
    storage.tx(() => {
      insertShare(storage, input.share);
      insertShareGrant(storage, input.grant);
      // A named grant tells its person the share arrived. The waiting row
      // commits with the grant, so a crash cannot lose the notice, and an
      // email grant waits until an account claims it.
      storage.db.prepare(
        "INSERT INTO sync_relay_share_notice_deliveries (grant_id, created_at_ms) VALUES (?, ?)",
      ).run(input.grant.grantId, Math.trunc(input.grant.createdAtMs));
    });
  }

export function createFileLinkShare(storage: StorageContext, input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
    guard: () => void;
  }): boolean {
    const { share, grant, credential } = input;
    if (
      grant.shareId !== share.shareId ||
      grant.principalKind !== "link" ||
      grant.principalUserId !== null ||
      grant.principalEmail !== null ||
      grant.parentGrantId !== null ||
      (grant.access !== "view" && grant.access !== "comment" && grant.access !== "edit") ||
      grant.status !== "active" ||
      grant.revokedAtMs !== null ||
      grant.generation !== 1 ||
      grant.createdAtMs !== share.createdAtMs ||
      credential.grantId !== grant.grantId ||
      credential.generation !== grant.generation ||
      credential.mintedAtMs !== grant.createdAtMs ||
      credential.retiredAtMs !== null ||
      !credential.secretHash
    ) {
      return false;
    }
    return storage.tx(() => {
      input.guard();
      insertShare(storage, share);
      insertShareGrant(storage, grant);
      insertLinkCredential(storage, credential);
      return true;
    });
  }

export function createLinkGrant(storage: StorageContext, input: {
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
    return storage.tx(() => {
      const activeShare = storage.db
        .prepare(
          `SELECT 1 AS active
           FROM sync_relay_share_grants
           WHERE share_id = ? AND status = 'active'
           LIMIT 1`,
        )
        .get(grant.shareId);
      if (!storage.getShare(grant.shareId) || !activeShare) return false;
      insertShareGrant(storage, grant);
      insertLinkCredential(storage, credential);
      return true;
    });
  }

export function getShareGrant(storage: StorageContext, grantId: string): SyncRelayShareGrantRow | null {
    const row = storage.db
      .prepare(
        `SELECT grant_id, share_id, principal_kind, principal_user_id, principal_email,
                access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         FROM sync_relay_share_grants WHERE grant_id = ?`,
      )
      .get(grantId);
    return row ? rowToShareGrantRow(row) : null;
  }

export function getCurrentLinkCredential(storage: StorageContext, grantId: string): SyncRelayLinkCredentialRow | null {
    const row = storage.db
      .prepare(
        `SELECT credential_id, grant_id, secret_hash, generation, minted_at_ms, retired_at_ms
         FROM sync_relay_link_credentials
         WHERE grant_id = ? AND retired_at_ms IS NULL
         LIMIT 1`,
      )
      .get(grantId);
    return row ? rowToLinkCredentialRow(row) : null;
  }

export function findLinkGrantByCredentialHash(
    storage: StorageContext,
    secretHash: string,
  ): SyncRelayLinkCredentialGrantRow | null {
    const row = storage.db
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

export function rotateLinkGrant(storage: StorageContext, input: {
    shareId: string;
    grantId: string;
    rotatedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential: () => SyncRelayLinkCredentialMint;
  }): LinkGrantTransitionResult {
    return storage.tx(() => {
      input.guard();
      const grant = storage.getShareGrant(input.grantId);
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.principalKind !== "link" ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null
      ) {
        return { ok: false };
      }
      const dependents = activeDependentGrants(storage, grant.grantId);
      if (!dependentGrantIdsMatch(dependents, input.expectedDependentGrantIds)) {
        return { ok: false, reason: "dependents-changed", dependents };
      }
      const current = storage.getCurrentLinkCredential(input.grantId);
      if (!current || current.generation !== grant.generation) {
        return { ok: false };
      }
      const credential = input.mintCredential();
      if (!credential.credentialId || !credential.secretHash) return { ok: false };
      const generation = grant.generation + 1;
      storage.db
        .prepare("UPDATE sync_relay_share_grants SET generation = ? WHERE grant_id = ?")
        .run(generation, grant.grantId);
      retireCurrentLinkCredential(storage, grant.grantId, input.rotatedAtMs);
      insertLinkCredential(storage, {
        credentialId: credential.credentialId,
        grantId: grant.grantId,
        secretHash: credential.secretHash,
        generation,
        mintedAtMs: input.rotatedAtMs,
        retiredAtMs: null,
      });
      storage.db
        .prepare("DELETE FROM sync_relay_link_usage WHERE grant_id = ?")
        .run(grant.grantId);
      pruneRetiredLinkCredentials(storage, grant.grantId);
      incrementActiveDependentGenerations(storage, grant.grantId);
      return { ok: true, grant: storage.getShareGrant(grant.grantId)! };
    });
  }

export function retuneShareGrant(storage: StorageContext, input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential?: () => SyncRelayLinkCredentialMint;
  }): LinkGrantTransitionResult {
    return storage.tx(() => {
      input.guard();
      const grant = storage.getShareGrant(input.grantId);
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

      const dependents = activeDependentGrants(storage, grant.grantId);
      if (!dependentGrantIdsMatch(dependents, input.expectedDependentGrantIds)) {
        return { ok: false, reason: "dependents-changed", dependents };
      }

      const widening = to > from;
      const current = storage.getCurrentLinkCredential(grant.grantId);
      if (!current || current.generation !== grant.generation) {
        return { ok: false };
      }
      if (widening && !input.mintCredential) {
        return { ok: false };
      }
      if (!widening && input.mintCredential) {
        return { ok: false };
      }

      const wideningCredential = widening ? input.mintCredential!() : null;
      if (
        wideningCredential &&
        (!wideningCredential.credentialId || !wideningCredential.secretHash)
      ) {
        return { ok: false };
      }

      const generation = widening ? grant.generation + 1 : grant.generation;
      storage.db
        .prepare(
          "UPDATE sync_relay_share_grants SET access = ?, generation = ? WHERE grant_id = ?",
        )
        .run(input.access, generation, grant.grantId);

      if (wideningCredential) {
        retireCurrentLinkCredential(storage, grant.grantId, input.changedAtMs);
        insertLinkCredential(storage, {
          credentialId: wideningCredential.credentialId,
          grantId: grant.grantId,
          secretHash: wideningCredential.secretHash,
          generation,
          mintedAtMs: input.changedAtMs,
          retiredAtMs: null,
        });
        storage.db
          .prepare("DELETE FROM sync_relay_link_usage WHERE grant_id = ?")
          .run(grant.grantId);
        pruneRetiredLinkCredentials(storage, grant.grantId);
        incrementActiveDependentGenerations(storage, grant.grantId);
      } else {
        nextShareDiscussionRevision(storage, grant.shareId);
        for (const dependent of dependents) {
          const dependentRank = shareAccessRank(dependent.access);
          if (dependentRank > to) {
            storage.db
              .prepare(
                `UPDATE sync_relay_share_grants
                 SET access = ?
                 WHERE grant_id = ? AND status = 'active'`,
              )
              .run(input.access, dependent.grantId);
          }
        }
        incrementActiveDependentGenerations(storage, grant.grantId);
      }
      return { ok: true, grant: storage.getShareGrant(grant.grantId)! };
    });
  }

type RevokeShareGrantInput = {
    shareId: string;
    grantId: string;
    revokedAtMs: number;
    expectedDependentGrantIds?: readonly string[];
    guard?: () => void;
  };

export function revokeShareGrant(storage: StorageContext, input: RevokeShareGrantInput): LinkGrantTransitionResult {
    return storage.tx(() => revokeShareGrantInTransaction(storage, input));
  }

// The caller owns the synchronous relay transaction.
export function revokeShareGrantInTransaction(storage: StorageContext, input: RevokeShareGrantInput): LinkGrantTransitionResult {
      input.guard?.();
      const grant = storage.getShareGrant(input.grantId);
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null
      ) {
        return { ok: false };
      }
      if (grant.principalKind === "link" && input.expectedDependentGrantIds !== undefined) {
        const dependents = activeDependentGrants(storage, grant.grantId);
        if (!dependentGrantIdsMatch(dependents, input.expectedDependentGrantIds)) {
          return { ok: false, reason: "dependents-changed", dependents };
        }
      }
      const revokedAtMs = Math.trunc(input.revokedAtMs);
      storage.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET status = 'revoked', generation = generation + 1, revoked_at_ms = ?
           WHERE grant_id = ?`,
        )
        .run(revokedAtMs, grant.grantId);
      if (grant.principalKind === "link") {
        retireCurrentLinkCredential(storage, grant.grantId, revokedAtMs);
        storage.db
          .prepare(
            `UPDATE sync_relay_share_grants
             SET status = 'revoked', generation = generation + 1, revoked_at_ms = ?
             WHERE parent_grant_id = ? AND status = 'active'`,
          )
          .run(revokedAtMs, grant.grantId);
      }
      return { ok: true, grant: storage.getShareGrant(grant.grantId)! };
  }

export function promoteShareGrant(storage: StorageContext, input: {
    shareId: string;
    grantId: string;
    expectedParentGrantId: string;
    expectedParentGeneration: number;
    guard: () => void;
  }): ShareGrantTransitionResult {
    return storage.tx(() => {
      input.guard();
      const grant = storage.getShareGrant(input.grantId);
      const parent = grant?.parentGrantId
        ? storage.getShareGrant(grant.parentGrantId)
        : null;
      if (
        !grant ||
        grant.shareId !== input.shareId ||
        grant.principalKind !== "user" ||
        !grant.principalUserId ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null ||
        grant.parentGrantId !== input.expectedParentGrantId ||
        !parent ||
        parent.shareId !== grant.shareId ||
        parent.principalKind !== "link" ||
        parent.generation !== input.expectedParentGeneration ||
        parent.status !== "active" ||
        parent.revokedAtMs !== null
      ) {
        return { ok: false };
      }
      storage.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET parent_grant_id = NULL, generation = generation + 1
           WHERE grant_id = ?`,
        )
        .run(grant.grantId);
      return { ok: true, grant: storage.getShareGrant(grant.grantId)! };
    });
  }

export function mintLinkSession(storage: StorageContext, input: {
    session: Omit<SyncRelayLinkSessionRow, "principalId">;
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
    return storage.tx(() => {
      input.guard?.();
      const current = readCurrentShareGrant(storage, {
        grantId: session.grantId,
        principal: { kind: "link" },
        generation: session.generation,
      });
      if (!current) return false;
      storage.db
        .prepare("DELETE FROM sync_relay_link_sessions WHERE expires_at_ms < ?")
        .run(Math.trunc(session.mintedAtMs - LINK_SESSION_RENEWAL_GRACE_MS));
      const liveSessionCount = Number(
        storage.db
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_link_sessions WHERE grant_id = ?",
          )
          .get(session.grantId)?.count ?? 0,
      );
      const sessionsToDelete =
        liveSessionCount - storage.options.linkSessionsPerGrantLimit + 1;
      if (sessionsToDelete > 0) {
        storage.db
          .prepare(
            `DELETE FROM sync_relay_link_sessions
             WHERE session_id IN (
               SELECT session_id
               FROM sync_relay_link_sessions
               WHERE grant_id = ?
               ORDER BY minted_at_ms ASC, session_id ASC
               LIMIT ?
             )`,
          )
          .run(session.grantId, sessionsToDelete);
      }
      storage.db
        .prepare(
          `INSERT INTO sync_relay_link_sessions (
             session_id, capability_hash, grant_id, generation, minted_at_ms,
             expires_at_ms, principal_id
           ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          session.sessionId,
          session.capabilityHash,
          session.grantId,
          session.generation,
          Math.trunc(session.mintedAtMs),
          Math.trunc(session.expiresAtMs),
        );
      upsertLinkUsage(storage, session.grantId, session.mintedAtMs);
      return true;
    });
  }

export function replaceLinkSession(storage: StorageContext, input: {
    currentSession: SyncRelayLinkSessionRow;
    session: Omit<SyncRelayLinkSessionRow, "principalId">;
    guard: () => void;
  }): boolean {
    const { currentSession, session } = input;
    if (
      !currentSession.capabilityHash ||
      !session.capabilityHash ||
      currentSession.sessionId !== session.sessionId ||
      currentSession.capabilityHash === session.capabilityHash ||
      currentSession.grantId !== session.grantId ||
      currentSession.generation !== session.generation ||
      currentSession.expiresAtMs + LINK_SESSION_RENEWAL_GRACE_MS <
        session.mintedAtMs ||
      session.expiresAtMs <= session.mintedAtMs ||
      session.generation < 1
    ) {
      return false;
    }
    return storage.tx(() => {
      input.guard();
      const replaced = storage.db.prepare(`UPDATE sync_relay_link_sessions
        SET capability_hash=?, minted_at_ms=?, expires_at_ms=?
        WHERE session_id=? AND capability_hash=? AND grant_id=? AND generation=? AND expires_at_ms>=?`)
        .run(session.capabilityHash, Math.trunc(session.mintedAtMs), Math.trunc(session.expiresAtMs),
          currentSession.sessionId, currentSession.capabilityHash, currentSession.grantId, currentSession.generation,
          Math.trunc(session.mintedAtMs - LINK_SESSION_RENEWAL_GRACE_MS));
      if (Number(replaced.changes ?? 0) !== 1) return false;
      upsertLinkUsage(storage, session.grantId, session.mintedAtMs);
      return true;
    });
  }

export function findLinkSessionByCapabilityHash(
    storage: StorageContext,
    capabilityHash: string,
  ): SyncRelayLinkSessionRow | null {
    const row = storage.db
      .prepare(
        `SELECT session_id, capability_hash, grant_id, generation, minted_at_ms,
                expires_at_ms, principal_id
         FROM sync_relay_link_sessions WHERE capability_hash = ? LIMIT 1`,
      )
      .get(capabilityHash);
    return row ? rowToLinkSessionRow(row) : null;
  }

export function insertShareGrant(storage: StorageContext, grant: SyncRelayShareGrantRow): void {
    storage.db
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

export function insertShare(storage: StorageContext, share: SyncRelayShareRow): void {
    storage.db
      .prepare(
        `INSERT INTO sync_relay_shares (
           share_id, workspace_id, granter_user_id, selector_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        share.shareId,
        share.workspaceId,
        share.granterUserId,
        share.selectorJson,
        Math.trunc(share.createdAtMs),
      );
  }

export function insertLinkCredential(storage: StorageContext, credential: SyncRelayLinkCredentialRow): void {
    storage.db
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

export function upsertLinkUsage(storage: StorageContext, grantId: string, lastUsedAtMs: number): void {
    storage.db
      .prepare(
        `INSERT INTO sync_relay_link_usage (grant_id, last_used_at_ms)
         VALUES (?, ?)
         ON CONFLICT (grant_id) DO UPDATE SET
           last_used_at_ms = MAX(
             sync_relay_link_usage.last_used_at_ms,
             excluded.last_used_at_ms
           )`,
      )
      .run(grantId, Math.trunc(lastUsedAtMs));
  }

export function retireCurrentLinkCredential(storage: StorageContext, grantId: string, retiredAtMs: number): boolean {
    const result = storage.db
      .prepare(
        `UPDATE sync_relay_link_credentials
         SET retired_at_ms = ?
         WHERE grant_id = ? AND retired_at_ms IS NULL`,
      )
      .run(Math.trunc(retiredAtMs), grantId);
    return Number(result.changes ?? 0) > 0;
  }

export function pruneRetiredLinkCredentials(storage: StorageContext, grantId: string): void {
    storage.db
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

export function activeDependentGrants(storage: StorageContext, parentGrantId: string): SyncRelayShareGrantRow[] {
    return storage.db
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

export function incrementActiveDependentGenerations(storage: StorageContext, parentGrantId: string): void {
    storage.db
      .prepare(
        `UPDATE sync_relay_share_grants
         SET generation = generation + 1
         WHERE parent_grant_id = ? AND status = 'active'`,
      )
      .run(parentGrantId);
  }

export function claimPendingSharesForEmail(storage: StorageContext, email: string, userId: string): number {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return 0;
    return storage.tx(() => {
      const result = storage.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET principal_kind = 'user', principal_user_id = ?, principal_email = NULL
           WHERE principal_kind = 'email' AND principal_email = ? AND status = 'active'`,
        )
        .run(userId, normalized);
      return Number(result.changes ?? 0);
    });
  }

export function getShare(storage: StorageContext, shareId: string): SyncRelayShareRow | null {
    const row = storage.db
      .prepare(
        `SELECT share_id, workspace_id, granter_user_id, selector_json, created_at_ms
         FROM sync_relay_shares WHERE share_id = ?`,
      )
      .get(shareId);
    return row ? rowToShareRow(row) : null;
  }

export function listActiveShareGrantsForRecipient(
    storage: StorageContext,
    shareId: string,
    recipientUserId: string,
  ): SyncRelayShareGrantRow[] {
    return storage.db
      .prepare(
        `SELECT grant_id, share_id, principal_kind, principal_user_id, principal_email,
                access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         FROM sync_relay_share_grants
         WHERE share_id = ? AND principal_kind = 'user' AND principal_user_id = ?
           AND status = 'active'
         ORDER BY created_at_ms DESC, grant_id`,
      )
      .all(shareId, recipientUserId)
      .map(rowToShareGrantRow);
  }

export function listSharesGrantedBy(storage: StorageContext, granterUserId: string): SyncRelayShareWithGrantRow[] {
    return storage.db
      .prepare(
        `SELECT s.share_id, s.workspace_id, s.granter_user_id, s.selector_json,
                s.created_at_ms, g.grant_id, g.share_id AS grant_share_id,
                g.principal_kind, g.principal_user_id, g.principal_email, g.access,
                g.generation, g.status, g.created_at_ms AS grant_created_at_ms,
                g.revoked_at_ms, g.parent_grant_id
         FROM sync_relay_shares s
         JOIN sync_relay_share_grants g ON g.share_id = s.share_id
         WHERE s.granter_user_id = ? AND g.parent_grant_id IS NULL
         ORDER BY s.created_at_ms DESC, s.share_id, g.created_at_ms, g.grant_id`,
      )
      .all(granterUserId)
      .map(rowToShareWithGrantRow);
  }

export function listLinkGrantsByWorkspace(
    storage: StorageContext,
    workspaceId: string,
    cursor?: SyncRelayLinkInventoryCursor,
  ): SyncRelayLinkInventoryPage {
    const afterCursor = cursor
      ? `AND (s.created_at_ms, s.share_id, link.created_at_ms, link.grant_id)
             > (?, ?, ?, ?)`
      : "";
    const rows = storage.db
      .prepare(
        `WITH page_links AS (
           SELECT s.created_at_ms AS share_created_at_ms, s.share_id,
                  link.created_at_ms AS link_created_at_ms, link.grant_id
           FROM sync_relay_shares s
           JOIN sync_relay_share_grants link
             ON link.share_id = s.share_id AND link.principal_kind = 'link'
           WHERE s.workspace_id = ?
             ${afterCursor}
           ORDER BY s.created_at_ms, s.share_id, link.created_at_ms, link.grant_id
           LIMIT ${LINK_INVENTORY_PAGE_SIZE + 1}
         ), bounded_links AS (
           SELECT *
           FROM page_links
           ORDER BY share_created_at_ms, share_id, link_created_at_ms, grant_id
           LIMIT ${LINK_INVENTORY_PAGE_SIZE}
         )
         SELECT s.share_id, s.workspace_id, s.granter_user_id, s.selector_json,
                s.created_at_ms AS share_created_at_ms,
                link.grant_id AS link_grant_id, link.share_id AS link_share_id,
                link.principal_kind AS link_principal_kind,
                link.principal_user_id AS link_principal_user_id,
                link.principal_email AS link_principal_email,
                link.access AS link_access, link.generation AS link_generation,
                link.status AS link_status, link.created_at_ms AS link_created_at_ms,
                link.revoked_at_ms AS link_revoked_at_ms,
                link.parent_grant_id AS link_parent_grant_id,
                usage.last_used_at_ms AS last_used_at_ms,
                credential.minted_at_ms AS url_issued_at_ms,
                dependent.grant_id AS dependent_grant_id,
                dependent.share_id AS dependent_share_id,
                dependent.principal_kind AS dependent_principal_kind,
                dependent.principal_user_id AS dependent_principal_user_id,
                dependent.principal_email AS dependent_principal_email,
                dependent.access AS dependent_access,
                dependent.generation AS dependent_generation,
                dependent.status AS dependent_status,
                dependent.created_at_ms AS dependent_created_at_ms,
                dependent.revoked_at_ms AS dependent_revoked_at_ms,
                dependent.parent_grant_id AS dependent_parent_grant_id,
                (SELECT COUNT(*) FROM page_links) AS page_link_count
         FROM bounded_links page
         JOIN sync_relay_shares s ON s.share_id = page.share_id
         JOIN sync_relay_share_grants link ON link.grant_id = page.grant_id
         LEFT JOIN sync_relay_link_usage usage
           ON usage.grant_id = link.grant_id
         LEFT JOIN sync_relay_link_credentials credential
           ON credential.grant_id = link.grant_id
          AND credential.retired_at_ms IS NULL
          AND link.status = 'active'
         LEFT JOIN sync_relay_share_grants dependent
           ON dependent.parent_grant_id = link.grant_id
          AND dependent.status = 'active'
          AND link.status = 'active'
         ORDER BY s.created_at_ms, s.share_id, link.created_at_ms, link.grant_id,
                  dependent.grant_id`,
      )
      .all(
        workspaceId,
        ...(cursor
          ? [
              cursor.shareCreatedAtMs,
              cursor.shareId,
              cursor.linkCreatedAtMs,
              cursor.grantId,
            ]
          : []),
      );
    const links = new Map<string, SyncRelayLinkInventoryRow>();
    for (const row of rows) {
      const grantId = String(row.link_grant_id);
      let link = links.get(grantId);
      if (!link) {
        link = {
          share: rowToShareRow({
            ...row,
            created_at_ms: row.share_created_at_ms,
          }),
          grant: rowToShareGrantRow({
            grant_id: row.link_grant_id,
            share_id: row.link_share_id,
            principal_kind: row.link_principal_kind,
            principal_user_id: row.link_principal_user_id,
            principal_email: row.link_principal_email,
            access: row.link_access,
            generation: row.link_generation,
            status: row.link_status,
            created_at_ms: row.link_created_at_ms,
            revoked_at_ms: row.link_revoked_at_ms,
            parent_grant_id: row.link_parent_grant_id,
          }),
          dependents: [],
          lastUsedAtMs:
            row.last_used_at_ms === null || row.last_used_at_ms === undefined
              ? null
              : Number(row.last_used_at_ms),
          urlIssuedAtMs:
            row.url_issued_at_ms === null || row.url_issued_at_ms === undefined
              ? null
              : Number(row.url_issued_at_ms),
        };
        links.set(grantId, link);
      }
      if (row.dependent_grant_id !== null && row.dependent_grant_id !== undefined) {
        link.dependents.push(
          rowToShareGrantRow({
            grant_id: row.dependent_grant_id,
            share_id: row.dependent_share_id,
            principal_kind: row.dependent_principal_kind,
            principal_user_id: row.dependent_principal_user_id,
            principal_email: row.dependent_principal_email,
            access: row.dependent_access,
            generation: row.dependent_generation,
            status: row.dependent_status,
            created_at_ms: row.dependent_created_at_ms,
            revoked_at_ms: row.dependent_revoked_at_ms,
            parent_grant_id: row.dependent_parent_grant_id,
          }),
        );
      }
    }
    const pageLinks = [...links.values()];
    const last = pageLinks.at(-1);
    const hasMore = Number(rows[0]?.page_link_count ?? 0) > LINK_INVENTORY_PAGE_SIZE;
    return {
      links: pageLinks,
      nextCursor:
        hasMore && last
          ? {
              shareCreatedAtMs: last.share.createdAtMs,
              shareId: last.share.shareId,
              linkCreatedAtMs: last.grant.createdAtMs,
              grantId: last.grant.grantId,
            }
          : null,
    };
  }

export function listActiveIndependentShareGrants(storage: StorageContext, input: {
    workspaceId: string;
    shareIds: readonly string[];
    cursor?: SyncRelayIndependentGrantInventoryCursor;
  }): SyncRelayIndependentGrantInventoryPage {
    const shareIds = [...new Set(input.shareIds)];
    if (shareIds.length === 0) return { grants: [], nextCursor: null };
    if (shareIds.length > LINK_INVENTORY_PAGE_SIZE) {
      throw new Error("link inventory share page exceeds its limit");
    }
    const afterCursor = input.cursor
      ? "AND (grant.share_id, grant.created_at_ms, grant.grant_id) > (?, ?, ?)"
      : "";
    const rows = storage.db
      .prepare(
        `SELECT grant.grant_id, grant.share_id, grant.principal_kind,
                grant.principal_user_id, grant.principal_email, grant.access,
                grant.generation, grant.status, grant.created_at_ms,
                grant.revoked_at_ms, grant.parent_grant_id
         FROM sync_relay_share_grants grant
         JOIN sync_relay_shares share ON share.share_id = grant.share_id
         WHERE share.workspace_id = ?
           AND grant.share_id IN (${shareIds.map(() => "?").join(", ")})
           AND grant.status = 'active'
           AND grant.parent_grant_id IS NULL
           AND grant.principal_kind != 'link'
           ${afterCursor}
         ORDER BY grant.share_id, grant.created_at_ms, grant.grant_id
         LIMIT ${LINK_INVENTORY_INDEPENDENT_GRANT_LIMIT + 1}`,
      )
      .all(
        input.workspaceId,
        ...shareIds,
        ...(input.cursor
          ? [
              input.cursor.shareId,
              input.cursor.grantCreatedAtMs,
              input.cursor.grantId,
            ]
          : []),
      )
      .map(rowToShareGrantRow);
    const grants = rows.slice(0, LINK_INVENTORY_INDEPENDENT_GRANT_LIMIT);
    const last = grants.at(-1);
    return {
      grants,
      nextCursor:
        rows.length > LINK_INVENTORY_INDEPENDENT_GRANT_LIMIT && last
          ? {
              shareId: last.shareId,
              grantCreatedAtMs: last.createdAtMs,
              grantId: last.grantId,
            }
          : null,
    };
  }

export function listSharesReceivedBy(storage: StorageContext, recipientUserId: string): SyncRelayShareWithGrantRow[] {
    return storage.db
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

export function revokeShare(storage: StorageContext, shareId: string, revokedAtMs: number): boolean {
  return storage.tx(() => revokeShareInTransaction(storage, shareId, revokedAtMs));
}

export function revokeShareInTransaction(storage: StorageContext, shareId: string, revokedAtMs: number): boolean {
      const existing = storage.db
        .prepare("SELECT 1 AS present FROM sync_relay_shares WHERE share_id = ?")
        .get(shareId);
      if (existing === undefined) return false;
      storage.db.prepare("UPDATE sync_relay_share_removals SET voided = 1 WHERE share_id = ?").run(shareId);
      const revoked = storage.db
        .prepare(
          `UPDATE sync_relay_share_grants
           SET status = 'revoked', generation = generation + 1, revoked_at_ms = ?
           WHERE share_id = ? AND status = 'active'`,
        )
        .run(Math.trunc(revokedAtMs), shareId);
      storage.db
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
        // Ending a share settles what it was still carrying. An
        // open proposal outlives the grant it came through — the recipient
        // can no longer withdraw it, and its content stays pinned out of the
        // blob sweep for as long as it stays open. Declining is the honest
        // state: the granter ended the share instead of answering, and the
        // recipient's own copy still has the changes.
        storage.db
          .prepare(
            `UPDATE sync_relay_share_proposals
             SET state = 'declined', settled_at_ms = ?
             WHERE share_id = ? AND state = 'open'`,
          )
          .run(Math.trunc(revokedAtMs), shareId);
      }
      return true;
  }
