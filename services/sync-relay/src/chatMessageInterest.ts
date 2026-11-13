import { chatMentionTokens, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import { authorizeShareAction } from "./shareAuthorization";
import { linkChatOrigin } from "./relayLogInputs";
import { filterOpForShare, type ChatShareThreadResolver } from "./shareFilter";
import { accountIsFenced, workspaceIsDeleted } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";

export type ChatMessageReason = "mention" | "dm" | "reply";
export interface PushMessage {
  workspaceId: string;
  threadId: string;
  messageId: string;
  relaySeq: number;
  payloadJson: string;
  authorUserId: string | null;
  authorKind: string;
  senderLabel: string;
  body: string;
}

export function pushPlainText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) return fallback;
  return (
    [
      ...value
        .replace(/[\p{Cc}\p{Cf}<>]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
    ]
      .slice(0, 80)
      .join("") || fallback
  );
}

export function readPushMessage(storage: StorageContext, relaySeq: number): PushMessage | null {
  const row = storage.db
    .prepare(`SELECT workspace_id, payload_json, origin_id FROM sync_relay_log
    WHERE relay_seq = ? AND op_kind = 'chat.message.append' AND relay_admission IS NULL AND settlement_admission_json IS NULL`)
    .get(relaySeq);
  if (!row) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.threadId !== "string" ||
    typeof payload.messageId !== "string" ||
    typeof payload.body !== "string" ||
    !["human", "agent", "automation", "link"].includes(String(payload.authorKind))
  )
    return null;
  // Link authors have no account identity. Other ingress paths admit authorUserId before append.
  if (
    payload.authorKind === "link"
      ? typeof payload.linkPrincipalId !== "string" ||
        row.origin_id !== linkChatOrigin(payload.linkPrincipalId)
      : typeof payload.authorUserId !== "string"
  )
    return null;
  return {
    workspaceId: String(row.workspace_id),
    threadId: payload.threadId,
    messageId: payload.messageId,
    relaySeq,
    payloadJson: String(row.payload_json),
    body: payload.body,
    authorKind: String(payload.authorKind),
    authorUserId: payload.authorKind === "link" ? null : String(payload.authorUserId),
    senderLabel: pushPlainText(payload.authorDisplayName, "Someone"),
  };
}

export function pushChatResolver(
  storage: StorageContext,
  workspaceId: string,
): ChatShareThreadResolver {
  return {
    channelKind: (id) => storage.findChannelCreateKind(workspaceId, id),
    threadChannelWireId: (id) => storage.findThreadCreateChannelWireId(workspaceId, id),
    threadFileBinding: (id) => storage.findThreadCreateFileBinding(workspaceId, id),
    objectCurrentPath: (id) => storage.objectCurrentPath(workspaceId, id),
    objectIdAtPath: (path) => storage.objectIdAtPath(workspaceId, path),
  };
}

export interface ChatMessageAccess {
  /** The Group, chat or file the message is in, as the recipient may call it. */
  place: string;
  /** True when the place is a chat channel rather than a file's comments. */
  channel: boolean;
  dm: boolean;
  /** The share the recipient reads the message through, or null for the owner. */
  shareId: string | null;
}

