import type { CommandId } from "../renderer/commands/commandRows";
import type { ShortcutId } from "../shortcuts/shortcutRegistry";

// Closed tuples and channel names shared by main, the bridge contract, and the
// preload. This module has no runtime imports so main-side modules can read a tuple
// without loading the whole contract.

// Edit > Find on macOS. The shell hands each to the editor that has focus,
// which runs what the shortcut of the same id runs.
export const EDITOR_MENU_COMMANDS = [
  "editor-find",
  "editor-replace",
  "find-again-next",
  "find-again-previous",
] as const satisfies readonly ShortcutId[];
export type EditorMenuCommand = (typeof EDITOR_MENU_COMMANDS)[number];

export const MENU_COMMANDS = [
  "new-file",
  "new-folder",
  "new-collection",
  "open-workspace",
  "import-files",
  "export-workspace",
  "command-palette",
  "quick-open",
  "toggle-sidebar",
  "show-chats",
  "toggle-about",
  "toggle-theme",
  "settings",
  "check-updates",
  "install-update",
  "new-editor-group-right",
  "close-tab",
  "next-tab",
  "previous-tab",
  ...EDITOR_MENU_COMMANDS,
] as const satisfies readonly (CommandId | "command-palette" | EditorMenuCommand)[];

export function isEditorMenuCommand(command: unknown): command is EditorMenuCommand {
  return (EDITOR_MENU_COMMANDS as readonly unknown[]).includes(command);
}

