import { normalizeShareDiscussionDisplayName, normalizeShareDiscussionBody } from "@dohc/security-contract/share-discussion";
import {
  LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT,
  LINK_DISCUSSION_MESSAGE_FIXED_STORAGE_BYTES,
  LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT,
  DISCUSSION_MESSAGE_RATE_WINDOW_MS,
  LINK_DISCUSSION_PAGE_LIMIT,
  MAX_DISCUSSION_REVISION,
} from "./limits";
import { createHash } from "node:crypto";
import { type StorageContext } from "./context";
import { workspaceUsageBytes } from "./workspaces";
import {
  type AppendLinkDiscussionMessageResult,
  type AppendAuthenticatedDiscussionMessageResult,
  type SyncRelayShareDiscussionCursor,
  type SyncRelayShareDiscussionPageDirection,
  type SyncRelayShareDiscussionPage,
  type SyncRelayShareDiscussionActivityPage,
  type SyncRelayLinkPrincipalRow,
  type SyncRelayDeletedDiscussionMessage,
} from "./types";
import { rowToLinkPrincipalRow, rowToShareDiscussionMessageRow } from "./rows";
import { readLinkEnrollment, linkWriteRefusal, linkPrincipalLimitReached, linkPrincipalStorageBytes, commitLinkEnrollment } from "./linkEnrollment";

export function normalizeDiscussionDisplayName(value: unknown): string | null {
  const result = normalizeShareDiscussionDisplayName(value);
  return result.ok ? result.value : null;
}

function validLinkDiscussionIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT &&
    /^[\x20-\x7e]+$/u.test(value)
  );
}

function linkDiscussionRequestHash(body: string, claimedName: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ body, claimedName }))
    .digest("base64url");
}

function namedDiscussionRequestHash(body: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ body }))
    .digest("base64url");
}

function discussionMessageStorageBytes(input: {
  messageId: string;
  shareId: string;
  idempotencyKey: string;
  requestHash: string;
  authorKind: "owner" | "named" | "link";
  authorUserId: string | null;
  linkGrantId: string | null;
  linkPrincipalId: string | null;
  displayNameSnapshot: string;
  body: string;
}): number {
  return (
    utf8Bytes(
      input.messageId,
      input.shareId,
      input.idempotencyKey,
      input.requestHash,
      input.authorKind,
      input.authorUserId,
      input.linkGrantId,
      input.linkPrincipalId,
      input.displayNameSnapshot,
      input.body,
    ) + LINK_DISCUSSION_MESSAGE_FIXED_STORAGE_BYTES
  );
}

function validDiscussionDeletingUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <=
      LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT
  );
}

function utf8Bytes(...values: Array<string | null>): number {
  return values.reduce(
    (total, value) => total + (value === null ? 0 : Buffer.byteLength(value, "utf8")),
    0,
  );
}

