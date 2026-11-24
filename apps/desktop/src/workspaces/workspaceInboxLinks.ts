import { dump } from "js-yaml";
import type { Definition, Image, Link, Nodes as MdNodes, Root as MdRoot } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { INBOX_COLLECTION_PATH, isInboxAttachmentPath } from "@dohc/workspace-contracts/inbox";

const markdownParser = unified().use(remarkParse);

interface DestinationSpan {
  start: number;
  end: number;
  url: string;
}

function splitMarkdownFrontmatter(markdown: string): {
  open: string;
  yamlBlock: string;
  close: string;
  body: string;
} | null {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u.exec(markdown);
  if (!match) return null;
  return {
    open: match[1]!,
    yamlBlock: match[2]!,
    close: match[3]!,
    body: markdown.slice(match[0].length),
  };
}

function encodeMarkdownTarget(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/\(/gu, "%28").replace(/\)/gu, "%29"))
    .join("/");
}

function decodeMarkdownTarget(encoded: string): string | null {
  try {
    return encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function parseCommonMarkDestination(
  rawSlice: string,
  kind: "inline" | "definition",
): string | null {
  if (!rawSlice || /[\r\n]/u.test(rawSlice)) return null;
  if (kind === "definition") {
    const tree = markdownParser.parse(`[a]: ${rawSlice}`) as MdRoot;
    const def = tree.children[0];
    if (!def || def.type !== "definition") return null;
    return def.url;
  }
  const tree = markdownParser.parse(`[a](${rawSlice})`) as MdRoot;
  const para = tree.children[0];
  if (!para || para.type !== "paragraph" || para.children.length !== 1) return null;
  const link = para.children[0];
  if (!link || link.type !== "link") return null;
  return link.url;
}

function destinationMatchesUrl(
  rawSlice: string,
  parsedUrl: string,
  kind: "inline" | "definition",
): boolean {
  const reparsed = parseCommonMarkDestination(rawSlice, kind);
  return reparsed !== null && reparsed === parsedUrl;
}

function isBlockquotePrefixAt(raw: string, index: number): boolean {
  if (raw[index] !== ">") return false;
  let probe = index;
  while (probe >= 0 && (raw[probe] === ">" || raw[probe] === " " || raw[probe] === "\t")) {
    probe -= 1;
  }
  return probe < 0 || raw[probe] === "\n" || raw[probe] === "\r";
}

function skipWhitespaceAndQuotePrefixForward(raw: string, startPos: number): number {
  let pos = startPos;
  while (pos < raw.length) {
    while (pos < raw.length && (raw[pos] === " " || raw[pos] === "\t")) pos += 1;
    if (raw[pos] === "\r" || raw[pos] === "\n") {
      if (raw[pos] === "\r" && raw[pos + 1] === "\n") pos += 2;
      else pos += 1;
      while (pos < raw.length) {
        let probe = pos;
        while (probe < raw.length && (raw[probe] === " " || raw[probe] === "\t")) probe += 1;
        if (raw[probe] === ">") {
          pos = probe + 1;
          if (raw[pos] === " ") pos += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return pos;
}

function skipWhitespaceAndQuotePrefixBackward(raw: string, startIndex: number): number {
  let i = startIndex;
  while (i >= 0) {
    while (i >= 0 && (raw[i] === " " || raw[i] === "\t")) i -= 1;
    // Strip blockquote `>` markers that only precede whitespace on a continuation line.
    if (i >= 0 && raw[i] === ">") {
      let probe = i;
      while (probe >= 0 && (raw[probe] === ">" || raw[probe] === " " || raw[probe] === "\t")) {
        probe -= 1;
      }
      if (probe < 0 || raw[probe] === "\n" || raw[probe] === "\r") {
        i = probe;
        continue;
      }
    }
    if (i >= 0 && (raw[i] === "\n" || raw[i] === "\r")) {
      i -= 1;
      continue;
    }
    break;
  }
  return i;
}

function stripTrailingTitleBackward(raw: string, endIndex: number): number | null {
  let i = endIndex;
  const closeDelim = raw[i];
  if (closeDelim === '"' || closeDelim === "'") {
    i -= 1;
    while (i >= 0 && !(raw[i] === closeDelim && !isEscapedAt(raw, i))) i -= 1;
    if (i < 0) return null;
    i -= 1;
  } else if (closeDelim === ")") {
    let depth = 1;
    i -= 1;
    while (i >= 0 && depth > 0) {
      if (raw[i] === ")" && !isEscapedAt(raw, i)) depth += 1;
      else if (raw[i] === "(" && !isEscapedAt(raw, i)) depth -= 1;
      i -= 1;
    }
    if (depth !== 0) return null;
  } else {
    return null;
  }
  // A CommonMark link title must be separated from the destination by whitespace (or quote continuation).
  if (i < 0 || (!isWhitespace(raw[i]) && raw[i] !== ">")) return null;
  const beforeTitle = skipWhitespaceAndQuotePrefixBackward(raw, i);
  return beforeTitle < i ? beforeTitle : null;
}

function extractInlineDestinationBefore(
  raw: string,
  endIndex: number,
  parsedUrl: string,
): { destStart: number; destEnd: number } | null {
  if (endIndex < 0) return null;
  const destEnd = endIndex + 1;
  let destStart = destEnd;

  if (raw[endIndex] === ">" && !isEscapedAt(raw, endIndex)) {
    let j = endIndex - 1;
    while (j >= 0 && !(raw[j] === "<" && !isEscapedAt(raw, j))) j -= 1;
    if (j < 0) return null;
    destStart = j;
  } else {
    let parenDepth = 0;
    let j = endIndex;
    while (j >= 0) {
      const ch = raw[j];
      if (isWhitespace(ch) || isBlockquotePrefixAt(raw, j)) {
        destStart = j + 1;
        break;
      }
      if (ch === ")" && !isEscapedAt(raw, j)) {
        parenDepth += 1;
      } else if (ch === "(" && !isEscapedAt(raw, j)) {
        if (parenDepth === 0) {
          destStart = j + 1;
          break;
        }
        parenDepth -= 1;
      }
      j -= 1;
    }
  }

  if (destStart >= destEnd) return null;
  if (!destinationMatchesUrl(raw.slice(destStart, destEnd), parsedUrl, "inline")) return null;
  return { destStart, destEnd };
}

function locateInlineDestinationSpan(body: string, node: Link | Image): DestinationSpan | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return null;
  const raw = body.slice(start, end);
  if (!raw.endsWith(")")) return null;

  const endBeforeClose = skipWhitespaceAndQuotePrefixBackward(raw, raw.length - 2);
  if (endBeforeClose < 0) return null;

  // Try stripping a trailing title first when remark-parse reports a title or when an explicit empty title ("", '', ()) is present.
  const withoutTitle = stripTrailingTitleBackward(raw, endBeforeClose);
  const candidates = node.title != null ? [withoutTitle] : [withoutTitle, endBeforeClose];

  for (const candidateEnd of candidates) {
    if (candidateEnd === null) continue;
    const found = extractInlineDestinationBefore(raw, candidateEnd, node.url);
    if (found) {
      return {
        start: start + found.destStart,
        end: start + found.destEnd,
        url: node.url,
      };
    }
  }
  return null;
}

function locateDefinitionDestinationSpan(body: string, node: Definition): DestinationSpan | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return null;
  const raw = body.slice(start, end);
  let pos = 0;
  while (pos < raw.length && raw[pos] !== "[") pos += 1;
  if (pos >= raw.length) return null;
  pos += 1;
  while (pos < raw.length) {
    if (raw[pos] === "\\") {
      pos += 2;
      continue;
    }
    if (raw[pos] === "]") break;
    pos += 1;
  }
  if (raw[pos] !== "]" || raw[pos + 1] !== ":") return null;
  pos = skipWhitespaceAndQuotePrefixForward(raw, pos + 2);
  if (pos >= raw.length) return null;

  const destStart = pos;
  let destEnd = pos;
  if (raw[pos] === "<") {
    destEnd = pos + 1;
    while (destEnd < raw.length && !(raw[destEnd] === ">" && !isEscapedAt(raw, destEnd))) {
      destEnd += 1;
    }
    if (destEnd >= raw.length) return null;
    destEnd += 1;
  } else {
    while (destEnd < raw.length && !isWhitespace(raw[destEnd])) {
      destEnd += 1;
    }
  }

  if (destStart >= destEnd) return null;
  if (!destinationMatchesUrl(raw.slice(destStart, destEnd), node.url, "definition")) return null;
  return {
    start: start + destStart,
    end: start + destEnd,
    url: node.url,
  };
}

function collectMarkdownLinkNodes(body: string): Array<Link | Image | Definition> {
  const tree = markdownParser.parse(body) as MdRoot;
  const found: Array<Link | Image | Definition> = [];
  const visit = (node: MdNodes): void => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      found.push(node);
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child as MdNodes);
      }
    }
  };
  visit(tree);
  return found;
}

