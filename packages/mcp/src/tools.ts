// Pure MCP tool implementations. Each operates on a workspace ROOT dir and a
// state HOME (the desktop registry/state location). EVERY workspace-relative
// path argument is validated through validateUserWritePath before it touches
// the filesystem — traversal (../, percent-encoded, the reserved .dohc dir)
// is rejected here, the #1 security requirement. Writes are scoped to the root
// and never auto-trust an app or auto-apply a boundary crossing.

import {
  databaseSyncStrategy,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { createChangeSetStore, mergeMarkdown } from "@dohc/workspace-history";
import { runStaticAppCheck } from "@dohc/app-tester/static";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ToolContext {
  // Workspace root the server is scoped to (the --workspace arg). All file
  // paths resolve under here and may never escape it.
  root: string;
  // Desktop state/home dir (the --home arg): holds dohc-workspaces.json.
  home: string;
}

// A tool's path arg, resolved to an absolute path INSIDE the root, or a reason
// it was refused. Centralizes the containment guard so no tool can forget it.
function safeResolve(
  ctx: ToolContext,
  relativePath: string,
): { ok: true; absolute: string; normalized: string } | { ok: false; reason: string } {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    return { ok: false, reason: `path rejected (${validated.reason}): ${relativePath}` };
  }
  return {
    ok: true,
    absolute: join(ctx.root, validated.normalized),
    normalized: validated.normalized,
  };
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

  const manifest = safeResolve(ctx, manifestPath);
  if (!manifest.ok) return { ok: false as const, reason: manifest.reason };
  const entry = safeResolve(ctx, entryPath);
  if (!entry.ok) return { ok: false as const, reason: entry.reason };

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

  return {
    ok: true as const,
    appRoot: manifest.normalized.slice(0, -"/app.json".length),
    files: [manifest.normalized, entry.normalized],
    // Explicit: scaffolding never confers trust. The desktop must test then the
    // user must grant trust before this app can run trusted.
    trusted: false,
  };
}

// --- dohc_test_app ----------------------------------------------------------

// Runs the Playwright-free static AppTester over an app's source files (the
// caller supplies the relative source paths it wants checked, each contained).
export async function testApp(
  ctx: ToolContext,
  args: { appRoot: string; sourcePaths: string[] },
) {
  const root = safeResolve(ctx, args.appRoot);
  if (!root.ok) return { ok: false as const, reason: root.reason };

  const files: Array<{ relativePath: string; body: string }> = [];
  for (const rel of args.sourcePaths) {
    const resolved = safeResolve(ctx, rel);
    if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
    // The path must live inside the app root — no smuggling foreign source.
    if (
      resolved.normalized !== root.normalized &&
      !resolved.normalized.startsWith(`${root.normalized}/`)
    ) {
      return { ok: false as const, reason: `not inside app: ${rel}` };
    }
    files.push({
      relativePath: resolved.normalized.slice(root.normalized.length + 1),
      body: await readFile(resolved.absolute, "utf8"),
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
  const sourceRel = safeResolve(ctx, args.sourcePath);
  if (!sourceRel.ok) return { ok: false as const, reason: sourceRel.reason };
  const dbRel = safeResolve(ctx, args.databasePath);
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
  if (databaseSyncStrategy(dbRel.normalized) !== "operation-log") {
    return { ok: false as const, reason: `not a visible database target: ${args.databasePath}` };
  }

  const body = await readFile(sourceRel.absolute, "utf8");
  const { createSqliteEngine } = await import("@dohc/sqlite-worker");
  const engine = await createSqliteEngine();
  const result = await engine.importData({
    name: args.sourcePath,
    mediaType: mediaTypeForSource(args.sourcePath),
    body,
    tableName: args.tableName,
  });
  if (!result.ok) return { ok: false as const, reason: `${result.code}: ${result.message}` };

  await mkdir(dirname(dbRel.absolute), { recursive: true });
  // wx: never overwrite an existing database (its bytes are canonical).
  await writeFile(dbRel.absolute, Buffer.from(result.bytesBase64, "base64"), { flag: "wx" });
  return {
    ok: true as const,
    path: dbRel.normalized,
    tableName: result.tableName,
    rowCount: result.rowCount,
  };
}

function mediaTypeForSource(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  if (ext === "jsonl" || ext === "ndjson") return "application/x-ndjson";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  return "text/plain";
}

// --- dohc_query_database ----------------------------------------------------

const MAX_QUERY_ROWS = 1000;

// Opens a visible database READ-ONLY and returns a bounded row window. Only a
// single read-only SELECT is honored; anything else is refused.
export async function queryDatabase(
  ctx: ToolContext,
  args: { databasePath: string; sql: string },
) {
  const dbRel = safeResolve(ctx, args.databasePath);
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
  if (!isReadOnlySelect(args.sql)) {
    return { ok: false as const, reason: "only a single read-only SELECT is allowed" };
  }
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(dbRel.absolute, { readOnly: true });
  try {
    const rows = db.prepare(args.sql).all();
    return { ok: true as const, rows: rows.slice(0, MAX_QUERY_ROWS) };
  } catch (cause) {
    return { ok: false as const, reason: cause instanceof Error ? cause.message : "query failed" };
  } finally {
    db.close();
  }
}

function isReadOnlySelect(sql: string): boolean {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) return false;
  const withoutFinalSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return !withoutFinalSemicolon.includes(";");
}

// --- dohc_share -------------------------------------------------------------

// Sharing crosses a boundary, so this NEVER auto-applies. It routes through
// the liberal collaboration policy and returns needs-confirmation with the
// human-readable reason; only the desktop, with the user's explicit OK, applies
// the share.
export async function share(ctx: ToolContext, args: { path: string; scope: "public" | "workspace" }) {
  const resolved = safeResolve(ctx, args.path);
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
export function openInDohc(ctx: ToolContext, args: { path: string }) {
  const resolved = safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  return { ok: true as const, path: resolved.absolute, relativePath: resolved.normalized };
}

export { safeResolve };
