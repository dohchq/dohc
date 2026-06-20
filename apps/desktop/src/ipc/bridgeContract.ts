import { WORKSPACE_KINDS, WORKSPACE_MODES } from "@dohc/workspace-core";
import { z } from "zod";
import {
  MAX_EXPANDED_FOLDERS,
  MAX_OPEN_TABS,
  MAX_PINNED_PATHS,
  MAX_RECENT_FILES,
  HISTORY_MAX_WIDTH,
  HISTORY_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  VIEW_IDS,
} from "../renderer/workbench/workbenchState";
import {
  EXPLORER_MENU_COMMANDS,
  MENU_COMMANDS,
  SEARCH_EVENT_MAX_ENTRIES,
  SEARCH_EVENT_MAX_ID_CHARS,
  SEARCH_EVENT_MAX_PREVIEW_CHARS,
  UPDATE_STATUSES,
  WORKBENCH_MENU_COMMANDS,
  type SearchResultsEvent,
} from "./channels";

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
  kind: z.enum(["file", "database"]),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

export const ListWorkspaceFilesResult = z.object({
  files: z.array(WorkspaceFileEntry),
  // Additive (Phase E3 explorer): directories ride along so EMPTY folders
  // appear in the tree. Optional so older fixtures/consumers keep parsing;
  // the main-side walk always provides it.
  folders: z.array(PATH_STRING).optional(),
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

// Phase E3 file-management surfaces. Every op mirrors createWorkspaceFile's
// handler shape (assertTrustedSender → parse → requireWorkspace → op →
// result parse) and the workspaceFiles containment sandwich on every path.

export const CreateWorkspaceFolderPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type CreateWorkspaceFolderPayload = z.infer<
  typeof CreateWorkspaceFolderPayload
>;

// rename === move: ONE engine — F2, inline rename, and drag-drop all call it.
export const MoveWorkspacePathPayload = z.object({
  workspaceId: WORKSPACE_ID,
  fromPath: PATH_STRING,
  toPath: PATH_STRING,
});
export type MoveWorkspacePathPayload = z.infer<typeof MoveWorkspacePathPayload>;

export const DeleteWorkspacePathPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type DeleteWorkspacePathPayload = z.infer<
  typeof DeleteWorkspacePathPayload
>;

// trashed: true = OS trash; false = the .dohc/trash fallback (cross-
// filesystem mounts where g_file_trash rejects). Both are recoverable.
export const DeleteWorkspacePathResult = z.object({
  trashed: z.boolean(),
});
export type DeleteWorkspacePathResult = z.infer<typeof DeleteWorkspacePathResult>;

// relativePath absent = export the whole workspace. The output path comes
// from a MAIN-process save dialog — the renderer never names one. null =
// the user cancelled the dialog.
export const ExportWorkspaceZipPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING.optional(),
});
export type ExportWorkspaceZipPayload = z.infer<typeof ExportWorkspaceZipPayload>;

export const ExportWorkspaceZipResult = z.object({
  path: PATH_STRING.nullable(),
});
export type ExportWorkspaceZipResult = z.infer<typeof ExportWorkspaceZipResult>;

// Explorer context menu: the renderer names WHAT was right-clicked, main
// builds the native Menu from main-owned labels over the closed
// EXPLORER_MENU_COMMANDS tuple (channels.ts) and resolves the SAME invoke
// with the chosen id (null = dismissed). No event channel needed.
export const ShowExplorerMenuPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // Absent for the root (container background) menu.
  path: PATH_STRING.optional(),
  kind: z.enum(["file", "folder", "root"]),
  pinned: z.boolean(),
});
export type ShowExplorerMenuPayload = z.infer<typeof ShowExplorerMenuPayload>;

export const ExplorerMenuCommand = z.enum(EXPLORER_MENU_COMMANDS);
export type ExplorerMenuCommand = z.infer<typeof ExplorerMenuCommand>;

export const ShowExplorerMenuResult = ExplorerMenuCommand.nullable();
export type ShowExplorerMenuResult = z.infer<typeof ShowExplorerMenuResult>;

export const ShowWorkbenchMenuPayload = z.object({
  workspaceId: WORKSPACE_ID,
  context: z.enum(["tab", "editor", "status"]),
  path: PATH_STRING.optional(),
});
export type ShowWorkbenchMenuPayload = z.infer<typeof ShowWorkbenchMenuPayload>;

export const WorkbenchMenuCommand = z.enum(WORKBENCH_MENU_COMMANDS);
export type WorkbenchMenuCommand = z.infer<typeof WorkbenchMenuCommand>;

export const ShowWorkbenchMenuResult = WorkbenchMenuCommand.nullable();
export type ShowWorkbenchMenuResult = z.infer<typeof ShowWorkbenchMenuResult>;

export const ImportWorkspaceFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // OS drag-in (Phase E3): absolute source paths resolved by the PRELOAD
  // (webUtils.getPathForFile) from a drop event. TRUST DELTA vs the dialog
  // flow: these are renderer-supplied — main re-validates every one through
  // the picker-grade import path (importDroppedPaths: regular files only,
  // never a registered workspace's .dohc) and the count is capped here.
  droppedPaths: z.array(PATH_STRING).max(100).optional(),
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

