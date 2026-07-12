import { posix } from "node:path";
import { open } from "node:fs/promises";
import { classifyEngineFilePathForRead } from "@dohc/workspace-engine";
import { resolveWorkspaceFile } from "./workspaceAssets";
import { listFiles } from "./workspaceFiles";

export type WorkspaceGraphEdgeKind = "wikilink" | "markdown";

export interface WorkspaceGraphNode {
  path: string;
  title: string;
  outgoing: number;
  incoming: number;
}

export interface WorkspaceGraphEdge {
  source: string;
  target: string;
  kind: WorkspaceGraphEdgeKind;
}

export interface WorkspaceGraph {
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
  unresolvedLinks: number;
  scannedFileCount: number;
  omittedFileCount: number;
  truncatedFileCount: number;
}

export interface MarkdownGraphDocument {
  path: string;
  text: string;
  truncated?: boolean;
}

// One mention of the target file inside a source document: the line that
// contains the link, trimmed to a readable length, plus the [start, end)
// character range WITHIN `text` that the link occupies (so the UI can
// highlight it).
export interface BacklinkSnippet {
  text: string;
  line: number;
  highlightStart: number;
  highlightEnd: number;
}

// Every source document that links to the target, with its mentions.
export interface BacklinkSource {
  sourcePath: string;
  sourceTitle: string;
  snippets: BacklinkSnippet[];
}

const MAX_BACKLINK_SOURCES = 500;
const MAX_BACKLINK_SNIPPETS_PER_SOURCE = 20;
const BACKLINK_SNIPPET_MAX_CHARS = 160;

const MAX_GRAPH_FILES = 2000;
const MAX_GRAPH_EDGES = 10000;
const MAX_GRAPH_LINK_CANDIDATES = 20000;
const MAX_GRAPH_FILE_TEXT_BYTES = 512 * 1024;
const MAX_GRAPH_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]{1,500})\]\]/g;

type LinkCandidate = {
  kind: WorkspaceGraphEdgeKind;
  target: string;
};

type PathIndex = {
  byPath: Map<string, string>;
  byPathLower: Map<string, string | null>;
  byStemLower: Map<string, string | null>;
  byPathWithoutExtLower: Map<string, string | null>;
};

const MARKDOWN_DESTINATION_ESCAPES = new Set([
  "\\",
  " ",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  "#",
  ".",
  "!",
  "?",
  "*",
  "_",
  "`",
  "~",
  "|",
  "-",
  "+",
]);

function isMarkdownGraphPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

function setUnique(map: Map<string, string | null>, key: string, value: string) {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, value);
  else if (existing !== value) map.set(key, null);
}

function titleFor(path: string, text: string): string {
  const h1 = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const raw =
    h1 && h1.length > 0
      ? h1
      : posix.basename(path).replace(/\.(md|markdown|mdx)$/i, "");
  return raw.replace(/\s+/g, " ").slice(0, 120);
}

function stripBlockCode(text: string): string {
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  let fence: { char: "`" | "~"; length: number } | null = null;

  return lines
    .map((line) => {
      if (line === "") return line;
      const hasTrailingNewline = line.endsWith("\n");
      const body = hasTrailingNewline ? line.slice(0, -1) : line;
      const newline = hasTrailingNewline ? "\n" : "";

      if (fence) {
        const close = body.match(/^[ \t]{0,3}([`~]{3,})[ \t]*$/);
        if (
          close?.[1]?.[0] === fence.char &&
          close[1].length >= fence.length
        ) {
          fence = null;
        }
        return newline;
      }

      const open = body.match(/^[ \t]{0,3}([`~]{3,})/);
      if (open?.[1]) {
        fence = { char: open[1][0] as "`" | "~", length: open[1].length };
        return newline;
      }

      if (/^(?: {4}|\t)/.test(body)) return newline;
      return line;
    })
    .join("");
}

function stripInlineCode(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      output += text[index];
      index += 1;
      continue;
    }

    let length = 1;
    while (text[index + length] === "`") length += 1;
    const delimiter = "`".repeat(length);
    const close = text.indexOf(delimiter, index + length);
    if (close === -1) {
      output += delimiter;
      index += length;
      continue;
    }

    index = close + length;
  }

  return output;
}

function stripCode(text: string): string {
  return stripInlineCode(stripBlockCode(text.replace(/\r\n?/g, "\n")));
}

function markdownHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    return close > 1 ? trimmed.slice(1, close) : null;
  }

  let token = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1]) {
      token += char + trimmed[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) break;
    token += char;
  }
  return token || null;
}