// Explorer context menu: the renderer names what was right-clicked, main pops
// a native menu built from main-owned labels over this closed set, and the
// chosen id comes back over the same invoke.
export const EXPLORER_MENU_COMMANDS = [
  "new-file",
  "new-folder",
  "new-collection",
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

// Generic workbench context menu for tabs, editor surfaces, and the status bar.
export const WORKBENCH_MENU_COMMANDS = [
  "move-tab-to-new-group",
  "close-editor-group",
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
  "unpin-app",
] as const;

// How much one OS drag-in imports: up to 100 dropped items, up to 1,000
// files and folders in all once dropped folders are opened, and up to 10,000
// entries those folders hold that dohc leaves out, such as .DS_Store. The
// bridge contract and the shell hold the first; the drag-in screen holds all.
export const DROP_IMPORT_LIMITS = { items: 100, entries: 1000, skipped: 10_000 } as const;
export const DROP_IMPORT_REFUSALS = {
  items: `dohc imports up to ${DROP_IMPORT_LIMITS.items} dropped items at once. Drop fewer at a time.`,
  entries: `dohc imports up to ${DROP_IMPORT_LIMITS.entries.toLocaleString("en-US")} files and folders from one drop. Drop fewer folders at a time.`,
  skipped: `dohc reads up to ${DROP_IMPORT_LIMITS.skipped.toLocaleString("en-US")} files it leaves out, such as .DS_Store, in one drop. Drop fewer folders at a time.`,
} as const;

// Why an import left a source out. The shell words each reason. A result
// lists the first IMPORT_SKIPS_LISTED, and counts the rest.
export const IMPORT_SKIP_REASONS = [
  "link",
  // A socket, device or pipe.
  "not-a-file",
  // Gone, or dohc may not read it.
  "unreadable",
  // Inside a workspace's .dohc folder.
  "workspace-data",
  // Dropped on its own: a file the OS makes, such as .DS_Store.
  "system-file",
  // Dropped on its own: a name every workspace leaves out, such as node_modules.
  "left-out",
  // A name dohc keeps for itself, such as .dohc.
  "dohc-name",
  // A name Windows can't use, such as CON.
  "windows-name",
  // A name dohc would have to change to save, such as a\b.
  "name",
  // Too long to save in that folder, even shortened.
  "too-long",
  // The name and its 99 numbered copies are all taken.
  "taken",
  // A shared view holds only files, so a folder with none lands nothing.
  "no-files",
  // Over a shared view's limit for a file, or for text.
  "too-large",
  "too-large-text",
] as const;
export const IMPORT_SKIPS_LISTED = 100;
// The longest path Windows can name, so a skip from deep in a dropped
// folder still fits.
export const IMPORT_SKIPPED_PATH_MAX_CHARS = 32_767;
// Past this many "name (N).ext" copies, a name collision skips the source
// instead of probing forever.
export const IMPORT_COLLISION_RENAMES = 99;

// Workspace content search streams batches main→renderer. The bounds mirror
// workspaceSearch.ts (the producer); bridgeContract's SearchResultsEvent
// schema enforces them at both ends of the channel.
export const SEARCH_EVENT_MAX_ENTRIES = 50;
export const SEARCH_EVENT_MAX_PREVIEW_CHARS = 250;
export const SEARCH_EVENT_MAX_ID_CHARS = 64;
// A search that is fail-closed by a broken policy file (or otherwise paused)
// carries a short human-readable notice so the panel can explain the empty
// result instead of silently showing nothing.
export const SEARCH_EVENT_MAX_NOTICE_CHARS = 500;

// Engine Y.Doc binding: main owns the node-only live Y.Doc session; the
// renderer's editor binds to a mirror doc kept convergent over IPC. sessionId
// is the renderer-minted per-open correlation id (like searchId): the renderer
// applies a forwarded delta only when it matches the session currently bound,
// so a slow/stale session can never repaint another.
export const ENGINE_YDOC_SESSION_ID_MAX_CHARS = 64;
// Raw bytes cross renderer IPC by structured clone. Admit the durable engine's
// measured raw-update range so an engine-owned session can always hand its
// accepted state to the renderer. The daemon carries full states as raw blob
// chunks under the same bound.
export const ENGINE_YDOC_UPDATE_MAX_BYTES = 20 * 1024 * 1024;

// The editor's save indicator, pushed from main on every real settle outcome.
// It replaced a renderer-side timer that flipped to "saved" on a timeout no
// matter what the engine did — a doc could read "Saved" over a zero-byte file.
// "read-only" is a separate refusal from "error": the workspace became a
// read-only shared view, so this edit and every edit after it is discarded.
// Advice that suits a transient failure ("try another edit") is futile there,
// so the two must not share a string. "changed-on-disk" is the same kind of
// separate refusal: the file was edited outside dohc while the document was
// open, dohc kept that edit, and the document's own text is in History.
// "file-locked" is the transient half of that split: another program holds
// the file's handle, the settle committed, and the engine retries until the
// handle releases — the user has nothing to do, so "error"'s advice would be
// noise and "saved" would be a lie about the disk. "deleted" is terminal for
// this live session: the path is gone and the renderer preserves its draft.
export const ENGINE_YDOC_SAVE_STATES = [
  "saved-to-host",
  "pending-share",
  "settling",
  "saved",
  "error",
  "file-locked",
  "read-only",
  "changed-on-disk",
  "deleted",
  // A reopen found another object at this document's path.
  "object-changed",
] as const;
export type EngineYDocSaveStateName = (typeof ENGINE_YDOC_SAVE_STATES)[number];

// Channels not yet in an operation table (operationTable.ts). A table row owns
// its own channel name, so a migrated operation has no entry here.
export const CHANNELS = {
  reloadRenderer: "desktop:reload-renderer",
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
  getDefaultShareRoot: "desktop:get-default-share-root",
  createLocalWorkspace: "desktop:create-local-workspace",
  attachWorkspaceFolder: "desktop:attach-workspace-folder",
  forgetWorkspace: "desktop:forget-workspace",
  openWorkspaceWindow: "desktop:open-workspace-window",
  openWorkspaceManager: "desktop:open-workspace-manager",
  closeThisWindow: "desktop:close-this-window",
  revealWorkspaceFolder: "desktop:reveal-workspace-folder",
  createCollectionRecord: "desktop:create-collection-record",
  showExplorerMenu: "desktop:show-explorer-menu",
  showWorkbenchMenu: "desktop:show-workbench-menu",
  listWorkspaceHeadings: "desktop:list-workspace-headings",
  listCollections: "desktop:list-collections",
  getCollection: "desktop:get-collection",
  queryCollectionRecords: "desktop:query-collection-records",
  historyNamesChanged: "desktop:history-names-changed",
  getCollectionRecordHistory: "desktop:get-collection-record-history",
  locateRecordHistoryRun: "desktop:locate-record-history-run",
  readWorkspaceDatabase: "desktop:read-workspace-database",
  readWorkspaceDatabasePage: "desktop:read-workspace-database-page",
  applyDatabaseEdit: "desktop:apply-database-edit",
  listSites: "desktop:list-sites",
  getSitePackage: "desktop:get-site-package",
  startSitePreview: "desktop:start-site-preview",
  getSitePreviewLogs: "desktop:get-site-preview-logs",
  stopSitePreview: "desktop:stop-site-preview",
  sitePreviewReplaced: "desktop:site-preview-replaced",
  openExternalUrl: "desktop:open-external-url",
  cloudLoginStart: "desktop:cloud-login-start",
  cloudLoginPoll: "desktop:cloud-login-poll",
  cloudStatus: "desktop:cloud-status",
  cloudLogout: "desktop:cloud-logout",
  shareHandoffStatus: "desktop:share-handoff-status",
  cloudEnableSync: "desktop:cloud-enable-sync",
  cloudJoinWorkspace: "desktop:cloud-join-workspace",
  publishOwnerApp: "desktop:publish-owner-app",
  appViewEvent: "desktop:app-view-event",
  ownerAppResponses: "desktop:owner-app-responses",
  // An automation claim failed or a retry queued one: run history reads again.
  automationRunsChanged: "desktop:automation-runs-changed",
  // The crash report changed; the renderer reads it again.
  crashReportChanged: "desktop:crash-report-changed",
  // The offline copies an account change left changed; the renderer reads them again.
  collectionCopiesLeftChanged: "desktop:collection-copies-left-changed",
  workspaceTrustChanged: "desktop:workspace-trust-changed",
  // A timed save stopped counting, because the usage record changed outside dohc.
  usageRecordStopped: "desktop:usage-record-stopped",
  noticesChanged: "desktop:notices-changed",
  // Main wrote or removed a draft it set aside for a workspace; the renderer
  // lists them again.
  liveDraftRecoveryChanged: "desktop:live-draft-recovery-changed",
  // Which of the owner's computers runs a workspace's schedules changed.
  scheduleHostChanged: "desktop:schedule-host-changed",
  chatDispatchNotices: "desktop:chat-dispatch-notices",
  agentRunState: "desktop:agent-run-state",
  chatDispatchPaused: "desktop:chat-dispatch-paused",
  chatAgentRequestsChanged: "desktop:chat-agent-requests-changed",
  // Collection automations: main parses and writes automations.yaml.
  listCollectionAutomations: "desktop:list-collection-automations",
  switchCollectionAutomation: "desktop:switch-collection-automation",
  resolveAutomationControls: "desktop:resolve-automation-controls",
  listCollectionAutomationRuns: "desktop:list-collection-automation-runs",
  getCollectionAutomationRun: "desktop:get-collection-automation-run",
  listServerAutomationRuns: "desktop:list-server-automation-runs",
  retryCollectionAutomation: "desktop:retry-collection-automation",
  undoCollectionAutomationRun: "desktop:undo-collection-automation-run",
  listAutomationTargets: "desktop:list-automation-targets",
  listAutomationGroups: "desktop:list-automation-groups",
  listAutomationPeople: "desktop:list-automation-people",
  checkCollectionAutomation: "desktop:check-collection-automation",
  stopAndRestore: "desktop:stop-and-restore",
  undoStopAndRestore: "desktop:undo-stop-and-restore",
  confirmCollectionAutomationStep: "desktop:confirm-collection-automation-step",
  writeCollectionAutomations: "desktop:write-collection-automations",
  listAutomationHolds: "desktop:list-automation-holds",
  listServerAutomationHolds: "desktop:list-server-automation-holds",
  resetAutomationHolds: "desktop:reset-automation-holds",
  revealAutomationHolds: "desktop:reveal-automation-holds",
  dismissAutomationStops: "desktop:dismiss-automation-stops",
  automationShareImpact: "desktop:automation-share-impact",
  automationHoldsChanged: "desktop:automation-holds-changed",
  listCollectionFieldMarks: "desktop:list-collection-field-marks",
  findDatasetCollection: "desktop:find-dataset-collection",
  findAutomationCollection: "desktop:find-automation-collection",
  collectionAutomationsChanged: "desktop:collection-automations-changed",
  // Button fields: main decides who may press and what runs, and tells the
  // pressing window how its run went.
  listAutomationButtons: "desktop:list-automation-buttons",
  listRecordButtons: "desktop:list-record-buttons",
  pressAutomationButton: "desktop:press-automation-button",
  automationRunSettled: "desktop:automation-run-settled",
  automationRunWaiting: "desktop:automation-run-waiting",
  // Reports direct writes pushed from an edit-level share view.
  shareDirectWritesPushed: "desktop:share-direct-writes-pushed",
  openWorkspace: "desktop:open-workspace",
  listEngineMoments: "desktop:list-engine-moments",
  readEngineMoment: "desktop:read-engine-moment",
  restoreEngineMomentFile: "desktop:restore-engine-moment-file",
  chatRunRecordsForThread: "desktop:chat-run-records-for-thread",
  syncDms: "desktop:sync-dms",
  acceptDm: "desktop:accept-dm",
  declineDm: "desktop:decline-dm",
  requestDmAgain: "desktop:request-dm-again",
  startDm: "desktop:start-dm",
  leaveDm: "desktop:leave-dm",
  // Ephemeral presence (MU-C5): IPC-proxied so the relay bearer token never
  // reaches the renderer — main holds the token and makes the relay presence
  // request. publish (or leave), long-poll, and cancel an in-flight poll.
  presencePublish: "desktop:presence-publish",
  presencePoll: "desktop:presence-poll",
  presenceCancel: "desktop:presence-cancel",
  getSyncStatus: "desktop:get-sync-status",
  retryOwnerLiveDelivery: "desktop:retry-owner-live-delivery",
  retryFileRecovery: "desktop:retry-file-recovery",
  retryCloudSync: "desktop:retry-cloud-sync",
  rebuildEngineStore: "desktop:rebuild-engine-store",
  startAgentRun: "desktop:start-agent-run",
  endAgentRun: "desktop:end-agent-run",
  getAgentRunStatus: "desktop:get-agent-run-status",
  getMcpConfig: "desktop:get-mcp-config",
  stopAgentRun: "desktop:stop-chat-agent-run",
  resumeThreadDispatch: "desktop:resume-thread-dispatch",
  chatDispatchStateForThread: "desktop:chat-dispatch-state-for-thread",
  runnerSelfTest: "desktop:runner-self-test",
  detectAgentTools: "desktop:detect-agent-tools",
  setTitlebarTheme: "desktop:set-titlebar-theme",
  windowFullScreen: "desktop:window-full-screen",
  stepWindowZoom: "desktop:step-window-zoom",
  agentColorChanged: "desktop:agent-color-changed",
  userSettingsChanged: "desktop:user-settings-changed",
  folderAppChanged: "desktop:folder-app-changed",
  searchResults: "desktop:search-results",
  engineYDocOpen: "desktop:engine-ydoc-open",
  engineYDocReadArtifactAsset: "desktop:engine-ydoc-read-artifact-asset",
  engineYDocApplyUpdate: "desktop:engine-ydoc-apply-update",
  engineYDocOwnerHandoff: "desktop:engine-ydoc-owner-handoff",
  engineYDocPrepareOwnerHandoff: "desktop:engine-ydoc-prepare-owner-handoff",
  engineYDocAcknowledgeLineageReplacement:
    "desktop:engine-ydoc-acknowledge-lineage-replacement",
  engineYDocClose: "desktop:engine-ydoc-close",
  engineYDocRemoteUpdate: "desktop:engine-ydoc-remote-update",
  engineYDocLineageReplacement: "desktop:engine-ydoc-lineage-replacement",
  engineYDocSaveState: "desktop:engine-ydoc-save-state",
  menuCommand: "desktop:menu-command",
  workspaceActivated: "desktop:workspace-activated",
  workspacePathOpenFailed: "desktop:workspace-path-open-failed",
  updateState: "desktop:update-state",
  getUpdateState: "desktop:get-update-state",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  // Exit rounds: before a quit or an update install, main asks every
  // workspace renderer whether set-aside drafts would be lost. The request
  // carries a round id; each renderer answers clear, hold, or cancel with it.
  exitRound: "desktop:exit-round",
  exitRoundAnswer: "desktop:exit-round-answer",
  // Version rounds: before the CLI or MCP changes a workspace's versions,
  // main asks each window showing it to save its open edits. Each answers
  // ready or refused with the round id, and hears the round's end.
  versionRound: "desktop:version-round",
  versionRoundAnswer: "desktop:version-round-answer",
  holdQuit: "desktop:hold-quit",
  resumeQuit: "desktop:resume-quit",
  workspaceActivity: "desktop:workspace-activity",
  captureHolds: "desktop:capture-holds",
  cloudSessionChanged: "desktop:cloud-session-changed",
  firstPaint: "desktop:first-paint",
  // Dev tools (DOHC_DEV_TOOLS=1, unpackaged only): the debug panel's
  // actions. Each handler is double-gated in main.
  devForgetWorkspaces: "desktop:dev:forget-workspaces",
  devRevealPath: "desktop:dev:reveal-path",
  getLaunchMarks: "desktop:test:get-launch-marks",
  getDesktopMarks: "desktop:test:get-desktop-marks",
} as const;
