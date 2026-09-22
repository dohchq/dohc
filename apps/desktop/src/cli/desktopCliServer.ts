import { readCachedUserSettingsFile } from "../settings/userSettingsStore";
import { resolve } from "node:path";
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
import type {
  CliRegistryWorkspace,
  CliRunMessageLink,
  CliServerHandle,
  CliWorkspaceContext,
  startCliServer as startCliServerImplementation,
} from "./cliServer";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { WorkspaceAuthorityOperation } from "../workspaces/workspaceAuthorityOwner";
import { captureRefusal } from "../workspaces/engineCaptureGate";
import {
  createCollectionRecord,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "../workspaces/collectionRecordEdits";
import { assertSharedChannelWritable } from "../workspaces/sharedChannels";
import {
  assertSharedChannelMessageIdentity,
  resolveWorkspaceRelayAuthorId,
  type ChatRelayIdentityTarget,
  type ResolvedChatRelayIdentity,
} from "../workspaces/chatRelayIdentity";

interface DesktopCliServerDependencies<State> {
  appBackend?(request: import("@dohc/cli/app-backend").OwnerAppBackendRequest): Promise<import("@dohc/cli/app-backend").OwnerAppBackendResult>;
  dataset?(request: import("@dohc/cli/dataset").DatasetRequest): Promise<import("@dohc/cli/dataset").DatasetResult>;
  ownerAppResponses?(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest):Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>;
  ownerAppPublication?(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult>;
  findWorkspace(workspaceId: string): RegistryEntry | null;
  listWorkspaces(): RegistryEntry[];
  openWorkspaceActivity(workspace: RegistryEntry): Promise<unknown>;
  activity: {
    engineCaptureFor(workspaceId: string): Pick<
      WorkspaceEngineCapture,
      "fileObjectIdForPath" | "filePathForObjectId" | "listMoments" | "readMoment"
    > | null;
    queueCloudSync(workspaceId: string): void;
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
  ): Promise<CollectionRecordEditContext>;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: VersionedLiveAdapter) => Promise<Result>,
  ): Promise<Result | null>;
  assertWritableWorkspace(workspace: RegistryEntry): void;
  chatRelayIdentityFor(
    workspaceId: string,
    target: ChatRelayIdentityTarget,
    store: DesktopLinkedChatStore,
  ): Promise<ResolvedChatRelayIdentity>;
  currentCredentials(): CloudCredentials | null;
  startCliServer: typeof startCliServerImplementation;
  stateDir(): string;
  warmCredentialCache(): Promise<unknown>;
  localUserDisplayName(): string;
  localReactorFallbackId(): string;
  notifyRenderer(input: { workspaceId: string }): void;
  queueChatBookmarkProjection(workspaceId: string): void;
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
    assertWritableWorkspace,
    chatRelayIdentityFor,
    currentCredentials,
    startCliServer,
    stateDir,
    warmCredentialCache,
    localUserDisplayName,
    localReactorFallbackId,
    notifyRenderer,
    queueChatBookmarkProjection,
    syncSharedChannelsForChatTarget,
    chatDispatchService,
    rememberPendingCliRunMessageLink,
  } = dependencies;

  // Agent-facing `dohc chat`: the socket authenticates locally, then MAIN
  // resolves the registry workspace and derives identity exactly like renderer
  // chat sends. The client can claim only the behavior-bearing human/agent kind;
  // it never supplies the user id or display identity.
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
    // The CLI's collection writes ride the same seam plugin SDK edits take,
    // resolved per write under the physical workspace's authority, so a
    // retired-and-reattached workspace refuses instead of falling through to
    // its successor.
    const cliCollectionEdit = <T>(
      work: (context: CollectionRecordEditContext) => Promise<T>,
    ): Promise<T> =>
      withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) =>
        await work(await collectionEditContextFor(operation)),
      );
    const publicationAttachment = await withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
        if (resolve(operation.workspace.rootPath) !== resolve(workspace.rootPath)) throw new Error("The workspace attachment changed.");
        return operation.signal;
      });
    return {
      workspaceId: workspace.workspaceId,
      ...(dependencies.appBackend ? { appBackend: (request: import("@dohc/cli/app-backend").OwnerAppBackendRequest) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (request.workspaceId !== workspace.workspaceId || operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("The app workspace attachment changed.");
          return dependencies.appBackend!(request);
        }) } : {}),
      ...(dependencies.dataset ? { dataset: (request: import("@dohc/cli/dataset").DatasetRequest) =>
        withPhysicalWorkspaceOperation(workspace.workspaceId, operation => {
          if (request.workspaceId !== workspace.workspaceId || operation.signal !== publicationAttachment || publicationAttachment.aborted) throw new Error("The Collection workspace attachment changed.");
          return dependencies.dataset!(request);
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
      // authority, reached from main's side. The plugin SDK's owned read port
      // wraps the same call in receivedShareEngine.workspaceForRegistered; the
      // CLI resolved this workspace by cwd above, so it already holds the
      // registered entry that wrapper would look up. Writes go through the
      // desktop's one collection write seam, the same path plugin SDK edits
      // take.
      collections: {
        writes: {
          setFields: (input) =>
            cliCollectionEdit((context) => setCollectionRecordFields(context, input)),
          createRecord: (input) =>
            cliCollectionEdit((context) => createCollectionRecord(context, input)),
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
      filePathForObjectId: (objectId) => capture.filePathForObjectId(objectId),
      listMoments: async ({ limit }) => {
        const page = await capture.listMoments({ limit });
        return page.moments
          .filter(
            (moment): moment is typeof moment & { objectId: string; protected: false } =>
              !moment.protected && Boolean(moment.objectId),
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
        return detail && !detail.protected ? detail.moment : null;
      },
      assertWritable: async (target) => {
        assertWritableWorkspace(workspace);
        await assertSharedChannelWritable({
          workspaceId: workspace.workspaceId,
          sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
          store,
          target,
        });
      },
      assertMessageWritable: async (target, authorUserId) => {
        const identity = await chatRelayIdentityFor(
          workspace.workspaceId,
          target,
          store,
        );
        assertSharedChannelMessageIdentity({
          joinedChannel: identity.joinedChannel,
          credentials: currentCredentials(),
          authorUserId,
          resolvedAuthorUserId: identity.authorUserId,
        });
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
      identity: async (workspaceId, target) => {
        await warmCredentialCache();
        const workspace = findWorkspace(workspaceId);
        const authorUserId = workspace
          ? target
            ? (
                await chatRelayIdentityFor(
                  workspaceId,
                  target,
                  linkedChatStoreFor(workspace),
                )
              ).authorUserId
            : resolveWorkspaceRelayAuthorId(workspace, currentCredentials())
          : undefined;
        return {
          displayName: localUserDisplayName(),
          agentName: (await readCachedUserSettingsFile(stateDir())).settings.profile.agentName ?? "Agent",
          ...(authorUserId ? { authorUserId } : {}),
          reactionAuthorId: localReactorFallbackId(),
        };
      },
      onWrite: (workspace, target) => {
        notifyRenderer({ workspaceId: workspace.workspaceId });
        // A CLI or MCP reply can mark a live bookmark projection pending.
        queueChatBookmarkProjection(workspace.workspaceId);
        activity.queueCloudSync(workspace.workspaceId);
        void syncSharedChannelsForChatTarget(workspace.workspaceId, target).catch((error) => {
          console.error("[desktop] shared channel sync:", error);
        });
        void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
          console.error("[desktop] CLI dispatch scan:", error);
        });
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