function unescapeMarkdownDestination(raw: string): string {
  let target = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === "\\" && next && MARKDOWN_DESTINATION_ESCAPES.has(next)) {
      target += next;
      index += 1;
      continue;
    }
    target += char;
  }
  return target;
}

// One `[label](href)` occurrence with the character offsets of the whole
// construct in `source`: `start` is the opening `[`, `end` is just past the
// closing `)`. Backlink snippets highlight [start, end); the graph only needs
// the href.
interface MarkdownLinkSpan {
  rawHref: string;
  start: number;
  end: number;
}

function extractMarkdownLinkSpans(
  source: string,
  limit: number,
): MarkdownLinkSpan[] {
  const spans: MarkdownLinkSpan[] = [];
  let index = 0;

  while (spans.length < limit && index < source.length) {
    const labelStart = source.indexOf("[", index);
    if (labelStart === -1) break;
    if (labelStart > 0 && source[labelStart - 1] === "!") {
      index = labelStart + 1;
      continue;
    }

    const labelEnd = source.indexOf("]", labelStart + 1);
    if (labelEnd === -1) break;
    if (source[labelEnd + 1] !== "(") {
      index = labelEnd + 1;
      continue;
    }

    const hrefStart = labelEnd + 2;
    let depth = 0;
    let inAngle = false;
    let closed = false;

    for (
      let cursor = hrefStart;
      cursor < source.length && cursor - hrefStart <= 800;
      cursor += 1
    ) {
      const char = source[cursor];
      if (!char || char === "\n") break;
      if (char === "\\") {
        cursor += 1;
        continue;
      }
      if (inAngle) {
        if (char === ">") inAngle = false;
        continue;
      }
      if (char === "<" && depth === 0) {
        inAngle = true;
        continue;
      }
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char === ")") {
        if (depth === 0) {
          spans.push({
            rawHref: source.slice(hrefStart, cursor),
            start: labelStart,
            end: cursor + 1,
          });
          index = cursor + 1;
          closed = true;
          break;
        }
        depth -= 1;
      }
    }

    if (!closed) index = labelEnd + 1;
  }

  return spans;
}

function extractMarkdownLinkHrefs(source: string, limit: number): string[] {
  return extractMarkdownLinkSpans(source, limit).map((span) => span.rawHref);
}

function isLocalGraphTarget(raw: string): boolean {
  const target = raw.trim();
  if (!target || target.startsWith("#")) return false;
  if (target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return false;
  }
  return true;
}

function normalizeRawTarget(
  raw: string,
  kind: WorkspaceGraphEdgeKind,
): string | null {
  let target = raw.trim();
  if (kind === "markdown") target = unescapeMarkdownDestination(target);
  if (!target) return null;
  const hashIndex = target.indexOf("#");
  if (hashIndex === 0) return null;
  if (hashIndex > 0) target = target.slice(0, hashIndex);
  const queryIndex = target.indexOf("?");
  if (queryIndex > 0) target = target.slice(0, queryIndex);
  target = target.trim();
  if (!target || target.includes("\0") || target.includes("\\")) return null;
  if (target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return null;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the undecoded target; malformed escapes just become unresolved.
  }
  return target;
}

export function extractMarkdownGraphLinks(
  text: string,
  limit = MAX_GRAPH_LINK_CANDIDATES,
): LinkCandidate[] {
  const source = stripCode(text);
  const links: LinkCandidate[] = [];

  for (const match of source.matchAll(WIKILINK_RE)) {
    if (links.length >= limit) break;
    const raw = match[1]?.split("|")[0]?.trim();
    if (raw && isLocalGraphTarget(raw)) {
      links.push({ kind: "wikilink", target: raw });
    }
  }

  for (const rawHref of extractMarkdownLinkHrefs(source, limit - links.length)) {
    if (links.length >= limit) break;
    const href = markdownHref(rawHref);
    if (href && isLocalGraphTarget(href)) {
      links.push({ kind: "markdown", target: href });
    }
  }

  return links;
}

function withoutGraphExtension(path: string): string {
  const ext = posix.extname(path);
  return ext ? path.slice(0, -ext.length) : path;
}

