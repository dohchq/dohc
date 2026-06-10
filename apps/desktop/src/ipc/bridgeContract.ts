import { WORKSPACE_KINDS, WORKSPACE_MODES } from "@dohc/workspace-core";
import { z } from "zod";

// Typed contract for everything the preload bridge exposes. Main-process
// handlers validate payloads on arrival and results before returning them.
// The renderer never sees raw Electron APIs.

// Length caps: IPC payloads are untrusted; bound every renderer-supplied
// string so a hostile/buggy caller cannot cause memory/latency pressure.
// workspaceId doubles as the dohc-file:// URL HOSTNAME, so it must be
// hostname-safe and lowercase (URL hostnames lowercase silently — a
// case-variant id would break asset serving or alias another workspace).
// Our own ids are UUIDs; a foreign manifest with any other shape is rejected
// at attach time with a visible error.
const WORKSPACE_ID = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "workspace id must be lowercase alphanumeric/hyphens");
const PATH_STRING = z.string().min(1).max(4096);

// Enums derive from the workspace-core tuples (single source of truth) so a
// new kind/mode cannot make the type and the runtime validator disagree.
const KIND_ENUM = z.enum(WORKSPACE_KINDS);
const MODE_ENUM = z.enum(WORKSPACE_MODES);

export const PickWorkspaceRootResult = PATH_STRING.nullable();
export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;

