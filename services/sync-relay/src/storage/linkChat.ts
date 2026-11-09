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
import { agentName, readAgentAuthority, recordAgentConnectionActionInTransaction, type AgentAccessCheck } from "./agentConnections";

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

// The profile's hash never leaves the relay, so nobody else can predict
// these IDs, and a retry from the same profile still finds its post.
function linkPostIds(principalId: string, profileTokenHash: string, idempotencyKey: string, threadId: string | null) {
  const key = sha256Hex(JSON.stringify([principalId, profileTokenHash, idempotencyKey]));
  return { originId: linkChatOrigin(principalId), messageId: `${LINK_CHAT_MESSAGE_ID_PREFIX}${key}`,
    threadId: threadId ?? `${LINK_CHAT_THREAD_ID_PREFIX}${key}` };
}

// A retry answers with its first post. The same key for another post conflicts.
export function replayedLinkPost(storage: StorageContext, workspaceId: string,
  ids: { originId: string; messageId: string; threadId: string }, body: string):
  SyncRelayLogRow | "conflict" | null {
  const existing = fetchChatMessage(storage, { workspaceId, originId: ids.originId, messageId: ids.messageId });
  if (!existing) return null;
  const stored = JSON.parse(existing.payloadJson) as { body?: unknown; threadId?: unknown };
  return stored.body === body && stored.threadId === ids.threadId ? existing : "conflict";
}

