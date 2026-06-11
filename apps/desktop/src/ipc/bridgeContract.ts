import { WORKSPACE_KINDS, WORKSPACE_MODES } from "@dohc/workspace-core";
import { z } from "zod";
import { MENU_COMMANDS } from "./channels";

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

// Live co-editing token: the renderer asks for a short-lived collab JWT for a
// specific atom (markdown/text file) in a SHARED cloud workspace. Main mints it
// by calling the workspace-api POST /workspaces/:id/collab/token endpoint with
// the cloud session Bearer — the session token never crosses IPC; only the
// 5-min collab token, the doc name, and the websocket URL come back. Returns
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
  importWorkspaceFiles(
    payload: ImportWorkspaceFilesPayload,
  ): Promise<ImportWorkspaceFilesResult>;
  readWorkspaceText(
    payload: ReadWorkspaceTextPayload,
  ): Promise<ReadWorkspaceTextResult>;
  writeWorkspaceText(payload: WriteWorkspaceTextPayload): Promise<void>;
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
  openExternalUrl(payload: OpenExternalUrlPayload): Promise<void>;
  cloudLoginStart(payload: CloudLoginStartPayload): Promise<CloudLoginStartResult>;
  cloudLoginPoll(): Promise<CloudLoginPollResult>;
  cloudStatus(payload?: CloudStatusPayload): Promise<CloudStatusResult>;
  cloudLogout(): Promise<void>;
  cloudEnableSync(payload: CloudEnableSyncPayload): Promise<SyncStatusResult>;
  collabToken(payload: CollabTokenPayload): Promise<CollabTokenResult>;
  openWorkspace(payload: OpenWorkspacePayload): Promise<SyncStatusResult>;
  listChangeSets(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListChangeSetsResult>;
  getSyncStatus(payload: ListWorkspaceFilesPayload): Promise<SyncStatusResult>;
  startAgentRun(payload: AgentRunPayload): Promise<StartAgentRunResult>;
  endAgentRun(payload: EndAgentRunPayload): Promise<void>;
  getAgentRunStatus(payload: AgentRunPayload): Promise<AgentRunStatusResult>;
  getMcpConfig(payload: AgentRunPayload): Promise<McpConfigResult>;
  setTitlebarTheme(payload: SetTitlebarThemePayload): Promise<void>;
  // Live push: main signals the renderer when the active workspace's files
  // or history changed (settled filesystem batch recorded). Returns an
  // unsubscribe function.
  onWorkspaceActivity(listener: () => void): () => void;
  // Application-menu clicks, validated against MenuCommand in the preload
  // before they reach renderer code. Returns an unsubscribe function.
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}