export const WriteWorkspaceTextPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  // Editor saves are bounded like reads (2MB); the handler re-checks bytes.
  text: z.string().max(2 * 1024 * 1024),
});
export type WriteWorkspaceTextPayload = z.infer<typeof WriteWorkspaceTextPayload>;

export const ReadWorkspaceTextResult = z.object({
  // Capped: text views are for human-scale files; very large files fall back
  // to a download affordance rather than streaming megabytes through IPC.
  text: z.string(),
  truncated: z.boolean(),
});
export type ReadWorkspaceTextResult = z.infer<typeof ReadWorkspaceTextResult>;

const WorkspaceGraphNode = z.object({
  path: PATH_STRING,
  title: z.string().max(120),
  outgoing: z.number().int().nonnegative(),
  incoming: z.number().int().nonnegative(),
});

const WorkspaceGraphEdge = z.object({
  source: PATH_STRING,
  target: PATH_STRING,
  kind: z.enum(["wikilink", "markdown"]),
});

export const ReadWorkspaceGraphPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ReadWorkspaceGraphPayload = z.infer<typeof ReadWorkspaceGraphPayload>;

export const WorkspaceGraphResult = z.object({
  nodes: z.array(WorkspaceGraphNode).max(2000),
  edges: z.array(WorkspaceGraphEdge).max(10000),
  unresolvedLinks: z.number().int().nonnegative(),
  scannedFileCount: z.number().int().nonnegative(),
  omittedFileCount: z.number().int().nonnegative(),
  truncatedFileCount: z.number().int().nonnegative(),
});
export type WorkspaceGraphResult = z.infer<typeof WorkspaceGraphResult>;

// Visible SQLite: the studio reads a snapshot (tables/columns/bounded rows),
// edits rows in place, and imports a source file into a new database. The
// on-disk .sqlite is canonical; raw bytes never CRDT-sync (edits flow as an
// op log). Identifiers are bounded — IPC payloads are untrusted.
const SQL_IDENT = z.string().min(1).max(256);

const DatabaseColumnView = z.object({
  name: z.string(),
  type: z.string(),
  primaryKey: z.boolean().optional(),
  nullable: z.boolean().optional(),
});

const DatabaseTableView = z.object({
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
  // Additive (Phase E2 status bar): HOW MANY files conflict, not just that
  // one does. Fed from the sync-engine snapshot in workspaceActivity —
  // optional so older producers/fixtures keep parsing.
  conflictCount: z.number().int().nonnegative().optional(),
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

export const ChangeSetFilePreview = z.object({
  path: z.string().min(1),
  operation: z.enum(["write", "delete", "rename"]),
});
export type ChangeSetFilePreview = z.infer<typeof ChangeSetFilePreview>;

export const ChangeSetLineStats = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  unavailableFileCount: z.number().int().nonnegative(),
});
export type ChangeSetLineStats = z.infer<typeof ChangeSetLineStats>;

const BoundaryCrossingSchema = z.enum([
  "public-share",
  "external-export",
  "permission-change",
  "bulk-delete",
  "site-publish",
  "private-to-shared",
  "unmergeable-overwrite",
]);
export type BoundaryCrossingRecord = z.infer<typeof BoundaryCrossingSchema>;

export const ChangeSetRecord = z.object({
  id: z.string().min(1),
  recordedAtMs: z.number(),
  kind: z.enum([
    "user-edit",
    "agent-run",
    "import",
    "sync",
    "site-build",
    "history-restore",
  ]),
  author: ChangeAuthorSchema,
  summary: z.string(),
  humanSummary: z.string(),
  fileCount: z.number().int().nonnegative(),
  reviewRequired: z.boolean().optional(),
  boundaryCrossingCount: z.number().int().nonnegative().optional(),
  filePreview: z.array(ChangeSetFilePreview).optional(),
  lineStats: ChangeSetLineStats.optional(),
  boundaryCrossingPreview: z.array(BoundaryCrossingSchema).optional(),
});
export type ChangeSetRecord = z.infer<typeof ChangeSetRecord>;

export const FileChangeSnapshot = z.object({
  sha256: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  unavailableReason: z
    .enum(["missing", "binary", "too-large", "unreadable"])
    .optional(),
});
export type FileChangeSnapshot = z.infer<typeof FileChangeSnapshot>;

export const ChangeSetFileRecord = z.object({
  path: z.string().min(1),
  operation: z.enum(["write", "delete", "rename"]),
  mediaType: z.string().optional(),
  before: FileChangeSnapshot.nullable().optional(),
  after: FileChangeSnapshot.nullable().optional(),
});
export type ChangeSetFileRecord = z.infer<typeof ChangeSetFileRecord>;

export const ChangeSetDetailRecord = ChangeSetRecord.extend({
  files: z.array(ChangeSetFileRecord),
  provenance: z
    .object({
      source: z.enum([
        "user-edit",
        "agent-run",
        "import",
        "sync",
        "site-build",
        "history-restore",
      ]),
      prompt: z.string().optional(),
      agentRunId: z.string().optional(),
      importPath: z.string().optional(),
      restoreOfChangeSetId: z.string().optional(),
      restoreOfPath: z.string().optional(),
      restoreDirection: z.enum(["restore", "undo"]).optional(),
    })
    .optional(),
  boundaryCrossings: z.array(BoundaryCrossingSchema),
});
export type ChangeSetDetailRecord = z.infer<typeof ChangeSetDetailRecord>;

