import { agentColorsForPresentation } from "../settings/userSettingsStore";
import { createWorkspaceHandler } from "./rendererWorkspaceHandler";
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
import { CollectionsRefusalError } from "../workspaces/collectionsHolder";
import { sharedViewHistory } from "../workspaces/sharedViewHistory";
import { historyPathAdmission, historyMomentPathsAdmitted, type readWorkspaceEnginePolicy, type WorkspaceEnginePolicySnapshot } from "../workspaces/workspaceEnginePolicyFile";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { collectionListSources, collectionReadSource, mountedCollectionSchema, receivedCollectionQuery } from "../workspaces/receivedShareCollections";
import { resolveRegisteredShareViewFilesTarget } from "../workspaces/shareViewFilesTarget";
import { resolveOwnedWorkspaceSharePath } from "../workspaces/ownedWorkspaceFileReader";
import { recordedShareSelector } from "../workspaces/shareViewRecords";
import { createHistoryPresentationRequest } from "../workspaces/actorPresentation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { readSyncHistory } from "../workspaces/syncHistory";

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
    work: (adapter: Pick<VersionedLiveAdapter, "listCollections" | "getCollection" | "queryCollectionRecords" | "reconcileCapture" | "watcherStatus" | "getCollectionRecord" | "clearCaptureRecovery" | "retryHeldCapture">) => Promise<Result>,
  ): Promise<Result | null>;
  requireEngineCapture(workspaceId: string, feature: "Engine history"): Promise<{
    capture: Pick<WorkspaceEngineCapture, "listMoments" | "readMoment" | "restoreFileToBeforeMoment">;
  }>;
  readWorkspaceEnginePolicy: typeof readWorkspaceEnginePolicy;
  readSyncHistory: typeof readSyncHistory;
  historyCollections(operation: Operation): Promise<Pick<TimelineReads, "local" | "remote" | "scope">>;
  localAgentDisplayName(): string;
  localPersonId(): string;
  /** This computer's person as History names them. */
  localPersonName(): string;
  recordHistoryPersonName(workspaceId: string, userId: string, sender: Sender): string | null;
  prepareRecordHistoryPeople(workspaceId: string, userIds: readonly string[], sender: Sender): void;
  /** The person a request is made by, read from main's own account when it arrives. */
  localPerson(): Promise<LocalPersonAuthor>;
  localInstallationId(): string;
  stateDir(): string;
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
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
  recordHeldFiles(workspace: EngineWorkspace, files: NonNullable<SyncStatusResult["heldFiles"]>): void;
  retryOwnerLiveDelivery?(workspaceId: string): void;
  retryCloudSync(workspaceId: string, reason: RetryCloudSyncPayload["reason"]): Promise<void>;
  retryFileObservation(workspaceId: string): Promise<void>;
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
    localInstallationId, warmCredentialCache, currentCredentials, automationAuthor, namedAuthorLabels, readWorkspaceEnginePolicy, readSyncHistory,
    automationRunOnThisComputer, serverRuns, signedInAccount,
    notifyRenderer, assertWritableWorkspace, syncStatusWithOwnedProjection,
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

  const workspaceHandler = createWorkspaceHandler({ assertTrustedSender, withRendererWorkspaceOperation });

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
    // timeline from engine moments through the admitted workspace. Owner
    // history rejects when the engine capture is not attached.
    // Runs dohc started use the Settings name. Other agents use their handshake label.
    function authorNames(workspaceId: string, sender: Sender, presentations: EngineMomentAuthorNames["presentations"]): EngineMomentAuthorNames {
      return {
        agent: (author) => author.agentRunId ? (author.onBehalfOf === localPersonId() ? localAgentDisplayName() : "Agent") : author.agentId === "dohc-mcp" ? "Agent" : author.agentId,
        person: (author) => author.humanId === localPersonId() ? localPersonName() : undefined,
        automation: (automationId) => automationAuthor(workspaceId, automationId),
        presentations,
        ...namedAuthorLabels(workspaceId, sender),
      };
    }

    // How one History read draws its authors, and the check it makes after each await.
    // The read stops when its window, server, or shared view changes; the operation itself
    // retires when the folder does. Other registry writes replace the entry too, such as the
    // last-opened stamp; they don't stop it.
    // A received share's authors are what the owner recorded, so they get no issuer and no self.
    function historyIdentity(operation: Operation) {
      const entry = operation.workspace;
      const shared = shareViewIsPresent(entry.shareView);
      const assertCurrent = () => {
        operation.assertCurrent();
        const current = operation.workspace;
        if (current.remote?.serverUrl !== entry.remote?.serverUrl || shareViewIsPresent(current.shareView) !== shared) {
          throw new Error("History stopped loading because the workspace changed.");
        }
      };
      const presentations = async (): Promise<EngineMomentAuthorNames["presentations"]> => {
        const agentColors = await agentColorsForPresentation(dependencies.stateDir());
        assertCurrent();
        if (shared) return createHistoryPresentationRequest({ agentColors, source: "received", workspaceId: entry.workspaceId, assertCurrent });
        await warmCredentialCache();
        assertCurrent();
        const credentials = currentCredentials();
        // A folder that records a sync but has no remote can't say which server its ids
        // belong to. An unreadable record may say it synced.
        const synced = entry.remote !== undefined
          || (credentials !== null && ["synced", "unknown"].includes(await readSyncHistory(entry.rootPath)));
        assertCurrent();
        return createHistoryPresentationRequest({
          agentColors, source: "own-store", workspaceId: entry.workspaceId, assertCurrent, serverUrl: entry.remote?.serverUrl, synced,
          installationId: localInstallationId(), credentials,
        });
      };
      return { entry, shared, assertCurrent, presentations };
    }

    // A shared view reads its own imported history through the renderer's
    // registered attachment. It keeps no capture, so restore stays refused.
    // The read never reaches the relay: a share whose access ended keeps the
    // history it already imported, as it keeps its files, and gains nothing new.
    async function readHistory<Result>(
      operation: Operation,
      read: (
        history: Pick<WorkspaceEngineCapture, "listMoments" | "readMoment"> & Partial<Pick<WorkspaceEngineCapture, "filePathForObjectId">>,
        rootPath: string | null,
        presentations: EngineMomentAuthorNames["presentations"],
        // Call after each await, so nothing returns from a replaced window, folder, server, or shared view.
        assertCurrent: () => void,
      ) => Promise<Result>,
    ): Promise<Result> {
      const { entry, shared, assertCurrent, presentations } = historyIdentity(operation);
      if (!shared) {
        const { capture } = await requireEngineCapture(entry.workspaceId, "Engine history");
        assertCurrent();
        return read(capture, entry.rootPath, await presentations(), assertCurrent);
      }
      const store = receivedShareEngine.storeFor({
        engineWorkspaceId: entry.workspaceId, rootPath: entry.rootPath, attachmentId: entry.attachmentId,
      });
      return read(sharedViewHistory(store, entry.workspaceId), null, await presentations(), assertCurrent);
    }

    const policyUnreadable = (policy: WorkspaceEnginePolicySnapshot) => HistoryPolicyUnreadableResult.parse({
      status: "policy-unreadable", unreadable: policy.unreadable, policyErrors: policy.errors,
    });

    registerOperations<typeof historyOperations, Event, Operation>({
      handle: registerHandler, assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, message, work) => withRendererWorkspaceOperation(event.sender, workspaceId, message, work),
    }, historyOperations, {
      listHistory: async (input, { event, operation }) => {
        // The timeline draws file authors as the moment list does, with the same checks.
        const identity = historyIdentity(operation);
        const { entry: workspace, shared, assertCurrent } = identity;
        assertCurrent();
        const policy = shared ? null : await readWorkspaceEnginePolicy(workspace.rootPath);
        assertCurrent();
        if (policy?.errors.length) return policyUnreadable(policy);
        const engine = shared ? sharedViewHistory(receivedShareEngine.storeFor({ engineWorkspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath, attachmentId: workspace.attachmentId }), workspace.workspaceId)
          : (await requireEngineCapture(workspace.workspaceId, "Engine history")).capture;
        assertCurrent();
        const presentations = await identity.presentations();
        let resolved: Awaited<ReturnType<typeof dependencies.historyCollections>> | undefined;
        let pending: Promise<NonNullable<typeof resolved>> | undefined;
        // No Collection moments, for a History without them.
        const without = (why: Error): Pick<TimelineReads, "scope" | "local" | "remote"> => ({ scope: operation.scope ?? workspace.workspaceId,
          local: () => ({ pages: [], transferred: [], sourceIds: [], sourceCount: 0 }), remote: async () => { throw why; } });
        // Another computer keeps the Collections: History shows files and documents without them.
        const getCollections = () => pending ??= dependencies.historyCollections(operation).catch((error: unknown) => {
          if (error instanceof CollectionsRefusalError) return without(error);
          throw error;
        }).then(value => { assertCurrent(); resolved = value; return value; });
        const collections: Pick<TimelineReads, "scope" | "local" | "remote"> = shared
          ? without(new Error("Collection History is unavailable in a received share."))
          : { get scope() { return resolved?.scope ?? operation.scope ?? workspace.workspaceId; },
            local: async (positions, limit, sourceIds) => (await getCollections()).local(positions, limit, sourceIds),
            remote: async (datasetId, beforeRevision, signal) => (await getCollections()).remote(datasetId, beforeRevision, signal) };
        return timeline(input, { ...collections, get scope() { return collections.scope; }, engine, signal: operation.signal, assertCurrent,
          names: authorNames(workspace.workspaceId, event.sender, presentations), ...(policy ? { admitted: historyPathAdmission(policy) } : {}) });
      },
    });

    registerHandler(CHANNELS.listEngineMoments, workspaceHandler(async (event, payload, operation) => {
      const input = ListEngineMomentsPayload.parse(payload);
      return readHistory(operation, async (history, rootPath, presentations, assertCurrent) => {
        const policy = rootPath === null ? null : await readWorkspaceEnginePolicy(rootPath);
        assertCurrent();
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
              assertCurrent();
              startCursor ??= page.startCursor;
              versionMarkers.push(...page.versionMarkers);
              const moments = admitted ? page.moments.filter(moment => moment.protected || admitted(moment.path)) : page.moments;
              if (moments.length > 0 || page.nextCursor === null || pageIndex + 1 >= pageReach) {
                return { ...page, moments, startCursor, versionMarkers };
              }
              if (pageIndex === 0 && admitted && input.objectId !== undefined) {
                const objectPath = await history.filePathForObjectId?.(input.objectId);
                assertCurrent();
                if (objectPath != null && !admitted(objectPath)) {
                  return { ...page, moments, nextCursor: null, startCursor, versionMarkers };
                }
              }
              cursor = page.nextCursor;
            }
          },
          authorNames(input.workspaceId, event.sender, presentations),
        );
      });
    }));

    registerHandler(CHANNELS.readEngineMoment, workspaceHandler(async (event, payload, operation) => {
      const input = ReadEngineMomentPayload.parse(payload);
      return readHistory(operation, async (history, rootPath, presentations, assertCurrent) => {
        const policy = rootPath === null ? null : await readWorkspaceEnginePolicy(rootPath);
        assertCurrent();
        if (policy?.errors.length) return ReadEngineMomentResult.parse({ ...policyUnreadable(policy), moment: null });
        const moment = await history.readMoment(input.momentId);
        assertCurrent();
        if (moment && !moment.protected && policy && !historyMomentPathsAdmitted(historyPathAdmission(policy), moment.moment)) {
          return ReadEngineMomentResult.parse({ status: "untracked", moment: null });
        }
        const names = authorNames(input.workspaceId, event.sender, presentations);
        if (moment && !moment.protected && moment.moment.authors) names.prepare?.(moment.moment.authors);
        return ReadEngineMomentResult.parse({
          moment: moment ? engineMomentDetailForIpc(moment, names) : null,
        });
      });
    }));

    registerHandler(CHANNELS.restoreEngineMomentFile, workspaceHandler(async (event, payload) => {
      const input = RestoreEngineMomentFilePayload.parse(payload);
      const person = await localPerson();
      const { capture } = await requireEngineCapture(
        input.workspaceId,
        "Engine history",
      );
      const result = await capture.restoreFileToBeforeMoment(input.momentId, person);
      notifyRenderer({ workspaceId: input.workspaceId });
      return RestoreEngineMomentFileResult.parse(result);
    }));
  }

  function registerStatusAndRepair(): void {
    registerHandler(CHANNELS.getSyncStatus, workspaceHandler(async (event, payload, operation) => {
      const input = WorkspaceIdPayload.parse(payload);
      const workspace = operation.workspace;
      return SyncStatusResult.parse(
        await syncStatusWithOwnedProjection(
          workspace,
          activity.getStatus(input.workspaceId),
        ),
      );
    }));
    registerOperations<typeof captureRecoveryOperations, Event, Operation>({
      handle: registerHandler,
      assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, message, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, message, work),
    }, captureRecoveryOperations, {
      retryHeldCapture: async (input, { event }) => {
        return withRendererWorkspaceOperation(event.sender, input.workspaceId, "This workspace is no longer active.", async operation => {
          const result = await withEngineAdapter(operation.workspace, adapter => adapter.retryHeldCapture(input.path));
          if (result === null) throw new Error("The workspace engine is not running.");
          dependencies.recordHeldFiles(operation.workspace, result.heldFiles);
          return result;
        });
      },
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

    registerHandler(CHANNELS.rebuildEngineStore, workspaceHandler(async (event, payload, operation) => {
      const input = RebuildEngineStorePayload.parse(payload);
      const registered = operation.workspace;
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
    }));
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
