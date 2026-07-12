export { parseMentionHandles } from "./chatMentions";
export {
  AgentDispatchStoreError,
  createAgentDispatchStore,
} from "./agentDispatchStore";
export type {
  AgentDispatchClaim,
  AgentDispatchRecord,
  AgentDispatchState,
  AgentDispatchStore,
  AgentDispatchStoreErrorCode,
  AgentDispatchStoreOptions,
  AgentRunRecord,
  ThreadDispatchPauseState,
} from "./agentDispatchStore";
export {
  AGENT_CHANNEL_NAME,
  AGENT_CHANNEL_WIRE_ID,
  GENERAL_CHANNEL_NAME,
  GENERAL_CHANNEL_WIRE_ID,
  LINKED_CHAT_PROJECTION_KIND,
  LINKED_CHAT_STORE_RELATIVE_PATH,
  LinkedChatStoreError,
  THREAD_SNIPPET_TITLE_MAX_CHARS,
  UNTITLED_THREAD_FALLBACK_TITLE,
  channelSlugForName,
  createLinkedChatStore,
  linkedChatProjectionPath,
  threadSnippetTitle,
} from "./linkedChatStore";
export {
  MAX_VERSIONED_BINARY_FILE_BYTES,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";
// WS-G2-C1 / G2-C-2 handoff: the reserved transaction origin a remote
// ydoc.update apply carries, so the future editor provider can filter it out of
// its local-edit journaling (see liveYDocRegistry.ts for the contract).
export { REMOTE_YDOC_APPLY_ORIGIN } from "./liveYDocRegistry";
// Legacy `.dohc/history` change-set store. The engine (moments in
// engine.db) is the production recorder post-flip; createChangeSetStore is
// retained ONLY so read-only relic reads and drift-guard checks (the desktop
// capture guard test, the phase0m QA script) can confirm the engine writes no
// legacy history. No production surface records through it.
export {
  createChangeSetStore,
  isDurableChangeSetRecordingSupported,
} from "./changeSetStore";
export type {
  ChangeSetStore,
  HistoryRecord,
} from "./changeSetStore";
export {
  exportSyncBundle,
  importSyncBundle,
} from "./syncFolder";
export type {
  ExportSyncBundleInput,
  ExportSyncBundleResult,
  ImportSyncBundleInput,
  ImportSyncBundleResult,
} from "./syncFolder";
export {
  ensureOriginId,
  journalReplicationOp,
  nextOriginSeq,
} from "./syncReplication";
export {
  RelayBlobMissingError,
  RelayConflictError,
  RelayKeyEnvelopeMissingError,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  claimRelayWorkspace,
  downloadKeyEnvelope,
  probeRelayWorkspace,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  recoverRelayOrigin,
  uploadKeyEnvelope,
} from "./syncRelay";
export type {
  ProbeRelayWorkspaceResult,
  PullWorkspaceFromRelayResult,
  PushWorkspaceToRelayResult,
  RecoverRelayOriginResult,
  RelayMaterializedPath,
  SyncRelayConnection,
  SyncRelayInput,
} from "./syncRelay";
export {
  ShareUnavailableError,
  fetchShareViewInfo,
  pullShareView,
} from "./syncShareView";
export type {
  PullShareViewResult,
  ShareViewChangedPath,
  ShareViewInfo,
  ShareViewSelector,
} from "./syncShareView";
export {
  SharedChannelAppendRejectedError,
  SharedChannelReadOnlyError,
  fetchSharedChannelInfo,
  pullSharedChannel,
  pushSharedChannel,
} from "./syncSharedChannel";
export type {
  PullSharedChannelResult,
  PushSharedChannelResult,
  SharedChannelInfo,
} from "./syncSharedChannel";
export type {
  PendingConflictResolve,
  SyncApplyResult,
  SyncReplicationEnvelope,
  SyncReplicationOpKind,
} from "./syncReplication";
export {
  YDocEngineDriverError,
  createYDocEngineDriver,
} from "./ydocEngineDriver";
export type {
  YDocContentKind,
  YDocDocKey,
  YDocEngineDriver,
  YDocEngineDriverErrorCode,
  YDocEngineDriverOptions,
  YDocExternalEditResult,
  YDocSession,
  YDocSettleResult,
} from "./ydocEngineDriver";
export { compareVersionFiles } from "./versionCompare";
export type {
  VersionFileChange,
  VersionFileChangeStatus,
} from "./versionCompare";
export {
  VersionedFileWorkspaceError,
  getFileWorkspaceCapabilityReport,
  resolveFileWorkspacePlatformMode,
} from "./versionedFileWorkspace";
export type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  AgentMomentAuthor,
  FileObjectRecord,
  MomentAuthor,
  TextFileSnapshot,
  VersionId,
  VersionKind,
  VersionRecord,
  VersionedTextComparison,
  VersionedTextComparisonStatus,
  VersionedTextConflictChoice,
  VersionedTextConflictId,
  VersionedTextConflictRecord,
  VersionedTextConflictResolveResult,
  VersionedTextConflictResolution,
  VersionedTextConflictStatus,
  VersionedTextDeleteResult,
  VersionedTextFileState,
  VersionedTextMergeResult,
  VersionedTextMoment,
  VersionedTextMomentId,
  VersionedTextMomentPage,
  VersionedTextMomentSummary,
  VersionedTextRenameResult,
  VersionedTextStore,
  VersionedTextStoreErrorCode,
  VersionedTextStoreOptions,
  VersionedTextWriteResult,
  WorkspaceId,
  WorkspaceObjectId,
} from "./versionedTextStore";
export type {
  VersionedFileDeleteResult,
  VersionedFileHistoryReader,
  VersionedFileListResult,
  VersionedFileReadResult,
  VersionedFileRestoreResult,
  VersionedFileStat,
  VersionedFileVersionReader,
  VersionedFileWorkspace,
  VersionedFileWorkspaceErrorCode,
  VersionedFileWorkspaceOptions,
  VersionedFileWriteResult,
  FileWorkspaceCapabilityReport,
  FileWorkspacePlatformMode,
} from "./versionedFileWorkspace";
export type {
  ChannelThreadSummary,
  ChatAgentReadState,
  ChatActor,
  ChatAttachment,
  ChatChannel,
  ChatChannelId,
  ChatChannelKind,
  ChatChannelSummary,
  ChatDecisionRecord,
  ChatDecisionState,
  ChatMentionRecord,
  ChatMessage,
  ChatMessageId,
  ChatReaction,
  ChatReactionAuthor,
  ChatReactionState,
  ChatThread,
  ChatThreadId,
  ChatThreadReadState,
  LinkedChatFileRef,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
  LinkedChatStoreErrorCode,
  LinkedChatStoreOptions,
} from "./linkedChatStore";
export {
  WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS,
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
  searchWorkspaceEngine,
} from "./workspaceSearch";
export { queryChatMessagesGranular } from "./searchIndex";
export type { GranularChatMessageSearchResult } from "./searchIndex";
export {
  MAX_SECRET_FILE_BYTES,
  SECRET_FILE_STORE_RELATIVE_PATH,
  SECRET_KEY_RELATIVE_PATH,
  SecretFileStoreError,
  createSecretFileStore,
  installWorkspaceDataKey,
  readWorkspaceDataKeyForEnrollment,
  readWorkspaceSecretState,
  type WorkspaceSecretState,
} from "./secretFileStore";
export {
  SECRET_KEY_ENVELOPE_FORMAT,
  SECRET_KEY_ENVELOPE_SCRYPT_N,
  SECRET_KEY_ENVELOPE_SCRYPT_P,
  SECRET_KEY_ENVELOPE_SCRYPT_R,
  SecretKeyEnvelopeError,
  unwrapWorkspaceDataKey,
  wrapWorkspaceDataKey,
} from "./secretKeyEnvelope";
export type {
  SecretFileCompareEntry,
  SecretFileDeleteOutcome,
  SecretFileMaterialization,
  SecretFileMoment,
  SecretFileRestoreOutcome,
  SecretFileStat,
  SecretFileStore,
  SecretFileStoreErrorCode,
  SecretFileStoreOptions,
  SecretFileWriteOutcome,
} from "./secretFileStore";
export {
  parseFilesPolicy,
  parseVisibilityPolicy,
  policyGlobMatches,
  resolveEffectivePolicy,
  validatePolicyGlob,
} from "./effectivePolicy";
export type {
  EffectivePolicyInput,
  EffectivePolicyResult,
  FilesPolicyRule,
  PolicyGlobValidation,
  PolicyParseResult,
  VisibilityPolicyRule,
} from "./effectivePolicy";
export type {
  EngineFilePathClassification,
  SearchSurface,
  SearchVisibility,
  WorkspaceEngineSearchOptions,
  WorkspaceEngineSearchResult,
  WorkspaceSearchPolicy,
} from "./workspaceSearch";
