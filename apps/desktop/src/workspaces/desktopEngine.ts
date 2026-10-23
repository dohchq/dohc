import { installedReaderConfig } from "./installedReaderConfig";
import {reconcileOwnerLiveStops, type OwnerStopRetirementTarget} from "./ownerLiveStop";
import { waitForEnginePublicationGate } from "./testEnginePublicationGate";
import type { App, Dialog } from "electron";
import {
  EngineWorkspaceSessions,
  type EngineDaemonLifecycle,
  type EngineWorkspace,
  type createRustEngineDaemon as createRustEngineDaemonImplementation,
  type defaultEngineBinaryPath as defaultEngineBinaryPathImplementation,
} from "@dohc/workspace-engine-client/daemon";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import {
  CAPTURE_INITIAL_SETTLED_EVENT, COLLECTIONS_PROJECTED_EVENT, bridgeCaptureEventsToRenderer, bridgeNoAtomicPlacement,
} from "./captureActivityBridge";
import { bridgeAutomationClaimsToExecutors } from "./automationClaimsBridge";
import type { WorkspaceActivityScope } from "../ipc/workspaceActivityBroadcast";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";
import { readLocalStateFrom } from "./workspaceLocalState";
import type { WorkspaceAuthorityOperation, WorkspaceAuthorityLease } from "./workspaceAuthorityOwner";
import type { launchMarks as launchMarksImplementation } from "../performance/launchMarks";
import type { desktopMarks as desktopMarksImplementation } from "../performance/desktopMarks";
import {EngineClient, EngineRequestError} from "@dohc/workspace-engine-client/daemon";
import type {ExistingOwnerDeviceConfig} from "@dohc/sync-relay/device-host";
import type {readDesktopOwnerHostConfig,startDesktopOwnerHost} from "./desktopOwnerHost";

import type {DesktopOwnerDeliveryConfig, startDesktopOwnerDelivery} from "./desktopOwnerDelivery";
import type {OwnerKnownRefusals} from "./ownerYDocOutbox";
import {relayUrlsMatch} from "./syncCode";
import {readyOwnerDeliveryDocuments, startServerOwnerDelivery} from "./serverOwnerDelivery";
import {readOwnerLiveQuarantines, readOwnerLiveQueue, retryOwnerLiveQuarantine, type OwnerLiveHeadCache, type OwnerLiveQuarantineRecord} from "./ownerLiveQuarantine";
import {sameBinding, type UnwrittenReleases} from "./ownerLiveReleases";
import type {LiveRecoveryFiles} from "./ownerLiveRecoveryCopy";
import type {DocumentProjection} from "./documentProjection";
import {createDurableFile} from "./workspaceFiles";
import {lstat} from "node:fs/promises";
import {join} from "node:path";
import type {OwnerLiveQuarantine} from "../ipc/bridgeContract";
import type {LiveObjectBinding} from "@dohc/workspace-engine-client";

export interface ServerOwnerDelivery {
  prepare(): Promise<Omit<DesktopOwnerDeliveryConfig, "relayUrl" | "documents">>;
  workspaceIds(): string[];
  hasRefusals(workspaceId: string): boolean | undefined;
  connect(workspace: RegistryEntry, signal: AbortSignal): Promise<{
    bearer: string; accountId: string; relayUrl: string; signal: AbortSignal;
    assertCurrent(): void;
    refusals(attempt: AbortSignal): Promise<void>;
    documents(signal: AbortSignal): Promise<unknown>;
    retire(binding: OwnerStopRetirementTarget, signal: AbortSignal): Promise<number | null>;
  } | null>;
}
/**
 * Whether this workspace has no ordinary sync configured: Stop sync saved a
 * pause, or the folder was attached again as local work. Sign-out, a lost
 * connection and a detach keep its remote.
 */
export function hasNoOrdinarySync(entry: RegistryEntry | null): boolean {
  return entry !== null && !entry.remote && entry.joinBootstrapPending !== true &&
    !shareViewIsPresent(entry.shareView);
}

export type OwnerLiveDeliveryStatus = "preparing" | "active" | "retrying";
type OwnerLiveDeliveryReason = "document-unavailable" | "workspace-changed" | "session-host-refused" | "session-host-diverged" | "live-document-without-lineage" | "live-edit-unadmitted" | "restart-required";

type EngineAuthorityState = {
  collectionAutomations: CollectionAutomationsLifecycle;
};

/** The Collection automation executor's part in an engine restart. */
interface CollectionAutomationsLifecycle {
  notifyClaimed(): void;
  failuresChanged(): void;
  pauseForEngineRestart(): void;
  resumeAfterEngineRestart(): void;
}

