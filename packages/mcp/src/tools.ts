// Pure MCP tool implementations. Each operates on a workspace ROOT dir and a
// state HOME (the desktop registry/state location). EVERY workspace-relative
// write path is validated through validateUserMaterializePath (reads through
// validateUserReadPath) before it touches the filesystem — traversal (../,
// percent-encoded, the reserved .dohc dir) is rejected here, the #1 security
// requirement, and disk-write mutations also refuse names that cannot be
// materialized on this host. Writes are scoped to the root and never
// auto-apply a boundary crossing.

import {
  addFileChanges,
  createChangeSet,
  databaseSyncStrategy,
  frameworkConfigName,
  hasIgnoredSegment,
  hasWebDependency,
  mediaTypeForPath,
  packageManagerFromFiles,
  validateUserMaterializePath,
  validateUserReadPath,
  type ChangeAuthor,
  type ChangeProvenance,
  type ChangeSetKind,
  type DohcSiteConfig,
  type FileChange,
  type PackageJson,
  type SiteConfidence,
  type SiteDiagnostic,
  type SiteKind,
  type SiteScripts,
  type WorkspaceSite,
  isSharedWithMePath,
} from "@dohc/workspace-core";
import {
  DohcCliError,
  sendCliRequest,
} from "@dohc/cli";
import {
  CLI_PROTOCOL_VERSION,
  parseCliResult,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { mergeMarkdown } from "@dohc/workspace-core/mergeMarkdown";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { hasLegacyAppImport } from "./sourceScanner";

export interface ToolContext {
  // Workspace root the server is scoped to (the --workspace arg). All file
  // paths resolve under here and may never escape it.
  root: string;
  // Desktop state/home dir (the --home arg): holds dohc-workspaces.json.
  home: string;
  // Desktop/package launcher-owned SDK metadata. add_sdk must not infer this
  // from the MCP build output path because packaged layouts can differ.
  sdkPackageJsonPath?: string;
  sdkDependencyRange?: string;
  // READ-ONLY profile (PR 18 shared views): when true the server registers
  // only read/list/search/status tools — the mutating tools are never
  // registered, so a shared-view MCP server cannot write, create, move,
  // delete, import, publish, share, or post chat. Set by the --read-only flag.
  readOnly?: boolean;
  // Injectable CLI transport for tests. Production uses sendCliRequest with
  // the explicit desktop state dir supplied by --home.
  request?: (request: CliRequestWithoutToken) => Promise<unknown>;
}

const MCP_AUTHOR: ChangeAuthor = {
  kind: "agent",
  agentId: "dohc-mcp",
  onBehalfOf: "local",
};
const historyRecordedAtMsByRoot = new Map<string, number>();
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const HARD_READ_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SEARCH_MAX_RESULTS = 100;
const HARD_SEARCH_MAX_RESULTS = 1000;
const DEFAULT_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_PREVIEW_CHARS = 200;

// Is `absolute` REALLY inside `root` after resolving symlinks? Lexical
// containment (the path validators) stops ../ and friends, but a symlink that
// already exists inside the workspace can still point outside it; every later
// fs call would follow it. We realpath the deepest EXISTING ancestor (the file
// itself for reads, its parent chain for not-yet-created targets) and require
// it to stay under the canonical root. The root itself may legitimately be a
// symlink, so we compare against realpath(root). Fails closed on any error.
async function isWithinRealRoot(root: string, absolute: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return false;
  }
  let probe = absolute;
  for (;;) {
    try {
      const real = await realpath(probe);
      return real === realRoot || real.startsWith(realRoot + sep);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false; // reached fs root without resolving
      probe = parent;
    }
  }
}

// A tool's path arg, resolved to an absolute path INSIDE the root, or a reason
// it was refused. Centralizes BOTH guards so no tool can forget them: lexical
// validation (traversal/encoding/reserved) then realpath containment (symlink
// escape). Async because the symlink check touches the filesystem.
async function safeResolve(
  ctx: ToolContext,
  relativePath: string,
  access: "read" | "write" = "write",
): Promise<{ ok: true; absolute: string; normalized: string } | { ok: false; reason: string }> {
  // "write" (the default — fail closed) refuses the reserved shared-with-me
  // projection; "read" allows it (share mounts exist to be read by agents)
  // while keeping traversal/encoding/ignored-segment guards identical.
  const validated =
    access === "read"
      ? validateUserReadPath(relativePath)
      : validateUserMaterializePath(relativePath);
  if (!validated.ok) {
    return { ok: false, reason: `path rejected (${validated.reason}): ${relativePath}` };
  }
  const absolute = join(ctx.root, validated.normalized);
  if (!(await isWithinRealRoot(ctx.root, absolute))) {
    return { ok: false, reason: `path rejected (symlink escapes workspace): ${relativePath}` };
  }
  return { ok: true, absolute, normalized: validated.normalized };
}

async function safeResolveForMutation(
  ctx: ToolContext,
  normalizedPath: string,
): Promise<{ absolute: string; normalized: string }> {
  const resolved = await safeResolve(ctx, normalizedPath);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.reason), { code: "EINVAL" });
  }
  return resolved;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readFileWindowWithDigest(
  absolute: string,
  offsetBytes: number,
  maxBytes: number,
): Promise<{ bytes: number; window: Buffer; sha256: string; offsetBytes: number; truncated: boolean }> {
  const file = await open(absolute, "r");
  try {
    const { size } = await file.stat();
    const offset = Math.min(size, offsetBytes);
    const windowLength = Math.min(maxBytes, size - offset);
    const window = Buffer.alloc(windowLength);
    if (windowLength > 0) {
      await file.read(window, 0, windowLength, offset);
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const length = Math.min(chunk.byteLength, size - position);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }

    return {
      bytes: size,
      window,
      sha256: hash.digest("hex"),
      offsetBytes: offset,
      truncated: offset + windowLength < size,
    };
  } finally {
    await file.close();
  }
}

// PR 0N-1: is this workspace on the workspace engine? MCP reads the SAME
// per-workspace settings file the desktop reads (.dohc/settings.local.json,
// workspaceSettingsFile.ts) and mirrors its resolution rule. WS-H1 flag
// flip: the engine is the DEFAULT — an absent key, a missing file, or any
// refused/failed read (symlink, oversized, parse error) resolves ON, exactly
// like the desktop's schema default; only an explicit
// `workspaceEngineAlpha: false` opts the workspace out. Cheap enough to read
// per mutating call — the flag can flip between desktop opens.
const MAX_WORKSPACE_SETTINGS_FILE_BYTES = 256 * 1024;

export async function isWorkspaceEngineFlagged(ctx: ToolContext): Promise<boolean> {
  try {
    const path = join(ctx.root, ".dohc", "settings.local.json");
    const stats = await lstat(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > MAX_WORKSPACE_SETTINGS_FILE_BYTES
    ) {
      return true;
    }
    if (!(await isWithinRealRoot(ctx.root, path))) return true;
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      experimental?: { workspaceEngineAlpha?: unknown };
    };
    return raw?.experimental?.workspaceEngineAlpha !== false;
  } catch {
    return true;
  }
}

// Retirement Phase C (WS-H1): MCP writes NO legacy change sets. For an engine
// workspace (the default) the desktop watcher captures MCP's physical writes
// into engine moments (agent-attributed when a dohc-tracked run is active; an
// external MCP client without a dohc-tracked run yields actor-neutral engine
// capture — honest per the actor-neutral principle). Caveat a standalone MCP
// client should know: that capture happens via the desktop watcher when the
// app is open — a write made while the desktop is closed is picked up by the
// next startup reconciliation. A workspace that explicitly opted OUT of the
// engine has NO recorder at all; naming a recorder there would be a lie, so
// mutating tools report `historyRecording: "off"` instead. Legacy
// .dohc/history left by pre-flip versions is no longer read (the relic reader
// retired with @dohc/workspace-history); the read tools below list engine
// moments only.
async function recordedChangeFields(
  ctx: ToolContext,
): Promise<{ recordedBy: "workspace-engine" } | { historyRecording: "off" }> {
  return (await isWorkspaceEngineFlagged(ctx))
    ? { recordedBy: "workspace-engine" as const }
    : { historyRecording: "off" as const };
}

function failureReason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function ensureRecordable(ctx: ToolContext) {
  // Retirement Phase C: no legacy durable-writer platform gate — the engine
  // captures the physical write. The metadata-dir safety check still fails
  // closed before visible disk changes (symlinked/escaping .dohc).
  try {
    await safeMetadataDir(ctx);
    return null;
  } catch (error) {
    return { ok: false as const, reason: failureReason(error, "history unavailable") };
  }
}

async function safeMetadataDir(ctx: ToolContext): Promise<string> {
  const dir = join(ctx.root, ".dohc");
  await mkdir(dir, { recursive: true });
  const link = await lstat(dir);
  if (link.isSymbolicLink()) {
    throw new Error("workspace metadata directory is a symlink");
  }
  if (!(await isWithinRealRoot(ctx.root, dir))) {
    throw new Error("workspace metadata directory escapes workspace");
  }
  return dir;
}

