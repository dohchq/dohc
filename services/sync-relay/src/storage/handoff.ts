import { type StorageContext } from "./context";
import { insertShareGrant } from "./shares";
import { type SyncRelayLinkHandoffCodeRow, type LinkHandoffRedeemResult, type SyncRelayShareGrantRow } from "./types";
import { LINK_HANDOFF_CODES_PER_GRANT_LIMIT, constantTimeHashEqual } from "../linkSecurity";
import { rowToLinkHandoffCodeRow, rowToShareGrantRow } from "./rows";
import { ACTIVE_LINK_DEPENDENT_GRANT_LIMIT } from "./limits";

export function mintLinkHandoffCode(storage: StorageContext, input: {
    code: SyncRelayLinkHandoffCodeRow;
    guard: () => boolean;
  }): boolean {
    const { code } = input;
    if (
      !code.codeId ||
      !code.codeHash ||
      !Number.isInteger(code.generation) ||
      code.generation < 1 ||
      !Number.isSafeInteger(code.mintedAtMs) ||
      !Number.isSafeInteger(code.expiresAtMs) ||
      code.expiresAtMs <= code.mintedAtMs
    ) {
      return false;
    }
    return storage.tx(() => {
      if (!input.guard()) return false;
      const grant = storage.getShareGrant(code.grantId);
      if (
        !grant ||
        grant.principalKind !== "link" ||
        grant.status !== "active" ||
        grant.revokedAtMs !== null ||
        grant.generation !== code.generation ||
        (grant.access !== "view" && grant.access !== "comment")
      ) {
        return false;
      }

      storage.db
        .prepare("DELETE FROM sync_relay_link_handoff_codes WHERE expires_at_ms <= ?")
        .run(Math.trunc(code.mintedAtMs));
      const currentCount = Number(
        storage.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sync_relay_link_handoff_codes
             WHERE grant_id = ?`,
          )
          .get(code.grantId)?.count ?? 0,
      );
      const codesToDelete =
        currentCount - LINK_HANDOFF_CODES_PER_GRANT_LIMIT + 1;
      if (codesToDelete > 0) {
        const evicted = storage.db
          .prepare(
            `DELETE FROM sync_relay_link_handoff_codes
             WHERE code_id IN (
               SELECT code_id
               FROM sync_relay_link_handoff_codes
               WHERE grant_id = ? AND result_grant_id IS NULL
               ORDER BY minted_at_ms ASC, code_id ASC
               LIMIT ?
             )`,
          )
          .run(code.grantId, codesToDelete);
        if (Number(evicted.changes ?? 0) !== codesToDelete) return false;
      }
      storage.db
        .prepare(
          `INSERT INTO sync_relay_link_handoff_codes (
             code_id, code_hash, grant_id, generation, minted_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          code.codeId,
          code.codeHash,
          code.grantId,
          code.generation,
          Math.trunc(code.mintedAtMs),
          Math.trunc(code.expiresAtMs),
        );
      return true;
    });
  }

export function hasLinkHandoffCode(storage: StorageContext, codeHash: string): boolean {
    if (!codeHash) return false;
    return (
      storage.db
        .prepare(
          `SELECT 1
           FROM sync_relay_link_handoff_codes
           WHERE code_hash = ?
           LIMIT 1`,
        )
        .get(codeHash) !== undefined
    );
  }

export function redeemLinkHandoffCode(storage: StorageContext, input: {
    codeHash: string;
    principalUserId: string;
    redeemedAtMs: number;
    mintGrantId: () => string;
    guard: (code: SyncRelayLinkHandoffCodeRow) => boolean;
  }): LinkHandoffRedeemResult {
    if (
      !input.codeHash ||
      !input.principalUserId ||
      !Number.isSafeInteger(input.redeemedAtMs)
    ) {
      return { ok: false };
    }
    return storage.tx(() => {
      const storedRow = storage.db
        .prepare(
          `SELECT code_id, code_hash, grant_id, generation, minted_at_ms, expires_at_ms,
                  result_grant_id
           FROM sync_relay_link_handoff_codes
           WHERE code_hash = ?
           LIMIT 1`,
        )
        .get(input.codeHash);
      if (!storedRow) return { ok: false };
      const code = rowToLinkHandoffCodeRow(storedRow);
      if (!constantTimeHashEqual(input.codeHash, code.codeHash)) {
        return { ok: false };
      }
      const deleteCode = (): void => {
        storage.db
          .prepare(
            `DELETE FROM sync_relay_link_handoff_codes
             WHERE code_id = ? AND code_hash = ?`,
          )
          .run(code.codeId, code.codeHash);
      };
      const recordResultGrant = (grantId: string): boolean => {
        const recorded = storage.db
          .prepare(
            `UPDATE sync_relay_link_handoff_codes
             SET result_grant_id = ?
             WHERE code_id = ? AND code_hash = ? AND result_grant_id IS NULL`,
          )
          .run(grantId, code.codeId, code.codeHash);
        return Number(recorded.changes ?? 0) === 1;
      };
      if (code.expiresAtMs <= input.redeemedAtMs) {
        deleteCode();
        return { ok: false };
      }

      if (code.resultGrantId !== null) {
        const grant = storage.getShareGrant(code.resultGrantId);
        if (grant?.principalUserId !== input.principalUserId) {
          return { ok: false };
        }
        if (
          grant.principalKind !== "user" ||
          grant.status !== "active" ||
          grant.revokedAtMs !== null ||
          (grant.access !== "view" && grant.access !== "comment")
        ) {
          deleteCode();
          return { ok: false };
        }
        return { ok: true, shareId: grant.shareId, grant };
      }

      const refuseAndConsume = (): LinkHandoffRedeemResult => {
        deleteCode();
        return { ok: false };
      };

      let authorized = false;
      try {
        authorized = input.guard(code);
      } catch {
        authorized = false;
      }
      if (!authorized) return refuseAndConsume();

      const parent = storage.getShareGrant(code.grantId);
      if (
        !parent ||
        parent.principalKind !== "link" ||
        parent.status !== "active" ||
        parent.revokedAtMs !== null ||
        parent.generation !== code.generation ||
        (parent.access !== "view" && parent.access !== "comment")
      ) {
        return refuseAndConsume();
      }
      const share = storage.getShare(parent.shareId);
      if (!share || share.granterUserId === input.principalUserId) {
        return refuseAndConsume();
      }

      const dependents = storage.db
        .prepare(
          `SELECT grant_id, share_id, principal_kind, principal_user_id,
                  principal_email, access, generation, status, created_at_ms,
                  revoked_at_ms, parent_grant_id
           FROM sync_relay_share_grants
           WHERE parent_grant_id = ? AND principal_user_id = ?
           ORDER BY created_at_ms, grant_id`,
        )
        .all(parent.grantId, input.principalUserId)
        .map(rowToShareGrantRow);
      if (dependents.some((dependent) => dependent.status === "revoked")) {
        return refuseAndConsume();
      }
      const existing = dependents.find(
        (dependent) => dependent.status === "active",
      );
      if (existing) {
        if (!recordResultGrant(existing.grantId)) return { ok: false };
        return { ok: true, shareId: share.shareId, grant: existing };
      }

      const activeDependentCount = Number(
        storage.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sync_relay_share_grants
             WHERE parent_grant_id = ? AND status = 'active'`,
          )
          .get(parent.grantId)?.count ?? 0,
      );
      if (activeDependentCount >= ACTIVE_LINK_DEPENDENT_GRANT_LIMIT) {
        return refuseAndConsume();
      }

      const grant: SyncRelayShareGrantRow = {
        grantId: input.mintGrantId(),
        shareId: share.shareId,
        principalKind: "user",
        principalUserId: input.principalUserId,
        principalEmail: null,
        access: parent.access,
        generation: 1,
        status: "active",
        createdAtMs: Math.trunc(input.redeemedAtMs),
        revokedAtMs: null,
        parentGrantId: parent.grantId,
      };
      if (!recordResultGrant(grant.grantId)) return { ok: false };
      insertShareGrant(storage, grant);
      return { ok: true, shareId: share.shareId, grant };
    });
  }
