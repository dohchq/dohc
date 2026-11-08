import { nameByteLength } from "./names";
// Pure @-mention scanning shared by storage/indexing and renderer surfaces.
// Every layer uses the same token boundaries, ignored Markdown code ranges
// and file links.

type MentionKind = "user" | "agent";

export interface MentionCandidate {
  id: string;
  kind: MentionKind;
  handle: string;
  label: string;
  description?: string;
}

interface MentionToken {
  start: number;
  end: number;
  handle: string;
}

interface ResolvedMention extends MentionToken {
  candidate: MentionCandidate;
}

interface MentionScanOptions {
  ignoreCode?: boolean;
}

const HANDLE_BODY = "[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}._-]*";
const MENTION_RE = new RegExp(`(^|[\\s(\\[{])@(${HANDLE_BODY})`, "gu");
const TERMINAL_HANDLE_PUNCTUATION_RE = /[._-]+$/u;

export function normalizeHandle(handle: string): string {
  return handle.normalize("NFC").toLowerCase().normalize("NFC");
}

// The handle a name gets, so the scanner reads "@" and it back in full: the
// name's handle characters, from its first letter or number, without the
// punctuation a handle cannot end with. "" when the name has none.
export function handleForName(name: string): string {
  const handle = name
    .replace(/[^\p{L}\p{N}\p{M}._-]/gu, "")
    .replace(/^[\p{M}._-]+/u, "")
    .replace(TERMINAL_HANDLE_PUNCTUATION_RE, "");
  return nameByteLength(normalizeHandle(handle)) > 200 ? "" : handle;
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

  // Fences are in order and runs come in order, so one pointer finds each
  // run's fence.
  const fences = ranges.length;
  let fence = 0;
  const inFence = (position: number) => {
    while (fence < fences && ranges[fence]![1] <= position) fence++;
    return fence < fences && ranges[fence]![0] <= position;
  };
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

// For positions asked in ascending order: whether each is inside code. Each
// call moves forward through the ranges, so a whole scan reads them once.
export function codeCover(body: string): (position: number) => boolean {
  const ranges = codeRanges(body).sort((a, b) => a[0] - b[0]);
  let next = 0;
  let end = -1;
  return (position) => {
    while (next < ranges.length && ranges[next]![0] <= position) end = Math.max(end, ranges[next++]![1]);
    return position < end;
  };
}

// Candidate-agnostic source scanner used by the engine mention index and by
// renderer candidate resolution. Tokens are returned in document order.
export function scanMentionTokens(
  body: string,
  options: MentionScanOptions = {},
): MentionToken[] {
  const inCode = options.ignoreCode ? codeCover(body) : () => false;
  const found: MentionToken[] = [];
  MENTION_RE.lastIndex = 0;
  for (let match = MENTION_RE.exec(body); match !== null; match = MENTION_RE.exec(body)) {
    const [, lead, handle = ""] = match;
    const start = match.index + (lead?.length ?? 0);
    if (inCode(start)) continue;
    const parsedHandle = handle.replace(TERMINAL_HANDLE_PUNCTUATION_RE, "");
    // "@..." / "@___" trims to nothing — a bare "@" is not a mention token.
    if (parsedHandle.length === 0 || nameByteLength(normalizeHandle(parsedHandle)) > 200) continue;
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

export function mentionsAnyCandidate(
  body: string,
  candidates: readonly MentionCandidate[],
  options: MentionScanOptions = {},
): boolean {
  return findMentions(body, candidates, options).length > 0;
}

function encodeReferenceComponent(value: string): string {
  // Keep ordinary paths human-readable while escaping the token grammar's
  // delimiters. Percent is escaped first so decoding remains one-pass and a
  // literal "%23" filename can never turn into "#" accidentally.
  return value.replace(/%/gu, "%25").replace(/#/gu, "%23").replace(/\]/gu, "%5D");
}

function decodeReferenceComponent(value: string): string {
  return value.replace(/%(23|5d|25)/giu, (escape) => {
    switch (escape.toLocaleLowerCase()) {
      case "%23":
        return "#";
      case "%5d":
        return "]";
      default:
        return "%";
    }
  });
}

// A file link in a chat message: its path and, when it has one, its heading.
export interface ChatFileReference {
  path: string;
  headingAnchor?: string;
}

export interface ChatFileReferenceToken extends ChatFileReference {
  start: number;
  end: number;
  text: string;
}

// The tokens `@[path]` and `@[path#heading]` outside code, in order: a path
// with no "#", then an optional "#" and a heading, neither empty, and no "]"
// or line break before the closing "]". It reads one opener at a time from
// the end of the last token, as a regular expression would, but every check
// at an opener is a lookup into arrays built in one backward pass, so its
// time grows linearly with the body.
export function extractChatFileReferenceTokens(body: string): ChatFileReferenceToken[] {
  const tokens: ChatFileReferenceToken[] = [];
  if (!body.includes("@[")) return tokens;
  const length = body.length;
  // From each index: the next "]" or line break, the next "#", and the next "@[".
  const stopAt = new Int32Array(length + 1);
  const hashAt = new Int32Array(length + 1);
  const openerAt = new Int32Array(length + 1);
  stopAt[length] = hashAt[length] = openerAt[length] = length;
  for (let at = length - 1; at >= 0; at--) {
    const char = body[at];
    stopAt[at] = char === "]" || char === "\r" || char === "\n" ? at : stopAt[at + 1]!;
    hashAt[at] = char === "#" ? at : hashAt[at + 1]!;
    openerAt[at] = char === "@" && body[at + 1] === "[" ? at : openerAt[at + 1]!;
  }
  const inCode = codeCover(body);
  for (let start = openerAt[0]!; start < length; ) {
    const from = start + 2;
    const stop = stopAt[from]!;
    const hash = hashAt[from]!;
    // The path runs to the first "#"; a heading after it is not empty.
    const matched = stop < length && body[stop] === "]" && stop > from && hash > from && (hash >= stop || stop > hash + 1);
    if (!matched) {
      start = openerAt[start + 1]!;
      continue;
    }
    const end = stop + 1;
    const next = openerAt[end]!;
    // A nested opener means the whole same-line construct is malformed. Do
    // not reinterpret the inner-looking text as a second attachment token.
    if (openerAt[from]! + 1 < stop || inCode(start)) {
      start = next;
      continue;
    }
    const path = decodeReferenceComponent(body.slice(from, Math.min(hash, stop)));
    // Edge spaces are legal filename bytes and the insertion formatter emits
    // them literally, so trim only to reject an empty/whitespace-only value.
    const rawHeading = hash < stop ? body.slice(hash + 1, stop) : undefined;
    const headingAnchor = rawHeading !== undefined ? decodeReferenceComponent(rawHeading.trim()) : undefined;
    // Keep heading normalization unchanged, but reject an explicitly present
    // heading delimiter whose value is empty after normalization.
    if (path.trim() && (rawHeading === undefined || headingAnchor)) {
      tokens.push({
        path,
        ...(headingAnchor ? { headingAnchor } : {}),
        start,
        end,
        text: body.slice(start, end),
      });
    }
    start = next;
  }
  return tokens;
}

// Chat reads an @ name outside code and outside file links. A file link owns
// its whole range, so a name inside a file's name names no one. The desktop's
// send and the relay read names with chatMentionTokens, and chat views with
// chatMentions, so the agents and people a message names are the mentions it
// shows.
export function chatMentionTokens(
  body: string,
  fileTokens: readonly ChatFileReferenceToken[] = extractChatFileReferenceTokens(body),
) {
  return outsideFileLinks(scanMentionTokens(body, { ignoreCode: true }), fileTokens);
}

export function chatMentions(
  body: string,
  candidates: readonly MentionCandidate[],
  fileTokens: readonly ChatFileReferenceToken[] = extractChatFileReferenceTokens(body),
) {
  return outsideFileLinks(findMentions(body, candidates, { ignoreCode: true }), fileTokens);
}

// Mentions and file links both come in source order, so one walk drops
// each mention that overlaps a link.
function outsideFileLinks<Mention extends { start: number; end: number }>(
  mentions: Mention[],
  fileTokens: readonly ChatFileReferenceToken[],
): Mention[] {
  let link = 0;
  return mentions.filter(({ start, end }) => {
    while (link < fileTokens.length && fileTokens[link]!.end <= start) link++;
    return !(link < fileTokens.length && fileTokens[link]!.start < end);
  });
}

export function extractChatFileReferences(body: string): ChatFileReference[] {
  const seen = new Set<string>();
  const references: ChatFileReference[] = [];
  for (const token of extractChatFileReferenceTokens(body)) {
    const key = `${token.path}\0${token.headingAnchor ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      path: token.path,
      ...(token.headingAnchor ? { headingAnchor: token.headingAnchor } : {}),
    });
  }
  return references;
}

export function formatChatFileReferenceToken(input: ChatFileReference): string {
  return `@[${encodeReferenceComponent(input.path)}${
    input.headingAnchor ? `#${encodeReferenceComponent(input.headingAnchor)}` : ""
  }]`;
}

interface ActiveMentionQuery {
  start: number;
  query: string;
}

export function activeMentionQuery(value: string, caret: number): ActiveMentionQuery | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const match = /(^|[\s(\[{])@([\p{L}\p{N}\p{M}._-]*)$/u.exec(before);
  if (!match || nameByteLength(normalizeHandle(match[2]!)) > 200) return null;
  return { start: match.index + match[1]!.length, query: match[2]! };
}

export function matchMentionCandidates(
  query: string,
  candidates: readonly MentionCandidate[],
  limit = 6,
): MentionCandidate[] {
  const needle = normalizeHandle(query.trim());
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
  const handle = normalizeHandle(candidate.handle);
  const label = normalizeHandle(candidate.label);
  if (handle === needle || label === needle) return 4;
  if (handle.startsWith(needle) || label.startsWith(needle)) return 3;
  if (handle.includes(needle) || label.includes(needle)) return 2;
  return 0;
}

interface MentionCompletion {
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