export const ListChangeSetsResult = z.object({
  changeSets: z.array(ChangeSetRecord),
});
export type ListChangeSetsResult = z.infer<typeof ListChangeSetsResult>;

export const ReadChangeSetPayload = z.object({
  workspaceId: WORKSPACE_ID,
  changeSetId: z.string().min(1).max(500),
});
export type ReadChangeSetPayload = z.infer<typeof ReadChangeSetPayload>;

export const ReadChangeSetResult = z.object({
  changeSet: ChangeSetDetailRecord.nullable(),
});
export type ReadChangeSetResult = z.infer<typeof ReadChangeSetResult>;

export const RestoreHistoryFilePayload = z.object({
  workspaceId: WORKSPACE_ID,
  changeSetId: z.string().min(1).max(500),
  relativePath: PATH_STRING,
});
export type RestoreHistoryFilePayload = z.infer<typeof RestoreHistoryFilePayload>;

export const RestoreHistoryFileResult = z.object({
  restored: z.enum(["text", "deleted"]),
});
export type RestoreHistoryFileResult = z.infer<typeof RestoreHistoryFileResult>;

const SiteDiagnostic = z.object({
  path: PATH_STRING.optional(),
  severity: z.enum(["warning", "error"]),
  code: z.string().min(1).max(100),
  message: z.string().max(10_000).optional(),
});
export type SiteDiagnostic = z.infer<typeof SiteDiagnostic>;

const SiteScripts = z.object({
  dev: z.string().optional(),
  start: z.string().optional(),
  build: z.string().optional(),
  preview: z.string().optional(),
});
export type SiteScripts = z.infer<typeof SiteScripts>;

const SitePackageInfo = z.object({
  root: PATH_STRING,
  title: z.string().min(1).max(200),
  kind: z.enum(["static", "package", "configured"]),
  confidence: z.enum(["high", "medium", "low"]),
  entryPath: PATH_STRING.nullable(),
  configPath: PATH_STRING.nullable(),
  packagePath: PATH_STRING.nullable(),
  packageManager: z.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
  scripts: SiteScripts,
  configuredScripts: SiteScripts.optional(),
  buildOutputs: z.array(PATH_STRING).max(100),
  sourceFiles: z.array(PATH_STRING).max(1000),
  diagnostics: z.array(SiteDiagnostic).max(100),
});
export type SitePackageInfo = z.infer<typeof SitePackageInfo>;

export const ListSitesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListSitesPayload = z.infer<typeof ListSitesPayload>;

export const ListSitesResult = z.object({
  sites: z.array(SitePackageInfo).max(100),
});
export type ListSitesResult = z.infer<typeof ListSitesResult>;

export const SitePackagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type SitePackagePayload = z.infer<typeof SitePackagePayload>;

export const SitePackageResult = SitePackageInfo.nullable();
export type SitePackageResult = z.infer<typeof SitePackageResult>;

export const SitePreviewMode = z.enum(["static", "dev", "build"]);
export type SitePreviewMode = z.infer<typeof SitePreviewMode>;

export const StartSitePreviewPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: PATH_STRING,
  mode: SitePreviewMode,
});
export type StartSitePreviewPayload = z.infer<typeof StartSitePreviewPayload>;

const SiteLogEntry = z.object({
  stream: z.enum(["stdout", "stderr", "system"]),
  text: z.string().max(10_000),
  at: z.number(),
});
export type SiteLogEntry = z.infer<typeof SiteLogEntry>;

const LoopbackPreviewUrl = z.string().min(1).max(2048).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid URL" });
    return;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preview URL must be an unauthenticated loopback HTTP URL",
    });
  }
});

export const StartSitePreviewResult = z.object({
  siteRoot: PATH_STRING,
  mode: SitePreviewMode,
  url: LoopbackPreviewUrl,
  logs: z.array(SiteLogEntry).max(500),
  build: z
    .object({
      ok: z.boolean(),
      command: z.string(),
      args: z.array(z.string()),
      outputPath: z.string().nullable(),
      exitCode: z.number().nullable(),
    })
    .optional(),
});
export type StartSitePreviewResult = z.infer<typeof StartSitePreviewResult>;

export const StopSitePreviewPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: PATH_STRING,
});
export type StopSitePreviewPayload = z.infer<typeof StopSitePreviewPayload>;

// dohc Cloud login (device-authorization flow): the desktop shows a short
// code, the user approves in the system browser, the desktop polls. The
// session token never reaches the renderer — main stores it via safeStorage
// and the renderer only ever sees connection status + email.
export const OpenExternalUrlPayload = z.object({
  url: z.string().min(1).max(2048),
});
export type OpenExternalUrlPayload = z.infer<typeof OpenExternalUrlPayload>;

export const CloudLoginStartPayload = z.object({
  serverUrl: z.string().url().max(2048).optional(),
});
export type CloudLoginStartPayload = z.infer<typeof CloudLoginStartPayload>;

export const CloudLoginStartResult = z.object({
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
});
export type CloudLoginStartResult = z.infer<typeof CloudLoginStartResult>;

export const CloudLoginPollResult = z.object({
  status: z.enum(["pending", "complete", "denied", "expired"]),
  email: z.string().optional(),
});
export type CloudLoginPollResult = z.infer<typeof CloudLoginPollResult>;

