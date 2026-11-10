// What an agent reports about work it does outside dohc, such as a thread in
// another product or a pull request: where the work stands, and a link to it.
// dohc can't check either, so they are only ever shown as reported. A
// thread's Work card shows its newest report.
export const CHAT_WORK_STATUSES = ["working", "waiting", "done", "failed", "stopped"] as const;
export type ChatWorkStatus = (typeof CHAT_WORK_STATUSES)[number];
export type ChatWorkReport = { status: ChatWorkStatus; url?: string };

// The longest link, in characters.
export const MAX_WORK_URL_CHARS = 2048;

// A work report's link is a web address: `http://` or `https://` followed by
// printable ASCII with no space, so no character can draw it as another
// address. The engine applies the same rule.
export function isWorkUrl(value: string): boolean {
  return value.length <= MAX_WORK_URL_CHARS && /^https?:\/\/[\x21-\x7e]+$/.test(value);
}

export function isChatWorkStatus(value: unknown): value is ChatWorkStatus {
  return (CHAT_WORK_STATUSES as readonly unknown[]).includes(value);
}