export function extractInboxAttachmentLinks(markdown: string): string[] {
  const split = splitMarkdownFrontmatter(markdown);
  const body = split ? split.body : markdown;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const node of collectMarkdownLinkNodes(body)) {
    if (!node.url.startsWith("files/")) continue;
    const decoded = decodeMarkdownTarget(node.url);
    if (!decoded) continue;
    const fullPath = `${INBOX_COLLECTION_PATH}/${decoded}`;
    if (!isInboxAttachmentPath(fullPath) || seen.has(fullPath)) continue;
    seen.add(fullPath);
    found.push(fullPath);
  }
  return found;
}

function rewriteFrontmatterAttachment(
  yamlBlock: string,
  pairs: ReadonlyArray<{ from: string; to: string }>,
): string {
  const lines = yamlBlock.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const keyMatch = /^Attachment:\s*(.+?)\s*$/u.exec(lines[i]!);
    if (!keyMatch) continue;
    const rawVal = keyMatch[1]!.trim();
    const unquoted =
      (rawVal.startsWith("'") && rawVal.endsWith("'")) ||
      (rawVal.startsWith('"') && rawVal.endsWith('"'))
        ? rawVal.slice(1, -1)
        : rawVal;
    const matched = pairs.find((pair) => pair.from === unquoted);
    if (matched) {
      lines[i] = dump({ Attachment: matched.to }, { lineWidth: -1, noRefs: true }).trimEnd();
      break;
    }
  }
  return lines.join("\n");
}