function createPathIndex(paths: string[]): PathIndex {
  const index: PathIndex = {
    byPath: new Map(),
    byPathLower: new Map(),
    byStemLower: new Map(),
    byPathWithoutExtLower: new Map(),
  };

  for (const path of paths) {
    index.byPath.set(path, path);
    setUnique(index.byPathLower, path.toLowerCase(), path);
    setUnique(
      index.byStemLower,
      posix.basename(withoutGraphExtension(path)).toLowerCase(),
      path,
    );
    setUnique(
      index.byPathWithoutExtLower,
      withoutGraphExtension(path).toLowerCase(),
      path,
    );
  }

  return index;
}

function normalizedPathCandidate(path: string): string | null {
  const normalized = posix.normalize(path).replace(/^\.\/+/, "");
  if (
    normalized === "." ||
    normalized === "" ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    return null;
  }
  return normalized;
}

function lookupPath(index: PathIndex, candidate: string): string | null {
  const normalized = normalizedPathCandidate(candidate);
  if (!normalized) return null;
  const exact = index.byPath.get(normalized);
  if (exact) return exact;
  const lower = index.byPathLower.get(normalized.toLowerCase());
  return lower ?? null;
}

function candidateWithMarkdownExtensions(path: string): string[] {
  if (MARKDOWN_EXTENSIONS.has(posix.extname(path).toLowerCase())) return [path];
  return [path, `${path}.md`, `${path}.markdown`, `${path}.mdx`];
}

function lookupPathFamily(index: PathIndex, candidate: string): string | null {
  for (const next of candidateWithMarkdownExtensions(candidate)) {
    const found = lookupPath(index, next);
    if (found) return found;
  }
  const withoutExt = index.byPathWithoutExtLower.get(candidate.toLowerCase());
  return withoutExt ?? null;
}

function resolveLinkTarget(
  sourcePath: string,
  rawTarget: string,
  kind: WorkspaceGraphEdgeKind,
  index: PathIndex,
): string | null {
  const target = normalizeRawTarget(rawTarget, kind);
  if (!target) return null;

  const rootRelative = target.startsWith("/");
  const targetPath = rootRelative ? target.replace(/^\/+/, "") : target;
  const sourceDir =
    posix.dirname(sourcePath) === "." ? "" : posix.dirname(sourcePath);
  const candidates: string[] = [];
  const hasPathSegment = targetPath.includes("/");
  const explicitRelative =
    targetPath.startsWith("./") || targetPath.startsWith("../");

  if (rootRelative) {
    candidates.push(targetPath);
  } else if (explicitRelative) {
    candidates.push(posix.join(sourceDir, targetPath));
  } else if (hasPathSegment) {
    candidates.push(
      kind === "markdown" ? posix.join(sourceDir, targetPath) : targetPath,
    );
  } else {
    if (kind === "wikilink") {
      const sourceRelative = lookupPathFamily(
        index,
        posix.join(sourceDir, targetPath),
      );
      if (sourceRelative) return sourceRelative;
      const stem = index.byStemLower.get(targetPath.toLowerCase());
      if (stem !== undefined) return stem;
      if (MARKDOWN_EXTENSIONS.has(posix.extname(targetPath).toLowerCase())) {
        candidates.push(targetPath);
      }
    } else {
      candidates.push(posix.join(sourceDir, targetPath));
    }
  }

  for (const candidate of candidates) {
    const found = lookupPathFamily(index, candidate);
    if (found) return found;
  }

  return null;
}

