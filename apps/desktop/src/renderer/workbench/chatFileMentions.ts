import type { ChatAttachmentRecord, ChatFileReferenceInput } from "../../ipc/bridgeContract";
import { codeRanges } from "@dohc/workspace-contracts/chat-mentions";

const FILE_REFERENCE_RE = /@\[([^\]\r\n#]+?)(?:#([^\]\r\n]+))?\]/gu;

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

export function extractChatFileReferenceTokens(body: string): ChatFileReferenceToken[] {
  const tokens: ChatFileReferenceToken[] = [];
  const inertRanges = codeRanges(body);
  const inCode = (position: number) =>
    inertRanges.some(([start, end]) => position >= start && position < end);
  FILE_REFERENCE_RE.lastIndex = 0;
  for (let match = FILE_REFERENCE_RE.exec(body); match; match = FILE_REFERENCE_RE.exec(body)) {
    // A nested opener means the whole same-line construct is malformed. Do
    // not reinterpret the inner-looking text as a second attachment token.
    if (match[0].slice(2).includes("@[")) continue;
    if (inCode(match.index)) continue;
    const path = match[1] ? decodeReferenceComponent(match[1]) : undefined;
    // Edge spaces are legal filename bytes and the insertion formatter emits
    // them literally, so trim only to reject an empty/whitespace-only value.
    if (!path || !path.trim()) continue;
    const rawHeading = match[2];
    const hasHeading = rawHeading !== undefined;
    const headingAnchor = rawHeading !== undefined
      ? decodeReferenceComponent(rawHeading.trim())
      : undefined;
    // Keep heading normalization unchanged, but reject an explicitly present
    // heading delimiter whose value is empty after normalization.
    if (hasHeading && !headingAnchor) continue;
    tokens.push({
      path,
      ...(headingAnchor ? { headingAnchor } : {}),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
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
