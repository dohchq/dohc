import { createHash } from "node:crypto";
import { duplicateWorkspaceFile } from "../workspaces/workspaceDuplicate";
import { createOperationHistory, readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation } from "../workspaces/workspaceHistoryOperations";
import { writeWorkspaceFilesAs } from "../workspaces/workspaceFileWrites";
import { prepareDeleteWorkspacePathAs, prepareMoveWorkspacePathAs, type PathChangeOptions } from "../workspaces/workspaceFileMoves";
import { join, resolve } from "node:path";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import {
  CHATS_METHOD,
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
  decodeChatsResult,
  type VersionedLiveAdapter,
} from "@dohc/workspace-engine-client";
import type {
  EngineDaemonLifecycle,
  EngineWorkspace,
} from "@dohc/workspace-engine-client/daemon";
import {
  CLI_REQUEST_DEADLINE_MS,
  type CliAutomationsPort,
  type CliButtonsPort,
  type CliRegistryWorkspace,
  type CliRunMessageLink,
  type CliServerHandle,
  type CliServerOptions,
  type CliWorkspaceContext,
  type startCliServer as startCliServerImplementation,
} from "./cliServer";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";
import { requirePublishedWrite, type WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { LocalDatasetAgent } from "../workspaces/localDatasetHost";
import type { WorkspaceAuthorityOperation } from "../workspaces/workspaceAuthorityOwner";
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import { captureRefusal } from "../workspaces/engineCaptureGate";
import { assertOriginalWorkspace } from "../ipc/ownerRelayShareHandler";
import type { OwnerLiveQuarantine, SaveOwnerLiveRecoveryCopyResult, StopOwnerLiveDocumentResult } from "../ipc/bridgeContract";
import type { OwnerLiveStopAgain } from "../ipc/relaySharesIpc";
import {
  runCollectionRecordCreation,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "@dohc/automation-executor/collection-record-edits";
import type { ChatRelayIdentityTarget } from "../workspaces/chatRelayIdentity";
import type { ChatWrites } from "../workspaces/chatWrites";
import type { LiveDocumentEditOrigin, LiveDocumentSessions } from "../workspaces/engineYDocSessionIpc";
import { readWorkspaceText } from "../workspaces/workspaceAssets";
import { historyPathAdmission, historyMomentPathsAdmitted, readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";
import { versionConflictForIpc } from "../ipc/engineHistoryIpc";
import { workspaceVersionForIpc } from "../ipc/workspaceVersionsIpc";
import type { createVersionRounds } from "../versionRounds";
import type { DocumentProjection } from "../workspaces/documentProjection";
import { FRONTMATTER_REFUSAL, startsWithFrontmatter } from "@dohc/ydoc-projection";
import { lossyNoteRefusal, unreadNoteRefusal } from "@dohc/ydoc-projection/lossy-markdown";
import { VersionedTextStoreError, type MomentWriteAuthor } from "@dohc/workspace-contracts/engine";

export function agentWriteAuthor(origin: LiveDocumentEditOrigin): MomentWriteAuthor {
  const { depth = 0, onBehalfOf } = origin.attribution;
  if (onBehalfOf === undefined) throw new Error("The agent write has no local person identity.");
  return { kind: "agent", agentId: origin.actorOriginId ?? "dohc-mcp", onBehalfOf, ...(depth > 0 ? { depth } : {}) };
}

// With no editor open, the file holds the document's settled text.
async function settledMarkdown(rootPath: string, path: string): Promise<string> {
  const read = await readWorkspaceText(rootPath, path);
  if (read.truncated) throw new Error(`${path} is too large to open as a live document.`);
  return read.text;
}

interface DesktopCliServerDependencies<State> {
  chatLinks: NonNullable<CliServerOptions["chatLinks"]>;
  chatFileMentions: NonNullable<CliServerOptions["chatFileMentions"]>;
  links: ReturnType<typeof import("../workspaces/workspaceLinks").createWorkspaceLinksReader>;
  stopWorkspaceSync?(operation: WorkspaceAuthorityOperation<RegistryEntry, State>, author?: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPauseAuthor): Promise<import("@dohc/cli/protocol").CliResultByVerb["stopSync"]>;
  shareCopy?(operation: WorkspaceAuthorityOperation<RegistryEntry, State>, input: import("@dohc/workspace-contracts/share-copy").ShareCopyInput): Promise<import("@dohc/workspace-contracts/share-copy").ShareCopyResult>;
  /** The desktop engine's refused live edits, and its Save recovery copy, Try again and Stop again for them. */
  ownerLiveRecovery?: {
    keptEdits(workspaceId: string): readonly OwnerLiveQuarantine[];
    /** With an incident, saves exactly that row's kept edits. */
    save(workspace: RegistryEntry, path: string, incident?: string): Promise<SaveOwnerLiveRecoveryCopyResult>;
    retry(workspace: RegistryEntry, objectId: string, incident: string): Promise<void>;
    /** The window's Stop of that row's document only, run while no editor holds the document where it is now. */
    stopAgain(operation: WorkspaceAuthorityOperation<RegistryEntry, State>, kept: { path: string } & OwnerLiveStopAgain): Promise<StopOwnerLiveDocumentResult>;
  };
  access?(workspaceId: string): NonNullable<CliWorkspaceContext["access"]>;
  recordSuccess?: CliServerOptions["recordSuccess"];
  serverAccount?: CliServerOptions["serverAccount"];
  dataset?(request: import("@dohc/cli/dataset").DatasetRequest, agent: LocalDatasetAgent | null): Promise<import("@dohc/cli/dataset").DatasetResult>;
  ownerAppResponses?(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest):Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>;
  ownerAppPublication?(request: OwnerAppPublicationRequest, agent: import("@dohc/security-contract/approval-provenance").ApprovalAgent | null): Promise<OwnerAppPublicationResult>;
  /** The executor calls the Automations panel makes, for one workspace. */
  automations(workspace: RegistryEntry): CliAutomationsPort;
  /** A window's press path, for one workspace. */
  buttons(workspace: RegistryEntry): CliButtonsPort;
  findWorkspace(workspaceId: string): RegistryEntry | null;
  listWorkspaces(): RegistryEntry[];
  openWorkspaceActivity(workspace: RegistryEntry): Promise<unknown>;
  activity: {
    engineCaptureFor(workspaceId: string): Pick<
      WorkspaceEngineCapture,
      | "fileObjectIdForPath" | "filePathForObjectId" | "listMoments" | "readMoment"
      | "listKeptCopies" | "saveKeptCopy" | "listRetainedCopies" | "deleteRetainedCopies"
      | "listVersions" | "compareVersions" | "listOpenConflictsPage" | "writeAuthoredFile"
      | "createVersion" | "switchVersion" | "mergeVersionIntoMain" | "resolveConflict"
      | "changePathsAs"
    > | null;
    queueCloudSync(workspaceId: string): void;
    agentRunDepth(workspaceId: string): number;
    dispatchedAgent(workspaceId: string): string | null;
    dispatchedRunId(workspaceId: string): string | null;
    agentRunWorkspace(runId: string): string | undefined;
  };
  linkedChatStoreFor(workspace: RegistryEntry): DesktopLinkedChatStore;
  currentDaemon(): Pick<EngineDaemonLifecycle, "requestWorkspace"> | null;
  agentDispatchStoreHandleFor(workspace: RegistryEntry): Pick<LiveAgentDispatchStoreHandle, "store">;
  sharedViewOf(workspaceId: string): unknown;
  withPhysicalWorkspaceOperation<Result>(
    workspaceId: string,
    work: (operation: WorkspaceAuthorityOperation<RegistryEntry, State>) => Result | Promise<Result>,
  ): Promise<Result>;
  collectionEditContextFor(
    operation: WorkspaceAuthorityOperation<RegistryEntry, State>,
    person: LocalPersonAuthor,
    signal: AbortSignal,
  ): Promise<CollectionRecordEditContext>;
  /** This computer's person, read when a write is requested. */
  localPerson(): Promise<LocalPersonAuthor>;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: VersionedLiveAdapter) => Promise<Result>,
  ): Promise<Result | null>;
  liveDocuments: LiveDocumentSessions;
  // The OS trash, and the editor sessions to tell when an agent deletes their file.
  trashItem(absolutePath: string): Promise<void>;
  markDeletedUnderPath(attachmentId: symbol, path: string): void;
  documentProjection: DocumentProjection;
  chatWrites: ChatWrites;
  startCliServer: typeof startCliServerImplementation;
  stateDir(): string;
  localUserDisplayName(): string;
  localPersonId(): string;
  notifyRenderer(input: { workspaceId: string }): void;
  notifyNoticesChanged(): void;
  /** Runs a version change after the windows showing the workspace save their open edits (versionRounds.ts). */
  versionRound: ReturnType<typeof createVersionRounds<unknown>>["run"];
  syncSharedChannelsForChatTarget(
    workspaceId: string,
    target?: ChatRelayIdentityTarget,
  ): Promise<unknown>;
  chatDispatchService: { scanWorkspace(workspaceId: string): Promise<unknown> };
  rememberPendingCliRunMessageLink(link: CliRunMessageLink, pending: boolean): void;
}

export function createDesktopCliServer<State>(
  dependencies: DesktopCliServerDependencies<State>,
) {
  const {
    findWorkspace,
    listWorkspaces,
    openWorkspaceActivity,
    activity,
    linkedChatStoreFor,
    currentDaemon,
    agentDispatchStoreHandleFor,
    sharedViewOf,
    withPhysicalWorkspaceOperation,
    collectionEditContextFor,
    localPerson,
    withEngineAdapter,
    liveDocuments,
    documentProjection,
    chatWrites,
    startCliServer,
    stateDir,
    localUserDisplayName,
    localPersonId,
    notifyRenderer,
    syncSharedChannelsForChatTarget,
    chatDispatchService,
    rememberPendingCliRunMessageLink,
  } = dependencies;

  // A lossy note's file text, or null for any other file. The check runs in
  // the projection worker, which remembers it by the text's SHA-256. A file
  // that isn't there has nothing on disk to rewrite; the edit's own check
  // covers its session. Any other failed or partial read refuses.
  async function lossyNoteText(rootPath: string, path: string): Promise<string | null> {
    let read: Awaited<ReturnType<typeof readWorkspaceText>>;
    try {
      read = await readWorkspaceText(rootPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      throw new Error(unreadNoteRefusal(path), { cause: error });
    }
    if (read.truncated) throw new Error(unreadNoteRefusal(path));
    const digest = createHash("sha256").update(read.text).digest("hex");
    return await documentProjection.run({ kind: "lossy", markdown: read.text, digest }) ? read.text : null;
  }

  // Agent-facing `dohc chat`: the socket authenticates locally, then MAIN
  // resolves the registry workspace, and chat writes go through the same
  // chatWrites module renderer sends use. The client can claim only the
  // behavior-bearing human/agent kind; it never supplies the user id or
  // display identity.
  async function openCliWorkspace(
    requested: CliRegistryWorkspace,
  ): Promise<CliWorkspaceContext> {
    const workspace = findWorkspace(requested.workspaceId);
    if (!workspace || resolve(workspace.rootPath) !== resolve(requested.rootPath)) {
      throw new Error("dohc: not inside a dohc workspace");
    }
    await openWorkspaceActivity(workspace);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      throw new Error(captureRefusal("Chats"));
    }
    const store = linkedChatStoreFor(workspace);
    const daemon = currentDaemon();
    if (!daemon) throw new Error("The workspace engine is not running.");
    // The CLI's collection writes ride the desktop's one collection write
    // seam, resolved per write under the physical workspace's authority, so a
    // retired-and-reattached workspace refuses instead of falling through to
    // its successor. A write ends with the CLI request that asked for it. Its
    // person is read when the request arrives, before it waits for the workspace.
    const cliCollectionEdit = async <T>(
      work: (context: CollectionRecordEditContext) => Promise<T>,
    ): Promise<T> => {
      const person = await localPerson();
      return await withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) =>
        await work(
          await collectionEditContextFor(
            operation,
            person,
            AbortSignal.any([
              operation.signal,
              AbortSignal.timeout(CLI_REQUEST_DEADLINE_MS),
            ]),
          ),
        ),
      );
    };
    const publicationAttachment = await withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
        if (resolve(operation.workspace.rootPath) !== resolve(workspace.rootPath)) throw new Error("This workspace changed while this ran. Try again.");
        return operation.signal;
      });
    // A move or delete holds the workspace operation fileWrite holds.
    const withPathChange = async <Result>(requestId: string, work: (
      operation: WorkspaceAuthorityOperation<RegistryEntry, State>, options: PathChangeOptions) => Promise<() => Promise<Result>>) => {
      const finish = await withPhysicalWorkspaceOperation(workspace.workspaceId, async operation => {
        operation.assertCurrent();
        if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
        if (sharedViewOf(workspace.workspaceId)) throw new Error("This workspace is read-only. Write in the owning workspace.");
        const current = activity.engineCaptureFor(workspace.workspaceId);
        if (!current) throw new Error("dohc could not start the engine for this workspace. Restart dohc to try again.");
        const attachmentId = operation.workspace.attachmentId;
        return work(operation, {
          capture: current, requestId, trashItem: dependencies.trashItem,
          linkRewrites: {workspaceId: workspace.workspaceId, signal: operation.signal,
            history: {rewriteHistoryLinks: input => operationHistory.rewriteHistoryLinks!(input)}},
          markDeleted: path => dependencies.markDeletedUnderPath(attachmentId, path),
        });
      });
      return finish();
    };
    // Save recovery copy, Try again and Stop again under the admission the
    // window's IPC uses: this attachment, the original workspace, and main's
    // own record of the kept edits, found by path. The caller names nothing else.
    const ownerLiveRecovery = dependencies.ownerLiveRecovery;
    const withOwnerLiveRecovery = <Result>(work: (operation: WorkspaceAuthorityOperation<RegistryEntry, State>) => Promise<Result>) =>
      withPhysicalWorkspaceOperation(workspace.workspaceId, async operation => {
        operation.assertCurrent();
        if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
        assertOriginalWorkspace(operation.workspace);
        const result = await work(operation);
        operation.assertCurrent();
        return result;
      });
    const keptEditsAt = (workspaceId: string, path: string, incident: string) => {
      const kept = ownerLiveRecovery?.keptEdits(workspaceId).find(row => row.path === path && row.incident === incident);
      if (!kept) throw new Error(`dohc has no kept edits for ${path}. List kept edits again to check it.`);
      return kept;
    };
    const operationHistory = createOperationHistory(work => withEngineAdapter(workspace, work));
    const withHistoryOperation = <T>(work: (operation: WorkspaceAuthorityOperation<RegistryEntry, State>) => Promise<T>) =>
      withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
        operation.assertCurrent();
        if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
        return work(operation);
      });
    return {
      workspaceId: workspace.workspaceId,
      historyOperation: input => withHistoryOperation(operation => readWorkspaceHistoryOperation(operation, input, operationHistory, {agent: true})),
      historyUndo: (input, origin) => withHistoryOperation(operation => undoWorkspaceHistoryOperation(operation, input, agentWriteAuthor(origin), { history: operationHistory, agent: true })),
      ...(dependencies.stopWorkspaceSync ? { stopSync: author =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
          return dependencies.stopWorkspaceSync!(operation, author);
        }) } : {}),
      ...(dependencies.shareCopy ? { shareCopy: (input: import("@dohc/workspace-contracts/share-copy").ShareCopyInput) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
          return dependencies.shareCopy!(operation, input);
        }) } : {}),
      ...(dependencies.access ? { access: dependencies.access(workspace.workspaceId) } : {}),
      ...(dependencies.dataset ? { dataset: (request: import("@dohc/cli/dataset").DatasetRequest, agent: LocalDatasetAgent | null) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (request.workspaceId !== workspace.workspaceId || operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
          if (request.action === "prepareRecovery" && !request.sourcePath) throw new Error("Collection recovery requires an explicit sourcePath.");
          return dependencies.dataset!(request, agent);
        }) } : {}),
      ...(dependencies.ownerAppResponses ? {ownerAppResponses:(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest)=>
        withPhysicalWorkspaceOperation(workspace.workspaceId,operation=>{
          if(request.workspaceId!==workspace.workspaceId || operation.signal!==publicationAttachment || publicationAttachment.aborted)throw new Error("This workspace changed while this ran. Try again.");
          return dependencies.ownerAppResponses!(request);
        })}:{}),
      ...(dependencies.ownerAppPublication ? { appPublication: (request: OwnerAppPublicationRequest, agent: import("@dohc/security-contract/approval-provenance").ApprovalAgent | null = null) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (request.workspaceId !== workspace.workspaceId || operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
          return dependencies.ownerAppPublication!(request, agent);
        }) } : {}),
      rootPath: workspace.rootPath,
      automations: dependencies.automations(workspace),
      buttons: dependencies.buttons(workspace),
      store,
      dispatchStore: agentDispatchStoreHandleFor(workspace).store,
      readOnly: Boolean(sharedViewOf(workspace.workspaceId)),
      fileObjectIdForPath: (path) => capture.fileObjectIdForPath(path),
      daemonReads: {
        async queryChatMessagesGranular(input: { query: string; limit: number }) {
          return decodeWorkspaceResult(
            WORKSPACE_METHOD.searchQueryChatMessagesGranular,
            await daemon.requestWorkspace(
              workspace.rootPath,
              workspace.workspaceId,
              WORKSPACE_METHOD.searchQueryChatMessagesGranular,
              input,
            ),
          );
        },
        async listUnreadFileThreads(input: {
          pageLimit: number;
          afterThreadId?: string;
        }) {
          return decodeChatsResult(
            CHATS_METHOD.readStateListUnreadFileThreads,
            await daemon.requestWorkspace(
              workspace.rootPath,
              workspace.workspaceId,
              CHATS_METHOD.readStateListUnreadFileThreads,
              input,
            ),
          );
        },
        async collectionsWaiting() {
          const waiting = await withEngineAdapter(workspace, async (adapter) => await adapter.collectionsWaiting());
          if (waiting === null) throw new Error("The workspace engine is not running.");
          return waiting;
        },
      },
      // Engine-backed collection reads and writes for the CLI/MCP verbs.
      // withEngineAdapter derives the attachment (and share-view session mode)
      // from the registered workspace itself — the renderer collection routes'
      // authority, reached from main's side. The CLI resolved this workspace
      // by cwd above, so it already holds the registered entry. Writes go
      // through the desktop's one collection write seam.
      collections: {
        writes: {
          setFields: (input) =>
            cliCollectionEdit((context) => setCollectionRecordFields(context, input)),
          createRecord: (input) =>
            runCollectionRecordCreation(cliCollectionEdit, input),
        },
        query: async (params) => {
          const result = await withEngineAdapter(
            workspace,
            async (adapter) => await adapter.queryCollectionRecords(params),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          return result;
        },
        getRecord: async (params) => {
          const result = await withEngineAdapter(
            workspace,
            async (adapter) =>
              await adapter.getCollectionRecord({
                collectionPath: params.collectionPath,
                recordId: params.recordId,
                historyLimit: params.historyLimit,
                ...(params.beforeHistoryId !== undefined
                  ? { beforeHistoryId: params.beforeHistoryId }
                  : {}),
              }),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          return result;
        },
      },
      writeFiles: (files, origin, requestId) => withPhysicalWorkspaceOperation(workspace.workspaceId, async operation => {
        operation.assertCurrent();
        if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("This workspace changed while this ran. Try again.");
        if (sharedViewOf(workspace.workspaceId)) throw new Error("This workspace is read-only. Write in the owning workspace.");
        const current = activity.engineCaptureFor(workspace.workspaceId);
        if (!current) throw new Error("dohc could not start the engine for this workspace. Restart dohc to try again.");
        return writeWorkspaceFilesAs(operation, files, agentWriteAuthor(origin), { capture: current, requestId });
      }),
      duplicateFile: (path, origin, requestId) => withPathChange(requestId, async (operation, options) => {
        const copied = await duplicateWorkspaceFile(operation, path, agentWriteAuthor(origin), options.capture);
        return async () => ({ok: true as const, ...copied});
      }),
      movePath: (input, origin, requestId) => withPathChange(requestId, (operation, options) =>
        prepareMoveWorkspacePathAs(operation, input, agentWriteAuthor(origin), options)),
      deletePath: async (path, origin, requestId) => {
        const result = await withPathChange(requestId, (operation, options) =>
          prepareDeleteWorkspacePathAs(operation, path, agentWriteAuthor(origin), options));
        return result;
      },
      // Document reads and edits go through the desktop's live document
      // sessions, the ones its editor holds, so an agent's edit merges into
      // an open editor instead of racing it on disk.
      documents: {
        read: async (path) => {
          const live = await liveDocuments.readDocument({ workspaceId: workspace.workspaceId, path });
          // A lossy note reads as its file, not as the editor's canonical
          // Markdown, which leaves out the parts dohc can't show.
          const file = await lossyNoteText(workspace.rootPath, live.path);
          if (file !== null) return { path: live.path, markdown: file };
          const markdown = live.state
            ? await documentProjection.run({ kind: "read", state: live.state })
            : await documentProjection.run({
                kind: "read-settled",
                markdown: await settledMarkdown(workspace.rootPath, live.path),
              });
          return { path: live.path, markdown };
        },
        edit: ({ path, edit, origin, allowLossySourceSha256 }) =>
          liveDocuments.editDocument({
            ...(allowLossySourceSha256 ? { allowLossySourceSha256 } : {}),
            workspaceId: workspace.workspaceId,
            path,
            origin,
            assertEditable: async (resolved) => {
              const source = await lossyNoteText(workspace.rootPath, resolved);
              if (source !== null && createHash("sha256").update(source).digest("hex") !== allowLossySourceSha256) {
                throw new Error(lossyNoteRefusal(resolved));
              }
            },
            change: (state, { keepBlocks, headSha256 }) =>
              documentProjection.run({ kind: "edit", state, edit, keepBlocks, headSha256,
                ...(allowLossySourceSha256 ? {} : { refuseLossy: path }) }),
          }),
        create: async ({ path, markdown, origin }) => {
          // Frontmatter would land as body blocks, so it is refused before
          // anything exists.
          if (startsWithFrontmatter(markdown)) throw new Error(FRONTMATTER_REFUSAL);
          // An empty file written on the capture chain, which refuses a path
          // that exists and records the agent as the file's author, and then
          // the text through the new file's live session, like typing into it.
          await withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) => {
            operation.assertCurrent();
            if (sharedViewOf(workspace.workspaceId)) {
              throw new Error("A shared view cannot create documents.");
            }
            const current = activity.engineCaptureFor(workspace.workspaceId);
            if (!current) throw new Error("dohc could not start the engine for this workspace, so it cannot create documents. Restart dohc to try again.");
            const absolute = join(operation.workspace.rootPath, path);
            try {
              requirePublishedWrite(path, await current.writeAuthoredFile(absolute, "", agentWriteAuthor(origin), { createOnly: true }));
            } catch (error) {
              if (error instanceof VersionedTextStoreError && error.code === "target-path-exists") {
                throw new Error(`${path} already exists. Edit it instead.`, { cause: error });
              }
              throw error;
            }
          });
          try {
            await liveDocuments.editDocument({
              workspaceId: workspace.workspaceId,
              path,
              origin,
              // This verb wrote the file empty just above.
              assertEditable: async () => undefined,
              change: (state, { keepBlocks }) =>
                documentProjection.run({ kind: "create", state, markdown, keepBlocks }),
            });
          } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            throw new Error(
              `dohc created ${path}, but could not write its text (${cause}). Edit the document to add it.`,
              { cause: error },
            );
          }
          return { path };
        },
      },
      ...(sharedViewOf(workspace.workspaceId)
        ? {}
        : {
            versions: {
              list: async () => {
                const snapshot = await capture.listVersions();
                return { versions: snapshot.versions.map(workspaceVersionForIpc), activeVersionId: snapshot.activeVersionId };
              },
              compare: async (versionId, afterPath) => {
                // Unreadable rules hide every file, as the desktop's History does.
                const policy = await readWorkspaceEnginePolicy(workspace.rootPath);
                if (policy.errors.length) return { status: "policy-unreadable", unreadable: policy.unreadable };
                const admitted = historyPathAdmission(policy);
                // A page continues after its last path, which can be a hidden
                // file. Continue after the last shown file instead, and read
                // past pages that show none.
                let after = afterPath;
                for (;;) {
                  const page = await capture.compareVersions(versionId, after === undefined ? {} : { afterPath: after });
                  const files = page.files
                    .filter(file => !file.protected && admitted(file.path))
                    .map(({ protected: _protected, ...file }) => file);
                  if (page.nextAfterPath === null) return { files, nextAfterPath: null };
                  if (files.length > 0) return { files, nextAfterPath: files[files.length - 1]!.path };
                  after = page.nextAfterPath;
                }
              },
              conflicts: async (afterConflictId) => {
                const policy = await readWorkspaceEnginePolicy(workspace.rootPath);
                if (policy.errors.length) return { status: "policy-unreadable", unreadable: policy.unreadable };
                const page = await capture.listOpenConflictsPage(afterConflictId);
                const admitted = historyPathAdmission(policy);
                // After a rename, a side can sit at another path than its conflict.
                const shown = (conflict: (typeof page.conflicts)[number]) =>
                  [conflict.path, conflict.base.path, conflict.current.path, conflict.incoming.path].every(path => admitted(path));
                return {
                  conflicts: page.conflicts.filter(shown).map(versionConflictForIpc),
                  nextAfterConflictId: page.nextAfterConflictId,
                };
              },
              // Each change tells the windows what changed, as the versions
              // IPC handlers do for the window's own changes. Each closes the
              // editors' documents before it can fail, so a failed change
              // still has the windows reopen on whichever version is active.
              create: name => dependencies.versionRound(workspace.workspaceId, async () => {
                const snapshot = await capture.createVersion(name);
                notifyRenderer({ workspaceId: workspace.workspaceId });
                const created = snapshot.versions.find(version => version.id === snapshot.activeVersionId)!;
                return { id: created.id, name: created.name };
              }, { done: created => ({ activeVersionId: created.id }), failed: {} }),
              switch: versionId => dependencies.versionRound(workspace.workspaceId, async () => {
                const switched = await capture.switchVersion(versionId);
                notifyRenderer({ workspaceId: workspace.workspaceId });
                return switched;
              }, { done: switched => ({ activeVersionId: switched.activeVersionId }), failed: {} }),
              merge: versionId => dependencies.versionRound(workspace.workspaceId, async () => {
                const merged = await capture.mergeVersionIntoMain(versionId);
                notifyRenderer({ workspaceId: workspace.workspaceId });
                return merged;
              }, { done: () => ({}), failed: {} }),
              resolve: (conflictId, resolution) => dependencies.versionRound(workspace.workspaceId, async () => {
                await capture.resolveConflict(conflictId, resolution.keep === "combined" ? { kind: "apply-merged", text: resolution.text }
                  : resolution.keep === "current" ? { kind: "keep-current" } : { kind: "apply-incoming" });
                // As the window's resolve does: the other computer hears of it
                // promptly, and Notices drops a resolved sync conflict.
                activity.queueCloudSync(workspace.workspaceId);
                notifyRenderer({ workspaceId: workspace.workspaceId });
                dependencies.notifyNoticesChanged();
              }, { done: () => ({}), failed: {} }),
            },
            keptCopies: {
              list: () => capture.listKeptCopies(),
              save: (id: number) => capture.saveKeptCopy(id),
            },
            retainedCopies: {
              list: () => capture.listRetainedCopies(),
              delete: (copies) => capture.deleteRetainedCopies(copies),
            },
            ...(ownerLiveRecovery ? {
              keptEdits: {
                list: () => withOwnerLiveRecovery(async operation =>
                  ownerLiveRecovery.keptEdits(operation.workspace.workspaceId).map(({ path, reason, storedOn, incident, recovery, earlier, saveOnly }) =>
                    ({ path, reason, storedOn, incident, recovery, ...(earlier ? { earlier } : {}), ...(saveOnly ? { saveOnly } : {}) }))),
                saveRecoveryCopy: (path: string, incident?: string) => withOwnerLiveRecovery(operation => ownerLiveRecovery.save(operation.workspace, path, incident)),
                retry: (path: string, incident: string) => withOwnerLiveRecovery(async operation => {
                  const kept = keptEditsAt(operation.workspace.workspaceId, path, incident);
                  if (kept.saveOnly && kept.recovery !== "unreadable") throw new Error("These edits were kept after a restore and cannot be sent again. Save a recovery copy using this path and incident.");
                  await ownerLiveRecovery.retry(operation.workspace, kept.objectId, incident);
                }),
                // Only a Stop that kept the edits runs again; any other Stop belongs to Live documents.
                stopAgain: (path: string, incident: string) => withOwnerLiveRecovery(async operation => {
                  const kept = keptEditsAt(operation.workspace.workspaceId, path, incident);
                  if (kept.recovery !== "not-written" && kept.recovery !== "stopping") {
                    throw new Error(`No Stop of ${path} is waiting to run again. List kept edits again to check it.`);
                  }
                  return await ownerLiveRecovery.stopAgain(operation, { path, objectId: kept.objectId, recovery: kept.recovery });
                }),
              },
            } : {}),
          }),
      filePathForObjectId: (objectId) => capture.filePathForObjectId(objectId),
      listMoments: async ({ limit, objectId }) => {
        // Unreadable rules hide every change, as the desktop's History does.
        const policy = await readWorkspaceEnginePolicy(workspace.rootPath);
        if (policy.errors.length) return { status: "policy-unreadable", unreadable: policy.unreadable };
        const page = await capture.listMoments({ limit, ...(objectId ? { objectId } : {}) });
        const admitted = historyPathAdmission(policy);
        return page.moments
          .filter(
            (moment): moment is typeof moment & { objectId: string; protected: false } =>
              !moment.protected && Boolean(moment.objectId) && admitted(moment.path),
          )
          .map((moment) => ({
            id: moment.id,
            workspaceId: workspace.workspaceId,
            versionId: moment.versionId,
            objectId: moment.objectId,
            path: moment.path,
            recordedAtMs: moment.recordedAtMs,
            operation: moment.operation,
            ...(moment.contentKind ? { contentKind: moment.contentKind } : {}),
            ...(moment.byteLength !== undefined
              ? { byteLength: moment.byteLength }
              : {}),
            metadata: moment.metadata,
            ...(moment.authors ? { authors: moment.authors } : {}),
            momentOrder: moment.momentOrder,
          }));
      },
      readMoment: async (momentId) => {
        // Unreadable rules hide every change, as the desktop's History does,
        // so the answer says nothing about this change.
        const policy = await readWorkspaceEnginePolicy(workspace.rootPath);
        if (policy.errors.length) return { status: "policy-unreadable", unreadable: policy.unreadable };
        const detail = await capture.readMoment(momentId);
        if (!detail || detail.protected) return null;
        const { moment } = detail;
        // History reads come from the active version, as the list does.
        if (moment.versionId !== (await capture.listVersions()).activeVersionId) return null;
        return historyMomentPathsAdmitted(historyPathAdmission(policy), moment) ? moment : { status: "untracked" };
      },
    };
  }

  const readLinks = <T>(requested: CliRegistryWorkspace, run: (workspace: RegistryEntry) => Promise<T>) =>
    withPhysicalWorkspaceOperation(requested.workspaceId, operation => {
      if (resolve(operation.workspace.rootPath) !== resolve(requested.rootPath)) throw new Error("The workspace attachment changed.");
      return run(operation.workspace);
    });

  async function startDesktopCliServer(): Promise<CliServerHandle> {
    return startCliServer({
      recordSuccess: dependencies.recordSuccess,
      serverAccount: dependencies.serverAccount,
      stateDir: stateDir(),
      listWorkspaces: () =>
        listWorkspaces()
          .map(({ workspaceId, rootPath }) => ({
            workspaceId,
            rootPath,
            readOnly: Boolean(sharedViewOf(workspaceId)),
          })),
      openWorkspace: openCliWorkspace,
      chatLinks: (workspace,input) => readLinks(workspace,current=>dependencies.chatLinks(current,input)),
      chatFileMentions: (workspace, input) => readLinks(workspace, current => dependencies.chatFileMentions(current, input)),
      links: {
        edges: (workspace, input) => readLinks(workspace, current => dependencies.links.edges(current, input)),
        incoming: (workspace, input) => readLinks(workspace, current => dependencies.links.incoming(current, input)),
        resolve: (workspace, input) => readLinks(workspace, current => dependencies.links.resolve(current, input)),
      },
      chatWrites,
      localUserDisplayName,
      localPersonId,
      agentRunDepth: (workspaceId) => activity.agentRunDepth(workspaceId),
      dispatchedAgent: (workspaceId) => activity.dispatchedAgent(workspaceId),
      dispatchedRunId: (workspaceId) => activity.dispatchedRunId(workspaceId),
      agentRunWorkspace: (runId) => activity.agentRunWorkspace(runId),
      // The renderer did not make this change, so its windows hear about it
      // here. Some CLI writes, such as provisioning General, skip chatWrites,
      // so this queues cloud sync too. The sync engine debounces a second
      // queue after a chatWrites write into one pass.
      onWrite: (workspace) => {
        notifyRenderer({ workspaceId: workspace.workspaceId });
        activity.queueCloudSync(workspace.workspaceId);
      },
      // No renderer poll runs the sync pass on the CLI's or MCP's behalf:
      // Await (bounded — see cliServer.ts's CHAT_READ_SYNC_BUDGET_MS) the same
      // pass syncDms already names a target for, so the read's own channel is
      // covered past the pass's row bound. Never throws — offline, it returns
      // fast and the local rows answer.
      onRead: async (workspace, target) => {
        await syncSharedChannelsForChatTarget(workspace.workspaceId, target);
      },
      onRunMessageLinkPending: (link) => {
        rememberPendingCliRunMessageLink(link, true);
      },
      onRunMessageLinkSettled: (link) => {
        rememberPendingCliRunMessageLink(link, false);
        void chatDispatchService.scanWorkspace(link.workspaceId).catch((error) => {
          console.error("[desktop] CLI provenance recovery scan:", error);
        });
      },
      onRunMessageLinkAbandoned: (link) => {
        rememberPendingCliRunMessageLink(link, false);
      },
      onError: (error) => {
        console.error("[desktop] CLI server:", error);
      },
      onDebug: (message) => {
        console.debug(`[desktop] CLI server: ${message}`);
      },
    });
  }

  return { openCliWorkspace, startDesktopCliServer };
}
