import {
  chatMessageCandidates,
  chatMessageInterest,
  readPushMessage,
} from "../chatMessageInterest";
import type { StorageContext } from "./context";
import { noticeChatMessage } from "./notices";
import { recordPushDeliveries } from "./pushDeliveries";

/**
 * Alerts the people a new message is for: a push to their devices when the
 * relay sends pushes, and a Notice for a person's mention or reply. Both use
 * one candidate list. Runs inside the message append transaction, once per
 * message; no network work may enter here.
 */
export function recordChatMessageAlerts(
  storage: StorageContext,
  relaySeq: number,
  nowMs = Date.now(),
): void {
  const message = readPushMessage(storage, relaySeq);
  if (!message) return;
  const first = storage.db
    .prepare(`SELECT relay_seq FROM sync_relay_log WHERE workspace_id = ?
    AND op_kind = 'chat.message.append' AND json_valid(payload_json)
    AND json_extract(payload_json, '$.threadId') = ? AND json_extract(payload_json, '$.messageId') = ?
    AND relay_admission IS NULL ORDER BY relay_seq LIMIT 1`)
    .get(message.workspaceId, message.threadId, message.messageId);
  if (Number(first?.relay_seq) !== relaySeq) return;
  for (const candidate of chatMessageCandidates(storage, message)) {
    const interest = chatMessageInterest(storage, message, candidate);
    if (!interest) continue;
    if (storage.options.pushConfigured)
      recordPushDeliveries(storage, message, candidate.userId, interest.reason, nowMs);
    if (interest.reason !== "dm") {
      noticeChatMessage(storage, {
        message,
        recipientUserId: candidate.userId,
        reason: interest.reason,
        access: interest.access,
        nowMs,
      });
    }
  }
}