// The channel's name, or the name of the file the thread is on. Null when
// the thread has neither.
function chatPlace(
  storage: StorageContext,
  message: PushMessage,
  resolver: ChatShareThreadResolver,
): { place: string; channel: boolean } | null {
  const { workspaceId, threadId } = message;
  const channel = resolver.threadChannelWireId(threadId);
  const binding = resolver.threadFileBinding(threadId);
  const filePath =
    binding?.kind === "object"
      ? resolver.objectCurrentPath(binding.objectId)
      : binding?.kind === "path" && resolver.objectIdAtPath(binding.path)
        ? binding.path
        : null;
  if (!channel && !filePath) return null;
  const row = channel
    ? storage.db
        .prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id = ?
    AND op_kind = 'chat.channel.create' AND json_valid(payload_json) AND json_extract(payload_json, '$.wireId') = ?
    AND relay_admission IS NULL ORDER BY relay_seq LIMIT 1`)
        .get(workspaceId, channel)
    : undefined;
  const name = row ? (JSON.parse(String(row.payload_json)) as { name?: unknown }).name : undefined;
  return {
    place: pushPlainText(name ?? filePath?.split("/").at(-1)?.replace(/\.md$/iu, ""), "a chat"),
    channel: Boolean(channel),
  };
}

/** Returns a place label only through the recipient's current read authority. */
export function pushMessageAccess(
  storage: StorageContext,
  message: PushMessage,
  userId: string,
): ChatMessageAccess | null {
  const { workspaceId, threadId } = message;
  if (accountIsFenced(storage, userId) || workspaceIsDeleted(storage, workspaceId)) return null;
  const resolver = pushChatResolver(storage, workspaceId);
  const channel = resolver.threadChannelWireId(threadId);
  const dm = Boolean(channel && resolver.channelKind(channel) === "dm");
  if (storage.workspaceIsOwnedBy(workspaceId, userId)) {
    const found = chatPlace(storage, message, resolver);
    return found && { ...found, dm, shareId: null };
  }
  // A membership comes first and names the Group or file as the member
  // sees them, so a member reads the message where they read the workspace.
  for (const row of storage.db
    .prepare(`SELECT DISTINCT s.share_id, json_extract(s.selector_json, '$.kind') = 'workspace' AS membership
    FROM sync_relay_shares s JOIN sync_relay_share_grants g USING (share_id) WHERE s.workspace_id = ?
    AND g.principal_user_id = ? AND g.status = 'active' ORDER BY membership DESC`)
    .all(workspaceId, userId)) {
    const authority = authorizeShareAction({
      storage,
      actorUserId: userId,
      shareId: String(row.share_id),
      action: "read",
    });
    if (
      !authority.ok ||
      !filterOpForShare(
        authority.effectiveSelector,
        "chat.message.append",
        message.payloadJson,
        resolver,
      ).allowed
    )
      continue;
    const found = Number(row.membership) === 1 ? chatPlace(storage, message, resolver) : null;
    return {
      place:
        found?.place ??
        pushPlainText(storage.getShareLabels(authority.share.shareId, "member").subjectName, "a chat"),
      channel: found?.channel ?? Boolean(channel),
      dm,
      shareId: authority.share.shareId,
    };
  }
  return null;
}

const MENTIONED_HANDLES_MAX = 20;
const ACCOUNTS_PER_HANDLE_MAX = 20;
const DM_PARTICIPANTS_MAX = 20;
const THREAD_AUTHORS_MAX = 50;

export interface ChatMessageCandidate {
  userId: string;
  mentioned: boolean;
  threadAuthor: boolean;
}

/**
 * The only people a message can alert, by push or by Notice: accounts in the
 * workspace whose handle it mentions, earlier human authors in its thread,
 * and a direct message's participants. Never the human author, and never an
 * agent, which has no account of its own. The work is bounded by mentions
 * and thread authors, never by the number of members.
 */
export function chatMessageCandidates(
  storage: StorageContext,
  message: PushMessage,
): ChatMessageCandidate[] {
  const { workspaceId, threadId } = message;
  const candidates = new Map<string, ChatMessageCandidate>();
  const candidate = (userId: string) => {
    let found = candidates.get(userId);
    if (!found) candidates.set(userId, (found = { userId, mentioned: false, threadAuthor: false }));
    return found;
  };
  const handles = [
    ...new Set(chatMentionTokens(message.body).map((token) => normalizeHandle(token.handle))),
  ].slice(0, MENTIONED_HANDLES_MAX);
  const named = storage.db
    .prepare(`SELECT n.user_id FROM sync_relay_account_names n WHERE n.handle = ? AND (
    n.user_id = (SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?) OR EXISTS (
      SELECT 1 FROM sync_relay_share_grants g JOIN sync_relay_shares s USING (share_id)
      WHERE g.principal_user_id = n.user_id AND g.principal_kind = 'user' AND g.status = 'active' AND s.workspace_id = ?))
    LIMIT ?`);
  for (const handle of handles) {
    for (const row of named.all(handle, workspaceId, workspaceId, ACCOUNTS_PER_HANDLE_MAX))
      candidate(String(row.user_id)).mentioned = true;
  }
  const channel = storage.findThreadCreateChannelWireId(workspaceId, threadId);
  if (channel && storage.findChannelCreateKind(workspaceId, channel) === "dm") {
    const owner = storage.db
      .prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?")
      .get(workspaceId);
    if (owner) candidate(String(owner.owner_user_id));
    for (const row of storage.db
      .prepare(`SELECT DISTINCT g.principal_user_id FROM sync_relay_share_grants g
      JOIN sync_relay_shares s USING (share_id) WHERE s.workspace_id = ? AND json_valid(s.selector_json)
      AND json_extract(s.selector_json, '$.channelWireId') = ? AND g.status = 'active' AND g.principal_kind = 'user'
      LIMIT ?`)
      .all(workspaceId, channel, DM_PARTICIPANTS_MAX))
      candidate(String(row.principal_user_id));
  }
  // Steps through the thread's distinct authors on the participation index,
  // so a long thread costs one seek per author, not one row per message.
  const nextAuthor = storage.db
    .prepare(`SELECT json_extract(payload_json, '$.authorUserId') AS user_id FROM sync_relay_log
    WHERE workspace_id = ? AND op_kind = 'chat.message.append' AND json_valid(payload_json)
    AND json_extract(payload_json, '$.threadId') = ? AND json_extract(payload_json, '$.authorUserId') > ?
    ORDER BY json_extract(payload_json, '$.authorUserId') LIMIT 1`);
  const wroteBefore = storage.db.prepare(`SELECT 1 FROM sync_relay_log WHERE workspace_id = ?
    AND op_kind = 'chat.message.append' AND json_valid(payload_json)
    AND json_extract(payload_json, '$.threadId') = ? AND json_extract(payload_json, '$.authorUserId') = ?
    AND json_extract(payload_json, '$.authorKind') = 'human' AND relay_seq < ?
    AND relay_admission IS NULL AND settlement_admission_json IS NULL LIMIT 1`);
  let author = "";
  for (let seen = 0; seen < THREAD_AUTHORS_MAX; seen++) {
    const row = nextAuthor.get(workspaceId, threadId, author);
    if (typeof row?.user_id !== "string") break;
    author = row.user_id;
    if (wroteBefore.get(workspaceId, threadId, author, message.relaySeq))
      candidate(author).threadAuthor = true;
  }
  if (message.authorKind === "human" && message.authorUserId)
    candidates.delete(message.authorUserId);
  return [...candidates.values()];
}

/** Why a candidate hears about the message, checked against what they may read now. */
export function chatMessageInterest(
  storage: StorageContext,
  message: PushMessage,
  candidate: ChatMessageCandidate,
): { reason: ChatMessageReason; access: ChatMessageAccess } | null {
  if (
    message.authorUserId === candidate.userId &&
    message.authorKind !== "agent" &&
    message.authorKind !== "automation"
  )
    return null;
  const access = pushMessageAccess(storage, message, candidate.userId);
  if (!access) return null;
  const reason = candidate.mentioned
    ? "mention"
    : access.dm
      ? "dm"
      : candidate.threadAuthor
        ? "reply"
        : null;
  return reason && { reason, access };
}
