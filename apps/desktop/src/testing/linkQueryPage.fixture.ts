import type { LinksInResult } from "@dohc/workspace-contracts/links";
export type BacklinksFixture = { sources: { sourcePath: string; sourceTitle: string; snippets: { text: string; line: number; highlightStart: number; highlightEnd: number }[] }[] };
export function linkQueryPage(result: BacklinksFixture): NonNullable<LinksInResult> {
  return { versionId: "main", subject: { path: "target.md", objectId: "target" }, entries: result.sources.flatMap(source => source.snippets.map((snippet, ordinal) => ({ source: source.sourcePath, title: source.sourceTitle, ordinal, span: [0, 1] as [number, number], line: snippet.line, snippet: snippet.text, highlightStart: snippet.highlightStart, highlightEnd: snippet.highlightEnd }))), unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, nextCursor: null };
}
