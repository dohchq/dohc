import { handleForName, normalizeHandle, scanMentionTokens } from "@dohc/workspace-contracts/chat-mentions";
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
  return [...value.replace(/[\p{Cc}\p{Cf}<>]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, 80).join("") || fallback;
}

export function readPushMessage(storage: StorageContext, relaySeq: number): PushMessage | null {
  const row = storage.db.prepare(`SELECT workspace_id, payload_json, origin_id FROM sync_relay_log
    WHERE relay_seq = ? AND op_kind = 'chat.message.append' AND relay_admission IS NULL AND settlement_admission_json IS NULL`).get(relaySeq);
  if (!row) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!payload || typeof payload.threadId !== "string" || typeof payload.messageId !== "string" || typeof payload.body !== "string" ||
    !["human", "agent", "automation", "link"].includes(String(payload.authorKind))) return null;
  // Link authors have no account identity. Other ingress paths admit authorUserId before append.
  if (payload.authorKind === "link"
    ? typeof payload.linkPrincipalId !== "string" || row.origin_id !== linkChatOrigin(payload.linkPrincipalId)
    : typeof payload.authorUserId !== "string") return null;
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

export function pushChatResolver(storage: StorageContext, workspaceId: string): ChatShareThreadResolver {
  return {
    channelKind: id => storage.findChannelCreateKind(workspaceId, id),
    threadChannelWireId: id => storage.findThreadCreateChannelWireId(workspaceId, id),
    threadFileBinding: id => storage.findThreadCreateFileBinding(workspaceId, id),
    objectCurrentPath: id => storage.objectCurrentPath(workspaceId, id),
    objectIdAtPath: path => storage.objectIdAtPath(workspaceId, path),
  };
}

/** Returns a place label only through the recipient's current read authority. */
export function pushMessageAccess(storage: StorageContext, message: PushMessage, userId: string): {place: string; dm: boolean} | null {
  const {workspaceId, threadId} = message;
  if (accountIsFenced(storage, userId) || workspaceIsDeleted(storage, workspaceId)) return null;
  const resolver = pushChatResolver(storage, workspaceId);
  const channel = resolver.threadChannelWireId(threadId);
  if (storage.workspaceIsOwnedBy(workspaceId, userId)) {
    const binding = resolver.threadFileBinding(threadId);
    const filePath = binding?.kind === "object" ? resolver.objectCurrentPath(binding.objectId) :
      binding?.kind === "path" && resolver.objectIdAtPath(binding.path) ? binding.path : null;
    if (!channel && !filePath) return null;
    const row = channel ? storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id = ?
      AND op_kind = 'chat.channel.create' AND json_valid(payload_json) AND json_extract(payload_json, '$.wireId') = ?
      AND relay_admission IS NULL ORDER BY relay_seq LIMIT 1`).get(workspaceId, channel) : undefined;
    const name = row ? (JSON.parse(String(row.payload_json)) as {name?: unknown}).name : undefined;
    return {place: pushPlainText(name ?? filePath?.split("/").at(-1)?.replace(/\.md$/iu, ""), "a chat"),
      dm: Boolean(channel && resolver.channelKind(channel) === "dm")};
  }
  for (const row of storage.db.prepare(`SELECT DISTINCT s.share_id FROM sync_relay_shares s
    JOIN sync_relay_share_grants g USING (share_id) WHERE s.workspace_id = ?
    AND g.principal_user_id = ? AND g.status = 'active'`).all(workspaceId, userId)) {
    const authority = authorizeShareAction({storage, actorUserId: userId, shareId: String(row.share_id), action: "read"});
    if (!authority.ok || !filterOpForShare(authority.effectiveSelector, "chat.message.append", message.payloadJson, resolver).allowed) continue;
    return {place: pushPlainText(storage.getShareLabels(authority.share.shareId).subjectName, "a chat"),
      dm: Boolean(channel && resolver.channelKind(channel) === "dm")};
  }
  return null;
}

/** Reasons describe the accepted message; caller-provided recipient lists have no role. */
export function chatMessageInterest(storage: StorageContext, message: PushMessage, recipient: {userId: string; accountName: string}): ChatMessageReason | null {
  if (message.authorUserId === recipient.userId && message.authorKind !== "agent" && message.authorKind !== "automation") return null;
  const access = pushMessageAccess(storage, message, recipient.userId);
  if (!access) return null;
  const handle = normalizeHandle(handleForName(recipient.accountName));
  if (handle && scanMentionTokens(message.body, {ignoreCode: true}).some(token => normalizeHandle(token.handle) === handle)) return "mention";
  if (access.dm) return "dm";
  const prior = storage.db.prepare(`SELECT 1 FROM sync_relay_log WHERE workspace_id = ?
    AND op_kind = 'chat.message.append' AND json_valid(payload_json)
    AND json_extract(payload_json, '$.threadId') = ? AND relay_seq < ?
    AND json_extract(payload_json, '$.authorKind') = 'human' AND json_extract(payload_json, '$.authorUserId') = ?
    AND relay_admission IS NULL AND settlement_admission_json IS NULL LIMIT 1`)
    .get(message.workspaceId, message.threadId, message.relaySeq, recipient.userId);
  return prior ? "reply" : null;
}