async function safeTrashDir(ctx: ToolContext): Promise<string> {
  const dir = join(await safeMetadataDir(ctx), "trash");
  await mkdir(dir, { recursive: true });
  const link = await lstat(dir);
  if (link.isSymbolicLink()) {
    throw new Error("workspace trash directory is a symlink");
  }
  if (!(await isWithinRealRoot(ctx.root, dir))) {
    throw new Error("workspace trash directory escapes workspace");
  }
  return dir;
}

function mutationRetainedReason(error: unknown, fallback: string): string {
  return `${failureReason(error, fallback)}; visible mutation retained because rollback cannot be made atomic`;
}

function expectedSha256Mismatch(currentSha256: string): Error & { currentSha256: string } {
  return Object.assign(new Error("expectedSha256 does not match current file"), {
    code: "ESTALE",
    currentSha256,
  });
}

function isExpectedSha256Mismatch(
  error: unknown,
): error is Error & { currentSha256: string } {
  return (
    error instanceof Error &&
    typeof (error as { currentSha256?: unknown }).currentSha256 === "string"
  );
}

async function writeFileAtomicallyForTool(
  ctx: ToolContext,
  normalizedPath: string,
  data: string | Buffer,
  options: { expectedSha256?: string; overwrite?: boolean } = {},
): Promise<void> {
  const target = await safeResolveForMutation(ctx, normalizedPath);
  const absolutePath = target.absolute;
  const parentDir = dirname(target.absolute);
  const tempPath = join(parentDir, `.dohc-write-${process.pid}-${randomUUID()}.tmp`);
  let published = false;
  let existingMode: number | undefined;
  const publishTarget = async (): Promise<string> => {
    const current = await safeResolveForMutation(ctx, normalizedPath);
    if (current.absolute !== absolutePath) {
      throw Object.assign(new Error(`path changed before publish: ${normalizedPath}`), {
        code: "EINVAL",
      });
    }
    return current.absolute;
  };
  const assertExpectedCurrent = async (): Promise<void> => {
    if (options.expectedSha256 === undefined) return;
    const finalPath = await publishTarget();
    const existing = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing to overwrite symlink: ${absolutePath}`), {
        code: "ELOOP",
      });
    }
    if (existing && !existing.isFile()) {
      throw Object.assign(new Error(`refusing to overwrite non-file: ${absolutePath}`), {
        code: "EISDIR",
      });
    }
    const currentBytes = existing ? await readFile(finalPath) : Buffer.alloc(0);
    const currentSha256 = sha256(currentBytes);
    if (currentSha256 !== options.expectedSha256) {
      throw expectedSha256Mismatch(currentSha256);
    }
  };
  if (options.overwrite !== false) {
    const existing = await lstat(await publishTarget()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing to overwrite symlink: ${absolutePath}`), {
        code: "ELOOP",
      });
    }
    if (existing && !existing.isFile()) {
      throw Object.assign(new Error(`refusing to overwrite non-file: ${absolutePath}`), {
        code: "EISDIR",
      });
    }
    existingMode = existing ? existing.mode & 0o777 : undefined;
  }
  try {
    await writeFile(tempPath, data, { flag: "wx" });
    if (existingMode !== undefined) await chmod(tempPath, existingMode);
    await assertExpectedCurrent();
    const finalPath = await publishTarget();
    if (options.overwrite === false) {
      await link(tempPath, finalPath);
      published = true;
      await rm(tempPath, { force: true }).catch(() => undefined);
    } else {
      await rename(tempPath, finalPath);
      published = true;
    }
  } finally {
    if (!published) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

const requireFromHere = createRequire(import.meta.url);
interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}
function nodeSqlite(): SqliteModule {
  return requireFromHere("node:sqlite") as SqliteModule;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// --- workspace filesystem ---------------------------------------------------

type WorkspaceFileKind = "file" | "directory";
type WorkspaceSearchMode = "content" | "path" | "both";
type WorkspaceSearchMatch =
  | {
      type: "content";
      path: string;
      mediaType: string;
      line: number;
      column: number;
      preview: string;
    }
  | {
      type: "path";
      path: string;
      mediaType?: string;
      preview: string;
    };

export async function listWorkspaceFiles(
  ctx: ToolContext,
  args: { path?: string; recursive?: boolean } = {},
): Promise<
  | {
      ok: true;
      root: string;
      entries: Array<{ path: string; kind: WorkspaceFileKind; bytes?: number; mediaType?: string }>;
    }
  | { ok: false; reason: string }
> {
  const root =
    args.path && args.path.trim().length > 0
      ? await safeResolve(ctx, args.path, "read")
      : { ok: true as const, absolute: ctx.root, normalized: "" };
  if (!root.ok) return { ok: false as const, reason: root.reason };

  const entries: Array<{ path: string; kind: WorkspaceFileKind; bytes?: number; mediaType?: string }> = [];
  const recursive = args.recursive ?? true;

  async function walk(absolute: string, prefix: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (hasIgnoredSegment(rel) || dirent.isSymbolicLink()) continue;
      const child = join(absolute, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, kind: "directory" });
        if (recursive) await walk(child, rel);
      } else if (dirent.isFile()) {
        const info = await stat(child);
        entries.push({
          path: rel,
          kind: "file",
          bytes: info.size,
          mediaType: mediaTypeForPath(rel) ?? "application/octet-stream",
        });
      }
    }
  }

  const info = await lstat(root.absolute).catch(() => null);
  if (!info) return { ok: false as const, reason: `path not found: ${args.path ?? "."}` };
  if (info.isDirectory()) {
    await walk(root.absolute, root.normalized);
  } else if (info.isFile()) {
    const file = await stat(root.absolute);
    entries.push({
      path: root.normalized,
      kind: "file",
      bytes: file.size,
      mediaType: mediaTypeForPath(root.normalized) ?? "application/octet-stream",
    });
  } else {
    return { ok: false as const, reason: `not a file or directory: ${args.path ?? "."}` };
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true as const, root: root.normalized, entries };
}

// Secret-backed files (PR 08, plan agent-access default = DENY): dohc-
// controlled agent surfaces never share secret file contents. The floor is
// the same classifyEngineFilePath rule the engine enforces everywhere —
// policy files can never unmark it.
const SECRET_READ_DENIED_REASON =
  "This file is protected: secret-backed files (like .env) are never shared with agents through dohc tools. Agent access to secret contents is denied by default.";

function isSecretWorkspacePath(normalizedPath: string): boolean {
  // Read-aware: a mounted `shared-with-me/alex/.env` classifies as the mount
  // sees it (secret), where the write-side classifier would say "ignored"
  // and wave it through the floor.
  return classifyEngineFilePathForRead(normalizedPath).kind === "secret";
}