function posixDirname(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

function splitUrlSuffix(url: string): { pathPart: string; suffix: string } {
  const queryIdx = url.indexOf("?");
  const hashIdx = url.indexOf("#");
  let splitIdx = -1;
  if (queryIdx !== -1 && hashIdx !== -1) splitIdx = Math.min(queryIdx, hashIdx);
  else if (queryIdx !== -1) splitIdx = queryIdx;
  else if (hashIdx !== -1) splitIdx = hashIdx;
  if (splitIdx === -1) return { pathPart: url, suffix: "" };
  return { pathPart: url.slice(0, splitIdx), suffix: url.slice(splitIdx) };
}

function encodeMarkdownSuffix(suffix: string): string {
  return suffix.replace(/[\s()<>]/gu, (ch) => encodeURIComponent(ch));
}

function resolveRelativePosix(
  baseDir: string,
  relPath: string,
): { ups: number; parts: string[]; trailingSlash: boolean } {
  const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  let ups = 0;
  const trailingSlash = relPath.endsWith("/");
  for (const seg of relPath.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      else ups += 1;
    } else {
      parts.push(seg);
    }
  }
  return { ups, parts, trailingSlash };
}

function relativePosix(
  fromDir: string,
  target: { ups: number; parts: string[]; trailingSlash: boolean },
): string {
  const fromParts = fromDir ? fromDir.split("/").filter(Boolean) : [];
  let upCount: number;
  let down: string[];
  if (target.ups > 0) {
    upCount = fromParts.length + target.ups;
    down = target.parts;
  } else {
    let common = 0;
    while (
      common < fromParts.length &&
      common < target.parts.length &&
      fromParts[common] === target.parts[common]
    ) {
      common += 1;
    }
    upCount = fromParts.length - common;
    down = target.parts.slice(common);
  }
  const up = new Array<string>(upCount).fill("..");
  const rel = [...up, ...down].join("/") || ".";
  if (target.trailingSlash && rel !== "." && !rel.endsWith("/")) {
    return `${rel}/`;
  }
  return rel;
}

function rebaseRelativeMarkdownUrl(rawUrl: string, fromDir: string, toDir: string): string | null {
  if (fromDir === toDir) return null;
  const { pathPart, suffix } = splitUrlSuffix(rawUrl);
  if (!pathPart) return null;
  if (pathPart.startsWith("/")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(pathPart)) return null;
  if (pathPart.includes("\\")) return null;

  const decoded = decodeMarkdownTarget(pathPart);
  if (decoded === null) return null;
  const resolved = resolveRelativePosix(fromDir, decoded);
  const rebased = relativePosix(toDir, resolved);
  if (rebased === decoded) return null;
  return `${encodeMarkdownTarget(rebased)}${encodeMarkdownSuffix(suffix)}`;
}

