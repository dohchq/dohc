// Matches dohc-engine-domain chats::normalize_body, including JS trimEnd.
export function normalizeChatMessageBody(body: string): string {
  const normalized = body.replace(/\r\n?/gu, "\n").trimEnd();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 64 * 1024) {
    throw new Error("Message body is required.");
  }
  return normalized;
}
