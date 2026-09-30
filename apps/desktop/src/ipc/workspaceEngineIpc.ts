import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineWorkspace, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  ListCollectionsPayload, ListCollectionsResult, GetCollectionPayload, GetCollectionResult,
  QueryCollectionRecordsPayload, QueryCollectionRecordsResult, ListEngineMomentsPayload,
  ReadEngineMomentPayload, ReadEngineMomentResult, RestoreEngineMomentFilePayload,
  RestoreEngineMomentFileResult, RetryCloudSyncPayload, WorkspaceIdPayload, SyncStatusResult,
  RebuildEngineStorePayload, RebuildEngineStoreResult, engineStoreRefusalRecovery,
  GetCollectionRecordHistoryPayload, GetCollectionRecordHistoryResult, RECORD_HISTORY_PAGE,
  LocateRecordHistoryRunPayload, LocateRecordHistoryRunResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { engineMomentDetailForIpc, listEngineMomentsForIpc, type EngineMomentAuthorNames } from "./engineHistoryIpc";
import { createRunLocator, recordHistoryForIpc, type RecordHistoryAuthors } from "./recordHistoryIpc";
import { rebuildEngineStoreRequest, type moveEngineStoreAside } from "../workspaces/engineStoreRebuild";
import { runInWorkspaceAuthorityLane } from "../workspaces/workspaceAuthorityLane";
import type { WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { ServerRuns } from "../automations/serverRuns";
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
    work: (adapter: Pick<VersionedLiveAdapter, "listCollections" | "getCollection" | "queryCollectionRecords" | "reconcileCapture" | "watcherStatus" | "getCollectionRecord">) => Promise<Result>,
  ): Promise<Result | null>;
  requireEngineCapture(workspaceId: string, feature: "Engine history"): Promise<{
    capture: Pick<WorkspaceEngineCapture, "listMoments" | "readMoment" | "restoreFileToBeforeMoment">;
  }>;
  localAgentDisplayName(): string;
  localPersonId(): string;
  /** An automation author as History shows it, in one workspace. */
  automationAuthor(workspaceId: string, automationId: string): ReturnType<EngineMomentAuthorNames["automation"]>;
  /** A person the owner shared with, as History names their direct write. */
  namedAuthorLabel(workspaceId: string, author: Parameters<EngineMomentAuthorNames["named"]>[0]): string;
  /** Whether this computer keeps an automation's run, so a record's history can open it. */
  automationRunOnThisComputer(workspaceId: string, automationId: string, claimId: string): Promise<boolean>;
  /** The owner's server's runs; the relay answers only the workspace's owner. */
  serverRuns: Pick<ServerRuns, "shownTo">;
  /** The signed-in account now, or null when signed out. */
  signedInAccount(): string | null;
  notifyRenderer(target: { workspaceId: string }): void;
  retryOwnerLiveDelivery?(workspaceId: string): void;
  retryCloudSync(workspaceId: string, reason: RetryCloudSyncPayload["reason"]): Promise<void>;
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
    receivedShareEngine, withEngineAdapter, requireEngineCapture, localAgentDisplayName, localPersonId, automationAuthor, namedAuthorLabel,
    automationRunOnThisComputer, serverRuns, signedInAccount,
    notifyRenderer, requireWorkspace, assertWritableWorkspace, syncStatusWithOwnedProjection,
    activity, workspaceAuthorities, canonicalWorkspaceFor, requireEngineSessions,
    closeDispatchRunActivity, probeEngineStoreRefusal, moveEngineStoreAside,
    openWorkspaceActivityUnderEngineStoreLock, engineYDocSessionIpc,
  } = dependencies;
  const runLocator = createRunLocator({
    onThisComputer: automationRunOnThisComputer,
    onServer: (workspaceId, automationId, claimId) => serverRuns.shownTo(workspaceId, automationId, claimId),
    signedInAccount,
  });

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

    // A document record's History, a page at a time. Authors are named as
    // the file timeline names them; an automation by its name when it ran.
    registerHandler(CHANNELS.getCollectionRecordHistory, async (event, payload) => {
      assertTrustedSender(event);
      const input = GetCollectionRecordHistoryPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Record history stopped loading because this window changed workspaces.",
        async (operation) => {
          const result = await withEngineAdapter(
            receivedShareEngine.workspaceForRegistered(operation.workspace),
            async (adapter) => await adapter.getCollectionRecord({
              collectionPath: input.collectionPath,
              recordId: input.recordId,
              historyLimit: RECORD_HISTORY_PAGE,
              ...(input.beforeHistoryId === undefined ? {} : { beforeHistoryId: input.beforeHistoryId }),
            }),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          const { workspaceId } = operation.workspace;
          const authors: RecordHistoryAuthors = {
            agent: (onBehalfOf) => onBehalfOf === localPersonId() ? localAgentDisplayName() : "Agent",
            automationName: (automationId) => automationAuthor(workspaceId, automationId)?.name ?? null,
            runAvailable: (automationId, claimId) => runLocator.available(workspaceId, automationId, claimId),
          };
          return GetCollectionRecordHistoryResult.parse(await recordHistoryForIpc(result, authors));
        },
      );
    });

    // A run History could not place from this computer, one at a time, so
    // the page shows at once and each run fills in as its answer comes.
    registerHandler(CHANNELS.locateRecordHistoryRun, async (event, payload) => {
      assertTrustedSender(event);
      const input = LocateRecordHistoryRunPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Record history stopped loading because this window changed workspaces.",
        async (operation) => LocateRecordHistoryRunResult.parse({
          location: await runLocator.locate(operation.workspace.workspaceId, input.automationId, input.claimId),
        }),
      );
    });
  }

  function registerHistory(): void {
    // Engine history + linked Chats (PR 0M-5). Workspaces read their
    // timeline from engine moments; every handler resolves the workspace via
    // requireWorkspace and rejects when the engine capture is not attached.
    // Runs dohc started use the Settings name. Other agents use their handshake label.
    function authorNames(workspaceId: string): EngineMomentAuthorNames {
      return {
        agent: (author) => author.agentRunId ? (author.onBehalfOf === localPersonId() ? localAgentDisplayName() : "Agent") : author.agentId === "dohc-mcp" ? "Agent" : author.agentId,
        automation: (automationId) => automationAuthor(workspaceId, automationId),
        named: (author) => namedAuthorLabel(workspaceId, author),
      };
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
        authorNames(input.workspaceId),
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
          ? engineMomentDetailForIpc(moment, authorNames(input.workspaceId))
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
    registerHandler(CHANNELS.retryFileRecovery, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceIdPayload.parse(payload);
      return withRendererWorkspaceOperation(event.sender, input.workspaceId, "This workspace is no longer active.", async operation => {
        assertWritableWorkspace(operation.workspace);
        const recovered = await withEngineAdapter(operation.workspace, async adapter => {
          await adapter.reconcileCapture();
          if ((await adapter.watcherStatus()).recoveryUnavailable) {
            throw new Error("dohc still cannot read the recovery folder. Check folder access, then try again.");
          }
          return true;
        });
        if (!recovered) throw new Error("The workspace engine is not running.");
        notifyRenderer({ workspaceId: operation.workspace.workspaceId });
      });
    });
    registerHandler(CHANNELS.retryOwnerLiveDelivery, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceIdPayload.parse(payload);
      return withRendererWorkspaceOperation(event.sender, input.workspaceId, "This workspace is no longer active.", async operation => {
        assertWritableWorkspace(operation.workspace);
        dependencies.retryOwnerLiveDelivery?.(operation.workspace.workspaceId);
      });
    });
    // Answers with the status after the pass, so the notice that offered
    // Try again can say whether it worked. Only the renderer's own workspace
    // is admitted. The pass starts inside the operation and is awaited
    // outside it, so a pass waiting on an unreachable server does not hold
    // the workspace open.
    registerHandler(CHANNELS.retryCloudSync, async (event, payload) => {
      assertTrustedSender(event);
      const input = RetryCloudSyncPayload.parse(payload);
      const started = await withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "This workspace is no longer active.",
        async (operation) => {
          assertWritableWorkspace(operation.workspace);
          const workspace = operation.workspace;
          return {
            workspace,
            pass: dependencies.retryCloudSync(workspace.workspaceId, input.reason),
          };
        },
      );
      await started.pass;
      return SyncStatusResult.parse(
        await syncStatusWithOwnedProjection(
          started.workspace,
          activity.getStatus(started.workspace.workspaceId),
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