function rewriteBodyLinkTargets(
  body: string,
  replacements: ReadonlyMap<string, string>,
  rebaseDirs?: { fromDir: string; toDir: string },
): string {
  const spans: Array<{ start: number; end: number; replacement: string }> = [];
  for (const node of collectMarkdownLinkNodes(body)) {
    const decoded = decodeMarkdownTarget(node.url);
    let replacement =
      replacements.get(node.url) ?? (decoded !== null ? replacements.get(decoded) : undefined);
    if (replacement === undefined && replacements.size > 0) {
      const { pathPart, suffix } = splitUrlSuffix(node.url);
      if (suffix) {
        const decodedPath = decodeMarkdownTarget(pathPart);
        const mappedPath =
          replacements.get(pathPart) ??
          (decodedPath !== null ? replacements.get(decodedPath) : undefined);
        if (mappedPath !== undefined) {
          replacement = `${mappedPath}${encodeMarkdownSuffix(suffix)}`;
        }
      }
    }
    if (replacement === undefined && rebaseDirs) {
      replacement =
        rebaseRelativeMarkdownUrl(node.url, rebaseDirs.fromDir, rebaseDirs.toDir) ?? undefined;
    }
    if (replacement === undefined) continue;
    const span =
      node.type === "definition"
        ? locateDefinitionDestinationSpan(body, node)
        : locateInlineDestinationSpan(body, node);
    if (!span) continue;
    spans.push({ start: span.start, end: span.end, replacement });
  }
  if (spans.length === 0) return body;

  spans.sort((left, right) => right.start - left.start);
  let updated = body;
  let lastAppliedStart = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    if (span.end > lastAppliedStart) continue;
    updated = `${updated.slice(0, span.start)}${span.replacement}${updated.slice(span.end)}`;
    lastAppliedStart = span.start;
  }
  return updated;
}

export function rewriteInboxMovedNoteMarkdown(
  markdown: string,
  movedAttachments: readonly { fromPath: string; toPath: string }[],
  noteMove?: { fromPath: string; toPath: string },
): string {
  const rebaseDirs = noteMove
    ? { fromDir: posixDirname(noteMove.fromPath), toDir: posixDirname(noteMove.toPath) }
    : undefined;
  if (movedAttachments.length === 0 && (!rebaseDirs || rebaseDirs.fromDir === rebaseDirs.toDir)) {
    return markdown;
  }
  const split = splitMarkdownFrontmatter(markdown);
  const header = split
    ? `${split.open}${
        movedAttachments.length > 0
          ? rewriteFrontmatterAttachment(
              split.yamlBlock,
              movedAttachments.map((moved) => ({ from: moved.fromPath, to: moved.toPath })),
            )
          : split.yamlBlock
      }${split.close}`
    : "";
  const body = split ? split.body : markdown;

  const targetMap = new Map<string, string>();
  for (const moved of movedAttachments) {
    if (!isInboxAttachmentPath(moved.fromPath)) continue;
    const oldRel = moved.fromPath.slice(INBOX_COLLECTION_PATH.length + 1);
    const oldEncoded = encodeMarkdownTarget(oldRel);
    const newLeaf = moved.toPath.split("/").at(-1) ?? moved.toPath;
    const newEncoded = encodeMarkdownTarget(newLeaf);
    targetMap.set(oldEncoded, newEncoded);
    targetMap.set(oldRel, newEncoded);
  }

  return `${header}${rewriteBodyLinkTargets(body, targetMap, rebaseDirs)}`;
}

export function rewriteInboxRestoredNoteMarkdown(
  markdown: string,
  restoredAttachments: readonly { fromPath: string; toPath: string }[],
  noteMove?: { fromPath: string; toPath: string },
): string {
  const rebaseDirs = noteMove
    ? { fromDir: posixDirname(noteMove.toPath), toDir: posixDirname(noteMove.fromPath) }
    : undefined;
  if (
    restoredAttachments.length === 0 &&
    (!rebaseDirs || rebaseDirs.fromDir === rebaseDirs.toDir)
  ) {
    return markdown;
  }
  const split = splitMarkdownFrontmatter(markdown);
  const header = split
    ? `${split.open}${
        restoredAttachments.length > 0
          ? rewriteFrontmatterAttachment(
              split.yamlBlock,
              restoredAttachments.map((moved) => ({ from: moved.toPath, to: moved.fromPath })),
            )
          : split.yamlBlock
      }${split.close}`
    : "";
  const body = split ? split.body : markdown;

  const targetMap = new Map<string, string>();
  for (const moved of restoredAttachments) {
    if (!isInboxAttachmentPath(moved.fromPath)) continue;
    const origRel = moved.fromPath.slice(INBOX_COLLECTION_PATH.length + 1);
    const origEncoded = encodeMarkdownTarget(origRel);
    const movedLeaf = moved.toPath.split("/").at(-1) ?? moved.toPath;
    const movedEncoded = encodeMarkdownTarget(movedLeaf);
    targetMap.set(movedEncoded, origEncoded);
    targetMap.set(movedLeaf, origEncoded);
  }

  return `${header}${rewriteBodyLinkTargets(body, targetMap, rebaseDirs)}`;
}