interface DesktopEngineDependencies<State extends EngineAuthorityState> {
  resourcesBasePath(): string;
  onWorkspaceOpened?(workspaceId: string): void;
  onRefusalsChanged?: () => void;
  serverOwnerDelivery?: ServerOwnerDelivery;
  /** Stops that took refused edits out of their queue but did not write the file. */
  ownerLiveReleases: UnwrittenReleases;
  /** Builds a recovery copy's Markdown off main. */
  documentProjection: DocumentProjection;
  ownerDeliveryCredentials?(): {bearer: string; accountId: string; relayUrl: string; signal: AbortSignal} | null;
  existingOwnerFor?: ExistingOwnerDeviceConfig["ownerFor"];
  findWorkspace(workspaceId: string): RegistryEntry | null;
  app: Pick<App, "isPackaged" | "getAppPath">;
  dialog: Pick<Dialog, "showErrorBox">;
  process: { env: NodeJS.ProcessEnv; resourcesPath?: string };
  createRustEngineDaemon: typeof createRustEngineDaemonImplementation;
  defaultEngineBinaryPath: typeof defaultEngineBinaryPathImplementation;
  isQuitting(): boolean;
  // Keeps an engine failure in the crash report on this computer.
  recordEngineProblem(error: unknown, stage: "restarting" | "stopped" | "startup"): void;
  workspaceAuthorities: {
    workspaceIds(): string[];
    withOperation?<Result>(workspaceId: string, work: (operation: WorkspaceAuthorityOperation<RegistryEntry, State>) => Result | Promise<Result>): Promise<Result>;
    withAuthority<Result>(
      workspaceId: string,
      work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  collectionAutomations: { current(workspaceId: string): Pick<CollectionAutomationsLifecycle, "notifyClaimed" | "failuresChanged"> | undefined };
  notifyRenderer(scope?: WorkspaceActivityScope): void;
  // The engine announced that a workspace's drive has no rename that refuses
  // to replace a file.
  noteNoAtomicPlacement(workspaceId: string): void;
  notifyOwnerDeliveryChanged?(workspaceId: string): void;
  launchMarks: Pick<typeof launchMarksImplementation, "daemonReady">;
  desktopMarks: Pick<typeof desktopMarksImplementation, "markOnce">;
  logLaunchMarksOnce(): void;
}

export function createDesktopEngine<State extends EngineAuthorityState>(
  dependencies: DesktopEngineDependencies<State>,
) {
  const {
    app, dialog, process, createRustEngineDaemon, defaultEngineBinaryPath,
    isQuitting, recordEngineProblem, workspaceAuthorities, notifyRenderer,
    launchMarks, desktopMarks, logLaunchMarksOnce,
  } = dependencies;

  let rustEngineDaemon: EngineDaemonLifecycle | null = null;
  // A failure since the engine last launched is already in the crash report.
  let engineProblemRecorded = false;
  let rustEngineWorkspaceSessions: EngineWorkspaceSessions | null = null;
  // Writers of this computer's state ask the current binding, so readiness
  // ends when its open closes, rebinds or fails.
  readLocalStateFrom({
    currentBinding: workspace => rustEngineWorkspaceSessions?.currentBinding(workspace) ?? null,
    openInProgress: workspace => rustEngineWorkspaceSessions?.openInProgress(workspace) ?? null,
  });
  let rustEngineRelayClient: EngineRelayClient | null = null;
  let rustEngineSessionSource: RelayConfiguredDaemonClientSource | null = null;
  let ownerHost: ReturnType<typeof startDesktopOwnerHost> | undefined;
  let ownerHostConfig: ReturnType<typeof readDesktopOwnerHostConfig> | undefined;
  let ownerHostModule: typeof import("./desktopOwnerHost") | undefined;
  let ownerHostGeneration = 0;
  let ownerWorkspaceCloses = 0;
  let ownerDelivery: (ReturnType<typeof startDesktopOwnerDelivery> & {retry?(workspaceId: string): void}) | undefined;
  let ownerDeliveryConfig: DesktopOwnerDeliveryConfig | undefined;
  let ownerDeliveryModule: typeof import("./desktopOwnerDelivery") | undefined;
  let nativeOwnerDeliveryModule: typeof import("./nativeOwnerDelivery") | undefined;
  // Outlives every owner delivery pass and connection.
  let ownerRefusals: OwnerKnownRefusals | undefined;
  let ownerDeliverySettled = Promise.resolve();
  let ownerDeliveryGeneration = 0;
  let serverOwnerConfig: Awaited<ReturnType<ServerOwnerDelivery["prepare"]>> | undefined;
  const ownerDeliveryStatus = new Map<string, OwnerLiveDeliveryStatus>();
  let serverOwnerUnavailable = false;
  let activeOwnerWorkspace: string | undefined;
  const failedOwnerDocuments = new Map<string, Set<string>>();
  const frozenOwnerDocuments = new Map<string, Set<string>>();
  const ownerDeliveryReason = new Map<string, OwnerLiveDeliveryReason>();
  const ownerStopFailures = new Map<string, Map<string,{path:string;detail:string}>>();
  // Documents whose edits the server refused for good, read from the engine's
  // durable queues, so a restart shows them again. Each Try again the owner
  // asked for counts by queue, so a refusal after it is a new incident.
  const ownerQuarantines = new Map<string, OwnerLiveQuarantineRecord[]>();
  const ownerQuarantineReads = new Map<string, number>();
  const ownerQuarantineAttempts = new Map<string, number>();
  const ownerQuarantineHeads = new Map<string, OwnerLiveHeadCache>();
  const quarantineIncident = (row: OwnerLiveQuarantineRecord) => row.outboxId !== null
    ? `${row.outboxId}:${row.headDeliveryId}:${ownerQuarantineAttempts.get(row.outboxId) ?? 0}`
    : row.binding ? `release:${row.binding.lineageClaimId}:${row.binding.restoreFenceGeneration}` : `release:${row.objectId}`;
  // Returns its own rows, which the caller can trust even when a later read owns the cache.
  async function readOwnerQuarantinesInto(workspaceId: string, client: EngineClient, workspaceHandle: string): Promise<OwnerLiveQuarantineRecord[]> {
    const read = (ownerQuarantineReads.get(workspaceId) ?? 0) + 1;
    ownerQuarantineReads.set(workspaceId, read);
    const heads = ownerQuarantineHeads.get(workspaceId) ?? new Map();
    ownerQuarantineHeads.set(workspaceId, heads);
    const rows = await readOwnerLiveQuarantines(client, workspaceHandle,
      {heads, unwritten: await dependencies.ownerLiveReleases.list(workspaceId)});
    // A later read owns the answer.
    if (ownerQuarantineReads.get(workspaceId) !== read) return rows;
    const before = JSON.stringify(ownerQuarantines.get(workspaceId) ?? []);
    if (rows.length) ownerQuarantines.set(workspaceId, rows); else ownerQuarantines.delete(workspaceId);
    if (JSON.stringify(rows) !== before) notifyRenderer({workspaceId});
    return rows;
  }
  /**
   * Releases a Stop's queue into the document. For refused edits, a recovery
   * package and a record are written first: once the release commits, the
   * queue is gone, and they keep the notice, its Try again and Save recovery
   * copy until the file holds the edits, or a recovery copy does.
   */
  async function releaseOwnerLiveStop(workspaceId: string, client: EngineClient, workspaceHandle: string,
    binding: LiveObjectBinding, acceptedCursor: number, signal?: AbortSignal) {
    const kept = (await readOwnerQuarantinesInto(workspaceId, client, workspaceHandle))
      .find(row => row.objectId === binding.objectId && row.outboxId !== null && row.binding.lineageClaimId === binding.lineageClaimId);
    if (kept?.outboxId) {
      const {liveRecoveryPackage} = await import("./ownerLiveRecoveryCopy");
      const queue = await readOwnerLiveQueue(client, workspaceHandle, kept);
      await dependencies.ownerLiveReleases.put({workspaceId, objectId: binding.objectId, path: kept.path, reason: kept.reason, binding, retry: true},
        JSON.stringify(liveRecoveryPackage(queue, {path: kept.path, reason: kept.reason, storedOn: "this-computer"})));
    }
    const released = await client.ownerYDocRelease({id: 0, workspace: workspaceHandle, deadlineMs: 30_000}, binding, acceptedCursor, signal);
    // A written file ends this binding's record; a deferred release leaves the edits in their queue.
    if (released.materialized === true || (released.deferred && kept)) await dependencies.ownerLiveReleases.remove(workspaceId, binding.objectId, binding);
    return released;
  }
  function refreshOwnerLiveQuarantines(workspace: EngineWorkspace): Promise<void> {
    const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions;
    if (!daemon || !sessions) return Promise.resolve();
    return sessions.run(workspace, async binding => {
      const client = daemon.currentClient();
      if (client instanceof EngineClient) await readOwnerQuarantinesInto(workspace.workspaceId, client, binding.workspace);
    });
  }
  async function withEngineClient<Result>(workspace: EngineWorkspace, work: (client: EngineClient, workspaceHandle: string) => Promise<Result>): Promise<Result> {
    const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions;
    if (!daemon || !sessions) throw new Error("dohc could not change live editing. Restart dohc and try again.");
    return sessions.run(workspace, async binding => {
      const client = daemon.currentClient();
      if (!(client instanceof EngineClient)) throw new Error("dohc could not change live editing. Restart dohc and try again.");
      return work(client, binding.workspace);
    });
  }
  // A failed read keeps the last answer: the queues are still on this computer.
  const readQuarantinesAfterPass = (workspaceId: string, client: EngineClient, workspaceHandle: string) =>
    readOwnerQuarantinesInto(workspaceId, client, workspaceHandle)
      .catch(error => console.error("[desktop] owner live quarantine read failed:", error));
  // A refusal starts or renews a quarantine; one already read as waiting stays
  // as read. An acceptance can end only a quarantine already read.
  const quarantinesMayChange = (workspaceId: string, objectId: string, outcome: string) => {
    const recovery = ownerQuarantines.get(workspaceId)?.find(row => row.objectId === objectId)?.recovery;
    return outcome === "frozen" ? recovery === undefined || recovery === "retrying" : outcome === "acknowledged" && recovery !== undefined;
  };
  const refusedPaths = (workspaceId: string) => new Set((ownerQuarantines.get(workspaceId) ?? []).map(row => row.path));
  const setOwnerDeliveryStatus = (workspaceId: string, status: OwnerLiveDeliveryStatus | undefined, reason?: OwnerLiveDeliveryReason) => {
    if (ownerDeliveryStatus.get(workspaceId) === status && ownerDeliveryReason.get(workspaceId) === reason) return;
    if (status) ownerDeliveryStatus.set(workspaceId, status); else ownerDeliveryStatus.delete(workspaceId);
    if (reason) ownerDeliveryReason.set(workspaceId, reason); else ownerDeliveryReason.delete(workspaceId);
    dependencies.notifyOwnerDeliveryChanged?.(workspaceId);
  };
  function stopOwnerDelivery(): Promise<void> {
    ownerDeliveryGeneration += 1;
    for (const id of ownerDeliveryStatus.keys()) setOwnerDeliveryStatus(id, undefined);
    failedOwnerDocuments.clear();
    frozenOwnerDocuments.clear();
    ownerStopFailures.clear();
    const previous = ownerDelivery;
    ownerDelivery = undefined;
    if (previous) ownerDeliverySettled = Promise.all([ownerDeliverySettled, previous.stop()]).then(() => undefined);
    return ownerDeliverySettled;
  }
  function startOwnerDelivery(): void {
    const settled = stopOwnerDelivery(), generation = ownerDeliveryGeneration;
    void settled.then(() => {
      const server = dependencies.serverOwnerDelivery;
      if (server && serverOwnerConfig && rustEngineDaemon && rustEngineWorkspaceSessions && rustEngineSessionSource &&
        generation === ownerDeliveryGeneration && !isQuitting() && !ownerWorkspaceCloses) {
        const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions, source = rustEngineSessionSource;
        const profile = serverOwnerConfig;
        ownerDelivery = startServerOwnerDelivery({workspaceIds: () => server.workspaceIds(), ...profile,
          onError: error => console.error("[desktop] server owner delivery failed:", error),
          runPass: async (workspaceId, index, lifetime) => {
            if (!workspaceAuthorities.withOperation) throw new Error("This build is missing a dependency required for live editing.");
            activeOwnerWorkspace = workspaceId;
            try {return await workspaceAuthorities.withOperation(workspaceId, async operation => {
              const session = await server.connect(operation.workspace, AbortSignal.any([lifetime, operation.signal]));
              if (!session) {setOwnerDeliveryStatus(workspaceId, undefined); return {documentCount: 0, acknowledged: false};}
              const signal = AbortSignal.any([lifetime, operation.signal, session.signal]);
              const check = () => {
                signal.throwIfAborted(); operation.assertCurrent(); session.assertCurrent();
                if (generation !== ownerDeliveryGeneration || isQuitting()) throw new Error("This live editing session ended.");
              };
              check();
              try {
              try {await session.refusals(signal);}
              catch (error) {check(); console.error("[desktop] owner live refusal discovery failed:", error);}
              try {await sessions.run(operation.workspace,async binding => {
                const client=daemon.currentClient();
                if (!(client instanceof EngineClient)) throw new Error("Owner Stop requires the desktop daemon client.");
                let stopsChanged=false;
                await reconcileOwnerLiveStops({client,workspaceHandle:binding.workspace,workspaceId,signal,
                  release:(target,acceptedCursor,releaseSignal) => releaseOwnerLiveStop(workspaceId,client,binding.workspace,target,acceptedCursor,releaseSignal),
                  onError:(row,error) => {
                    stopsChanged=true;
                    const failures=ownerStopFailures.get(workspaceId) ?? new Map();
                    const detail=error instanceof Error ? error.message : String(error);
                    failures.set(row.document.objectId,{path:row.document.currentPath,detail});
                    ownerStopFailures.set(workspaceId,failures);notifyRenderer({workspaceId});
                  },
                  onComplete:row => {stopsChanged=true;if (ownerStopFailures.get(workspaceId)?.delete(row.document.objectId)) notifyRenderer({workspaceId});},
                  retire:session.retire,assertCurrent:() => {check();sessions.assertCurrentBinding(operation.workspace,binding);}});
                // A Stop that finished or failed in the background changes what the
                // notices say, even when no live document remains to deliver.
                if (stopsChanged) await readQuarantinesAfterPass(workspaceId,client,binding.workspace);
              });
              } catch (error) {check();console.error("[desktop] owner Stop discovery failed:",error);}
              const response = await session.documents(signal);
              const documents = readyOwnerDeliveryDocuments(response, workspaceId);
              check();
              const {documents: rows, diverged} = response as {documents: {status: string; reason?: unknown}[]; diverged?: unknown};
              const preparing = rows.some(row => row.status === "preparing");
              // The server reports a diverged copy even after its owner stopped every document.
              const unavailable = diverged === true || rows.some(row => row.status === "unavailable");
              const unavailableFor = (reason: OwnerLiveDeliveryReason) => rows.some(row => row.status === "unavailable" && row.reason === reason);
              // A document the server refused stays stopped until its owner tries again, so no other reason hides it.
              // One it cannot start goes before it: the owner must open it before a Resume can help.
              // One that changed while live editing was off follows both: no Resume continues it.
              // A diverged server copy goes first: only the server's operator can continue it.
              const reason = diverged === true ? "session-host-diverged" :
                unavailableFor("live-document-without-lineage") ? "live-document-without-lineage" :
                unavailableFor("session-host-refused") ? "session-host-refused" :
                unavailableFor("live-edit-unadmitted") ? "live-edit-unadmitted" :
                unavailableFor("workspace-changed") ? "workspace-changed" :
                unavailableFor("document-unavailable") ? "document-unavailable" : undefined;
              const ownerMustAct = reason === "session-host-diverged" || reason === "live-document-without-lineage" ||
                reason === "session-host-refused" || reason === "live-edit-unadmitted";
              const failures = failedOwnerDocuments.get(workspaceId) ?? new Set<string>();
              const frozen = frozenOwnerDocuments.get(workspaceId) ?? new Set<string>();
              for (const path of failures) if (!documents.some(document => document.binding.currentPath === path)) failures.delete(path);
              for (const path of frozen) if (!documents.some(document => document.binding.currentPath === path)) frozen.delete(path);
              failedOwnerDocuments.set(workspaceId, failures);
              frozenOwnerDocuments.set(workspaceId, frozen);
              if (!documents.length) {
                setOwnerDeliveryStatus(workspaceId, unavailable ? "retrying" : preparing ? "preparing" : undefined, reason);
                return {documentCount: 0, acknowledged: false};
              }
              const document = documents[index % documents.length]!;
              nativeOwnerDeliveryModule ??= await import("./nativeOwnerDelivery");
              check();
              const native = nativeOwnerDeliveryModule;
              const result = await sessions.run(operation.workspace, async binding => {
                const client = daemon.currentClient();
                if (!(client instanceof EngineClient)) throw new Error("Owner delivery requires the desktop daemon client.");
                const assertCurrent = () => {
                  check(); sessions.assertCurrentBinding(operation.workspace, binding);
                  if (daemon.currentClient() !== client || binding.client !== source.currentClient()) throw new Error("This live editing session ended.");
                };
                assertCurrent();
                const outcome = await native.runNativeOwnerDeliveryPass({client, workspaceHandle: binding.workspace,
                  document, config: {...profile, relayUrl: session.relayUrl, documents}, refusals: ownerRefusals ??= new native.OwnerKnownRefusals(),
                  signal, bearer: session.bearer, accountId: session.accountId, assertCurrent});
                if (quarantinesMayChange(workspaceId, document.binding.objectId, outcome)) await readQuarantinesAfterPass(workspaceId, client, binding.workspace);
                return outcome;
              });
              check();
              // A document the server refused names itself in its own notice. It
              // is not retrying, and the rest of the workspace keeps delivering.
              const path = document.binding.currentPath;
              const blocked = result === "frozen" && !refusedPaths(workspaceId).has(path);
              if (result === "retry" || blocked) failures.add(path); else failures.delete(path);
              if (blocked) frozen.add(path); else if (result !== "retry") frozen.delete(path);
              if (result === "acknowledged" || result === "frozen") notifyRenderer({workspaceId});
              setOwnerDeliveryStatus(workspaceId, failures.size || unavailable ? "retrying" : preparing ? "preparing" : "active",
                frozen.size && !ownerMustAct ? "document-unavailable" : reason);
              return {documentCount: documents.length, acknowledged: result === "acknowledged"};
              } catch (error) {
                if (!operation.signal.aborted && !session.signal.aborted && generation === ownerDeliveryGeneration && !isQuitting()) {
                  setOwnerDeliveryStatus(workspaceId, "retrying", ownerDeliveryReason.get(workspaceId));
                }
                throw error;
              }
            });} finally {activeOwnerWorkspace = undefined;}
          },
        });
        return;
      }
      if (generation !== ownerDeliveryGeneration || isQuitting() || ownerWorkspaceCloses || !ownerDeliveryConfig || !ownerDeliveryModule || !nativeOwnerDeliveryModule || !rustEngineDaemon || !rustEngineWorkspaceSessions || !rustEngineSessionSource) return;
      const config = ownerDeliveryConfig, daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions,
        source = rustEngineSessionSource, native = nativeOwnerDeliveryModule;
      ownerDelivery = ownerDeliveryModule.startDesktopOwnerDelivery({config,
        onError: error => console.error("[desktop] owner delivery failed:", error),
        runPass: async (document, lifetime) => {
          const credentials = dependencies.ownerDeliveryCredentials?.();
          const workspace = dependencies.findWorkspace(document.binding.workspaceId);
          if (!credentials || !relayUrlsMatch(credentials.relayUrl, config.relayUrl) || !workspace || workspace.pausedRemote) return "retry";
          if (!workspaceAuthorities.withOperation) throw new Error("This build is missing a dependency required for live editing.");
          return workspaceAuthorities.withOperation(document.binding.workspaceId, operation =>
            sessions.run(operation.workspace, async binding => {
              const client = daemon.currentClient();
              if (!(client instanceof EngineClient)) throw new Error("Owner delivery requires the desktop daemon client.");
              const signal = AbortSignal.any([lifetime, operation.signal, credentials.signal]);
              const assertCurrent = () => {
                signal.throwIfAborted(); operation.assertCurrent();
                sessions.assertCurrentBinding(operation.workspace, binding);
                if (generation !== ownerDeliveryGeneration || isQuitting() || daemon.currentClient() !== client || binding.client !== source.currentClient()) throw new Error("This live editing session ended.");
              };
              assertCurrent();
              const result = await native.runNativeOwnerDeliveryPass({client, workspaceHandle: binding.workspace,
                document, config, refusals: ownerRefusals ??= new native.OwnerKnownRefusals(),
                signal, bearer: credentials.bearer, accountId: credentials.accountId, assertCurrent});
              assertCurrent();
              if (quarantinesMayChange(document.binding.workspaceId, document.binding.objectId, result)) await readQuarantinesAfterPass(document.binding.workspaceId, client, binding.workspace);
              if (result === "acknowledged" || result === "frozen") notifyRenderer({workspaceId: document.binding.workspaceId});
              return result;
            }));
        },
      });
    }).catch(error => console.error("[desktop] owner delivery startup failed:", error));
  }
  const ownerUsesWorkspace = (workspaceId: string) => ownerHostConfig?.workspaceIds.includes(workspaceId) === true ||
    activeOwnerWorkspace === workspaceId ||
    (serverOwnerConfig !== undefined && dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) === true) ||
    ownerDeliveryConfig?.documents.some(document => document.binding.workspaceId === workspaceId) === true;
  const stopOwnerHost = () => {
    ownerHostGeneration += 1;
    const previous = ownerHost;
    ownerHost = undefined;
    previous?.stop();
  };
  const startOwnerHost = () => {
    stopOwnerHost();
    if (isQuitting() || ownerWorkspaceCloses || !ownerHostModule || !ownerHostConfig || !rustEngineDaemon || !rustEngineWorkspaceSessions || !rustEngineSessionSource || !dependencies.existingOwnerFor) return;
    const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions, source = rustEngineSessionSource, config = ownerHostConfig;
    const generation = ownerHostGeneration;
    ownerHost = ownerHostModule.startDesktopOwnerHost({config,ownerFor: dependencies.existingOwnerFor,
      onError: error => console.error("[desktop] owner host connection failed:",error),
      bindings: async () => {
        const client = daemon.currentClient();
        if (!(client instanceof EngineClient)) throw new Error("Owner host requires the desktop daemon client.");
        const workspaces = [];
        const bindingChecks: (() => void)[] = [];
        for (const workspaceId of config.workspaceIds) {
          const entry = dependencies.findWorkspace(workspaceId);
          if (!entry || entry.pausedRemote) continue;
          workspaces.push(await workspaceAuthorities.withAuthority(workspaceId,async lease => {
            lease.assertCurrent();
            const workspace = {workspaceId,rootPath: lease.binding.canonicalRootPath,attachmentId: lease.binding.attachmentId};
            return sessions.run(workspace, async binding => {
              lease.assertCurrent();
              if (daemon.currentClient() !== client || binding.client !== source.currentClient()) throw new Error("Owner host daemon changed.");
              bindingChecks.push(() => sessions.assertCurrentBinding(workspace, binding));
              return {workspaceId,workspaceHandle: binding.workspace};
            });
          }));
        }
        if (!workspaces.length) throw new Error("Owner host has no registered workspaces.");
        return {client,workspaces,assertCurrent: () => {
          if (isQuitting() || ownerHostGeneration !== generation || daemon.currentClient() !== client) throw new Error("This live editing session ended.");
          for (const check of bindingChecks) check();
        }};
      },
    });
  };
  // Settles with the daemon handshake (false = startup failed and the app will
  // quit). The whenReady continuation creates the window while the daemon
  // starts, so a fast renderer can ask for the engine before the handshake
  // settles; boot-time paths that need engine sessions await this first instead
  // of throwing the broken-invariant error at it.
  let engineDaemonStartup: Promise<boolean> = Promise.resolve(false);
  // A workspace that opens proves the engine's workspace work, so the startup
  // smoke runs only when none has opened by the time the launch settles.
  const startupSmoke = Promise.withResolvers<"run" | "skip">();
  const relayTransportRoutes = new RelayTransportRouteGuard();

  // Narrowing for the engine-access gates. The invariant is real:
  // every boot-time path that can reach the engine awaits engineDaemonStartup
  // first (openWorkspaceActivityWith, cloudStatus, the share-view file and
  // mount lanes), and a failed handshake
  // quits the app; this handle is nulled only on that
  // failure path. A later startup-smoke failure restarts the daemon without
  // nulling it. A throw here would mean that invariant broke, which must be
  // loud, not a silent drop to the legacy engine.
  function requireEngineSessions(): EngineWorkspaceSessions {
    if (!rustEngineWorkspaceSessions) {
      throw new Error("Rust engine workspace sessions are unavailable.");
    }
    return rustEngineWorkspaceSessions;
  }

  async function withOwnerHostPaused<Result>(
    pause: boolean,
    work: () => Promise<Result>,
  ): Promise<Result> {
    if (!pause) return work();
    ownerWorkspaceCloses += 1;
    try {
      stopOwnerHost();
      await stopOwnerDelivery();
      return await work();
    } finally {
      ownerWorkspaceCloses -= 1;
      if (!ownerWorkspaceCloses) {startOwnerHost(); startOwnerDelivery();}
    }
  }

  async function closeRelayTransportWorkspace(
    workspace: string | EngineWorkspace,
  ): Promise<void> {
    const workspaceId =
      typeof workspace === "string" ? workspace : workspace.workspaceId;
    const reconnectOwner = ownerUsesWorkspace(workspaceId);
    await withOwnerHostPaused(reconnectOwner, async () => {
      if (rustEngineRelayClient) {
        await rustEngineRelayClient.closeWorkspace(workspace);
        return;
      }
      await rustEngineWorkspaceSessions?.closeWorkspace(workspace);
      relayTransportRoutes.releaseWorkspace(workspaceId);
    });
  }

  async function closeAllRelayTransportWorkspaces(options?: { accountChanged?: boolean }): Promise<void> {
    await withOwnerHostPaused(true, async () => {
      if (rustEngineRelayClient) {
        await rustEngineRelayClient.closeAll(options);
        return;
      }
      await rustEngineWorkspaceSessions?.closeAll();
      for (const workspaceId of relayTransportRoutes.workspaceIds()) {
        relayTransportRoutes.releaseWorkspace(workspaceId);
      }
    });
  }

  // Test-only daemon restart seam (hermetic E2E: the daemon-kill spec needs the
  // outage to outlive the transport retry window, which production restarts far
  // too fast to reach). Ignored outside DOHC_DESKTOP_TEST like every other
  // DOHC_TEST_* seam.
  function testEngineRestartOverrides(): {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
  } {
    if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return {};
    const backoff = Number(process.env.DOHC_TEST_ENGINE_RESTART_BACKOFF_MS);
    if (!Number.isFinite(backoff) || backoff <= 0) return {};
    return { initialBackoffMs: backoff, maxBackoffMs: backoff };
  }

  async function startRustEngineDaemon(): Promise<boolean> {
    const restartingCollectionAutomations = new Set<CollectionAutomationsLifecycle>();
    // Everything, including resolving the binary path, runs inside the try: a
    // throw while building the options would otherwise reject this whenReady
    // callback and leave the user with no dialog, on the one path whose job is
    // to explain that the engine could not start.
    try {
      if (process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG) {
        if (!dependencies.existingOwnerFor) throw new Error("This build is missing a dependency required for live editing.");
        ownerHostModule = await import("./desktopOwnerHost");
        ownerHostConfig = ownerHostModule.readDesktopOwnerHostConfig(process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG);
      }
      if (process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG) {
        if (!dependencies.ownerDeliveryCredentials || !workspaceAuthorities.withOperation) throw new Error("This build is missing a dependency required for live editing.");
        ownerDeliveryModule = await import("./desktopOwnerDelivery");
        nativeOwnerDeliveryModule = await import("./nativeOwnerDelivery");
        ownerDeliveryConfig = ownerDeliveryModule.readDesktopOwnerDeliveryConfig(process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG);
      }
      if (!ownerHostConfig && !ownerDeliveryConfig && dependencies.serverOwnerDelivery) {
        if (!workspaceAuthorities.withOperation) throw new Error("This build is missing a dependency required for live editing.");
        try {
          serverOwnerConfig = await dependencies.serverOwnerDelivery.prepare();
          serverOwnerUnavailable = false;
        } catch (error) {
          serverOwnerConfig = undefined; serverOwnerUnavailable = true;
          console.error("[desktop] owner live setup unavailable:", error);
        }
      }
      const hostIngress = ownerHostConfig && {configPath: ownerHostConfig.nativeConfigPath,
        client: {aggregateBytes: ownerHostConfig.transport.aggregateBytes, maxUploads: ownerHostConfig.transport.maxUploads}};
      const peerIngress = ownerDeliveryConfig && {configPath: ownerDeliveryConfig.nativeConfigPath, client: ownerDeliveryConfig.nativeClient};
      if (hostIngress && peerIngress && (hostIngress.configPath !== peerIngress.configPath ||
        hostIngress.client.aggregateBytes !== peerIngress.client.aggregateBytes || hostIngress.client.maxUploads !== peerIngress.client.maxUploads)) throw new Error("Private owner modes require the same native ingress configuration and client budget.");
      const ingress = hostIngress ?? peerIngress ?? (serverOwnerConfig && {configPath: serverOwnerConfig.nativeConfigPath, client: serverOwnerConfig.nativeClient});
      let publications = 0;
      rustEngineDaemon = createRustEngineDaemon({
        readerConfig: installedReaderConfig(dependencies.resourcesBasePath()),
        ...(ingress ? {privateOwnerHost: ingress} : {}),
        startupSmoke: startupSmoke.promise,
        ...testEngineRestartOverrides(),
        command: defaultEngineBinaryPath({
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
        }),
        onFailure: (error, terminal) => {
          // The supervisor's diagnostic is for us: it names engine.ping, probe
          // counts and wedge budgets, which tell a developer or an agent exactly
          // which limit was hit. It goes to the log in full.
          console.error("[desktop] Rust engine daemon:", error);
          // One problem per crash: the first failure, not each restart
          // attempt after it, then the final verdict if restarts run out.
          if (!isQuitting() && (terminal || !engineProblemRecorded)) {
            recordEngineProblem(error, terminal ? "stopped" : "restarting");
            if (!terminal) engineProblemRecorded = true;
          }
          if (terminal && !isQuitting()) {
            // The dialog is for the user, so it says what broke and what to do
            // instead — no internal names, one instruction per sentence
            // (the dohc-interface skill). Use the same workspace engine name
            // as the runner settings.
            //
            // Cause-neutral on purpose: a terminal failure also arrives from the
            // restart limit and the crash window, where the engine crashed
            // rather than went silent. Every one of them ends the same way.
            dialog.showErrorBox(
              "The workspace engine stopped",
              "dohc stopped restarting the workspace engine.\n\n" +
                "Restart dohc. If this happens again, review the desktop logs. " +
                "If it continues, reinstall dohc.",
            );
          }
        },
        beforePublish: async signal => {
          const gate = process.env.DOHC_TEST_ENGINE_PUBLICATION_GATE;
          if (publications++ > 0 && process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && gate) await waitForEnginePublicationGate(gate, signal);
          stopOwnerHost();
          await stopOwnerDelivery();
          await Promise.all(workspaceAuthorities.workspaceIds().map((workspaceId) =>
            workspaceAuthorities.withAuthority(workspaceId, (lease) => {
              const automations = lease.state.collectionAutomations;
              automations.pauseForEngineRestart();
              restartingCollectionAutomations.add(automations);
            }),
          ));
        },
        // A capture event can die with the previous daemon's transport after its
        // moment committed; the replacement never re-emits it (its baseline finds
        // disk and manifest agreeing). One repaint per healthy launch closes that
        // staleness window. Scope-free: the lost event could have belonged to
        // any open workspace.
        onLaunch: () => {
          engineProblemRecorded = false;
          startOwnerHost();
          startOwnerDelivery();
          for (const automations of restartingCollectionAutomations) {
            automations.resumeAfterEngineRestart();
          }
          restartingCollectionAutomations.clear();
          notifyRenderer();
        },
      });
      await rustEngineDaemon.start();
      // Collection projection completion is a separate derived-state wake, and
      // so is the end of a new workspace's first read: reads refused during it
      // can be answered now. Workspace activity owns capture and file
      // observation delivery.
      bridgeCaptureEventsToRenderer({ onEvent: listener => rustEngineDaemon!.onEvent(event => {
        if (event.name === COLLECTIONS_PROJECTED_EVENT || event.name === CAPTURE_INITIAL_SETTLED_EVENT) listener(event);
      }) }, scope => notifyRenderer(scope ? { ...scope, pathSetChanged: false } : undefined));
      // The first placement that falls back on a drive without atomic
      // renames announces it at once; the capture health poll is a backstop.
      bridgeNoAtomicPlacement(rustEngineDaemon, dependencies.noteNoAtomicPlacement);
      // The daemon also claims each local record change for its subscribed
      // automations (ADR 0008); its automation.claimed events wake the owning
      // workspace's executors to drain the durable claim table, and a claim
      // inserted already failed (the depth cap's chain-stopped stop report)
      // tells the executor, which sends its failure notice.
      bridgeAutomationClaimsToExecutors(
        rustEngineDaemon,
        (workspaceId) => ({
          notifyClaimed() {
            dependencies.collectionAutomations.current(workspaceId)?.notifyClaimed();
          },
        }),
        (workspaceId) => dependencies.collectionAutomations.current(workspaceId)?.failuresChanged(),
      );
      const relaySource = new RelayConfiguredDaemonClientSource(
        rustEngineDaemon,
        relayTransportRoutes,
        workspaceId => hasNoOrdinarySync(dependencies.findWorkspace(workspaceId)),
      );
      rustEngineSessionSource = relaySource;
      // A fresh debug-engine adoption measured 18.7 s for 5,000 files and
      // 101.8 s for 15,000 files on the launch fixture; 120 s bounds that path
      // with headroom. The renderer names the wait.
      rustEngineWorkspaceSessions = new EngineWorkspaceSessions(relaySource, {
        workspaceOpenDeadlineMs: 120_000,
        onOpened: workspace => {
          startupSmoke.resolve("skip");
          dependencies.onWorkspaceOpened?.(workspace.workspaceId);
          // Refused edits wait in the engine's queues across restarts, so each open reads them again.
          void Promise.resolve().then(() => refreshOwnerLiveQuarantines(workspace))
            .catch(error => console.error("[desktop] owner live quarantine read failed:", error));
        },
      });
      const sessions = rustEngineWorkspaceSessions;
      rustEngineRelayClient = new EngineRelayClient({
        onRefusalsChanged: dependencies.onRefusalsChanged,
        sessions,
        routes: relayTransportRoutes,
        closeWorkspaceBinding: workspace => withOwnerHostPaused(
          ownerUsesWorkspace(workspace.workspaceId),
          () => sessions.closeWorkspaceBinding(workspace).catch(() => undefined),
        ),
      });
      startOwnerHost();
      startOwnerDelivery();
      console.info("[desktop] Rust engine daemon handshake complete.");
      // Marked here, where the handshake actually completes — the bootstrap
      // gate's await also covers the cached-settings read, which would inflate
      // this mark.
      launchMarks.daemonReady();
      desktopMarks.markOnce("daemon-ready");
      logLaunchMarksOnce();
      return true;
    } catch (error) {
      stopOwnerHost();
      await stopOwnerDelivery();
      const message =
        error instanceof Error ? error.message : "Unknown Rust engine startup error.";
      console.error("[desktop] Rust engine daemon failed to start:", error);
      recordEngineProblem(error, "startup");
      dialog.showErrorBox(
        "Rust engine failed to start",
        `${message}\n\nThe desktop cannot start without the Rust engine.`,
      );
      // Contained: a stop() throw here would reject engineDaemonStartup itself
      // and rethrow from every gated await instead of letting the caller's
      // quit land.
      await rustEngineDaemon?.stop().catch((stopError: unknown) => {
        console.error(
          "[desktop] Rust engine daemon stop after failed start:",
          stopError,
        );
      });
      rustEngineDaemon = null;
      rustEngineWorkspaceSessions = null;
      rustEngineRelayClient = null;
      rustEngineSessionSource = null;
      // The app lifecycle quits, after it checks for a build that fixes this.
      return false;
    }
  }

  return {
    retryOwnerDelivery(workspaceId: string): void {
      if (dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)) ownerDelivery?.retry?.(workspaceId);
    },
    ownerLiveDeliveryStatus(workspaceId: string): OwnerLiveDeliveryStatus | undefined {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) ? serverOwnerUnavailable ? "retrying" : ownerDeliveryStatus.get(workspaceId) : undefined;
    },
    ownerLiveStopFailures(workspaceId:string) {return [...(ownerStopFailures.get(workspaceId)?.values() ?? [])];},
    ownerLiveQuarantines(workspaceId: string): OwnerLiveQuarantine[] {
      return (ownerQuarantines.get(workspaceId) ?? []).map(row => ({objectId: row.objectId, path: row.path, reason: row.reason,
        storedOn: "this-computer", incident: quarantineIncident(row), recovery: row.recovery}));
    },
    refreshOwnerLiveQuarantines,
    /** Grants the refused head one more attempt, if the owner saw this incident. */
    async retryOwnerLiveQuarantine(workspace: EngineWorkspace, objectId: string, incident: string): Promise<void> {
      await withEngineClient(workspace, async (client, handle) => {
        // Read again, so a Try again never names a queue that already changed.
        const row = (await readOwnerQuarantinesInto(workspace.workspaceId, client, handle)).find(candidate => candidate.objectId === objectId);
        if (!row || row.outboxId === null || row.recovery !== "paused" || quarantineIncident(row) !== incident) {
          throw new Error("This document changed. Open Live documents to check it.");
        }
        const outboxId = row.outboxId;
        await retryOwnerLiveQuarantine(client, handle, {...row, outboxId});
        ownerQuarantineAttempts.set(outboxId, (ownerQuarantineAttempts.get(outboxId) ?? 0) + 1);
        // The grant leaves the queue's size as it was, so its head is read again.
        ownerQuarantineHeads.get(workspace.workspaceId)?.delete(outboxId);
        // The attempt is granted; a failed read must not report it as refused.
        await readQuarantinesAfterPass(workspace.workspaceId, client, handle);
      });
      ownerDelivery?.retry?.(workspace.workspaceId);
    },
    /** A Stop's release, recorded until the file holds any refused edits it took. */
    releaseOwnerLiveStop(workspace: EngineWorkspace, binding: LiveObjectBinding, acceptedCursor: number) {
      return withEngineClient(workspace, (client, handle) => releaseOwnerLiveStop(workspace.workspaceId, client, handle, binding, acceptedCursor));
    },
    /**
     * Resume clears a document's Stop. A release still owed to the file keeps
     * its record and recovery package: resuming does not write the file.
     */
    clearOwnerLiveStop(workspace: EngineWorkspace, path: string): Promise<void> {
      return withEngineClient(workspace, (client, handle) => client.ownerYDocStopClear({id: 0, workspace: handle, deadlineMs: 30_000}, path));
    },
    /**
     * Try again for a Stop whose release took refused edits but could not
     * write the file: settles that release again and never starts a new Stop.
     * When the engine no longer holds that release, nothing shows the file has
     * the edits: the record and its package stay, offering only Save recovery copy.
     */
    async retryOwnerLiveRelease(workspace: EngineWorkspace, objectId: string) {
      return withEngineClient(workspace, async (client, handle) => {
        const releases = dependencies.ownerLiveReleases;
        const binding = (await releases.list(workspace.workspaceId)).find(row => row.objectId === objectId && row.retry)?.binding;
        if (!binding) throw new Error("This document changed. Open Live documents to check it.");
        try {
          const released = await client.ownerYDocRelease({id: 0, workspace: handle, deadlineMs: 30_000}, binding, 0);
          if (released.materialized === true) await releases.remove(workspace.workspaceId, objectId, binding);
          return released;
        } catch (error) {
          if (!(error instanceof EngineRequestError && error.message === "owner-stop-conflict")) throw error;
          await releases.endRetry(workspace.workspaceId, objectId, binding);
          return undefined;
        } finally {
          await readQuarantinesAfterPass(workspace.workspaceId, client, handle);
        }
      });
    },
    /**
     * Save recovery copy: writes a document's kept edits next to its file, as
     * a lossless package and, when they rebuild the document, a readable copy.
     * The queue stays. It works while live editing is stopped, after a Stop
     * took the edits but could not write the file, and for any size. Saving a
     * Stop's stored package ends its record: the workspace now holds the edits.
     */
    async saveOwnerLiveRecoveryCopy(workspace: EngineWorkspace, path: string): Promise<LiveRecoveryFiles> {
      const recovery = await import("./ownerLiveRecoveryCopy");
      const releases = dependencies.ownerLiveReleases;
      const records = await releases.list(workspace.workspaceId);
      const read = await withEngineClient(workspace, async (client, handle) => {
        const row = (await readOwnerLiveQuarantines(client, handle)).find(candidate => candidate.path === path && candidate.outboxId !== null);
        // An earlier release's record goes first: the document's queue hides its row.
        const record = records.find(candidate => candidate.path === path) ?? records.find(candidate => candidate.objectId === row?.objectId);
        if (record && !(row?.outboxId && record.retry && sameBinding(record.binding, row.binding))) return {record};
        return row?.outboxId ? {queued: recovery.liveRecoveryPackage(await readOwnerLiveQueue(client, handle, row),
          {path: row.path, reason: row.reason, storedOn: "this-computer"})} : {};
      });
      let saved = read.queued;
      if (!saved) {
        const text = read.record ? await releases.recovery(workspace.workspaceId, read.record.objectId) : null;
        if (text === null) throw new Error("dohc has no kept edits for this file. Open Live documents to check it.");
        saved = recovery.parseLiveRecoveryPackage(text);
      }
      const files = await recovery.saveLiveRecoveryCopy(saved, {
        create: (relative, text) => createDurableFile(workspace.rootPath, relative, text),
        exists: relative => lstat(join(workspace.rootPath, relative)).then(() => true,
          (error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return false; throw error;}),
      }, dependencies.documentProjection);
      if (!read.queued && read.record) {
        await releases.remove(workspace.workspaceId, read.record.objectId, read.record.binding);
        await refreshOwnerLiveQuarantines(workspace).catch(error => console.error("[desktop] owner live quarantine read failed:", error));
      }
      return files;
    },
    clearOwnerLiveStopFailure(workspaceId:string,target:{objectId:string}|{path:string}) {
      const failures=ownerStopFailures.get(workspaceId);if (!failures) return;
      let changed=false;
      for (const [key,failure] of failures) {
        if ("objectId" in target ? key===target.objectId : failure.path===target.path) {failures.delete(key);changed=true;}
      }
      if (changed) notifyRenderer({workspaceId});
    },
    ownerLiveDeliveryReason(workspaceId: string): OwnerLiveDeliveryReason | undefined {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) ? serverOwnerUnavailable ? "restart-required" : ownerDeliveryReason.get(workspaceId) : undefined;
    },
    hasOwnerLiveRefusals(workspaceId: string): boolean | undefined {
      return dependencies.serverOwnerDelivery?.hasRefusals(workspaceId);
    },
    get daemon() { return rustEngineDaemon; },
    get sessions() { return rustEngineWorkspaceSessions; },
    get relayClient() { return rustEngineRelayClient; },
    get startup() { return engineDaemonStartup; },
    requireEngineSessions,
    withOwnerHostPaused: <Result>(work: () => Promise<Result>) => withOwnerHostPaused(true, work),
    closeRelayTransportWorkspace,
    closeAllRelayTransportWorkspaces,
    start() {
      engineDaemonStartup = startRustEngineDaemon();
      return engineDaemonStartup;
    },
    launchSettled() {
      startupSmoke.resolve("run");
    },
  };
}
