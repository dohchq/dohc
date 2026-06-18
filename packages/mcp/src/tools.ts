// Pure MCP tool implementations. Each operates on a workspace ROOT dir and a
// state HOME (the desktop registry/state location). EVERY workspace-relative
// path argument is validated through validateUserWritePath before it touches
// the filesystem — traversal (../, percent-encoded, the reserved .dohc dir)
// is rejected here, the #1 security requirement. Writes are scoped to the root
// and never auto-trust an app or auto-apply a boundary crossing.

import {
  addFileChanges,
  createChangeSet,
  databaseSyncStrategy,
  hasIgnoredSegment,
  mediaTypeForPath,
  validateUserWritePath,
  type ChangeAuthor,
  type ChangeProvenance,
  type FileChange,
} from "@dohc/workspace-core";
import { createChangeSetStore, mergeMarkdown } from "@dohc/workspace-history";
import { runStaticAppCheck } from "@dohc/app-tester/static";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

export interface ToolContext {
  // Workspace root the server is scoped to (the --workspace arg). All file
  // paths resolve under here and may never escape it.
  root: string;
  // Desktop state/home dir (the --home arg): holds dohc-workspaces.json.
  home: string;
}

const MCP_AUTHOR: ChangeAuthor = {
  kind: "agent",
  agentId: "dohc-mcp",
  onBehalfOf: "local",
};
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const HARD_READ_MAX_BYTES = 10 * 1024 * 1024;

// Is `absolute` REALLY inside `root` after resolving symlinks? Lexical
// containment (validateUserWritePath) stops ../ and friends, but a symlink that
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
): Promise<{ ok: true; absolute: string; normalized: string } | { ok: false; reason: string }> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    return { ok: false, reason: `path rejected (${validated.reason}): ${relativePath}` };
  }
  const absolute = join(ctx.root, validated.normalized);
  if (!(await isWithinRealRoot(ctx.root, absolute))) {
    return { ok: false, reason: `path rejected (symlink escapes workspace): ${relativePath}` };
  }
  return { ok: true, absolute, normalized: validated.normalized };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function recordChange(
  ctx: ToolContext,
  input: {
    files: FileChange[];
    summary: string;
    kind?: "agent-run" | "import";
    provenance?: ChangeProvenance;
  },
) {
  await safeMetadataDir(ctx);
  const set = addFileChanges(
    createChangeSet({
      kind: input.kind ?? "agent-run",
      author: MCP_AUTHOR,
      summary: input.summary,
      provenance: input.provenance ?? { source: input.kind === "import" ? "import" : "agent-run" },
    }),
    input.files,
  );
  return createChangeSetStore(ctx.root).record(set, {
    id: randomUUID(),
    recordedAtMs: Date.now(),
  });
}

