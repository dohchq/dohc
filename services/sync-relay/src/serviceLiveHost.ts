import {workspaceIsDeleted} from "./storage/accountDeletion";
import {parseServiceActivationConfig,parseServiceActivationTarget,ServiceActivationDriver,type ServiceActivationBlock,type ServiceActivationConfig,type ServiceActivationTarget,type ServiceCatchUp} from "./serviceActivationDriver";
import type {OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import {liveHostSignal, withLiveHostSignal} from "./liveHostSignal.js";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges.js";
import {parseNativeLiveSyncConfig} from "./liveSyncConfig.js";
import {LiveDocumentWork} from "./liveDocumentWork.js";
import {liveEditors} from "./liveEditors.js";
import {HeldReadBusyError, HeldReadTooLargeError, heldReadLane, queueLiveHostRequests} from "./liveHostRequests.js";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { createEngineClient, EngineRequestError, isHostedDocumentUnready } from "@dohc/workspace-engine-client/daemon";
import { OwnerYDocOutbox, VersionedLiveAdapter, type Event, type JsonValue } from "@dohc/workspace-engine-client";
import { RecoveryCopyRefusal, sameKeptEditsIdentity, type ServiceKeptEdits, type ServiceKeptEditsIdentity } from "./storage/serviceKeptEdits.js";
import type { LiveClaimLedger } from "./automationLiveClaims.js";
import { parseLiveDocumentKey, parseLiveUpdateIdentifier, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { LiveCommittedDelivery, type CommittedDeliveryOutcome } from "./liveCommittedDelivery.js";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory.js";
import type { LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import { parseLiveSettlementConfig, type LiveSettlementConfig } from "./liveSettlementConfig.js";
import {snapshotStopRestoreLookup} from "./liveRestoreDelivery.js";
import {relayError} from "./errors.js";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation.js";
import {parseLiveRestoreConfig, LiveRestorePreparation, type LiveRestoreConfig} from "./liveRestorePreparation.js";
import {parseServiceHostedReplicationConfig, ServiceHostedReplication} from "./serviceHostedReplication.js";
import {decodeHostedSyncResult, hostedWindowCovers, type HostedSyncMethodResultMap} from "@dohc/workspace-engine-client/relay-wire";
import {withStreamedContributions, withStreamedMarkdown, type HeldReadInvalidated, type StreamedBlob} from "./heldDocumentRoutes";
import type {ServiceActivationReplica} from "./serviceActivationDriver";
interface ServiceLiveHostConfig {
  readonly version: 1;
  readonly engineExecutable: string;
  readonly hostId: string;
  readonly instanceId: string;
  readonly workspaces: readonly ServiceWorkspace[];
  readonly ingress: { readonly aggregateBytes: number; readonly applicationWorkingReserveBytes: number; readonly maxUploads: number; readonly uploadDeadlineMs: number };
  readonly client: { readonly aggregateBytes: number; readonly maxUploads: number; readonly connectTimeoutMs: number; readonly requestDeadlineMs: number };
  readonly settlement?: LiveSettlementConfig;
  readonly restore?: LiveRestoreConfig;
  readonly sync?: ReturnType<typeof parseNativeLiveSyncConfig>;
  readonly activation?: ServiceActivationConfig;
  readonly adoption?: { readonly maxBytes: number; readonly maxEvents: number;
    readonly ownerOutbox: { readonly maxPendingBytes: number; readonly maxPendingAgeMs: number } };
  /**
   * Where the daemon copies an earlier store that needs migrations before its
   * owner's recovery copy, under `<root>/.recovery`, and how long preparing
   * one may take. Without it, no earlier store opens for recovery.
   */
  readonly recovery?: { readonly root: string; readonly preparationDeadlineMs: number };
}

function record(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) throw new TypeError("Invalid service host configuration.");
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("Invalid service host limit.");
  return value;
}
function path(value: unknown, directory: boolean): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new TypeError("Service host paths must be absolute and canonical.");
  const canonical = realpathSync(value);
  if ((process.platform === "win32" ? canonical.toLowerCase() !== value.toLowerCase() : canonical !== value) ||
    (directory ? !statSync(value).isDirectory() : !statSync(value).isFile())) throw new TypeError("Invalid service host path.");
  return value;
}

export type ServiceWorkspace = ReturnType<typeof parseServiceWorkspace>;
/**
 * The workspaces a host that started empty should hold, the documents it
 * hosts, and the documents that left but may remain in a hosted replica, at
 * their enrolled paths. A workspace stays attached while it has either kind.
 */
export interface ServiceHostedSet {
  readonly workspaces: readonly ServiceWorkspace[];
  readonly documents: readonly ServiceHostedDocument[];
  readonly departing: readonly ServiceHostedDocument[];
}
// The lineages whose kept queue stays frozen at its owner's refused adoption seed, and those whose queue holds another refused edit.
interface KeptHeads {readonly seeded: ReadonlySet<string>; readonly refused: ReadonlySet<string>}
interface ServiceHostedDocument {readonly workspaceId: string; readonly objectId: string; readonly path: string; readonly shareId: string}
function parseServiceWorkspace(item: unknown) {
  const row = record(item, ["root", "workspaceId", "maxRegistrations"], ["hostedReplication"]);
  return Object.freeze({ root: path(row.root, true), workspaceId: parseLiveUpdateIdentifier(row.workspaceId, "workspace ID"),
    maxRegistrations: integer(row.maxRegistrations),
    hostedReplication: row.hostedReplication === undefined ? undefined : parseServiceHostedReplicationConfig(row.hostedReplication) });
}
function assertSeparateWorkspaceRoots(roots: readonly string[]): void {
  for (const [index, root] of roots.entries()) for (const other of roots.slice(index + 1)) {
    const distance = relative(root, other);
    if (!distance || (!distance.startsWith(".." + sep) && distance !== ".." && !isAbsolute(distance)) ||
        (!relative(other, root).startsWith(".." + sep) && relative(other, root) !== ".." && !isAbsolute(relative(other, root)))) throw new TypeError("Service workspace roots must not overlap.");
  }
}
export async function deleteConfiguredServiceWorkspaceRoots(configPath: string, workspaceIds: readonly string[]): Promise<void> {
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || !("workspaces" in config) || !Array.isArray(config.workspaces)) throw new TypeError("Invalid service host configuration.");
  const roots = config.workspaces.map((workspace: unknown) => {
    const row = record(workspace, ["root", "workspaceId", "maxRegistrations"], ["hostedReplication"]);
    if (typeof row.root !== "string" || !isAbsolute(row.root) || resolve(row.root) !== row.root || typeof row.workspaceId !== "string") throw new TypeError("Invalid service workspace root.");
    return {root: row.root, workspaceId: row.workspaceId};
  });
  assertSeparateWorkspaceRoots(roots.map(row => row.root));
  for (const row of roots) if (workspaceIds.includes(row.workspaceId)) await rm(row.root, {recursive: true, force: true});
}
function checkServiceMembership(workspaces: readonly ServiceWorkspace[], targets: readonly ServiceActivationTarget[]) {
  if (new Set(workspaces.map(row => row.workspaceId)).size !== workspaces.length ||
    new Set(workspaces.map(row => process.platform === "win32" ? row.root.toLowerCase() : row.root)).size !== workspaces.length) throw new TypeError("Duplicate service workspace.");
  assertSeparateWorkspaceRoots(workspaces.map(row => row.root));
  for(const target of targets){
    const workspace=workspaces.find(row=>row.workspaceId===target.workspaceId);
    if(!workspace?.hostedReplication || targets.filter(row=>row.workspaceId===target.workspaceId).length>workspace.maxRegistrations)throw new Error("Service activation workspace is not configured.");
  }
}

/** Operator configuration only. Incoming document fields never supply these paths. */
export function readServiceLiveHostConfig(configPath: string, keepWorkspace: (id: string) => boolean = () => true): ServiceLiveHostConfig {
  const value = record(JSON.parse(readFileSync(path(configPath, false), "utf8")),
    ["version", "engineExecutable", "hostId", "instanceId", "workspaces", "ingress", "client"], ["settlement", "restore", "sync", "adoption", "activation", "recovery"]);
  // A host may start empty; `update` attaches workspaces as documents are shared.
  if (value.version !== 1 || !Array.isArray(value.workspaces)) throw new TypeError("Invalid service host configuration.");
  const workspaces = value.workspaces.filter(item => {
    if (!item || typeof item !== "object" || !("workspaceId" in item) || typeof item.workspaceId !== "string") return true;
    return keepWorkspace(item.workspaceId);
  }).map(parseServiceWorkspace);
  const ingress = record(value.ingress, ["aggregateBytes", "applicationWorkingReserveBytes", "maxUploads", "uploadDeadlineMs"]);
  const client = record(value.client, ["aggregateBytes", "maxUploads", "connectTimeoutMs", "requestDeadlineMs"]);
  const settlement = parseLiveSettlementConfig(value.settlement);
  const restore = parseLiveRestoreConfig(value.restore);
  const adoption = value.adoption === undefined ? undefined : (() => {
    const row = record(value.adoption, ["maxBytes", "maxEvents", "ownerOutbox"]);
    const outbox = record(row.ownerOutbox, ["maxPendingBytes", "maxPendingAgeMs"]);
    return Object.freeze({maxBytes: integer(row.maxBytes), maxEvents: integer(row.maxEvents),
      ownerOutbox: Object.freeze({maxPendingBytes: integer(outbox.maxPendingBytes), maxPendingAgeMs: integer(outbox.maxPendingAgeMs)})});
  })();
  const recovery = value.recovery === undefined ? undefined : (() => {
    const row = record(value.recovery, ["root", "preparationDeadlineMs"]);
    // The engine answers no request after 300 s.
    return Object.freeze({root: path(row.root, true), preparationDeadlineMs: integer(row.preparationDeadlineMs, 1, 300_000)});
  })();
  const parsedActivation=parseServiceActivationConfig(value.activation);
  const activation=parsedActivation ? {...parsedActivation, targets: parsedActivation.targets.filter(row => keepWorkspace(row.workspaceId))} : undefined;
  const sync=parseNativeLiveSyncConfig(value.sync,integer(ingress.aggregateBytes));
  checkServiceMembership(workspaces, activation?.targets ?? []);
  if(activation && (!adoption || !sync || !settlement || activation.maxCaptureBytes>Math.min(sync.policy.maxReadBytes,sync.policy.maxOutputBytes))){
    throw new Error("Service activation requires bounded native adoption, sync and settlement.");
  }
  const applicationWorkingReserveBytes = integer(ingress.applicationWorkingReserveBytes, 0);
  if (applicationWorkingReserveBytes === 0) throw new TypeError("Live application requires a positive applicationWorkingReserveBytes limit.");
  return Object.freeze({ version: 1, engineExecutable: path(value.engineExecutable, false),
    hostId: parseLiveUpdateIdentifier(value.hostId, "host ID"), instanceId: parseLiveUpdateIdentifier(value.instanceId, "instance ID"),
    workspaces: Object.freeze(workspaces),
    settlement, restore, adoption, activation, sync, recovery,
    ingress: Object.freeze({ aggregateBytes: integer(ingress.aggregateBytes), applicationWorkingReserveBytes,
      maxUploads: integer(ingress.maxUploads), uploadDeadlineMs: integer(ingress.uploadDeadlineMs, 1, 2_147_483_647) }),
    client: Object.freeze({ aggregateBytes: integer(client.aggregateBytes), maxUploads: integer(client.maxUploads),
      connectTimeoutMs: integer(client.connectTimeoutMs, 1, 2_147_483_647), requestDeadlineMs: integer(client.requestDeadlineMs, 1, 2_147_483_647) }),
  });
}

