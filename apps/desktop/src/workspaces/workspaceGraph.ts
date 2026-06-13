import { posix } from "node:path";
import { open } from "node:fs/promises";
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

const MAX_GRAPH_FILES = 2000;
const MAX_GRAPH_EDGES = 10000;
const MAX_GRAPH_LINK_CANDIDATES = 20000;
const MAX_GRAPH_FILE_TEXT_BYTES = 512 * 1024;
const MAX_GRAPH_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const NON_GRAPH_TARGET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".csv",
  ".db",
  ".doc",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".pdf",
  ".png",
  ".sqlite",
  ".sqlite3",
  ".svg",
  ".tsv",
  ".txt",
  ".wav",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);
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

function extractMarkdownLinkHrefs(source: string, limit: number): string[] {
  const hrefs: string[] = [];
  let index = 0;

  while (hrefs.length < limit && index < source.length) {
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
          hrefs.push(source.slice(hrefStart, cursor));
          index = cursor + 1;
          closed = true;
          break;
        }
        depth -= 1;
      }
    }

    if (!closed) index = labelEnd + 1;
  }

  return hrefs;
}

function isLocalGraphTarget(raw: string): boolean {
  const target = raw.trim();
  if (!target || target.startsWith("#")) return false;
  if (target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return false;
  }
  const pathPart = target.split(/[?#]/)[0] ?? "";
  const ext = posix.extname(pathPart).toLowerCase();
  return !NON_GRAPH_TARGET_EXTENSIONS.has(ext);
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

function withoutMarkdownExtension(path: string): string {
  return path.replace(/\.(md|markdown|mdx)$/i, "");
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
      posix.basename(withoutMarkdownExtension(path)).toLowerCase(),
      path,
    );
    setUnique(
      index.byPathWithoutExtLower,
      withoutMarkdownExtension(path).toLowerCase(),
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
  options: { omittedFileCount?: number } = {},
): WorkspaceGraph {
  const sortedDocs = [...docs]
    .filter((doc) => isMarkdownGraphPath(doc.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const paths = sortedDocs.map((doc) => doc.path);
  const index = createPathIndex(paths);
  const stats = new Map<string, { incoming: number; outgoing: number }>();
  const edges: WorkspaceGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let unresolvedLinks = 0;
  let processedLinkCandidates = 0;

  for (const path of paths) {
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

  const nodes = sortedDocs.map((doc) => ({
    path: doc.path,
    title: titleFor(doc.path, doc.text),
    outgoing: stats.get(doc.path)?.outgoing ?? 0,
    incoming: stats.get(doc.path)?.incoming ?? 0,
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
    scannedFileCount: sortedDocs.length,
    omittedFileCount: options.omittedFileCount ?? 0,
    truncatedFileCount: sortedDocs.filter((doc) => doc.truncated).length,
  };
}

async function readGraphText(
  rootPath: string,
  relativePath: string,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const { realTarget } = await resolveWorkspaceFile(rootPath, relativePath);
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

export async function readWorkspaceGraph(rootPath: string): Promise<WorkspaceGraph> {
  const listed = await listFiles(rootPath);
  const markdownPaths = listed.files
    .filter((file) => file.kind === "file" && isMarkdownGraphPath(file.path))
    .map((file) => file.path);
  const selected = markdownPaths.slice(0, MAX_GRAPH_FILES);
  const docs: MarkdownGraphDocument[] = [];
  let totalTextBytes = 0;
  let omittedFileCount = Math.max(0, markdownPaths.length - selected.length);

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
      // time graph reads it. The graph is a view; the next refresh will catch up.
    }
  }

  return buildMarkdownGraph(docs, {
    omittedFileCount,
  });
}
