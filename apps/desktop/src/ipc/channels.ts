// The closed application-menu command set. Lives here (not bridgeContract)
// because the SANDBOXED preload validates against it as a value, and this
// module must stay dependency-free — bridgeContract pulls zod/workspace-core,
// which a sandboxed preload cannot require at runtime.
export const MENU_COMMANDS = [
  "new-file",
  "new-folder",
  "open-workspace",
  "import-export",
  "import-files",
  "export-workspace",
  "command-palette",
  "quick-open",
  "toggle-sidebar",
  "toggle-theme",
  "settings",
  "close-tab",
] as const;

export type MenuCommandId = (typeof MENU_COMMANDS)[number];

// THE preload boundary check for menu events: only an exact PRIMITIVE string
// from the closed tuple passes — String objects, toString tricks, case
// variants, and unknown ids are all dropped. Exported so the boundary itself
// is unit-tested (not just the renderer-side registry lookup behind it).
export function isMenuCommand(value: unknown): value is MenuCommandId {
  return (
    typeof value === "string" &&
    (MENU_COMMANDS as readonly string[]).includes(value)
  );
}

// The closed explorer context-menu command set (Phase E3). Same pattern as
// MENU_COMMANDS: the renderer asks main to pop a native menu built from
// MAIN-owned labels over this closed set, and the chosen id comes back over
// the SAME invoke. Lives here (dependency-free) so the sandboxed preload can
// validate the RESULT against it as a plain value before renderer code sees
// it — the renderer never supplies labels or item structure.
export const EXPLORER_MENU_COMMANDS = [
  "new-file",
  "new-folder",
  "rename",
  "delete",
  "pin",
  "unpin",
  "import-export",
  "export-zip",
  "open-externally",
  "import-files",
] as const;

export type ExplorerMenuCommandId = (typeof EXPLORER_MENU_COMMANDS)[number];

// THE preload boundary check for the explorer-menu invoke result: only an
// exact primitive string from the closed tuple passes (String objects,
// toString tricks, case variants, unknown ids drop to null = "dismissed").
export function isExplorerMenuCommand(
  value: unknown,
): value is ExplorerMenuCommandId {
  return (
    typeof value === "string" &&
    (EXPLORER_MENU_COMMANDS as readonly string[]).includes(value)
  );
}

// Closed native workbench context-menu command set (Phase E7). Explorer kept
// its richer file-tree menu; this generic menu covers tabs, editor surfaces,
// and the status bar. Labels/roles live in main. Renderer receives only the
// selected command id, validated here before it can route to existing shell
// actions.
export const WORKBENCH_MENU_COMMANDS = [
  "close-tab",
  "close-other-tabs",
  "copy-path",
  "show-in-explorer",
  "import-export",
  "open-agent",
  "open-history",
  "connect-cloud",
  "settings",
  "toggle-theme",
] as const;

export type WorkbenchMenuCommandId = (typeof WORKBENCH_MENU_COMMANDS)[number];

export function isWorkbenchMenuCommand(
  value: unknown,
): value is WorkbenchMenuCommandId {
  return (
    typeof value === "string" &&
    (WORKBENCH_MENU_COMMANDS as readonly string[]).includes(value)
  );
}

// Closed main→renderer update-state event shape (Phase E2 status bar). Like
// MENU_COMMANDS this lives here, not bridgeContract, because the SANDBOXED
// preload validates against it as a plain value and must stay dependency-free.
// The tuple mirrors updateMachine's UpdateState["status"] — channels.test.ts
// holds the compile-time both-ways check so the two can never drift.
export const UPDATE_STATUSES = [
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "offline",
  "error",
] as const;

export type UpdateStatusId = (typeof UPDATE_STATUSES)[number];