// Held reads running at once, waiting, and sharing one engine request.
const HELD_READS = {maxRunning: 2, maxQueued: 16, maxWaiters: 8} as const;
const held = new WeakSet<SyncRelayStorage>();
// An earlier store's recovery handle closes after this long without a page read.
const RECOVERY_IDLE_MS = 60_000;
// An engine refusal of an open with one of these codes proves it holds no
// handle for the store. Any other failure, an overloaded or expired request
// included, may follow an open that made one.
const RECOVERY_OPEN_REFUSALS = new Set(["INVALID_PARAMS", "CONFLICT"]);
// A page read failing with one of these says nothing about the store.
const RECOVERY_READ_TRANSIENT = new Set(["WORKSPACE_UNAVAILABLE", "OVERLOADED", "DEADLINE_EXCEEDED", "CANCELLED", "SESSION_EXPIRED"]);
const recoveryRefusal = (error: unknown) => new RecoveryCopyRefusal(
  !(error instanceof EngineRequestError) ? "server"
    : error.wireError?.message === "recovery-store-disk-full" ? "disk-space"
    : error.wireError?.message === "recovery-store-needs-update" ? "newer-schema"
    : error.wireError?.message === "recovery-store-busy" ? "busy" : "server");
/**
 * An attached workspace's hosted replica. `pulls` counts the pulls started and
 * `confirmed` numbers the last one that succeeded. A departing document is
 * gone from the replica only once a pull numbered at least its `announced`
 * value succeeded. `reached` numbers the last pull whose departed list
 * reached a document this host waits on, and says whether it listed it.
 * `dropped` is how many owners the last report said a page dropped because
 * its newly held list may leave some out, or 0 since a complete list.
 */
interface HostedAttachment {
  readonly handle: string; readonly hosted: ServiceHostedReplication; readonly replica: ServiceActivationReplica;
  readonly identity: ServiceKeptEditsIdentity;
  pulls: number; confirmed: number; readonly announced: Map<string, number>;
  readonly reached: Map<string, {pull: number; listed: boolean}>; dropped: number;
}
// Whether the departed list of a pull numbered at least `required` reached the document; for `goneSince`, without listing it.
const reachedSince = (attached: HostedAttachment, objectId: string, required: number) => (attached.reached.get(objectId)?.pull ?? 0) >= required;
const goneSince = (attached: HostedAttachment, objectId: string, required: number) =>
  reachedSince(attached, objectId, required) && !attached.reached.get(objectId)!.listed;