export const CloudStatusPayload = z.object({
  workspaceId: WORKSPACE_ID.optional(),
});
export type CloudStatusPayload = z.infer<typeof CloudStatusPayload>;

export const CloudStatusResult = z.object({
  connected: z.boolean(),
  email: z.string().optional(),
  serverUrl: z.string().optional(),
  // Whether the named workspace has cloud sync enabled (registry remote set).
  workspaceSynced: z.boolean().optional(),
});
export type CloudStatusResult = z.infer<typeof CloudStatusResult>;

export const CloudEnableSyncPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type CloudEnableSyncPayload = z.infer<typeof CloudEnableSyncPayload>;

const EMAIL_STRING = z.string().email().max(320);
const SHARE_ID = z.string().min(1).max(200);
const SHARE_CAPABILITY = z.enum(["view", "edit"]);
const DATA_FRAGMENT_ID = z.string().min(1).max(200);
const DATA_FRAGMENT_BODY = z.string().min(1).max(200_000);
const DATA_FRAGMENT_TEXT = z.string().min(1).max(500);

export const WorkspaceShareRow = z.object({
  shareId: SHARE_ID,
  workspaceId: WORKSPACE_ID,
  atomId: z.string().min(1).max(200),
  atomPath: PATH_STRING.nullable(),
  recipientUserId: z.string().min(1).max(200),
  recipientEmail: EMAIL_STRING,
  capability: SHARE_CAPABILITY,
});
export type WorkspaceShareRow = z.infer<typeof WorkspaceShareRow>;

export const ListWorkspaceSharesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListWorkspaceSharesPayload = z.infer<
  typeof ListWorkspaceSharesPayload
>;

export const ListWorkspaceSharesResult = z.object({
  shares: z.array(WorkspaceShareRow).max(500),
});
export type ListWorkspaceSharesResult = z.infer<
  typeof ListWorkspaceSharesResult
>;

export const CreateWorkspaceSharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  atomPath: PATH_STRING,
  recipientEmail: EMAIL_STRING,
  capability: SHARE_CAPABILITY,
});
export type CreateWorkspaceSharePayload = z.infer<
  typeof CreateWorkspaceSharePayload
>;

export const CreateWorkspaceShareResult = z.object({
  share: WorkspaceShareRow,
});
export type CreateWorkspaceShareResult = z.infer<
  typeof CreateWorkspaceShareResult
>;

export const RevokeWorkspaceSharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: SHARE_ID,
});
export type RevokeWorkspaceSharePayload = z.infer<
  typeof RevokeWorkspaceSharePayload
>;

export const DataFragmentSummary = z.object({
  fragmentId: DATA_FRAGMENT_ID,
  sourceWorkspaceId: WORKSPACE_ID,
  sourcePath: PATH_STRING.nullable(),
  title: DATA_FRAGMENT_TEXT,
  preview: DATA_FRAGMENT_TEXT,
  contentType: z.string().min(1).max(100),
  createdBy: z.string().min(1).max(200),
  createdAt: z.string().min(1).max(100),
  recipientEmail: EMAIL_STRING.nullable(),
});
export type DataFragmentSummary = z.infer<typeof DataFragmentSummary>;

export const CreateDataFragmentPayload = z.object({
  workspaceId: WORKSPACE_ID,
  sourcePath: PATH_STRING.optional(),
  title: DATA_FRAGMENT_TEXT.optional(),
  contentType: z.string().min(1).max(100).optional(),
  body: DATA_FRAGMENT_BODY,
  recipientEmail: EMAIL_STRING,
});
export type CreateDataFragmentPayload = z.infer<typeof CreateDataFragmentPayload>;

export const CreateDataFragmentResult = z.object({
  fragment: DataFragmentSummary,
});
export type CreateDataFragmentResult = z.infer<typeof CreateDataFragmentResult>;

export const ListDataFragmentsPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListDataFragmentsPayload = z.infer<typeof ListDataFragmentsPayload>;

export const ListDataFragmentsResult = z.object({
  fragments: z.array(DataFragmentSummary).max(500),
});
export type ListDataFragmentsResult = z.infer<typeof ListDataFragmentsResult>;

export const ReadDataFragmentPayload = z.object({
  workspaceId: WORKSPACE_ID,
  fragmentId: DATA_FRAGMENT_ID,
});
export type ReadDataFragmentPayload = z.infer<typeof ReadDataFragmentPayload>;

export const ReadDataFragmentResult = z.object({
  fragment: DataFragmentSummary.extend({
    body: DATA_FRAGMENT_BODY,
  }),
});
export type ReadDataFragmentResult = z.infer<typeof ReadDataFragmentResult>;

export const RevokeDataFragmentPayload = z.object({
  workspaceId: WORKSPACE_ID,
  fragmentId: DATA_FRAGMENT_ID,
});
export type RevokeDataFragmentPayload = z.infer<typeof RevokeDataFragmentPayload>;

export const WorkspaceMemberRow = z.object({
  userId: z.string().min(1).max(200),
  email: EMAIL_STRING.nullable(),
  role: z.string().min(1).max(50),
});
export type WorkspaceMemberRow = z.infer<typeof WorkspaceMemberRow>;

