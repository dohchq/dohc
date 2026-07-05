import type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  ChatActor,
  ChatMessage,
  ChatMessageId,
  ChatThread,
  ChatThreadId,
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
  TextFileSnapshot,
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
    const message: ChatMessage = {
      id: messageId,
      workspaceId,
      threadId,
      author: actor,
      body: "hello",
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
    const searchOptions = null as unknown as WorkspaceEngineSearchOptions;
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
    void message;
    void projection;
    void chatSend;
    void chatOptions;
    void searchPolicy;
    void searchResult;
    void searchOptions;
    void classification;
    void change;

    return true;
})();
