export {
  LINKED_CHAT_PROJECTION_KIND,
  LINKED_CHAT_STORE_RELATIVE_PATH,
  LinkedChatStoreError,
  createLinkedChatStore,
  linkedChatProjectionPath,
} from "./linkedChatStore";
export {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";
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
  ChatActor,
  ChatMessage,
  ChatMessageId,
  ChatThread,
  ChatThreadId,
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
  searchWorkspaceEngine,
} from "./workspaceSearch";
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
