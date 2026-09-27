// Display text only. Never use labels to resolve a share or authorize access.
export interface ShareLabels { subjectName: string | null; sharerName: string | null }
export const SHARE_LABEL_MAX_CHARS = 160;
export function normalizeShareLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Array.from(value.replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim()).slice(0, SHARE_LABEL_MAX_CHARS).join("") || null;
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
