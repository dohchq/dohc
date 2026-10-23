import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { linkChatOrigin, LINK_CHAT_MESSAGE_ID_PREFIX, LINK_CHAT_ORIGIN_PREFIX, LINK_CHAT_THREAD_ID_PREFIX } from "../relayLogInputs";
import { authorizeLinkChatAction } from "../shareAuthorization";
import type { StorageContext } from "./context";
import { nextShareDiscussionRevision, validLinkDiscussionIdempotencyKey } from "./discussion";
import { DISCUSSION_MESSAGE_RATE_WINDOW_MS, LINK_CHAT_BODY_BYTE_LIMIT } from "./limits";
import { commitLinkEnrollment, linkPrincipalLimitReached, linkPrincipalStorageBytes, linkWriteRefusal, readLinkEnrollment } from "./linkEnrollment";
import { appendLogBatchInTransaction, fetchChatMessage, maxOriginSeq } from "./log";
import type { SyncRelayLogRow } from "./types";
import { workspaceUsageBytes } from "./workspaces";

export type AppendLinkChatPostResult =
  | { ok: true; replayed: boolean; workspaceId: string; shareId: string; enrolled: boolean; row: SyncRelayLogRow }
  | {
      ok: false;
      reason:
        | "invalid-input"
        | "not-authorized"
        | "read-only"
        | "blocked"
        | "paused"
        | "name-already-set"
        | "idempotency-conflict"
        | "principal-limit"
        | "rate-limit"
        | "lifetime-limit"
        | "share-limit"
        | "workspace-quota";
    };

function linkChatBody(value: string): string | null {
  if (!value.isWellFormed()) return null;
  const body = value.replace(/\r\n?/gu, "\n").trimEnd();
  return body && Buffer.byteLength(body) <= LINK_CHAT_BODY_BYTE_LIMIT ? body : null;
}

/**
 * Posts one message to a Group's channel from a link holder. The relay
 * writes the operations itself, in the replication shape every desktop
 * accepts for a link author: the link grant, the link principal and the
 * principal's name, and no account. The caller names only the body, an
 * optional thread of the channel, and a retry key. Inside one transaction
 * the link's session, grant and Group are read again, then a retry is
 * answered, then pause, block, name and every limit decide.
 */
