export interface WorkspaceHeading {
  text: string;
  level: number;
  anchor: string;
  occurrence: number;
  line: number;
  startOffset: number;
  contentStartOffset: number;
  endOffset: number;
}

interface PendingHeading extends Omit<WorkspaceHeading, "anchor" | "occurrence" | "endOffset"> {}

function visibleHeadingText(value: string): string {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\\([\\`*{}\[\]#+\-.!_>~|<])/g, "$1")
    .trim();
}

// Matches GitHub-style heading anchors closely enough for the Markdown forms
// dohc emits: lower-case, punctuation removed, whitespace collapsed to '-'.
// Unicode letters and numbers remain readable instead of being transliterated.
export function headingAnchorBase(text: string): string {
  const visible = visibleHeadingText(text).normalize("NFC").toLocaleLowerCase();
  const slug = visible
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-");
  if (slug) return slug;

  // Emoji- and punctuation-only headings are still valid Markdown headings.
  // Give them a deterministic, non-empty identity instead of the empty anchor;
  // duplicates continue through the normal `-1`, `-2`, ... occurrence path.
  let hash = 0x811c9dc5;
  for (const character of visible) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return visible ? `section-${(hash >>> 0).toString(36)}` : "section";
}

function lineRecords(markdown: string): Array<{ text: string; line: number; offset: number; end: number }> {
  const records: Array<{ text: string; line: number; offset: number; end: number }> = [];
  let offset = 0;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const newlineLength = markdown.startsWith("\r\n", offset + text.length) ? 2 :
      markdown.startsWith("\n", offset + text.length) ? 1 : 0;
    records.push({ text, line: index + 1, offset, end: offset + text.length + newlineLength });
    offset += text.length + newlineLength;
  }
  return records;
}

function canBeSetextHeadingText(value: string): boolean {
  // A setext underline can only promote paragraph text. Lines that already
  // open another block (a quote or list item) are not paragraph text at this
  // level, so treating them as headings would invent headings for common
  // `- item\n---` and `> quote\n---` sequences.
  return !/^[ \t]{0,3}(?:>|[-+*](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$))/u.test(value);
}

export function extractWorkspaceHeadings(markdown: string): WorkspaceHeading[] {
  const lines = lineRecords(markdown);
  const pending: PendingHeading[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const row = lines[index]!;
    const fenceMatch = row.text.match(/^[ \t]{0,3}([`~]{3,})/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(row.text)) continue;

    const atx = row.text.match(
      /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/,
    );
    if (atx?.[1] && atx[2]) {
      const text = visibleHeadingText(atx[2]);
      if (text) {
        pending.push({
          text,
          level: atx[1].length,
          line: row.line,
          startOffset: row.offset,
          contentStartOffset: row.end,
        });
      }
      continue;
    }

    const underline = lines[index + 1];
    if (
      !underline ||
      row.text.trim().length === 0 ||
      !canBeSetextHeadingText(row.text)
    ) continue;
    const setext = underline.text.match(/^[ \t]{0,3}(=+|-+)[ \t]*$/);
    if (!setext?.[1]) continue;
    const text = visibleHeadingText(row.text.trim());
    if (!text) continue;
    pending.push({
      text,
      level: setext[1][0] === "=" ? 1 : 2,
      line: row.line,
      startOffset: row.offset,
      contentStartOffset: underline.end,
    });
    index += 1;
  }

  const counts = new Map<string, number>();
  return pending.map((heading, index) => {
    const base = headingAnchorBase(heading.text);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    const nextBoundary = pending
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level)?.startOffset;
    return {
      ...heading,
      anchor: occurrence === 0 ? base : `${base}-${occurrence}`,
      occurrence,
      endOffset: nextBoundary ?? markdown.length,
    };
  });
}

export function findWorkspaceHeading(
  headings: readonly WorkspaceHeading[],
  input: { anchor?: string; text?: string; occurrence?: number },
): WorkspaceHeading | null {
  const decodedAnchor = input.anchor
    ? (() => {
        try {
          return decodeURIComponent(input.anchor);
        } catch {
          return input.anchor;
        }
      })()
    : undefined;
  if (decodedAnchor) {
    const exact = headings.find((heading) => heading.anchor === decodedAnchor);
    if (exact) return exact;
  }
  if (input.text) {
    const normalized = input.text.trim().toLocaleLowerCase();
    const matches = headings.filter(
      (heading) => heading.text.trim().toLocaleLowerCase() === normalized,
    );
    return matches[input.occurrence ?? 0] ?? null;
  }
  return null;
}

export function workspaceHeadingSection(markdown: string, heading: WorkspaceHeading): string {
  return markdown.slice(heading.startOffset, heading.endOffset).trimEnd();
}
