import { shareRecordStatuses } from "../workspaces/shareRecordStatus";
import { WorkspaceDaemonRequester, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { z } from "zod";
import type { EngineWorkspace, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  historyOperations,
  CaptureRecoveryStatusResult, captureRecoveryOperations, fileObservationOperations,
  ListCollectionsPayload, ListCollectionsResult, GetCollectionPayload, GetCollectionResult,
  QueryCollectionRecordsPayload, QueryCollectionRecordsResult, ListEngineMomentsPayload,
  ReadEngineMomentPayload, ReadEngineMomentResult, HistoryPolicyUnreadableResult, RestoreEngineMomentFilePayload,
  RestoreEngineMomentFileResult, RetryCloudSyncPayload, WorkspaceIdPayload, SyncStatusResult,
  RebuildEngineStorePayload, RebuildEngineStoreResult, engineStoreRefusalRecovery,
  GetCollectionRecordHistoryPayload, GetCollectionRecordHistoryResult, RECORD_HISTORY_PAGE,
  LocateRecordHistoryRunPayload, LocateRecordHistoryRunResult,
  engineYDocAdmissionOperations,
  engineYDocSaveOperations,
} from "./bridgeContract";
import { registerOperations } from "./operationTable";
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
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import { createHistoryTimeline, type TimelineReads } from "../workspaces/historyTimeline";
import { sharedViewHistory } from "../workspaces/sharedViewHistory";
import { historyPathAdmission, historyMomentPathsAdmitted, type readWorkspaceEnginePolicy, type WorkspaceEnginePolicySnapshot } from "../workspaces/workspaceEnginePolicyFile";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { collectionListSources, collectionReadSource, mountedCollectionSchema, receivedCollectionQuery } from "../workspaces/receivedShareCollections";
import { resolveRegisteredShareViewFilesTarget } from "../workspaces/shareViewFilesTarget";
import { resolveOwnedWorkspaceSharePath } from "../workspaces/ownedWorkspaceFileReader";
import { recordedShareSelector } from "../workspaces/shareViewRecords";

type EngineStoreAuthorityState = {
  operationLanes: Map<string, Promise<void>>;
  lastEngineStoreRebuildResult: RebuildEngineStoreResult | null;
};

export function createWorkspaceEngineIpc<
  Sender extends EngineYDocIpcSender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry,
  State extends EngineStoreAuthorityState,
  Operation extends { workspace: Workspace & { attachmentId: symbol }; signal: AbortSignal; scope?: string; assertCurrent(): void },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: any) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, retiredMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  receivedShareEngine: Pick<ReturnType<typeof createReceivedShareEngineAccess>, "workspaceFor" | "workspaceForRegistered" | "storeFor">;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: Pick<VersionedLiveAdapter, "listCollections" | "getCollection" | "queryCollectionRecords" | "reconcileCapture" | "watcherStatus" | "getCollectionRecord" | "clearCaptureRecovery">) => Promise<Result>,
  ): Promise<Result | null>;
  requireEngineCapture(workspaceId: string, feature: "Engine history"): Promise<{
    capture: Pick<WorkspaceEngineCapture, "listMoments" | "readMoment" | "restoreFileToBeforeMoment">;
  }>;
  readWorkspaceEnginePolicy: typeof readWorkspaceEnginePolicy;
  historyCollections(operation: Operation): Promise<Pick<TimelineReads, "local" | "remote" | "scope">>;
  localAgentDisplayName(): string;
  localPersonId(): string;
  /** This computer's person as History names them. */
  localPersonName(): string;
  recordHistoryPersonName(workspaceId: string, userId: string, sender: Sender): string | null;
  prepareRecordHistoryPeople(workspaceId: string, userIds: readonly string[], sender: Sender): void;
  /** The person a request is made by, read from main's own account when it arrives. */
  localPerson(): Promise<LocalPersonAuthor>;
  /** An automation author as History shows it, in one workspace. */
  automationAuthor(workspaceId: string, automationId: string): ReturnType<EngineMomentAuthorNames["automation"]>;
  /** A person the owner shared with, as History names their direct write. */
  /** How one History read names the people the owner shared with, reading the roster once. */
  namedAuthorLabels(workspaceId: string, sender: Sender): Pick<EngineMomentAuthorNames, "named" | "prepare">;
  /** Whether this computer keeps an automation's run, so a record's history can open it. */
  automationRunOnThisComputer(workspaceId: string, automationId: string, claimId: string): Promise<boolean>;
  /** The owner's server's runs; the relay answers only the workspace's owner. */
  serverRuns: Pick<ServerRuns, "shownTo">;
  /** The signed-in account now, or null when signed out. */
  signedInAccount(): string | null;
  isOnline?(): boolean;
  notifyRenderer(target: { workspaceId: string }): void;
  retryOwnerLiveDelivery?(workspaceId: string): void;
  retryCloudSync(workspaceId: string, reason: RetryCloudSyncPayload["reason"]): Promise<void>;
  retryFileObservation(workspaceId: string): Promise<void>;
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
    "open" | "waitForAdmission" | "retrySave" | "readArtifactAsset" | "applyUpdate" | "acknowledgeLineageReplacement" | "prepareOwnerHandoff" | "close">;
}) {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    receivedShareEngine, withEngineAdapter, requireEngineCapture, localAgentDisplayName, localPersonId, localPersonName, localPerson,
    automationAuthor, namedAuthorLabels, readWorkspaceEnginePolicy,
    automationRunOnThisComputer, serverRuns, signedInAccount,
    notifyRenderer, requireWorkspace, assertWritableWorkspace, syncStatusWithOwnedProjection,
    activity, workspaceAuthorities, canonicalWorkspaceFor, requireEngineSessions,
    closeDispatchRunActivity, probeEngineStoreRefusal, moveEngineStoreAside,
    openWorkspaceActivityUnderEngineStoreLock, engineYDocSessionIpc,
  } = dependencies;
  const timeline = createHistoryTimeline();
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
          const [required, ...mounts] = collectionListSources(operation.workspace, receivedShareEngine);
          const read = async (source: NonNullable<typeof required>) => {
            const result = await withEngineAdapter(source.workspace, adapter => adapter.listCollections());
            return (result?.collections ?? [])
              .filter(collection => source.selected(`${collection.path}/collection.yaml`))
              .map(collection => ({ ...collection, path: source.prefix + collection.path }));
          };
          const collections = required ? await read(required) : [];
          const mounted = await Promise.allSettled(mounts.map(read));
          for (const result of mounted) {
            if (result.status === "fulfilled") collections.push(...result.value);
          }
          return ListCollectionsResult.parse({ collections });
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
          const { source, path } = await collectionReadSource(operation.workspace, input.collectionPath, receivedShareEngine);
          const result = await withEngineAdapter(
            source.workspace,
            async (adapter) =>
              await adapter.getCollection({ collectionPath: path }),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          return GetCollectionResult.parse({ ...result, path: source.prefix + result.path, schema: mountedCollectionSchema(result.schema, source.prefix) });
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
          const { source, path } = await collectionReadSource(operation.workspace, input.collectionPath, receivedShareEngine);
          const cursor = params.cursor;
          if (cursor && (!cursor.recordPath.startsWith(source.prefix) || !source.selected(cursor.recordPath.slice(source.prefix.length)))) {
            throw new Error("This record is outside the files shared with you.");
          }
          const result = await withEngineAdapter(
            source.workspace,
            async (adapter) => await adapter.queryCollectionRecords({ ...params, collectionPath: path,
              ...(cursor ? { cursor: { ...cursor, recordPath: cursor.recordPath.slice(source.prefix.length) } } : {}) }),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          const found = await resolveOwnedWorkspaceSharePath(operation.workspace, `${input.collectionPath}/collection.yaml`);
          const target = found && resolveRegisteredShareViewFilesTarget(operation.workspace, found.target);
          const grant = target && recordedShareSelector(target.grantedSelector);
          if (target?.shareId && grant?.versionId === null) {
            const records = [...result.records, ...(result.groups?.flatMap(group => group.records) ?? [])];
            const paths = [...new Set(records.map(record => record.path))];
            const statuses = await dependencies.requireEngineSessions().run(source.workspace, async binding =>
              shareRecordStatuses(new WorkspaceDaemonRequester(binding.client), {
                workspaceId: target.storeWorkspaceId, shareId: target.shareId!, paths,
                grantedSelector: { paths: grant.paths, versionId: grant.versionId, access: grant.access },
              }, { workspace: binding.workspace })).catch((): Awaited<ReturnType<typeof shareRecordStatuses>> => ({}));
            for (const record of records) {
              const status = statuses[record.path];
              if (status) {
                record.creationDelivery = status.state === "pending" && dependencies.isOnline?.() === false ? "offline" : status.state;
                record.creationRefusal = status.reason;
                record.creationCanDiscard = status.canDiscard;
              }
            }
          }
          return QueryCollectionRecordsResult.parse(receivedCollectionQuery(result, source));
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
          const { source, path } = await collectionReadSource(operation.workspace, input.collectionPath, receivedShareEngine);
          const result = await withEngineAdapter(
            source.workspace,
            async (adapter) => await adapter.getCollectionRecord({
              collectionPath: path,
              recordId: input.recordId,
              historyLimit: RECORD_HISTORY_PAGE,
              ...(input.beforeHistoryId === undefined ? {} : { beforeHistoryId: input.beforeHistoryId }),
            }),
          );
          if (!result) throw new Error("The workspace engine is not running.");
          if (!source.selected(result.record.path)) throw new Error("This record is outside the files shared with you.");
          result.record.path = source.prefix + result.record.path;
          const { workspaceId } = operation.workspace;
          const authors: RecordHistoryAuthors = {
            prepare: userIds => dependencies.prepareRecordHistoryPeople(workspaceId, userIds, event.sender),
            person: userId => dependencies.recordHistoryPersonName(workspaceId, userId, event.sender),
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
    function authorNames(workspaceId: string, sender: Sender): EngineMomentAuthorNames {
      return {
        agent: (author) => author.agentRunId ? (author.onBehalfOf === localPersonId() ? localAgentDisplayName() : "Agent") : author.agentId === "dohc-mcp" ? "Agent" : author.agentId,
        person: (author) => author.humanId === localPersonId() ? localPersonName() : undefined,
        automation: (automationId) => automationAuthor(workspaceId, automationId),
        ...namedAuthorLabels(workspaceId, sender),
      };
    }

    // A shared view reads its own imported history through the renderer's
    // registered attachment. It keeps no capture, so restore stays refused.
    // The read never reaches the relay: a share whose access ended keeps the
    // history it already imported, as it keeps its files, and gains nothing new.
    async function readHistory<Result>(
      event: Event, workspaceId: string,
      read: (history: Pick<WorkspaceEngineCapture, "listMoments" | "readMoment"> & Partial<Pick<WorkspaceEngineCapture, "filePathForObjectId">>, rootPath: string | null) => Promise<Result>,
    ): Promise<Result> {
      if (!shareViewIsPresent(requireWorkspace(workspaceId).shareView)) {
        const { capture } = await requireEngineCapture(workspaceId, "Engine history");
        return read(capture, requireWorkspace(workspaceId).rootPath);
      }
      return withRendererWorkspaceOperation(event.sender, workspaceId,
        "History stopped loading because this window changed workspaces.", async (operation) => {
          const { workspace } = operation;
          if (!shareViewIsPresent(workspace.shareView)) throw new Error("This workspace is no longer a shared view.");
          const store = receivedShareEngine.storeFor({
            engineWorkspaceId: workspace.workspaceId, rootPath: workspace.rootPath, attachmentId: workspace.attachmentId,
          });
          return read(sharedViewHistory(store, workspace.workspaceId), null);
        });
    }

    const policyUnreadable = (policy: WorkspaceEnginePolicySnapshot) => HistoryPolicyUnreadableResult.parse({
      status: "policy-unreadable", unreadable: policy.unreadable, policyErrors: policy.errors,
    });

    registerOperations<typeof historyOperations, Event, Operation>({
      handle: registerHandler, assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, message, work) => withRendererWorkspaceOperation(event.sender, workspaceId, message, work),
    }, historyOperations, {
      listHistory: async (input, { event, operation }) => {
        const workspace = operation.workspace, shared = shareViewIsPresent(workspace.shareView);
        operation.assertCurrent();
        const policy = shared ? null : await readWorkspaceEnginePolicy(workspace.rootPath);
        operation.assertCurrent();
        if (policy?.errors.length) return policyUnreadable(policy);
        const engine = shared ? sharedViewHistory(receivedShareEngine.storeFor({ engineWorkspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath, attachmentId: workspace.attachmentId }), workspace.workspaceId)
          : (await requireEngineCapture(workspace.workspaceId, "Engine history")).capture;
        operation.assertCurrent();
        let resolved: Awaited<ReturnType<typeof dependencies.historyCollections>> | undefined;
        let pending: Promise<NonNullable<typeof resolved>> | undefined;
        const getCollections = () => pending ??= dependencies.historyCollections(operation).then(value => { operation.assertCurrent(); resolved = value; return value; });
        const collections: Pick<TimelineReads, "scope" | "local" | "remote"> = shared
          ? { scope: operation.scope ?? workspace.workspaceId, local: () => ({ pages: [], transferred: [] }), remote: async () => { throw new Error("Collection History is unavailable in a received share."); } }
          : { get scope() { return resolved?.scope ?? operation.scope ?? workspace.workspaceId; },
            local: async (positions, limit, sourceIds) => (await getCollections()).local(positions, limit, sourceIds),
            remote: async (datasetId, beforeRevision, signal) => (await getCollections()).remote(datasetId, beforeRevision, signal) };
        return timeline(input, { ...collections, engine, signal: operation.signal, assertCurrent: () => operation.assertCurrent(),
          names: authorNames(workspace.workspaceId, event.sender), ...(policy ? { admitted: historyPathAdmission(policy) } : {}) });
      },
    });

    registerHandler(CHANNELS.listEngineMoments, async (event, payload) => {
      assertTrustedSender(event);
      const input = ListEngineMomentsPayload.parse(payload);
      return readHistory(event, input.workspaceId, async (history, rootPath) => {
        const policy = rootPath === null ? null : await readWorkspaceEnginePolicy(rootPath);
        if (policy?.errors.length) return policyUnreadable(policy);
        const admitted = policy ? historyPathAdmission(policy) : null;
        return listEngineMomentsForIpc(
          async () => {
            let cursor = input.cursor;
            let startCursor = input.cursor;
            const versionMarkers: Awaited<ReturnType<typeof history.listMoments>>["versionMarkers"] = [];
            // Today's view shows moments. Keep skipped markers for the later timeline UI.
            const pageReach = Math.min(40, Math.ceil(2_000 / (input.limit ?? 50)));
            for (let pageIndex = 0; ; pageIndex += 1) {
              const page = await history.listMoments({
                ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
                ...(cursor !== undefined ? { cursor } : {}),
              });
              startCursor ??= page.startCursor;
              versionMarkers.push(...page.versionMarkers);
              const moments = admitted ? page.moments.filter(moment => moment.protected || admitted(moment.path)) : page.moments;
              if (moments.length > 0 || page.nextCursor === null || pageIndex + 1 >= pageReach) {
                return { ...page, moments, startCursor, versionMarkers };
              }
              if (pageIndex === 0 && admitted && input.objectId !== undefined) {
                const objectPath = await history.filePathForObjectId?.(input.objectId);
                if (objectPath != null && !admitted(objectPath)) {
                  return { ...page, moments, nextCursor: null, startCursor, versionMarkers };
                }
              }
              cursor = page.nextCursor;
            }
          },
          authorNames(input.workspaceId, event.sender),
        );
      });
    });

    registerHandler(CHANNELS.readEngineMoment, async (event, payload) => {
      assertTrustedSender(event);
      const input = ReadEngineMomentPayload.parse(payload);
      return readHistory(event, input.workspaceId, async (history, rootPath) => {
        const policy = rootPath === null ? null : await readWorkspaceEnginePolicy(rootPath);
        if (policy?.errors.length) return ReadEngineMomentResult.parse({ ...policyUnreadable(policy), moment: null });
        const moment = await history.readMoment(input.momentId);
        if (moment && !moment.protected && policy && !historyMomentPathsAdmitted(historyPathAdmission(policy), moment.moment)) {
          return ReadEngineMomentResult.parse({ status: "untracked", moment: null });
        }
        const names = authorNames(input.workspaceId, event.sender);
        if (moment && !moment.protected && moment.moment.authors) names.prepare?.(moment.moment.authors);
        return ReadEngineMomentResult.parse({
          moment: moment ? engineMomentDetailForIpc(moment, names) : null,
        });
      });
    });

    registerHandler(CHANNELS.restoreEngineMomentFile, async (event, payload) => {
      assertTrustedSender(event);
      const input = RestoreEngineMomentFilePayload.parse(payload);
      const person = await localPerson();
      const { capture } = await requireEngineCapture(
        input.workspaceId,
        "Engine history",
      );
      const result = await capture.restoreFileToBeforeMoment(input.momentId, person);
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
    registerOperations<typeof captureRecoveryOperations, Event, Operation>({
      handle: registerHandler,
      assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, message, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, message, work),
    }, captureRecoveryOperations, {
      getCaptureRecoveryStatus: async (input, { event }) => {
        return withRendererWorkspaceOperation(event.sender, input.workspaceId, "This workspace is no longer active.", async operation => {
          const result = await withEngineAdapter(operation.workspace, async adapter => ({ captureRecoveries: (await adapter.watcherStatus()).captureRecoveries }));
          if (result === null) throw new Error("The workspace engine is not running.");
          return CaptureRecoveryStatusResult.parse(result);
        });
      },
      clearCaptureRecovery: async (input, { event }) => {
        return withRendererWorkspaceOperation(event.sender, input.workspaceId, "This workspace is no longer active.", async operation => {
          const result = await withEngineAdapter(operation.workspace, async adapter => {
            await adapter.clearCaptureRecovery(input.momentId);
            return true;
          });
          if (result === null) throw new Error("The workspace engine is not running.");
        });
      },
    });
    registerOperations<typeof fileObservationOperations, Event, Operation>({
      handle: registerHandler, assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, message, work) => withRendererWorkspaceOperation(event.sender, workspaceId, message, work),
    }, fileObservationOperations, {
      retryFileObservation: async (input, { event }) => {
        const started = await withRendererWorkspaceOperation(event.sender, input.workspaceId, "This workspace is no longer active.", async operation => {
          const read = dependencies.retryFileObservation(operation.workspace.workspaceId);
          // Observe rejection while the workspace operation is still completing.
          void read.catch(() => {});
          return { workspaceId: operation.workspace.workspaceId, read };
        });
        // A stalled read must not hold the workspace operation open.
        await started.read;
        return activity.getStatus(started.workspaceId);
      },
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
    registerOperations<typeof engineYDocAdmissionOperations, Event, Operation>({
      handle: registerHandler,
      assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
    }, engineYDocAdmissionOperations, {
      waitForEngineYDocAdmission: (payload, { event }) =>
        engineYDocSessionIpc.waitForAdmission(event.sender, payload),
    });
    registerOperations<typeof engineYDocSaveOperations, Event, Operation>({
      handle: registerHandler,
      assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
    }, engineYDocSaveOperations, {
      retryEngineYDocSave: (payload, { event }) =>
        engineYDocSessionIpc.retrySave(event.sender, payload),
    });
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
