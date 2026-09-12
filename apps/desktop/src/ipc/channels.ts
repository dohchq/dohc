// Closed tuples and channel names shared by main, the bridge contract, and the
// preload. This module imports nothing so main-side modules can read a tuple
// without loading the whole contract.

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
  "toggle-chats",
  "toggle-theme",
  "settings",
  "check-updates",
  "install-update",
  "new-editor-group-right",
  "close-tab",
] as const;

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
] as const;

export const PLUGIN_PIPELINE_STATUSES = [
  "discovered",
  "queued",
  "snapshotting",
  "installing",
  "scanning",
  "building",
  "starting",
  "ready",
  "failed",
  "crashed",
  "disabled",
  "disabled-pending-approval",
  "disabled-pending-repair",
  "invalid",
  "uninstalling",
] as const;

export const PLUGIN_PIPELINE_ERROR_STAGES = [
  "discovery",
  "snapshot",
  "install",
  "scan",
  "build",
  "state",
  "runtime",
  "uninstall",
] as const;

export const BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES = ["agent-chat"] as const;

// How many unrecoverable paths the uninstall preflight sends to the renderer.
// The dialog lists this sample and says how many more there are; a plugin
// tree can hold thousands, and the whole inventory stays in main.
export const PLUGIN_UNINSTALL_PATH_SAMPLE_LIMIT = 20;

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
] as const;
export type EngineYDocSaveStateName = (typeof ENGINE_YDOC_SAVE_STATES)[number];