export function appendLinkChatPost(storage: StorageContext, input: {
  capabilityHash: string;
  profileTokenHash: string;
  grantId: string;
  generation: number;
  channelWireId: string;
  threadId: string | null;
  body: string;
  claimedName: string | null;
  idempotencyKey: string;
  createdAtMs: number;
}): AppendLinkChatPostResult {
  const body = linkChatBody(input.body);
  const claimed = input.claimedName === null ? null : normalizeShareDiscussionDisplayName(input.claimedName);
  if (body === null || (claimed !== null && !claimed.ok) || !validLinkDiscussionIdempotencyKey(input.idempotencyKey) ||
      (input.threadId !== null && (!input.threadId || !input.threadId.isWellFormed())) ||
      !Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
    return { ok: false, reason: "invalid-input" };
  }
  const claimedName = claimed?.ok ? claimed.value : null;
  const createdAtMs = input.createdAtMs;
  return storage.tx((): AppendLinkChatPostResult => {
    const enrollment = readLinkEnrollment(storage, input, createdAtMs);
    if (!enrollment || enrollment.authority.grant_id !== input.grantId ||
        Number(enrollment.authority.grant_generation) !== input.generation) {
      return { ok: false, reason: "not-authorized" };
    }
    const authorized = authorizeLinkChatAction({ storage, grantId: input.grantId, action: "append" });
    if (!authorized.ok) return { ok: false, reason: authorized.reason === "denied" ? "read-only" : "not-authorized" };
    const { workspaceId, shareId } = authorized.share;
    if (authorized.grant.generation !== input.generation || authorized.effectiveSelector.channelWireId !== input.channelWireId) {
      return { ok: false, reason: "not-authorized" };
    }
    if (input.threadId !== null && storage.findThreadCreateChannelWireId(workspaceId, input.threadId) !== input.channelWireId) {
      return { ok: false, reason: "invalid-input" };
    }

    const { principal } = enrollment;
    // The profile's hash never leaves the relay, so nobody else can predict
    // these IDs, and a retry from the same profile still finds its post.
    const ids = (principalId: string) => {
      const key = sha256Hex(JSON.stringify([principalId, input.profileTokenHash, input.idempotencyKey]));
      return { originId: linkChatOrigin(principalId), messageId: `${LINK_CHAT_MESSAGE_ID_PREFIX}${key}`,
        threadId: input.threadId ?? `${LINK_CHAT_THREAD_ID_PREFIX}${key}` };
    };
    if (principal) {
      const { originId, messageId, threadId } = ids(principal.principalId);
      const existing = fetchChatMessage(storage, { workspaceId, originId, messageId });
      if (existing) {
        const stored = JSON.parse(existing.payloadJson) as { body?: unknown; threadId?: unknown };
        return stored.body === body && stored.threadId === threadId
          ? { ok: true, replayed: true, workspaceId, shareId, enrolled: false, row: existing }
          : { ok: false, reason: "idempotency-conflict" };
      }
    }
    const refusal = linkWriteRefusal(enrollment);
    if (refusal) return { ok: false, reason: refusal };
    if (principal && claimedName !== null && principal.displayName !== null && claimedName !== principal.displayName) {
      return { ok: false, reason: "name-already-set" };
    }
    if (linkPrincipalLimitReached(storage, enrollment)) return { ok: false, reason: "principal-limit" };
    if (principal) {
      const posted = storage.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(recorded_at_ms > ?), 0) AS recent
        FROM sync_relay_log WHERE workspace_id = ? AND origin_id = ? AND op_kind = 'chat.message.append'`)
        .get(createdAtMs - DISCUSSION_MESSAGE_RATE_WINDOW_MS, workspaceId, linkChatOrigin(principal.principalId));
      if (Number(posted?.recent ?? 0) >= storage.options.discussionMessageRateLimit) return { ok: false, reason: "rate-limit" };
      if (Number(posted?.count ?? 0) >= storage.options.discussionLifetimeMessageLimit) return { ok: false, reason: "lifetime-limit" };
    }
    const sharePosts = storage.db.prepare(`SELECT COUNT(*) AS count FROM sync_relay_log
      WHERE workspace_id = ? AND op_kind = 'chat.message.append' AND origin_id IN (
        SELECT ? || principal.principal_id FROM sync_relay_link_principals AS principal
        JOIN sync_relay_share_grants AS grant ON grant.grant_id = principal.grant_id
        WHERE grant.share_id = ?)`).get(workspaceId, LINK_CHAT_ORIGIN_PREFIX, shareId)?.count;
    if (Number(sharePosts ?? 0) >= storage.options.discussionNonOwnerShareRowLimit) return { ok: false, reason: "share-limit" };

    const principalId = principal?.principalId ?? storage.newDiscussionId();
    const { originId, messageId, threadId } = ids(principalId);
    const committedName = principal?.displayName ?? claimedName;
    const createThread = input.threadId === null;
    const firstOriginSeq = maxOriginSeq(storage, workspaceId, originId) + 1;
    const ops = [
      ...(createThread ? [{ opKind: "chat.thread.create", payload: {
        threadId, title: "", channelWireId: input.channelWireId, lane: "chat", createdAtMs,
      } }] : []),
      { opKind: "chat.message.append", payload: {
        messageId, threadId, body, authorKind: "link", authorDisplayName: committedName ?? "Anonymous",
        linkGrantId: input.grantId, linkPrincipalId: principalId, createdAtMs,
      } },
    ].map((op, index) => ({ originSeq: firstOriginSeq + index, opKind: op.opKind,
      payloadJson: JSON.stringify(op.payload), recordedAtMs: createdAtMs }));
    const addedBytes = (principal ? 0 : linkPrincipalStorageBytes(principalId, input.grantId, input.profileTokenHash)) +
      ops.reduce((bytes, op) => bytes + Buffer.byteLength(op.payloadJson), 0);
    if (workspaceUsageBytes(storage, workspaceId) + addedBytes > storage.options.workspaceQuotaBytes) {
      return { ok: false, reason: "workspace-quota" };
    }
    // A new link holder, or one naming itself, is news to the owner's moderation feed.
    const enrolled = !principal || (principal.displayName === null && committedName !== null);
    commitLinkEnrollment(storage, { ...input, enrollment, principalId, displayName: committedName, createdAtMs,
      discussionRevision: enrolled ? nextShareDiscussionRevision(storage, shareId) : Number(enrollment.authority.discussion_revision) });
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops });
    const row = fetchChatMessage(storage, { workspaceId, originId, messageId });
    if (!row) throw new Error("appended link post is missing");
    return { ok: true, replayed: false, workspaceId, shareId, enrolled, row };
  });
}