// THE preload boundary check for update events: only a plain object whose
// status is an exact primitive member of the closed tuple and whose message
// is a bounded primitive string passes — and ONLY those two fields cross the
// boundary (extra fields are dropped, String objects/toString tricks fail the
// typeof checks). Unit-tested like isMenuCommand.
export function parseUpdateStateEvent(
  value: unknown,
): { status: UpdateStatusId; message: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // OWN properties only: an object inheriting status/message from a crafted
  // prototype must not pass a check that promises "plain object".
  if (!Object.hasOwn(value, "status") || !Object.hasOwn(value, "message")) {
    return null;
  }
  const { status, message } = value as { status?: unknown; message?: unknown };
  if (
    typeof status !== "string" ||
    !(UPDATE_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  if (typeof message !== "string" || message.length === 0 || message.length > 500) {
    return null;
  }
  return { status: status as UpdateStatusId, message };
}

// Closed main→renderer search-results event shape (Phase E5.0). Like
// parseUpdateStateEvent this lives here, not bridgeContract, because the
// SANDBOXED preload validates every batch against it as a plain value and
// must stay dependency-free. The bounds mirror workspaceSearch.ts (the main-
// side producer) and bridgeContract's zod schema derives from the same
// limits — channels.test.ts pins them so the three can never drift.
export const SEARCH_EVENT_MAX_ENTRIES = 50;
export const SEARCH_EVENT_MAX_PREVIEW_CHARS = 250;
export const SEARCH_EVENT_MAX_ID_CHARS = 64;
const SEARCH_EVENT_MAX_PATH_CHARS = 4096;

export interface SearchResultsEventEntry {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResultsEvent {
  searchId: string;
  entries: SearchResultsEventEntry[];
  done: boolean;
  limitHit: boolean;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// Dependency-free lexical path check for the preload boundary: relative,
// forward-slashed, no null bytes, no backslashes, no empty/dot/dot-dot
// segments. Main ALREADY ran validateUserWritePath before sending (it owns
// containment); this re-check is the sandboxed preload's own closed gate —
// it cannot require workspace-core, so it enforces the same lexical rules
// inline. A path that fails drops the WHOLE batch (a tampered event is not
// salvageable row by row).
export function isSafeRelativePath(value: unknown): value is string {
  if (!isBoundedString(value, SEARCH_EVENT_MAX_PATH_CHARS)) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

// THE preload boundary check for search-result events: only a plain object
// whose searchId is a bounded primitive string and whose entries ALL pass the
// closed entry shape (safe relative path, 1-based integer line/column,
// bounded preview, ordered in-bounds match offsets) gets through — and only
// the validated fields are REBUILT into a fresh object (extra fields never
// cross; String objects/toString tricks fail the typeof checks). Unit-tested
// like parseUpdateStateEvent.
export function parseSearchResultsEvent(value: unknown): SearchResultsEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (
    !Object.hasOwn(value, "searchId") ||
    !Object.hasOwn(value, "entries") ||
    !Object.hasOwn(value, "done") ||
    !Object.hasOwn(value, "limitHit")
  ) {
    return null;
  }
  const { searchId, entries, done, limitHit } = value as {
    searchId?: unknown;
    entries?: unknown;
    done?: unknown;
    limitHit?: unknown;
  };
  if (!isBoundedString(searchId, SEARCH_EVENT_MAX_ID_CHARS)) return null;
  if (typeof done !== "boolean" || typeof limitHit !== "boolean") return null;
  if (!Array.isArray(entries) || entries.length > SEARCH_EVENT_MAX_ENTRIES) return null;
  const safeEntries: SearchResultsEventEntry[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    const { path, line, column, preview, matchStart, matchEnd } = entry;
    if (!isSafeRelativePath(path)) return null;
    if (!isPositiveInt(line) || !isPositiveInt(column)) return null;
    if (
      typeof preview !== "string" ||
      preview.length > SEARCH_EVENT_MAX_PREVIEW_CHARS
    ) {
      return null;
    }
    if (
      typeof matchStart !== "number" ||
      typeof matchEnd !== "number" ||
      !Number.isInteger(matchStart) ||
      !Number.isInteger(matchEnd) ||
      matchStart < 0 ||
      matchEnd < matchStart ||
      matchEnd > preview.length
    ) {
      return null;
    }
    safeEntries.push({ path, line, column, preview, matchStart, matchEnd });
  }
  return { searchId, entries: safeEntries, done, limitHit };
}

export interface WorkspaceActivatedEvent {
  workspaceId: string;
  rootPath: string;
  kind: "personal" | "shared" | "cloud-only";
  mode: "local-first" | "cloud-first-local-copy" | "cloud-only";
}

const WORKSPACE_KINDS = ["personal", "shared", "cloud-only"] as const;
const WORKSPACE_MODES = ["local-first", "cloud-first-local-copy", "cloud-only"] as const;

function isWorkspaceKind(value: unknown): value is WorkspaceActivatedEvent["kind"] {
  return (
    typeof value === "string" &&
    (WORKSPACE_KINDS as readonly string[]).includes(value)
  );
}

function isWorkspaceMode(value: unknown): value is WorkspaceActivatedEvent["mode"] {
  return (
    typeof value === "string" &&
    (WORKSPACE_MODES as readonly string[]).includes(value)
  );
}

// Native app-menu / OS-open events carry a workspace summary from main to the
// sandboxed renderer. Keep this dependency-free like menu/update/search
// parsing: exact primitive fields only, extra fields stripped.
export function parseWorkspaceActivatedEvent(
  value: unknown,
): WorkspaceActivatedEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (
    !Object.hasOwn(value, "workspaceId") ||
    !Object.hasOwn(value, "rootPath") ||
    !Object.hasOwn(value, "kind") ||
    !Object.hasOwn(value, "mode")
  ) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const { workspaceId, rootPath, kind, mode } = raw;
  if (
    !isBoundedString(workspaceId, 200) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(workspaceId)
  ) {
    return null;
  }
  if (!isBoundedString(rootPath, 4096)) return null;
  if (!isWorkspaceKind(kind)) return null;
  if (!isWorkspaceMode(mode)) return null;
  return { workspaceId, rootPath, kind, mode };
}

export const CHANNELS = {
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
  createLocalWorkspace: "desktop:create-local-workspace",
  attachWorkspaceFolder: "desktop:attach-workspace-folder",
  listWorkspaceFiles: "desktop:list-workspace-files",
  createWorkspaceFile: "desktop:create-workspace-file",
  createWorkspaceFolder: "desktop:create-workspace-folder",
  moveWorkspacePath: "desktop:move-workspace-path",
  deleteWorkspacePath: "desktop:delete-workspace-path",
  exportWorkspaceZip: "desktop:export-workspace-zip",
  showExplorerMenu: "desktop:show-explorer-menu",
  showWorkbenchMenu: "desktop:show-workbench-menu",
  importWorkspaceFiles: "desktop:import-workspace-files",
  createDataFragment: "desktop:create-data-fragment",
  listDataFragments: "desktop:list-data-fragments",
  readDataFragment: "desktop:read-data-fragment",
  revokeDataFragment: "desktop:revoke-data-fragment",
  readWorkspaceText: "desktop:read-workspace-text",
  writeWorkspaceText: "desktop:write-workspace-text",
  openFileExternally: "desktop:open-file-externally",
  readWorkspaceGraph: "desktop:read-workspace-graph",
  readWorkspaceDatabase: "desktop:read-workspace-database",
  applyDatabaseEdit: "desktop:apply-database-edit",
  importToDatabase: "desktop:import-to-database",
  getAppPackage: "desktop:get-app-package",
  runAppTester: "desktop:run-app-tester",
  grantAppTrust: "desktop:grant-app-trust",
  getAppRuntime: "desktop:get-app-runtime",
  runAppRuntimeRpc: "desktop:run-app-runtime-rpc",
  openExternalUrl: "desktop:open-external-url",
  cloudLoginStart: "desktop:cloud-login-start",
  cloudLoginPoll: "desktop:cloud-login-poll",
  cloudStatus: "desktop:cloud-status",
  cloudLogout: "desktop:cloud-logout",
  cloudEnableSync: "desktop:cloud-enable-sync",
  listWorkspaceShares: "desktop:list-workspace-shares",
  createWorkspaceShare: "desktop:create-workspace-share",
  revokeWorkspaceShare: "desktop:revoke-workspace-share",
  listWorkspaceMembers: "desktop:list-workspace-members",
  listWorkspaceInvites: "desktop:list-workspace-invites",
  createWorkspaceInvite: "desktop:create-workspace-invite",
  revokeWorkspaceInvite: "desktop:revoke-workspace-invite",
  collabToken: "desktop:collab-token",
  openWorkspace: "desktop:open-workspace",
  listChangeSets: "desktop:list-change-sets",
  readChangeSet: "desktop:read-change-set",
  restoreHistoryFile: "desktop:restore-history-file",
  undoHistoryFileRestore: "desktop:undo-history-file-restore",
  getSyncStatus: "desktop:get-sync-status",
  startAgentRun: "desktop:start-agent-run",
  endAgentRun: "desktop:end-agent-run",
  getAgentRunStatus: "desktop:get-agent-run-status",
  getMcpConfig: "desktop:get-mcp-config",
  probeAgentDrivers: "desktop:probe-agent-drivers",
  getAgentSessionState: "desktop:get-agent-session-state",
  startAgentSession: "desktop:start-agent-session",
  stopAgentSession: "desktop:stop-agent-session",
  answerAgentPermission: "desktop:answer-agent-permission",
  setTitlebarTheme: "desktop:set-titlebar-theme",
  getWorkspaceUiState: "desktop:get-workspace-ui-state",
  setWorkspaceUiState: "desktop:set-workspace-ui-state",
  searchWorkspace: "desktop:search-workspace",
  cancelWorkspaceSearch: "desktop:cancel-workspace-search",
  searchResults: "desktop:search-results",
  menuCommand: "desktop:menu-command",
  workspaceActivated: "desktop:workspace-activated",
  updateState: "desktop:update-state",
  workspaceActivity: "desktop:workspace-activity",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
  getDesktopMarks: "desktop:test:get-desktop-marks",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
