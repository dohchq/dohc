import {parseServiceActivationConfig,parseServiceActivationTarget,ServiceActivationDriver,type ServiceActivationConfig,type ServiceActivationTarget} from "./serviceActivationDriver";
import {liveHostSignal, withLiveHostSignal} from "./liveHostSignal.js";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges.js";
import {parseNativeLiveSyncConfig} from "./liveSyncConfig.js";
import {LiveDocumentWork} from "./liveDocumentWork.js";
import {queueLiveHostRequests} from "./liveHostRequests.js";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { createEngineClient, EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { VersionedLiveAdapter, type Event, type JsonValue } from "@dohc/workspace-engine-client";
import type { LiveClaimLedger } from "./automationLiveClaims.js";
import { parseLiveDocumentKey, parseLiveUpdateIdentifier, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { LiveCommittedDelivery, type CommittedDeliveryOutcome } from "./liveCommittedDelivery.js";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory.js";
import type { LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import { parseLiveSettlementConfig, type LiveSettlementConfig } from "./liveSettlementConfig.js";
import {snapshotStopRestoreLookup} from "./liveRestoreDelivery.js";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation.js";
import {parseLiveRestoreConfig, LiveRestorePreparation, type LiveRestoreConfig} from "./liveRestorePreparation.js";
import {parseServiceOrdinaryReplicationConfig, ServiceOrdinaryReplication} from "./serviceOrdinaryReplication.js";
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
/** The workspaces and documents a host that started empty should hold. */
export interface ServiceHostedSet {
  readonly workspaces: readonly ServiceWorkspace[];
  readonly documents: readonly {readonly workspaceId: string; readonly objectId: string; readonly path: string; readonly shareId: string}[];
}
function parseServiceWorkspace(item: unknown) {
  const row = record(item, ["root", "workspaceId", "maxRegistrations"], ["ordinaryReplication"]);
  return Object.freeze({ root: path(row.root, true), workspaceId: parseLiveUpdateIdentifier(row.workspaceId, "workspace ID"),
    maxRegistrations: integer(row.maxRegistrations), ordinaryReplication: parseServiceOrdinaryReplicationConfig(row.ordinaryReplication) });
}
function checkServiceMembership(workspaces: readonly ServiceWorkspace[], targets: readonly ServiceActivationTarget[]) {
  if (new Set(workspaces.map(row => row.workspaceId)).size !== workspaces.length ||
    new Set(workspaces.map(row => process.platform === "win32" ? row.root.toLowerCase() : row.root)).size !== workspaces.length) throw new TypeError("Duplicate service workspace.");
  for(const target of targets){
    const workspace=workspaces.find(row=>row.workspaceId===target.workspaceId);
    if(!workspace?.ordinaryReplication || targets.filter(row=>row.workspaceId===target.workspaceId).length>workspace.maxRegistrations)throw new Error("Service activation workspace is not configured.");
  }
}

/** Operator configuration only. Incoming document fields never supply these paths. */
export function readServiceLiveHostConfig(configPath: string): ServiceLiveHostConfig {
  const value = record(JSON.parse(readFileSync(path(configPath, false), "utf8")),
    ["version", "engineExecutable", "hostId", "instanceId", "workspaces", "ingress", "client"], ["settlement", "restore", "sync", "adoption", "activation"]);
  // A host may start empty; `update` attaches workspaces as documents are shared.
  if (value.version !== 1 || !Array.isArray(value.workspaces)) throw new TypeError("Invalid service host configuration.");
  const workspaces = value.workspaces.map(parseServiceWorkspace);
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
  const activation=parseServiceActivationConfig(value.activation);
  const sync=parseNativeLiveSyncConfig(value.sync,integer(ingress.aggregateBytes));
  checkServiceMembership(workspaces, activation?.targets ?? []);
  if(activation && (!adoption || !sync || activation.maxCaptureBytes>Math.min(sync.policy.maxReadBytes,sync.policy.maxOutputBytes))){
    throw new Error("Service activation requires bounded native adoption and sync.");
  }
  const applicationWorkingReserveBytes = integer(ingress.applicationWorkingReserveBytes, 0);
  if (applicationWorkingReserveBytes === 0) throw new TypeError("Live application requires a positive applicationWorkingReserveBytes limit.");
  return Object.freeze({ version: 1, engineExecutable: path(value.engineExecutable, false),
    hostId: parseLiveUpdateIdentifier(value.hostId, "host ID"), instanceId: parseLiveUpdateIdentifier(value.instanceId, "instance ID"),
    workspaces: Object.freeze(workspaces),
    settlement, restore, adoption, activation, sync,
    ingress: Object.freeze({ aggregateBytes: integer(ingress.aggregateBytes), applicationWorkingReserveBytes,
      maxUploads: integer(ingress.maxUploads), uploadDeadlineMs: integer(ingress.uploadDeadlineMs, 1, 2_147_483_647) }),
    client: Object.freeze({ aggregateBytes: integer(client.aggregateBytes), maxUploads: integer(client.maxUploads),
      connectTimeoutMs: integer(client.connectTimeoutMs, 1, 2_147_483_647), requestDeadlineMs: integer(client.requestDeadlineMs, 1, 2_147_483_647) }),
  });
}

const held = new WeakSet<SyncRelayStorage>();

/** Owns one configured service incarnation and its durable delivery consumers. */
export async function startServiceLiveHost(options: {
  configPath: string;
  storage: SyncRelayStorage;
  history: LiveJournalHistoryAuthority;
  signal?: AbortSignal;
  frameChanges?: LiveHostChanges;
}) {
  const { storage, history } = options;
  const config = readServiceLiveHostConfig(options.configPath);
  // An activation host registers when its first document activates, even if it starts empty.
  const preparingOrdinary = config.activation !== undefined || config.workspaces.some(row => row.ordinaryReplication !== undefined);
  const standing = storage.captureStanding();
  if (!history.reconciled || held.has(storage)) throw new Error("Service host is unavailable.");
  const control = storage.getLiveHostControl();
  if (!control || control.configuredMode !== "service" || control.configuredHostId !== config.hostId || control.transition ||
    (control.registeredInstanceId !== null && control.registeredInstanceId !== config.instanceId)) throw new Error("Service host does not match provisioned control.");
  if (preparingOrdinary && !config.activation && control.registeredConnectionId !== null) throw new Error("Ordinary service preparation requires an unregistered host.");
  const coordinate: LiveHostConnectionCoordinate = Object.freeze({ mode: "service", hostId: config.hostId, hostEpoch: control.hostEpoch,
    instanceId: config.instanceId, connectionId: randomUUID() });
  const host = { hostId: coordinate.hostId, hostEpoch: coordinate.hostEpoch, instanceId: coordinate.instanceId, connectionId: coordinate.connectionId };
  const invalidated = new AbortController();
  const lifetime = liveHostSignal(storage.unavailable, invalidated.signal, options.signal);
  const signal = lifetime.signal;
  const changes = options.frameChanges;
  const scope = Scope.makeUnsafe();
  const consumers = new Map<string, LiveCommittedDelivery>();
  const ordinary = new Map<string, ServiceOrdinaryReplication>();
  const documents = new LiveDocumentWork();
  const attachments=new Map<string,{handle:string;ordinary:ServiceOrdinaryReplication}>();
  const ledgers = new Map<string, LiveClaimLedger>();
  // Attached workspaces and hosted documents, as `update` last left them.
  const members = new Map<string, {handle: string; workspace: ServiceWorkspace}>();
  const hosted = new Map<string, {target: ServiceActivationTarget; objectId: string}>();
  // Activation passes and membership changes take turns, so a pass never
  // activates a document while an update unloads it.
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
  const check = () => {
    standing();
    if (signal.aborted || !history.reconciled) throw new Error("Service host is unavailable.");
    const current = storage.getLiveHostControl();
    if (!current || current.transition || current.configuredMode !== "service" || current.configuredHostId !== coordinate.hostId ||
      current.hostEpoch !== coordinate.hostEpoch || current.registeredInstanceId !== coordinate.instanceId ||
      current.registeredConnectionId !== coordinate.connectionId || current.admissionState !== "open") throw new Error("Service host registration was retired.");
  };
  const checkPreparing = () => {
    if(registered){check();return;}
    standing(); signal.throwIfAborted();
    if (!history.reconciled || !isDeepStrictEqual(storage.getLiveHostControl(), control)) throw new Error("Ordinary service preparation was retired.");
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
  const consumerFor=(document:LiveDocumentKey)=>ordinary.has(document.workspaceId)
    ? activation?.consumer(document).consumer
    : consumers.get(document.workspaceId);
  const consumerForRestore=(lookup:StopRestoreLookup)=>{
    const document=consumers.get(lookup.workspaceId)?.documentForRestore(lookup);
    return document?(ordinary.has(document.workspaceId)?activation?.restoreConsumer(document):consumerFor(document)):undefined;
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
    const temporary = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "dohc-service-live-host-"))),
      directory => Effect.promise(() => rm(directory,{recursive: true,force: true})),
    );
    const nativeConfig = join(temporary, "host.json");
    yield* Effect.promise(() => writeFile(nativeConfig, JSON.stringify({ version: 1, relayNamespace: history.namespace, host,
      workspaces: config.workspaces.map(({ordinaryReplication, ...workspace}) => ({...workspace,
        ...(ordinaryReplication ? {relay: ordinaryReplication.relay} : {})})),
      ingress: config.ingress, settlement: config.settlement, sync: config.sync, adoption: config.adoption,
      restore: config.restore ? {maxBytes: config.restore.maxBytes, maxEvents: config.restore.maxEvents} : undefined }), { flag: "wx", mode: 0o600 }));
    signal.throwIfAborted();
    const native = yield* Effect.acquireRelease(Effect.promise(() => createEngineClient({ command: config.engineExecutable, authToken: randomBytes(32).toString("base64url"),
      protocolVersion: 2, capabilities: ["blobs"], privateLiveApplication: config.client, connectTimeoutMs: config.client.connectTimeoutMs,
      env: { DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig }, signal,
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
      const attachment = workspace.ordinaryReplication;
      if (!attachment) return;
      const driver = new ServiceOrdinaryReplication({client, workspace: handle, workspaceId: workspace.workspaceId, nextRequestId,
        deadlineMs: config.client.requestDeadlineMs, signal, assertCurrent: checkPreparing}, attachment);
      ordinary.set(workspace.workspaceId, driver);
      attachments.set(workspace.workspaceId, {handle, ordinary: driver});
    };
    for (const [index, value] of reply.workspaces.entries()) install(config.workspaces[index]!, value);
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (registered && !storage.unavailable.aborted) storage.disconnectLiveHost({...coordinate,updatedAtMs: Date.now(),guard: standing});
    }));
    standing();
    if (signal.aborted || !history.reconciled) throw new Error("Service host startup cancelled.");
    if (preparingOrdinary) {
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
      const {ordinaryReplication, ...entry} = workspace;
      const result = await membershipRequest("liveApplication.attachWorkspace", undefined,
        {...entry, ...(ordinaryReplication ? {relay: ordinaryReplication.relay} : {})}, joined);
      joined.throwIfAborted();
      try {install(workspace, result);} catch (error) {abort(); throw error;}
      changes?.notifyHost([workspace.workspaceId]);
    };
    // Detach does not wait for unsettled work. The workspace store keeps it until the workspace attaches again.
    const detach = async (workspaceId: string, joined: AbortSignal) => {
      try {await membershipRequest("liveApplication.detachWorkspace", members.get(workspaceId)!.handle, {}, joined);}
      catch (error) {
        // The workspace is already closed, as after a detach whose reply was lost.
        if (engineCode(error) !== "WORKSPACE_UNAVAILABLE") throw error;
      }
      members.delete(workspaceId); consumers.delete(workspaceId); ordinary.delete(workspaceId);
      attachments.delete(workspaceId); ledgers.delete(workspaceId);
      for (const [key, document] of hosted) {
        if (document.target.workspaceId === workspaceId) {activation!.removeTarget(document.target, document.objectId); hosted.delete(key);}
      }
      changes?.notifyHost([workspaceId]);
    };
    // False while the engine holds unsettled work for the document. It stays in
    // activation passes, which settle it, until a later update unloads it.
    const unload = async (document: {target: ServiceActivationTarget; objectId: string}, joined: AbortSignal) => {
      if (activation!.loaded(document.target)) {
        const send = async () => {
          try {
            const result = await membershipRequest("liveApplication.unloadDocument", members.get(document.target.workspaceId)!.handle,
              {objectId: document.objectId}, joined);
            const status = result && typeof result === "object" ? (result as Record<string, unknown>).status : undefined;
            if (status === "pending") return false;
            if (status !== "unloaded") throw new Error("Invalid live document unload response.");
          } catch (error) {
            // Nothing of the document is loaded, as after an unload whose reply was lost.
            if (engineCode(error) !== "WORKSPACE_UNAVAILABLE") throw error;
          }
          return true;
        };
        // Unload waits for delivery and settlement already running on the document.
        const owned = activation!.ownerDocument(document.target);
        if (!(owned ? await runDocument(owned, joined, send) : await send())) return false;
      }
      activation!.removeTarget(document.target, document.objectId);
      return true;
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
      // A workspace whose identity changed, and with it its root and credential, attaches again at once.
      const changed = [...members].filter(([workspaceId, member]) => desired.has(workspaceId) && !isDeepStrictEqual(desired.get(workspaceId), member.workspace))
        .map(([workspaceId]) => workspaceId);
      const retiring: {workspaceId: string; objectId: string}[] = [];
      for (const [key, document] of hosted) {
        if (changed.includes(document.target.workspaceId) || isDeepStrictEqual(wanted.get(key), document)) continue;
        if (await unload(document, joined)) hosted.delete(key);
        else retiring.push({workspaceId: document.target.workspaceId, objectId: document.objectId});
      }
      // Any other workspace detaches only once its last document unloads, so
      // its unsettled work keeps settling while it stays attached.
      const holding = new Set([...hosted.values()].map(document => document.target.workspaceId));
      const leaving = [...changed, ...[...members.keys()].filter(workspaceId => !desired.has(workspaceId) && !holding.has(workspaceId))];
      for (const workspaceId of leaving) await detach(workspaceId, joined);
      for (const workspace of workspaces) if (!members.has(workspace.workspaceId)) await attach(workspace, joined);
      for (const [key, document] of wanted) {
        if (!hosted.has(key)) {activation.addTarget(document.target); hosted.set(key, document);}
      }
      registerRetained();
      return retiring;
    }));
    if(config.activation){
      activation=new ServiceActivationDriver({storage,history,client,host:coordinate,workspaces:attachments,config:config.activation,
        adoption:config.adoption!,restore,nextRequestId,deadlineMs:config.client.requestDeadlineMs,assertCurrent:checkPreparing,
        registered(){registered=true;},runDocument:(document,signal,operation)=>runDocument(document,signal,operation)});
      registerRetained();
      let index=0,lastError:string|undefined;
      const pass=async()=>{
        const bounds=config.activation!,targets=activation!.targets;
        const passSignal=AbortSignal.any([signal,AbortSignal.timeout(bounds.passDeadlineMs)]);
        try{
          for(let visited=0;visited<Math.min(bounds.maxDocumentsPerPass,targets.length);visited++){
            index%=targets.length;
            const target=targets[index]!;index=(index+1)%targets.length;
            // Settlement runs in the activation's own document work. A restore
            // fence during it leaves the pass pending rather than ready.
            const result=await activation!.activate(target,passSignal,
              config.settlement?(consumer,document,joined)=>consumer.settle(document,joined):undefined);
            if(result.kind==="done"){
              await attachments.get(target.workspaceId)!.ordinary.push(passSignal);
              if(activation!.workspaceReady(target.workspaceId))await attachments.get(target.workspaceId)!.ordinary.pull(passSignal);
            }
          }
          lastError=undefined;
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          if(!signal.aborted && message!==lastError){
            lastError=message;
            try{console.error("Service activation pass failed.",message);}catch{ /* Reporting must not stop activation. */ }
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
          yield* Effect.uninterruptible(Effect.promise(() => exclusive(pass)));
          yield* pause;
        }
      }));
    }
    return Object.freeze({ coordinate, invalidated: signal,
      /**
       * Moves this running daemon to the hosted set. It attaches a workspace for
       * its first document, adds documents to activation, unloads documents
       * that left, and detaches a workspace once its last document unloads.
       * Resolves to the documents that left but whose unsettled work the
       * engine still holds; a later update retries them.
       */
      update,
      isDocumentReady(document: LiveDocumentKey): boolean {
        try { check(); return consumerFor(parseLiveDocumentKey(document)) !== undefined; }
        catch { return false; }
      },
      /**
       * The claim ledger of a workspace this host replicates as its owner,
       * where it claims each accepted frame's field changes, for the relay's
       * automations. Null for any other workspace, or once this host retired.
       */
      automationLedger(workspaceId: string): LiveClaimLedger | null {
        const attached = attachments.get(workspaceId);
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
      async prepareOrdinary(workspaceId: string, callerSignal?: AbortSignal) {
        if(config.activation)throw new Error("The activation driver owns ordinary replication on this host.");
        const driver = ordinary.get(workspaceId);
        if (!driver) throw new Error("Workspace has no ordinary replication attachment.");
        return driver.pull(callerSignal);
      },
      async captureNative(value: LiveObjectBinding, callerSignal?: AbortSignal) {
        if (!changes || !config.sync) throw new Error("Named frame sync is not configured on this service host.");
        const binding = parseLiveObjectBinding(value);
        const document = parseLiveDocumentKey({workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId});
        await drain(document, callerSignal);
        check();
        const consumer = consumerFor(document)!;
        const registration = consumer.captureRegistration(binding);
        return Object.freeze({client: ordinary.has(document.workspaceId)?activation!.consumer(document).transport.client:client!, workspace: consumer.workspace,
          registrationId: registration.id, binding: registration.binding, coordinate, invalidated: AbortSignal.any([signal, registration.invalidated]),
          changes, nextRequestId, deadlineMs: config.client.requestDeadlineMs, drain});
      },
      get restoreConfigured() { return restore !== undefined; },
      async prepareRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumerForRestore(lookup);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.prepareRestore(lookup, joined));
      },
      async reviewRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumerForRestore(lookup);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.reviewRestore(lookup, joined));
      },
      async confirmRestore(value: StopRestoreLookup, proposalDigest: string, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumerForRestore(lookup);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.confirmRestore(lookup, proposalDigest, joined));
      },
      async completeRestore(value: StopRestoreLookup, proposalDigest: string, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumerForRestore(lookup);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.completeRestore(lookup, proposalDigest, joined));
      },
      async stopRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumerForRestore(lookup);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.stopRestore(lookup, joined));
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
