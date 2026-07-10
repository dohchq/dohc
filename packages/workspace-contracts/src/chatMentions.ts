// Pure @-mention scanning shared by storage/indexing and renderer surfaces.
// Keep this module dependency-free so every layer agrees on token boundaries
// and on which Markdown code ranges make a token inert.

export type MentionKind = "user" | "agent";

export interface MentionCandidate {
  id: string;
  kind: MentionKind;
  handle: string;
  label: string;
  description?: string;
}

export interface MentionToken {
  start: number;
  end: number;
  handle: string;
}

export interface ResolvedMention extends MentionToken {
  candidate: MentionCandidate;
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; candidate: MentionCandidate };

export interface MentionScanOptions {
  ignoreCode?: boolean;
}

// Keep the renderer scanner's original Unicode-aware ignore-case behavior,
// including JavaScript's case-fold equivalents for the a-z range.
const HANDLE_BODY = "[a-z0-9][a-z0-9._-]*";
const MENTION_RE = new RegExp(`(^|[\\s(\\[{])@(${HANDLE_BODY})`, "giu");
const TERMINAL_HANDLE_PUNCTUATION_RE = /[._-]+$/u;

function normalizeHandle(handle: string): string {
  return handle.normalize("NFC").toLowerCase();
}

// Character ranges [start, end) inside inline-code spans or fenced code
// blocks. This deliberately pragmatic scanner covers backtick spans and both
// ``` and ~~~ fences without taking a Markdown dependency.
export function codeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenceRe = /^[ \t]*(`{3,}|~{3,})/;
  let offset = 0;
  let openFence: { char: string; len: number; start: number } | null = null;
  for (const line of body.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const marker = fenceRe.exec(line)?.[1];
    if (!openFence) {
      if (marker) {
        openFence = { char: marker[0]!, len: marker.length, start: lineStart };
      }
    } else if (
      marker &&
      marker[0] === openFence.char &&
      marker.length >= openFence.len &&
      line.trim() === marker
    ) {
      ranges.push([openFence.start, lineEnd]);
      openFence = null;
    }
    offset = lineEnd + 1;
  }
  if (openFence) ranges.push([openFence.start, body.length]);

  const inFence = (position: number) =>
    ranges.some(([start, end]) => position >= start && position < end);
  const runRe = /`+/g;
  let open: { len: number; start: number } | null = null;
  for (let match = runRe.exec(body); match !== null; match = runRe.exec(body)) {
    if (inFence(match.index)) continue;
    const len = match[0].length;
    if (!open) {
      open = { len, start: match.index };
    } else if (len === open.len) {
      ranges.push([open.start, match.index + len]);
      open = null;
    }
  }
  return ranges;
}

// Candidate-agnostic source scanner used by the engine mention index and by
// renderer candidate resolution. Tokens are returned in document order.
export function scanMentionTokens(
  body: string,
  options: MentionScanOptions = {},
): MentionToken[] {
  const ranges = options.ignoreCode ? codeRanges(body) : [];
  const inCode = (position: number) =>
    ranges.some(([start, end]) => position >= start && position < end);
  const found: MentionToken[] = [];
  MENTION_RE.lastIndex = 0;
  for (let match = MENTION_RE.exec(body); match !== null; match = MENTION_RE.exec(body)) {
    const [, lead, handle = ""] = match;
    const start = match.index + (lead?.length ?? 0);
    if (inCode(start)) continue;
    const parsedHandle = handle.replace(TERMINAL_HANDLE_PUNCTUATION_RE, "");
    // "@..." / "@___" trims to nothing — a bare "@" is not a mention token.
    if (parsedHandle.length === 0) continue;
    found.push({ start, end: start + 1 + parsedHandle.length, handle: parsedHandle });
  }
  return found;
}

export function resolveMentionCandidate(
  handle: string,
  candidates: readonly MentionCandidate[],
): MentionCandidate | null {
  const wanted = normalizeHandle(handle);
  return candidates.find((candidate) => normalizeHandle(candidate.handle) === wanted) ?? null;
}

export function findMentions(
  body: string,
  candidates: readonly MentionCandidate[],
  options: MentionScanOptions = {},
): ResolvedMention[] {
  if (candidates.length === 0) return [];
  const found: ResolvedMention[] = [];
  for (const token of scanMentionTokens(body, options)) {
    const candidate = resolveMentionCandidate(token.handle, candidates);
    if (candidate) found.push({ ...token, candidate });
  }
  return found;
}

export function toMentionSegments(
  body: string,
  candidates: readonly MentionCandidate[],
  options: MentionScanOptions = {},
): MentionSegment[] {
  const mentions = findMentions(body, candidates, options);
  if (mentions.length === 0) return [{ type: "text", text: body }];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) {
      segments.push({ type: "text", text: body.slice(cursor, mention.start) });
    }
    segments.push({
      type: "mention",
      text: body.slice(mention.start, mention.end),
      candidate: mention.candidate,
    });
    cursor = mention.end;
  }
  if (cursor < body.length) segments.push({ type: "text", text: body.slice(cursor) });
  return segments;
}

export function mentionsAnyCandidate(
  body: string,
  candidates: readonly MentionCandidate[],
  options: MentionScanOptions = {},
): boolean {
  return findMentions(body, candidates, options).length > 0;
}

export interface ActiveMentionQuery {
  start: number;
  query: string;
}

export function activeMentionQuery(value: string, caret: number): ActiveMentionQuery | null {
  const clampedCaret = Math.max(0, Math.min(caret, value.length));
  let index = clampedCaret;
  while (index > 0) {
    const char = value[index - 1] ?? "";
    if (char === "@") {
      const before = index >= 2 ? value[index - 2] : undefined;
      if (before === undefined || /[\s(\[{]/u.test(before)) {
        const query = value.slice(index, clampedCaret);
        if (query.length === 0 || /^[a-z0-9._-]*$/iu.test(query)) {
          return { start: index - 1, query };
        }
      }
      return null;
    }
    if (!/[a-z0-9._-]/iu.test(char)) return null;
    index -= 1;
  }
  return null;
}

export function matchMentionCandidates(
  query: string,
  candidates: readonly MentionCandidate[],
  limit = 6,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  return candidates
    .map((candidate) => ({ candidate, score: candidateScore(needle, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
        left.candidate.label.localeCompare(right.candidate.label),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function kindRank(kind: MentionKind): number {
  return kind === "agent" ? 0 : 1;
}

function candidateScore(needle: string, candidate: MentionCandidate): number {
  if (needle.length === 0) return 1;
  const handle = candidate.handle.toLowerCase();
  const label = candidate.label.toLowerCase();
  if (handle === needle || label === needle) return 4;
  if (handle.startsWith(needle) || label.startsWith(needle)) return 3;
  if (handle.includes(needle) || label.includes(needle)) return 2;
  return 0;
}

export interface MentionCompletion {
  value: string;
  caret: number;
}

export function applyMentionCompletion(
  value: string,
  active: ActiveMentionQuery,
  candidate: MentionCandidate,
): MentionCompletion {
  const insert = `@${candidate.handle} `;
  const tokenEnd = active.start + 1 + active.query.length;
  const next = value.slice(0, active.start) + insert + value.slice(tokenEnd);
  return { value: next, caret: active.start + insert.length };
}
