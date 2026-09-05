import {
  isDatabaseFile,
  isDatabaseSidecar,
  validateUserMaterializePath,
  validateUserReadPath,
} from "@dohc/workspace-core";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type {
  CollectionGetParams,
  CollectionGetRecordParams,
  CollectionGetRecordResult,
  CollectionGetResult,
  CollectionListResult,
  CollectionQueryParams,
  CollectionQueryResult,
  CollectionValue,
} from "@dohc/workspace-contracts";
import { rgPath } from "@vscode/ripgrep";
import { basename, join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createWorkspaceTextExclusive,
  restoreWorkspaceText,
  type WorkspaceTextReadResult,
} from "./workspaceAssets";
import {
  type DatabaseEdit,
  type DatabaseSnapshotView,
} from "./workspaceDatabase";
import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
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
  // Host-derived owner authority. Required so a caller cannot regain raw-disk
  // reads by omitting the adapter.
  reads: WorkspaceSdkReadPort;
  // Host-derived database writer. Production routes this through the shared
  // database worker; the SDK caller supplies neither a filesystem path nor an
  // execution lane.
  editDatabase(input: {
    path: string;
    edit: DatabaseEdit;
    author: ChangeAuthor;
    nowMs: number;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  // Host-derived collection record writer (the desktop's one main-side
  // collection write seam). Absent means this surface has no collection
  // write authority; the advertised collections.edit capability follows it.
  editCollections?: WorkspaceSdkCollectionEditPort;
  // The wire idempotency key a collection write carries to the seam. Only an
  // automation-run context sets it (to the run's claim id plus its write
  // ordinal, host-derived like the author); every other write lets the
  // session generate one per update.
  collectionWriteIdempotencyKey?: string;
}

export interface WorkspaceSdkCollectionEditPort {
  setRecordFields(input: {
    recordPath: string;
    fields: Record<string, unknown>;
    author: ChangeAuthor;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<{ path: string }>;
  createRecord(input: {
    collectionPath: string;
    name: string;
    fields?: Record<string, unknown>;
    author: ChangeAuthor;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<{ path: string; recordId: string }>;
}

export type SdkSearchStarter = typeof startRipgrepSearch;

export interface WorkspaceSdkReadPort {
  readText(path: string): Promise<WorkspaceTextReadResult>;
  listFiles(): Promise<{
    files: ListWorkspaceFilesResult["files"];
    folders?: readonly string[];
  }>;
  prepareSearch(path?: string): Promise<WorkspaceSdkSearchView>;
  readDatabase(path: string): Promise<DatabaseSnapshotView>;
  // Collection reads share the port's path scope with file reads: a port
  // scoped to a prefix filters its listing and refuses a collection or
  // record outside it. This host validates path shape only; the port owns
  // visibility, exactly like readText.
  listCollections(): Promise<CollectionListResult>;
  getCollection(params: CollectionGetParams): Promise<CollectionGetResult>;
  queryCollectionRecords(
    params: CollectionQueryParams,
  ): Promise<CollectionQueryResult>;
  getCollectionRecord(
    params: CollectionGetRecordParams,
  ): Promise<CollectionGetRecordResult>;
}

export interface WorkspaceSdkSearchView {
  includeGlob?: string;
  allowPath(path: string): boolean;
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
    collections: {
      read: true,
      edit: context.writable && context.editCollections !== undefined,
    },
    provenance: { record: false },
  };
}

function requireCollectionEditPort(
  context: WorkspaceSdkHostContext,
): WorkspaceSdkCollectionEditPort {
  if (!context.writable) {
    throw new Error("This plugin has read-only workspace authority.");
  }
  if (!context.editCollections) {
    throw new Error("Collection edits are unavailable in this workspace.");
  }
  return context.editCollections;
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
  const listed = await context.reads.listFiles();
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

async function searchVisibleWorkspace(context: WorkspaceSdkHostContext, params: unknown) {
  const input = record(params);
  const query = text(input.query, "query", 2_000);
  const requestedPath =
    input.path === undefined || input.path === "."
      ? undefined
      : sdkWorkspacePath(input.path);
  const searchView = await context.reads.prepareSearch(requestedPath);
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
    ...(searchView.includeGlob ? { includeGlob: searchView.includeGlob } : {}),
  };
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
      allowPath: searchView.allowPath,
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

const MAX_COLLECTION_HISTORY_LIMIT = 500;
const DEFAULT_COLLECTION_HISTORY_LIMIT = 100;
const MAX_COLLECTION_QUERY_LIMIT = 500;

function collectionValue(value: unknown, label: string): CollectionValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectionValue(entry, label));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as RecordValue).map(([key, entry]) => [
        key,
        collectionValue(entry, label),
      ]),
    );
  }
  throw new Error(`${label} must be a JSON value.`);
}