export const WorkspaceSummary = z.object({
  workspaceId: WORKSPACE_ID,
  rootPath: PATH_STRING,
  kind: KIND_ENUM,
  mode: MODE_ENUM,
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceRegistryResult = z.object({
  workspaces: z.array(WorkspaceSummary),
});
export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;

export const DefaultWorkspaceRootResult = PATH_STRING;

export const CreateLocalWorkspacePayload = z.object({
  rootPath: PATH_STRING,
  kind: z.enum(["personal", "shared"]),
});
export type CreateLocalWorkspacePayload = z.infer<
  typeof CreateLocalWorkspacePayload
>;

export const AttachWorkspaceFolderPayload = z.object({
  rootPath: PATH_STRING,
});
export type AttachWorkspaceFolderPayload = z.infer<
  typeof AttachWorkspaceFolderPayload
>;

export const ListWorkspaceFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListWorkspaceFilesPayload = z.infer<
  typeof ListWorkspaceFilesPayload
>;

export const WorkspaceFileEntry = z.object({
  path: PATH_STRING,
  kind: z.enum(["file", "database", "app-source"]),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

export const ListWorkspaceFilesResult = z.object({
  files: z.array(WorkspaceFileEntry),
});
export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;

export const CreateWorkspaceFilePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type CreateWorkspaceFilePayload = z.infer<
  typeof CreateWorkspaceFilePayload
>;

export const CreateWorkspaceFileResult = z.object({
  path: PATH_STRING,
});
export type CreateWorkspaceFileResult = z.infer<
  typeof CreateWorkspaceFileResult
>;

export const ImportWorkspaceFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ImportWorkspaceFilesPayload = z.infer<
  typeof ImportWorkspaceFilesPayload
>;

export const ImportWorkspaceFilesResult = z.object({
  imported: z.array(PATH_STRING),
});
export type ImportWorkspaceFilesResult = z.infer<
  typeof ImportWorkspaceFilesResult
>;

export const OpenWorkspacePayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type OpenWorkspacePayload = z.infer<typeof OpenWorkspacePayload>;

export const ReadWorkspaceTextPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type ReadWorkspaceTextPayload = z.infer<typeof ReadWorkspaceTextPayload>;

export const OpenFileExternallyPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type OpenFileExternallyPayload = z.infer<
  typeof OpenFileExternallyPayload
>;

export const ReadWorkspaceTextResult = z.object({
  // Capped: text views are for human-scale files; very large files fall back
  // to a download affordance rather than streaming megabytes through IPC.
  text: z.string(),
  truncated: z.boolean(),
});
export type ReadWorkspaceTextResult = z.infer<typeof ReadWorkspaceTextResult>;

// Visible SQLite: the studio reads a snapshot (tables/columns/bounded rows),
// edits rows in place, and imports a source file into a new database. The
// on-disk .sqlite is canonical; raw bytes never CRDT-sync (edits flow as an
// op log). Identifiers are bounded — IPC payloads are untrusted.
const SQL_IDENT = z.string().min(1).max(256);

export const DatabaseColumnView = z.object({
  name: z.string(),
  type: z.string(),
  primaryKey: z.boolean().optional(),
  nullable: z.boolean().optional(),
});

export const DatabaseTableView = z.object({
  name: z.string(),
  columns: z.array(DatabaseColumnView),
  rows: z.array(z.record(z.unknown())),
});

export const DatabaseSnapshotResult = z.object({
  path: z.string(),
  tables: z.array(DatabaseTableView),
});
export type DatabaseSnapshotResult = z.infer<typeof DatabaseSnapshotResult>;

export const ReadWorkspaceDatabasePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type ReadWorkspaceDatabasePayload = z.infer<typeof ReadWorkspaceDatabasePayload>;

export const ApplyDatabaseEditPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  edit: z.object({
    table: SQL_IDENT,
    op: z.enum(["insert", "update", "upsert", "delete"]),
    pkColumn: SQL_IDENT,
    rowId: z.union([z.string().max(4096), z.number()]),
    payload: z.record(z.unknown()).optional(),
  }),
});
export type ApplyDatabaseEditPayload = z.infer<typeof ApplyDatabaseEditPayload>;

export const ImportToDatabasePayload = z.object({
  workspaceId: WORKSPACE_ID,
  sourceRelativePath: PATH_STRING,
  databaseRelativePath: PATH_STRING,
  tableName: SQL_IDENT,
});
export type ImportToDatabasePayload = z.infer<typeof ImportToDatabasePayload>;

export const ImportToDatabaseResult = z.object({
  path: z.string(),
  tableName: z.string(),
  rowCount: z.number().int().nonnegative(),
});
export type ImportToDatabaseResult = z.infer<typeof ImportToDatabaseResult>;

export const SyncStatusResult = z.object({
  state: z.enum([
    "synced",
    "syncing",
    "local-changes",
    "conflict",
    "cloud-disconnected",
  ]),
  pendingChangeCount: z.number().int().nonnegative(),
  lastSyncedAtMs: z.number().nullable(),
});
export type SyncStatusResult = z.infer<typeof SyncStatusResult>;

const ChangeAuthorSchema = z.union([
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({
    kind: z.literal("agent"),
    agentId: z.string(),
    onBehalfOf: z.string(),
  }),
]);

export const ChangeSetRecord = z.object({
  id: z.string().min(1),
  recordedAtMs: z.number(),
  kind: z.enum(["user-edit", "agent-run", "import", "sync", "app-build"]),
  author: ChangeAuthorSchema,
  summary: z.string(),
  humanSummary: z.string(),
  fileCount: z.number().int().nonnegative(),
});
export type ChangeSetRecord = z.infer<typeof ChangeSetRecord>;

export const ListChangeSetsResult = z.object({
  changeSets: z.array(ChangeSetRecord),
});
export type ListChangeSetsResult = z.infer<typeof ListChangeSetsResult>;

const AppCheck = z.object({
  name: z.string(),
  status: z.string(),
  message: z.string().optional(),
});

export const AppPackagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type AppPackagePayload = z.infer<typeof AppPackagePayload>;

export const AppPackageResult = z
  .object({
    name: z.string(),
    root: z.string(),
    manifest: z.object({
      title: z.string().optional(),
      entry: z.string(),
      read: z.array(z.string()),
      write: z.array(z.string()),
      agent: z.enum(["run", "patch.propose"]).optional(),
      network: z.literal(false),
    }),
    sourceFiles: z.array(z.string()),
    requiresTrust: z.boolean(),
    trusted: z.boolean(),
    readiness: z.enum(["needs-testing", "failed", "ready"]),
    lastTestChecks: z.array(AppCheck),
  })
  .nullable();
export type AppPackageResult = z.infer<typeof AppPackageResult>;

export const RunAppTesterPayload = z.object({
  workspaceId: WORKSPACE_ID,
  appRoot: PATH_STRING,
});
export type RunAppTesterPayload = z.infer<typeof RunAppTesterPayload>;

export const RunAppTesterResult = z.object({
  ok: z.boolean(),
  checks: z.array(AppCheck),
});
export type RunAppTesterResult = z.infer<typeof RunAppTesterResult>;

export const GrantAppTrustPayload = z.object({
  workspaceId: WORKSPACE_ID,
  appRoot: PATH_STRING,
});
export type GrantAppTrustPayload = z.infer<typeof GrantAppTrustPayload>;

export const LaunchMarksResult = z.object({
  appReadyMs: z.number().positive(),
  firstWindowMs: z.number().positive(),
  firstPaintMs: z.number().positive(),
  shellVisibleMs: z.number().positive().optional(),
});
export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;

export interface DohcDesktopBridge {
  pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
  getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
  getDefaultWorkspaceRoot(): Promise<string>;
  createLocalWorkspace(
    payload: CreateLocalWorkspacePayload,
  ): Promise<WorkspaceSummary>;
  attachWorkspaceFolder(
    payload: AttachWorkspaceFolderPayload,
  ): Promise<WorkspaceSummary>;
  listWorkspaceFiles(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListWorkspaceFilesResult>;
  createWorkspaceFile(
    payload: CreateWorkspaceFilePayload,
  ): Promise<CreateWorkspaceFileResult>;
  importWorkspaceFiles(
    payload: ImportWorkspaceFilesPayload,
  ): Promise<ImportWorkspaceFilesResult>;
  readWorkspaceText(
    payload: ReadWorkspaceTextPayload,
  ): Promise<ReadWorkspaceTextResult>;
  openFileExternally(payload: OpenFileExternallyPayload): Promise<void>;
  readWorkspaceDatabase(
    payload: ReadWorkspaceDatabasePayload,
  ): Promise<DatabaseSnapshotResult>;
  applyDatabaseEdit(
    payload: ApplyDatabaseEditPayload,
  ): Promise<DatabaseSnapshotResult>;
  importToDatabase(
    payload: ImportToDatabasePayload,
  ): Promise<ImportToDatabaseResult>;
  getAppPackage(payload: AppPackagePayload): Promise<AppPackageResult>;
  runAppTester(payload: RunAppTesterPayload): Promise<RunAppTesterResult>;
  grantAppTrust(payload: GrantAppTrustPayload): Promise<void>;
  openWorkspace(payload: OpenWorkspacePayload): Promise<SyncStatusResult>;
  listChangeSets(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListChangeSetsResult>;
  getSyncStatus(payload: ListWorkspaceFilesPayload): Promise<SyncStatusResult>;
  // Live push: main signals the renderer when the active workspace's files
  // or history changed (settled filesystem batch recorded). Returns an
  // unsubscribe function.
  onWorkspaceActivity(listener: () => void): () => void;
}