export async function readWorkspaceFile(
  ctx: ToolContext,
  args: {
    path: string;
    encoding?: "utf8" | "base64";
    maxBytes?: number;
    offsetBytes?: number;
  },
) {
  const resolved = await safeResolve(ctx, args.path, "read");
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  if (isSecretWorkspacePath(resolved.normalized)) {
    return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
  }
  // The alias check above classifies the REQUESTED path, but the read below
  // follows symlinks: an in-workspace link (notes.md -> .env) passes both
  // guards while the bytes come from the secret. Classify the resolved real
  // target too, so no alias can read protected contents.
  const realTarget = await realpath(resolved.absolute).catch(() => null);
  if (realTarget) {
    const realRoot = await realpath(ctx.root).catch(() => null);
    if (!realRoot) {
      return { ok: false as const, reason: `path rejected (workspace root unresolvable): ${args.path}` };
    }
    if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
      const relativeReal = realTarget
        .slice(realRoot.length)
        .split(sep)
        .filter((segment) => segment.length > 0)
        .join("/");
      if (relativeReal && isSecretWorkspacePath(relativeReal)) {
        return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
      }
    }
  }
  try {
    const maxBytes = Math.min(
      HARD_READ_MAX_BYTES,
      Math.max(1, Math.floor(args.maxBytes ?? DEFAULT_READ_MAX_BYTES)),
    );
    const read = await readFileWindowWithDigest(
      resolved.absolute,
      Math.max(0, Math.floor(args.offsetBytes ?? 0)),
      maxBytes,
    );
    const encoding = args.encoding ?? "utf8";
    return {
      ok: true as const,
      path: resolved.normalized,
      mediaType: mediaTypeForPath(resolved.normalized) ?? "application/octet-stream",
      encoding,
      bytes: read.bytes,
      offsetBytes: read.offsetBytes,
      sha256: read.sha256,
      truncated: read.truncated,
      content:
        encoding === "base64" ? read.window.toString("base64") : read.window.toString("utf8"),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to read: ${args.path}`),
    };
  }
}

function isSearchableText(mediaType: string, path: string, bytes: Buffer): boolean {
  const lower = `${mediaType} ${path}`.toLowerCase();
  if (
    lower.includes("image/") ||
    lower.includes("audio/") ||
    lower.includes("video/") ||
    lower.includes("pdf") ||
    lower.includes("sqlite") ||
    lower.endsWith(".db")
  ) {
    return false;
  }
  return !bytes.includes(0);
}

function pathMatchesQuery(
  path: string,
  query: string,
  caseSensitive: boolean,
  regex: RegExp | null,
): boolean {
  if (regex) {
    regex.lastIndex = 0;
    return regex.test(path);
  }
  return caseSensitive
    ? path.includes(query)
    : path.toLowerCase().includes(query.toLowerCase());
}

function fixedStringIndexes(line: string, query: string, caseSensitive: boolean): number[] {
  const indexes: number[] = [];
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + Math.max(1, needle.length))
  ) {
    indexes.push(index);
  }
  return indexes;
}

function regexIndexes(line: string, regex: RegExp): number[] {
  const indexes: number[] = [];
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(line);
    if (!match) break;
    indexes.push(match.index);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return indexes;
}

function previewLine(line: string, matchIndex: number): string {
  if (line.length <= SEARCH_PREVIEW_CHARS) return line;
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(line.length, start + SEARCH_PREVIEW_CHARS);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

export async function searchWorkspaceFiles(
  ctx: ToolContext,
  args: {
    query: string;
    path?: string;
    mode?: WorkspaceSearchMode;
    caseSensitive?: boolean;
    regex?: boolean;
    maxResults?: number;
    maxFileBytes?: number;
  },
): Promise<
  | {
      ok: true;
      query: string;
      root: string;
      mode: WorkspaceSearchMode;
      matches: WorkspaceSearchMatch[];
      matchCount: number;
      limitHit: boolean;
      skipped: Array<{ path: string; reason: string }>;
    }
  | { ok: false; reason: string }
> {
  if (args.query.length === 0) {
    return { ok: false as const, reason: "query must not be empty" };
  }
  const root =
    args.path && args.path.trim().length > 0
      ? await safeResolve(ctx, args.path, "read")
      : { ok: true as const, absolute: ctx.root, normalized: "" };
  if (!root.ok) return { ok: false as const, reason: root.reason };

  let regex: RegExp | null = null;
  if (args.regex) {
    try {
      regex = new RegExp(args.query, `g${args.caseSensitive ? "" : "i"}`);
    } catch (error) {
      return { ok: false as const, reason: failureReason(error, "invalid regex") };
    }
  }

  const mode = args.mode ?? "both";
  const caseSensitive = args.caseSensitive ?? false;
  const maxResults = Math.min(
    HARD_SEARCH_MAX_RESULTS,
    Math.max(1, Math.floor(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS)),
  );
  const maxFileBytes = Math.min(
    HARD_READ_MAX_BYTES,
    Math.max(1, Math.floor(args.maxFileBytes ?? DEFAULT_SEARCH_MAX_FILE_BYTES)),
  );
  const matches: WorkspaceSearchMatch[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let limitHit = false;

  function pushMatch(match: WorkspaceSearchMatch): boolean {
    if (matches.length >= maxResults) {
      limitHit = true;
      return false;
    }
    matches.push(match);
    if (matches.length >= maxResults) {
      limitHit = true;
      return false;
    }
    return true;
  }

  async function searchFile(absolute: string, relativePath: string): Promise<boolean> {
    // Secret floor (PR 08): never search protected files — neither their
    // contents nor a path hit that would carry a preview. The skip is
    // reported honestly instead of silently vanishing.
    if (isSecretWorkspacePath(relativePath)) {
      skipped.push({ path: relativePath, reason: "protected file (secret contents are never searched)" });
      return true;
    }
    const info = await stat(absolute);
    const mediaType = mediaTypeForPath(relativePath) ?? "application/octet-stream";

    if (mode !== "content" && pathMatchesQuery(relativePath, args.query, caseSensitive, regex)) {
      if (!pushMatch({ type: "path", path: relativePath, mediaType, preview: relativePath })) {
        return false;
      }
    }

    if (mode === "path") return true;
    if (info.size > maxFileBytes) {
      skipped.push({ path: relativePath, reason: `file exceeds maxFileBytes (${info.size})` });
      return true;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      skipped.push({ path: relativePath, reason: failureReason(error, "read failed") });
      return true;
    }
    if (!isSearchableText(mediaType, relativePath, bytes)) {
      skipped.push({ path: relativePath, reason: "binary or unsupported text encoding" });
      return true;
    }

    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      const indexes = regex
        ? regexIndexes(line, regex)
        : fixedStringIndexes(line, args.query, caseSensitive);
      for (const matchIndex of indexes) {
        if (
          !pushMatch({
            type: "content",
            path: relativePath,
            mediaType,
            line: lineIndex + 1,
            column: matchIndex + 1,
            preview: previewLine(line, matchIndex),
          })
        ) {
          return false;
        }
      }
    }
    return true;
  }

  async function walk(absolute: string, prefix: string): Promise<boolean> {
    const info = await lstat(absolute).catch(() => null);
    if (!info) {
      skipped.push({ path: prefix || ".", reason: "path not found" });
      return true;
    }
    if (info.isSymbolicLink()) return true;
    if (info.isFile()) return searchFile(absolute, prefix);
    if (!info.isDirectory()) {
      skipped.push({ path: prefix || ".", reason: "not a file or directory" });
      return true;
    }

    const dirents = await readdir(absolute, { withFileTypes: true }).catch((error: unknown) => {
      skipped.push({ path: prefix || ".", reason: failureReason(error, "directory read failed") });
      return null;
    });
    if (!dirents) return true;
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (hasIgnoredSegment(rel) || dirent.isSymbolicLink()) continue;
      const child = join(absolute, dirent.name);
      if (!(await walk(child, rel))) return false;
    }
    return true;
  }

  try {
    await walk(root.absolute, root.normalized);
  } catch (error) {
    return { ok: false as const, reason: failureReason(error, "search failed") };
  }

  return {
    ok: true as const,
    query: args.query,
    root: root.normalized,
    mode,
    matches,
    matchCount: matches.length,
    limitHit,
    skipped,
  };
}

export async function writeWorkspaceFile(
  ctx: ToolContext,
  args: {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    expectedSha256?: string;
    summary?: string;
  },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;

  const bytes =
    args.encoding === "base64"
      ? Buffer.from(args.content, "base64")
      : Buffer.from(args.content, "utf8");
  const parentDir = dirname(resolved.absolute);
  let visibleMutationStarted = false;
  try {
    const createdParent = await mkdir(parentDir, { recursive: true });
    if (createdParent) visibleMutationStarted = true;
    await writeFileAtomicallyForTool(ctx, resolved.normalized, bytes, {
      expectedSha256: args.expectedSha256,
    });
    visibleMutationStarted = true;
  } catch (error) {
    if (isExpectedSha256Mismatch(error)) {
      return {
        ok: false as const,
        reason: error.message,
        currentSha256: error.currentSha256,
      };
    }
    return {
      ok: false as const,
      reason: visibleMutationStarted
        ? mutationRetainedReason(error, `failed to write: ${args.path}`)
        : failureReason(error, `failed to write: ${args.path}`),
    };
  }
  return {
    ok: true as const,
    path: resolved.normalized,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...(await recordedChangeFields(ctx)),
  };
}

export async function createWorkspaceDirectory(
  ctx: ToolContext,
  args: { path: string; summary?: string },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  try {
    const existing = await lstat(resolved.absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (existing.isDirectory()) {
        return { ok: true as const, path: resolved.normalized, unchanged: true as const };
      }
      return {
        ok: false as const,
        reason: `path already exists and is not a directory: ${args.path}`,
      };
    }
    const createdPath = await mkdir(resolved.absolute, { recursive: true });
    if (!createdPath) {
      return { ok: true as const, path: resolved.normalized, unchanged: true as const };
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to create directory: ${args.path}`),
    };
  }
  return {
    ok: true as const,
    path: resolved.normalized,
    ...(await recordedChangeFields(ctx)),
  };
}

export async function moveWorkspacePath(
  ctx: ToolContext,
  args: { fromPath: string; toPath: string; overwrite?: boolean; summary?: string },
) {
  const from = await safeResolve(ctx, args.fromPath);
  if (!from.ok) return { ok: false as const, reason: from.reason };
  const to = await safeResolve(ctx, args.toPath);
  if (!to.ok) return { ok: false as const, reason: to.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  if (to.normalized === from.normalized || to.normalized.startsWith(`${from.normalized}/`)) {
    return { ok: false as const, reason: `cannot move a path into itself: ${args.fromPath}` };
  }
  const destinationExists = await lstat(to.absolute).then(
    () => true,
    () => false,
  );
  if (destinationExists && !args.overwrite) {
    return { ok: false as const, reason: `destination already exists: ${args.toPath}` };
  }
  await mkdir(dirname(to.absolute), { recursive: true });
  try {
    await rename(from.absolute, to.absolute);
    return {
      ok: true as const,
      fromPath: from.normalized,
      toPath: to.normalized,
      ...(await recordedChangeFields(ctx)),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to move: ${args.fromPath}`),
    };
  }
}

export async function deleteWorkspacePath(
  ctx: ToolContext,
  args: { path: string; summary?: string },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  try {
    await lstat(resolved.absolute);
    const trashDir = await safeTrashDir(ctx);
    const trashedTo = join(
      trashDir,
      `${Date.now()}-${randomUUID()}-${basename(resolved.normalized)}`,
    );
    await rename(resolved.absolute, trashedTo);
    return {
      ok: true as const,
      path: resolved.normalized,
      trashed: true,
      ...(await recordedChangeFields(ctx)),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to delete: ${args.path}`),
    };
  }
}