export const ListWorkspaceMembersResult = z.object({
  members: z.array(WorkspaceMemberRow).max(500),
});
export type ListWorkspaceMembersResult = z.infer<
  typeof ListWorkspaceMembersResult
>;

export const WorkspaceInviteRow = z.object({
  inviteId: z.string().min(1).max(200),
  workspaceId: WORKSPACE_ID,
  email: EMAIL_STRING,
  role: z.string().min(1).max(50),
  invitedBy: z.string().min(1).max(200),
  status: z.enum(["pending", "claimed"]),
});
export type WorkspaceInviteRow = z.infer<typeof WorkspaceInviteRow>;

export const ListWorkspaceInvitesResult = z.object({
  invites: z.array(WorkspaceInviteRow).max(500),
});
export type ListWorkspaceInvitesResult = z.infer<
  typeof ListWorkspaceInvitesResult
>;

export const CreateWorkspaceInvitePayload = z.object({
  workspaceId: WORKSPACE_ID,
  email: EMAIL_STRING,
});
export type CreateWorkspaceInvitePayload = z.infer<
  typeof CreateWorkspaceInvitePayload
>;

export const CreateWorkspaceInviteResult = z.object({
  invite: WorkspaceInviteRow,
});
export type CreateWorkspaceInviteResult = z.infer<
  typeof CreateWorkspaceInviteResult
>;

export const RevokeWorkspaceInvitePayload = z.object({
  workspaceId: WORKSPACE_ID,
  inviteId: z.string().min(1).max(200),
});
export type RevokeWorkspaceInvitePayload = z.infer<
  typeof RevokeWorkspaceInvitePayload
>;

// Live co-editing token: the renderer asks for a short-lived collab JWT for a
// specific markdown atom in a SHARED cloud workspace. Main mints it
// by calling the workspace-api POST /workspaces/:id/collab/token endpoint with
// the cloud session Bearer — the session token never crosses IPC; only the
// 5-min collab token, the doc name, server body base, and websocket URL come back. Returns
// { available: false } whenever the workspace isn't a signed-in shared cloud
// workspace (personal/local-only behaves exactly as before).
export const CollabTokenPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type CollabTokenPayload = z.infer<typeof CollabTokenPayload>;

export const CollabTokenResult = z.union([
  z.object({
    available: z.literal(true),
    token: z.string().min(1),
    documentName: z.string().min(1),
    baseMarkdown: z.string(),
    wsUrl: z.string().min(1),
  }),
  z.object({ available: z.literal(false) }),
]);
export type CollabTokenResult = z.infer<typeof CollabTokenResult>;

// Local agent integration (Phase 11). An agent run is a LOCAL concept: a small
// record persisted to .dohc/agent-runs.json. Enabling a run (optionally) spawns
// the managed MCP stdio child for the workspace and sets the watcher's
// active-run slot, so the run's writes are attributed to the agent.
export const AgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type AgentRunPayload = z.infer<typeof AgentRunPayload>;

export const EndAgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
  runId: z.string().min(1).max(200),
  status: z.enum(["complete", "failed"]).optional(),
});
export type EndAgentRunPayload = z.infer<typeof EndAgentRunPayload>;

const AgentRunRecordSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  agentId: z.string(),
  onBehalfOf: z.string(),
  status: z.enum(["running", "complete", "failed"]),
});

export const StartAgentRunResult = AgentRunRecordSchema;
export type StartAgentRunResult = z.infer<typeof StartAgentRunResult>;

export const AgentRunStatusResult = z.object({
  mcpEnabled: z.boolean(),
  activeRun: AgentRunRecordSchema.nullable(),
  lastRun: AgentRunRecordSchema.nullable(),
});
export type AgentRunStatusResult = z.infer<typeof AgentRunStatusResult>;

// The copyable MCP config the user pastes into their AI tool. Main owns the
// real command/args (the renderer never invents a path or argv).
export const McpConfigResult = z.object({
  command: z.string(),
  args: z.array(z.string()),
  workspacePath: z.string(),
  home: z.string(),
});
export type McpConfigResult = z.infer<typeof McpConfigResult>;

const AgentDriverIdSchema = z.string().min(1).max(100);
const AgentPermissionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
const AgentPermissionDecisionSchema = z.union([
  AgentPermissionKindSchema,
  z.literal("cancel"),
]);
export type AgentPermissionDecision = z.infer<typeof AgentPermissionDecisionSchema>;

const AgentModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  planIncluded: z.boolean(),
});

const AgentDriverProbeSchema = z.object({
  id: AgentDriverIdSchema,
  displayName: z.string().min(1).max(100),
  installed: z.boolean(),
  version: z.string().max(200).optional(),
  auth: z.object({
    status: z.enum(["authenticated", "unauthenticated", "unknown"]),
    label: z.string().max(200).optional(),
  }),
  models: z.array(AgentModelSchema).max(50),
  errorMessage: z.string().max(500).optional(),
});

const AgentPermissionOptionSchema = z.object({
  optionId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  kind: AgentPermissionKindSchema,
});

const AgentPermissionRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  requestType: z.enum(["command", "file-change", "file-read", "tool", "other"]),
  title: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
  locations: z.array(z.string().min(1).max(1000)).max(20),
  options: z.array(AgentPermissionOptionSchema).max(8),
});

