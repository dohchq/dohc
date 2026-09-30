import { writeWorkspaceFilesAs } from "../workspaces/workspaceFileWrites";
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
  type CliWorkspaceContext,
  type startCliServer as startCliServerImplementation,
} from "./cliServer";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";
import { requirePublishedWrite, type WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { LocalDatasetAgent } from "../workspaces/localDatasetHost";
import type { WorkspaceAuthorityOperation } from "../workspaces/workspaceAuthorityOwner";
import { captureRefusal } from "../workspaces/engineCaptureGate";
import {
  runCollectionRecordCreation,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "@dohc/automation-executor/collection-record-edits";
import type { ChatRelayIdentityTarget } from "../workspaces/chatRelayIdentity";
import type { ChatWrites } from "../workspaces/chatWrites";
import type { LiveDocumentEditOrigin, LiveDocumentSessions } from "../workspaces/engineYDocSessionIpc";
import { readWorkspaceText } from "../workspaces/workspaceAssets";
import { historyPathAdmission, readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";
import type { DocumentProjection } from "../workspaces/documentProjection";
import { FRONTMATTER_REFUSAL, startsWithFrontmatter } from "@dohc/ydoc-projection";
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
  dataset?(request: import("@dohc/cli/dataset").DatasetRequest, agent: LocalDatasetAgent | null): Promise<import("@dohc/cli/dataset").DatasetResult>;
  ownerAppResponses?(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest):Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>;
  ownerAppPublication?(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult>;
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
      | "listKeptCopies" | "saveKeptCopy"
      | "listVersions" | "writeAuthoredFile"
    > | null;
    queueCloudSync(workspaceId: string): void;
    agentRunDepth(workspaceId: string): number;
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
    signal: AbortSignal,
  ): Promise<CollectionRecordEditContext>;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: VersionedLiveAdapter) => Promise<Result>,
  ): Promise<Result | null>;
  liveDocuments: LiveDocumentSessions;
  documentProjection: DocumentProjection;
  chatWrites: ChatWrites;
  startCliServer: typeof startCliServerImplementation;
  stateDir(): string;
  localUserDisplayName(): string;
  localPersonId(): string;
  notifyRenderer(input: { workspaceId: string }): void;
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
    // its successor. A write ends with the CLI request that asked for it.
    const cliCollectionEdit = <T>(
      work: (context: CollectionRecordEditContext) => Promise<T>,
    ): Promise<T> =>
      withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) =>
        await work(
          await collectionEditContextFor(
            operation,
            AbortSignal.any([
              operation.signal,
              AbortSignal.timeout(CLI_REQUEST_DEADLINE_MS),
            ]),
          ),
        ),
      );
    const publicationAttachment = await withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
        if (resolve(operation.workspace.rootPath) !== resolve(workspace.rootPath)) throw new Error("The workspace attachment changed.");
        return operation.signal;
      });
    return {
      workspaceId: workspace.workspaceId,
      ...(dependencies.dataset ? { dataset: (request: import("@dohc/cli/dataset").DatasetRequest, agent: LocalDatasetAgent | null) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (request.workspaceId !== workspace.workspaceId || operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("The Collection workspace attachment changed.");
          if (request.action === "prepareRecovery" && !request.sourcePath) throw new Error("Collection recovery requires an explicit sourcePath.");
          return dependencies.dataset!(request, agent);
        }) } : {}),
      ...(dependencies.ownerAppResponses ? {ownerAppResponses:(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest)=>
        withPhysicalWorkspaceOperation(workspace.workspaceId,operation=>{
          if(request.workspaceId!==workspace.workspaceId || operation.signal!==publicationAttachment || publicationAttachment.aborted)throw new Error("The response workspace attachment changed.");
          return dependencies.ownerAppResponses!(request);
        })}:{}),
      ...(dependencies.ownerAppPublication ? { appPublication: (request: OwnerAppPublicationRequest) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (request.workspaceId !== workspace.workspaceId || operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("The app publication workspace attachment changed.");
          return dependencies.ownerAppPublication!(request);
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
        if (operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("The workspace attachment changed.");
        if (sharedViewOf(workspace.workspaceId)) throw new Error("This workspace is read-only. Write in the owning workspace.");
        const current = activity.engineCaptureFor(workspace.workspaceId);
        if (!current) throw new Error("dohc could not start the engine for this workspace. Restart dohc to try again.");
        return writeWorkspaceFilesAs(operation, files, agentWriteAuthor(origin), { capture: current, requestId });
      }),
      // Document reads and edits go through the desktop's live document
      // sessions, the ones its editor holds, so an agent's edit merges into
      // an open editor instead of racing it on disk.
      documents: {
        read: async (path) => {
          const live = await liveDocuments.readDocument({ workspaceId: workspace.workspaceId, path });
          const markdown = live.state
            ? await documentProjection.run({ kind: "read", state: live.state })
            : await documentProjection.run({
                kind: "read-settled",
                markdown: await settledMarkdown(workspace.rootPath, live.path),
              });
          return { path: live.path, markdown };
        },
        edit: ({ path, edit, origin }) =>
          liveDocuments.editDocument({
            workspaceId: workspace.workspaceId,
            path,
            origin,
            change: (state, { keepBlocks }) =>
              documentProjection.run({ kind: "edit", state, edit, keepBlocks }),
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
            keptCopies: {
              list: () => capture.listKeptCopies(),
              save: (id: number) => capture.saveKeptCopy(id),
            },
          }),
      filePathForObjectId: (objectId) => capture.filePathForObjectId(objectId),
      listMoments: async ({ limit, objectId }) => {
        const page = await capture.listMoments({ limit, ...(objectId ? { objectId } : {}) });
        const admitted = historyPathAdmission(await readWorkspaceEnginePolicy(workspace.rootPath));
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
            ...(moment.author ? { author: moment.author } : {}),
            momentOrder: moment.momentOrder,
          }));
      },
      readMoment: async (momentId) => {
        const detail = await capture.readMoment(momentId);
        if (!detail || detail.protected) return null;
        const { moment } = detail;
        // History reads come from the active version, as the list does.
        if (moment.versionId !== (await capture.listVersions()).activeVersionId) return null;
        const admitted = historyPathAdmission(await readWorkspaceEnginePolicy(workspace.rootPath));
        const paths = [moment.path, moment.payload.after.path, ...(moment.payload.before ? [moment.payload.before.path] : [])];
        return paths.every(admitted) ? moment : null;
      },
    };
  }

  async function startDesktopCliServer(): Promise<CliServerHandle> {
    return startCliServer({
      stateDir: stateDir(),
      listWorkspaces: () =>
        listWorkspaces()
          .map(({ workspaceId, rootPath }) => ({
            workspaceId,
            rootPath,
            readOnly: Boolean(sharedViewOf(workspaceId)),
          })),
      openWorkspace: openCliWorkspace,
      chatWrites,
      localUserDisplayName,
      localPersonId,
      agentRunDepth: (workspaceId) => activity.agentRunDepth(workspaceId),
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