// --- dohc_list_workspaces / cloud binding helpers ---------------------------

interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
  ownerUserId: string;
}

interface RegistryWorkspace {
  workspaceId: string;
  rootPath: string;
  kind: string;
  mode?: string;
  remote?: RemoteIdentity;
}

interface RegistryFile {
  version?: number;
  workspaces?: RegistryWorkspace[];
}

interface SyncManifest {
  workspaceId?: string;
  serverUrl?: string;
  remoteWorkspaceId?: string;
}

type CloudCredentialLoad =
  | {
      ok: true;
      status: "available";
      serverUrl: string;
      email: string;
      userId: string;
      token: string;
    }
  | { ok: false; status: "missing" | "encrypted" | "invalid"; reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

async function readRegistry(ctx: ToolContext): Promise<RegistryFile | null> {
  return readJson<RegistryFile>(join(ctx.home, "dohc-workspaces.json"));
}

async function readSyncManifest(ctx: ToolContext): Promise<SyncManifest | null> {
  return readJson<SyncManifest>(join(ctx.root, ".dohc", "sync-manifest.json"));
}

async function findWorkspaceEntry(ctx: ToolContext): Promise<RegistryWorkspace | null> {
  const registry = await readRegistry(ctx);
  const workspaces = registry?.workspaces ?? [];
  const realRoot = await realpath(ctx.root).catch(() => ctx.root);
  for (const workspace of workspaces) {
    if (workspace.rootPath === ctx.root) return workspace;
    const realWorkspaceRoot = await realpath(workspace.rootPath).catch(() => workspace.rootPath);
    if (realWorkspaceRoot === realRoot) return workspace;
  }
  return null;
}

function validRemote(remote: unknown): remote is RemoteIdentity {
  return (
    remote !== null &&
    typeof remote === "object" &&
    nonEmptyString((remote as RemoteIdentity).serverUrl) &&
    nonEmptyString((remote as RemoteIdentity).remoteWorkspaceId) &&
    nonEmptyString((remote as RemoteIdentity).ownerUserId)
  );
}

async function remoteForCurrentWorkspace(
  ctx: ToolContext,
): Promise<(RemoteIdentity & { workspaceId?: string }) | null> {
  const entry = await findWorkspaceEntry(ctx);
  if (validRemote(entry?.remote)) {
    return { workspaceId: entry?.workspaceId, ...entry.remote };
  }
  return null;
}

async function loadCloudCredentials(ctx: ToolContext): Promise<CloudCredentialLoad> {
  if (
    process.env.DOHC_MCP_CLOUD_TOKEN ||
    process.env.DOHC_MCP_CLOUD_SERVER_URL ||
    process.env.DOHC_MCP_CLOUD_EMAIL ||
    process.env.DOHC_MCP_CLOUD_USER_ID
  ) {
    if (
      nonEmptyString(process.env.DOHC_MCP_CLOUD_TOKEN) &&
      nonEmptyString(process.env.DOHC_MCP_CLOUD_SERVER_URL) &&
      nonEmptyString(process.env.DOHC_MCP_CLOUD_USER_ID)
    ) {
      return {
        ok: true,
        status: "available",
        serverUrl: process.env.DOHC_MCP_CLOUD_SERVER_URL,
        email: process.env.DOHC_MCP_CLOUD_EMAIL ?? "desktop",
        userId: process.env.DOHC_MCP_CLOUD_USER_ID,
        token: process.env.DOHC_MCP_CLOUD_TOKEN,
      };
    }
    return {
      ok: false,
      status: "invalid",
      reason: "dohc MCP cloud environment is incomplete.",
    };
  }

  const credentials = await readJson<{
    version?: unknown;
    serverUrl?: unknown;
    email?: unknown;
    userId?: unknown;
    token?: unknown;
  }>(join(ctx.home, "dohc-cloud.json"));
  if (
    !credentials ||
    credentials.version !== 1 ||
    !nonEmptyString(credentials.serverUrl) ||
    !nonEmptyString(credentials.email) ||
    !nonEmptyString(credentials.userId) ||
    !nonEmptyString(credentials.token)
  ) {
    return { ok: false, status: "missing", reason: "Sign in to dohc Cloud first." };
  }

  if (credentials.token.startsWith("plain:")) {
    const token = credentials.token.slice("plain:".length);
    if (!token) {
      return { ok: false, status: "invalid", reason: "dohc Cloud session token is empty." };
    }
    return {
      ok: true,
      status: "available",
      serverUrl: credentials.serverUrl,
      email: credentials.email,
      userId: credentials.userId,
      token,
    };
  }

  if (credentials.token.startsWith("enc:")) {
    return {
      ok: false,
      status: "encrypted",
      reason:
        "dohc Cloud session is encrypted by Desktop safeStorage; open dohc Desktop or use a desktop-brokered MCP session to sync.",
    };
  }

  return { ok: false, status: "invalid", reason: "dohc Cloud session token has an unknown format." };
}

function credentialStatusFor(
  remote: RemoteIdentity | null,
  credentials: CloudCredentialLoad,
):
  | {
      cloudConnected: false;
      credentialStatus:
        | "not-needed"
        | "missing"
        | "encrypted"
        | "invalid"
        | "server-mismatch"
        | "account-mismatch";
    }
  | { cloudConnected: true; credentialStatus: "available" } {
  if (!remote) return { cloudConnected: false, credentialStatus: "not-needed" };
  if (!credentials.ok) {
    return { cloudConnected: false, credentialStatus: credentials.status };
  }
  if (normalizeServerUrl(credentials.serverUrl) !== normalizeServerUrl(remote.serverUrl)) {
    return { cloudConnected: false, credentialStatus: "server-mismatch" };
  }
  if (credentials.userId !== remote.ownerUserId) {
    return { cloudConnected: false, credentialStatus: "account-mismatch" };
  }
  return { cloudConnected: true, credentialStatus: "available" };
}

export async function listWorkspaces(ctx: ToolContext) {
  const registry = await readRegistry(ctx);
  const workspaces = (registry?.workspaces ?? []).map((w) => ({
    workspaceId: w.workspaceId,
    rootPath: w.rootPath,
    kind: w.kind,
    ...(w.remote ? { remote: w.remote } : {}),
  }));
  return { workspaces };
}

// --- dohc_workspace_status --------------------------------------------------

export async function workspaceStatus(ctx: ToolContext) {
  const [manifest, remote, credentials] = await Promise.all([
    readSyncManifest(ctx),
    remoteForCurrentWorkspace(ctx),
    loadCloudCredentials(ctx),
  ]);
  const remoteWorkspaceId = remote?.remoteWorkspaceId ?? manifest?.remoteWorkspaceId;
  const serverUrl = remote?.serverUrl ?? manifest?.serverUrl;
  const synced = !!remoteWorkspaceId;
  const credential = credentialStatusFor(remote, credentials);
  return {
    synced,
    scope: synced ? ("cloud" as const) : ("local" as const),
    ...credential,
    ...(manifest?.workspaceId ?? remote?.workspaceId
      ? { workspaceId: manifest?.workspaceId ?? remote?.workspaceId }
      : {}),
    ...(remoteWorkspaceId ? { remoteWorkspaceId } : {}),
    ...(serverUrl ? { serverUrl } : {}),
  };
}

// Legacy cloud sync (dohc_sync_now / dohc_sync_cloud) was removed together with
// the retired workspace-api file/sync routes (/workspaces/:id/files,
// /sync/apply). Cloud sync is now automatic per workspace via the sync relay;
// workspace history is read through dohc_list_changes (engine moments) below.

// --- dohc_list_changes / dohc_read_change ----------------------------------

// The workspace engine is the sole recorder of history, but desktop main is
// the sole owner of its database. These tools read moments through the CLI
// transport. The pre-flip legacy `.dohc/history` change-set relic was retired;
// a moment carries path/operation/versionId (the legacy kind,
// boundaryCrossings, and provenance fields no longer exist and are never
// faked).

const LIST_CHANGES_HARD_LIMIT = 500;

export async function listChanges(
  ctx: ToolContext,
  args: { sinceMs?: number; limit?: number; includeFiles?: boolean } = {},
) {
  return requestCli(ctx, "moments", {
    ...args,
    ...(args.limit !== undefined
      ? { limit: Math.min(LIST_CHANGES_HARD_LIMIT, Math.max(1, Math.floor(args.limit))) }
      : {}),
  });
}

export async function readChange(ctx: ToolContext, args: { id: string }) {
  return requestCli(ctx, "moment", args);
}

// --- dohc site tools --------------------------------------------------------

type RawDohcSiteConfig = Partial<Record<keyof DohcSiteConfig, unknown>> &
  Record<string, unknown>;

type SiteCheck = {
  name: string;
  ok: boolean;
  message?: string;
  path?: string;
};

const LEGACY_APPS_SEGMENT = `.${"apps"}`;
const SITE_SCAN_IGNORED_NAMES = new Set([
  ".cache",
  ".dohc",
  ".git",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "coverage",
  "node_modules",
]);
const SITE_BUILD_OUTPUT_NAMES = ["dist", "build", "out"];
const SITE_SOURCE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".ts",
  ".tsx",
  ".css",
]);
const MAX_SITE_TEST_BYTES = 2 * 1024 * 1024;
const MAX_SITE_SCAN_DEPTH = 100;
let cachedDohcSdkPackageVersion: {
  packageJsonPath: string;
  mtimeMs: number;
  version: string;
} | null = null;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeJoin(prefix: string, name: string): string {
  return prefix && prefix !== "." ? `${prefix}/${name}` : name;
}

