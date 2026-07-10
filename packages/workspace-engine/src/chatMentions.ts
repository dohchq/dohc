import { scanMentionTokens } from "@dohc/workspace-contracts/chat-mentions";

export function parseMentionHandles(body: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const token of scanMentionTokens(body, { ignoreCode: true })) {
    const handle = token.handle.normalize("NFC").toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
  }
  return handles;
}
