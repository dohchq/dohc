// One limit and one refusal for every chat message, whoever sends it.
export const MAX_CHAT_MESSAGE_BODY_BYTES = 64 * 1024;
export const CHAT_MESSAGE_TOO_LONG = "The message is longer than 64 KiB. Shorten it.";

// Matches dohc-engine-domain chats::normalize_body, including JS trimEnd.
export function normalizeChatMessageBody(body: string): string {
  const normalized = body.replace(/\r\n?/gu, "\n").trimEnd();
  if (!normalized) {
    throw new Error("The message is empty. Enter a message.");
  }
  if (new TextEncoder().encode(normalized).byteLength > MAX_CHAT_MESSAGE_BODY_BYTES) {
    throw new Error(CHAT_MESSAGE_TOO_LONG);
  }
  return normalized;
}
