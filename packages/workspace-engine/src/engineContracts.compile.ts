import type * as Engine from "@dohc/workspace-engine";
import type * as Contracts from "@dohc/workspace-contracts/engine";
import type {
  BoundaryCrossing,
  ChangeAuthor,
  ChangeProvenance,
  ChangeSetKind,
  FileChange,
} from "@dohc/workspace-core";
import type { ChangeSetStore, HistoryRecord } from "./changeSetStore";

type IsSame<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;

type AssertSame<A, B> = IsSame<A, B>;

type ContractChecks = [
  AssertSame<Engine.ActorNeutralWriteMetadata, Contracts.ActorNeutralWriteMetadata>,
  AssertSame<Engine.ActorNeutralWriteOrigin, Contracts.ActorNeutralWriteOrigin>,
  AssertSame<Engine.AgentDispatchClaim, Contracts.AgentDispatchClaim>,
  AssertSame<Engine.AgentDispatchRecord, Contracts.AgentDispatchRecord>,
  AssertSame<Engine.AgentDispatchState, Contracts.AgentDispatchState>,
  AssertSame<Engine.AgentDispatchStore, Contracts.AgentDispatchStore>,
  AssertSame<Engine.AgentRunRecord, Contracts.AgentRunRecord>,
  AssertSame<Engine.ChannelThreadSummary, Contracts.ChannelThreadSummary>,
  AssertSame<Engine.ChatAgentReadState, Contracts.ChatAgentReadState>,
  AssertSame<Engine.ChatActor, Contracts.ChatActor>,
  AssertSame<Engine.ChatAttachment, Contracts.ChatAttachment>,
  AssertSame<Engine.ChatChannel, Contracts.ChatChannel>,
  AssertSame<Engine.ChatChannelId, Contracts.ChatChannelId>,
  AssertSame<Engine.ChatChannelKind, Contracts.ChatChannelKind>,
  AssertSame<Engine.ChatChannelSummary, Contracts.ChatChannelSummary>,
  AssertSame<Engine.ChatDecisionRecord, Contracts.ChatDecisionRecord>,
  AssertSame<Engine.ChatDecisionState, Contracts.ChatDecisionState>,
  AssertSame<Engine.ChatMessage, Contracts.ChatMessage>,
  AssertSame<Engine.ChatMessageId, Contracts.ChatMessageId>,
  AssertSame<Engine.ChatMentionRecord, Contracts.ChatMentionRecord>,
  AssertSame<Engine.ChatThread, Contracts.ChatThread>,
  AssertSame<Engine.ChatThreadId, Contracts.ChatThreadId>,
  AssertSame<Engine.EngineFilePathClassification, Contracts.EngineFilePathClassification>,
  AssertSame<Engine.FileObjectRecord, Contracts.FileObjectRecord>,
  AssertSame<Engine.FileWorkspaceCapabilityReport, Contracts.FileWorkspaceCapabilityReport>,
  AssertSame<Engine.FileWorkspacePlatformMode, Contracts.FileWorkspacePlatformMode>,
  AssertSame<Engine.LinkedChatFileRef, Contracts.LinkedChatFileRef>,
  AssertSame<Engine.LinkedChatProjection, Contracts.LinkedChatProjection>,
  AssertSame<
    Engine.LinkedChatProjectionFileAccess,
    Contracts.LinkedChatProjectionFileAccess
  >,
  AssertSame<Engine.LinkedChatStore, Contracts.LinkedChatStore>,
  AssertSame<Engine.LinkedChatStoreErrorCode, Contracts.LinkedChatStoreErrorCode>,
  AssertSame<Engine.LinkedChatStoreOptions, Contracts.LinkedChatStoreOptions>,
  AssertSame<Engine.SearchSurface, Contracts.SearchSurface>,
  AssertSame<Engine.SearchVisibility, Contracts.SearchVisibility>,
  AssertSame<Engine.TextFileSnapshot, Contracts.TextFileSnapshot>,
  AssertSame<Engine.ThreadDispatchPauseState, Contracts.ThreadDispatchPauseState>,
  // VersionFileChange/VersionFileChangeStatus are gone from this list because the
  // engine no longer re-exports them: versionCompare moved to @dohc/workspace-core,
  // which re-exports them straight from @dohc/workspace-contracts/engine. There is
  // no longer a second declaration for them to drift from.
  AssertSame<Engine.VersionId, Contracts.VersionId>,
  AssertSame<Engine.VersionKind, Contracts.VersionKind>,
  AssertSame<Engine.VersionRecord, Contracts.VersionRecord>,
  AssertSame<Engine.VersionedFileDeleteResult, Contracts.VersionedFileDeleteResult>,
  AssertSame<Engine.VersionedFileHistoryReader, Contracts.VersionedFileHistoryReader>,
  AssertSame<Engine.VersionedFileListResult, Contracts.VersionedFileListResult>,
  AssertSame<Engine.VersionedFileReadResult, Contracts.VersionedFileReadResult>,
  AssertSame<Engine.VersionedFileRestoreResult, Contracts.VersionedFileRestoreResult>,
  AssertSame<Engine.VersionedFileStat, Contracts.VersionedFileStat>,
  AssertSame<Engine.VersionedFileVersionReader, Contracts.VersionedFileVersionReader>,
  AssertSame<Engine.VersionedFileWorkspace, Contracts.VersionedFileWorkspace>,
  AssertSame<
    Engine.VersionedFileWorkspaceErrorCode,
    Contracts.VersionedFileWorkspaceErrorCode
  >,
  AssertSame<Engine.VersionedFileWorkspaceOptions, Contracts.VersionedFileWorkspaceOptions>,
  AssertSame<Engine.VersionedFileWriteResult, Contracts.VersionedFileWriteResult>,
  AssertSame<Engine.VersionedTextComparison, Contracts.VersionedTextComparison>,
  AssertSame<
    Engine.VersionedTextComparisonStatus,
    Contracts.VersionedTextComparisonStatus
  >,
  AssertSame<Engine.VersionedTextConflictChoice, Contracts.VersionedTextConflictChoice>,
  AssertSame<Engine.VersionedTextConflictId, Contracts.VersionedTextConflictId>,
  AssertSame<Engine.VersionedTextConflictRecord, Contracts.VersionedTextConflictRecord>,
  AssertSame<
    Engine.VersionedTextConflictResolution,
    Contracts.VersionedTextConflictResolution
  >,
  AssertSame<
    Engine.VersionedTextConflictResolveResult,
    Contracts.VersionedTextConflictResolveResult
  >,
  AssertSame<Engine.VersionedTextConflictStatus, Contracts.VersionedTextConflictStatus>,
  AssertSame<Engine.VersionedTextDeleteResult, Contracts.VersionedTextDeleteResult>,
  AssertSame<Engine.VersionedTextFileState, Contracts.VersionedTextFileState>,
  AssertSame<Engine.VersionedTextMergeResult, Contracts.VersionedTextMergeResult>,
  AssertSame<Engine.VersionedTextMoment, Contracts.VersionedTextMoment>,
  AssertSame<Engine.VersionedTextMomentId, Contracts.VersionedTextMomentId>,
  AssertSame<Engine.VersionedTextMomentPage, Contracts.VersionedTextMomentPage>,
  AssertSame<Engine.VersionedTextMomentSummary, Contracts.VersionedTextMomentSummary>,
  AssertSame<Engine.VersionedTextRenameResult, Contracts.VersionedTextRenameResult>,
  AssertSame<Engine.VersionedTextStore, Contracts.VersionedTextStore>,
  AssertSame<Engine.VersionedTextStoreErrorCode, Contracts.VersionedTextStoreErrorCode>,
  AssertSame<Engine.VersionedTextStoreOptions, Contracts.VersionedTextStoreOptions>,
  AssertSame<Engine.VersionedTextWriteResult, Contracts.VersionedTextWriteResult>,
  AssertSame<Engine.WorkspaceEngineSearchOptions, Contracts.WorkspaceEngineSearchOptions>,
  AssertSame<Engine.WorkspaceEngineSearchResult, Contracts.WorkspaceEngineSearchResult>,
  AssertSame<Engine.WorkspaceId, Contracts.WorkspaceId>,
  AssertSame<Engine.WorkspaceObjectId, Contracts.WorkspaceObjectId>,
  AssertSame<Engine.WorkspaceSearchPolicy, Contracts.WorkspaceSearchPolicy>,
];

