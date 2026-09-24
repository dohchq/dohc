// The daemon client surface the desktop app, CLI, and tools import. Test
// fakes and fixture helpers live under `@dohc/workspace-engine-client/testing`.
export type { Event, JsonValue, Request, Response, Retryability } from "./protocol";

export {
  DaemonRefusalError,
  WorkspaceDaemonRequester,
  engineStoreRefusalDetailOf,
  engineStoreRefusalOf,
  isConflictStaleTargetRefusal,
  isEngineStoreBusyRefusal,
  isFileLockedRefusal,
  isTransientEngineRefusal,
  isWorkspaceUpdatingRefusal,
  isYdocArtifactAssetsInvalidRefusal,
  isYdocRemoteUpdatesPendingRefusal,
  isYdocUnsettledCloseRefusal,
  type CompletedDaemonBlob,
  type DaemonErrorCode,
  type EngineStoreRefusal,
} from "./live/daemonLiveAdapter";

export {
  YDOC_OPEN_DEADLINE_MS,
  YdocAdapterError,
  YdocOwnerDraftPendingError,
  YdocLiveAdapter,
  YdocOpenTimedOutError,
  isYDocClaimPromotion,
  type EngineTransport,
} from "./ydoc/ydocLiveAdapter";
export {
  YdocReleasedWithSettleFailureError,
  openEngineYdocProviderSession,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
} from "./ydoc/ydocProviderSession";
export {
  YDOC_METHOD,
  type ArtifactAssetDescriptor,
  type ChangeAttributionWire,
  type JsonObject,
  type YdocContentKind,
} from "./ydoc/ydocWireContract";

export { ChatsLiveAdapter } from "./chats/chatsLiveAdapter";
export { CHATS_METHOD, decodeChatsResult, type ChatChannel, type ChatChannelSummary, type ChatDispatch, type ChatDispatchClaim, type ChatFileMention, type ChatRecoveriesPage, type ChatRunMessagesPage, type ChatUnreadFileThread } from "./chats/chatsWireContract";

export { VersionedLiveAdapter } from "./versioned/versionedLiveAdapter";
export {
  VERSIONED_METHOD,
  type AgentAuthor,
  type MomentRecord,
  type SecretMomentRecord,
  type VersionedComparisonRecord,
  type VersionedTextListEntry,
  type VersionedTextReadValue,
} from "./versioned/versionedWireContract";

export {
  KEY_ENVELOPE_METHOD,
  decodeKeyEnvelopeResult,
  type KeyEnvelopeDownloadResult,
  type KeyEnvelopeUploadResult,
} from "./relay/keyEnvelopeWireContract";

export { AUTOMATION_CLAIMED_EVENT, MAX_GRANULAR_CHAT_QUERY_CHARS, WORKSPACE_METHOD, decodeCollectionValue, decodeWorkspaceResult, encodeCollectionValue, type AutomationClaim, type CollectionPendingAdoptionCursor, type CollectionPendingAdoptionsPage, type ConflictFileState, type ConflictRecord, type GranularChatMessageSearchResponse, type GranularChatMessageSearchResult, type SearchQueryPageParams, type SearchResult, type WatcherStatusResult } from "./workspace/workspaceWireContract";

export {
  OwnerYDocOutbox,
  OwnerYDocOutboxReadChangedError,
  parseLiveObjectBinding,
  type LiveObjectBinding,
  type OwnerYDocOutboxEntry,
} from "./ydoc/ownerYDocOutbox";
