import {
  isDatabaseFile,
  isDatabaseSidecar,
  validateUserMaterializePath,
  validateUserReadPath,
} from "@dohc/workspace-core";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import { rgPath } from "@vscode/ripgrep";
import { basename, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  createWorkspaceTextExclusive,
  readWorkspaceText,
  restoreWorkspaceText,
  type WorkspaceTextReadResult,
} from "./workspaceAssets";
import {
  applyDatabaseEdit,
  readDatabaseSnapshot,
  type DatabaseEdit,
  type DatabaseSnapshotView,
} from "./workspaceDatabase";
import { listFiles } from "./workspaceFiles";
import {
  SEARCH_MAX_TOTAL_MATCHES,
  startRipgrepSearch,
  type SearchResultEntry,
  type WorkspaceSearchRequest,
} from "./workspaceSearch";

type RecordValue = Record<string, unknown>;

export interface WorkspaceSdkHostContext {
  workspaceRoot: string;
  writable: boolean;
  // Who a database edit is recorded as. Required, never defaulted: this host
  // serves every plugin SDK route, and an inherited default would record
  // one plugin's work as another's.
  author: ChangeAuthor;
  // Surface-lifetime cancellation. Search subprocesses must not survive the
  // surface that owns their SDK authority.
  signal?: AbortSignal;
  // Test/lifecycle seam for proving that cancellation terminates the owned
  // search handle. Production callers use startRipgrepSearch.
  searchStarter?: SdkSearchStarter;
  // Injectable clock/id seams (oracle/tests) for database edits made through
  // the SDK. Omitted ⇒ the real wall clock / randomUUID, identical to
  // today's behavior.
  now?: () => number;
  createId?: () => string;
  reads?: WorkspaceSdkReadPort;
}

export type SdkSearchStarter = typeof startRipgrepSearch;

export interface WorkspaceSdkReadPort {
  readText(path: string): Promise<WorkspaceTextReadResult>;
  listFiles(): Promise<{
    files: Awaited<ReturnType<typeof listFiles>>["files"];
    folders?: readonly string[];
  }>;
  searchAllowPath(): Promise<(path: string) => boolean>;
  readDatabase(path: string): Promise<DatabaseSnapshotView>;
}

const MAX_LIST_RESULTS = 10_000;
const MAX_SEARCH_RESULTS = 2_000;