function hasLegacyAppsSegment(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => segment.toLowerCase() === LEGACY_APPS_SEGMENT);
}

function sitePathAllowed(path: string): { ok: true } | { ok: false; reason: string } {
  if (hasLegacyAppsSegment(path)) {
    return { ok: false, reason: `site tools do not operate on legacy ${LEGACY_APPS_SEGMENT} paths` };
  }
  return { ok: true };
}

function isIgnoredSitePath(path: string): boolean {
  if (!path) return false;
  if (hasIgnoredSegment(path) || hasLegacyAppsSegment(path)) return true;
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) => SITE_SCAN_IGNORED_NAMES.has(segment.toLowerCase()));
}

function siteTitleFromPath(root: string): string {
  const name = basename(root) || "Site";
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function packageNameFromPath(root: string): string {
  const name = basename(root) || "site";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "site";
}

function readPackageScripts(pkg: PackageJson | null): SiteScripts {
  if (!pkg || !isRecord(pkg.scripts)) return {};
  const scripts: SiteScripts = {};
  for (const key of ["dev", "start", "build", "preview"] as const) {
    const value = pkg.scripts[key];
    if (typeof value === "string" && value.trim()) scripts[key] = value;
  }
  return scripts;
}

function configString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === "string" && found.trim() ? found : undefined;
}

async function readJsonDetailed<T>(
  absolute: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(absolute, "utf8")) as T };
  } catch (error) {
    return { ok: false, reason: failureReason(error, "invalid JSON") };
  }
}

type DohcSdkDependency =
  | { specifier: string; sourceDir: null }
  | { specifier: string; sourceDir: string; version: string };

async function dohcSdkDependency(ctx: ToolContext): Promise<DohcSdkDependency> {
  const explicitRange = ctx.sdkDependencyRange?.trim();
  const packageJsonPath = ctx.sdkPackageJsonPath?.trim();
  if (!packageJsonPath) {
    if (explicitRange) return { specifier: explicitRange, sourceDir: null };
    throw new Error(
      "MCP server configuration is missing @dohc/sdk package metadata; launch with --sdk-package-json or set DOHC_SDK_PACKAGE_JSON",
    );
  }

  const packageStat = await stat(packageJsonPath);
  if (
    cachedDohcSdkPackageVersion?.packageJsonPath === packageJsonPath &&
    cachedDohcSdkPackageVersion.mtimeMs === packageStat.mtimeMs
  ) {
    return {
      specifier: explicitRange || "file:vendor/dohc-sdk",
      sourceDir: dirname(packageJsonPath),
      version: cachedDohcSdkPackageVersion.version,
    };
  }

  const pkg = await readJson<{ version?: unknown }>(packageJsonPath);
  const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error(`Unable to read @dohc/sdk version from ${packageJsonPath}`);
  }
  cachedDohcSdkPackageVersion = { packageJsonPath, mtimeMs: packageStat.mtimeMs, version };
  return {
    specifier: explicitRange || "file:vendor/dohc-sdk",
    sourceDir: dirname(packageJsonPath),
    version,
  };
}

async function detectSiteAt(ctx: ToolContext, absolute: string, root: string): Promise<WorkspaceSite | null> {
  let dirents;
  try {
    dirents = await readdir(absolute, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = new Set(dirents.filter((dirent) => dirent.isFile()).map((dirent) => dirent.name));
  const directories = new Set(
    dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name),
  );
  const allNames = new Set([...files, ...directories]);
  const diagnostics: SiteDiagnostic[] = [];
  const configPath = files.has("dohc.json") ? relativeJoin(root, "dohc.json") : undefined;
  let config: RawDohcSiteConfig | null = null;
  if (configPath) {
    const parsed = await readJsonDetailed<RawDohcSiteConfig>(join(ctx.root, configPath));
    if (parsed.ok) {
      config = parsed.value;
    } else {
      diagnostics.push({
        severity: "error",
        code: "invalid_dohc_json",
        path: configPath,
        message: parsed.reason,
      });
    }
  }

  let pkg: PackageJson | null = null;
  if (files.has("package.json")) {
    const parsed = await readJsonDetailed<PackageJson>(join(absolute, "package.json"));
    if (parsed.ok) {
      pkg = parsed.value;
    } else {
      diagnostics.push({
        severity: "error",
        code: "invalid_package_json",
        path: relativeJoin(root, "package.json"),
        message: parsed.reason,
      });
    }
  }

  const scripts = readPackageScripts(pkg);
  const configPreviewCommand = configString(config?.preview, "command");
  const configPreviewMode = configString(config?.preview, "mode");
  if (configPreviewCommand) {
    if (configPreviewMode === "dev") scripts.dev = configPreviewCommand;
    else scripts.preview = configPreviewCommand;
  }
  const configBuildCommand = configString(config?.build, "command");
  if (configBuildCommand) scripts.build = configBuildCommand;

  const frameworkConfig = frameworkConfigName(files);
  const hasIndex = files.has("index.html");
  const hasPackageSignal =
    files.has("package.json") &&
    (Object.keys(scripts).length > 0 || Boolean(frameworkConfig) || hasWebDependency(pkg));
  const buildOutputs = [
    configString(config?.build, "output"),
    ...SITE_BUILD_OUTPUT_NAMES.filter((name) => directories.has(name)),
  ].filter((output): output is string => typeof output === "string" && output.length > 0);
  const uniqueBuildOutputs = [...new Set(buildOutputs)];
  const explicitNonSite = config?.type !== undefined && config.type !== "site";

  if (
    explicitNonSite &&
    !hasIndex &&
    !hasPackageSignal &&
    !frameworkConfig &&
    uniqueBuildOutputs.length === 0
  ) {
    return null;
  }
  if (explicitNonSite) {
    diagnostics.push({
      severity: "warning",
      code: "unexpected_dohc_type",
      path: configPath ?? relativeJoin(root, "dohc.json"),
      message: "dohc.json has website signals but its type is not \"site\".",
    });
  }

  if (!configPath && !hasIndex && !hasPackageSignal && !frameworkConfig && uniqueBuildOutputs.length === 0) {
    return null;
  }

  const kind: SiteKind = configPath ? "configured" : hasPackageSignal || frameworkConfig ? "package" : "static";
  const confidence: SiteConfidence =
    configPath && diagnostics.every((diagnostic) => diagnostic.severity !== "error")
      ? "high"
      : hasIndex && (hasPackageSignal || frameworkConfig)
        ? "high"
        : hasIndex || hasPackageSignal || frameworkConfig
          ? "medium"
          : "low";
  const configuredTitle = typeof config?.title === "string" && config.title.trim() ? config.title : undefined;
  const packageTitle = typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  let builtEntry: string | undefined;
  for (const name of SITE_BUILD_OUTPUT_NAMES) {
    if (!directories.has(name)) continue;
    const candidate = join(absolute, name, "index.html");
    if (await stat(candidate).catch(() => null)) {
      builtEntry = relativeJoin(relativeJoin(root, name), "index.html");
      break;
    }
  }
  const entry = hasIndex ? relativeJoin(root, "index.html") : builtEntry;
  const packageManager = packageManagerFromFiles(allNames, pkg);

  return {
    root,
    title: configuredTitle ?? packageTitle ?? siteTitleFromPath(root),
    kind,
    confidence,
    ...(entry ? { entry } : {}),
    ...(packageManager ? { packageManager } : {}),
    scripts,
    buildOutputs: uniqueBuildOutputs,
    ...(configPath ? { configPath } : {}),
    diagnostics,
  };
}

export async function detectSites(
  ctx: ToolContext,
  args: { path?: string; maxDepth?: number } = {},
): Promise<{ ok: true; sites: WorkspaceSite[]; count: number; detector: "mcp-local" } | { ok: false; reason: string }> {
  const start =
    args.path && args.path.trim().length > 0
      ? await safeResolve(ctx, args.path, "read")
      : { ok: true as const, absolute: ctx.root, normalized: "" };
  if (!start.ok) return { ok: false as const, reason: start.reason };
  const allowed = sitePathAllowed(start.normalized);
  if (!allowed.ok) return allowed;

  const info = await lstat(start.absolute).catch(() => null);
  if (!info) return { ok: false as const, reason: `path not found: ${args.path ?? "."}` };
  if (!info.isDirectory()) return { ok: false as const, reason: `not a directory: ${args.path ?? "."}` };

  const maxDepth = Math.min(12, Math.max(0, Math.floor(args.maxDepth ?? 5)));
  const sites: WorkspaceSite[] = [];
  async function walk(absolute: string, root: string, depth: number): Promise<void> {
    if (isIgnoredSitePath(root)) return;
    const site = await detectSiteAt(ctx, absolute, root);
    if (site) sites.push(site);
    if (depth >= maxDepth) return;

    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
      const childRoot = relativeJoin(root, dirent.name);
      if (isIgnoredSitePath(childRoot)) continue;
      await walk(join(absolute, dirent.name), childRoot, depth + 1);
    }
  }

  await walk(start.absolute, start.normalized, 0);
  sites.sort((a, b) => a.root.localeCompare(b.root));
  return { ok: true as const, sites, count: sites.length, detector: "mcp-local" };
}

