import type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  AgentDispatchClaim,
  AgentDispatchRecord,
  AgentDispatchState,
  AgentDispatchStore,
  AgentRunRecord,
  ChannelThreadSummary,
  ChatAgentReadState,
  ChatActor,
  ChatAttachment,
  ChatAttachmentAddPayload,
  ChatChannel,
  ChatChannelId,
  ChatChannelKind,
  ChatChannelSummary,
  ChatDecisionRecord,
  ChatDecisionSetPayload,
  ChatDecisionState,
  ChatMessage,
  ChatMessageId,
  ChatMentionRecord,
  ChatThread,
  ChatThreadId,
  ChatThreadReadState,
  EngineFilePathClassification,
  FileObjectRecord,
  FileWorkspaceCapabilityReport,
  FileWorkspacePlatformMode,
  LinkedChatFileRef,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
  LinkedChatStoreErrorCode,
  LinkedChatStoreOptions,
  SearchSurface,
  SearchVisibility,
  SyncReplicationEnvelope,
  TextFileSnapshot,
  ThreadDispatchPauseState,
  VersionFileChange,
  VersionFileChangeStatus,
  VersionId,
  VersionKind,
  VersionRecord,
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
  VersionedTextComparison,
  VersionedTextComparisonStatus,
  VersionedTextConflictChoice,
  VersionedTextConflictId,
  VersionedTextConflictRecord,
  VersionedTextConflictResolution,
  VersionedTextConflictResolveResult,
  VersionedTextConflictStatus,
  VersionedTextDeleteResult,
  VersionedTextFileState,
  VersionedTextMergeResult,
  VersionedTextMoment,
  VersionedTextMomentId,
  VersionedTextMomentPage,
  VersionedTextMomentPayload,
  VersionedTextMomentPayloadSnapshot,
  VersionedTextMomentSummary,
  VersionedTextRenameResult,
  VersionedTextStore,
  VersionedTextStoreErrorCode,
  VersionedTextStoreOptions,
  VersionedTextWriteResult,
  WorkspaceEngineSearchOptions,
  WorkspaceEngineSearchResult,
  WorkspaceId,
  WorkspaceObjectId,
  WorkspaceSearchPolicy,
} from "./engine";

