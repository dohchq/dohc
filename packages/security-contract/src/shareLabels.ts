// Display text only. Never use labels to resolve a share or authorize access.
export interface ShareLabels { subjectName: string | null }
export const SHARE_LABEL_MAX_CHARS = 160;
export function normalizeShareLabel(value: unknown, maxChars = SHARE_LABEL_MAX_CHARS): string | null {
  if (typeof value !== "string") return null;
  return Array.from(value.replace(/(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim()).slice(0, maxChars).join("") || null;
}
export function shareSubjectFallback(selector: unknown): string {
  const value = selector as {kind?: unknown; paths?: unknown} | null;
  if (value?.kind === "group" || value?.kind === "chat") return "a Group";
  if (Array.isArray(value?.paths) && value.paths.length) return value.paths.length > 1 ? "several items" : "a folder or file";
  return "a workspace";
}
export function shareAccessLabel(access: string): string {
  return ({view: "View", comment: "Comment", edit: "Edit", owner: "Owner", "read-only": "Read-only", "read-write": "Read-write"} as Record<string, string>)[access] ?? access;
}

export function shareSenderLabel(name: unknown, email: unknown): string {
  const address = normalizeShareLabel(email, 320);
  const label = normalizeShareLabel(name, 320);
  if (!address) return label ?? "the owner";
  if (!label || label === address) return address;
  if (label.endsWith("(" + address + ")")) return label;
  let boundedName = "";
  for (const character of label) {
    if (boundedName.length + character.length + address.length + 3 > 320) break;
    boundedName += character;
  }
  return boundedName ? boundedName + " (" + address + ")" : address;
}