function failureReason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function ensureRecordable(ctx: ToolContext) {
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
      ? await safeResolve(ctx, args.path)
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

export async function readWorkspaceFile(
  ctx: ToolContext,
  args: {
    path: string;
    encoding?: "utf8" | "base64";
    maxBytes?: number;
    offsetBytes?: number;
  },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  try {
    const body = await readFile(resolved.absolute);
    const maxBytes = Math.min(
      HARD_READ_MAX_BYTES,
      Math.max(1, Math.floor(args.maxBytes ?? DEFAULT_READ_MAX_BYTES)),
    );
    const offsetBytes = Math.min(
      body.byteLength,
      Math.max(0, Math.floor(args.offsetBytes ?? 0)),
    );
    const end = Math.min(body.byteLength, offsetBytes + maxBytes);
    const truncated = end < body.byteLength;
    const view = body.subarray(offsetBytes, end);
    const encoding = args.encoding ?? "utf8";
    return {
      ok: true as const,
      path: resolved.normalized,
      mediaType: mediaTypeForPath(resolved.normalized) ?? "application/octet-stream",
      encoding,
      bytes: body.byteLength,
      offsetBytes,
      sha256: sha256(body),
      truncated,
      content: encoding === "base64" ? view.toString("base64") : view.toString("utf8"),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to read: ${args.path}`),
    };
  }
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

  const existing = await readFile(resolved.absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (args.expectedSha256 && sha256(existing ?? new Uint8Array()) !== args.expectedSha256) {
    return {
      ok: false as const,
      reason: "expectedSha256 does not match current file",
      currentSha256: existing ? sha256(existing) : sha256(new Uint8Array()),
    };
  }

  const bytes =
    args.encoding === "base64"
      ? Buffer.from(args.content, "base64")
      : Buffer.from(args.content, "utf8");
  await mkdir(dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, bytes);
  const record = await recordChange(ctx, {
    files: [{ path: resolved.normalized, operation: "write" }],
    summary: args.summary ?? `MCP wrote ${resolved.normalized}`,
  });
  return {
    ok: true as const,
    path: resolved.normalized,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    changeSetId: record.id,
    recordedAtMs: record.recordedAtMs,
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
  await mkdir(resolved.absolute, { recursive: true });
  const record = await recordChange(ctx, {
    files: [{ path: resolved.normalized, operation: "write" }],
    summary: args.summary ?? `MCP created ${resolved.normalized}`,
  });
  return {
    ok: true as const,
    path: resolved.normalized,
    changeSetId: record.id,
    recordedAtMs: record.recordedAtMs,
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
  await rename(from.absolute, to.absolute);
  const record = await recordChange(ctx, {
    files: [
      { path: from.normalized, operation: "delete" },
      { path: to.normalized, operation: "write" },
    ],
    summary: args.summary ?? `MCP moved ${from.normalized} to ${to.normalized}`,
  });
  return {
    ok: true as const,
    fromPath: from.normalized,
    toPath: to.normalized,
    changeSetId: record.id,
    recordedAtMs: record.recordedAtMs,
  };
}

export async function deleteWorkspacePath(
  ctx: ToolContext,
  args: { path: string; summary?: string },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  try {
    await lstat(resolved.absolute);
    const trashDir = await safeTrashDir(ctx);
    const trashedTo = join(
      trashDir,
      `${Date.now()}-${randomUUID()}-${basename(resolved.normalized)}`,
    );
    await rename(resolved.absolute, trashedTo);
    const record = await recordChange(ctx, {
      files: [{ path: resolved.normalized, operation: "delete" }],
      summary: args.summary ?? `MCP deleted ${resolved.normalized}`,
    });
    return {
      ok: true as const,
      path: resolved.normalized,
      trashed: true,
      changeSetId: record.id,
      recordedAtMs: record.recordedAtMs,
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to delete: ${args.path}`),
    };
  }
}

// --- dohc_list_workspaces ---------------------------------------------------

interface RegistryFile {
  version?: number;
  workspaces?: Array<{ workspaceId: string; rootPath: string; kind: string; mode: string }>;
}

export async function listWorkspaces(ctx: ToolContext) {
  const registry = await readJson<RegistryFile>(join(ctx.home, "dohc-workspaces.json"));
  const workspaces = (registry?.workspaces ?? []).map((w) => ({
    workspaceId: w.workspaceId,
    rootPath: w.rootPath,
    kind: w.kind,
  }));
  return { workspaces };
}

// --- dohc_workspace_status --------------------------------------------------

interface SyncManifest {
  workspaceId?: string;
  serverUrl?: string;
  remoteWorkspaceId?: string;
}

export async function workspaceStatus(ctx: ToolContext) {
  const manifest = await readJson<SyncManifest>(
    join(ctx.root, ".dohc", "sync-manifest.json"),
  );
  if (!manifest) return { synced: false, scope: "local" as const };
  return {
    synced: !!manifest.remoteWorkspaceId,
    scope: manifest.remoteWorkspaceId ? ("cloud" as const) : ("local" as const),
    ...(manifest.workspaceId ? { workspaceId: manifest.workspaceId } : {}),
    ...(manifest.serverUrl ? { serverUrl: manifest.serverUrl } : {}),
  };
}

// --- dohc_sync_now ----------------------------------------------------------

// Local-first: "sync" reports the change sets recorded since the cursor (what
// would be pushed) rather than performing a network push. A clean state means
// nothing pending.
export async function syncNow(ctx: ToolContext, args: { sinceMs?: number }) {
  const store = createChangeSetStore(ctx.root);
  const pending = await store.listSince(args.sinceMs ?? 0);
  return {
    pendingChangeCount: pending.length,
    clean: pending.length === 0,
    pending: pending.map((record) => ({
      id: record.id,
      recordedAtMs: record.recordedAtMs,
      summary: record.summary,
      fileCount: record.files.length,
    })),
  };
}

// --- dohc_create_app --------------------------------------------------------