export function record(value: unknown, label = "parameters"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RecordValue;
}

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string no longer than ${max} characters.`);
  }
  return value;
}

export function sdkWorkspacePath(
  requestedPath: unknown,
  kind: "read" | "write" = "read",
): string {
  const raw = text(requestedPath, "path");
  const result = kind === "read" ? validateUserReadPath(raw) : validateUserMaterializePath(raw);
  if (!result.ok) throw new Error(`Invalid ${kind} path (${result.reason}): ${raw}`);
  return result.normalized;
}

/** Whether a workspace path sits at or below a root, where "." is the whole
 * workspace. Segment-aware, so "docsx/a" is not below "docs". */
export function isAtOrBelow(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

export function assertRawTextWritable(
  path: string,
  options: { protectPluginSource?: boolean } = {},
): void {
  // Plugins run with full-trust authority. A sandboxed guest must not change
  // plugin source and cross that authority boundary.
  const [topLevel] = path.replaceAll("\\", "/").split("/");
  if (options.protectPluginSource && topLevel?.toLowerCase() === "plugins") {
    throw new Error(
      "files.write cannot write plugin source under the workspace-root plugins/ tree. A sandboxed guest cannot modify source that runs with full-trust authority.",
    );
  }
  // SQLite files are canonical structured artifacts. Replacing their raw
  // bytes/text would bypass the operation log, transactions, provenance,
  // and collaboration convergence used by databases.edit.
  if (isDatabaseFile(path) || isDatabaseSidecar(path)) {
    throw new Error(
      "files.write cannot overwrite database files. Use databases.edit so structured transactions, history, and collaboration are preserved.",
    );
  }
  // Live documents are projected from canonical Y.Doc state. This host does
  // not own the session or review context for a canonical transaction.
  if (liveDocumentKindForPath(path) !== null) {
    throw new Error(
      "files.write cannot overwrite live documents. Use a dohc document editing capability so locks, history, and collaboration are preserved.",
    );
  }
}

function capabilities(context: WorkspaceSdkHostContext) {
  return {
    files: { read: true, list: true, write: context.writable, watch: false },
    workspace: { search: true, events: false },
    databases: { read: true, edit: context.writable },
    ui: { open: true },
    collections: { read: false, list: false },
    provenance: { record: false },
  };
}

function assertRequestSurfaceActive(context: WorkspaceSdkHostContext): void {
  if (context.signal?.aborted) {
    throw new Error("The surface that owns this SDK request is no longer active.");
  }
}

async function listVisibleFiles(context: WorkspaceSdkHostContext, params: unknown) {
  const input = params === undefined ? {} : record(params);
  const requestedRoot =
    input.path === undefined || input.path === "." ? "." : sdkWorkspacePath(input.path);
  const recursive = input.recursive !== false;
  const listed = context.reads
    ? await context.reads.listFiles()
    : await listFiles(context.workspaceRoot);
  const files = [];
  for (const entry of listed.files) {
    const path = entry.path;
    if (!isAtOrBelow(path, requestedRoot)) continue;

    if (!recursive) {
      const remainder = requestedRoot === "." ? path : path.slice(requestedRoot.length + 1);
      if (remainder.includes("/")) continue;
    }
    files.push({ ...entry, name: basename(path) });
    if (files.length >= MAX_LIST_RESULTS) break;
  }
  return files;
}

async function requestedIncludeGlob(
  workspaceRoot: string,
  requestedPath: unknown,
): Promise<string | undefined> {
  if (requestedPath === undefined || requestedPath === ".") return undefined;
  const path = sdkWorkspacePath(requestedPath);
  const literalGlob = path.replace(/([*?[\]{}!\\])/g, "\\$1");
  try {
    if ((await stat(join(workspaceRoot, path))).isFile()) return literalGlob;
  } catch {
    // A missing path simply produces no rg matches through the directory glob.
  }
  return `${literalGlob}/**`;
}

async function searchVisibleWorkspace(context: WorkspaceSdkHostContext, params: unknown) {
  const input = record(params);
  const query = text(input.query, "query", 2_000);
  const includeGlob = await requestedIncludeGlob(context.workspaceRoot, input.path);
  const requestedLimit =
    typeof input.limit === "number" && Number.isInteger(input.limit)
      ? input.limit
      : MAX_SEARCH_RESULTS;
  const limit = Math.max(1, Math.min(requestedLimit, MAX_SEARCH_RESULTS, SEARCH_MAX_TOTAL_MATCHES));
  const request: WorkspaceSearchRequest = {
    query,
    ...(typeof input.caseSensitive === "boolean" ? { caseSensitive: input.caseSensitive } : {}),
    ...(typeof input.wholeWord === "boolean" ? { wholeWord: input.wholeWord } : {}),
    ...(typeof input.regex === "boolean" ? { regex: input.regex } : {}),
    ...(typeof input.excludeGlob === "string" ? { excludeGlob: input.excludeGlob } : {}),
    ...(includeGlob ? { includeGlob } : {}),
  };
  const allowPath = context.reads
    ? await context.reads.searchAllowPath()
    : undefined;
  const root = await realpath(context.workspaceRoot);
  if (context.signal?.aborted) {
    throw new Error("The surface that owns this SDK request is no longer active.");
  }
  return new Promise<SearchResultEntry[]>((resolve, reject) => {
    const entries: SearchResultEntry[] = [];
    let handle: ReturnType<typeof startRipgrepSearch> | null = null;
    let settled = false;
    const finish = (result: SearchResultEntry[]) => {
      if (settled) return;
      settled = true;
      context.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      handle?.kill();
      context.signal?.removeEventListener("abort", abort);
      reject(new Error("The surface that owns this SDK request is no longer active."));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    handle = (context.searchStarter ?? startRipgrepSearch)({
      rgPath,
      realRoot: root,
      searchId: `workspace-sdk-${Date.now()}`,
      request,
      ...(allowPath ? { allowPath } : {}),
      onBatch(batch) {
        for (const entry of batch.entries) {
          entries.push(entry);
          if (entries.length >= limit) {
            handle?.kill();
            finish(entries.slice(0, limit));
            break;
          }
        }
        if (batch.done) finish(entries.slice(0, limit));
      },
    });
    if (context.signal?.aborted) abort();
  });
}

function databaseEdits(value: unknown): DatabaseEdit[] {
  const input = record(value);
  const candidates = Array.isArray(input.operations)
    ? input.operations
    : input.edit
      ? [input.edit]
      : [];
  if (candidates.length !== 1) {
    throw new Error(
      "databases.edit requires exactly one structured operation until atomic multi-operation transactions are available.",
    );
  }
  return candidates.map((candidate) => {
    const edit = record(candidate, "database operation");
    const op = text(edit.op, "database operation op", 20);
    if (!['insert', 'update', 'upsert', 'delete'].includes(op)) {
      throw new Error(`Unsupported database operation: ${op}`);
    }
    if (typeof edit.rowId !== "string" && typeof edit.rowId !== "number") {
      throw new Error("database operation rowId must be a string or number.");
    }
    return {
      table: text(edit.table, "database operation table", 256),
      op: op as DatabaseEdit["op"],
      pkColumn: text(edit.pkColumn, "database operation pkColumn", 256),
      rowId: edit.rowId,
      ...(edit.payload && typeof edit.payload === "object" && !Array.isArray(edit.payload)
        ? { payload: edit.payload as RecordValue }
        : {}),
    };
  });
}

export async function invokeWorkspaceSdkHost(
  context: WorkspaceSdkHostContext,
  method: string,
  params?: unknown,
): Promise<unknown> {
  if (method !== "capabilities") assertRequestSurfaceActive(context);
  switch (method) {
    case "capabilities":
      return capabilities(context);
    case "files.read": {
      const input = record(params);
      const path = sdkWorkspacePath(input.path);
      return context.reads
        ? context.reads.readText(path)
        : readWorkspaceText(context.workspaceRoot, path);
    }
    case "files.list":
      return listVisibleFiles(context, params);
    case "files.write": {
      if (!context.writable) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      const input = record(params);
      const path = sdkWorkspacePath(input.path, "write");
      assertRawTextWritable(path, { protectPluginSource: true });
      const body = typeof input.text === "string" ? input.text : null;
      if (body === null) throw new Error("files.write text must be a string.");
      if (input.overwrite === false) {
        try {
          await createWorkspaceTextExclusive(context.workspaceRoot, path, body, {
            signal: context.signal,
            resolvedPathPolicy: (resolvedPath) =>
              assertRawTextWritable(resolvedPath, { protectPluginSource: true }),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(`File already exists: ${path}`);
          }
          throw error;
        }
        return { path };
      }
      await restoreWorkspaceText(context.workspaceRoot, path, body, {
        signal: context.signal,
        resolvedPathPolicy: (resolvedPath) =>
          assertRawTextWritable(resolvedPath, { protectPluginSource: true }),
      });
      return { path };
    }
    case "workspace.search":
      return searchVisibleWorkspace(context, params);
    case "databases.read": {
      const input = record(params);
      if (input.query !== undefined) {
        throw new Error(
          "This dohc host exposes database snapshots; read-only SQL queries are not available yet.",
        );
      }
      const path = sdkWorkspacePath(input.path);
      return context.reads
        ? context.reads.readDatabase(path)
        : readDatabaseSnapshot(context.workspaceRoot, path);
    }
    case "databases.edit": {
      if (!context.writable) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      const input = record(params);
      const path = sdkWorkspacePath(input.path, "write");
      const [edit] = databaseEdits(input);
      await readDatabaseSnapshot(context.workspaceRoot, path);
      assertRequestSurfaceActive(context);
      return applyDatabaseEdit(
        context.workspaceRoot,
        path,
        edit,
        context.author,
        context.now?.() ?? Date.now(),
        { signal: context.signal, ...(context.createId ? { createId: context.createId } : {}) },
      );
    }
    case "ui.open": {
      const input = record(params);
      return {
        target: sdkWorkspacePath(input.target),
        ...(typeof input.position === "string" ? { position: input.position } : {}),
      };
    }
    default:
      throw new Error(`Unsupported dohc SDK method: ${method}`);
  }
}