// One link principal's rate and lifetime, and every link principal's posts on the share.
function linkPostLimitRefusal(storage: StorageContext, input: {
  workspaceId: string; shareId: string; principalId: string | null; createdAtMs: number;
}): "rate-limit" | "lifetime-limit" | "share-limit" | null {
  if (input.principalId !== null) {
    const posted = storage.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(recorded_at_ms > ?), 0) AS recent
      FROM sync_relay_log WHERE workspace_id = ? AND origin_id = ? AND op_kind = 'chat.message.append'`)
      .get(input.createdAtMs - DISCUSSION_MESSAGE_RATE_WINDOW_MS, input.workspaceId, linkChatOrigin(input.principalId));
    if (Number(posted?.recent ?? 0) >= storage.options.discussionMessageRateLimit) return "rate-limit";
    if (Number(posted?.count ?? 0) >= storage.options.discussionLifetimeMessageLimit) return "lifetime-limit";
  }
  const sharePosts = storage.db.prepare(`SELECT COUNT(*) AS count FROM sync_relay_log
    WHERE workspace_id = ? AND op_kind = 'chat.message.append' AND origin_id IN (
      SELECT ? || principal.principal_id FROM sync_relay_link_principals AS principal
      JOIN sync_relay_share_grants AS grant ON grant.grant_id = principal.grant_id
      WHERE grant.share_id = ?)`).get(input.workspaceId, LINK_CHAT_ORIGIN_PREFIX, input.shareId)?.count;
  return Number(sharePosts ?? 0) >= storage.options.discussionNonOwnerShareRowLimit ? "share-limit" : null;
}

export type RelayPostAuthor =
  | {
    authorKind: "link";
    authorDisplayName: string;
    linkGrantId: string;
    linkPrincipalId: string;
    agentConnectionId?: string;
  }
  | {
    authorKind: "agent";
    authorDisplayName: string;
    authorUserId: string;
    authorAgentId: string;
    agentConnectionId: string;
  };

// The operations every desktop accepts for a post the relay writes. A link
// post names the link grant and link principal, the agent connection when an
// agent posted, and no account. A personal agent's post names the account,
// the agent, and the connection it signed in with.
export function linkPostOps(storage: StorageContext, input: {
  workspaceId: string; originId: string; messageId: string; threadId: string; createThread: boolean;
  channelWireId: string; body: string; createdAtMs: number; author: RelayPostAuthor;
}) {
  const { createdAtMs, threadId } = input;
  const firstOriginSeq = maxOriginSeq(storage, input.workspaceId, input.originId) + 1;
  return [
    ...(input.createThread ? [{ opKind: "chat.thread.create", payload: {
      threadId, title: "", channelWireId: input.channelWireId, lane: "chat", createdAtMs,
    } }] : []),
    { opKind: "chat.message.append", payload: { messageId: input.messageId, threadId, body: input.body, ...input.author, createdAtMs } },
  ].map((op, index) => ({ originSeq: firstOriginSeq + index, opKind: op.opKind,
    payloadJson: JSON.stringify(op.payload), recordedAtMs: createdAtMs }));
}

export function linkChatBody(value: string): string | null {
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
    const ids = (principalId: string) => linkPostIds(principalId, input.profileTokenHash, input.idempotencyKey, input.threadId);
    if (principal) {
      const replay = replayedLinkPost(storage, workspaceId, ids(principal.principalId), body);
      if (replay) {
        return replay === "conflict" ? { ok: false, reason: "idempotency-conflict" }
          : { ok: true, replayed: true, workspaceId, shareId, enrolled: false, row: replay };
      }
    }
    const refusal = linkWriteRefusal(enrollment);
    if (refusal) return { ok: false, reason: refusal };
    if (principal && claimedName !== null && principal.displayName !== null && claimedName !== principal.displayName) {
      return { ok: false, reason: "name-already-set" };
    }
    if (linkPrincipalLimitReached(storage, enrollment)) return { ok: false, reason: "principal-limit" };
    const limited = linkPostLimitRefusal(storage, { workspaceId, shareId, principalId: principal?.principalId ?? null, createdAtMs });
    if (limited) return { ok: false, reason: limited };

    const principalId = principal?.principalId ?? storage.newDiscussionId();
    const { originId, messageId, threadId } = ids(principalId);
    const committedName = principal?.displayName ?? claimedName;
    const ops = linkPostOps(storage, { workspaceId, originId, messageId, threadId, createThread: input.threadId === null,
      channelWireId: input.channelWireId, body, createdAtMs,
      author: { authorKind: "link", authorDisplayName: committedName ?? "Anonymous", linkGrantId: input.grantId, linkPrincipalId: principalId } });
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

export type AppendAgentChatPostResult =
  | { ok: true; replayed: boolean; workspaceId: string; shareId: string; row: SyncRelayLogRow }
  | {
      ok: false;
      reason: Exclude<Extract<AppendLinkChatPostResult, { ok: false }>["reason"], "name-already-set" | "principal-limit">;
    };

/**
 * Posts one message to a Group's channel from an agent connection. The
 * author is the connection the access token names, sent to the MCP address
 * it signed in at, under its link principal and with its agent name. The
 * caller names only the body, an optional thread of the link's channel, and
 * a retry key, so it can neither choose nor forge the author. The connection,
 * its link and the Group are read again inside the transaction that writes
 * the post, with the clock read there too, so a token that expired while the
 * write waited for the lock writes nothing.
 */
export function appendAgentChatPost(storage: StorageContext, input: {
  agent: AgentAccessCheck;
  /** The relay's clock, read inside the write. */
  now: () => number;
  threadId: string | null;
  body: string;
  idempotencyKey: string;
  createdAtMs: number;
}): AppendAgentChatPostResult {
  const body = linkChatBody(input.body);
  const { createdAtMs } = input;
  if (body === null || !validLinkDiscussionIdempotencyKey(input.idempotencyKey) ||
      (input.threadId !== null && (!input.threadId || !input.threadId.isWellFormed())) ||
      !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    return { ok: false, reason: "invalid-input" };
  }
  return storage.tx((): AppendAgentChatPostResult => {
    const connection = readAgentAuthority(storage, input.agent, input.now());
    if (!connection) return { ok: false, reason: "not-authorized" };
    const authorized = authorizeLinkChatAction({ storage, grantId: connection.grantId, action: "append" });
    if (!authorized.ok) return { ok: false, reason: authorized.reason === "denied" ? "read-only" : "not-authorized" };
    const { workspaceId, shareId } = authorized.share;
    const { channelWireId } = authorized.effectiveSelector;
    const principal = storage.getLinkPrincipal(connection.principalId);
    if (authorized.grant.generation !== connection.generation || shareId !== connection.shareId ||
        principal?.grantId !== connection.grantId) {
      return { ok: false, reason: "not-authorized" };
    }
    if (input.threadId !== null && storage.findThreadCreateChannelWireId(workspaceId, input.threadId) !== channelWireId) {
      return { ok: false, reason: "invalid-input" };
    }
    const { originId, messageId, threadId } = linkPostIds(principal.principalId, principal.profileTokenHash, input.idempotencyKey, input.threadId);
    const replay = replayedLinkPost(storage, workspaceId, { originId, messageId, threadId }, body);
    if (replay) {
      return replay === "conflict" ? { ok: false, reason: "idempotency-conflict" }
        : { ok: true, replayed: true, workspaceId, shareId, row: replay };
    }
    if (principal.blockedAtMs !== null) return { ok: false, reason: "blocked" };
    const paused = storage.db.prepare("SELECT link_writes_paused_at_ms FROM sync_relay_shares WHERE share_id = ?").get(shareId);
    if (paused?.link_writes_paused_at_ms != null) return { ok: false, reason: "paused" };
    const limited = linkPostLimitRefusal(storage, { workspaceId, shareId, principalId: principal.principalId, createdAtMs });
    if (limited) return { ok: false, reason: limited };
    const ops = linkPostOps(storage, { workspaceId, originId, messageId, threadId, createThread: input.threadId === null,
      channelWireId, body, createdAtMs, author: {
        authorKind: "link", authorDisplayName: agentName(connection.reportedName),
        linkGrantId: connection.grantId, linkPrincipalId: principal.principalId, agentConnectionId: connection.connectionId,
      } });
    const addedBytes = ops.reduce((bytes, op) => bytes + Buffer.byteLength(op.payloadJson), 0);
    if (workspaceUsageBytes(storage, workspaceId) + addedBytes > storage.options.workspaceQuotaBytes) {
      return { ok: false, reason: "workspace-quota" };
    }
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops });
    recordAgentConnectionActionInTransaction(storage, connection.connectionId, createdAtMs);
    const row = fetchChatMessage(storage, { workspaceId, originId, messageId });
    if (!row) throw new Error("appended agent post is missing");
    return { ok: true, replayed: false, workspaceId, shareId, row };
  });
}

/** The threads a link principal posted in. A lifetime limit bounds its posts. */
export function linkPrincipalThreadIds(storage: StorageContext, workspaceId: string, principalId: string): Set<string> {
  const rows = storage.db.prepare(`SELECT DISTINCT json_extract(payload_json, '$.threadId') AS thread_id FROM sync_relay_log
    WHERE workspace_id = ? AND origin_id = ? AND op_kind = 'chat.message.append'`).all(workspaceId, linkChatOrigin(principalId));
  return new Set(rows.map(row => String(row.thread_id)));
}