function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** The query options a caller may shape; the collection path is validated separately. */
function collectionQueryParams(
  collectionPath: string,
  input: RecordValue,
): CollectionQueryParams {
  const params: CollectionQueryParams = { collectionPath };
  if (input.filter !== undefined) {
    const filter = record(input.filter, "filter");
    const operator = text(filter.operator, "filter operator", 20);
    if (operator !== "equals" && operator !== "contains") {
      throw new Error(`Unsupported filter operator: ${operator}`);
    }
    params.filter = {
      field: text(filter.field, "filter field", 256),
      operator,
      value: collectionValue(filter.value, "filter value"),
    };
  }
  if (input.sort !== undefined) {
    if (!Array.isArray(input.sort)) {
      throw new Error("sort must be an array of { field, direction }.");
    }
    params.sort = input.sort.map((entry) => {
      const sort = record(entry, "sort entry");
      const direction = text(sort.direction, "sort direction", 10);
      if (direction !== "asc" && direction !== "desc") {
        throw new Error(`Unsupported sort direction: ${direction}`);
      }
      return { field: text(sort.field, "sort field", 256), direction };
    });
  }
  if (input.groupBy !== undefined) {
    params.groupBy = text(input.groupBy, "groupBy", 256);
  }
  if (input.resolveRelations !== undefined) {
    if (typeof input.resolveRelations !== "boolean") {
      throw new Error("resolveRelations must be a boolean.");
    }
    params.resolveRelations = input.resolveRelations;
  }
  if (input.limit !== undefined) {
    params.limit = boundedInteger(input.limit, "limit", 1, MAX_COLLECTION_QUERY_LIMIT);
  }
  if (input.cursor !== undefined) {
    const cursor = record(input.cursor, "cursor");
    if (!Array.isArray(cursor.sortValues)) {
      throw new Error("cursor.sortValues must be an array.");
    }
    params.cursor = {
      sortValues: cursor.sortValues.map((entry) => {
        const sortValue = record(entry, "cursor sort value");
        if (typeof sortValue.present !== "boolean") {
          throw new Error("cursor sort value present must be a boolean.");
        }
        return {
          present: sortValue.present,
          value: collectionValue(sortValue.value, "cursor sort value"),
        };
      }),
      recordPath: text(cursor.recordPath, "cursor recordPath", 4096),
      recordId: text(cursor.recordId, "cursor recordId", 256),
    };
  }
  return params;
}

/** A record path's collection folder, used for the pre-write scope check. */
function collectionPathOfRecord(recordPath: string): string {
  const separator = recordPath.lastIndexOf("/");
  if (separator <= 0) {
    throw new Error(
      `Not a collection record path (records live inside a collection folder): ${recordPath}`,
    );
  }
  return recordPath.slice(0, separator);
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
      return context.reads.readText(path);
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
      return context.reads.readDatabase(path);
    }
    case "databases.edit": {
      if (!context.writable) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      const input = record(params);
      const path = sdkWorkspacePath(input.path, "write");
      const [edit] = databaseEdits(input);
      await context.reads.readDatabase(path);
      assertRequestSurfaceActive(context);
      return context.editDatabase({
        path,
        edit,
        author: context.author,
        nowMs: context.now?.() ?? Date.now(),
        ...(context.createId ? { operationId: context.createId() } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    case "collections.list":
      return context.reads.listCollections();
    case "collections.get": {
      const input = record(params);
      const collectionPath = sdkWorkspacePath(input.path);
      return context.reads.getCollection({ collectionPath });
    }
    case "collections.query": {
      const input = record(params);
      const collectionPath = sdkWorkspacePath(input.path);
      return context.reads.queryCollectionRecords(
        collectionQueryParams(collectionPath, input),
      );
    }
    case "collections.getRecord": {
      const input = record(params);
      const collectionPath = sdkWorkspacePath(input.path);
      return context.reads.getCollectionRecord({
        collectionPath,
        recordId: text(input.recordId, "recordId", 256),
        historyLimit:
          input.historyLimit === undefined
            ? DEFAULT_COLLECTION_HISTORY_LIMIT
            : boundedInteger(
                input.historyLimit,
                "historyLimit",
                1,
                MAX_COLLECTION_HISTORY_LIMIT,
              ),
        ...(input.beforeHistoryId === undefined
          ? {}
          : {
              beforeHistoryId: boundedInteger(
                input.beforeHistoryId,
                "beforeHistoryId",
                1,
                Number.MAX_SAFE_INTEGER,
              ),
            }),
      });
    }
    case "collections.setFields": {
      const port = requireCollectionEditPort(context);
      const input = record(params);
      const recordPath = sdkWorkspacePath(input.path, "write");
      // The port's read scope gates the write: a caller that cannot read
      // this record's collection cannot write into it either. This also
      // refuses a Markdown file that is not inside a collection.
      await context.reads.getCollection({
        collectionPath: collectionPathOfRecord(recordPath),
      });
      assertRequestSurfaceActive(context);
      return port.setRecordFields({
        recordPath,
        fields: record(input.fields, "fields"),
        author: context.author,
        ...(context.collectionWriteIdempotencyKey === undefined
          ? {}
          : { idempotencyKey: context.collectionWriteIdempotencyKey }),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    case "collections.createRecord": {
      const port = requireCollectionEditPort(context);
      const input = record(params);
      const collectionPath = sdkWorkspacePath(input.path, "write");
      const name = text(input.name, "name", 200);
      await context.reads.getCollection({ collectionPath });
      assertRequestSurfaceActive(context);
      return port.createRecord({
        collectionPath,
        name,
        ...(input.fields === undefined
          ? {}
          : { fields: record(input.fields, "fields") }),
        author: context.author,
        ...(context.collectionWriteIdempotencyKey === undefined
          ? {}
          : { idempotencyKey: context.collectionWriteIdempotencyKey }),
        ...(context.signal ? { signal: context.signal } : {}),
      });
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