export const engineContractCompileCheck = (() => {
    const workspaceId: WorkspaceId = "workspace";
    const versionId: VersionId = "version";
    const objectId: WorkspaceObjectId = "object";
    const momentId: VersionedTextMomentId = "moment";
    const conflictId: VersionedTextConflictId = "conflict";
    const origin: ActorNeutralWriteOrigin = "api";
    const metadata: ActorNeutralWriteMetadata = { origin, summary: "Saved" };
    const versionKind: VersionKind = "main";
    const version: VersionRecord = {
      id: versionId,
      workspaceId,
      kind: versionKind,
      name: "Main",
      createdAtMs: 1,
    };
    const object: FileObjectRecord = {
      id: objectId,
      workspaceId,
      createdAtMs: 1,
    };
    const snapshot: TextFileSnapshot = {
      objectId,
      versionId,
      path: "notes/day.md",
      text: "# Day\n",
      updatedAtMs: 2,
      latestMomentId: momentId,
      metadata,
    };
    const state: VersionedTextFileState = {
      exists: true,
      path: snapshot.path,
      objectId,
      text: snapshot.text,
      updatedAtMs: snapshot.updatedAtMs,
      latestMomentId: momentId,
      metadata,
    };
    const comparisonStatus: VersionedTextComparisonStatus = "same";
    const comparison: VersionedTextComparison = {
      workspaceId,
      path: snapshot.path,
      targetVersionId: versionId,
      sourceVersionId: versionId,
      base: state,
      current: state,
      incoming: state,
      status: comparisonStatus,
    };
    const conflictStatus: VersionedTextConflictStatus = "open";
    const conflictResolution: VersionedTextConflictResolution = "kept-current";
    const conflictChoice: VersionedTextConflictChoice = "current";
    const conflict: VersionedTextConflictRecord = {
      id: conflictId,
      workspaceId,
      path: snapshot.path,
      targetVersionId: versionId,
      sourceVersionId: versionId,
      createdAtMs: 1,
      updatedAtMs: 2,
      base: state,
      current: state,
      incoming: state,
      status: conflictStatus,
      chosenFrom: conflictChoice,
      metadata,
      resolution: conflictResolution,
    };
    const payloadSnapshot: VersionedTextMomentPayloadSnapshot = {
      path: snapshot.path,
      text: snapshot.text,
    };
    const payload: VersionedTextMomentPayload = {
      before: null,
      after: payloadSnapshot,
    };
    const moment: VersionedTextMoment = {
      id: momentId,
      workspaceId,
      versionId,
      objectId,
      path: snapshot.path,
      recordedAtMs: 3,
      operation: "write",
      payload,
      metadata,
      before: null,
    };
    const summary: VersionedTextMomentSummary = {
      id: momentId,
      workspaceId,
      versionId,
      objectId,
      path: snapshot.path,
      recordedAtMs: 3,
      operation: "write",
      metadata,
      momentOrder: 1,
    };
    const page: VersionedTextMomentPage = {
      moments: [summary],
      nextBeforeMomentOrder: null,
      latestMomentOrder: 1,
    };
    const write: VersionedTextWriteResult = { object, snapshot, moment };
    const rename: VersionedTextRenameResult = {
      object,
      before: snapshot,
      after: snapshot,
      moment,
    };
    const deleted: VersionedTextDeleteResult = { object, before: snapshot, moment };
    const merge: VersionedTextMergeResult = {
      kind: "merged",
      operation: "write",
      comparison,
      write,
    };
    const resolve: VersionedTextConflictResolveResult = {
      kind: "resolved",
      conflict,
      write,
    };
    const textStoreOptions: VersionedTextStoreOptions = {};
    type TextStoreWrite = VersionedTextStore["writeTextFile"];
    const textStoreWrite: TextStoreWrite | null = null;
    const textStoreErrorCode: VersionedTextStoreErrorCode = "invalid-input";

    const platformMode: FileWorkspacePlatformMode = "linux-anchored";
    const capabilities: FileWorkspaceCapabilityReport = {
      platform: "linux",
      mode: platformMode,
      atomicReplace: true,
      symlinkDefense: "descriptor-relative",
      descriptorPinning: true,
      containmentCheck: "realpath-root-containment",
      fileFsync: true,
      parentDirectoryFsync: "supported",
      notes: [],
    };
    const fileErrorCode: VersionedFileWorkspaceErrorCode = "invalid-path";
    const stat: VersionedFileStat = {
      path: snapshot.path,
      mediaType: "text/markdown",
      sizeBytes: 6,
      sha256: "abc",
    };
    const readResult: VersionedFileReadResult = snapshot.text;
    const listResult: VersionedFileListResult = [stat];
    const history: VersionedFileWriteResult["history"] = {
      id: "history",
      recordedAtMs: 4,
      kind: "user-edit",
      author: { kind: "user", userId: "user" },
      summary: "Saved",
      files: [],
      boundaryCrossings: [],
    };
    const fileWrite: VersionedFileWriteResult = {
      path: snapshot.path,
      versionId,
      snapshot,
      history,
    };
    const fileDelete: VersionedFileDeleteResult = {
      path: snapshot.path,
      versionId,
      deleted: snapshot,
      history,
    };
    const fileRestore: VersionedFileRestoreResult = {
      ...fileWrite,
      restoredFrom: {
        changeSetId: history.id,
        path: snapshot.path,
        direction: "after",
      },
    };
    type HistoryList = VersionedFileHistoryReader["list"];
    type VersionReaderRead = VersionedFileVersionReader["readTextFile"];
    type FileWorkspaceWrite = VersionedFileWorkspace["writeTextFile"];
    const historyList: HistoryList | null = null;
    const versionReaderRead: VersionReaderRead | null = null;
    const fileWorkspaceWrite: FileWorkspaceWrite | null = null;
    const workspaceOptions: VersionedFileWorkspaceOptions = {
      rootDir: "/tmp/workspace",
      workspaceId,
    };

    const threadId: ChatThreadId = "thread";
    const messageId: ChatMessageId = "message";
    const chatErrorCode: LinkedChatStoreErrorCode = "thread-not-found";
    const actor: ChatActor = { kind: "human", displayName: "Ice" };
    const fileRef: LinkedChatFileRef = {
      objectId,
      pathHint: snapshot.path,
      linkedAtMs: 5,
    };
    const thread: ChatThread = {
      id: threadId,
      workspaceId,
      title: "Day",
      createdAtMs: 5,
      updatedAtMs: 5,
      linkedFile: fileRef,
    };
    const attachment: ChatAttachment = {
      attachmentId: "attachment",
      threadId,
      messageId,
      targetKind: "file",
      objectId,
      pathHint: snapshot.path,
      createdAtMs: 6,
    };
    const message: ChatMessage = {
      id: messageId,
      workspaceId,
      threadId,
      author: actor,
      parentMessageId: "parent-message",
      body: "hello",
      createdAtMs: 6,
      attachments: [attachment],
    };
    const decisionState: ChatDecisionState = "open";
    const decision: ChatDecisionRecord = {
      workspaceId,
      threadId,
      messageId,
      state: decisionState,
      atMs: 6,
    };
    const agentReadState: ChatAgentReadState = {
      workspaceId,
      threadId,
      lastReadCreatedAtMs: 6,
      lastReadMessageId: messageId,
      revision: 1,
      updatedAtMs: 7,
    };
    const mention: ChatMentionRecord = {
      threadId,
      messageId,
      handle: "agent",
      authorKind: "human",
      createdAtMs: 6,
    };
    const access: LinkedChatProjectionFileAccess = { kind: "allowed", path: snapshot.path };
    const projection: LinkedChatProjection = {
      path: ".dohc/chats/thread.md",
      readOnly: true,
      threadId,
      text: "# Day\n",
    };
    type ChatSend = LinkedChatStore["sendMessage"];
    const chatSend: ChatSend | null = null;
    const chatOptions: LinkedChatStoreOptions = {};

    // Channels + read cursors (PR 12, WS-E).
    const channelId: ChatChannelId = "channel";
    const channelKind: ChatChannelKind = "agent";
    const channel: ChatChannel = {
      id: channelId,
      workspaceId,
      name: "general",
      slug: "general",
      kind: "channel",
      createdAtMs: 5,
      updatedAtMs: 5,
    };
    const channelSummary: ChatChannelSummary = {
      ...channel,
      threadCount: 1,
      unreadCount: 0,
    };
    const channelThread: ChatThread = {
      id: threadId,
      workspaceId,
      title: "Snippet of the first message",
      createdAtMs: 5,
      updatedAtMs: 5,
      channelId,
    };
    const readState: ChatThreadReadState = {
      workspaceId,
      threadId,
      lastReadSequence: 1,
      revision: 1,
      updatedAtMs: 6,
    };
    const channelThreadSummary: ChannelThreadSummary = {
      thread: channelThread,
      messageCount: 2,
      lastReadSequence: 1,
      unreadCount: 1,
      openDecisionCount: 1,
    };
    type ChannelStart = LinkedChatStore["startChannelThread"];
    const channelStart: ChannelStart | null = null;
    type MarkRead = LinkedChatStore["markThreadRead"];
    const markRead: MarkRead | null = null;
    type EnsureAgentChannel = LinkedChatStore["ensureAgentChannel"];
    type ResolveDecision = LinkedChatStore["resolveChatDecision"];
    type ListDecisions = LinkedChatStore["listThreadDecisions"];
    type ListAttachments = LinkedChatStore["listThreadAttachments"];
    type MarkAgentRead = LinkedChatStore["markThreadReadByAgent"];
    type ListAgentUnread = LinkedChatStore["listAgentUnreadThreads"];
    type ListMentions = LinkedChatStore["listMentionsForHandle"];
    const ensureAgentChannel: EnsureAgentChannel | null = null;
    const resolveDecision: ResolveDecision | null = null;
    const listDecisions: ListDecisions | null = null;
    const listAttachments: ListAttachments | null = null;
    const markAgentRead: MarkAgentRead | null = null;
    const listAgentUnread: ListAgentUnread | null = null;
    const listMentions: ListMentions | null = null;

    const decisionPayload: ChatDecisionSetPayload = {
      threadId,
      messageId,
      state: "resolved",
      resolvedByMessageId: "resolution",
      atMs: 8,
    };
    const attachmentPayload: ChatAttachmentAddPayload = {
      attachmentId: attachment.attachmentId,
      threadId,
      messageId,
      targetKind: "file",
      objectId,
      pathHint: snapshot.path,
      createdAtMs: 6,
    };
    const decisionEnvelope: SyncReplicationEnvelope = {
      workspaceId,
      originId: "origin",
      originSeq: 1,
      opKind: "chat.decision.set",
      payload: decisionPayload,
      recordedAtMs: 8,
    };
    const attachmentEnvelope: SyncReplicationEnvelope = {
      workspaceId,
      originId: "origin",
      originSeq: 2,
      opKind: "chat.attachment.add",
      payload: attachmentPayload,
      recordedAtMs: 8,
    };

    const dispatchState: AgentDispatchState = "running";
    const dispatch: AgentDispatchRecord = {
      workspaceId,
      triggerMessageId: messageId,
      threadId,
      state: dispatchState,
      runId: "run",
      attemptCount: 1,
      createdAtMs: 8,
      updatedAtMs: 8,
    };
    const run: AgentRunRecord = {
      workspaceId,
      runId: "run",
      threadId,
      triggerMessageId: messageId,
      command: "runner",
      startedAtMs: 8,
      failureNotePosted: false,
    };
    const dispatchClaim: AgentDispatchClaim = { dispatch, run };
    const pauseState: ThreadDispatchPauseState = {
      workspaceId,
      threadId,
      paused: false,
      updatedAtMs: 8,
    };
    type ClaimDispatch = AgentDispatchStore["claimNextPending"];
    const claimDispatch: ClaimDispatch | null = null;

    const surface: SearchSurface = "file";
    const visibility: SearchVisibility = { searchable: true, projectionFileAccess: access };
    const searchPolicy: WorkspaceSearchPolicy = {
      fileVisibility: () => visibility,
      chatVisibility: () => visibility,
    };
    const searchResult: WorkspaceEngineSearchResult = {
      surface,
      path: snapshot.path,
      title: snapshot.path,
      line: 1,
      preview: "# Day",
      matchStart: 2,
      matchEnd: 5,
      objectId,
    };
    // A concrete literal keeps this drift check real for the option FIELDS
    // (workspaceId/versionId/query/policy/limit renames fail compilation);
    // only the two store interfaces — unconstructible without an
    // implementation — stay as casts.
    const searchOptions: WorkspaceEngineSearchOptions = {
      workspaceId: "workspace-a",
      versionId: "main",
      query: "day",
      versions: null as unknown as VersionedTextStore,
      chats: null as unknown as LinkedChatStore,
      policy: searchPolicy,
      limit: 20,
    };
    const classification: EngineFilePathClassification = { kind: "tracked" };

    const changeStatus: VersionFileChangeStatus = "modified";
    const change: VersionFileChange = {
      path: snapshot.path,
      status: changeStatus,
      currentText: "before",
      incomingText: "after",
    };

    void version;
    void object;
    void page;
    void rename;
    void deleted;
    void merge;
    void resolve;
    void textStoreOptions;
    void textStoreWrite;
    void textStoreErrorCode;
    void capabilities;
    void fileErrorCode;
    void readResult;
    void listResult;
    void fileDelete;
    void fileRestore;
    void historyList;
    void versionReaderRead;
    void fileWorkspaceWrite;
    void workspaceOptions;
    void chatErrorCode;
    void thread;
    void attachment;
    void message;
    void decision;
    void agentReadState;
    void mention;
    void projection;
    void chatSend;
    void chatOptions;
    void channelKind;
    void channelSummary;
    void readState;
    void channelThreadSummary;
    void channelStart;
    void markRead;
    void ensureAgentChannel;
    void resolveDecision;
    void listDecisions;
    void listAttachments;
    void markAgentRead;
    void listAgentUnread;
    void listMentions;
    void decisionEnvelope;
    void attachmentEnvelope;
    void dispatchClaim;
    void pauseState;
    void claimDispatch;
    void searchPolicy;
    void searchResult;
    void searchOptions;
    void classification;
    void change;

    return true;
})();
