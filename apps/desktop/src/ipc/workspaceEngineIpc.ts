import type { VersionedTextMomentSummary } from "@dohc/workspace-contracts/engine";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineWorkspace, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  ListCollectionsPayload, ListCollectionsResult, GetCollectionPayload, GetCollectionResult,
  QueryCollectionRecordsPayload, QueryCollectionRecordsResult, ListEngineMomentsPayload,
  ReadEngineMomentPayload, ReadEngineMomentResult, RestoreEngineMomentFilePayload,
  RestoreEngineMomentFileResult, WorkspaceIdPayload, SyncStatusResult,
  RebuildEngineStorePayload, RebuildEngineStoreResult, engineStoreRefusalRecovery,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { engineMomentDetailForIpc, listEngineMomentsForIpc } from "./engineHistoryIpc";
import { rebuildEngineStoreRequest, type moveEngineStoreAside } from "../workspaces/engineStoreRebuild";
import { runInWorkspaceAuthorityLane } from "../workspaces/workspaceAuthorityLane";
import type { WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { WorkspaceEngineCapture, probeEngineStoreRefusal } from "../workspaces/workspaceEngineCapture";
import type { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type { createEngineYDocSessionIpc, EngineYDocIpcSender } from "../workspaces/engineYDocSessionIpc";

type EngineStoreAuthorityState = {
  operationLanes: Map<string, Promise<void>>;
  lastEngineStoreRebuildResult: RebuildEngineStoreResult | null;
};

export function createWorkspaceEngineIpc<
  Sender extends EngineYDocIpcSender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry,
  State extends EngineStoreAuthorityState,
  Operation extends { workspace: Workspace & { attachmentId: symbol } },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: any) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, retiredMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  receivedShareEngine: Pick<ReturnType<typeof createReceivedShareEngineAccess>, "workspaceForRegistered">;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: Pick<VersionedLiveAdapter, "listCollections" | "getCollection" | "queryCollectionRecords">) => Promise<Result>,
  ): Promise<Result | null>;
  requireEngineCapture(workspaceId: string, feature: "Engine history"): Promise<{
    capture: Pick<WorkspaceEngineCapture, "listMoments" | "readMoment" | "restoreFileToBeforeMoment">;
  }>;
  localAgentDisplayName(): string;
  notifyRenderer(target: { workspaceId: string }): void;
  requireWorkspace(workspaceId: string): Workspace;
  assertWritableWorkspace(workspace: Workspace): void;
  syncStatusWithOwnedProjection(workspace: Workspace, status: SyncStatusResult): Promise<SyncStatusResult>;
  activity: {
    getStatus(workspaceId: string): SyncStatusResult;
    hasAgentRun(workspaceId: string, rootPath: string): boolean;
  };
  workspaceAuthorities: {
    withAuthority<Result>(workspaceId: string, work: (lease: WorkspaceAuthorityLease<Workspace, State>) => Promise<Result>): Promise<Result>;
  };
  canonicalWorkspaceFor(lease: WorkspaceAuthorityLease<Workspace, State>): Workspace & { attachmentId: symbol };
  requireEngineSessions(): EngineWorkspaceSessions;
  closeDispatchRunActivity(workspace: Workspace, options: { notifyRenderer: boolean }): Promise<void>;
  probeEngineStoreRefusal: typeof probeEngineStoreRefusal;
  moveEngineStoreAside: typeof moveEngineStoreAside;
  openWorkspaceActivityUnderEngineStoreLock(workspace: Workspace, options: { afterReopenRecoverySettled: () => void }): Promise<SyncStatusResult>;
  engineYDocSessionIpc: Pick<ReturnType<typeof createEngineYDocSessionIpc>,
    "open" | "readArtifactAsset" | "applyUpdate" | "acknowledgeLineageReplacement" | "prepareOwnerHandoff" | "close">;
}) {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    receivedShareEngine, withEngineAdapter, requireEngineCapture, localAgentDisplayName,
    notifyRenderer, requireWorkspace, assertWritableWorkspace, syncStatusWithOwnedProjection,
    activity, workspaceAuthorities, canonicalWorkspaceFor, requireEngineSessions,
    closeDispatchRunActivity, probeEngineStoreRefusal, moveEngineStoreAside,
    openWorkspaceActivityUnderEngineStoreLock, engineYDocSessionIpc,
  } = dependencies;

  function registerCollections(): void {
    // Collections: read-only engine index queries. list answers
    // "no collections" when the daemon has no sessions, so a shared view stays
    // quiet; get/query name the missing capability instead, because their
    // caller is an open collection tab that must show a cause.
    registerHandler(CHANNELS.listCollections, async (event, payload) => {
      assertTrustedSender(event);
      const input = ListCollectionsPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Collection listing stopped because this window changed workspaces.",
        async (operation) => {
          const result = await withEngineAdapter(
            receivedShareEngine.workspaceForRegistered(operation.workspace),
            async (adapter) => await adapter.listCollections(),
          );
          return ListCollectionsResult.parse(result ?? { collections: [] });
        },
      );
    });

    registerHandler(CHANNELS.getCollection, async (event, payload) => {
      assertTrustedSender(event);
      const input = GetCollectionPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Collection read stopped because this window changed workspaces.",
        async (operation) => {
          const result = await withEngineAdapter(
            receivedShareEngine.workspaceForRegistered(operation.workspace),
            async (adapter) =>
              await adapter.getCollection({ collectionPath: input.collectionPath }),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          return GetCollectionResult.parse(result);
        },
      );
    });

    registerHandler(CHANNELS.queryCollectionRecords, async (event, payload) => {
      assertTrustedSender(event);
      const input = QueryCollectionRecordsPayload.parse(payload);
      const { workspaceId: _workspaceId, ...params } = input;
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Collection query stopped because this window changed workspaces.",
        async (operation) => {
          const result = await withEngineAdapter(
            receivedShareEngine.workspaceForRegistered(operation.workspace),
            async (adapter) => await adapter.queryCollectionRecords(params),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          return QueryCollectionRecordsResult.parse(result);
        },
      );
    });
  }

  function registerHistory(): void {
    // Engine history + linked Chats (PR 0M-5). Workspaces read their
    // timeline from engine moments; every handler resolves the workspace via
    // requireWorkspace and rejects when the engine capture is not attached.
    // The moment/conflict record mappers live in ./ipc/engineHistoryIpc (pure,
    // unit-tested); main only injects the display-name rule below.
    // The same display-name rule the chat rail uses. AgentIntegration
    // stamps onBehalfOf "local" for local runs, which use the configured
    // agent name. Other labels display as stored.
    function agentAuthorDisplayName(author: Extract<NonNullable<VersionedTextMomentSummary["author"]>, {kind: "agent"}>): string {
      return author.onBehalfOf === "local" ? localAgentDisplayName() : author.onBehalfOf;
    }

    registerHandler(CHANNELS.listEngineMoments, async (event, payload) => {
      assertTrustedSender(event);
      const input = ListEngineMomentsPayload.parse(payload);
      const { capture } = await requireEngineCapture(
        input.workspaceId,
        "Engine history",
      );
      return listEngineMomentsForIpc(
        () =>
          capture.listMoments({
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.beforeMomentOrder !== undefined
              ? { beforeMomentOrder: input.beforeMomentOrder }
              : {}),
          }),
        agentAuthorDisplayName,
      );
    });

    registerHandler(CHANNELS.readEngineMoment, async (event, payload) => {
      assertTrustedSender(event);
      const input = ReadEngineMomentPayload.parse(payload);
      const { capture } = await requireEngineCapture(
        input.workspaceId,
        "Engine history",
      );
      const moment = await capture.readMoment(input.momentId);
      return ReadEngineMomentResult.parse({
        moment: moment
          ? engineMomentDetailForIpc(moment, agentAuthorDisplayName)
          : null,
      });
    });

    registerHandler(CHANNELS.restoreEngineMomentFile, async (event, payload) => {
      assertTrustedSender(event);
      const input = RestoreEngineMomentFilePayload.parse(payload);
      const { capture } = await requireEngineCapture(
        input.workspaceId,
        "Engine history",
      );
      const result = await capture.restoreFileToBeforeMoment(input.momentId);
      notifyRenderer({ workspaceId: input.workspaceId });
      return RestoreEngineMomentFileResult.parse(result);
    });
  }

  function registerStatusAndRepair(): void {
    registerHandler(CHANNELS.getSyncStatus, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceIdPayload.parse(payload);
      const workspace = requireWorkspace(input.workspaceId);
      return SyncStatusResult.parse(
        await syncStatusWithOwnedProjection(
          workspace,
          activity.getStatus(input.workspaceId),
        ),
      );
    });

    registerHandler(CHANNELS.rebuildEngineStore, async (event, payload) => {
      assertTrustedSender(event);
      const input = RebuildEngineStorePayload.parse(payload);
      const registered = requireWorkspace(input.workspaceId);
      assertWritableWorkspace(registered);
      return workspaceAuthorities.withAuthority(input.workspaceId, (lease) =>
        runInWorkspaceAuthorityLane(lease, "engine-store",
        async () => {
          const workspace = canonicalWorkspaceFor(lease);
          const sessions = requireEngineSessions();
          return RebuildEngineStoreResult.parse(
            await rebuildEngineStoreRequest(workspace.rootPath, {
              // A store this build could not migrate is intact; only a
              // refusal the rebuild can repair admits the move.
              isStoreRefused: () => {
                const refusal =
                  activity.getStatus(workspace.workspaceId).engineStoreRefused;
                return (
                  refusal != null &&
                  engineStoreRefusalRecovery(refusal) === "rebuild"
                );
              },
              hasActiveAgentRun: () =>
                activity.hasAgentRun(workspace.workspaceId, workspace.rootPath),
              previousResult: () =>
                lease.state.lastEngineStoreRebuildResult ?? undefined,
              rememberResult: (result) =>
                (lease.state.lastEngineStoreRebuildResult = result),
              closeActivity: async () => {
                try {
                  await closeDispatchRunActivity(workspace, {
                    notifyRenderer: false,
                  });
                } catch (error) {
                  notifyRenderer({ workspaceId: workspace.workspaceId });
                  throw error;
                }
              },
              probeStoreRefusal: () =>
                probeEngineStoreRefusal(
                  workspace,
                  sessions,
                ),
              rebuildGate: {
                begin: () => sessions.beginRebuild(workspace),
                end: () => sessions.endRebuild(workspace),
              },
              moveStoreAside: moveEngineStoreAside,
              reopenActivity: async () => {
                try {
                  await openWorkspaceActivityUnderEngineStoreLock(workspace, {
                    afterReopenRecoverySettled: () =>
                      sessions.endRebuild(workspace),
                  });
                } finally {
                  notifyRenderer({ workspaceId: workspace.workspaceId });
                }
              },
            }),
          );
        }),
      );
    });
  }

  function registerYDoc(): void {
    registerHandler(CHANNELS.engineYDocOpen, async (event, payload) => {
      assertTrustedSender(event);
      return engineYDocSessionIpc.open(event.sender, payload);
    });

    registerHandler(
      CHANNELS.engineYDocReadArtifactAsset,
      async (event, payload) => {
        assertTrustedSender(event);
        return engineYDocSessionIpc.readArtifactAsset(event.sender, payload);
      },
    );

    registerHandler(CHANNELS.engineYDocApplyUpdate, (event, payload) => {
      assertTrustedSender(event);
      return engineYDocSessionIpc.applyUpdate(event.sender, payload);
    });

    registerHandler(
      CHANNELS.engineYDocAcknowledgeLineageReplacement,
      (event, payload) => {
        assertTrustedSender(event);
        return engineYDocSessionIpc.acknowledgeLineageReplacement(
          event.sender,
          payload,
        );
      },
    );

    registerHandler(CHANNELS.engineYDocClose, async (event, payload) => {
      assertTrustedSender(event);
      await engineYDocSessionIpc.close(event.sender, payload);
    });
    registerHandler(CHANNELS.engineYDocPrepareOwnerHandoff, (event,payload) => {
      assertTrustedSender(event);
      return engineYDocSessionIpc.prepareOwnerHandoff(event.sender,payload);
    });
  }

  return { registerCollections, registerHistory, registerStatusAndRepair, registerYDoc };
}