export function appendLinkDiscussionMessage(storage: StorageContext, input: {
    capabilityHash: string;
    profileTokenHash: string;
    claimedName?: string | null;
    body: string;
    idempotencyKey: string;
    createdAtMs: number;
    guard?: () => void;
  }): AppendLinkDiscussionMessageResult {
    const body = normalizeShareDiscussionBody(input.body);
    const hasClaimedName =
      input.claimedName !== undefined && input.claimedName !== null;
    const claimedName = hasClaimedName
      ? normalizeDiscussionDisplayName(input.claimedName)
      : null;
    if (
      body === null ||
      (hasClaimedName && claimedName === null) ||
      !validLinkDiscussionIdempotencyKey(input.idempotencyKey) ||
      !input.capabilityHash ||
      !input.profileTokenHash ||
      !Number.isSafeInteger(input.createdAtMs) ||
      input.createdAtMs < 0
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    const createdAtMs = Math.trunc(input.createdAtMs);
    const requestHash = linkDiscussionRequestHash(body, claimedName);

    // This gate lets the HTTP boundary refresh its already-derived capability
    // immediately before the storage transaction. The transaction still owns
    // the final live-authority decision below.
    input.guard?.();
    return storage.tx(() => {
      const enrollment = readLinkEnrollment(storage, input, createdAtMs);
      if (!enrollment) return { ok: false, reason: "not-authorized" };
      const { authority } = enrollment;
      let { principal } = enrollment;
      const grantId = String(authority.grant_id);
      const shareId = String(authority.share_id);
      const workspaceId = String(authority.workspace_id);
      const activityRevision = Number(authority.discussion_revision);
      if (!Number.isSafeInteger(activityRevision) || activityRevision < 0) {
        throw new Error("share discussion revision is invalid");
      }
      if (principal) {
        const replayRow = storage.db
          .prepare(
            `SELECT message_id, share_id, idempotency_key, request_hash,
                    author_kind, author_user_id, link_grant_id, link_principal_id,
                    display_name_snapshot, body, created_at_ms, deleted_at_ms,
                     deleted_by_user_id, discussion_revision, storage_bytes
             FROM sync_relay_share_discussion_messages
             WHERE share_id = ?
               AND author_kind = 'link'
               AND link_principal_id = ?
               AND idempotency_key = ?
             LIMIT 1`,
          )
          .get(shareId, principal.principalId, input.idempotencyKey);
        if (replayRow) {
          if (replayRow.request_hash !== requestHash) {
            return { ok: false, reason: "idempotency-conflict" };
          }
          return {
            ok: true,
            replayed: true,
            principal,
            message: rowToShareDiscussionMessageRow(replayRow),
          };
        }
      }
      if (authority.access !== "comment") {
        return { ok: false, reason: "not-authorized" };
      }
      const writeRefusal = linkWriteRefusal(enrollment);
      if (writeRefusal) return { ok: false, reason: writeRefusal, activityRevision };
      if (
        principal &&
        claimedName !== null &&
        principal.displayName !== null &&
        claimedName !== principal.displayName
      ) {
        return { ok: false, reason: "name-already-set" };
      }

      if (linkPrincipalLimitReached(storage, enrollment)) return { ok: false, reason: "principal-limit" };

      if (principal) {
        const rateCount = Number(
          storage.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM sync_relay_share_discussion_messages
               WHERE author_kind = 'link'
                 AND link_principal_id = ?
                 AND created_at_ms > ?`,
            )
            .get(
              principal.principalId,
              createdAtMs - DISCUSSION_MESSAGE_RATE_WINDOW_MS,
            )?.count ?? 0,
        );
        if (rateCount >= storage.options.discussionMessageRateLimit) {
          return { ok: false, reason: "rate-limit" };
        }
        const lifetimeCount = Number(
          storage.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM sync_relay_share_discussion_messages
               WHERE author_kind = 'link' AND link_principal_id = ?`,
            )
            .get(principal.principalId)?.count ?? 0,
        );
        if (lifetimeCount >= storage.options.discussionLifetimeMessageLimit) {
          return { ok: false, reason: "lifetime-limit" };
        }
      }
      const shareRowCount = Number(
        storage.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sync_relay_share_discussion_messages
             WHERE share_id = ? AND author_kind IN ('named', 'link')`,
          )
          .get(shareId)?.count ?? 0,
      );
      if (shareRowCount >= storage.options.discussionNonOwnerShareRowLimit) {
        return { ok: false, reason: "share-limit" };
      }

      const principalId = principal?.principalId ?? storage.newDiscussionId();
      const messageId = storage.newDiscussionId();
      if (!principalId || !messageId || principalId === messageId) {
        throw new Error("discussion id generator returned an invalid identifier");
      }
      const committedName = principal?.displayName ?? claimedName;
      const displayNameSnapshot = committedName ?? "Anonymous";
      const principalAddedBytes = principal
        ? 0
        : linkPrincipalStorageBytes(principalId, grantId, input.profileTokenHash);
      const messageStorageBytes = discussionMessageStorageBytes({
        messageId,
        shareId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        authorKind: "link",
        authorUserId: null,
        linkGrantId: grantId,
        linkPrincipalId: principalId,
        displayNameSnapshot,
        body,
      });
      if (
        workspaceUsageBytes(storage, workspaceId) + principalAddedBytes + messageStorageBytes >
        storage.options.workspaceQuotaBytes
      ) {
        return { ok: false, reason: "workspace-quota" };
      }
      const discussionRevision = nextShareDiscussionRevision(storage, shareId);

      principal = commitLinkEnrollment(storage, { ...input, enrollment, principalId,
        displayName: committedName, createdAtMs, discussionRevision });

      storage.db
        .prepare(
          `INSERT INTO sync_relay_share_discussion_messages (
             message_id, share_id, idempotency_key, request_hash, author_kind,
             author_user_id, link_grant_id, link_principal_id,
             display_name_snapshot, body, created_at_ms, deleted_at_ms,
             deleted_by_user_id, discussion_revision, storage_bytes
           ) VALUES (?, ?, ?, ?, 'link', NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          messageId,
          shareId,
          input.idempotencyKey,
          requestHash,
          grantId,
          principal.principalId,
          displayNameSnapshot,
          body,
          createdAtMs,
          discussionRevision,
          messageStorageBytes,
        );
      const message = storage.db
        .prepare(
          `SELECT message_id, share_id, idempotency_key, request_hash,
                  author_kind, author_user_id, link_grant_id, link_principal_id,
                  display_name_snapshot, body, created_at_ms, deleted_at_ms,
                  deleted_by_user_id, discussion_revision, storage_bytes
           FROM sync_relay_share_discussion_messages
           WHERE message_id = ?`,
        )
        .get(messageId);
      if (!message) throw new Error("inserted discussion message is missing");
      return {
        ok: true,
        replayed: false,
        principal,
        message: rowToShareDiscussionMessageRow(message),
      };
    });
  }

export function appendAuthenticatedDiscussionMessage(storage: StorageContext, input: {
    shareId: string;
    authorUserId: string;
    displayName: string;
    body: string;
    idempotencyKey: string;
    createdAtMs: number;
    readGuard: () => "owner" | "recipient";
    appendGuard: () => "owner" | "recipient";
  }): AppendAuthenticatedDiscussionMessageResult {
    const body = normalizeShareDiscussionBody(input.body);
    const displayName = normalizeDiscussionDisplayName(input.displayName);
    if (
      body === null ||
      !input.shareId ||
      !validDiscussionDeletingUserId(input.authorUserId) ||
      displayName === null ||
      displayName !== input.displayName ||
      !validLinkDiscussionIdempotencyKey(input.idempotencyKey) ||
      !Number.isSafeInteger(input.createdAtMs) ||
      input.createdAtMs < 0
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    const createdAtMs = Math.trunc(input.createdAtMs);
    const requestHash = namedDiscussionRequestHash(body);

    return storage.tx(() => {
      // The caller's server-derived identity and current read authority are
      // rechecked under this write lock before any durable replay is exposed.
      const readerRole = input.readGuard();
      if (readerRole !== "owner" && readerRole !== "recipient") {
        throw new Error("discussion authority guard returned an invalid role");
      }
      const share = storage.db
        .prepare(
          `SELECT workspace_id
           FROM sync_relay_shares
           WHERE share_id = ?
           LIMIT 1`,
        )
        .get(input.shareId);
      if (!share) return { ok: false, reason: "invalid-input" };

      const replayRow = storage.db
        .prepare(
          `SELECT message_id, share_id, idempotency_key, request_hash,
                  author_kind, author_user_id, link_grant_id, link_principal_id,
                  display_name_snapshot, body, created_at_ms, deleted_at_ms,
                  deleted_by_user_id, discussion_revision, storage_bytes
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_kind IN ('owner', 'named')
             AND author_user_id = ?
             AND idempotency_key = ?
           LIMIT 1`,
        )
        .get(input.shareId, input.authorUserId, input.idempotencyKey);
      if (replayRow) {
        if (replayRow.request_hash !== requestHash) {
          return { ok: false, reason: "idempotency-conflict" };
        }
        return {
          ok: true,
          replayed: true,
          message: rowToShareDiscussionMessageRow(replayRow),
        };
      }

      // Only a genuinely new insert needs current Comment/Edit authority. This
      // second check shares the transaction's write lock with all budget work.
      const authorRole = input.appendGuard();
      if (authorRole !== "owner" && authorRole !== "recipient") {
        throw new Error("discussion append guard returned an invalid role");
      }
      const authorKind = authorRole === "owner" ? "owner" : "named";

      if (authorRole === "recipient") {
        const rateCount = Number(
          storage.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM sync_relay_share_discussion_messages
               WHERE share_id = ?
                 AND author_kind = 'named'
                 AND author_user_id = ?
                 AND created_at_ms > ?`,
            )
            .get(
              input.shareId,
              input.authorUserId,
              createdAtMs - DISCUSSION_MESSAGE_RATE_WINDOW_MS,
            )?.count ?? 0,
        );
        if (rateCount >= storage.options.discussionMessageRateLimit) {
          return { ok: false, reason: "rate-limit" };
        }
        const lifetimeCount = Number(
          storage.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM sync_relay_share_discussion_messages
               WHERE share_id = ?
                 AND author_kind = 'named'
                 AND author_user_id = ?`,
            )
            .get(input.shareId, input.authorUserId)?.count ?? 0,
        );
        if (lifetimeCount >= storage.options.discussionLifetimeMessageLimit) {
          return { ok: false, reason: "lifetime-limit" };
        }
        const shareRowCount = Number(
          storage.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM sync_relay_share_discussion_messages
               WHERE share_id = ? AND author_kind IN ('named', 'link')`,
            )
            .get(input.shareId)?.count ?? 0,
        );
        if (shareRowCount >= storage.options.discussionNonOwnerShareRowLimit) {
          return { ok: false, reason: "share-limit" };
        }
      }

      const messageId = storage.newDiscussionId();
      if (!messageId) {
        throw new Error("discussion id generator returned an invalid identifier");
      }
      const messageStorageBytes = discussionMessageStorageBytes({
        messageId,
        shareId: input.shareId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        authorKind,
        authorUserId: input.authorUserId,
        linkGrantId: null,
        linkPrincipalId: null,
        displayNameSnapshot: displayName,
        body,
      });
      if (
        workspaceUsageBytes(storage, String(share.workspace_id)) + messageStorageBytes >
        storage.options.workspaceQuotaBytes
      ) {
        return { ok: false, reason: "workspace-quota" };
      }
      const discussionRevision = nextShareDiscussionRevision(storage, input.shareId);

      storage.db
        .prepare(
          `INSERT INTO sync_relay_share_discussion_messages (
             message_id, share_id, idempotency_key, request_hash, author_kind,
             author_user_id, link_grant_id, link_principal_id,
             display_name_snapshot, body, created_at_ms, deleted_at_ms,
             deleted_by_user_id, discussion_revision, storage_bytes
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          messageId,
          input.shareId,
          input.idempotencyKey,
          requestHash,
          authorKind,
          input.authorUserId,
          displayName,
          body,
          createdAtMs,
          discussionRevision,
          messageStorageBytes,
        );
      const message = storage.db
        .prepare(
          `SELECT message_id, share_id, idempotency_key, request_hash,
                  author_kind, author_user_id, link_grant_id, link_principal_id,
                  display_name_snapshot, body, created_at_ms, deleted_at_ms,
                  deleted_by_user_id, discussion_revision, storage_bytes
           FROM sync_relay_share_discussion_messages
           WHERE message_id = ?`,
        )
        .get(messageId);
      if (!message) throw new Error("inserted discussion message is missing");
      return {
        ok: true,
        replayed: false,
        message: rowToShareDiscussionMessageRow(message),
      };
    });
  }

export function listShareDiscussionMessages(storage: StorageContext, input: {
    shareId: string;
    after?: SyncRelayShareDiscussionCursor | null;
    before?: SyncRelayShareDiscussionCursor | null;
    direction?: SyncRelayShareDiscussionPageDirection;
    limit: number;
  }): SyncRelayShareDiscussionPage {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > LINK_DISCUSSION_PAGE_LIMIT
    ) {
      throw new Error(`discussion page limit must be between 1 and ${LINK_DISCUSSION_PAGE_LIMIT}`);
    }
    const direction = input.direction ?? "oldest-first";
    if (direction !== "oldest-first" && direction !== "newest-first") {
      throw new Error("discussion page direction is invalid");
    }
    const cursor =
      direction === "newest-first" ? (input.before ?? null) : (input.after ?? null);
    if (
      cursor !== null &&
      (!Number.isSafeInteger(cursor.createdAtMs) || !cursor.messageId)
    ) {
      throw new Error("discussion page cursor is invalid");
    }
    return storage.readTx(() => {
      const share = storage.db
        .prepare(
          `SELECT link_writes_paused_at_ms, discussion_revision
           FROM sync_relay_shares
           WHERE share_id = ?`,
        )
        .get(input.shareId);
      const rows = (
        cursor === null
          ? storage.db
              .prepare(
                `SELECT message.message_id, message.share_id,
                        message.idempotency_key, message.request_hash,
                        message.author_kind, message.author_user_id,
                        message.link_grant_id, message.link_principal_id,
                        message.display_name_snapshot, message.body,
                        message.created_at_ms, message.deleted_at_ms,
                        message.deleted_by_user_id, message.discussion_revision,
                        message.storage_bytes,
                        principal.blocked_at_ms AS link_principal_blocked_at_ms
                 FROM sync_relay_share_discussion_messages AS message
                 LEFT JOIN sync_relay_link_principals AS principal
                   ON principal.principal_id = message.link_principal_id
                  AND principal.grant_id = message.link_grant_id
                 WHERE message.share_id = ?
                  ORDER BY message.created_at_ms ${direction === "newest-first" ? "DESC" : "ASC"},
                           message.message_id ${direction === "newest-first" ? "DESC" : "ASC"}
                  LIMIT ?`,
              )
              .all(input.shareId, input.limit + 1)
          : storage.db
              .prepare(
                `SELECT message.message_id, message.share_id,
                        message.idempotency_key, message.request_hash,
                        message.author_kind, message.author_user_id,
                        message.link_grant_id, message.link_principal_id,
                        message.display_name_snapshot, message.body,
                        message.created_at_ms, message.deleted_at_ms,
                        message.deleted_by_user_id, message.discussion_revision,
                        message.storage_bytes,
                        principal.blocked_at_ms AS link_principal_blocked_at_ms
                 FROM sync_relay_share_discussion_messages AS message
                 LEFT JOIN sync_relay_link_principals AS principal
                   ON principal.principal_id = message.link_principal_id
                  AND principal.grant_id = message.link_grant_id
                 WHERE message.share_id = ?
                    AND (message.created_at_ms ${direction === "newest-first" ? "<" : ">"} ? OR
                         (message.created_at_ms = ? AND
                          message.message_id ${direction === "newest-first" ? "<" : ">"} ?))
                  ORDER BY message.created_at_ms ${direction === "newest-first" ? "DESC" : "ASC"},
                           message.message_id ${direction === "newest-first" ? "DESC" : "ASC"}
                  LIMIT ?`,
              )
              .all(
                input.shareId,
                cursor.createdAtMs,
                cursor.createdAtMs,
                cursor.messageId,
                input.limit + 1,
              )
      ).map((row) => ({
        ...rowToShareDiscussionMessageRow(row),
        linkPrincipalBlocked:
          row.author_kind === "link"
            ? row.link_principal_blocked_at_ms !== null
            : null,
      }));
      const hasMore = rows.length > input.limit;
      const messages = hasMore ? rows.slice(0, input.limit) : rows;
      const last = messages.at(-1);
      return {
        messages,
        nextCursor:
          hasMore && last
            ? { createdAtMs: last.createdAtMs, messageId: last.messageId }
            : null,
        linkCommentsPaused: share?.link_writes_paused_at_ms != null,
        activityRevision: Number(share?.discussion_revision ?? 0),
      };
    });
  }

export function getShareDiscussionRevision(storage: StorageContext, shareId: string): number | null {
    const row = storage.db
      .prepare(
        `SELECT discussion_revision
         FROM sync_relay_shares
         WHERE share_id = ?`,
      )
      .get(shareId);
    return row ? Number(row.discussion_revision) : null;
  }

export function listShareDiscussionActivity(storage: StorageContext, input: {
    shareId: string;
    sinceRevision: number;
    limit: number;
  }): SyncRelayShareDiscussionActivityPage {
    if (
      !Number.isSafeInteger(input.sinceRevision) ||
      input.sinceRevision < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > LINK_DISCUSSION_PAGE_LIMIT
    ) {
      throw new Error("discussion activity query is invalid");
    }
    return storage.readTx(() => {
      const share = storage.db
        .prepare(
          `SELECT link_writes_paused_at_ms, discussion_revision
           FROM sync_relay_shares
           WHERE share_id = ?`,
        )
        .get(input.shareId);
      const latestRevision = Number(share?.discussion_revision ?? 0);
      if (input.sinceRevision > latestRevision) {
        throw new Error("discussion activity revision is ahead of storage");
      }
      const changedRevisions = storage.db
        .prepare(
          `SELECT discussion_revision
           FROM (
             SELECT message.discussion_revision AS discussion_revision
             FROM sync_relay_share_discussion_messages AS message
             WHERE message.share_id = ?
               AND message.discussion_revision > ?
             UNION
             SELECT principal.discussion_revision AS discussion_revision
             FROM sync_relay_link_principals AS principal
             JOIN sync_relay_share_grants AS grant
               ON grant.grant_id = principal.grant_id
             WHERE grant.share_id = ?
               AND principal.discussion_revision > ?
           )
           ORDER BY discussion_revision
           LIMIT ?`,
        )
        .all(
          input.shareId,
          input.sinceRevision,
          input.shareId,
          input.sinceRevision,
          input.limit + 1,
        )
        .map((row) => Number(row.discussion_revision));
      const hasMore = changedRevisions.length > input.limit;
      const cursorRevision = hasMore
        ? changedRevisions[input.limit - 1]!
        : latestRevision;
      const messages = storage.db
        .prepare(
          `SELECT message.message_id, message.share_id,
                  message.idempotency_key, message.request_hash,
                  message.author_kind, message.author_user_id,
                  message.link_grant_id, message.link_principal_id,
                  message.display_name_snapshot, message.body,
                  message.created_at_ms, message.deleted_at_ms,
                  message.deleted_by_user_id, message.discussion_revision,
                  message.storage_bytes,
                  principal.blocked_at_ms AS link_principal_blocked_at_ms
           FROM sync_relay_share_discussion_messages AS message
           LEFT JOIN sync_relay_link_principals AS principal
             ON principal.principal_id = message.link_principal_id
            AND principal.grant_id = message.link_grant_id
           WHERE message.share_id = ?
             AND message.discussion_revision > ?
             AND message.discussion_revision <= ?
           ORDER BY message.created_at_ms, message.message_id`,
        )
        .all(input.shareId, input.sinceRevision, cursorRevision)
        .map((row) => ({
          ...rowToShareDiscussionMessageRow(row),
          linkPrincipalBlocked:
            row.author_kind === "link"
              ? row.link_principal_blocked_at_ms !== null
              : null,
        }));
      const principals = storage.db
        .prepare(
          `SELECT principal.principal_id, principal.grant_id,
                  principal.mint_generation, principal.profile_token_hash,
                  principal.display_name, principal.created_at_ms,
                  principal.blocked_at_ms, principal.discussion_revision,
                  principal.storage_bytes
           FROM sync_relay_link_principals AS principal
           JOIN sync_relay_share_grants AS grant
             ON grant.grant_id = principal.grant_id
           WHERE grant.share_id = ?
             AND principal.discussion_revision > ?
             AND principal.discussion_revision <= ?
           ORDER BY principal.discussion_revision, principal.principal_id`,
        )
        .all(input.shareId, input.sinceRevision, cursorRevision)
        .map(rowToLinkPrincipalRow);
      return {
        latestRevision,
        cursorRevision,
        hasMore,
        messages,
        principals,
        linkCommentsPaused: share?.link_writes_paused_at_ms != null,
      };
    });
  }

export function getLinkPrincipal(storage: StorageContext, principalId: string): SyncRelayLinkPrincipalRow | null {
    const row = storage.db
      .prepare(
        `SELECT principal_id, grant_id, mint_generation, profile_token_hash,
                display_name, created_at_ms, blocked_at_ms,
                discussion_revision, storage_bytes
         FROM sync_relay_link_principals
         WHERE principal_id = ?`,
      )
      .get(principalId);
    return row ? rowToLinkPrincipalRow(row) : null;
  }

export function getLinkPrincipalForGrantProfile(
    storage: StorageContext,
    grantId: string,
    profileTokenHash: string,
  ): SyncRelayLinkPrincipalRow | null {
    const row = storage.db
      .prepare(
        `SELECT principal_id, grant_id, mint_generation, profile_token_hash,
                display_name, created_at_ms, blocked_at_ms,
                discussion_revision, storage_bytes
         FROM sync_relay_link_principals
         WHERE grant_id = ? AND profile_token_hash = ?
         LIMIT 1`,
      )
      .get(grantId, profileTokenHash);
    return row ? rowToLinkPrincipalRow(row) : null;
  }

export function setLinkPrincipalBlocked(storage: StorageContext, input: {
    shareId: string;
    workspaceId: string;
    principalId: string;
    actorUserId: string;
    blockedAtMs: number | null;
  }): boolean {
    if (
      !validDiscussionDeletingUserId(input.actorUserId) ||
      (input.blockedAtMs !== null &&
        (!Number.isSafeInteger(input.blockedAtMs) || input.blockedAtMs < 0))
    ) {
      return false;
    }
    return storage.tx(() => {
      const principal = storage.db
        .prepare(
          `SELECT principal.principal_id
           FROM sync_relay_link_principals AS principal
           JOIN sync_relay_share_grants AS grant ON grant.grant_id = principal.grant_id
           JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
           JOIN sync_relay_workspaces AS workspace
             ON workspace.workspace_id = share.workspace_id
           WHERE principal.principal_id = ?
             AND share.share_id = ?
             AND workspace.workspace_id = ?
             AND workspace.owner_user_id = ?`,
        )
        .get(
          input.principalId,
          input.shareId,
          input.workspaceId,
          input.actorUserId,
        );
      if (!principal) return false;
      const discussionRevision = nextShareDiscussionRevision(storage, input.shareId);
      storage.db
        .prepare(
          `UPDATE sync_relay_link_principals
           SET blocked_at_ms = ?, discussion_revision = ?
           WHERE principal_id = ?`,
        )
        .run(
          input.blockedAtMs === null ? null : Math.trunc(input.blockedAtMs),
          discussionRevision,
          input.principalId,
        );
      return true;
    });
  }

export function setShareLinkWritesPaused(storage: StorageContext, input: {
    shareId: string;
    workspaceId: string;
    actorUserId: string;
    pausedAtMs: number | null;
  }): boolean {
    if (
      !validDiscussionDeletingUserId(input.actorUserId) ||
      (input.pausedAtMs !== null &&
        (!Number.isSafeInteger(input.pausedAtMs) || input.pausedAtMs < 0))
    ) {
      return false;
    }
    return storage.tx(() => {
      const updated = storage.db
        .prepare(
          `UPDATE sync_relay_shares
           SET link_writes_paused_at_ms = ?,
               discussion_revision = discussion_revision + 1
           WHERE share_id = ?
             AND discussion_revision < ${MAX_DISCUSSION_REVISION}
             AND EXISTS (
               SELECT 1
               FROM sync_relay_workspaces AS workspace
               WHERE workspace.workspace_id = sync_relay_shares.workspace_id
                 AND workspace.workspace_id = ?
                 AND workspace.owner_user_id = ?
             )`,
        )
        .run(
          input.pausedAtMs === null ? null : Math.trunc(input.pausedAtMs),
          input.shareId,
          input.workspaceId,
          input.actorUserId,
        );
      return Number(updated.changes ?? 0) === 1;
    });
  }

export function deleteShareDiscussionMessage(storage: StorageContext, input: {
    shareId: string;
    workspaceId: string;
    messageId: string;
    deletedAtMs: number;
    actorUserId: string;
  }): SyncRelayDeletedDiscussionMessage | null {
    if (
      !Number.isSafeInteger(input.deletedAtMs) ||
      input.deletedAtMs < 0 ||
      !validDiscussionDeletingUserId(input.actorUserId)
    ) {
      return null;
    }
    return storage.tx(() => {
      const message = storage.db
        .prepare(
          `SELECT message.message_id, message.created_at_ms
           FROM sync_relay_share_discussion_messages AS message
           JOIN sync_relay_shares AS share ON share.share_id = message.share_id
           JOIN sync_relay_workspaces AS workspace
             ON workspace.workspace_id = share.workspace_id
           WHERE message.share_id = ?
             AND message.message_id = ?
             AND message.deleted_at_ms IS NULL
             AND workspace.workspace_id = ?
             AND workspace.owner_user_id = ?
           LIMIT 1`,
        )
        .get(
          input.shareId,
          input.messageId,
          input.workspaceId,
          input.actorUserId,
        );
      if (!message) return null;
      const deletedAtMs = Math.trunc(input.deletedAtMs);
      const discussionRevision = nextShareDiscussionRevision(storage, input.shareId);
      const deleted = storage.db
        .prepare(
          `UPDATE sync_relay_share_discussion_messages
           SET body = NULL,
               deleted_at_ms = ?,
               deleted_by_user_id = ?,
               discussion_revision = ?
           WHERE share_id = ? AND message_id = ? AND deleted_at_ms IS NULL`,
        )
        .run(
          deletedAtMs,
          input.actorUserId,
          discussionRevision,
          input.shareId,
          input.messageId,
        );
      if (Number(deleted.changes ?? 0) !== 1) return null;
      return {
        messageId: String(message.message_id),
        createdAtMs: Number(message.created_at_ms),
        deletedAtMs,
      };
    });
  }

export function nextShareDiscussionRevision(storage: StorageContext, shareId: string): number {
    const row = storage.db
      .prepare(
        `UPDATE sync_relay_shares
         SET discussion_revision = discussion_revision + 1
         WHERE share_id = ?
           AND discussion_revision < ${MAX_DISCUSSION_REVISION}
         RETURNING discussion_revision`,
      )
      .get(shareId);
    if (!row) throw new Error("share discussion revision cannot advance");
    const revision = Number(row.discussion_revision);
    if (!Number.isSafeInteger(revision)) {
      throw new Error("share discussion revision is invalid");
    }
    return revision;
  }