/** Owns one configured service incarnation and its durable delivery consumers. */
export async function startServiceLiveHost(options: {
  trustedAccount: OwnerOutboxAdmission["trustedAccount"];
  configPath: string;
  storage: SyncRelayStorage;
  history: LiveJournalHistoryAuthority;
  signal?: AbortSignal;
  frameChanges?: LiveHostChanges;
}) {
  const { storage, history } = options;
  const config = readServiceLiveHostConfig(options.configPath, id => !workspaceIsDeleted(options.storage,id));
  // An activation host registers when its first document activates, even if it starts empty.
  const preparing = config.activation !== undefined || config.workspaces.some(row => row.hostedReplication !== undefined);
  const standing = storage.captureStanding();
  if (!history.reconciled || held.has(storage)) throw new Error("Service host is unavailable.");
  const control = storage.getLiveHostControl();
  if (!control || control.configuredMode !== "service" || control.configuredHostId !== config.hostId || control.transition ||
    (control.registeredInstanceId !== null && control.registeredInstanceId !== config.instanceId)) throw new Error("Service host does not match provisioned control.");
  if (preparing && !config.activation && control.registeredConnectionId !== null) throw new Error("Hosted service preparation requires an unregistered host.");
  const coordinate: LiveHostConnectionCoordinate = Object.freeze({ mode: "service", hostId: config.hostId, hostEpoch: control.hostEpoch,
    instanceId: config.instanceId, connectionId: randomUUID() });
  const host = { hostId: coordinate.hostId, hostEpoch: coordinate.hostEpoch, instanceId: coordinate.instanceId, connectionId: coordinate.connectionId };
  const invalidated = new AbortController();
  const lifetime = liveHostSignal(storage.unavailable, invalidated.signal, options.signal);
  const signal = lifetime.signal;
  const changes = options.frameChanges;
  const scope = Scope.makeUnsafe();
  const consumers = new Map<string, LiveCommittedDelivery>();
  const documents = new LiveDocumentWork();
  const attachments = new Map<string, HostedAttachment>();
  // An attached workspace whose replica checked its origin. Activation, restore and departures reach no other.
  const checked = (workspaceId: string) => {
    const attached = attachments.get(workspaceId);
    return attached?.hosted.checked ? attached : undefined;
  };
  const ledgers = new Map<string, LiveClaimLedger>();
  // Attached workspaces and hosted documents, as `update` last left them.
  const members = new Map<string, {handle: string; workspace: ServiceWorkspace}>();
  const hosted = new Map<string, {target: ServiceActivationTarget; objectId: string}>();
  // Hosted documents that left the hosted set. Passes settle, publish and unload them.
  const leaving = new Set<string>();
  // Leaving documents an earlier daemon may have left unsettled. Each resumes its retained activation before it unloads.
  const recovering = new Set<string>();
  // Documents an earlier daemon left that are no longer at their enrolled path, by workspace and object, never by
  // path, so a document now at that path changes nothing. Each stays, unsettled and outside activation, only while
  // its owner has no recovery copy of edits this host refused, and keeps its workspace attached so they can still
  // read them from its store.
  // `ended` is set once no Try again of its queues stays granted.
  const retained = new Map<string, {target: ServiceActivationTarget; objectId: string; ended?: boolean}>();
  const documentKey = (document: {workspaceId: string; objectId: string}) => JSON.stringify([document.workspaceId, document.objectId]);
  // Leaving documents the engine refused as not ready, with the number of the pull that must succeed before they are known parked.
  const parking = new Map<string, number>();
  // Whether an update completed on this daemon.
  let updated = false;
  // The stores whose replica diverged, with their workspaces. None of these stores attaches again on this daemon, and each stays where it is.
  const diverged = new Map<string, string>();
  // When each hosted document is due to unload with no live connection, and
  // the count of connection changes it last saw. An idle unload that started
  // under an older count was overtaken by a connection.
  const editors = liveEditors(storage), idle = new Map<string, {due: number; generation: number}>();
  // Hosted documents whose idle unload is running, or was sent and got no reply.
  const unloading = new Set<string>();
  let generation = 0;
  const hostedKey = (document: {workspaceId: string; objectId: string}) => {
    for (const [key, row] of hosted) if (row.target.workspaceId === document.workspaceId && row.objectId === document.objectId) return key;
    return undefined;
  };
  const touch = (key: string) => {idle.set(key, {due: Date.now() + config.activation!.idleUnloadMs, generation: ++generation});};
  // Activation passes, idle unloads, wakes, and membership changes take turns,
  // so a pass never activates a document while it unloads.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = turn.then(work);
    turn = run.catch(() => {});
    return run;
  };
  let activation:ServiceActivationDriver|undefined;
  const restore = config.restore ? new LiveRestorePreparation(config.restore) : undefined;
  let registered = false, closing: Promise<void> | undefined;
  let requestId = 0;
  const nextRequestId = () => {
    if (requestId === Number.MAX_SAFE_INTEGER) throw new Error("Service host request IDs exhausted.");
    return ++requestId;
  };
  const available = () => {
    standing();
    if (signal.aborted || !history.reconciled) throw new Error("Service host is unavailable.");
  };
  const registrationStands = () => {
    const current = storage.getLiveHostControl();
    return !!current && !current.transition && current.configuredMode === "service" && current.configuredHostId === coordinate.hostId &&
      current.hostEpoch === coordinate.hostEpoch && current.registeredInstanceId === coordinate.instanceId &&
      current.registeredConnectionId === coordinate.connectionId && current.admissionState === "open";
  };
  const check = () => {
    available();
    if (!registrationStands()) throw new Error("Service host registration was retired.");
  };
  const checkPreparing = () => {
    if(registered){check();return;}
    standing(); signal.throwIfAborted();
    if (!history.reconciled || !isDeepStrictEqual(storage.getLiveHostControl(), control)) throw new Error("Hosted service preparation was retired.");
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      await startup.catch(() => {});
      await Effect.runPromise(Scope.close(scope,Exit.void));
    });
    invalidated.abort();
    changes?.notifyHost([...members.keys()]);
    return closing;
  };
  const abort = () => { if (!closing) void close().catch(error => console.error("Service host shutdown failed.", error)); };
  const runDocument = async <T>(document: LiveDocumentKey, callerSignal: AbortSignal | undefined, operation: (joined: AbortSignal) => Promise<T>): Promise<T> => {
    try {
      return await withLiveHostSignal(signal, callerSignal, joined => documents.run(JSON.stringify(parseLiveDocumentKey(document)), joined, async () => {
        check();
        const result = await operation(joined);
        check();
        return result;
      }));
    } finally {changes?.notify(document);}
  };
  const consumerFor=(document:LiveDocumentKey)=>attachments.has(document.workspaceId)
    ? activation?.consumer(document).consumer
    : consumers.get(document.workspaceId);
  const consumerForRestore=(lookup:StopRestoreLookup)=>{
    const document=consumers.get(lookup.workspaceId)?.documentForRestore(lookup);
    return document?(attachments.has(document.workspaceId)?activation?.restoreConsumer(document,lookup):consumerFor(document)):undefined;
  };
  const configuredConsumer = (document: LiveDocumentKey) => {
    const consumer = consumerFor(document);
    if (!consumer) throw new Error("Workspace is not configured on this service host.");
    return consumer;
  };
  // A restore can fence the binding while a call waits for the document or the
  // engine. The call then fails as incomplete; cancellation, lost standing,
  // and damage on the same binding stay visible.
  const deliver = <T>(document: LiveDocumentKey, callerSignal: AbortSignal | undefined,
    run: (consumer: ReturnType<typeof configuredConsumer>, joined: AbortSignal) => Promise<T>) => {
    configuredConsumer(document);
    return runDocument(document, callerSignal, async joined => {
      const consumer = configuredConsumer(document);
      try { return await run(consumer, joined); }
      catch (error) { joined.throwIfAborted(); check(); configuredConsumer(document); throw error; }
    });
  };
  const drain = async (value: LiveDocumentKey, callerSignal?: AbortSignal): Promise<CommittedDeliveryOutcome> => {
    check();
    const document = parseLiveDocumentKey(value);
    return deliver(document, callerSignal, (consumer, joined) => consumer.drain(document, joined));
  };
  const startup = Effect.runPromise(Effect.provideService(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.succeed(lifetime), value => Effect.sync(() => value.dispose()));
    yield* Effect.acquireRelease(Effect.sync(() => {held.add(storage);}), () => Effect.sync(() => {held.delete(storage);}));
    yield* Effect.acquireRelease(Effect.sync(() => {
      signal.addEventListener("abort",abort,{once: true});
    }),() => Effect.sync(() => signal.removeEventListener("abort",abort)));
    if (signal.aborted) throw new Error("Service host startup cancelled.");
    yield* Effect.acquireRelease(Effect.sync(() => {
      const stop = changes ? observeRelayWrites(storage, () => changes.notify()) : () => {};
      signal.addEventListener("abort",stop,{once: true});
      return stop;
    }),stop => Effect.sync(() => signal.removeEventListener("abort",stop)));
    // Every connection change restarts the document's idle period.
    yield* Effect.acquireRelease(Effect.sync(() => editors.subscribe(document => {
      const key = hostedKey(document);
      if (key) touch(key);
    })),stop => Effect.sync(stop));
    const temporary = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "dohc-service-live-host-"))),
      directory => Effect.promise(() => rm(directory,{recursive: true,force: true})),
    );
    const nativeConfig = join(temporary, "host.json");
    yield* Effect.promise(() => writeFile(nativeConfig, JSON.stringify({ version: 1, relayNamespace: history.namespace, host,
      workspaces: config.workspaces.map(({hostedReplication, ...workspace}) => ({...workspace,
        ...(hostedReplication ? {relay: hostedReplication.relay} : {})})),
      ingress: config.ingress, settlement: config.settlement, sync: config.sync, adoption: config.adoption, recovery: config.recovery,
      restore: config.restore ? {maxBytes: config.restore.maxBytes, maxEvents: config.restore.maxEvents} : undefined }), { flag: "wx", mode: 0o600 }));
    signal.throwIfAborted();
    const native = yield* Effect.acquireRelease(Effect.promise(() => createEngineClient({ command: config.engineExecutable, authToken: randomBytes(32).toString("base64url"),
      protocolVersion: 2, capabilities: ["blobs"], privateLiveApplication: config.client, connectTimeoutMs: config.client.connectTimeoutMs,
      env: { DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig, DOHC_ENGINE_READER_CONFIG: process.env.DOHC_ENGINE_READER_CONFIG }, signal,
      onExit: abort, onStderr: text => console.error("[service-live-host]", text.trimEnd()),
    })),value => Effect.promise(() => value.waitForExit()));
    yield* Effect.acquireRelease(Effect.sync(() => {
      const stop = () => native.close();
      if (signal.aborted) stop(); else signal.addEventListener("abort",stop,{once: true});
      return stop;
    }),stop => Effect.sync(() => signal.removeEventListener("abort",stop)));
    // Caller input retention and native upload buffers each have their own cap.
    const client = changes ? queueLiveHostRequests(native, {maxPendingReads: changes.maxListeners, maxPendingWrites: changes.maxListeners,
      maxRetainedInputBytes: config.client.aggregateBytes,
      deadlineMs: config.client.requestDeadlineMs, signal, retire: abort}) : native;
    if (signal.aborted) throw new Error("Service host startup cancelled.");
    const discovery = yield* Effect.promise(() => client.sendRequest({ id: nextRequestId(), method: "liveApplication.hosts", params: {}, deadlineMs: config.client.requestDeadlineMs }));
    const reply = record(discovery.result, ["relayNamespace", "host", "workspaces"]);
    if (reply.relayNamespace !== history.namespace || !isDeepStrictEqual(reply.host, host) || !Array.isArray(reply.workspaces) ||
      reply.workspaces.length !== config.workspaces.length) throw new Error("Configured engine identity mismatch.");
    const install = (workspace: ServiceWorkspace, value: unknown) => {
      const row = record(value, ["workspaceId", "workspaceHandle"]), handle = row.workspaceHandle;
      if (row.workspaceId !== workspace.workspaceId || typeof handle !== "string" || !handle || [...members.values()].some(member => member.handle === handle)) {
        throw new Error("Configured workspace identity mismatch.");
      }
      members.set(workspace.workspaceId, {handle, workspace});
      consumers.set(workspace.workspaceId, new LiveCommittedDelivery(storage, history, { client, workspace: handle,
        host: coordinate, deadlineMs: config.client.requestDeadlineMs, nextRequestId, restore }));
      const attachment = workspace.hostedReplication;
      if (!attachment) return;
      const replica = new ServiceHostedReplication({client, workspace: handle, workspaceId: workspace.workspaceId, nextRequestId,
        deadlineMs: config.client.requestDeadlineMs, signal, assertCurrent: checkPreparing}, attachment);
      const attached: HostedAttachment = {handle, hosted: replica, identity: replica.identity, pulls: 0, confirmed: 0, announced: new Map(), reached: new Map(), dropped: 0, replica: {
        pull: joined => pull(attached, joined), publish: joined => replica.publish(joined)}};
      attachments.set(workspace.workspaceId, attached);
    };
    // Every pull of a hosted replica runs here. A page that leaves documents held clears their readiness,
    // and each page that read its documents says which still are, within its held list's window.
    // Within its departed list's window, it says which of the documents this host waits on are gone.
    // Owners dropped because a newly held list may leave some out are reported once per change in their count, until a complete list.
    const pull = async (attached: HostedAttachment, joined: AbortSignal) => {
      const number = ++attached.pulls, workspaceId = attached.hosted.connection.workspaceId;
      const result = await attached.hosted.pull(joined, page => {
        if (!page.adoptedScope && activation) {
          const dropped = activation.hold(workspaceId, page.held, page.heldWindow, page.newlyHeld);
          if (page.newlyHeld.complete) attached.dropped = 0;
          else if (dropped > 0 && dropped !== attached.dropped) {
            attached.dropped = dropped;
            try {console.error("Hosted pull dropped live document owners its held list may leave out.", workspaceId, dropped);}
            catch { /* Reporting must not stop the pull. */ }
          }
        }
        const waiting = new Set([...attached.announced.keys(), ...[...parking.keys()].flatMap(key => {
          const row = hosted.get(key);
          return row?.target.workspaceId === workspaceId ? [row.objectId] : [];
        })]);
        for (const objectId of attached.reached.keys()) if (!waiting.has(objectId)) attached.reached.delete(objectId);
        const listed = new Set(page.departed.listed);
        for (const objectId of waiting) {
          if (hostedWindowCovers(page.departed.window, objectId)) attached.reached.set(objectId, {pull: number, listed: listed.has(objectId)});
        }
      });
      attached.confirmed = number;
      return result;
    };
    for (const [index, value] of reply.workspaces.entries()) install(config.workspaces[index]!, value);
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (registered && !storage.unavailable.aborted) storage.disconnectLiveHost({...coordinate,updatedAtMs: Date.now(),guard: standing});
    }));
    standing();
    if (signal.aborted || !history.reconciled) throw new Error("Service host startup cancelled.");
    if (preparing) {
      // Imported-lineage activation must finish before this instance serves live documents.
      checkPreparing();
    } else {
      const registration = storage.registerLiveHost({ ...coordinate, updatedAtMs: Date.now(), guard: standing });
      if (!registration.ok) throw new Error("Service host registration refused.");
      registered = true;
      check();
    }
    const registerRetained = () => {
      if (registered || !activation?.hasRetained()) return;
      if(!storage.registerLiveHost({...coordinate,updatedAtMs:Date.now(),guard:standing}).ok)throw new Error("Retained service host registration refused.");
      registered=true;check();
    };
    const engineCode = (error: unknown) => error instanceof EngineRequestError ? error.wireError?.code : undefined;
    // A retired connection leaves the daemon unusable. Any other refusal keeps it for the next update.
    const membershipRequest = async (method: string, workspace: string | undefined, params: JsonValue, joined: AbortSignal) => {
      try {
        return (await client.sendRequest({id: nextRequestId(), method, ...(workspace ? {workspace} : {}), params,
          deadlineMs: config.client.requestDeadlineMs}, joined)).result;
      } catch (error) {
        if (engineCode(error) === "SESSION_EXPIRED") abort();
        throw error;
      }
    };
    const attach = async (workspace: ServiceWorkspace, joined: AbortSignal) => {
      const {hostedReplication, ...entry} = workspace;
      const result = await membershipRequest("liveApplication.attachWorkspace", undefined,
        {...entry, ...(hostedReplication ? {relay: hostedReplication.relay} : {})}, joined);
      joined.throwIfAborted();
      try {install(workspace, result);} catch (error) {abort(); throw error;}
      changes?.notifyHost([workspace.workspaceId]);
      // A failure other than divergence detaches it too, so the next update attaches it and checks again.
      try {await checkOrigin(workspace.workspaceId, joined);}
      catch (error) {
        if (!diverged.has(workspace.root)) await detach(workspace.workspaceId, signal).catch(() => {});
        throw error;
      }
    };
    // A replica checks its origin before any other work on its store,
    // departures included. A diverged store counts as diverged, then detaches
    // for good; if that detach fails, the pass's diverged loop retries it.
    const checkOrigin = async (workspaceId: string, joined: AbortSignal) => {
      const attached = attachments.get(workspaceId);
      if (!attached || attached.hosted.checked) return;
      try {await attached.hosted.create(joined);}
      catch (error) {
        if (!attached.hosted.diverged) throw error;
        diverged.set(members.get(workspaceId)!.workspace.root, workspaceId);
        try {await detach(workspaceId, signal);} catch {throw error;}
      }
    };
    // Detach does not wait for unsettled work. The workspace store keeps it until the workspace attaches again.
    const detach = async (workspaceId: string, joined: AbortSignal) => {
      try {await membershipRequest("liveApplication.detachWorkspace", members.get(workspaceId)!.handle, {}, joined);}
      catch (error) {
        // The workspace is already closed, as after a detach whose reply was lost.
        if (engineCode(error) !== "WORKSPACE_UNAVAILABLE") throw error;
      }
      members.delete(workspaceId); consumers.delete(workspaceId);
      attachments.delete(workspaceId); ledgers.delete(workspaceId);
      for (const [key, document] of hosted) if (document.target.workspaceId === workspaceId) forget(key);
      for (const [key, document] of retained) if (document.target.workspaceId === workspaceId) retained.delete(key);
      changes?.notifyHost([workspaceId]);
    };
    const forget = (key: string) => {activation!.removeTarget(hosted.get(key)!.target); unhost(key);};
    const unhost = (key: string) => {
      hosted.delete(key); leaving.delete(key); recovering.delete(key); parking.delete(key); idle.delete(key); unloading.delete(key); keeping.delete(key);
      grantsEnded.delete(key); heldOf.delete(key); observed.delete(key);
    };
    // The engine's reason while it holds unfinished work for the document, or undefined once nothing of it is loaded.
    // The unload names the activation the relay retains, so it cannot end another one's state.
    const requestUnload = async (document: {target: ServiceActivationTarget; objectId: string}, joined: AbortSignal) => {
      const activationId = activation!.activationId(document.target);
      try {
        const result = await membershipRequest("liveApplication.unloadDocument", members.get(document.target.workspaceId)!.handle,
          {objectId: document.objectId, ...(activationId === undefined ? {} : {activationId})}, joined);
        const reply = result && typeof result === "object" ? result as Record<string, unknown> : {};
        if (reply.status === "pending") return typeof reply.reason === "string" ? reply.reason : "unload-pending";
        if (reply.status !== "unloaded") throw new Error("Invalid live document unload response.");
      } catch (error) {
        // Nothing of the document is loaded, as after an unload whose reply was lost.
        if (engineCode(error) !== "WORKSPACE_UNAVAILABLE") throw error;
      }
      return undefined;
    };
    const settleTarget: Parameters<ServiceActivationDriver["activate"]>[2] = config.settlement
      ? (consumer, document, joined) => consumer.settle(document, joined) : undefined;
    // Whether a hosted document's owner lost live authority over it: Stop
    // fenced it, or no Edit grant of its owner covers it any more.
    const authorityLost = ({target, objectId}: {target: ServiceActivationTarget; objectId: string}) => {
      const share = storage.getShare(target.shareId);
      return !storage.serviceHostDocumentEnabled({workspaceId: target.workspaceId, objectId}) || !share || share.workspaceId !== target.workspaceId ||
        !storage.serviceHostEnrollmentHasEditGrant({workspaceId: target.workspaceId, ownerUserId: share.granterUserId, path: target.path});
    };
    const PARKING = "Waiting for its hosted replica to confirm the document parked.";
    // A departed document whose owner has not saved a recovery copy of edits
    // this host refused stays, with its workspace attached, so the owner can
    // still read them. Once it settled and unloaded, passes only check the copy.
    const KEPT = "Waiting for its owner to save a recovery copy of the edits the server kept.";
    const keeping = new Set<string>();
    // Once its owner lost live authority, nothing grants a Try again on a
    // departing document or delivers its queues, so each of these scans runs
    // once until the document returns: the documents whose departure ended
    // every grant, and the lineages each one's first scan in its document's
    // work found frozen at the seed or holding a refused edit. Once a departing
    // document unloaded, nothing applies to it either: `observed` holds the documents whose
    // departure recorded the checkpoints their copies must hold.
    const grantsEnded = new Set<string>(), heldOf = new Map<string, KeptHeads>(), observed = new Set<string>();
    // Whether one of the document's refusals in its attached store has no recovery copy.
    const uncopied = (row: {target: ServiceActivationTarget; objectId: string}) => {
      const attached = attachments.get(row.target.workspaceId);
      return !!attached && storage.serviceKeptEditsHeld({workspaceId: row.target.workspaceId, objectId: row.objectId}, attached.identity);
    };
    const kept = (key: string, row: {target: ServiceActivationTarget; objectId: string}) => {
      if (!uncopied(row)) {keeping.delete(key); return undefined;}
      // Activation passes leave it unloaded meanwhile.
      if (!keeping.has(key)) {keeping.add(key); activation!.removeTarget(row.target);}
      return KEPT;
    };
    // Once it leaves with a recovery copy of every refusal, its rows go too. Its store keeps the queues.
    // A row released here comes back uncopied if the same quarantined queue drains again, as after the
    // document is shared again, and its owner is asked for a recovery copy once more. Its first check in a
    // departure records the checkpoint a copy of each of its queues reads now, as it unloaded with nothing
    // more to apply, so a digest an earlier departure recorded decides nothing.
    const gone = async (key: string, row: {target: ServiceActivationTarget; objectId: string}, joined: AbortSignal) => {
      if (!observed.has(key)) {await observeKeptCheckpoints(row, joined); observed.add(key);}
      const waiting = kept(key, row);
      if (waiting === undefined) {forget(key); storage.releaseServiceKeptEdits({workspaceId: row.target.workspaceId, objectId: row.objectId});}
      return waiting;
    };
    // Ends what the owner's Try again left outstanding on a queue this host
    // keeps, once nothing can deliver it, so its unload no longer waits for
    // that attempt. The queue keeps its bytes. A refusal whose quarantine never
    // reached the engine is quarantined now, and a row whose queue delivered
    // again, or that the engine no longer holds, is forgotten. Resolves to
    // "seed" when the engine answers that the queue stays frozen at its owner's
    // adoption seed at its document's current restore generation, which no
    // settlement may pass, and to "edits" while it holds another refused edit.
    // The row of a queue holding a refused seed, at any generation, records the
    // checkpoint a recovery copy reads now, which its copy must hold.
    const endKeptRetry = async (kept: ServiceKeptEdits, outbox: OwnerYDocOutbox): Promise<"seed" | "edits" | undefined> => {
      let head;
      try {head = await outbox.readDeliveryHead(kept.outboxId, kept.binding);}
      catch (error) {
        if (!(error instanceof Error && error.message === "owner-outbox-not-found")) throw error;
        storage.forgetServiceKeptEdits(kept);
        return undefined;
      }
      const quarantined = head.state === "quarantined";
      if (quarantined ? head.retryDeliveryId !== null : !kept.retrying && head.entry?.deliveryId === kept.headDeliveryId) {
        await outbox.quarantine({outboxId: kept.outboxId, reason: kept.reason});
        // An ended grant can freeze the queue at its seed; only the engine can say.
        head = await outbox.readDeliveryHead(kept.outboxId, kept.binding);
      } else if (!quarantined) {storage.forgetServiceKeptEdits(kept); return undefined;}
      if (kept.retrying) storage.endServiceKeptEditsRetry(kept);
      storage.observeServiceKeptEditsCheckpoint(kept, head.recoveryCheckpointDigest);
      return head.frozenAtRefusedSeed ? "seed" : head.entry ? "edits" : undefined;
    };
    // Runs `work` on every queue of the document in its attached store, page
    // by page, so each gets its turn. Takes no turn of its document's work
    // when `inTurn` is set.
    const eachKeptOutbox = async (row: {target: ServiceActivationTarget; objectId: string}, joined: AbortSignal, inTurn: boolean,
      work: (kept: ServiceKeptEdits, outbox: OwnerYDocOutbox) => Promise<void>) => {
      const attached = attachments.get(row.target.workspaceId);
      if (!attached) return;
      for (let after: number | null = 0; after !== null;) {
        const page = storage.serviceKeptEditsOf({workspaceId: row.target.workspaceId, objectId: row.objectId}, after);
        for (const kept of page.keptEdits) {
          if (!sameKeptEditsIdentity(kept.identity, attached.identity)) continue;
          const each = (outbox: OwnerYDocOutbox) => work(kept, outbox);
          await (inTurn ? openKeptOutbox(kept, joined, each) : withKeptOutbox(kept, joined, each));
        }
        after = page.nextCursor;
      }
    };
    // Records, on each of the document's rows, the checkpoint a recovery copy of its queue reads now,
    // before a departure checks the copies, so a digest an earlier departure recorded decides nothing.
    const observeKeptCheckpoints = (row: {target: ServiceActivationTarget; objectId: string}, joined: AbortSignal) =>
      eachKeptOutbox(row, joined, false, async (kept, outbox) => {
        let head;
        try {head = await outbox.readDeliveryHead(kept.outboxId, kept.binding);}
        catch (error) {
          if (!(error instanceof Error && error.message === "owner-outbox-not-found")) throw error;
          storage.forgetServiceKeptEdits(kept);
          return;
        }
        storage.observeServiceKeptEditsCheckpoint(kept, head.recoveryCheckpointDigest);
      });
    // Runs `endKeptRetry` on every queue of the document. Resolves to the lineages whose queue stays frozen
    // at the seed at the current restore generation, where an earlier generation's seed freezes nothing, and
    // those whose queue holds another refused edit.
    const endKeptRetries = async (row: {target: ServiceActivationTarget; objectId: string}, joined: AbortSignal, inTurn: boolean): Promise<KeptHeads> => {
      const heads = {seeded: new Set<string>(), refused: new Set<string>()};
      await eachKeptOutbox(row, joined, inTurn, async (kept, outbox) => {
        const head = await endKeptRetry(kept, outbox);
        if (head) (head === "seed" ? heads.seeded : heads.refused).add(kept.binding.lineageClaimId);
      });
      return heads;
    };
    // The engine refused the document as not ready, as once it parked. Only a pull that starts after
    // this can tell: a parked document is no longer departed, and one its scope still held becomes so.
    // Meanwhile it leaves activation passes, which would keep its workspace from pulling.
    const awaitParking = (key: string, row: {target: ServiceActivationTarget}) => {
      parking.set(key, attachments.get(row.target.workspaceId)!.pulls + 1);
      activation!.removeTarget(row.target);
      return PARKING;
    };
    // Whether a refusal on the lineage's queue in the document's attached store has no recovery copy.
    const uncopiedOn = (row: {target: ServiceActivationTarget; objectId: string}, lineageClaimId: string) => {
      const attached = attachments.get(row.target.workspaceId);
      if (!attached) return false;
      for (let after: number | null = 0; after !== null;) {
        const page = storage.serviceKeptEditsOf({workspaceId: row.target.workspaceId, objectId: row.objectId}, after);
        if (page.keptEdits.some(kept => !kept.copied && kept.binding.lineageClaimId === lineageClaimId && sameKeptEditsIdentity(kept.identity, attached.identity))) return true;
        after = page.nextCursor;
      }
      return false;
    };
    // A document whose activation retires leaves through its retirement alone,
    // whatever this daemon loaded, so it never waits on an ordinary unload. Once
    // it retired, its successor activates when its document is hosted again.
    // Null while no retirement is open, or while it departs as an ordinary unload instead.
    const retire = async (key: string, joined: AbortSignal): Promise<string | undefined | null> => {
      const row = hosted.get(key);
      if (!row) return null;
      const open = storage.serviceActivationRetirement({workspaceId: row.target.workspaceId, objectId: row.objectId});
      if (!open) return null;
      let heads = heldOf.get(key);
      if (!heads) {heads = await endKeptRetries(row, joined, false); heldOf.set(key, heads); grantsEnded.add(key);}
      // Retirement keeps a refused edit out of the queue its recovery copy reads, so until a copy holds it the
      // document departs as an ordinary unload. A queue frozen at its owner's adoption seed waits for nothing:
      // the engine abandons a seed nothing applied, and holds the retirement on any other.
      if (heads.refused.has(open.lineageClaimId) && uncopiedOn(row, open.lineageClaimId)) return null;
      const attached = attachments.get(row.target.workspaceId), required = attached?.announced.get(row.objectId);
      const step = await activation!.retire(row.target, row.objectId, joined, {
        departed: () => required !== undefined && reachedSince(attached!, row.objectId, required),
        parked: () => required !== undefined && goneSince(attached!, row.objectId, required)});
      // A seed the engine cannot abandon holds the retirement. No settlement may pass it, so the document
      // departs as an ordinary unload, with its accepted work kept for its owner's recovery copy.
      if (!step || step.kind === "held") return null;
      if (step.kind === "pending") return step.reason;
      // A retired document whose refusals this host kept stays, with its workspace attached, until no Try again
      // of them stays granted and its owner saved a recovery copy of each. Its rows go then.
      const document = {workspaceId: row.target.workspaceId, objectId: row.objectId};
      if (storage.serviceKeptEditsOf(document).keptEdits.length > 0) retained.set(documentKey(document), {target: row.target, objectId: row.objectId});
      unhost(key);
      return undefined;
    };
    // Unloads a document that left the hosted set once it settled and its
    // output reached the relay; its workspace stays attached, so its hosted
    // replica can retire it. Resolves to why it stays loaded, or undefined
    // once it is gone. It stays while the engine answers its unload as
    // pending, since its replica cannot park it until then.
    // Once its owner lost live authority nothing new is accepted, but what the
    // host already applied still settles into the file. That settlement uses
    // only durable state, so it holds after a restart and whether or not this
    // daemon loaded the document. Its work is pushed before the unload, where
    // the engine can prove it, so the relay refuses it at its coordinates.
    const depart = async (key: string, joined: AbortSignal) => {
      const retirement = await retire(key, joined);
      if (retirement !== null) return retirement;
      await resolveUnload(key, joined);
      const row = hosted.get(key);
      if (!row) return undefined;
      // Nothing can deliver a Try again once its owner lost live authority, so
      // none stays granted, whatever this departure waits for next.
      const lost = authorityLost(row);
      if (lost && !grantsEnded.has(key)) {await endKeptRetries(row, joined, false); grantsEnded.add(key);}
      if (keeping.has(key) && kept(key, row)) return KEPT;
      const attached = attachments.get(row.target.workspaceId)!, required = parking.get(key);
      if (required !== undefined) {
        if (attached.confirmed < required) return PARKING;
        parking.delete(key);
        if (goneSince(attached, row.objectId, required)) return gone(key, row, joined);
      }
      const publish = async (operation: AbortSignal) => (await attached.hosted.publish(operation)).hasMore ? "Hosted publication has more pages." : undefined;
      if (lost) {
        recovering.delete(key);
        const document = activation!.departing(row.target, joined);
        if (document) {
          // Settle, publish, then unload, under the departure's registration.
          // A queue frozen at its owner's adoption seed keeps the document
          // unsettled: settling would drop the owner's pre-adoption head from
          // the file. It unloads with its queue's bytes kept and nothing published.
          const waiting = await runDocument(document, joined, async operation => {
            let heads = heldOf.get(key);
            if (!heads) {heads = await endKeptRetries(row, operation, true); heldOf.set(key, heads);}
            if (settleTarget && !heads.seeded.has(document.lineageClaimId)) {
              const settled = await activation!.settleDeparted(row.target, document, operation);
              if (settled?.kind === "unready") return awaitParking(key, row);
              if (settled?.kind === "pending") return settled.reason;
              if (settled && !settled.settlement.materialized) return "Settlement has not reached the file.";
              if (settled) {
                const more = await publish(operation);
                if (more) return more;
              }
            }
            return requestUnload(row, operation);
          });
          if (waiting !== undefined) return waiting;
        } else if (activation!.loaded(row.target) && !activation!.dormant(row.target)) {
          const waiting = await requestUnload(row, joined);
          if (waiting !== undefined) return waiting;
        }
        return gone(key, row, joined);
      }
      // Resuming loads what an earlier daemon left, and delivers and settles it, as for a document that left this one.
      if (recovering.has(key) && activation!.retained(row.target)) {
        let outcome;
        try {outcome = await activation!.activate(row.target, joined, settleTarget);}
        catch (error) {
          if (!isHostedDocumentUnready(error)) throw error;
          return awaitParking(key, row);
        }
        if (outcome.kind !== "done") return outcome.reason;
      }
      recovering.delete(key);
      if (activation!.loaded(row.target) && !activation!.dormant(row.target)) {
        const document = activation!.ownerDocument(row.target);
        // A document with no owner has nothing delivered here to settle; the engine reports any work it still holds.
        const leave = async (operation: AbortSignal) => {
          if (document) {
            if (!activation!.completed(row.target)) return "Service document activation is incomplete.";
            const {consumer} = activation!.consumer(document);
            if (settleTarget && !(await consumer.settle(document, operation)).materialized) return "Settlement has not reached the file.";
            const more = await publish(operation);
            if (more) return more;
          }
          return requestUnload(row, operation);
        };
        // The unload waits for delivery and settlement already running on the document.
        const waiting = document ? await runDocument(document, joined, leave) : await leave(joined);
        if (waiting !== undefined) return waiting;
      }
      return gone(key, row, joined);
    };
    // Resolves to why a retained document stays, or undefined once its owner has
    // a recovery copy of every refusal, when its rows go too. Nothing delivers
    // it, so first no Try again of its queues stays granted. One hosted again
    // belongs to activation.
    const keepRetained = async (key: string, joined: AbortSignal) => {
      const row = retained.get(key);
      if (!row) return undefined;
      if (hostedKey({workspaceId: row.target.workspaceId, objectId: row.objectId}) !== undefined) {retained.delete(key); return undefined;}
      // Nothing delivers it on this daemon, which may not even be registered, so this takes no turn of its document's work.
      if (!row.ended) {await endKeptRetries(row, joined, true); row.ended = true;}
      if (uncopied(row)) return KEPT;
      retained.delete(key);
      storage.releaseServiceKeptEdits({workspaceId: row.target.workspaceId, objectId: row.objectId});
      return undefined;
    };
    // Unloads one idle hosted document and keeps it hosted. Resolves to why it
    // stays loaded, or undefined once it unloaded or a connection overtook it.
    // Runs in its document work, so no delivery reaches it between settlement
    // and the unload, and it gives way to any connection change until it sends the unload.
    // The unload's reply is awaited past the caller's deadline. Without a reply
    // the document stays unloading, and the unload is sent again, without
    // settling, before anything else uses the document.
    const sleep = async (key: string, row: {target: ServiceActivationTarget; objectId: string}, seen: number, joined: AbortSignal) => {
      const document = activation!.ownerDocument(row.target), lost = unloading.has(key);
      if (!document || !(lost || activation!.completed(row.target))) return "Service document activation is incomplete.";
      const quiet = () => !editors.connected({workspaceId: row.target.workspaceId, objectId: row.objectId}) && idle.get(key)?.generation === seen;
      unloading.add(key);
      let unanswered = lost;
      try {
        return await runDocument(document, joined, async operation => {
          if (!lost) {
            if (!quiet()) return undefined;
            const {consumer} = activation!.consumer(document);
            if (settleTarget && !(await consumer.settle(document, operation)).materialized) return "Settlement has not reached the file.";
            // Publish settled output now: passes skip a dormant document, so they may not push its workspace again.
            if ((await attachments.get(row.target.workspaceId)!.hosted.publish(operation)).hasMore) return "Hosted publication has more pages.";
            if (!quiet()) return undefined;
          }
          try {
            const pending = await requestUnload(row, signal);
            unanswered = false;
            if (pending === undefined) activation!.sleep(row.target, document);
            return pending;
          } catch (error) {
            // An engine refusal answers the unload. A lost reply leaves it unknown, and so
            // does a deadline or cancellation, after which the engine's unload may still finish.
            const code = engineCode(error);
            unanswered = code === undefined || code === "DEADLINE_EXCEEDED" || code === "CANCELLED";
            throw error;
          }
        });
      } finally {if (!unanswered) unloading.delete(key);}
    };
    // Sends an unanswered idle unload again. Runs in a turn, so no sweep holds the document.
    const resolveUnload = async (key: string, joined: AbortSignal) => {
      const row = hosted.get(key);
      if (row && unloading.has(key)) await sleep(key, row, idle.get(key)!.generation, joined);
    };
    // Opening a dormant document, or one whose idle unload is running or
    // unanswered, reloads it from its retained source. The open first pulls
    // what the relay received since the last pass, and activation drains it
    // before the first sync.
    const wake = async (document: {workspaceId: string; objectId: string}, callerSignal?: AbortSignal) => {
      const key = hostedKey(document);
      if (!key) return;
      touch(key);
      if (!activation!.dormant(hosted.get(key)!.target) && !unloading.has(key)) return;
      await exclusive(() => withLiveHostSignal(signal, callerSignal, async joined => {
        await resolveUnload(key, joined);
        const row = hosted.get(key);
        if (!row || !activation!.dormant(row.target)) return;
        const workspaceId = row.target.workspaceId;
        // While a sibling is mid-activation the open skips catch-up, as awake documents
        // do, and converges once that sibling resolves. Waiting here would let one stuck
        // sibling keep every dormant document in the workspace from opening.
        if (activation!.workspaceReady(workspaceId) && (await pull(attachments.get(workspaceId)!, joined)).hasMore) {
          throw new Error("Hosted replication has more pages.");
        }
        activation!.wake(row.target); touch(key);
        await activation!.activate(row.target, joined, settleTarget);
      }));
    };
    // A held-document read asks the engine for a workspace this daemon replicates,
    // and answers only while this registration and that attachment still stand.
    // One that ended during the read invalidates it, however the read ended.
    // It writes nothing, so it takes no turn and no pass waits on it. It runs in
    // its own lane on the native client, beside ordinary requests, and an
    // identical read joins one already running. With `stream`, `streamed` is the
    // blob the engine sends before its answer.
    const heldReads = heldReadLane({...HELD_READS, deadlineMs: config.client.requestDeadlineMs, signal});
    const heldRead = async <M extends "sync.heldDocuments" | "sync.heldDocument">(workspaceId: string, method: M,
      params: Record<string, JsonValue>, stream: boolean, callerSignal?: AbortSignal,
    ): Promise<{result: HostedSyncMethodResultMap[M]; streamed?: StreamedBlob} | HeldReadInvalidated | null> => {
      available();
      if (!registrationStands()) return {invalidated: "registration"};
      const attached = attachments.get(workspaceId);
      if (!attached) return null;
      const ended = (): HeldReadInvalidated | undefined => !registrationStands() ? {invalidated: "registration"}
        : attachments.get(workspaceId) !== attached ? {invalidated: "attachment"} : undefined;
      let read;
      try {
        read = await heldReads(workspaceId, JSON.stringify([attached.handle, method, params, stream]), callerSignal, async cancelled => {
          cancelled.throwIfAborted();
          const id = nextRequestId();
          let streamed: StreamedBlob | undefined;
          const stop = stream ? native.onBlob(blob => {if (blob.requestId === id) streamed = blob;}) : () => {};
          // A cancelled read waits for the engine's answer, so its lane slot frees only once the engine stops.
          try {
            const response = await native.sendRequest({id, method, workspace: attached.handle,
              params: {workspaceId, ...params}, deadlineMs: config.client.requestDeadlineMs}, undefined, undefined, cancelled);
            return {result: decodeHostedSyncResult(method, response.result), ...(streamed ? {streamed} : {})};
          } finally {
            stop();
          }
        });
        available();
      } catch (error) {
        const invalidated = ended();
        if (invalidated) return invalidated;
        // The engine runs one proof per workspace and refuses other reads beside it,
        // and refuses an answer larger than it keeps for one.
        if (error instanceof EngineRequestError && error.wireError?.code === "OVERLOADED" &&
          error.wireError.message === "held-read-busy") throw new HeldReadBusyError();
        if (error instanceof EngineRequestError && error.wireError?.code === "PAYLOAD_TOO_LARGE" &&
          error.wireError.message === "held-read-too-large") throw new HeldReadTooLargeError();
        throw error;
      }
      return ended() ?? read;
    };
    // A refused queue this host keeps, through its own connection. Only the
    // store of the row's workspace identity holds it.
    const reachable = (kept: ServiceKeptEdits) => {
      const member = members.get(kept.binding.workspaceId), attached = attachments.get(kept.binding.workspaceId);
      if (!member || !attached || !sameKeptEditsIdentity(kept.identity, attached.identity)) throw new Error("This server does not hold the workspace's live documents now.");
      return member;
    };
    const openKeptOutbox = async <T>(kept: ServiceKeptEdits, joined: AbortSignal, work: (outbox: OwnerYDocOutbox, joined: AbortSignal) => Promise<T>) => {
      const member = reachable(kept);
      const outbox = new OwnerYDocOutbox({sendRequest: async original => ({...await client.sendRequest({...original, id: nextRequestId(),
        deadlineMs: config.client.requestDeadlineMs}, joined), id: original.id})}, member.handle);
      try {return await work(outbox, joined);} finally {outbox.dispose();}
    };
    // The same, in its document's work so no delivery changes it meanwhile.
    const withKeptOutbox = <T>(kept: ServiceKeptEdits, callerSignal: AbortSignal | undefined, work: (outbox: OwnerYDocOutbox, joined: AbortSignal) => Promise<T>) => {
      const {binding} = kept;
      reachable(kept);
      return runDocument({workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId,
        lineageClaimId: binding.lineageClaimId}, callerSignal, joined => openKeptOutbox(kept, joined, work));
    };
    // `preparing`: an earlier store is still being prepared; its reader asks again.
    const keptPage = (page: JsonValue | undefined): JsonValue => {
      if (!page || typeof page !== "object" || Array.isArray(page) || !["page", "readChanged", "preparing"].includes(String(page.kind))) throw new Error("Invalid kept edits page.");
      return page;
    };
    // Earlier stores open read-only for their owners' recovery copies, by
    // workspace. The engine opens at most one per workspace, so each
    // workspace's recovery work takes turns, and its handle closes before
    // another of its stores opens. A handle also closes once idle, once a
    // read through it is abandoned, once the engine refused its store, and
    // once no refusal kept in its store waits for a recovery copy. An open
    // whose answer was lost, or whose lookup failed without the engine
    // refusing it, stays recorded with no handle, and a close that fails keeps
    // its handle: either closes on the workspace's next turn, or once idle.
    // A record drops its handle only once a close of it ended.
    type Recovery = {readonly identity: ServiceKeptEditsIdentity; readonly root: string; handle?: string; idle?: ReturnType<typeof setTimeout>};
    const recoveries = new Map<string, Recovery>();
    const recoveryTurns = new Map<string, Promise<void>>();
    const recoveryTurn = <T>(workspaceId: string, work: () => Promise<T>): Promise<T> => {
      const run = (recoveryTurns.get(workspaceId) ?? Promise.resolve()).then(work);
      const settled = run.then(() => {}, () => {});
      recoveryTurns.set(workspaceId, settled);
      void settled.then(() => {if (recoveryTurns.get(workspaceId) === settled) recoveryTurns.delete(workspaceId);});
      return run;
    };
    // The recovery handle, opening its store if it has none. The engine
    // answers an open of a store it already holds with that store's handle,
    // so this also finds the handle of an open whose answer was lost.
    const recoveryHandle = async (workspaceId: string, open: Recovery, joined: AbortSignal) => {
      if (open.handle !== undefined) return open.handle;
      const opened = record(await membershipRequest("liveApplication.openRecoveryStore", undefined, {root: open.root, workspaceId,
        replicationEpoch: open.identity.replicationEpoch, streamIdentity: open.identity.streamIdentity}, joined), ["workspaceHandle"]);
      if (typeof opened.workspaceHandle !== "string" || !opened.workspaceHandle) throw new Error("Invalid recovery store response.");
      return open.handle = opened.workspaceHandle;
    };
    // Closes the record's handle; the engine answers a close of a handle
    // already closing once that close ends. Resolves once the handle is gone,
    // and throws, keeping it, while that is unknown.
    const endRecoveryHandle = async (open: Recovery, joined: AbortSignal) => {
      try {await membershipRequest("liveApplication.closeRecoveryStore", open.handle, {}, joined);}
      catch (error) {if (engineCode(error) !== "WORKSPACE_UNAVAILABLE") throw error;}
      delete open.handle;
    };
    const closeRecovery = async (workspaceId: string) => {
      const open = recoveries.get(workspaceId);
      if (!open) return;
      clearTimeout(open.idle);
      try {await recoveryHandle(workspaceId, open, signal);}
      catch (error) {
        if (RECOVERY_OPEN_REFUSALS.has(engineCode(error) ?? "")) {recoveries.delete(workspaceId); return;}
        idleRecovery(workspaceId, open);
        throw error;
      }
      try {await endRecoveryHandle(open, signal);}
      catch (error) {idleRecovery(workspaceId, open); throw error;}
      recoveries.delete(workspaceId);
    };
    const idleRecovery = (workspaceId: string, open: Recovery) => {
      clearTimeout(open.idle);
      if (signal.aborted) return;
      open.idle = setTimeout(() => {
        void recoveryTurn(workspaceId, async () => {if (!signal.aborted && recoveries.get(workspaceId) === open) await closeRecovery(workspaceId);}).catch(() => {});
      }, RECOVERY_IDLE_MS);
      open.idle.unref?.();
    };
    // A page of a queue kept in an earlier store of its workspace, at `root`,
    // read through that store's recovery handle. It admits, settles,
    // publishes and delivers nothing, so it needs no live registration, only
    // a host that was not retired. The engine answers `preparing` until the
    // store is ready; a store it refused throws RecoveryCopyRefusal, and its
    // handle closes, so another read prepares it again.
    const readEarlierKeptEdits = (kept: ServiceKeptEdits, root: string, cursor: JsonValue | undefined, callerSignal?: AbortSignal) =>
      withLiveHostSignal(signal, callerSignal, joined => recoveryTurn(kept.workspaceId, async (): Promise<JsonValue> => {
        joined.throwIfAborted();
        checkPreparing();
        // A read that waited behind an account deletion, or behind a change to
        // the row it names, opens nothing.
        if (workspaceIsDeleted(storage, kept.workspaceId) ||
          !storage.readServiceKeptEditsRefusal({workspaceId: kept.workspaceId, outboxId: kept.outboxId, generation: kept.generation})) return {kind: "readChanged"};
        const held = recoveries.get(kept.workspaceId);
        if (held && (!sameKeptEditsIdentity(held.identity, kept.identity) || held.root !== root)) await closeRecovery(kept.workspaceId);
        const open = recoveries.get(kept.workspaceId) ?? {identity: kept.identity, root};
        recoveries.set(kept.workspaceId, open);
        clearTimeout(open.idle);
        try {
          for (let reopened = false; ; reopened = true) {
            let handle: string;
            try {handle = await recoveryHandle(kept.workspaceId, open, joined);}
            catch (error) {
              if (!RECOVERY_OPEN_REFUSALS.has(engineCode(error) ?? "")) throw error;
              recoveries.delete(kept.workspaceId);
              throw recoveryRefusal(error);
            }
            try {
              return keptPage((await client.sendRequest({id: nextRequestId(), workspace: handle, method: "ydoc.ownerOutbox.readPending",
                params: {outboxId: kept.outboxId, ...(cursor === undefined ? {} : {cursor})}, deadlineMs: config.client.requestDeadlineMs}, joined)).result);
            } catch (error) {
              const code = engineCode(error);
              // The engine reads nothing through a handle whose close began, as
              // one that timed out, and may still be preparing behind it. The
              // record keeps the handle until a close of it ends or finds it
              // gone; only then does its store open once more.
              if (code === "WORKSPACE_UNAVAILABLE" && !reopened) {await endRecoveryHandle(open, joined); continue;}
              if (code === undefined || RECOVERY_READ_TRANSIENT.has(code)) throw error;
              await closeRecovery(kept.workspaceId).catch(() => {});
              throw recoveryRefusal(error);
            }
          }
        } finally {
          if (recoveries.get(kept.workspaceId) === open) {
            if (joined.aborted) await closeRecovery(kept.workspaceId).catch(() => {});
            else idleRecovery(kept.workspaceId, open);
          }
        }
      }));
    // Restore work takes a turn, so no idle unload runs beside it. A step that
    // registers on a dormant document reloads it, and passes then settle it.
    const restoring = <T>(value: StopRestoreLookup, callerSignal: AbortSignal | undefined,
      operation: (consumer: NonNullable<ReturnType<typeof consumerForRestore>>, lookup: StopRestoreLookup, joined: AbortSignal) => Promise<T>) => {
      check();
      const lookup = snapshotStopRestoreLookup(value);
      return exclusive(() => withLiveHostSignal(signal, callerSignal, async joined => {
        const document = consumers.get(lookup.workspaceId)?.documentForRestore(lookup), key = document && hostedKey(document);
        if (key) {await resolveUnload(key, joined); touch(key);}
        const consumer = consumerForRestore(lookup);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), joined, work => operation(consumer, lookup, work));
      }));
    };
    const update = (value: ServiceHostedSet, callerSignal?: AbortSignal) => exclusive(() => withLiveHostSignal(signal, callerSignal, async joined => {
      if (!activation || config.workspaces.length || config.activation!.targets.length) throw new Error("Only an activation host that starts empty takes membership updates.");
      const workspaces = value.workspaces.map(parseServiceWorkspace), desired = new Map(workspaces.map(row => [row.workspaceId, row]));
      const wanted = new Map(value.documents.map(item => {
        const target = parseServiceActivationTarget({workspaceId: item.workspaceId, path: item.path, shareId: item.shareId});
        return [JSON.stringify([target.workspaceId, target.path]), {target, objectId: parseLiveUpdateIdentifier(item.objectId, "object ID")}] as const;
      }));
      if (wanted.size !== value.documents.length) throw new Error("Duplicate service activation target.");
      checkServiceMembership(workspaces, [...wanted.values()].map(row => row.target));
      const departing = new Map(value.departing.map(row => {
        const document = {target: parseServiceActivationTarget({workspaceId: row.workspaceId, path: row.path, shareId: row.shareId}),
          objectId: parseLiveUpdateIdentifier(row.objectId, "object ID")};
        if (!desired.has(document.target.workspaceId)) throw new Error("Departing document's workspace is not configured.");
        return [JSON.stringify([document.target.workspaceId, document.objectId]), document] as const;
      }));
      // An identity change fences the old identity: the relay refuses its
      // settlement and replication, so its unsettled work stays in the old
      // workspace store and this host does not settle it. The old attachment
      // detaches at once without unloading, and the workspace attaches again
      // under its new identity, root and credential.
      const obsolete = (workspaceId: string, workspace: ServiceWorkspace) => {
        const attached = workspace.hostedReplication?.identity, current = storage.getWorkspaceIdentity(workspaceId);
        return attached !== undefined && (attached.replicationEpoch !== current?.replicationEpoch || attached.streamIdentity !== current?.streamIdentity);
      };
      const changed = [...members].filter(([workspaceId, member]) => desired.has(workspaceId)
        ? !isDeepStrictEqual(desired.get(workspaceId), member.workspace) : obsolete(workspaceId, member.workspace))
        .map(([workspaceId]) => workspaceId);
      // A document that left stays in passes, which settle, publish and unload it.
      // One that returns before it is gone activates again; a recovered or parking one was never in activation passes.
      for (const [key, document] of hosted) {
        if (isDeepStrictEqual(wanted.get(key), document)) {
          if (leaving.delete(key)) {
            recovering.delete(key); parking.delete(key); keeping.delete(key); grantsEnded.delete(key); heldOf.delete(key); observed.delete(key);
            activation.addTarget(document.target, document.objectId);
          }
        } else if (!changed.includes(document.target.workspaceId)) leaving.add(key);
      }
      // A workspace stays wanted while anything of it may remain in its replica, so one that is not has nothing left to drain.
      for (const workspaceId of [...members.keys()]) if (!desired.has(workspaceId) || changed.includes(workspaceId)) await detach(workspaceId, joined);
      for (const workspace of workspaces) if (!members.has(workspace.workspaceId) && !diverged.has(workspace.root)) await attach(workspace, joined);
      for (const [key, document] of wanted) {
        if (!hosted.has(key) && members.has(document.target.workspaceId)) {activation.addTarget(document.target, document.objectId); hosted.set(key, document); touch(key);}
      }
      // A fresh daemon has nothing loaded, but an earlier one may have left a
      // departing document's work unsettled in its store. Passes settle each
      // one still at its enrolled path, then publish and unload it. One that
      // moved is not settled there; it stays only for its owner's recovery
      // copy, whatever document now holds its old path.
      if (!updated) {
        for (const document of departing.values()) {
          const {workspaceId, path} = document.target, key = JSON.stringify([workspaceId, path]);
          if (!members.has(workspaceId)) continue;
          if (storage.objectIdAtPathInVersion({workspaceId, versionId: "main", path}) !== document.objectId) {
            if (uncopied(document)) retained.set(documentKey({workspaceId, objectId: document.objectId}), document);
            continue;
          }
          if (!hosted.has(key)) {hosted.set(key, document); leaving.add(key); recovering.add(key);}
        }
      }
      // A departing document is confirmed gone only by a pull that starts after this.
      for (const [workspaceId, attached] of attachments) {
        for (const objectId of attached.announced.keys()) if (!departing.has(JSON.stringify([workspaceId, objectId]))) attached.announced.delete(objectId);
      }
      for (const document of departing.values()) {
        const attached = attachments.get(document.target.workspaceId);
        if (attached && !attached.announced.has(document.objectId)) attached.announced.set(document.objectId, attached.pulls + 1);
      }
      registerRetained();
      updated = true;
    }));
    // Detaches a workspace whose replica drained. Its caller then releases its enrollments and keeps the store.
    const detachDrained = (workspaceId: string, callerSignal?: AbortSignal) => exclusive(() => withLiveHostSignal(signal, callerSignal, async joined => {
      if (!drained(workspaceId)) return false;
      await detach(workspaceId, joined);
      return true;
    }));
    const drained = (workspaceId: string) => {
      const attached = attachments.get(workspaceId);
      return !!attached && ![...hosted.values(), ...retained.values()].some(row => row.target.workspaceId === workspaceId) && attached.confirmed === attached.pulls &&
        attached.hosted.departedNone && [...attached.announced.values()].every(required => required <= attached.confirmed);
    };
    if(config.activation){
      // A configured replica checks its origin before the host serves restores or passes activate. One that could not retries on each pass.
      for(const workspaceId of [...attachments.keys()])yield* Effect.promise(()=>checkOrigin(workspaceId,signal).catch(()=>{}));
      activation=new ServiceActivationDriver({trustedAccount:options.trustedAccount,storage,history,client,host:coordinate,workspace:checked,config:config.activation,
        adoption:config.adoption!,restore,nextRequestId,deadlineMs:config.client.requestDeadlineMs,assertCurrent:checkPreparing,
        maxApplications:config.settlement?.maxApplicationsPerSettlement,
        registered(){registered=true;},runDocument:(document,signal,operation)=>runDocument(document,signal,operation)});
      registerRetained();
      let index=0,lastError:string|undefined,lastIdleError:string|undefined;
      const pass=async()=>{
        const bounds=config.activation!;
        const passSignal=AbortSignal.any([signal,AbortSignal.timeout(bounds.passDeadlineMs)]);
        let failed=false;
        // One failed step does not hold back the others.
        const step=async(work:()=>Promise<unknown>)=>{
          try{await work();}
          catch(error){
            failed=true;
            const message=error instanceof Error?error.message:String(error);
            if(!signal.aborted && message!==lastError){
              lastError=message;
              try{console.error("Service activation pass failed.",message);}catch{ /* Reporting must not stop activation. */ }
            }
          }
        };
        // A replica that has not checked its origin checks it first. Until it succeeds, its workspace's steps wait.
        for(const workspaceId of [...attachments.keys()])await step(()=>checkOrigin(workspaceId,passSignal));
        // Departures go first: a document an earlier daemon left resumes only before a pull adopts the scope it left.
        for(const key of [...leaving])await step(async()=>{
          const waiting=await depart(key,passSignal);
          if(waiting!==undefined)throw new Error(`Departing live document is waiting: ${waiting}`);
        });
        // A document whose owner lost live authority but that has not left, as right after Stop, records
        // what the engine applied before anything publishes, so its output does not hold back its workspace's.
        // One whose activation retires reconciles, settles and publishes here until it leaves.
        for(const [key,row] of [...hosted]){
          if(leaving.has(key) || !checked(row.target.workspaceId))continue;
          await step(async()=>{
            if(await retire(key,passSignal)!==null || unloading.has(key) || !authorityLost(row))return;
            const document=activation!.departing(row.target,passSignal);
            if(document)await runDocument(document,passSignal,operation=>activation!.reconcileDeparted(row.target,document,operation));
          });
        }
        for(const key of [...retained.keys()])await step(async()=>{
          const waiting=await keepRetained(key,passSignal);
          if(waiting!==undefined)throw new Error(`Departing live document is waiting: ${waiting}`);
        });
        // A dormant document stays out of memory until someone opens it. One whose
        // unload is unanswered may hold an ended registration until the unload is sent again.
        // A departing one whose owner lost live authority only settles what the host applied.
        const targets=activation!.targets.filter(target=>{
          const key=JSON.stringify([target.workspaceId,target.path]),row=hosted.get(key);
          return checked(target.workspaceId) && !activation!.dormant(target) && !unloading.has(key) && !(row && leaving.has(key) && authorityLost(row));
        });
        // Targets with no owner share one catch-up pull of their workspace a pass.
        const catchUp:ServiceCatchUp=new Map();
        await step(async()=>{
          for(let visited=0;visited<Math.min(bounds.maxDocumentsPerPass,targets.length);visited++){
            index%=targets.length;
            const target=targets[index]!;index=(index+1)%targets.length;
            // Settlement runs in the activation's own document work. A restore
            // fence during it leaves the pass pending rather than ready.
            await activation!.activate(target,passSignal,settleTarget,catchUp);
          }
        });
        // Every ready workspace pushes, then pulls. One with no documents still pulls, so its replica retires what left.
        // One that is not ready only pulls, once a pass unless an activation above caught it up, so its held lists page
        // on and an ended hold is freed, however long another document holds readiness back. One whose replica has not
        // checked its origin does neither.
        for(const [workspaceId,attached] of [...attachments]){
          if(!attached.hosted.checked)continue;
          if(activation!.workspaceReady(workspaceId))await step(async()=>{await attached.hosted.push(passSignal);await pull(attached,passSignal);});
          else if(!catchUp.has(workspaceId))await step(()=>pull(attached,passSignal));
        }
        // A diverged replica runs nothing more. Its workspace detaches for good, and its store stays.
        // It counts as diverged before the detach, which a lost reply or an exiting engine can fail.
        for(const [workspaceId,attached] of [...attachments]){
          if(attached.hosted.diverged)await step(async()=>{
            diverged.set(members.get(workspaceId)!.workspace.root,workspaceId);
            await detach(workspaceId,passSignal);
          });
        }
        if(!failed)lastError=undefined;
      };
      // Unloads hosted documents with no live connection for the idle period.
      // Unfinished delivery, settlement, publication, or engine work keeps a
      // document loaded until a later sweep retries it.
      const sweep=async()=>{
        const bounds=config.activation!;let visited=0;
        for(const [key,row] of hosted){
          const state=idle.get(key);
          if(visited>=bounds.maxDocumentsPerPass || signal.aborted)break;
          if(!state || Date.now()<state.due || activation!.dormant(row.target) || leaving.has(key) ||
            editors.connected({workspaceId:row.target.workspaceId,objectId:row.objectId}))continue;
          visited++;
          let waiting:string|undefined;
          try{waiting=await sleep(key,row,state.generation,AbortSignal.any([signal,AbortSignal.timeout(bounds.passDeadlineMs)]));}
          catch(error){waiting=error instanceof Error?error.message:String(error);}
          if(waiting===undefined || idle.get(key)?.generation!==state.generation)continue;
          idle.set(key,{due:Date.now()+bounds.idleRetryMs,generation:state.generation});
          if(!signal.aborted && waiting!==lastIdleError){
            lastIdleError=waiting;
            try{console.error("Idle live document unload is waiting.",waiting);}catch{ /* Reporting must not stop activation. */ }
          }
        }
      };
      const pause = Effect.callback<void>(resume => {
        const timer = setTimeout(() => resume(Effect.void),config.activation!.pollIntervalMs);
        timer.unref();
        return Effect.sync(() => clearTimeout(timer));
      });
      yield* Effect.forkScoped(Effect.gen(function* () {
        while (!signal.aborted) {
          // Native passes retain ownership until their actual work settles.
          yield* Effect.uninterruptible(Effect.promise(() => exclusive(async () => {await pass(); await sweep();})));
          yield* pause;
        }
      }));
    }
    return Object.freeze({ coordinate, invalidated: signal,
      /**
       * Moves this running daemon to the hosted set. It attaches each wanted
       * workspace and adds its documents to activation. Passes settle, publish
       * and unload documents that left, while their workspace stays attached.
       * On a fresh daemon, they first resume departing documents that are
       * still enabled. A workspace that is no longer wanted, or whose identity
       * changed, detaches at once. Each workspace it attaches checks its
       * replica's origin before anything else; a diverged store detaches and
       * stays detached.
       */
      update,
      /**
       * Detaches each workspace of a deleted account at once, without
       * settling, publishing or unloading anything, then removes its store,
       * diverged or not. The account is gone, so nothing is left to settle.
       */
      async deleteWorkspaces(workspaceIds: readonly string[]) {
        await exclusive(() => withLiveHostSignal(signal, undefined, async joined => {
          for (const workspaceId of workspaceIds) {
            await recoveryTurn(workspaceId, () => closeRecovery(workspaceId));
            const member = members.get(workspaceId), roots = [...diverged].flatMap(([root, id]) => id === workspaceId ? [root] : []);
            if (member) {roots.push(member.workspace.root); await detach(workspaceId, joined);}
            for (const root of roots) {await rm(root, {recursive: true, force: true}); diverged.delete(root);}
          }
        }));
      },
      /**
       * Whether this daemon may still hold any of the document: it is hosted,
       * unloading or retained for its owner's recovery copy, its workspace is
       * not attached, no pull that started after it departed has succeeded,
       * or the last departed list of such a pull that reached it listed it in
       * its replica, or none reached it yet.
       */
      retains(document: {workspaceId: string; objectId: string}): boolean {
        const attached = attachments.get(document.workspaceId), required = attached?.announced.get(document.objectId);
        return hostedKey(document) !== undefined || retained.has(documentKey(document)) || !attached || required === undefined || attached.confirmed < required ||
          !goneSince(attached, document.objectId, required);
      },
      /**
       * Whether the departed document stayed through a pull after it
       * departed whose departed list reached it, listed or not, and nothing
       * of it is loaded now. That list may have reached it before it
       * unloaded, so one it still retains waits for a later list.
       */
      pulledAfterDeparture(document: {workspaceId: string; objectId: string}): boolean {
        const attached = attachments.get(document.workspaceId), required = attached?.announced.get(document.objectId);
        return hostedKey(document) === undefined && !retained.has(documentKey(document)) && required !== undefined && attached!.confirmed >= required &&
          reachedSince(attached!, document.objectId, required);
      },
      /** Whether this daemon has delivered and settled the hosted document, in an activation pass or before it unloaded idle. */
      settled(document: {workspaceId: string; objectId: string}): boolean {
        const key = hostedKey(document), row = key === undefined ? undefined : hosted.get(key);
        return !!row && (activation!.completed(row.target) || activation!.dormant(row.target));
      },
      /**
       * Whether a workspace with no documents can detach: nothing of it is
       * loaded, and its last pull succeeded with nothing departed.
       */
      drained,
      /** Detaches a drained workspace. Resolves to whether it did; the caller then releases its enrollments and keeps its store. */
      detachDrained,
      /** The workspaces whose replica diverged from the relay, with their stores. Each stays detached on this daemon. */
      diverged(): readonly {readonly workspaceId: string; readonly root: string}[] {
        return [...diverged].map(([root, workspaceId]) => ({workspaceId, root}));
      },
      /** Why the hosted document failed the one capture it gets while it cannot progress and waits for its owner, if it did. */
      blocked(document: {workspaceId: string; objectId: string}): ServiceActivationBlock | undefined {
        const key = hostedKey(document);
        return key === undefined ? undefined : activation!.blocked(hosted.get(key)!.target);
      },
      /** Why the hosted pass left this document held, until a capture succeeds. */
      holdReason(document: {workspaceId: string; objectId: string}) {
        const key = hostedKey(document);
        return key === undefined ? undefined : activation!.holdReason(hosted.get(key)!.target);
      },
      /**
       * Lets a blocked hosted document try one more capture on the next pass,
       * as when its owner tries again. Returns whether it was blocked.
       */
      unblock(document: {workspaceId: string; objectId: string}): boolean {
        const key = hostedKey(document);
        return key !== undefined && activation!.unblock(hosted.get(key)!.target);
      },
      /**
       * Reads one bounded page of a refused queue this host keeps, as the
       * engine pages a recovery read, for its owner's recovery copy. `cursor`
       * is the previous page's, and the engine answers `readChanged` once the
       * queue changed under it. It admits, settles and publishes nothing.
       * `store` is the root of the store that holds the queue: a queue of an
       * earlier identity of its workspace is read there, through a read-only
       * recovery handle, even on a daemon that hosts no document; one of the
       * current identity, or of the store still attached, through its attachment.
       */
      readKeptEditsPage(kept: ServiceKeptEdits, cursor: JsonValue | undefined, store: string, callerSignal?: AbortSignal): Promise<JsonValue> {
        if (!sameKeptEditsIdentity(kept.identity, attachments.get(kept.workspaceId)?.identity) &&
          !sameKeptEditsIdentity(kept.identity, storage.getWorkspaceIdentity(kept.workspaceId))) return readEarlierKeptEdits(kept, store, cursor, callerSignal);
        check();
        return withKeptOutbox(kept, callerSignal, async (_outbox, joined) => {
          try {
            return keptPage((await client.sendRequest({id: nextRequestId(), workspace: reachable(kept).handle, method: "ydoc.ownerOutbox.readPending",
              params: {outboxId: kept.outboxId, ...(cursor === undefined ? {} : {cursor})}, deadlineMs: config.client.requestDeadlineMs}, joined)).result);
          } catch (error) {
            // A refused seed whose earlier generation's final accepted state was not kept.
            if (error instanceof EngineRequestError && error.wireError?.message === "owner-outbox-recovery-checkpoint-unavailable") throw recoveryRefusal(error);
            throw error;
          }
        });
      },
      /**
       * Closes the recovery handle of the earlier store that holds the queue,
       * once no refusal kept in that store waits for a recovery copy.
       */
      releaseKeptEditsStore(kept: ServiceKeptEdits): Promise<void> {
        return recoveryTurn(kept.workspaceId, async () => {
          const open = recoveries.get(kept.workspaceId);
          if (open && sameKeptEditsIdentity(open.identity, kept.identity) && !storage.serviceKeptEditsStoreHeld(kept.workspaceId, kept.identity)) {
            await closeRecovery(kept.workspaceId);
          }
        });
      },
      /**
       * Grants the refused head of a hosted document one more delivery attempt,
       * then wakes the document so a pass delivers it. In the document's work,
       * right before the grant, `guard` rechecks its caller and the host
       * rechecks its owner's live authority and the refusal. `unavailable`
       * while its owner has no live authority over it here, and `changed`
       * once the refusal changed or already has a Try again; neither grants.
       */
      async retryKeptEdits(kept: ServiceKeptEdits, guard: () => void, callerSignal?: AbortSignal): Promise<"granted" | "changed" | "unavailable"> {
        check();
        const live = () => {
          const key = hostedKey(kept.binding), row = key === undefined ? undefined : hosted.get(key);
          return key !== undefined && !!row && !leaving.has(key) && !authorityLost(row);
        };
        if (!live()) return "unavailable";
        const outcome = await withKeptOutbox(kept, callerSignal, async outbox => {
          guard();
          if (!live()) return "unavailable" as const;
          const current = storage.readServiceKeptEdits(kept);
          if (current?.generation !== kept.generation || current.retrying) return "changed" as const;
          await outbox.retry({outboxId: kept.outboxId, binding: kept.binding});
          // A grant the relay could not record ends at once.
          let marked = false;
          try {marked = storage.markServiceKeptEditsRetrying(kept);}
          finally {if (!marked) await outbox.quarantine({outboxId: kept.outboxId, reason: kept.reason});}
          return marked ? "granted" as const : "changed" as const;
        });
        if (outcome === "granted") await wake(kept.binding, callerSignal);
        return outcome;
      },
      /** Whether the document can be opened now. A dormant document reloads when it is opened. */
      isDocumentReady(document: LiveDocumentKey): boolean {
        try {
          check();
          const parsed = parseLiveDocumentKey(document);
          return activation?.asleep(parsed) === true || consumerFor(parsed) !== undefined;
        } catch { return false; }
      },
      /**
       * The claim ledger of a workspace this host replicates as its owner,
       * where it claims each accepted frame's field changes, for the relay's
       * automations. Null for any other workspace, one whose replica has not
       * checked its origin, or once this host retired.
       */
      automationLedger(workspaceId: string): LiveClaimLedger | null {
        const attached = checked(workspaceId);
        if (!attached || signal.aborted) return null;
        let ledger = ledgers.get(workspaceId);
        if (!ledger) {
          ledger = Object.freeze({engine: new VersionedLiveAdapter(client!, attached.handle, {workspaceId}), incarnation: coordinate.connectionId});
          ledgers.set(workspaceId, ledger);
        }
        return ledger;
      },
      /** The engine's events, such as a claim it made for an accepted frame. */
      onEvent(handler: (event: Event) => void): () => void {
        return client!.onEvent(handler);
      },
      async captureNative(value: LiveObjectBinding, callerSignal?: AbortSignal) {
        if (!changes || !config.sync) throw new Error("Named frame sync is not configured on this service host.");
        const binding = parseLiveObjectBinding(value);
        const document = parseLiveDocumentKey({workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId});
        await wake(document, callerSignal);
        await drain(document, callerSignal);
        check();
        const consumer = consumerFor(document)!;
        const registration = consumer.captureRegistration(binding);
        return Object.freeze({client: attachments.has(document.workspaceId)?activation!.consumer(document).transport.client:client!, workspace: consumer.workspace,
          registrationId: registration.id, binding: registration.binding, coordinate, invalidated: AbortSignal.any([signal, registration.invalidated]),
          changes, nextRequestId, deadlineMs: config.client.requestDeadlineMs, drain});
      },
      /**
       * The documents a hosted replica of this daemon holds for retained work a
       * released chain left, in object ID order after `afterObjectId`. Null for a
       * workspace it does not replicate.
       */
      async heldDocuments(workspaceId: string, page: {afterObjectId?: string; limit: number}, callerSignal?: AbortSignal) {
        const listed = await heldRead(workspaceId, "sync.heldDocuments",
          {...(page.afterObjectId === undefined ? {} : {afterObjectId: page.afterObjectId}), limit: page.limit}, false, callerSignal);
        return listed === null || "invalidated" in listed ? listed : listed.result;
      },
      /**
       * One held document, whether its binding stands, and what that binding preserves; with
       * `markdown`, its whole Markdown however long. Null when nothing is held there.
       */
      async heldDocument(workspaceId: string, objectId: string, read: {markdown: boolean}, callerSignal?: AbortSignal) {
        const inspected = await heldRead(workspaceId, "sync.heldDocument", {objectId, ...(read.markdown ? {stream: "markdown"} : {})},
          read.markdown, callerSignal);
        if (inspected === null || "invalidated" in inspected) return inspected;
        return inspected.result === null || !read.markdown ? inspected.result : withStreamedMarkdown(inspected.result, inspected.streamed);
      },
      /** One held document with its contribution artifact, exactly the bytes its inspection names. */
      async heldContributions(workspaceId: string, objectId: string, callerSignal?: AbortSignal) {
        const inspected = await heldRead(workspaceId, "sync.heldDocument", {objectId, stream: "contributions"}, true, callerSignal);
        if (inspected === null || "invalidated" in inspected) return inspected;
        return inspected.result === null ? null : withStreamedContributions(inspected.result, inspected.streamed);
      },
      get restoreConfigured() { return restore !== undefined; },
      async prepareRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        return restoring(value, callerSignal, (consumer, lookup, joined) => consumer.prepareRestore(lookup, joined));
      },
      async reviewRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        return restoring(value, callerSignal, (consumer, lookup, joined) => consumer.reviewRestore(lookup, joined));
      },
      async confirmRestore(value: StopRestoreLookup, proposalDigest: string, callerSignal?: AbortSignal) {
        return restoring(value, callerSignal, (consumer, lookup, joined) => consumer.confirmRestore(lookup, proposalDigest, joined));
      },
      async completeRestore(value: StopRestoreLookup, proposalDigest: string, callerSignal?: AbortSignal) {
        return restoring(value, callerSignal, (consumer, lookup, joined) => consumer.completeRestore(lookup, proposalDigest, joined));
      },
      async stopRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        return restoring(value, callerSignal, (consumer, lookup, joined) => consumer.stopRestore(lookup, joined));
      },
      async settle(value: LiveDocumentKey, callerSignal?: AbortSignal) {
        check();
        if (!config.settlement) throw new Error("Settlement is not configured on this service host.");
        const document = parseLiveDocumentKey(value);
        return deliver(document, callerSignal, (consumer, joined) => consumer.settle(document, joined));
      },
      drain,
      close,
    });
  }),Scope.Scope,scope));
  try {
    const result = await startup;
    changes?.notifyHost([...members.keys()]);
    return result;
  } catch (error) {
    signal.removeEventListener("abort",abort);
    try {await close();}
    catch (cleanupError) {
      try {console.error("Service host startup cleanup failed.",cleanupError);} catch { /* Preserve the startup failure. */ }
    }
    throw error;
  }
}
