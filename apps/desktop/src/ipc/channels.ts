// The closed application-menu command set. Lives here (not bridgeContract)
// because the SANDBOXED preload validates against it as a value, and this
// module must stay dependency-free — bridgeContract pulls zod/workspace-core,
// which a sandboxed preload cannot require at runtime.
export const MENU_COMMANDS = [
  "new-file",
  "new-folder",
  "open-workspace",
  "import-files",
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

export const CHANNELS = {
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
  createLocalWorkspace: "desktop:create-local-workspace",
  attachWorkspaceFolder: "desktop:attach-workspace-folder",
  listWorkspaceFiles: "desktop:list-workspace-files",
  createWorkspaceFile: "desktop:create-workspace-file",
  importWorkspaceFiles: "desktop:import-workspace-files",
  readWorkspaceText: "desktop:read-workspace-text",
  writeWorkspaceText: "desktop:write-workspace-text",
  openFileExternally: "desktop:open-file-externally",
  readWorkspaceDatabase: "desktop:read-workspace-database",
  applyDatabaseEdit: "desktop:apply-database-edit",
  importToDatabase: "desktop:import-to-database",
  getAppPackage: "desktop:get-app-package",
  runAppTester: "desktop:run-app-tester",
  grantAppTrust: "desktop:grant-app-trust",
  openExternalUrl: "desktop:open-external-url",
  cloudLoginStart: "desktop:cloud-login-start",
  cloudLoginPoll: "desktop:cloud-login-poll",
  cloudStatus: "desktop:cloud-status",
  cloudLogout: "desktop:cloud-logout",
  cloudEnableSync: "desktop:cloud-enable-sync",
  collabToken: "desktop:collab-token",
  openWorkspace: "desktop:open-workspace",
  listChangeSets: "desktop:list-change-sets",
  getSyncStatus: "desktop:get-sync-status",
  startAgentRun: "desktop:start-agent-run",
  endAgentRun: "desktop:end-agent-run",
  getAgentRunStatus: "desktop:get-agent-run-status",
  getMcpConfig: "desktop:get-mcp-config",
  setTitlebarTheme: "desktop:set-titlebar-theme",
  getWorkspaceUiState: "desktop:get-workspace-ui-state",
  setWorkspaceUiState: "desktop:set-workspace-ui-state",
  menuCommand: "desktop:menu-command",
  updateState: "desktop:update-state",
  workspaceActivity: "desktop:workspace-activity",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
  getDesktopMarks: "desktop:test:get-desktop-marks",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