// Scaffolds <area>/.apps/<name>/{app.json,src/App.tsx} through the safe write
// path. NEVER marks the app trusted — trust is the user's explicit Phase 7
// gate, granted only after AppTester passes in the desktop.
export async function createApp(
  ctx: ToolContext,
  args: { area: string; name: string; title?: string },
) {
  const appRoot = args.area
    ? `${args.area}/.apps/${args.name}`
    : `.apps/${args.name}`;
  const manifestPath = `${appRoot}/app.json`;
  const entryPath = `${appRoot}/src/App.tsx`;

  const manifest = await safeResolve(ctx, manifestPath);
  if (!manifest.ok) return { ok: false as const, reason: manifest.reason };
  const entry = await safeResolve(ctx, entryPath);
  if (!entry.ok) return { ok: false as const, reason: entry.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;

  const appJson = {
    ...(args.title ? { title: args.title } : {}),
    entry: "src/App.tsx",
    read: ["."],
    write: [] as string[],
    network: false as const,
  };
  const source = `import { App } from "@dohc/app";\n\nexport default App(() => <div>${args.name}</div>);\n`;

  await mkdir(dirname(manifest.absolute), { recursive: true });
  await writeFile(manifest.absolute, `${JSON.stringify(appJson, null, 2)}\n`, { flag: "wx" });
  await mkdir(dirname(entry.absolute), { recursive: true });
  await writeFile(entry.absolute, source, { flag: "wx" });
  const record = await recordChange(ctx, {
    files: [
      { path: manifest.normalized, operation: "write" },
      { path: entry.normalized, operation: "write" },
    ],
    summary: `MCP created app ${args.name}`,
  });

  return {
    ok: true as const,
    appRoot: manifest.normalized.slice(0, -"/app.json".length),
    files: [manifest.normalized, entry.normalized],
    // Explicit: scaffolding never confers trust. The desktop must test then the
    // user must grant trust before this app can run trusted.
    trusted: false,
    changeSetId: record.id,
    recordedAtMs: record.recordedAtMs,
  };
}

// --- dohc_test_app ----------------------------------------------------------

const MAX_TEST_APP_BYTES = 2 * 1024 * 1024;

// Runs the Playwright-free static AppTester over an app's source files (the
// caller supplies the relative source paths it wants checked, each contained).
export async function testApp(
  ctx: ToolContext,
  args: { appRoot: string; sourcePaths: string[] },
) {
  const root = await safeResolve(ctx, args.appRoot);
  if (!root.ok) return { ok: false as const, reason: root.reason };

  const files: Array<{ relativePath: string; body: string }> = [];
  // Bound total source so an agent can't point the transpiler at huge files
  // and burn memory/CPU. The static check is for app sources, not data dumps.
  let totalBytes = 0;
  for (const rel of args.sourcePaths) {
    const resolved = await safeResolve(ctx, rel);
    if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
    // The path must live inside the app root — no smuggling foreign source.
    if (
      resolved.normalized !== root.normalized &&
      !resolved.normalized.startsWith(`${root.normalized}/`)
    ) {
      return { ok: false as const, reason: `not inside app: ${rel}` };
    }
    const body = await readFile(resolved.absolute, "utf8");
    totalBytes += Buffer.byteLength(body, "utf8");
    if (totalBytes > MAX_TEST_APP_BYTES) {
      return { ok: false as const, reason: "app source too large to test (>2MB)" };
    }
    files.push({
      relativePath: resolved.normalized.slice(root.normalized.length + 1),
      body,
    });
  }

  const result = runStaticAppCheck(files);
  return { ok: result.ok, checks: result.checks };
}

// --- dohc_import_data -------------------------------------------------------

// Imports a delimited/structured source into a NEW visible .sqlite, written
// safely under the root. Refuses a hidden-internal (.dohc) or sidecar target —
// only a visible user database is a valid import destination.
export async function importData(
  ctx: ToolContext,
  args: { sourcePath: string; databasePath: string; tableName: string },
) {
  const sourceRel = await safeResolve(ctx, args.sourcePath);
  if (!sourceRel.ok) return { ok: false as const, reason: sourceRel.reason };
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

  await mkdir(dirname(dbRel.absolute), { recursive: true });
  // wx: never overwrite an existing database (its bytes are canonical).
  await writeFile(dbRel.absolute, Buffer.from(result.bytesBase64, "base64"), { flag: "wx" });
  const record = await recordChange(ctx, {
    kind: "import",
    provenance: { source: "import", importPath: sourceRel.normalized },
    files: [{ path: dbRel.normalized, operation: "write" }],
    summary: `MCP imported ${sourceRel.normalized} to ${dbRel.normalized}`,
  });
  return {
    ok: true as const,
    path: dbRel.normalized,
    tableName: result.tableName,
    rowCount: result.rowCount,
    changeSetId: record.id,
    recordedAtMs: record.recordedAtMs,
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
  const dbRel = await safeResolve(ctx, args.databasePath);
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
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
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  return { ok: true as const, path: resolved.absolute, relativePath: resolved.normalized };
}

export { safeResolve };
