import {parseServiceActivationConfig,ServiceActivationDriver,type ServiceActivationConfig} from "./serviceActivationDriver";
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
import { createEngineClient, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import { VersionedLiveAdapter, type Event } from "@dohc/workspace-engine-client";
import type { LiveClaimLedger } from "./automationLiveClaims.js";
import { parseLiveDocumentKey, parseLiveUpdateIdentifier, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { LiveCommittedDelivery, type CommittedDeliveryOutcome } from "./liveCommittedDelivery.js";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory.js";
import type { LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import { parseLiveSettlementConfig, type LiveSettlementConfig } from "./liveSettlementConfig.js";
import {snapshotStopRestoreLookup} from "./liveRestoreDelivery.js";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation.js";
import {parseLiveRestoreConfig, LiveRestorePreparation, type LiveRestoreConfig} from "./liveRestorePreparation.js";
import {parseServiceOrdinaryReplicationConfig, ServiceOrdinaryReplication, type ServiceOrdinaryReplicationConfig} from "./serviceOrdinaryReplication.js";
interface ServiceLiveHostConfig {
  readonly version: 1;
  readonly engineExecutable: string;
  readonly hostId: string;
  readonly instanceId: string;
  readonly workspaces: readonly { readonly root: string; readonly workspaceId: string; readonly maxRegistrations: number;
    readonly ordinaryReplication?: ServiceOrdinaryReplicationConfig }[];
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

/** Operator configuration only. Incoming document fields never supply these paths. */
export function readServiceLiveHostConfig(configPath: string): ServiceLiveHostConfig {
  const value = record(JSON.parse(readFileSync(path(configPath, false), "utf8")),
    ["version", "engineExecutable", "hostId", "instanceId", "workspaces", "ingress", "client"], ["settlement", "restore", "sync", "adoption", "activation"]);
  if (value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length) throw new TypeError("Invalid service host configuration.");
  const workspaces = value.workspaces.map(item => {
    const row = record(item, ["root", "workspaceId", "maxRegistrations"], ["ordinaryReplication"]);
    return Object.freeze({ root: path(row.root, true), workspaceId: parseLiveUpdateIdentifier(row.workspaceId, "workspace ID"),
      maxRegistrations: integer(row.maxRegistrations), ordinaryReplication: parseServiceOrdinaryReplicationConfig(row.ordinaryReplication) });
  });
  if (new Set(workspaces.map(row => row.workspaceId)).size !== workspaces.length ||
    new Set(workspaces.map(row => process.platform === "win32" ? row.root.toLowerCase() : row.root)).size !== workspaces.length) throw new TypeError("Duplicate service workspace.");
  const ingress = record(value.ingress, ["aggregateBytes", "applicationWorkingReserveBytes", "maxUploads", "uploadDeadlineMs"]);
  const client = record(value.client, ["aggregateBytes", "maxUploads", "connectTimeoutMs", "requestDeadlineMs"]);
  const settlement = parseLiveSettlementConfig(value.settlement);
  const restore = parseLiveRestoreConfig(value.restore);
  const adoption = value.adoption === undefined ? undefined : (() => {
    const row = record(value.adoption, ["maxBytes", "maxEvents", "ownerOutbox"]);
    const outbox = record(row.ownerOutbox, ["maxPendingBytes", "maxPendingAgeMs"]);
    if (!workspaces.some(workspace => workspace.ordinaryReplication)) throw new TypeError("Service owner adoption requires ordinary replication.");
    return Object.freeze({maxBytes: integer(row.maxBytes), maxEvents: integer(row.maxEvents),
      ownerOutbox: Object.freeze({maxPendingBytes: integer(outbox.maxPendingBytes), maxPendingAgeMs: integer(outbox.maxPendingAgeMs)})});
  })();
  const activation=parseServiceActivationConfig(value.activation);
  const sync=parseNativeLiveSyncConfig(value.sync,integer(ingress.aggregateBytes));
  if(activation){
    if(!adoption || !sync || activation.maxCaptureBytes>Math.min(sync.policy.maxReadBytes,sync.policy.maxOutputBytes))throw new Error("Service activation requires bounded native adoption and sync.");
    for(const target of activation.targets){
      const workspace=workspaces.find(row=>row.workspaceId===target.workspaceId);
      if(!workspace?.ordinaryReplication || activation.targets.filter(row=>row.workspaceId===target.workspaceId).length>workspace.maxRegistrations)throw new Error("Service activation workspace is not configured.");
    }
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
  const preparingOrdinary = config.workspaces.some(row => row.ordinaryReplication !== undefined);
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
  const stopObserving = changes ? observeRelayWrites(storage, () => changes.notify()) : () => {};
  const consumers = new Map<string, LiveCommittedDelivery>();
  const ordinary = new Map<string, ServiceOrdinaryReplication>();
  const documents = new LiveDocumentWork();
  const attachments=new Map<string,{handle:string;ordinary:ServiceOrdinaryReplication}>();
  const ledgers = new Map<string, LiveClaimLedger>();
  let activation:ServiceActivationDriver|undefined,activationTimer:ReturnType<typeof setTimeout>|undefined,activationPass:Promise<void>|undefined;
  const restore = config.restore ? new LiveRestorePreparation(config.restore) : undefined;
  let client: EngineClient | undefined, temporary: string | undefined, registered = false, closing: Promise<void> | undefined;
  let clientClosed = false;
  const stopClient = () => { if (client && !clientClosed) { clientClosed = true; client.close(); } };
  let finishStartup!: () => void;
  const startupSettled = new Promise<void>(resolve => { finishStartup = resolve; });
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
      await startupSettled;
      stopClient();
      await activationPass;
      try {
        if (registered && !storage.unavailable.aborted) storage.disconnectLiveHost({ ...coordinate, updatedAtMs: Date.now(), guard: standing });
      } finally {
        await client?.waitForExit();
        if (temporary) await rm(temporary, { recursive: true, force: true });
        held.delete(storage);
      }
    });
    invalidated.abort();
    clearTimeout(activationTimer);
    stopObserving();
    changes?.notify();
    lifetime.dispose();
    stopClient();
    return closing;
  };
  held.add(storage);
  const abort = () => { void close().catch(error => console.error("Service host shutdown failed.", error)); };
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
  const drain = async (value: LiveDocumentKey, callerSignal?: AbortSignal): Promise<CommittedDeliveryOutcome> => {
    check();
    const document = parseLiveDocumentKey(value), consumer = consumerFor(document);
    if (!consumer) throw new Error("Workspace is not configured on this service host.");
    return runDocument(document, callerSignal, joined => consumer.drain(document, joined));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("Service host startup cancelled.");
    temporary = await mkdtemp(join(tmpdir(), "dohc-service-live-host-"));
    const nativeConfig = join(temporary, "host.json");
    await writeFile(nativeConfig, JSON.stringify({ version: 1, relayNamespace: history.namespace, host,
      workspaces: config.workspaces.map(({ordinaryReplication, ...workspace}) => ({...workspace,
        ...(ordinaryReplication ? {relay: ordinaryReplication.relay} : {})})),
      ingress: config.ingress, settlement: config.settlement, sync: config.sync, adoption: config.adoption,
      restore: config.restore ? {maxBytes: config.restore.maxBytes, maxEvents: config.restore.maxEvents} : undefined }), { flag: "wx", mode: 0o600 });
    client = await createEngineClient({ command: config.engineExecutable, authToken: randomBytes(32).toString("base64url"),
      protocolVersion: 2, capabilities: ["blobs"], privateLiveApplication: config.client, connectTimeoutMs: config.client.connectTimeoutMs,
      env: { DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig }, signal,
      onExit: abort, onStderr: text => console.error("[service-live-host]", text.trimEnd()),
    });
    // Caller input retention and native upload buffers each have their own cap.
    if (changes) client = queueLiveHostRequests(client, {maxPendingReads: changes.maxListeners, maxPendingWrites: changes.maxListeners,
      maxRetainedInputBytes: config.client.aggregateBytes,
      deadlineMs: config.client.requestDeadlineMs, signal, retire: abort});
    if (signal.aborted) throw new Error("Service host startup cancelled.");
    const discovery = await client.sendRequest({ id: nextRequestId(), method: "liveApplication.hosts", params: {}, deadlineMs: config.client.requestDeadlineMs });
    const reply = record(discovery.result, ["relayNamespace", "host", "workspaces"]);
    if (reply.relayNamespace !== history.namespace || !isDeepStrictEqual(reply.host, host) || !Array.isArray(reply.workspaces) ||
      reply.workspaces.length !== config.workspaces.length) throw new Error("Configured engine identity mismatch.");
    const handles = new Set<string>();
    for (const [index, value] of reply.workspaces.entries()) {
      const row = record(value, ["workspaceId", "workspaceHandle"]);
      if (row.workspaceId !== config.workspaces[index]!.workspaceId || typeof row.workspaceHandle !== "string" || !row.workspaceHandle || handles.has(row.workspaceHandle)) throw new Error("Configured workspace identity mismatch.");
      handles.add(row.workspaceHandle);
      consumers.set(row.workspaceId as string, new LiveCommittedDelivery(storage, history, { client, workspace: row.workspaceHandle,
        host: coordinate, deadlineMs: config.client.requestDeadlineMs, nextRequestId, restore }));
      const attachment = config.workspaces[index]!.ordinaryReplication;
      if (attachment) ordinary.set(row.workspaceId as string, new ServiceOrdinaryReplication({client, workspace: row.workspaceHandle,
        workspaceId: row.workspaceId as string, nextRequestId, deadlineMs: config.client.requestDeadlineMs,
        signal, assertCurrent: checkPreparing}, attachment));
      if(attachment)attachments.set(row.workspaceId as string,{handle:row.workspaceHandle,ordinary:ordinary.get(row.workspaceId as string)!});
    }
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
    if(config.activation){
      activation=new ServiceActivationDriver({storage,history,client,host:coordinate,workspaces:attachments,config:config.activation,
        adoption:config.adoption!,restore,nextRequestId,deadlineMs:config.client.requestDeadlineMs,assertCurrent:checkPreparing,
        registered(){registered=true;},runDocument:(document,signal,operation)=>runDocument(document,signal,operation)});
      if(activation.hasRetained()){
        if(!storage.registerLiveHost({...coordinate,updatedAtMs:Date.now(),guard:standing}).ok)throw new Error("Retained service host registration refused.");
        registered=true;check();
      }
      let index=0,lastError:string|undefined;
      const pass=async()=>{
        const bounds=config.activation!;
        const passSignal=AbortSignal.any([signal,AbortSignal.timeout(bounds.passDeadlineMs)]);
        try{
          for(let visited=0;visited<Math.min(bounds.maxDocumentsPerPass,bounds.targets.length);visited++){
            const target=bounds.targets[index]!;index=(index+1)%bounds.targets.length;
            const result=await activation!.activate(target,passSignal);
            if(result.kind==="done"){
              if(config.settlement)await runDocument(result.document,passSignal,joined=>activation!.consumer(result.document).consumer.settle(result.document,joined));
              await attachments.get(target.workspaceId)!.ordinary.push(passSignal);
              if(activation!.workspaceReady(target.workspaceId))await attachments.get(target.workspaceId)!.ordinary.pull(passSignal);
            }
          }
          lastError=undefined;
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          if(!signal.aborted && message!==lastError){lastError=message;console.error("Service activation pass failed.",message);}
        }
        if(!signal.aborted){activationTimer=setTimeout(()=>{activationPass=pass();},bounds.pollIntervalMs);activationTimer.unref();}
      };
      activationPass=Promise.resolve().then(pass);
    }
    finishStartup();
    return Object.freeze({ coordinate, invalidated: signal,
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
        const document = parseLiveDocumentKey(value), consumer = consumerFor(document);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(document, callerSignal, joined => consumer.settle(document, joined));
      },
      drain,
      async close() { signal.removeEventListener("abort", abort); await close(); },
    });
  } catch (error) {
    finishStartup();
    signal.removeEventListener("abort", abort);
    await close();
    throw error;
  }
}