export function buildMarkdownGraph(
  docs: MarkdownGraphDocument[],
  options: {
    allPaths?: string[];
    omittedFileCount?: number;
    scannedFileCount?: number;
  } = {},
): WorkspaceGraph {
  const allPaths = [...(options.allPaths ?? docs.map((doc) => doc.path))]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort((a, b) => a.localeCompare(b));
  const sortedDocs = [...docs]
    .filter((doc) => isMarkdownGraphPath(doc.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const docByPath = new Map(sortedDocs.map((doc) => [doc.path, doc]));
  const index = createPathIndex(allPaths);
  const stats = new Map<string, { incoming: number; outgoing: number }>();
  const edges: WorkspaceGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let unresolvedLinks = 0;
  let processedLinkCandidates = 0;

  for (const path of allPaths) {
    stats.set(path, { incoming: 0, outgoing: 0 });
  }

  for (const doc of sortedDocs) {
    if (
      edges.length >= MAX_GRAPH_EDGES ||
      processedLinkCandidates >= MAX_GRAPH_LINK_CANDIDATES
    ) {
      break;
    }
    const remainingLinkCandidates =
      MAX_GRAPH_LINK_CANDIDATES - processedLinkCandidates;
    for (const link of extractMarkdownGraphLinks(doc.text, remainingLinkCandidates)) {
      processedLinkCandidates += 1;
      if (edges.length >= MAX_GRAPH_EDGES) break;
      const target = resolveLinkTarget(doc.path, link.target, link.kind, index);
      if (!target) {
        unresolvedLinks += 1;
        continue;
      }
      if (target === doc.path) continue;
      const key = `${doc.path}\0${target}\0${link.kind}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: doc.path, target, kind: link.kind });
      stats.get(doc.path)!.outgoing += 1;
      stats.get(target)!.incoming += 1;
    }
  }

  const nodes = allPaths.map((path) => ({
    path,
    title: docByPath.has(path)
      ? titleFor(path, docByPath.get(path)!.text)
      : posix.basename(path).slice(0, 120),
    outgoing: stats.get(path)?.outgoing ?? 0,
    incoming: stats.get(path)?.incoming ?? 0,
  }));

  edges.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.kind.localeCompare(b.kind),
  );

  return {
    nodes,
    edges,
    unresolvedLinks,
    scannedFileCount: options.scannedFileCount ?? sortedDocs.length,
    omittedFileCount: options.omittedFileCount ?? 0,
    truncatedFileCount: sortedDocs.filter((doc) => doc.truncated).length,
  };
}

// Replaces every code character (fenced blocks, indented blocks, inline spans)
// with a space of its own — same length, same newlines. Link scanning then
// skips code exactly as the graph does (which STRIPS it), but character offsets
// stay aligned with the original text so a match position maps straight back to
// the source line for a snippet.
function maskBlockCode(text: string): string {
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  const blank = (value: string) => value.replace(/[^\n]/g, " ");

  return lines
    .map((line) => {
      if (line === "") return line;
      const hasNewline = line.endsWith("\n");
      const body = hasNewline ? line.slice(0, -1) : line;
      const output = () => blank(body) + (hasNewline ? "\n" : "");
      // A trailing CR is part of the body's length but not its fence syntax.
      const probe = body.endsWith("\r") ? body.slice(0, -1) : body;

      if (fence) {
        const close = probe.match(/^[ \t]{0,3}([`~]{3,})[ \t]*$/);
        if (close?.[1]?.[0] === fence.char && close[1].length >= fence.length) {
          fence = null;
        }
        return output();
      }

      const open = probe.match(/^[ \t]{0,3}([`~]{3,})/);
      if (open?.[1]) {
        fence = { char: open[1][0] as "`" | "~", length: open[1].length };
        return output();
      }

      if (/^(?: {4}|\t)/.test(probe)) return output();
      return line;
    })
    .join("");
}

function maskInlineCode(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      output += text[index];
      index += 1;
      continue;
    }

    let length = 1;
    while (text[index + length] === "`") length += 1;
    const delimiter = "`".repeat(length);
    const close = text.indexOf(delimiter, index + length);
    if (close === -1) {
      output += delimiter;
      index += length;
      continue;
    }

    // Blank the whole span but keep newlines so line extraction still works.
    output += text.slice(index, close + length).replace(/[^\n]/g, " ");
    index = close + length;
  }

  return output;
}

function maskCode(text: string): string {
  return maskInlineCode(maskBlockCode(text));
}

interface RawMention {
  kind: WorkspaceGraphEdgeKind;
  target: string;
  start: number;
  end: number;
}

// Like extractMarkdownGraphLinks, but over the offset-preserving code MASK
// (not the length-changing strip) so each mention carries its position in the
// ORIGINAL text. Returned in document order.
function extractMentionsWithPositions(text: string, limit: number): RawMention[] {
  const masked = maskCode(text);
  const mentions: RawMention[] = [];

  for (const match of masked.matchAll(WIKILINK_RE)) {
    if (mentions.length >= limit) break;
    const raw = match[1]?.split("|")[0]?.trim();
    if (raw && isLocalGraphTarget(raw)) {
      const start = match.index ?? 0;
      mentions.push({
        kind: "wikilink",
        target: raw,
        start,
        end: start + match[0].length,
      });
    }
  }

  for (const span of extractMarkdownLinkSpans(masked, limit)) {
    if (mentions.length >= limit) break;
    const href = markdownHref(span.rawHref);
    if (href && isLocalGraphTarget(href)) {
      mentions.push({
        kind: "markdown",
        target: href,
        start: span.start,
        end: span.end,
      });
    }
  }

  mentions.sort((a, b) => a.start - b.start || a.end - b.end);
  return mentions;
}

