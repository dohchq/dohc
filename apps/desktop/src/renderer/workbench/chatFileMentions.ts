import type { ChatFileReferenceInput } from "../../ipc/bridgeContract";
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