// The contracts package cannot import @dohc/workspace-core or the engine's
// changeSetStore (both would create a dependency cycle: workspace-core already
// depends on workspace-contracts). engine.ts therefore carries private
// structural copies of the history/provenance shapes. These checks pin those
// copies to the real types so any drift fails this package's typecheck, which
// CAN see both sides.
type HistoryDriftChecks = [
  AssertSame<Contracts.VersionedFileWriteResult["history"], HistoryRecord>,
  AssertSame<Contracts.VersionedFileWriteResult["history"]["kind"], ChangeSetKind>,
  AssertSame<
    Contracts.VersionedFileWriteResult["history"]["files"][number],
    FileChange
  >,
  AssertSame<
    Contracts.VersionedFileWriteResult["history"]["boundaryCrossings"][number],
    BoundaryCrossing
  >,
  AssertSame<
    NonNullable<Contracts.VersionedFileWriteResult["history"]["provenance"]>,
    ChangeProvenance
  >,
  AssertSame<
    NonNullable<Contracts.VersionedFileWorkspaceOptions["author"]>,
    ChangeAuthor
  >,
  AssertSame<
    Contracts.VersionedFileHistoryReader,
    Pick<ChangeSetStore, "get" | "list" | "listIndexed" | "listSince">
  >,
];

type AssertAllSame<T extends readonly true[]> = T;
type VerifiedContractChecks = AssertAllSame<[...ContractChecks, ...HistoryDriftChecks]>;

export const engineContractReExportCompileCheck: VerifiedContractChecks[number] = true;