const AgentSessionSnapshotSchema = z.object({
  driverId: AgentDriverIdSchema,
  driverName: z.string().min(1).max(100),
  status: z.enum([
    "idle",
    "starting",
    "ready",
    "running",
    "waiting-permission",
    "completed",
    "failed",
    "stopped",
  ]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  runId: z.string().min(1).max(200).optional(),
  lastError: z.string().max(500).optional(),
  messages: z.array(
    z.object({
      id: z.string().min(1).max(300),
      role: z.enum(["assistant", "reasoning"]),
      text: z.string().max(10_000),
    }),
  ).max(200),
  items: z.array(
    z.object({
      id: z.string().min(1).max(300),
      type: z.enum(["tool_call", "command", "file_change", "mcp_tool_call", "web_search", "plan", "other"]),
      title: z.string().min(1).max(200),
      detail: z.string().max(500).optional(),
      status: z.enum(["pending", "in_progress", "completed", "failed"]),
      locations: z.array(z.string().min(1).max(1000)).max(20),
    }),
  ).max(200),
  pendingPermissions: z.array(AgentPermissionRequestSchema).max(20),
  usage: z.object({
    used: z.number(),
    max: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
  authNotices: z.array(z.string().min(1).max(300)).max(5),
});

export const AgentPanelSnapshotResult = z.object({
  drivers: z.array(AgentDriverProbeSchema).max(20),
  session: AgentSessionSnapshotSchema.nullable(),
});
export type AgentPanelSnapshotResult = z.infer<typeof AgentPanelSnapshotResult>;

export const StartAgentSessionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  driverId: AgentDriverIdSchema,
  prompt: z.string().min(1).max(20_000),
  model: z.string().min(1).max(200).optional(),
});
export type StartAgentSessionPayload = z.infer<typeof StartAgentSessionPayload>;

export const AgentPermissionResponsePayload = z.object({
  workspaceId: WORKSPACE_ID,
  requestId: z.string().min(1).max(200),
  decision: AgentPermissionDecisionSchema,
});
export type AgentPermissionResponsePayload = z.infer<typeof AgentPermissionResponsePayload>;

// Native window chrome (Phase E1). The renderer mirrors its theme flip to
// main so the OS titleBarOverlay (Windows/Linux) re-tints with the app; main
// feature-detects overlay support and no-ops where it doesn't exist.
export const SetTitlebarThemePayload = z.object({
  theme: z.enum(["light", "dark"]),
});
export type SetTitlebarThemePayload = z.infer<typeof SetTitlebarThemePayload>;

// Application-menu commands. One closed set (channels.ts owns the tuple; the
// sandboxed preload validates against it as a plain value): the menu sends
// these names and the shell routes them through the SAME command registry the
// palette uses — menu items never grow their own action definitions.
export const MenuCommand = z.enum(MENU_COMMANDS);
export type MenuCommand = z.infer<typeof MenuCommand>;

// Main→renderer auto-update event (Phase E2 status bar toast). channels.ts
// owns the closed status tuple and the dependency-free preload check
// (parseUpdateStateEvent) — this schema derives from the same tuple so the
// two can never drift. Only {status, message} ever crosses the boundary.
export const UpdateStateEvent = z.object({
  status: z.enum(UPDATE_STATUSES),
  message: z.string().min(1).max(500),
});
export type UpdateStateEvent = z.infer<typeof UpdateStateEvent>;

// Per-workspace UI state persisted to .dohc/ui-state.json by MAIN (the
// renderer cannot write .dohc through writeWorkspaceText by design —
// validateUserWritePath refuses reserved paths). The clamp/cap constants are
// the pure workbench model's, so contract and model can never disagree.
export const WorkspaceUiState = z.object({
  version: z.literal(1),
  activeView: z.enum(VIEW_IDS),
  sidebarVisible: z.boolean(),
  sidebarWidth: z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
  tabs: z.array(PATH_STRING).max(MAX_OPEN_TABS),
  activeTab: PATH_STRING.nullable(),
  historyVisible: z.boolean(),
  historyWidth: z.number().int().min(HISTORY_MIN_WIDTH).max(HISTORY_MAX_WIDTH).optional(),
  // Additive (Phase E3 explorer), still version 1: optional fields parse old
  // files, and zod's non-strict parse drops unknown keys for old readers.
  expandedFolders: z.array(PATH_STRING).max(MAX_EXPANDED_FOLDERS).optional(),
  pinned: z.array(PATH_STRING).max(MAX_PINNED_PATHS).optional(),
  // Additive (Phase E5.0 quick-open ranking), still version 1: the last ~20
  // opened files, most recent first — recency boosts quick-open results.
  recentFiles: z.array(PATH_STRING).max(MAX_RECENT_FILES).optional(),
});
export type WorkspaceUiState = z.infer<typeof WorkspaceUiState>;

export const GetWorkspaceUiStateResult = WorkspaceUiState.nullable();
export type GetWorkspaceUiStateResult = z.infer<typeof GetWorkspaceUiStateResult>;

export const SetWorkspaceUiStatePayload = z.object({
  workspaceId: WORKSPACE_ID,
  state: WorkspaceUiState,
});
export type SetWorkspaceUiStatePayload = z.infer<typeof SetWorkspaceUiStatePayload>;

// Workspace content search (Phase E5.0). The renderer mints a bounded
// searchId per search; main spawns ripgrep rooted at the real workspace root
// and STREAMS batches back over the desktop:search-results event channel
// (closed shape, validated in the dependency-free preload via
// parseSearchResultsEvent — these zod schemas are the main-side mirror, with
// the same bounds, used to validate batches BEFORE they are sent).
const SEARCH_ID = z.string().min(1).max(SEARCH_EVENT_MAX_ID_CHARS);

export const WorkspaceSearchPayload = z.object({
  workspaceId: WORKSPACE_ID,
  searchId: SEARCH_ID,
  // Bounded like every IPC string: a pattern is a line of text, never a blob.
  query: z.string().min(1).max(1000),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
  includeGlob: z.string().min(1).max(256).optional(),
  excludeGlob: z.string().min(1).max(256).optional(),
});
export type WorkspaceSearchPayload = z.infer<typeof WorkspaceSearchPayload>;

export const CancelWorkspaceSearchPayload = z.object({
  searchId: SEARCH_ID,
});
export type CancelWorkspaceSearchPayload = z.infer<
  typeof CancelWorkspaceSearchPayload
>;

const SearchResultEntrySchema = z.object({
  path: PATH_STRING,
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  preview: z.string().max(SEARCH_EVENT_MAX_PREVIEW_CHARS),
  matchStart: z.number().int().min(0),
  matchEnd: z.number().int().min(0),
});

export const SearchResultsEventSchema = z.object({
  searchId: SEARCH_ID,
  entries: z.array(SearchResultEntrySchema).max(SEARCH_EVENT_MAX_ENTRIES),
  done: z.boolean(),
  limitHit: z.boolean(),
});
export type SearchResultsEventSchema = z.infer<typeof SearchResultsEventSchema>;

// Test-only snapshot of the main-process mark/measure recorder (Phase 16):
// named marks as wall-clock epochs, measures as durations between marks.
export const DesktopMarksResult = z.object({
  marks: z.record(z.number()),
  measures: z.record(z.number()),
});
export type DesktopMarksResult = z.infer<typeof DesktopMarksResult>;

export const LaunchMarksResult = z.object({
  appReadyMs: z.number().positive(),
  firstWindowMs: z.number().positive(),
  firstPaintMs: z.number().positive(),
  shellVisibleMs: z.number().positive().optional(),
});
export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;

export interface DohcDesktopBridge {
  // Constant, not a call: the titlebar lays out around macOS traffic lights
  // on darwin vs the window-controls overlay everywhere else.
  platform: NodeJS.Platform;
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
  createWorkspaceFolder(
    payload: CreateWorkspaceFolderPayload,
  ): Promise<CreateWorkspaceFileResult>;
  moveWorkspacePath(
    payload: MoveWorkspacePathPayload,
  ): Promise<CreateWorkspaceFileResult>;
  deleteWorkspacePath(
    payload: DeleteWorkspacePathPayload,
  ): Promise<DeleteWorkspacePathResult>;
  exportWorkspaceZip(
    payload: ExportWorkspaceZipPayload,
  ): Promise<ExportWorkspaceZipResult>;
  // Native explorer context menu; resolves with the chosen closed-tuple
  // command (validated in the preload via isExplorerMenuCommand) or null.
  showExplorerMenu(
    payload: ShowExplorerMenuPayload,
  ): Promise<ShowExplorerMenuResult>;
  showWorkbenchMenu(
    payload: ShowWorkbenchMenuPayload,
  ): Promise<ShowWorkbenchMenuResult>;
  // OS drag-in: maps dropped File objects to absolute paths via
  // webUtils.getPathForFile in the PRELOAD (sandboxed renderers have no
  // File.path since Electron 32). The paths feed importWorkspaceFiles'
  // droppedPaths — see the trust-delta note on that payload.
  getDroppedFilePaths(files: File[]): string[];
  importWorkspaceFiles(
    payload: ImportWorkspaceFilesPayload,
  ): Promise<ImportWorkspaceFilesResult>;
  createDataFragment(
    payload: CreateDataFragmentPayload,
  ): Promise<CreateDataFragmentResult>;
  listDataFragments(
    payload: ListDataFragmentsPayload,
  ): Promise<ListDataFragmentsResult>;
  readDataFragment(
    payload: ReadDataFragmentPayload,
  ): Promise<ReadDataFragmentResult>;
  revokeDataFragment(payload: RevokeDataFragmentPayload): Promise<void>;
  readWorkspaceText(
    payload: ReadWorkspaceTextPayload,
  ): Promise<ReadWorkspaceTextResult>;
  writeWorkspaceText(payload: WriteWorkspaceTextPayload): Promise<void>;
  openFileExternally(payload: OpenFileExternallyPayload): Promise<void>;
  readWorkspaceGraph(
    payload: ReadWorkspaceGraphPayload,
  ): Promise<WorkspaceGraphResult>;
  readWorkspaceDatabase(
    payload: ReadWorkspaceDatabasePayload,
  ): Promise<DatabaseSnapshotResult>;
  applyDatabaseEdit(
    payload: ApplyDatabaseEditPayload,
  ): Promise<DatabaseSnapshotResult>;
  importToDatabase(
    payload: ImportToDatabasePayload,
  ): Promise<ImportToDatabaseResult>;
  listSites(payload: ListSitesPayload): Promise<ListSitesResult>;
  getSitePackage(payload: SitePackagePayload): Promise<SitePackageResult>;
  startSitePreview(payload: StartSitePreviewPayload): Promise<StartSitePreviewResult>;
  stopSitePreview(payload: StopSitePreviewPayload): Promise<void>;
  openExternalUrl(payload: OpenExternalUrlPayload): Promise<void>;
  cloudLoginStart(payload: CloudLoginStartPayload): Promise<CloudLoginStartResult>;
  cloudLoginPoll(): Promise<CloudLoginPollResult>;
  cloudStatus(payload?: CloudStatusPayload): Promise<CloudStatusResult>;
  cloudLogout(): Promise<void>;
  cloudEnableSync(payload: CloudEnableSyncPayload): Promise<SyncStatusResult>;
  listWorkspaceShares(
    payload: ListWorkspaceSharesPayload,
  ): Promise<ListWorkspaceSharesResult>;
  createWorkspaceShare(
    payload: CreateWorkspaceSharePayload,
  ): Promise<CreateWorkspaceShareResult>;
  revokeWorkspaceShare(payload: RevokeWorkspaceSharePayload): Promise<void>;
  listWorkspaceMembers(
    payload: ListWorkspaceSharesPayload,
  ): Promise<ListWorkspaceMembersResult>;
  listWorkspaceInvites(
    payload: ListWorkspaceSharesPayload,
  ): Promise<ListWorkspaceInvitesResult>;
  createWorkspaceInvite(
    payload: CreateWorkspaceInvitePayload,
  ): Promise<CreateWorkspaceInviteResult>;
  revokeWorkspaceInvite(payload: RevokeWorkspaceInvitePayload): Promise<void>;
  collabToken(payload: CollabTokenPayload): Promise<CollabTokenResult>;
  openWorkspace(payload: OpenWorkspacePayload): Promise<SyncStatusResult>;
  listChangeSets(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListChangeSetsResult>;
  readChangeSet(payload: ReadChangeSetPayload): Promise<ReadChangeSetResult>;
  restoreHistoryFile(
    payload: RestoreHistoryFilePayload,
  ): Promise<RestoreHistoryFileResult>;
  undoHistoryFileRestore(
    payload: RestoreHistoryFilePayload,
  ): Promise<RestoreHistoryFileResult>;
  getSyncStatus(payload: ListWorkspaceFilesPayload): Promise<SyncStatusResult>;
  startAgentRun(payload: AgentRunPayload): Promise<StartAgentRunResult>;
  endAgentRun(payload: EndAgentRunPayload): Promise<void>;
  getAgentRunStatus(payload: AgentRunPayload): Promise<AgentRunStatusResult>;
  getMcpConfig(payload: AgentRunPayload): Promise<McpConfigResult>;
  probeAgentDrivers(payload: AgentRunPayload): Promise<AgentPanelSnapshotResult>;
  getAgentSessionState(payload: AgentRunPayload): Promise<AgentPanelSnapshotResult>;
  startAgentSession(payload: StartAgentSessionPayload): Promise<AgentPanelSnapshotResult>;
  stopAgentSession(payload: AgentRunPayload): Promise<AgentPanelSnapshotResult>;
  answerAgentPermission(
    payload: AgentPermissionResponsePayload,
  ): Promise<AgentPanelSnapshotResult>;
  setTitlebarTheme(payload: SetTitlebarThemePayload): Promise<void>;
  // Per-workspace workbench UI state (.dohc/ui-state.json), main-owned.
  getWorkspaceUiState(
    payload: ListWorkspaceFilesPayload,
  ): Promise<GetWorkspaceUiStateResult>;
  setWorkspaceUiState(payload: SetWorkspaceUiStatePayload): Promise<void>;
  // Live push: main signals the renderer when the active workspace's files
  // or history changed (settled filesystem batch recorded). Returns an
  // unsubscribe function.
  onWorkspaceActivity(listener: () => void): () => void;
  // Application-menu clicks, validated against MenuCommand in the preload
  // before they reach renderer code. Returns an unsubscribe function.
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  // Native Open Recent / OS "Open with dohc" activation. Main sends a full
  // workspace summary; the preload strips and validates it before the root
  // swaps workspaces.
  onWorkspaceActivated(listener: (workspace: WorkspaceSummary) => void): () => void;
  // Auto-update state pushes from main, validated against the closed
  // UPDATE_STATUSES tuple in the preload (parseUpdateStateEvent) before they
  // reach renderer code. Returns an unsubscribe function.
  onUpdateState(listener: (state: UpdateStateEvent) => void): () => void;
  // Workspace content search (Phase E5.0). Resolves when the search has been
  // ACCEPTED and the rg child spawned; results stream separately through
  // onSearchResults. Issuing a new search cancels the previous one in main.
  searchWorkspace(payload: WorkspaceSearchPayload): Promise<void>;
  cancelWorkspaceSearch(payload: CancelWorkspaceSearchPayload): Promise<void>;
  // Streamed result batches, validated batch-by-batch in the preload via the
  // closed dependency-free parseSearchResultsEvent check. Returns an
  // unsubscribe function. The searchId round-trips so the renderer drops
  // batches that belong to a superseded search.
  onSearchResults(listener: (batch: SearchResultsEvent) => void): () => void;
}
