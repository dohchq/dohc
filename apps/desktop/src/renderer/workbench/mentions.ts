// @-mentions for the local, individual-first chat (Agent Notifications &
// Mentions). Two directions share this one parser:
//   • the user @-mentions an agent (or themselves) in the composer, and
//   • an agent @-mentions the user in an authored message.
// Everything here is PURE so the composer autocomplete, the chip renderer,
// the "addressed to me" inbox, and the notification derivation can never
// drift on what counts as a mention.
//
// NOTE (shared-code seam): when the multi-user chat lanes land, this module is
// the natural home for member/agent handle resolution too. Keep it free of
// desktop-only imports so it can move to a shared package unchanged.

export type MentionKind = "user" | "agent";

export interface MentionCandidate {
  // Stable identity, e.g. "user:you" or "agent:default". Used as React keys
  // and for de-duping autocomplete matches.
  id: string;
  kind: MentionKind;
  // The @-token text WITHOUT the leading "@", lowercase, single word.
  handle: string;
  // Human label shown in the autocomplete row and the rendered chip.
  label: string;
  // Optional one-word hint ("you", "your agent") shown dimmed in autocomplete.
  description?: string;
}

export interface ResolvedMention {
  // Character offsets into the source body: [start, end) covers "@handle".
  start: number;
  end: number;
  // The raw handle as typed (original casing preserved for display).
  handle: string;
  candidate: MentionCandidate;
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; candidate: MentionCandidate };

// A handle is "@" + a word that starts with a letter/digit and may contain
// letters, digits, dot, hyphen, underscore. The "@" must sit at the start of
// the body or right after whitespace / an opening bracket — this is what keeps
// email addresses ("ice@dohc.app") from being read as mentions.
const HANDLE_BODY = "[a-z0-9][a-z0-9._-]*";
const MENTION_RE = new RegExp(`(^|[\\s(\\[{])@(${HANDLE_BODY})`, "giu");

function normalizeHandle(handle: string): string {
  return handle.normalize("NFC").toLowerCase();
}

// Case-insensitive exact match on a candidate's handle. Unknown handles never
// resolve, so a stray "@todo" stays plain text — only real people/agents light
// up, which keeps the mention affordance honest.
export function resolveMentionCandidate(
  handle: string,
  candidates: readonly MentionCandidate[],
): MentionCandidate | null {
  const wanted = normalizeHandle(handle);
  return candidates.find((candidate) => normalizeHandle(candidate.handle) === wanted) ?? null;
}

// All resolved mentions in a body, in document order. Only mentions that map
// to a known candidate are returned.
export function findMentions(
  body: string,
  candidates: readonly MentionCandidate[],
): ResolvedMention[] {
  if (candidates.length === 0) return [];
  const found: ResolvedMention[] = [];
  MENTION_RE.lastIndex = 0;
  for (let match = MENTION_RE.exec(body); match !== null; match = MENTION_RE.exec(body)) {
    const [, lead, handle] = match;
    const candidate = resolveMentionCandidate(handle ?? "", candidates);
    if (!candidate) continue;
    const start = match.index + (lead?.length ?? 0);
    found.push({ start, end: start + 1 + (handle?.length ?? 0), handle: handle ?? "", candidate });
  }
  return found;
}

// Splits a body into text/mention segments for rendering chips. Text between
// and around mentions is preserved verbatim (whitespace included) so the chip
// renderer can rebuild the message exactly.
export function toMentionSegments(
  body: string,
  candidates: readonly MentionCandidate[],
): MentionSegment[] {
  const mentions = findMentions(body, candidates);
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

// True when a body @-mentions any of the given candidates (used to decide
// whether an agent message is "addressed to me").
export function mentionsAnyCandidate(
  body: string,
  candidates: readonly MentionCandidate[],
): boolean {
  return findMentions(body, candidates).length > 0;
}

// --- composer autocomplete --------------------------------------------------

export interface ActiveMentionQuery {
  // Offset of the "@" that begins the token the caret sits in.
  start: number;
  // The typed characters after "@" up to the caret (may be empty right after
  // typing "@").
  query: string;
}

// Finds the mention token the caret is currently editing, if any. The token is
// the run of handle characters immediately before the caret, anchored by an
// "@" that sits at a valid boundary. Returns null when the caret is not inside
// a mention (so the autocomplete menu stays closed).
export function activeMentionQuery(value: string, caret: number): ActiveMentionQuery | null {
  const clampedCaret = Math.max(0, Math.min(caret, value.length));
  // Walk back over handle characters to find the "@".
  let index = clampedCaret;
  while (index > 0) {
    const char = value[index - 1] ?? "";
    if (char === "@") {
      const before = index >= 2 ? value[index - 2] : undefined;
      // Boundary check: "@" starts the value or follows whitespace/bracket.
      if (before === undefined || /[\s(\[{]/u.test(before)) {
        const query = value.slice(index, clampedCaret);
        // Everything between "@" and the caret must be valid handle chars.
        if (query.length === 0 || /^[a-z0-9._-]*$/iu.test(query)) {
          return { start: index - 1, query };
        }
      }
      return null;
    }
    // Stop as soon as we hit a non-handle character before finding "@".
    if (!/[a-z0-9._-]/iu.test(char)) return null;
    index -= 1;
  }
  return null;
}

// Ranks candidates for an autocomplete query. Empty query lists everyone
// (handle/label prefix matches first, then substring matches), so pressing "@"
// alone reveals the full, short roster.
export function matchMentionCandidates(
  query: string,
  candidates: readonly MentionCandidate[],
  limit = 6,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const scored = candidates
    .map((candidate) => ({ candidate, score: candidateScore(needle, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // In a chat composer the agent is the likelier target, so on a tie it
        // sorts ahead of the user; labels break any remaining tie.
        kindRank(a.candidate.kind) - kindRank(b.candidate.kind) ||
        a.candidate.label.localeCompare(b.candidate.label),
    );
  return scored.slice(0, limit).map((entry) => entry.candidate);
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

// Replaces the active mention token with the chosen candidate's handle plus a
// trailing space, and reports where the caret should land (after the space).
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
