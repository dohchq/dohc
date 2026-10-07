// Matches dohc-engine-domain chats::normalize_body, including JS trimEnd.
export function normalizeChatMessageBody(body: string): string {
  const normalized = body.replace(/\r\n?/gu, "\n").trimEnd();
  if (!normalized) {
    throw new Error("The message is empty. Enter a message.");
  }
  if (new TextEncoder().encode(normalized).byteLength > 64 * 1024) {
    throw new Error("The message is longer than 64 KiB. Shorten it.");
  }
  return normalized;
}