export const CHANNELS = {
  reloadRenderer: "desktop:reload-renderer",
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
  getDefaultShareRoot: "desktop:get-default-share-root",
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
  listWorkspaceHeadings: "desktop:list-workspace-headings",
  listChatFileMentions: "desktop:list-chat-file-mentions",
  listChatBookmarks: "desktop:list-chat-bookmarks",
  saveChatBookmark: "desktop:save-chat-bookmark",
  archiveChatBookmark: "desktop:archive-chat-bookmark",
  listCollections: "desktop:list-collections",
  getCollection: "desktop:get-collection",
  queryCollectionRecords: "desktop:query-collection-records",
  readWorkspaceDatabase: "desktop:read-workspace-database",
  readWorkspaceDatabasePage: "desktop:read-workspace-database-page",
  applyDatabaseEdit: "desktop:apply-database-edit",
  importToDatabase: "desktop:import-to-database",
  listSites: "desktop:list-sites",
  getSitePackage: "desktop:get-site-package",
  startSitePreview: "desktop:start-site-preview",
  getSitePreviewLogs: "desktop:get-site-preview-logs",
  stopSitePreview: "desktop:stop-site-preview",
  openPluginPanel: "desktop:open-plugin-panel",
  startPluginPanel: "desktop:start-plugin-panel",
  invokePluginCommand: "desktop:invoke-plugin-command",
  stopPluginPanel: "desktop:stop-plugin-panel",
  pluginPanelInvalidated: "desktop:plugin-panel-invalidated",
  invokePluginPanelSdk: "desktop:invoke-plugin-panel-sdk",
  openPluginWebApp: "desktop:open-plugin-web-app",
  startPluginWebApp: "desktop:start-plugin-web-app",
  setPluginWebAppBounds: "desktop:set-plugin-web-app-bounds",
  stopPluginWebApp: "desktop:stop-plugin-web-app",
  pluginWebAppFailed: "desktop:plugin-web-app-failed",
  listPlugins: "desktop:list-plugins",
  listOfferedPlugins: "desktop:list-offered-plugins",
  addOfferedPlugin: "desktop:add-offered-plugin",
  installPlugin: "desktop:install-plugin",
  disablePlugin: "desktop:disable-plugin",
  enablePlugin: "desktop:enable-plugin",
  approvePlugin: "desktop:approve-plugin",
  rebuildPlugin: "desktop:rebuild-plugin",
  pluginUninstallPreflight: "desktop:plugin-uninstall-preflight",
  pluginSizes: "desktop:plugin-sizes",
  uninstallPlugin: "desktop:uninstall-plugin",
  getPluginSettings: "desktop:get-plugin-settings",
  setPluginSettings: "desktop:set-plugin-settings",
  pluginStatusChanged: "desktop:plugin-status-changed",
  pluginPanelSdkEvent: "desktop:plugin-panel-sdk-event",
  openExternalUrl: "desktop:open-external-url",
  cloudLoginStart: "desktop:cloud-login-start",
  cloudLoginPoll: "desktop:cloud-login-poll",
  cloudStatus: "desktop:cloud-status",
  cloudLogout: "desktop:cloud-logout",
  getShareHandoffStatus: "desktop:get-share-handoff-status",
  acceptShareHandoff: "desktop:accept-share-handoff",
  retryShareHandoff: "desktop:retry-share-handoff",
  dismissShareHandoff: "desktop:dismiss-share-handoff",
  shareHandoffStatus: "desktop:share-handoff-status",
  cloudEnableSync: "desktop:cloud-enable-sync",
  cloudJoinWorkspace: "desktop:cloud-join-workspace",
  createRelayShare: "desktop:create-relay-share",
  listRelayShares: "desktop:list-relay-shares",
  getRelayReceivedShare: "desktop:get-relay-received-share",
  revokeRelayShare: "desktop:revoke-relay-share",
  createRelayShareLink: "desktop:create-relay-share-link",
  addRelayShareLink: "desktop:add-relay-share-link",
  listRelayShareLinks: "desktop:list-relay-share-links",
  ownerRestore: "desktop:owner-restore",
  publishOwnerApp: "desktop:publish-owner-app",
  ownerAppResponses: "desktop:owner-app-responses",
  retuneRelayShareLink: "desktop:retune-relay-share-link",
  rotateRelayShareLink: "desktop:rotate-relay-share-link",
  revokeRelayShareLink: "desktop:revoke-relay-share-link",
  listRelayShareDiscussion: "desktop:list-relay-share-discussion",
  pollRelayShareDiscussionActivity:
    "desktop:poll-relay-share-discussion-activity",
  cancelRelayShareDiscussionActivity:
    "desktop:cancel-relay-share-discussion-activity",
  appendRelayShareDiscussion: "desktop:append-relay-share-discussion",
  deleteRelayShareDiscussionMessage:
    "desktop:delete-relay-share-discussion-message",
  blockRelayShareDiscussionPrincipal:
    "desktop:block-relay-share-discussion-principal",
  unblockRelayShareDiscussionPrincipal:
    "desktop:unblock-relay-share-discussion-principal",
  pauseRelayShareDiscussion: "desktop:pause-relay-share-discussion",
  resumeRelayShareDiscussion: "desktop:resume-relay-share-discussion",
  promoteRelayShareGrant: "desktop:promote-relay-share-grant",
  revokeRelayShareGrant: "desktop:revoke-relay-share-grant",
  shareChatChannel: "desktop:share-chat-channel",
  listChatChannelShares: "desktop:list-chat-channel-shares",
  listJoinedSharedChannels: "desktop:list-joined-shared-channels",
  joinSharedChannel: "desktop:join-shared-channel",
  leaveSharedChannel: "desktop:leave-shared-channel",
  openSharedView: "desktop:open-shared-view",
  refreshSharedView: "desktop:refresh-shared-view",
  dismissShareSkips: "desktop:dismiss-share-skips",
  // Automation failures (ADR 0008): the engine's failed claim rows minus
  // what the owner acknowledged; the push poke tells the renderer to
  // re-list.
  listAutomationFailures: "desktop:list-automation-failures",
  dismissAutomationFailure: "desktop:dismiss-automation-failure",
  automationFailuresChanged: "desktop:automation-failures-changed",
  // Share changes. The first three act on a workspace this
  // machine owns; the last three act from inside an edit-level share view.
  listShareProposals: "desktop:list-share-proposals",
  readShareProposalChanges: "desktop:read-share-proposal-changes",
  readShareProposalFileContent: "desktop:read-share-proposal-file-content",
  settleShareProposal: "desktop:settle-share-proposal",
  submitShareChanges: "desktop:submit-share-changes",
  listMyShareChanges: "desktop:list-my-share-changes",
  withdrawShareChanges: "desktop:withdraw-share-changes",
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
  getChatThreadRevision: "desktop:get-chat-thread-revision",
  sendChatMessage: "desktop:send-chat-message",
  listChatThreadDecisions: "desktop:list-chat-thread-decisions",
  resolveChatDecision: "desktop:resolve-chat-decision",
  listChatThreadAttachments: "desktop:list-chat-thread-attachments",
  chatRunRecordsForThread: "desktop:chat-run-records-for-thread",
  listChatChannels: "desktop:list-chat-channels",
  listChatFollows: "desktop:list-chat-follows",
  setChatFollow: "desktop:set-chat-follow",
  listPersonalChatFeed: "desktop:list-personal-chat-feed",
  markPersonalChatFeedSeen: "desktop:mark-personal-chat-feed-seen",
  createChatChannel: "desktop:create-chat-channel",
  listChannelThreads: "desktop:list-channel-threads",
  startChannelThread: "desktop:start-channel-thread",
  markChatThreadRead: "desktop:mark-chat-thread-read",
  listChatReactions: "desktop:list-chat-reactions",
  setChatReaction: "desktop:set-chat-reaction",
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
  rebuildEngineStore: "desktop:rebuild-engine-store",
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
  stepWindowZoom: "desktop:step-window-zoom",
  userSettingsChanged: "desktop:user-settings-changed",
  getWorkspaceUiState: "desktop:get-workspace-ui-state",
  setWorkspaceUiState: "desktop:set-workspace-ui-state",
  searchWorkspace: "desktop:search-workspace",
  cancelWorkspaceSearch: "desktop:cancel-workspace-search",
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
  updateState: "desktop:update-state",
  getUpdateState: "desktop:get-update-state",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  // Quit interception: main asks the renderer before a quit proceeds,
  // so set-aside drafts warn before any destructive teardown. The renderer
  // answers with hold (its dialog owns the decision) or resume (quit).
  quitRequested: "desktop:quit-requested",
  // Recovery re-check: main asks at the quit boundary,
  // because a reopen can set an edit aside after the renderer's own check and
  // before the install IPC runs. Request carries an id; the answer invokes
  // back with it.
  recoveryCheckRequested: "desktop:recovery-check-requested",
  recoveryCheckAnswer: "desktop:recovery-check-answer",
  holdQuit: "desktop:hold-quit",
  resumeQuit: "desktop:resume-quit",
  workspaceActivity: "desktop:workspace-activity",
  cloudSessionChanged: "desktop:cloud-session-changed",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
  getDesktopMarks: "desktop:test:get-desktop-marks",
} as const;
