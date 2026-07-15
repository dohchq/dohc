import {
  isDatabaseFile,
  isDatabaseSidecar,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { rgPath } from "@vscode/ripgrep";
import { basename, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  createWorkspaceTextExclusive,
  readWorkspaceText,
  restoreWorkspaceText,
} from "./workspaceAssets";
import {
  applyDatabaseEdit,
  readDatabaseSnapshot,
  type DatabaseEdit,
} from "./workspaceDatabase";
import { listFiles } from "./workspaceFiles";
import {
  SEARCH_MAX_TOTAL_MATCHES,
  startRipgrepSearch,
  type SearchResultEntry,
  type WorkspaceSearchRequest,
} from "./workspaceSearch";

type RecordValue = Record<string, unknown>;

export interface SiteSdkHostContext {
  workspaceRoot: string;
  // null grants the current user's owned workspace. A concrete root is the
  // read-only collaboration projection that the shared site arrived through.
  scopeRoot: string | null;
  writable: boolean;
  // Preview-lifetime cancellation. Search subprocesses must not survive the
  // renderer/preview that owns their SDK authority.
  signal?: AbortSignal;
  // Test/lifecycle seam for proving that preview cancellation terminates the
  // owned search handle. Production callers use startRipgrepSearch.
  searchStarter?: SiteSdkSearchStarter;
}

export type SiteSdkSearchStarter = typeof startRipgrepSearch;

const MAX_LIST_RESULTS = 10_000;
const MAX_SEARCH_RESULTS = 2_000;

function record(value: unknown, label = "parameters"): RecordValue {
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

function normalizeScopeRoot(scopeRoot: string | null): string | null {
  return !scopeRoot || scopeRoot === "." ? null : scopeRoot.replace(/\/$/, "");
}

function validatedPath(path: unknown, kind: "read" | "write"): string {
  const raw = text(path, "path");
  const result = kind === "read" ? validateUserReadPath(raw) : validateUserWritePath(raw);
  if (!result.ok) throw new Error(`Invalid ${kind} path (${result.reason}): ${raw}`);
  return result.normalized;
}

/** Maps the site's logical path into the host-derived collaboration scope. */
export function siteSdkWorkspacePath(
  scopeRoot: string | null,
  requestedPath: unknown,
  kind: "read" | "write" = "read",
): string {
  const requested = validatedPath(requestedPath, kind);
  const scope = normalizeScopeRoot(scopeRoot);
  return scope ? `${scope}/${requested}` : requested;
}

function visiblePath(scopeRoot: string | null, workspacePath: string): string | null {
  const scope = normalizeScopeRoot(scopeRoot);
  if (!scope) return workspacePath;
  if (workspacePath === scope) return ".";
  const prefix = `${scope}/`;
  return workspacePath.startsWith(prefix) ? workspacePath.slice(prefix.length) : null;
}

function isAtOrBelow(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function isCanonicalMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function capabilities(context: SiteSdkHostContext) {
  const canWrite = context.writable && !normalizeScopeRoot(context.scopeRoot);
  return {
    files: { read: true, list: true, write: canWrite, watch: false },
    workspace: { search: true, events: false },
    databases: { read: true, edit: canWrite },
    ui: { open: true },
    collections: { read: false, list: false },
    provenance: { record: false },
  };
}

function assertSitePreviewActive(context: SiteSdkHostContext): void {
  if (context.signal?.aborted) {
    throw new Error("Site preview is no longer active.");
  }
}

async function listVisibleFiles(context: SiteSdkHostContext, params: unknown) {
  const input = params === undefined ? {} : record(params);
  const requestedRoot = input.path === undefined ? "." : validatedPath(input.path, "read");
  const recursive = input.recursive !== false;
  const listed = await listFiles(context.workspaceRoot);
  const files = [];
  for (const entry of listed.files) {
    const path = visiblePath(context.scopeRoot, entry.path);
    if (!path || !isAtOrBelow(path, requestedRoot)) continue;
    if (!recursive) {
      const remainder = requestedRoot === "." ? path : path.slice(requestedRoot.length + 1);
      if (remainder.includes("/")) continue;
    }
    files.push({ ...entry, path, name: basename(path) });
    if (files.length >= MAX_LIST_RESULTS) break;
  }
  return files;
}

async function scopedIncludeGlob(
  workspaceRoot: string,
  scopeRoot: string | null,
  requestedPath: unknown,
): Promise<string | undefined> {
  const scope = normalizeScopeRoot(scopeRoot);
  const path = requestedPath === undefined ? null : validatedPath(requestedPath, "read");
  const roots = [scope, path].filter((part): part is string => Boolean(part && part !== "."));
  if (roots.length === 0) return undefined;
  const scopedPath = roots.join("/");
  try {
    if ((await stat(join(workspaceRoot, scopedPath))).isFile()) return scopedPath;
  } catch {
    // A missing path simply produces no rg matches through the directory glob.
  }
  return `${scopedPath}/**`;
}

async function searchVisibleWorkspace(context: SiteSdkHostContext, params: unknown) {
  const input = record(params);
  const query = text(input.query, "query", 2_000);
  const includeGlob = await scopedIncludeGlob(context.workspaceRoot, context.scopeRoot, input.path);
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
  const root = await realpath(context.workspaceRoot);
  if (context.signal?.aborted) {
    throw new Error("Site preview is no longer active.");
  }
  return new Promise<Array<SearchResultEntry & { path: string }>>((resolve, reject) => {
    const entries: Array<SearchResultEntry & { path: string }> = [];
    let handle: ReturnType<typeof startRipgrepSearch> | null = null;
    let settled = false;
    const finish = (result: Array<SearchResultEntry & { path: string }>) => {
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
      reject(new Error("Site preview is no longer active."));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    handle = (context.searchStarter ?? startRipgrepSearch)({
      rgPath,
      realRoot: root,
      searchId: `site-sdk-${Date.now()}`,
      request,
      onBatch(batch) {
        for (const entry of batch.entries) {
          const path = visiblePath(context.scopeRoot, entry.path);
          if (path) entries.push({ ...entry, path });
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

export async function invokeSiteSdkHost(
  context: SiteSdkHostContext,
  method: string,
  params?: unknown,
): Promise<unknown> {
  if (method !== "capabilities") assertSitePreviewActive(context);
  switch (method) {
    case "capabilities":
      return capabilities(context);
    case "files.read": {
      const input = record(params);
      return readWorkspaceText(
        context.workspaceRoot,
        siteSdkWorkspacePath(context.scopeRoot, input.path),
      );
    }
    case "files.list":
      return listVisibleFiles(context, params);
    case "files.write": {
      if (!context.writable || normalizeScopeRoot(context.scopeRoot)) {
        throw new Error("This site has read-only collaboration authority.");
      }
      const input = record(params);
      const path = siteSdkWorkspacePath(null, input.path, "write");
      // SQLite files are canonical structured artifacts. Replacing their raw
      // bytes/text would bypass the operation log, transactions, provenance,
      // and collaboration convergence used by databases.edit.
      if (isDatabaseFile(path) || isDatabaseSidecar(path)) {
        throw new Error(
          "files.write cannot overwrite database files. Use databases.edit so structured transactions, history, and collaboration are preserved.",
        );
      }
      // Markdown is projected from the canonical Y.Doc/document model. This
      // host does not own a document session or the review/lock context needed
      // to perform a correct canonical transaction, so a raw text overwrite
      // here would bypass collaboration, history, and live-editor state.
      // Keep ordinary source/text writes useful while failing closed for rich
      // documents until the SDK has a first-class document edit capability.
      if (isCanonicalMarkdownPath(path)) {
        throw new Error(
          "files.write cannot overwrite canonical Markdown documents. Use a dohc document editing capability so locks, history, and collaboration are preserved.",
        );
      }
      const body = typeof input.text === "string" ? input.text : null;
      if (body === null) throw new Error("files.write text must be a string.");
      if (input.overwrite === false) {
        try {
          await createWorkspaceTextExclusive(context.workspaceRoot, path, body, {
            signal: context.signal,
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
      return readDatabaseSnapshot(
        context.workspaceRoot,
        siteSdkWorkspacePath(context.scopeRoot, input.path),
      );
    }
    case "databases.edit": {
      if (!context.writable || normalizeScopeRoot(context.scopeRoot)) {
        throw new Error("This site has read-only collaboration authority.");
      }
      const input = record(params);
      const path = siteSdkWorkspacePath(null, input.path, "write");
      const [edit] = databaseEdits(input);
      await readDatabaseSnapshot(context.workspaceRoot, path);
      assertSitePreviewActive(context);
      return applyDatabaseEdit(
        context.workspaceRoot,
        path,
        edit,
        { kind: "user", userId: "local" },
        Date.now(),
      );
    }
    case "ui.open": {
      const input = record(params);
      return {
        target: siteSdkWorkspacePath(context.scopeRoot, input.target),
        ...(typeof input.position === "string" ? { position: input.position } : {}),
      };
    }
    default:
      throw new Error(`Unsupported dohc SDK method: ${method}`);
  }
}
