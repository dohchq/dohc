import { ACTIVE_LINK_DEPENDENT_GRANT_LIMIT } from "./limits";
import { shareAccessRank } from "@dohc/security-contract/share-selector";
import { randomUUID } from "node:crypto";
import { notFound, relayError } from "../errors";
import type { StorageContext } from "./context";
import type { LinkGrantTransitionResult, SyncRelayShareGrantRow } from "./types";
import { revokeShareInTransaction, revokeShareGrantInTransaction } from "./shares";

export const SHARE_REMOVAL_UNDO_MS = 10 * 60 * 1000;

export function purgeExpiredShareRemovals(storage: StorageContext, nowMs: number): void {
  storage.tx(() => storage.db.prepare("DELETE FROM sync_relay_share_removals WHERE expires_at_ms <= ?").run(nowMs));
}

export interface ShareRemovalInput {
  shareId: string;
  actorUserId: string;
  nowMs: number;
  guard?: () => void;
  grantId?: string;
  expectedDependentGrantIds?: readonly string[];
}

function requireOwner(storage: StorageContext, shareId: string, userId: string) {
  const share = storage.getShare(shareId);
  if (!share || share.granterUserId !== userId || !storage.workspaceIsOwnedBy(share.workspaceId, userId)) throw notFound();
}

function hasLaterCoveringRemoval(storage: StorageContext, shareId: string, rowid: number, grantsJson: string): boolean {
  return Boolean(storage.db.prepare(`SELECT 1 FROM sync_relay_share_removals later
    WHERE later.share_id = ? AND later.rowid > ? AND (
      later.removed_grant_id IS NULL OR EXISTS (
        SELECT 1 FROM json_each(?) receipt_grant
        JOIN sync_relay_share_grants g ON g.grant_id = json_extract(receipt_grant.value, '$.grantId')
        WHERE g.grant_id = later.removed_grant_id OR g.parent_grant_id = later.removed_grant_id
      )
    )`).get(shareId, rowid, grantsJson));
}

