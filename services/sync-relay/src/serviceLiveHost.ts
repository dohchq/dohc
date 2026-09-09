import {liveHostSignal, withLiveHostSignal} from "./liveHostSignal.js";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges.js";
import {parseNativeLiveSyncConfig} from "./liveSyncConfig.js";
import {LiveDocumentWork} from "./liveDocumentWork.js";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { createEngineClient, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import { parseLiveDocumentKey, parseLiveUpdateIdentifier, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { LiveCommittedDelivery, type CommittedDeliveryOutcome } from "./liveCommittedDelivery.js";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory.js";
import type { LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import { parseLiveSettlementConfig, type LiveSettlementConfig } from "./liveSettlementConfig.js";
import {snapshotStopRestoreLookup} from "./liveRestoreDelivery.js";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation.js";
import {parseLiveRestoreConfig, LiveRestorePreparation, type LiveRestoreConfig} from "./liveRestorePreparation.js";

interface ServiceLiveHostConfig {
  readonly version: 1;
  readonly engineExecutable: string;
  readonly hostId: string;
  readonly instanceId: string;
  readonly workspaces: readonly { readonly root: string; readonly workspaceId: string; readonly maxRegistrations: number }[];
  readonly ingress: { readonly aggregateBytes: number; readonly applicationWorkingReserveBytes: number; readonly maxUploads: number; readonly uploadDeadlineMs: number };
  readonly client: { readonly aggregateBytes: number; readonly maxUploads: number; readonly connectTimeoutMs: number; readonly requestDeadlineMs: number };
  readonly settlement?: LiveSettlementConfig;
  readonly restore?: LiveRestoreConfig;
  readonly sync?: ReturnType<typeof parseNativeLiveSyncConfig>;
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
function readServiceLiveHostConfig(configPath: string): ServiceLiveHostConfig {
  const value = record(JSON.parse(readFileSync(path(configPath, false), "utf8")),
    ["version", "engineExecutable", "hostId", "instanceId", "workspaces", "ingress", "client"], ["settlement", "restore", "sync"]);
  if (value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length) throw new TypeError("Invalid service host configuration.");
  const workspaces = value.workspaces.map(item => {
    const row = record(item, ["root", "workspaceId", "maxRegistrations"]);
    return Object.freeze({ root: path(row.root, true), workspaceId: parseLiveUpdateIdentifier(row.workspaceId, "workspace ID"), maxRegistrations: integer(row.maxRegistrations) });
  });
  if (new Set(workspaces.map(row => row.workspaceId)).size !== workspaces.length ||
    new Set(workspaces.map(row => process.platform === "win32" ? row.root.toLowerCase() : row.root)).size !== workspaces.length) throw new TypeError("Duplicate service workspace.");
  const ingress = record(value.ingress, ["aggregateBytes", "applicationWorkingReserveBytes", "maxUploads", "uploadDeadlineMs"]);
  const client = record(value.client, ["aggregateBytes", "maxUploads", "connectTimeoutMs", "requestDeadlineMs"]);
  const settlement = parseLiveSettlementConfig(value.settlement);
  const restore = parseLiveRestoreConfig(value.restore);
  const applicationWorkingReserveBytes = integer(ingress.applicationWorkingReserveBytes, 0);
  if (applicationWorkingReserveBytes === 0) throw new TypeError("Live application requires a positive applicationWorkingReserveBytes limit.");
  return Object.freeze({ version: 1, engineExecutable: path(value.engineExecutable, false),
    hostId: parseLiveUpdateIdentifier(value.hostId, "host ID"), instanceId: parseLiveUpdateIdentifier(value.instanceId, "instance ID"),
    workspaces: Object.freeze(workspaces),
    settlement, restore, sync: parseNativeLiveSyncConfig(value.sync, integer(ingress.aggregateBytes)),
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
  const standing = storage.captureStanding();
  if (!history.reconciled || held.has(storage)) throw new Error("Service host is unavailable.");
  const control = storage.getLiveHostControl();
  if (!control || control.configuredMode !== "service" || control.configuredHostId !== config.hostId || control.transition ||
    (control.registeredInstanceId !== null && control.registeredInstanceId !== config.instanceId)) throw new Error("Service host does not match provisioned control.");
  const coordinate: LiveHostConnectionCoordinate = Object.freeze({ mode: "service", hostId: config.hostId, hostEpoch: control.hostEpoch,
    instanceId: config.instanceId, connectionId: randomUUID() });
  const host = { hostId: coordinate.hostId, hostEpoch: coordinate.hostEpoch, instanceId: coordinate.instanceId, connectionId: coordinate.connectionId };
  const invalidated = new AbortController();
  const lifetime = liveHostSignal(storage.unavailable, invalidated.signal, options.signal);
  const signal = lifetime.signal;
  const changes = options.frameChanges;
  const stopObserving = changes ? observeRelayWrites(storage, () => changes.notify()) : () => {};
  const consumers = new Map<string, LiveCommittedDelivery>();
  const documents = new LiveDocumentWork();
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
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      await startupSettled;
      stopClient();
      try {
        if (registered && !storage.unavailable.aborted) storage.disconnectLiveHost({ ...coordinate, updatedAtMs: Date.now(), guard: standing });
      } finally {
        await client?.waitForExit();
        if (temporary) await rm(temporary, { recursive: true, force: true });
        held.delete(storage);
      }
    });
    invalidated.abort();
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
    } finally {changes?.notify();}
  };
  const drain = async (value: LiveDocumentKey, callerSignal?: AbortSignal): Promise<CommittedDeliveryOutcome> => {
    check();
    const document = parseLiveDocumentKey(value), consumer = consumers.get(document.workspaceId);
    if (!consumer) throw new Error("Workspace is not configured on this service host.");
    return runDocument(document, callerSignal, joined => consumer.drain(document, joined));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("Service host startup cancelled.");
    temporary = await mkdtemp(join(tmpdir(), "dohc-service-live-host-"));
    const nativeConfig = join(temporary, "host.json");
    await writeFile(nativeConfig, JSON.stringify({ version: 1, relayNamespace: history.namespace, host,
      workspaces: config.workspaces, ingress: config.ingress, settlement: config.settlement, sync: config.sync,
      restore: config.restore ? {maxBytes: config.restore.maxBytes, maxEvents: config.restore.maxEvents} : undefined }), { flag: "wx", mode: 0o600 });
    client = await createEngineClient({ command: config.engineExecutable, authToken: randomBytes(32).toString("base64url"),
      protocolVersion: 2, capabilities: ["blobs"], privateLiveApplication: config.client, connectTimeoutMs: config.client.connectTimeoutMs,
      env: { DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig }, signal,
      onExit: abort, onStderr: text => console.error("[service-live-host]", text.trimEnd()),
    });
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
    }
    standing();
    if (signal.aborted || !history.reconciled) throw new Error("Service host startup cancelled.");
    const registration = storage.registerLiveHost({ ...coordinate, updatedAtMs: Date.now(), guard: standing });
    if (!registration.ok) throw new Error("Service host registration refused.");
    registered = true;
    check();
    finishStartup();
    return Object.freeze({ coordinate, invalidated: signal,
      async captureNative(value: LiveObjectBinding, callerSignal?: AbortSignal) {
        if (!changes || !config.sync) throw new Error("Named frame sync is not configured on this service host.");
        const binding = parseLiveObjectBinding(value);
        const document = parseLiveDocumentKey({workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId});
        await drain(document, callerSignal);
        check();
        const consumer = consumers.get(document.workspaceId)!;
        const registration = consumer.captureRegistration(binding);
        return Object.freeze({client: client!, workspace: consumer.workspace,
          registrationId: registration.id, binding: registration.binding, coordinate, invalidated: AbortSignal.any([signal, registration.invalidated]),
          changes, nextRequestId, deadlineMs: config.client.requestDeadlineMs, drain});
      },
      get restoreConfigured() { return restore !== undefined; },
      async prepareRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.prepareRestore(lookup, joined));
      },
      async reviewRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.reviewRestore(lookup, joined));
      },
      async confirmRestore(value: StopRestoreLookup, proposalDigest: string, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.confirmRestore(lookup, proposalDigest, joined));
      },
      async completeRestore(value: StopRestoreLookup, proposalDigest: string, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.completeRestore(lookup, proposalDigest, joined));
      },
      async stopRestore(value: StopRestoreLookup, callerSignal?: AbortSignal) {
        check();
        const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
        if (!consumer) throw new Error("Workspace is not configured on this service host.");
        return runDocument(consumer.documentForRestore(lookup), callerSignal, joined => consumer.stopRestore(lookup, joined));
      },
      async settle(value: LiveDocumentKey, callerSignal?: AbortSignal) {
        check();
        if (!config.settlement) throw new Error("Settlement is not configured on this service host.");
        const document = parseLiveDocumentKey(value), consumer = consumers.get(document.workspaceId);
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