export async function createSite(
  ctx: ToolContext,
  args: { path: string; title?: string; withDohcJson?: boolean },
) {
  const root = await safeResolve(ctx, args.path);
  if (!root.ok) return { ok: false as const, reason: root.reason };
  if (!root.normalized) return { ok: false as const, reason: "site path must name a folder" };
  const allowed = sitePathAllowed(root.normalized);
  if (!allowed.ok) return allowed;
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;

  const existing = await lstat(root.absolute).catch(() => null);
  if (existing && !existing.isDirectory()) {
    return { ok: false as const, reason: `site path is not a directory: ${root.normalized}` };
  }
  if (existing) {
    const entries = await readdir(root.absolute);
    if (entries.length > 0) {
      return { ok: false as const, reason: `site folder already exists and is not empty: ${root.normalized}` };
    }
  }

  const title = args.title?.trim() || siteTitleFromPath(root.normalized);
  const packageName = packageNameFromPath(root.normalized);
  const files = [
    {
      path: relativeJoin(root.normalized, "index.html"),
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main>
      <p class="eyebrow">Fresh Site</p>
      <h1>${escapeHtml(title)}</h1>
      <p>A clean local page, ready for the shape of the work.</p>
    </main>
    <script type="module" src="./script.js"></script>
  </body>
</html>
`,
    },
    {
      path: relativeJoin(root.normalized, "styles.css"),
      content: `:root {
  color: #151515;
  background: #f7f6f1;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
}

main {
  width: min(720px, calc(100vw - 48px));
}

.eyebrow {
  margin: 0 0 12px;
  color: #66635d;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 16px;
  font-size: 4rem;
  line-height: 0.96;
}

p {
  max-width: 56ch;
  font-size: 1.08rem;
  line-height: 1.6;
}

@media (max-width: 640px) {
  h1 {
    font-size: 2.25rem;
  }
}
`,
    },
    {
      path: relativeJoin(root.normalized, "script.js"),
      content: `document.documentElement.dataset.siteReady = "true";
`,
    },
    {
      path: relativeJoin(root.normalized, "scripts/build-static.mjs"),
      content: `import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const file of ["index.html", "styles.css", "script.js"]) {
  if (existsSync(file)) await copyFile(file, \`dist/\${file}\`);
}
`,
    },
    {
      path: relativeJoin(root.normalized, "package.json"),
      content: `${JSON.stringify(
        {
          name: packageName,
          private: true,
          type: "module",
          engines: {
            node: ">=14.8.0",
          },
          scripts: {
            dev: "serve . --listen 127.0.0.1:4173",
            build: "node scripts/build-static.mjs",
            preview: "serve dist --listen 127.0.0.1:4173",
          },
          devDependencies: {
            serve: "14.2.6",
          },
        },
        null,
        2,
      )}\n`,
    },
    ...(args.withDohcJson === false
      ? []
      : [
          {
            path: relativeJoin(root.normalized, "dohc.json"),
            content: `${JSON.stringify(
              {
                type: "site",
                title,
                preview: { mode: "static", entry: "index.html" },
                build: { command: "npm run build", output: "dist" },
              },
              null,
              2,
            )}\n`,
          },
        ]),
  ];

  const resolvedFiles = [];
  for (const file of files) {
    const resolved = await safeResolve(ctx, file.path);
    if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
    const fileAllowed = sitePathAllowed(resolved.normalized);
    if (!fileAllowed.ok) return fileAllowed;
    if (
      resolved.normalized !== root.normalized &&
      !resolved.normalized.startsWith(`${root.normalized}/`)
    ) {
      return { ok: false as const, reason: `not inside site: ${file.path}` };
    }
    if (await lstat(resolved.absolute).catch(() => null)) {
      return { ok: false as const, reason: `file already exists: ${resolved.normalized}` };
    }
    resolvedFiles.push({ ...file, ...resolved });
  }

  let visibleMutationStarted = false;
  try {
    await mkdir(root.absolute, { recursive: true });
    if (!existing) visibleMutationStarted = true;
    for (const file of resolvedFiles) {
      const parentDir = dirname(file.absolute);
      const createdParent = await mkdir(parentDir, { recursive: true });
      if (createdParent) visibleMutationStarted = true;
      await writeFileAtomicallyForTool(ctx, file.normalized, file.content, { overwrite: false });
      visibleMutationStarted = true;
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: visibleMutationStarted
        ? mutationRetainedReason(error, `failed to create site: ${root.normalized}`)
        : failureReason(error, `failed to create site: ${root.normalized}`),
    };
  }
  return {
    ok: true as const,
    siteRoot: root.normalized,
    files: resolvedFiles.map((file) => file.normalized),
    ...(await recordedChangeFields(ctx)),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function resolveSiteRoot(ctx: ToolContext, siteRoot: string) {
  const root = await safeResolve(ctx, siteRoot, "read");
  if (!root.ok) return root;
  // Mounted shares (shared-with-me/) are readable, but site tools execute
  // or mutate the site (test/build/preview/publish/add-sdk) — running
  // someone else's shared code with workspace access is refused. Copying
  // the site into the user's own files makes it runnable. The check is the
  // shared case-insensitive/alias-normalizing predicate, NOT a literal
  // compare: normalized paths preserve casing, and "Shared-With-Me/…" names
  // the same directory on case-insensitive filesystems (CodeRabbit).
  if (isSharedWithMePath(root.normalized)) {
    return {
      ok: false as const,
      reason: `site root is a mounted share (read-only): ${siteRoot} — copy it into your own files to run it`,
    };
  }
  const allowed = sitePathAllowed(root.normalized);
  if (!allowed.ok) return allowed;
  const info = await lstat(root.absolute).catch(() => null);
  if (!info) return { ok: false as const, reason: `site root not found: ${siteRoot}` };
  if (!info.isDirectory()) return { ok: false as const, reason: `site root is not a directory: ${siteRoot}` };
  return root;
}

export async function testSite(ctx: ToolContext, args: { siteRoot: string }) {
  const root = await resolveSiteRoot(ctx, args.siteRoot);
  if (!root.ok) return root;
  const site = await detectSiteAt(ctx, root.absolute, root.normalized);
  if (!site) return { ok: false as const, reason: `not a detected site: ${root.normalized}` };

  const checks: SiteCheck[] = [];
  checks.push({
    name: "detected-site",
    ok: true,
    path: root.normalized,
    message: `${site.kind} site detected with ${site.confidence} confidence.`,
  });
  for (const diagnostic of site.diagnostics) {
    checks.push({
      name: diagnostic.code,
      ok: diagnostic.severity !== "error",
      path: diagnostic.path,
      message: diagnostic.message,
    });
  }

  if (site.entry) {
    const entry = await safeResolve(ctx, site.entry, "read");
    const exists = entry.ok && Boolean(await lstat(entry.absolute).catch(() => null));
    checks.push({
      name: "entry-file",
      ok: exists,
      path: site.entry,
      message: exists ? "Entry file exists." : "Entry file is missing.",
    });
  } else if (!site.scripts.dev && !site.scripts.start && !site.scripts.build) {
    checks.push({
      name: "entry-or-script",
      ok: false,
      path: root.normalized,
      message: "Site needs an index.html entry or a package script.",
    });
  }

  const legacyImport = await findLegacyAppImport(root.absolute, root.normalized);
  checks.push(
    legacyImport
      ? {
          name: "no-legacy-sdk-import",
          ok: false,
          path: legacyImport.path,
          message:
            legacyImport.reason === "too-large"
              ? "Site source is too large for MCP static validation."
              : "Sites must use normal web files or @dohc/sdk, not the legacy app SDK.",
        }
      : {
          name: "no-legacy-sdk-import",
          ok: true,
          message: "No legacy app SDK import found in scanned site source.",
        },
  );

  const ok = checks.every((check) => check.ok);
  return { ok, site, checks };
}

async function findLegacyAppImport(
  absolute: string,
  root: string,
): Promise<{ path: string; reason: "legacy-import" | "too-large" } | null> {
  let totalBytes = 0;
  async function walk(
    currentAbsolute: string,
    currentRoot: string,
    depth: number,
  ): Promise<{ path: string; reason: "legacy-import" | "too-large" } | null> {
    if (depth > MAX_SITE_SCAN_DEPTH) return null;
    if (isIgnoredSitePath(currentRoot)) return null;
    let dirents;
    try {
      dirents = await readdir(currentAbsolute, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const dirent of dirents) {
      const rel = relativeJoin(currentRoot, dirent.name);
      if (dirent.isSymbolicLink() || isIgnoredSitePath(rel)) continue;
      const child = join(currentAbsolute, dirent.name);
      if (dirent.isDirectory()) {
        const found = await walk(child, rel, depth + 1);
        if (found) return found;
        continue;
      }
      if (!dirent.isFile() || !SITE_SOURCE_EXTENSIONS.has(fileExtension(dirent.name))) continue;
      const info = await stat(child);
      if (totalBytes + info.size > MAX_SITE_TEST_BYTES) {
        return { path: rel, reason: "too-large" };
      }
      totalBytes += info.size;
      if (hasLegacyAppImport(await readFile(child, "utf8"))) {
        return { path: rel, reason: "legacy-import" };
      }
    }
    return null;
  }
  return walk(absolute, root, 0);
}

function fileExtension(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index).toLowerCase() : "";
}

export async function buildSite(ctx: ToolContext, args: { siteRoot: string }) {
  const tested = await testSite(ctx, args);
  if (!tested.ok) return tested;
  const site = tested.site;
  const command = site.scripts.build;
  const output = site.buildOutputs[0] ?? (command ? "dist" : site.root);
  return {
    ok: true as const,
    status: command ? "planned" : "static-ready",
    siteRoot: site.root,
    command,
    output,
    message: command
      ? "Build command detected. MCP build execution is not wired yet; run this command in the site folder."
      : "No build command detected; the site can be previewed directly as static files.",
    checks: tested.checks,
  };
}

function previewModesForSite(site: WorkspaceSite) {
  const modes = [];
  if (site.entry) {
    modes.push({ mode: "static" as const, entry: site.entry });
  }
  if (site.scripts.dev || site.scripts.start) {
    modes.push({
      mode: "dev" as const,
      command: site.scripts.dev ? "dev" : "start",
      script: site.scripts.dev ?? site.scripts.start,
      packageManager: site.packageManager ?? "npm",
    });
  }
  if (site.scripts.build || site.buildOutputs.length > 0) {
    modes.push({
      mode: "build" as const,
      command: site.scripts.build,
      output: site.buildOutputs[0] ?? "dist",
      packageManager: site.packageManager ?? "npm",
    });
  }
  return modes;
}

export async function previewSite(ctx: ToolContext, args: { siteRoot: string }) {
  const tested = await testSite(ctx, args);
  if (!tested.ok) return tested;
  const site = tested.site;
  const modes = previewModesForSite(site);
  return {
    ok: true as const,
    siteRoot: site.root,
    modes,
    message:
      modes.length > 0
        ? "Open this site in the dohc Sites panel to run the preview."
        : "No preview mode is available yet.",
    checks: tested.checks,
  };
}

function ensureObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

export async function addSiteSdk(ctx: ToolContext, args: { siteRoot: string }) {
  const root = await resolveSiteRoot(ctx, args.siteRoot);
  if (!root.ok) return root;
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  // Detect before adding package.json: creating package metadata must not turn
  // a plain static site into a package-import workflow that browsers cannot
  // actually resolve without a bundler.
  const detectedSite = await detectSiteAt(ctx, root.absolute, root.normalized);

  const packagePath = join(root.absolute, "package.json");
  const existingBytes = await readFile(packagePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  const expectedPackageSha256 = sha256(existingBytes ?? new Uint8Array());
  let existing: PackageJson | null = null;
  if (existingBytes) {
    try {
      existing = JSON.parse(existingBytes.toString("utf8")) as PackageJson;
    } catch (error) {
      return {
        ok: false as const,
        reason: `invalid package.json at ${relativeJoin(root.normalized, "package.json")}: ${failureReason(error, "invalid JSON")}`,
      };
    }
  }
  const siteRootNames = new Set(
    (await readdir(root.absolute, { withFileTypes: true })).map((entry) => entry.name),
  );
  const usesPackageModuleResolution =
    Boolean(frameworkConfigName(siteRootNames)) ||
    hasWebDependency(existing) ||
    Object.keys(readPackageScripts(existing)).length > 0;
  const packageJson = ensureObject(existing);
  packageJson.private = packageJson.private ?? true;
  packageJson.type = packageJson.type ?? "module";
  packageJson.name =
    typeof packageJson.name === "string" && packageJson.name.trim()
      ? packageJson.name
      : packageNameFromPath(root.normalized);
  let sdk: DohcSdkDependency;
  try {
    sdk = await dohcSdkDependency(ctx);
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, "unable to resolve @dohc/sdk dependency range"),
    };
  }
  if (!usesPackageModuleResolution && !sdk.sourceDir) {
    return {
      ok: false as const,
      reason:
        "A plain static site needs bundled @dohc/sdk browser files; configure sdkPackageJsonPath so add_sdk can create a browser-resolvable import.",
    };
  }
  if (sdk.sourceDir) {
    let sdkJavaScript: string;
    let sdkTypes: string;
    try {
      [sdkJavaScript, sdkTypes] = await Promise.all([
        readFile(join(sdk.sourceDir, "dist", "index.js"), "utf8"),
        readFile(join(sdk.sourceDir, "dist", "index.d.ts"), "utf8"),
      ]);
    } catch (error) {
      return {
        ok: false as const,
        reason: failureReason(error, "unable to read the bundled @dohc/sdk browser files"),
      };
    }
    const vendorFiles = [
      {
        path: "vendor/dohc-sdk/package.json",
        content: `${JSON.stringify(
          {
            name: "@dohc/sdk",
            version: sdk.version,
            type: "module",
            types: "./dist/index.d.ts",
            exports: {
              ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "vendor/dohc-sdk/dist/index.js",
        content: sdkJavaScript,
      },
      {
        path: "vendor/dohc-sdk/dist/index.d.ts",
        content: sdkTypes,
      },
    ];
    for (const file of vendorFiles) {
      const path = relativeJoin(root.normalized, file.path);
      const existing = await readFile(join(ctx.root, path)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const writtenVendor = await writeWorkspaceFile(ctx, {
        path,
        content: file.content,
        expectedSha256: sha256(existing ?? new Uint8Array()),
        summary: `MCP installed the bundled @dohc/sdk in ${root.normalized}`,
      });
      if (!writtenVendor.ok) return writtenVendor;
    }
  }
  const dependencies = ensureObject(packageJson.dependencies);
  dependencies["@dohc/sdk"] = sdk.specifier;
  packageJson.dependencies = dependencies;

  const normalizedPackagePath = relativeJoin(root.normalized, "package.json");
  const written = await writeWorkspaceFile(ctx, {
    path: normalizedPackagePath,
    content: `${JSON.stringify(packageJson, null, 2)}\n`,
    expectedSha256: expectedPackageSha256,
    summary: `MCP added @dohc/sdk to ${root.normalized}`,
  });
  if (!written.ok) return written;

  const useVendoredBrowserImport = !usesPackageModuleResolution && sdk.sourceDir !== null;

  return {
    ok: true as const,
    siteRoot: root.normalized,
    packagePath: normalizedPackagePath,
    dependency: "@dohc/sdk",
    // Forward the write's history-recording shape honestly (recordedBy for
    // engine workspaces, historyRecording: "off" for opted-out ones).
    ...("recordedBy" in written
      ? { recordedBy: written.recordedBy }
      : { historyRecording: written.historyRecording }),
    importMode: useVendoredBrowserImport ? "vendored-browser-module" : "package",
    usage: useVendoredBrowserImport
      ? `import { dohc } from "./vendor/dohc-sdk/dist/index.js";\nconst text = await dohc.files.read("notes/today.md");`
      : `import { dohc } from "@dohc/sdk";\nconst text = await dohc.files.read("notes/today.md");`,
  };
}

export async function publishSite(ctx: ToolContext, args: { siteRoot: string }) {
  const tested = await testSite(ctx, args);
  if (!tested.ok) return tested;
  const site = tested.site;
  return {
    ok: false as const,
    status: "review-required",
    siteRoot: site.root,
    reason:
      "Site publish/share is a dohc Cloud boundary and is not wired in this local MCP tool yet.",
    review: {
      siteRoot: site.root,
      modes: previewModesForSite(site),
      includesSharedWithMe: isSharedWithMePath(site.root),
    },
    checks: tested.checks,
  };
}

// --- dohc_import_data -------------------------------------------------------

// Imports a delimited/structured source into a NEW visible .sqlite, written
// safely under the root. Refuses a hidden-internal (.dohc) or sidecar target —
// only a visible user database is a valid import destination.
export async function importData(
  ctx: ToolContext,
  args: { sourcePath: string; databasePath: string; tableName: string },
) {
  const sourceRel = await safeResolve(ctx, args.sourcePath, "read");
  if (!sourceRel.ok) return { ok: false as const, reason: sourceRel.reason };
  // Same secret floor as read/search: an import is a read of the source,
  // and importing a secret-classified file (".env.csv", mounted or local)
  // into a visible database would launder its contents past the denial.
  if (isSecretWorkspacePath(sourceRel.normalized)) {
    return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
  }
  const dbRel = await safeResolve(ctx, args.databasePath);
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  if (databaseSyncStrategy(dbRel.normalized) !== "operation-log") {
    return { ok: false as const, reason: `not a visible database target: ${args.databasePath}` };
  }

  const body = await readFile(sourceRel.absolute, "utf8");
  const { createSqliteEngine } = await import("@dohc/sqlite-worker");
  const engine = await createSqliteEngine();
  const result = await engine.importData({
    name: args.sourcePath,
    mediaType: mediaTypeForPath(args.sourcePath) ?? "text/plain",
    body,
    tableName: args.tableName,
  });
  if (!result.ok) return { ok: false as const, reason: `${result.code}: ${result.message}` };

  const parentDir = dirname(dbRel.absolute);
  let visibleMutationStarted = false;
  try {
    const createdParent = await mkdir(parentDir, { recursive: true });
    if (createdParent) visibleMutationStarted = true;
    const dbBytes = Buffer.from(result.bytesBase64, "base64");
    await writeFileAtomicallyForTool(ctx, dbRel.normalized, dbBytes, { overwrite: false });
    visibleMutationStarted = true;
  } catch (error) {
    return {
      ok: false as const,
      reason: visibleMutationStarted
        ? mutationRetainedReason(error, `failed to write import: ${dbRel.normalized}`)
        : failureReason(error, `failed to write import: ${dbRel.normalized}`),
    };
  }
  return {
    ok: true as const,
    path: dbRel.normalized,
    tableName: result.tableName,
    rowCount: result.rowCount,
    ...(await recordedChangeFields(ctx)),
  };
}

// --- dohc_query_database ----------------------------------------------------

const MAX_QUERY_ROWS = 1000;

// Opens a visible database READ-ONLY and returns a bounded row window. Only a
// single read-only SELECT is honored; anything else is refused.
export async function queryDatabase(
  ctx: ToolContext,
  args: { databasePath: string; sql: string },
) {
  // Registered read-only (SELECT enforcement below): a mounted share's
  // database is queryable like any other readable file.
  const dbRel = await safeResolve(ctx, args.databasePath, "read");
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
  // Secret floor before any bytes open: a secret-classified database name
  // (".env.sqlite", mounted or local) is denied like any other secret read.
  if (isSecretWorkspacePath(dbRel.normalized)) {
    return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
  }
  // Only a VISIBLE user database (parity with import_data): never a sidecar,
  // hidden internal, or a non-db file that merely contains SQLite bytes.
  if (databaseSyncStrategy(dbRel.normalized) !== "operation-log") {
    return { ok: false as const, reason: `not a visible database: ${args.databasePath}` };
  }
  if (!isReadOnlySelect(args.sql)) {
    return { ok: false as const, reason: "only a single read-only SELECT is allowed" };
  }
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(dbRel.absolute, { readOnly: true });
  try {
    // Bound the work the DB does, not just the result we keep: wrap the SELECT
    // so SQLite stops after MAX_QUERY_ROWS rather than materializing a huge or
    // unbounded result (e.g. a giant join or randomblob) before we slice.
    const bounded = `select * from (${stripTrailingSemicolon(args.sql)}) limit ${MAX_QUERY_ROWS}`;
    const rows = db.prepare(bounded).all();
    return { ok: true as const, rows };
  } catch (cause) {
    return { ok: false as const, reason: cause instanceof Error ? cause.message : "query failed" };
  } finally {
    db.close();
  }
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
}

function isReadOnlySelect(sql: string): boolean {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) return false;
  // No second statement after the (optional) trailing semicolon.
  return !stripTrailingSemicolon(trimmed).includes(";");
}

// --- dohc_share -------------------------------------------------------------

// Sharing crosses a boundary, so this NEVER auto-applies. It routes through
// the liberal collaboration policy and returns needs-confirmation with the
// human-readable reason; only the desktop, with the user's explicit OK, applies
// the share.
export async function share(ctx: ToolContext, args: { path: string; scope: "public" | "workspace" }) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  return {
    ok: true as const,
    status: "needs-confirmation" as const,
    boundaryCrossing: args.scope === "public" ? "public-share" : "private-to-shared",
    path: resolved.normalized,
    reason:
      "Sharing crosses a boundary — it waits for your explicit OK in dohc before anything is shared.",
  };
}

// --- dohc_resolve_conflict --------------------------------------------------

// Attempts a conservative three-way merge of a markdown conflict. A clean merge
// is returned as proposed content; an ambiguous one returns conflict so a human
// decides — never a silent overwrite.

// --- desktop-owned history and Chats ---------------------------------------
//
// MCP is a separate process and never opens the daemon-owned engine database.
// The desktop is the sole writer and applies workspace authorization plus chat
// identity before dispatching these CLI verbs.

export const DOHC_TRANSPORT_UNAVAILABLE_REASON =
  "dohc is not running. Open the dohc app to read workspace history or chats, or post chats.";

function cliFailureReason(error: unknown): string {
  if (error instanceof DohcCliError && error.message === "desktop app not running") {
    return DOHC_TRANSPORT_UNAVAILABLE_REASON;
  }
  return failureReason(error, DOHC_TRANSPORT_UNAVAILABLE_REASON);
}

async function requestCli<Verb extends CliVerb>(
  ctx: ToolContext,
  verb: Verb,
  args: Omit<Extract<CliRequestWithoutToken, { verb: Verb }>["args"], "cwd" | "actor">,
): Promise<CliResultByVerb[Verb] | { ok: false; reason: string }> {
  const request = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: {
      cwd: ctx.root,
      actor: "agent" as const,
      ...args,
    },
  } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
  try {
    const rawResult = ctx.request
      ? await ctx.request(request)
      : await sendCliRequest(request, { stateDir: ctx.home });
    return parseCliResult(verb, rawResult);
  } catch (error) {
    return { ok: false as const, reason: cliFailureReason(error) };
  }
}

export async function listFileChats(ctx: ToolContext, args: { path: string }) {
  return requestCli(ctx, "fileChats", args);
}

export async function readChat(ctx: ToolContext, args: { threadId: string }) {
  return requestCli(ctx, "chat", args);
}

// --- channels (PR 12/15 slice, WS-E) ----------------------------------------

// Channel discovery for agents: names, slugs, kinds, and each channel's
// threads (id + display title) so a follow-up reply/read has real ids to
// target. Writable MCP profiles ensure the workspace's default "general"
// channel on first use — the same rule the desktop applies. Read-only shared
// views list only existing channels so discovery never creates durable state.
export async function listChannels(ctx: ToolContext) {
  return requestCli(ctx, "channelsFull", {});
}

// Start a chat in a channel AS THE AGENT. `channel` accepts a channel id or
// a name/slug ("general", "#general", "Client ACME"). No title is required:
// untitled chats display their first-message snippet.
export async function startChannelChat(
  ctx: ToolContext,
  args: { channel: string; body: string; title?: string },
) {
  return requestCli(ctx, "startChannelChat", args);
}

export async function replyToChat(
  ctx: ToolContext,
  args: { threadId: string; body: string },
) {
  return requestCli(ctx, "replyToChat", args);
}

export function resolveConflict(args: { base: string; local: string; remote: string }) {
  const result = mergeMarkdown(args);
  return result.kind === "merged"
    ? { resolved: true as const, content: result.content }
    : {
        resolved: false as const,
        reason: "Both sides changed overlapping lines — kept both for a human to pick.",
      };
}

// --- dohc_open_in_dohc ------------------------------------------------------

// Returns the absolute path the desktop should surface (open/select). Path is
// contained first so it can never point outside the workspace.
export async function openInDohc(ctx: ToolContext, args: { path: string }) {
  // Opening is a read: mounted files open in dohc like any other file.
  const resolved = await safeResolve(ctx, args.path, "read");
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  return { ok: true as const, path: resolved.absolute, relativePath: resolved.normalized };
}

export { safeResolve };