export function removeShareAccess(storage: StorageContext, input: ShareRemovalInput):
  | Exclude<LinkGrantTransitionResult, { ok: true }>
  | { ok: true; grant: SyncRelayShareGrantRow | null; undo?: { undoId: string; expiresAtMs: number } } {
  purgeExpiredShareRemovals(storage, input.nowMs);
  return storage.tx(() => {
    input.guard?.();
    requireOwner(storage, input.shareId, input.actorUserId);
    const before = storage.db.prepare(`SELECT grant_id, generation FROM sync_relay_share_grants
      WHERE share_id = ? AND status = 'active'`).all(input.shareId) as { grant_id: string; generation: number }[];
    const credentials = storage.db.prepare(`SELECT credential_id, grant_id FROM sync_relay_link_credentials
      WHERE retired_at_ms IS NULL AND grant_id IN (SELECT grant_id FROM sync_relay_share_grants WHERE share_id = ?)`)
      .all(input.shareId) as { credential_id: string; grant_id: string }[];
    if (!before.some(row => input.grantId === undefined || row.grant_id === input.grantId)) {
      if (input.grantId === undefined) {
        revokeShareInTransaction(storage, input.shareId, input.nowMs);
      }
      const candidates = storage.db.prepare(`SELECT rowid, undo_id, expires_at_ms, grants_json FROM sync_relay_share_removals
        WHERE share_id = ? AND owner_user_id = ? AND removed_grant_id IS ? AND undone = 0 AND voided = 0 AND expires_at_ms > ?
        ORDER BY rowid DESC`).all(input.shareId, input.actorUserId, input.grantId ?? null, input.nowMs) as
        {rowid: number; undo_id: string; expires_at_ms: number; grants_json: string}[];
      const prior = candidates.find(candidate => {
        if (hasLaterCoveringRemoval(storage, input.shareId, candidate.rowid, candidate.grants_json)) return false;
        const expected = JSON.parse(candidate.grants_json) as {grantId: string; generation: number}[];
        return expected.every(row => {
          const grant = storage.getShareGrant(row.grantId);
          return grant?.status === "revoked" && grant.generation === row.generation;
        });
      });
      if (!prior) {
        if (input.grantId === undefined) return {ok: true, grant: null};
        throw notFound();
      }
      return {ok: true, grant: input.grantId ? storage.getShareGrant(input.grantId) : null,
        undo: {undoId: prior.undo_id, expiresAtMs: prior.expires_at_ms}};
    }
    const proposals = input.grantId === undefined
      ? storage.db.prepare("SELECT proposal_id FROM sync_relay_share_proposals WHERE share_id = ? AND state = 'open'")
          .all(input.shareId).map(row => String(row.proposal_id))
      : [];
    const result = input.grantId
      ? revokeShareGrantInTransaction(storage, { shareId: input.shareId, grantId: input.grantId,
          revokedAtMs: input.nowMs, expectedDependentGrantIds: input.expectedDependentGrantIds })
      : revokeShareInTransaction(storage, input.shareId, input.nowMs) ? { ok: true as const } : { ok: false as const };
    if (!result.ok) return result;
    const grants = before.flatMap(row => {
      const current = storage.getShareGrant(row.grant_id);
      return current?.status === "revoked" && current.generation === row.generation + 1
        ? [{ grantId: current.grantId, generation: current.generation }] : [];
    });
    if (!grants.length) throw notFound();
    const undo = { undoId: randomUUID(), expiresAtMs: input.nowMs + SHARE_REMOVAL_UNDO_MS };
    storage.db.prepare(`INSERT INTO sync_relay_share_removals
      (undo_id, share_id, owner_user_id, expires_at_ms, grants_json, credentials_json, removed_grant_id, proposals_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(undo.undoId, input.shareId, input.actorUserId, undo.expiresAtMs, JSON.stringify(grants),
        JSON.stringify(credentials.filter(row => grants.some(grant => grant.grantId === row.grant_id))), input.grantId ?? null,
        JSON.stringify(proposals));
    return { ok: true, grant: "grant" in result ? result.grant : null, undo };
  });
}

export function undoShareRemoval(storage: StorageContext, input: {
  shareId: string; actorUserId: string; undoId: string; nowMs: number;
}): void {
  purgeExpiredShareRemovals(storage, input.nowMs);
  storage.tx(() => {
    requireOwner(storage, input.shareId, input.actorUserId);
    const receipt = storage.db.prepare(`SELECT rowid, expires_at_ms, grants_json, credentials_json, proposals_json, undone, voided
      FROM sync_relay_share_removals WHERE undo_id = ? AND share_id = ? AND owner_user_id = ?`)
      .get(input.undoId, input.shareId, input.actorUserId) as
      { rowid: number; expires_at_ms: number; grants_json: string; credentials_json: string; proposals_json: string; undone: number; voided: number } | undefined;
    if (!receipt || input.nowMs >= receipt.expires_at_ms) {
      throw relayError("conflict", "The 10-minute Undo period has ended.");
    }
    if (receipt.voided || hasLaterCoveringRemoval(storage, input.shareId, receipt.rowid, receipt.grants_json)) {
      throw relayError("conflict", "Access changed after removal. Undo is no longer available.");
    }
    const grants = JSON.parse(receipt.grants_json) as { grantId: string; generation: number }[];
    const credentials = JSON.parse(receipt.credentials_json) as { credential_id: string; grant_id: string }[];
    if (receipt.undone === 1) {
      if (grants.every(expected => {
        const grant = storage.getShareGrant(expected.grantId);
        return grant?.status === "active" && grant.generation === expected.generation + 1;
      })) return;
      throw relayError("conflict", "Access changed after Undo. Check the current sharing settings.");
    }
    for (const expected of grants) {
      const grant = storage.getShareGrant(expected.grantId);
      if (!grant || grant.shareId !== input.shareId || grant.status !== "revoked" || grant.generation !== expected.generation) {
        throw relayError("conflict", "Access changed after removal. Undo is no longer available.");
      }
      if (grant.parentGrantId && storage.db.prepare(`SELECT 1 FROM sync_relay_share_grants
        WHERE parent_grant_id = ? AND principal_user_id = ? AND status = 'active'`).get(grant.parentGrantId, grant.principalUserId)) {
        throw relayError("conflict", "This person already has access through the link.");
      }
      if (grant.parentGrantId && !grants.some(parent => parent.grantId === grant.parentGrantId)) {
        const parent = storage.getShareGrant(grant.parentGrantId);
        if (!parent || parent.status !== "active" || parent.shareId !== grant.shareId || parent.principalKind !== "link" ||
            shareAccessRank(parent.access) < shareAccessRank(grant.access)) {
          throw relayError("conflict", "The parent link no longer allows this access.");
        }
      }
    }
    const parents = new Set(grants.map(expected => storage.getShareGrant(expected.grantId)?.parentGrantId).filter((id): id is string => Boolean(id)));
    for (const parentId of parents) {
      const active = storage.db.prepare("SELECT COUNT(*) AS total FROM sync_relay_share_grants WHERE parent_grant_id = ? AND status = 'active'").get(parentId) as {total: number};
      const restored = grants.filter(expected => storage.getShareGrant(expected.grantId)?.parentGrantId === parentId).length;
      if (active.total + restored > ACTIVE_LINK_DEPENDENT_GRANT_LIMIT) throw relayError("conflict", "The link has too many recipients to undo this removal.");
    }
    for (const credential of credentials) {
      const retained = storage.db.prepare(`SELECT 1 FROM sync_relay_link_credentials
        WHERE credential_id = ? AND grant_id = ? AND retired_at_ms IS NOT NULL`)
        .get(credential.credential_id, credential.grant_id);
      if (!retained) throw relayError("conflict", "The original link is no longer available.");
    }
    for (const grant of grants) storage.db.prepare(`UPDATE sync_relay_share_grants
      SET status = 'active', revoked_at_ms = NULL, generation = generation + 1 WHERE grant_id = ?`).run(grant.grantId);
    for (const credential of credentials) storage.db.prepare(`UPDATE sync_relay_link_credentials
      SET retired_at_ms = NULL, generation = (SELECT generation FROM sync_relay_share_grants WHERE grant_id = ?)
      WHERE credential_id = ?`).run(credential.grant_id, credential.credential_id);
    for (const proposalId of JSON.parse(receipt.proposals_json) as string[]) {
      storage.db.prepare(`UPDATE sync_relay_share_proposals SET state = 'open', settled_at_ms = NULL
        WHERE proposal_id = ? AND share_id = ? AND state = 'declined'`).run(proposalId, input.shareId);
    }
    storage.db.prepare("UPDATE sync_relay_share_removals SET undone = 1 WHERE undo_id = ?").run(input.undoId);
  });
}

export function listRemovedSharesForRecipient(storage: StorageContext, userId: string, shareId?: string) {
  const rows = storage.db.prepare(`SELECT g.share_id, g.grant_id, MAX(g.revoked_at_ms) AS revoked_at_ms
    FROM sync_relay_share_grants g JOIN sync_relay_shares s ON s.share_id = g.share_id
    JOIN sync_relay_workspaces w ON w.workspace_id = s.workspace_id AND w.owner_user_id = s.granter_user_id
    WHERE g.principal_kind = 'user' AND g.principal_user_id = ? AND g.status = 'revoked'
    ${shareId === undefined ? '' : 'AND g.share_id = ?'}
    AND NOT EXISTS (SELECT 1 FROM sync_relay_share_grants active
      WHERE active.share_id = g.share_id AND active.principal_user_id = ? AND active.status = 'active')
    GROUP BY g.share_id
    ORDER BY revoked_at_ms DESC, g.grant_id LIMIT 1000`).all(...(shareId === undefined ? [userId, userId] : [userId, shareId, userId])) as
    { share_id: string; grant_id: string; revoked_at_ms: number }[];
  return rows.map(row => ({ shareId: row.share_id, grantId: row.grant_id,
    message: "The owner removed your access." as const, removedAtMs: row.revoked_at_ms }));
}
