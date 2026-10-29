import type { ChatAttachmentRecord, ChatFileReferenceInput } from "../../ipc/bridgeContract";
import { codeCover } from "@dohc/workspace-contracts/chat-mentions";

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

export interface ChatFileReferenceToken extends ChatFileReferenceInput {
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

export function extractChatFileReferences(body: string): ChatFileReferenceInput[] {
  const seen = new Set<string>();
  const references: ChatFileReferenceInput[] = [];
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

export function formatChatFileReferenceToken(input: ChatFileReferenceInput): string {
  return `@[${encodeReferenceComponent(input.path)}${
    input.headingAnchor ? `#${encodeReferenceComponent(input.headingAnchor)}` : ""
  }]`;
}

export interface FileMentionNavigationTarget {
  path: string;
  headingAnchor?: string;
}

export function fileReferenceKey(reference: {
  path: string;
  headingAnchor?: string;
}): string {
  return `${reference.path}\u0000${reference.headingAnchor ?? ""}`;
}

function sameHeading(
  token: Pick<ChatFileReferenceToken, "headingAnchor">,
  attachment: Pick<ChatAttachmentRecord, "headingAnchor">,
): boolean {
  return (token.headingAnchor ?? "") === (attachment.headingAnchor ?? "");
}

// Body text is immutable display copy, while attachment pathHint is the
// engine's authoritative, permission-checked navigation target. Most tokens
// match it exactly. Hand-typed compatibility forms can have edge spaces that
// main intentionally trims only after exact lookup. Reconcile unique
// references in two passes so exact space-named files always
// win, followed only by the explicit edge-space compatibility form. Never
// bind by heading/order alone: CLI callers can attach an independent file that
// happens to share a heading with a literal token in the message body.
export function resolveFileMentionNavigationTargets(
  tokens: readonly ChatFileReferenceToken[],
  attachments: readonly ChatAttachmentRecord[],
): Map<string, FileMentionNavigationTarget> {
  const references = Array.from(
    new Map(tokens.map((token) => [fileReferenceKey(token), token])).values(),
  );
  const available = attachments.filter(
    (attachment): attachment is ChatAttachmentRecord & { pathHint: string } =>
      typeof attachment.pathHint === "string" && attachment.pathHint.length > 0,
  );
  const unused = new Set(available.map((_, index) => index));
  const targets = new Map<string, FileMentionNavigationTarget>();

  const assign = (
    predicate: (
      token: ChatFileReferenceToken,
      attachment: ChatAttachmentRecord & { pathHint: string },
    ) => boolean,
  ) => {
    for (const token of references) {
      const key = fileReferenceKey(token);
      if (targets.has(key)) continue;
      const index = available.findIndex(
        (attachment, at) => unused.has(at) && predicate(token, attachment),
      );
      if (index < 0) continue;
      const attachment = available[index];
      if (!attachment) continue;
      unused.delete(index);
      targets.set(key, {
        path: attachment.pathHint,
        ...(attachment.headingAnchor
          ? { headingAnchor: attachment.headingAnchor }
          : {}),
      });
    }
  };

  assign(
    (token, attachment) =>
      attachment.pathHint === token.path && sameHeading(token, attachment),
  );
  assign(
    (token, attachment) =>
      token.path.trim() !== token.path &&
      attachment.pathHint === token.path.trim() &&
      sameHeading(token, attachment),
  );

  return targets;
}
