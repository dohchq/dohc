import type { ChatFileReferenceInput } from "../../ipc/bridgeContract";

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
  FILE_REFERENCE_RE.lastIndex = 0;
  for (let match = FILE_REFERENCE_RE.exec(body); match; match = FILE_REFERENCE_RE.exec(body)) {
    const path = match[1] ? decodeReferenceComponent(match[1].trim()) : undefined;
    if (!path) continue;
    const headingAnchor = match[2]
      ? decodeReferenceComponent(match[2].trim())
      : undefined;
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