// Windows a source line down to BACKLINK_SNIPPET_MAX_CHARS around the link,
// adding ellipses when trimmed, and returns the highlight range within the
// windowed text.
function windowSnippet(
  fullLine: string,
  hStart: number,
  hEnd: number,
): { text: string; highlightStart: number; highlightEnd: number } {
  const max = BACKLINK_SNIPPET_MAX_CHARS;
  if (fullLine.length <= max) {
    return { text: fullLine, highlightStart: hStart, highlightEnd: hEnd };
  }

  const linkLen = hEnd - hStart;
  let start: number;
  let end: number;
  if (linkLen >= max) {
    start = hStart;
    end = hStart + max;
  } else {
    const context = Math.floor((max - linkLen) / 2);
    start = hStart - context;
    end = hEnd + (max - linkLen - context);
    if (start < 0) {
      end += -start;
      start = 0;
    }
    if (end > fullLine.length) {
      start -= end - fullLine.length;
      end = fullLine.length;
    }
    start = Math.max(0, start);
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < fullLine.length ? "…" : "";
  const text = prefix + fullLine.slice(start, end) + suffix;
  const highlightStart = Math.min(prefix.length + (hStart - start), text.length);
  const highlightEnd = Math.min(
    prefix.length + (Math.min(end, hEnd) - start),
    text.length,
  );
  return {
    text,
    highlightStart,
    highlightEnd: Math.max(highlightStart, highlightEnd),
  };
}

function buildBacklinkSnippet(
  text: string,
  matchStart: number,
  matchEnd: number,
): BacklinkSnippet {
  let line = 1;
  for (let i = 0; i < matchStart; i += 1) if (text[i] === "\n") line += 1;

  const lineStart =
    matchStart === 0 ? 0 : text.lastIndexOf("\n", matchStart - 1) + 1;
  const newline = text.indexOf("\n", matchStart);
  const lineEnd = newline === -1 ? text.length : newline;
  const rawLine = text.slice(lineStart, lineEnd).replace(/\r$/, "");

  // Trim leading indentation and trailing whitespace, shifting the highlight.
  const leading = rawLine.length - rawLine.trimStart().length;
  const trimmed = rawLine.trim();
  const hStart = Math.max(0, matchStart - lineStart - leading);
  const hEnd = Math.min(
    trimmed.length,
    Math.max(hStart, matchEnd - lineStart - leading),
  );

  const windowed = windowSnippet(trimmed, hStart, hEnd);
  return { ...windowed, line };
}

// Inverts the graph for one file: every OTHER document whose links resolve to
// `targetPath`, with a snippet per mention. Self-links (a doc linking to
// itself) and unresolved links are excluded — the same rules the graph applies.
// Pure over an in-memory document map so it is testable without any IPC/FS.
export function computeBacklinks(
  docs: MarkdownGraphDocument[],
  targetPath: string,
  options: { allPaths?: string[] } = {},
): BacklinkSource[] {
  const allPaths = [...(options.allPaths ?? docs.map((doc) => doc.path))]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort((a, b) => a.localeCompare(b));
  const index = createPathIndex(allPaths);
  const sortedDocs = [...docs]
    .filter((doc) => isMarkdownGraphPath(doc.path) && doc.path !== targetPath)
    .sort((a, b) => a.path.localeCompare(b.path));

  const sources: BacklinkSource[] = [];
  // Workspace-wide mention budget, decremented across ALL source docs — the
  // same bound buildMarkdownGraph applies via processedLinkCandidates. Without
  // it, a large workspace of link-heavy files with few/no matches could scan
  // up to MAX_GRAPH_LINK_CANDIDATES mentions PER file on every backlinks
  // refresh; this keeps the panel's cost bounded like the graph's.
  let remainingLinkCandidates = MAX_GRAPH_LINK_CANDIDATES;
  for (const doc of sortedDocs) {
    if (sources.length >= MAX_BACKLINK_SOURCES) break;
    if (remainingLinkCandidates <= 0) break;
    const snippets: BacklinkSnippet[] = [];
    const seen = new Set<string>();

    for (const mention of extractMentionsWithPositions(
      doc.text,
      remainingLinkCandidates,
    )) {
      remainingLinkCandidates -= 1;
      if (snippets.length >= MAX_BACKLINK_SNIPPETS_PER_SOURCE) break;
      const resolved = resolveLinkTarget(
        doc.path,
        mention.target,
        mention.kind,
        index,
      );
      if (resolved !== targetPath) continue;
      const key = `${mention.start}\0${mention.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      snippets.push(buildBacklinkSnippet(doc.text, mention.start, mention.end));
    }

    if (snippets.length > 0) {
      sources.push({
        sourcePath: doc.path,
        sourceTitle: titleFor(doc.path, doc.text),
        snippets,
      });
    }
  }

  return sources;
}

async function readGraphText(
  rootPath: string,
  relativePath: string,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const { realTarget } = await resolveWorkspaceFile(rootPath, relativePath, "read");
  const handle = await open(realTarget, "r");
  try {
    const buf = Buffer.alloc(MAX_GRAPH_FILE_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(
      buf,
      0,
      MAX_GRAPH_FILE_TEXT_BYTES + 1,
      0,
    );
    const truncated = bytesRead > MAX_GRAPH_FILE_TEXT_BYTES;
    const slice = buf.subarray(0, Math.min(bytesRead, MAX_GRAPH_FILE_TEXT_BYTES));
    return { text: slice.toString("utf8"), truncated, bytesRead: slice.length };
  } finally {
    await handle.close();
  }
}

// Loads every markdown file in the workspace (bounded by the same file/byte
// caps the graph enforces) so both the graph and backlinks read from one place.
// `graphPaths` keeps the FULL scanned set (all kinds) — link resolution indexes
// against it so a markdown link to a non-markdown file still resolves.
async function loadGraphDocuments(rootPath: string): Promise<{
  docs: MarkdownGraphDocument[];
  graphPaths: string[];
  scannedFileCount: number;
  omittedFileCount: number;
}> {
  const listed = await listFiles(rootPath);
  // Enforce the engine secret floor at the loader so EVERY graph/backlinks
  // consumer inherits it: a secret- or ignored-classified file (the whole
  // `.env` family, incl. markdown-extensioned variants like `.env.local.md`,
  // and ignored segments) must never be scanned as a link source, indexed as
  // a resolvable node, or surfaced as a backlink entry/snippet. This mirrors
  // search, which fails-closed on the same `classifyEngineFilePath` floor
  // (workspaceSearch.ts + searchIndex.ts) so "what the graph reads" and "what
  // search may reveal" cannot drift apart.
  // Read-aware: mounted shares are readable content, so their markdown
  // joins the graph/backlinks like any other file; secrets stay excluded
  // inside and outside mounts.
  const visiblePaths = listed.files
    .map((file) => file.path)
    .filter((path) => classifyEngineFilePathForRead(path).kind === "tracked");
  const graphPaths = visiblePaths.slice(0, MAX_GRAPH_FILES);
  const selected = graphPaths.filter((path) => isMarkdownGraphPath(path));
  const docs: MarkdownGraphDocument[] = [];
  let totalTextBytes = 0;
  let omittedFileCount = Math.max(0, visiblePaths.length - graphPaths.length);

  for (let index = 0; index < selected.length; index++) {
    const path = selected[index];
    try {
      const result = await readGraphText(rootPath, path);
      if (totalTextBytes + result.bytesRead > MAX_GRAPH_TOTAL_TEXT_BYTES) {
        omittedFileCount += selected.length - index;
        break;
      }
      totalTextBytes += result.bytesRead;
      docs.push({ path, text: result.text, truncated: result.truncated });
    } catch {
      // The watcher may have observed a file that was moved or deleted by the
      // time we read it. This is a view; the next refresh will pick it up.
    }
  }

  return {
    docs,
    graphPaths,
    scannedFileCount: graphPaths.length,
    omittedFileCount,
  };
}

export async function readWorkspaceGraph(rootPath: string): Promise<WorkspaceGraph> {
  const { docs, graphPaths, scannedFileCount, omittedFileCount } =
    await loadGraphDocuments(rootPath);
  return buildMarkdownGraph(docs, {
    allPaths: graphPaths,
    omittedFileCount,
    scannedFileCount,
  });
}

// Backlinks read the SAME graph documents and invert the edge derivation: for
// the open file, find every OTHER file whose links resolve to it. Reuses the
// graph's link extraction + resolution so a backlink and a graph edge always
// agree on what points where.
export async function readWorkspaceBacklinks(
  rootPath: string,
  targetPath: string,
): Promise<BacklinkSource[]> {
  const { docs, graphPaths } = await loadGraphDocuments(rootPath);
  return computeBacklinks(docs, targetPath, { allPaths: graphPaths });
}
