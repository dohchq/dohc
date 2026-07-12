// The closed application-menu command set. Lives here (not bridgeContract)
// because the SANDBOXED preload validates against it as a value, and this
// module must stay dependency-free — bridgeContract pulls zod/workspace-core,
// which a sandboxed preload cannot require at runtime.
export const MENU_COMMANDS = [
  "new-file",
  "new-folder",
  "open-workspace",
  "import-files",
  "export-workspace",
  "command-palette",
  "quick-open",
  "toggle-sidebar",
  "toggle-theme",
  "settings",
  "check-updates",
  "install-update",
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
  "export-zip",
  "open-externally",
  "import-files",
  "share",
  "refresh-share-mount",
  "unmount-share",
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
  "open-history",
  "connect-cloud",
  "check-updates",
  "install-update",
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

export const UPDATE_CHANNELS = ["latest", "nightly"] as const;
export type UpdateChannelId = (typeof UPDATE_CHANNELS)[number];

function isUpdateChannel(value: unknown): value is UpdateChannelId {
  return (
    typeof value === "string" &&
    (UPDATE_CHANNELS as readonly string[]).includes(value)
  );
}

function optionalBoundedString(
  value: unknown,
  max: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function optionalPercent(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

// THE preload boundary check for update events: only a plain object whose
// status is an exact primitive member of the closed tuple, whose message is a
// bounded primitive string, and whose optional public update metadata is
// primitive and bounded can cross. Unknown fields are dropped, and String
// objects/toString tricks fail the typeof checks. Unit-tested like
// isMenuCommand.
export function parseUpdateStateEvent(
  value: unknown,
): {
  status: UpdateStatusId;
  message: string;
  currentVersion?: string;
  channel?: UpdateChannelId;
  canCheck?: boolean;
  canInstall?: boolean;
  version?: string;
  percent?: number;
} | null {
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
  const raw = value as Record<string, unknown>;
  const currentVersion = optionalBoundedString(raw.currentVersion, 200);
  const version = optionalBoundedString(raw.version, 200);
  const canCheck = optionalBoolean(raw.canCheck);
  const canInstall = optionalBoolean(raw.canInstall);
  const percent = optionalPercent(raw.percent);
  if (
    currentVersion === null ||
    version === null ||
    canCheck === null ||
    canInstall === null ||
    percent === null
  ) {
    return null;
  }
  if (raw.channel !== undefined && !isUpdateChannel(raw.channel)) return null;
  return {
    status: status as UpdateStatusId,
    message,
    ...(currentVersion ? { currentVersion } : {}),
    ...(raw.channel ? { channel: raw.channel as UpdateChannelId } : {}),
    ...(canCheck !== undefined ? { canCheck } : {}),
    ...(canInstall !== undefined ? { canInstall } : {}),
    ...(version ? { version } : {}),
    ...(percent !== undefined ? { percent } : {}),
  };
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
  surface?: "file" | "chat";
  threadId?: string;
  objectId?: string;
  title?: string;
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
    const surface = entry.surface;
    if (surface !== undefined && surface !== "file" && surface !== "chat") return null;
    const threadId = optionalBoundedString(entry.threadId, 200);
    const objectId = optionalBoundedString(entry.objectId, 200);
    const title = optionalBoundedString(entry.title, 500);
    if (threadId === null || objectId === null || title === null) return null;
    safeEntries.push({
      path,
      line,
      column,
      preview,
      matchStart,
      matchEnd,
      ...(surface !== undefined ? { surface } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(objectId !== undefined ? { objectId } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  }
  return { searchId, entries: safeEntries, done, limitHit };
}

// WS-G2-C-2 engine Y.Doc binding: main owns the node-only live Y.Doc session;
// the renderer's editor binds to a mirror doc kept convergent over IPC. A
// remote CRDT delta (a co-editor's edit routed through the engine) is forwarded
// main→renderer over the engine-ydoc-remote-update event channel as a raw Yjs
// update (structured-clone Uint8Array). Like every event that crosses into the
// sandboxed preload, its shape is re-validated there with this dependency-free
// closed check. sessionId is the renderer-minted per-open correlation id (like
// searchId): the renderer applies a forwarded delta only when it matches the
// session currently bound, so a slow/stale session can never repaint another.
export const ENGINE_YDOC_SESSION_ID_MAX_CHARS = 64;
// A single Yjs update crossing IPC is bounded well above a normal keystroke
// delta yet below anything abusive; the driver's recordUpdate independently
// rejects an oversized update, so this is a preload sanity bound, not the
// authority.
export const ENGINE_YDOC_UPDATE_MAX_BYTES = 16 * 1024 * 1024;

export interface EngineYDocRemoteUpdateEvent {
  sessionId: string;
  update: Uint8Array;
}

export function parseEngineYDocRemoteUpdateEvent(
  value: unknown,
): EngineYDocRemoteUpdateEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!Object.hasOwn(value, "sessionId") || !Object.hasOwn(value, "update")) return null;
  const { sessionId, update } = value as { sessionId?: unknown; update?: unknown };
  if (!isBoundedString(sessionId, ENGINE_YDOC_SESSION_ID_MAX_CHARS)) return null;
  // Structured clone preserves a Uint8Array as a real Uint8Array; anything else
  // (a plain object, an ArrayBuffer, a tampered value) is rejected.
  if (!(update instanceof Uint8Array)) return null;
  if (update.byteLength === 0 || update.byteLength > ENGINE_YDOC_UPDATE_MAX_BYTES) return null;
  return { sessionId, update };
}

export interface WorkspaceActivatedEvent {
  workspaceId: string;
  rootPath: string;
  kind: "personal" | "shared" | "cloud-only";
  mode: "local-first" | "cloud-first-local-copy" | "cloud-only";
}

export const WORKSPACE_KINDS = ["personal", "shared", "cloud-only"] as const;
export const WORKSPACE_MODES = ["local-first", "cloud-first-local-copy", "cloud-only"] as const;

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
  exportDocumentFile: "desktop:export-document-file",
  showExplorerMenu: "desktop:show-explorer-menu",
  showWorkbenchMenu: "desktop:show-workbench-menu",
  importWorkspaceFiles: "desktop:import-workspace-files",
  readWorkspaceText: "desktop:read-workspace-text",
  writeWorkspaceText: "desktop:write-workspace-text",
  writeWorkspaceAsset: "desktop:write-workspace-asset",
  pickImageFiles: "desktop:pick-image-files",
  openFileExternally: "desktop:open-file-externally",
  readWorkspaceGraph: "desktop:read-workspace-graph",
  getBacklinks: "desktop:get-backlinks",
  readWorkspaceDatabase: "desktop:read-workspace-database",
  applyDatabaseEdit: "desktop:apply-database-edit",
  importToDatabase: "desktop:import-to-database",
  listSites: "desktop:list-sites",
  getSitePackage: "desktop:get-site-package",
  startSitePreview: "desktop:start-site-preview",
  stopSitePreview: "desktop:stop-site-preview",
  openExternalUrl: "desktop:open-external-url",
  cloudLoginStart: "desktop:cloud-login-start",
  cloudLoginPoll: "desktop:cloud-login-poll",
  cloudStatus: "desktop:cloud-status",
  cloudLogout: "desktop:cloud-logout",
  cloudEnableSync: "desktop:cloud-enable-sync",
  cloudJoinWorkspace: "desktop:cloud-join-workspace",
  dismissSyncReviewNotice: "desktop:dismiss-sync-review-notice",
  createRelayShare: "desktop:create-relay-share",
  listRelayShares: "desktop:list-relay-shares",
  revokeRelayShare: "desktop:revoke-relay-share",
  shareChatChannel: "desktop:share-chat-channel",
  listChatChannelShares: "desktop:list-chat-channel-shares",
  joinSharedChannel: "desktop:join-shared-channel",
  leaveSharedChannel: "desktop:leave-shared-channel",
  openSharedView: "desktop:open-shared-view",
  refreshSharedView: "desktop:refresh-shared-view",
  mountShare: "desktop:mount-share",
  refreshShareMounts: "desktop:refresh-share-mounts",
  unmountShare: "desktop:unmount-share",
  openWorkspace: "desktop:open-workspace",
  listWorkspaceVersions: "desktop:list-workspace-versions",
  createWorkspaceVersion: "desktop:create-workspace-version",
  switchWorkspaceVersion: "desktop:switch-workspace-version",
  compareWorkspaceVersions: "desktop:compare-workspace-versions",
  mergeWorkspaceVersion: "desktop:merge-workspace-version",
  listWorkspaceVersionConflicts: "desktop:list-workspace-version-conflicts",
  resolveWorkspaceVersionConflict: "desktop:resolve-workspace-version-conflict",
  listEngineMoments: "desktop:list-engine-moments",
  readEngineMoment: "desktop:read-engine-moment",
  restoreEngineMomentFile: "desktop:restore-engine-moment-file",
  listFileChats: "desktop:list-file-chats",
  createFileChat: "desktop:create-file-chat",
  listChatMessages: "desktop:list-chat-messages",
  sendChatMessage: "desktop:send-chat-message",
  listChatThreadDecisions: "desktop:list-chat-thread-decisions",
  resolveChatDecision: "desktop:resolve-chat-decision",
  listChatThreadAttachments: "desktop:list-chat-thread-attachments",
  chatRunRecordsForThread: "desktop:chat-run-records-for-thread",
  listChatChannels: "desktop:list-chat-channels",
  createChatChannel: "desktop:create-chat-channel",
  listChannelThreads: "desktop:list-channel-threads",
  startChannelThread: "desktop:start-channel-thread",
  markChatThreadRead: "desktop:mark-chat-thread-read",
  listChatReactions: "desktop:list-chat-reactions",
  setChatReaction: "desktop:set-chat-reaction",
  syncDms: "desktop:sync-dms",
  startDm: "desktop:start-dm",
  // Ephemeral presence (MU-C5): IPC-proxied so the relay bearer token never
  // reaches the renderer — main holds the token and makes the relay presence
  // request. publish (or leave), long-poll, and cancel an in-flight poll.
  presencePublish: "desktop:presence-publish",
  presencePoll: "desktop:presence-poll",
  presenceCancel: "desktop:presence-cancel",
  getSyncStatus: "desktop:get-sync-status",
  startAgentRun: "desktop:start-agent-run",
  endAgentRun: "desktop:end-agent-run",
  getAgentRunStatus: "desktop:get-agent-run-status",
  tryInWorkspaceVersion: "desktop:try-in-workspace-version",
  getTryInVersionState: "desktop:get-try-in-version-state",
  dismissTryInVersionReview: "desktop:dismiss-try-in-version-review",
  getMcpConfig: "desktop:get-mcp-config",
  probeAgentDrivers: "desktop:probe-agent-drivers",
  getAgentSessionState: "desktop:get-agent-session-state",
  answerAgentPermission: "desktop:answer-agent-permission",
  stopAgentRun: "desktop:stop-chat-agent-run",
  resumeThreadDispatch: "desktop:resume-thread-dispatch",
  chatDispatchStateForThread: "desktop:chat-dispatch-state-for-thread",
  runnerSelfTest: "desktop:runner-self-test",
  getUserSettings: "desktop:get-user-settings",
  setUserSettings: "desktop:set-user-settings",
  resetUserSettings: "desktop:reset-user-settings",
  getWorkspaceSettings: "desktop:get-workspace-settings",
  setWorkspaceSettings: "desktop:set-workspace-settings",
  resetWorkspaceSettings: "desktop:reset-workspace-settings",
  writeClipboardText: "desktop:write-clipboard-text",
  setTitlebarTheme: "desktop:set-titlebar-theme",
  getWorkspaceUiState: "desktop:get-workspace-ui-state",
  setWorkspaceUiState: "desktop:set-workspace-ui-state",
  searchWorkspace: "desktop:search-workspace",
  cancelWorkspaceSearch: "desktop:cancel-workspace-search",
  searchResults: "desktop:search-results",
  engineYDocOpen: "desktop:engine-ydoc-open",
  engineYDocApplyUpdate: "desktop:engine-ydoc-apply-update",
  engineYDocClose: "desktop:engine-ydoc-close",
  engineYDocRemoteUpdate: "desktop:engine-ydoc-remote-update",
  menuCommand: "desktop:menu-command",
  workspaceActivated: "desktop:workspace-activated",
  updateState: "desktop:update-state",
  getUpdateState: "desktop:get-update-state",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  workspaceActivity: "desktop:workspace-activity",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
  getDesktopMarks: "desktop:test:get-desktop-marks",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
