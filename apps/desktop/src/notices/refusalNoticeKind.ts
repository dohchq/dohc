export function isRefusalNoticeKind(kind: string): boolean {
  return kind === "sync-refusal" || kind === "markdown-write-held";
}
