import {withLiveHostSignal} from "./liveHostSignal.js";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges.js";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { parseDeviceLiveHostStart, parseDeviceLiveHostTransport, parseDeviceLiveHostCredit, deviceLiveHostReceive,
  type DeviceLiveHostReceive, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { DeviceCreditWindow } from "@dohc/service-http";
import { parseLiveDocumentKey, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { DeviceEngineConnection } from "./deviceEngineConnection.js";
import { configRecord, type RelayDeviceDeliveryConfig } from "./deviceLiveHostConfig.js";
import { LiveCommittedDelivery, type LiveJournalHistoryAuthority } from "./liveCommittedDelivery.js";
import type { LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import { OwnerCommittedDelivery } from "./ownerCommittedDelivery.js";
import type { OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
import {snapshotStopRestoreLookup} from "./liveRestoreDelivery.js";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation.js";
import {LiveRestorePreparation} from "./liveRestorePreparation.js";
import {LiveDocumentWork} from "./liveDocumentWork.js";
import {OwnerOutboxWake} from "./ownerOutboxWake.js";
import {queueLiveHostRequests} from "./liveHostRequests.js";

export function createDeviceLiveDelivery(options: {
  ws: WebSocket; limits: DeviceControlLimits; config: RelayDeviceDeliveryConfig;
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; host: LiveHostConnectionCoordinate;
  isCurrent: () => boolean; stop: () => void;
  ownerAdmission?: OwnerOutboxAdmission;
  frameChanges?: LiveHostChanges;
}) {
  const { ws, limits, config, storage, history, host } = options;
  const invalidated = new AbortController();
  const changes = options.frameChanges;
  let stopObserving = () => {};
  let stopOwnerEvents = () => {};
  const documentWork = new LiveDocumentWork();
  const documentFor = (binding: LiveObjectBinding) => parseLiveDocumentKey({workspaceId: binding.workspaceId,
    mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId});
  const consumers = new Map<string, LiveCommittedDelivery | OwnerCommittedDelivery>();
  const restore = config.restore ? new LiveRestorePreparation(config.restore) : undefined;
  const authToken = randomBytes(32).toString("base64url");
  let connection: DeviceEngineConnection | undefined, client: EngineClient | undefined;
  let ready = false, closed = false, requestId = 0, active = 0;
  const receive = deviceLiveHostReceive(limits, { maxPayloadBytes: limits.maxPayloadBytes, maxPendingBytes: config.maxQueuedBytes });
  const incoming = new DeviceCreditWindow(receive.maxPendingBytes, receive.maxPayloadBytes);
  let receivedBytes = 0;
  const nextRequestId = () => {
    if (requestId === Number.MAX_SAFE_INTEGER) throw new Error("Device request IDs exhausted.");
    return ++requestId;
  };
  const check = () => {
    if (closed || !history.reconciled || !options.isCurrent()) throw new Error("Device delivery connection was retired.");
  };
  const timer = setTimeout(options.stop, config.client.connectTimeoutMs);
  timer.unref();
  const nativeHost = { hostId: host.hostId, hostEpoch: host.hostEpoch, instanceId: host.instanceId, connectionId: host.connectionId };
  const start = JSON.stringify(parseDeviceLiveHostStart({ type: "liveHost.start", version: 1, relayNamespace: history.namespace, host: nativeHost, authToken, receive }));
  if (!history.reconciled || Buffer.byteLength(start) > limits.maxPayloadBytes || ws.bufferedAmount + Buffer.byteLength(start) + 16 > limits.maxPendingBytes) {
    clearTimeout(timer); throw new Error("Device delivery startup refused.");
  }
  ws.send(start, error => { if (error) options.stop(); });

  async function attach(peer: DeviceLiveHostReceive): Promise<void> {
    check();
    connection = new DeviceEngineConnection(ws, limits, peer, config.maxQueuedBytes, options.stop);
    client = new EngineClient(connection, { authToken, protocolVersion: 2, capabilities: ["blobs"],
      maxFrameBytes: config.client.maxFrameBytes, connectTimeoutMs: config.client.connectTimeoutMs, privateLiveApplication: config.client });
    // Caller input retention and native upload buffers each have their own cap.
    if (changes) client = queueLiveHostRequests(client, {maxPendingReads: changes.maxListeners, maxPendingWrites: changes.maxListeners,
      maxRetainedInputBytes: config.client.aggregateBytes,
      deadlineMs: config.client.requestDeadlineMs, signal: invalidated.signal,
      retire() {invalidated.abort(new Error("Native request completion is unknown.")); options.stop();}});
    stopOwnerEvents = client.onEvent(event => {
      if (event.name !== "liveApplication.ownerOutboxChanged") return;
      try {
        check();
        const value = configRecord(event.payload, ["registrationId", "binding"]), binding = parseLiveObjectBinding(value.binding);
        if (!Number.isSafeInteger(value.registrationId) || (value.registrationId as number) < 1) throw new Error("Invalid owner change registration.");
        const consumer = consumers.get(binding.workspaceId);
        if (!(consumer instanceof OwnerCommittedDelivery)) throw new Error("Owner change workspace is unavailable.");
        let registration;
        try {registration = consumer.captureRegistration(binding);} catch {return;}
        // The notice identifies the native registration, never a browser ticket selector.
        if (registration.id !== value.registrationId || !isDeepStrictEqual(registration.binding, binding)) return;
        ownerWake.wake(registration);
      } catch {options.stop();}
    });
    await client.ready();
    check();
    const response = await client.sendRequest({ id: nextRequestId(), method: "liveApplication.hosts", params: {}, deadlineMs: config.client.requestDeadlineMs });
    check();
    const discovery = configRecord(response.result, ["relayNamespace", "host", "workspaces"],["ownerSessions"]);
    let ownerBounds: { maxBytes: number; maxEvents: number } | undefined;
    if (discovery.ownerSessions !== undefined) {
      const bounds = configRecord(discovery.ownerSessions,["maxBytes","maxEvents"]);
      if (typeof bounds.maxBytes !== "number" || !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || bounds.maxBytes * 3 > config.client.aggregateBytes ||
        typeof bounds.maxEvents !== "number" || !Number.isSafeInteger(bounds.maxEvents) || bounds.maxEvents < 1) throw new Error("Invalid device owner bounds.");
      ownerBounds = { maxBytes: bounds.maxBytes,maxEvents: bounds.maxEvents };
    }
    if (discovery.relayNamespace !== history.namespace || !isDeepStrictEqual(discovery.host, nativeHost) || !Array.isArray(discovery.workspaces) ||
      discovery.workspaces.length !== config.workspaceIds.length) throw new Error("Device discovery identity mismatch.");
    const handles = new Set<string>();
    for (const value of discovery.workspaces) {
      const row = configRecord(value, ["workspaceId", "workspaceHandle"]);
      if (typeof row.workspaceId !== "string" || !config.workspaceIds.includes(row.workspaceId) || consumers.has(row.workspaceId) ||
        typeof row.workspaceHandle !== "string" || !row.workspaceHandle || handles.has(row.workspaceHandle)) throw new Error("Device workspace discovery mismatch.");
      handles.add(row.workspaceHandle);
      const ownerConnection = { client,workspace: row.workspaceHandle,host,deadlineMs: config.client.requestDeadlineMs,nextRequestId,restore };
      if (ownerBounds && !options.ownerAdmission) throw new Error("Owner admission is not configured.");
      consumers.set(row.workspaceId, ownerBounds ? new OwnerCommittedDelivery(storage,history,{ ...ownerConnection,bounds: ownerBounds,ownerAdmission: options.ownerAdmission! }) : new LiveCommittedDelivery(storage,history,ownerConnection));
    }
    clearTimeout(timer);
    ready = true;
  }
  const requireReady = () => {
    check();
    if (!ready) throw new Error("Device delivery is not ready.");
  };
  const runDocument = async <T>(document: LiveDocumentKey, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    requireReady();
    return withLiveHostSignal(invalidated.signal, signal, joined => documentWork.run(JSON.stringify(document), joined, async () => {
      check();
      if (!ready || active >= config.maxActiveDrains) throw new Error("Device delivery is not ready or is full.");
      active++;
      try {const outcome = await run(joined); check(); return outcome;}
      finally {active--; changes?.notify(document); queueMicrotask(() => ownerWake.pump());}
    }));
  };
  const drain = async (value: LiveDocumentKey, signal?: AbortSignal) => {
    requireReady();
    const document = parseLiveDocumentKey(value), consumer = consumers.get(document.workspaceId);
    if (!consumer) throw new Error("Workspace is not configured on this device host.");
    return runDocument(document, signal, async joined => {
      const outcome = await consumer.drain(document, joined);
      check();
      if (consumer instanceof OwnerCommittedDelivery && "continueDrain" in outcome && outcome.continueDrain) {
        ownerWake.wake(consumer.captureDocumentRegistration(document));
      }
      return outcome;
    });
  };
  const ownerWake = new OwnerOutboxWake({
    canRun: registration => ready && !closed && active < config.maxActiveDrains && !documentWork.busy(JSON.stringify(documentFor(registration.binding))),
    async run(registration) {
      const outcome = await drain(documentFor(registration.binding), registration.invalidated);
      return "continueDrain" in outcome && outcome.continueDrain === true;
    },
    onError: error => {if (!closed && !invalidated.signal.aborted) console.error("Owner outbox change delivery failed.", error);},
  });
  if (changes) stopObserving = observeRelayWrites(storage, () => changes.notify());
  return {
    receive(bytes: Buffer, binary: boolean): void {
      try {
        check();
        if (binary) {
          if (!connection || bytes.length === 0) throw new Error("Early device bytes.");
          incoming.receive(bytes.length);
          connection.receive(bytes);
          receivedBytes += bytes.length + 16;
          incoming.acknowledge(receivedBytes);
          connection.acknowledge(receivedBytes);
        } else {
          if (connection) { connection.credit(parseDeviceLiveHostCredit(JSON.parse(bytes.toString("utf8")))); return; }
          const transport = parseDeviceLiveHostTransport(JSON.parse(bytes.toString("utf8")));
          void attach(transport.receive).catch(options.stop);
        }
      } catch { options.stop(); }
    },
    drain,
    async captureNative(value: LiveObjectBinding, signal?: AbortSignal) {
      if (!changes) throw new Error("Named frame sync is not configured on this device host.");
      const binding = parseLiveObjectBinding(value);
      const document = parseLiveDocumentKey({workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId});
      await drain(document, signal);
      check();
      const consumer = consumers.get(document.workspaceId)!;
      const registration = consumer.captureRegistration(binding);
      return Object.freeze({client: client!, workspace: consumer.workspace, registrationId: registration.id, binding: registration.binding,
        coordinate: host, invalidated: AbortSignal.any([invalidated.signal, registration.invalidated]),
        changes, nextRequestId, deadlineMs: config.client.requestDeadlineMs, drain});
    },
    get restoreConfigured() { return config.restore !== undefined; },
    async prepareRestore(value: StopRestoreLookup, signal?: AbortSignal) {
      requireReady();
      const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      return runDocument(consumer.documentForRestore(lookup), signal, joined => consumer.prepareRestore(lookup, joined));
    },
    async reviewRestore(value: StopRestoreLookup, signal?: AbortSignal) {
      requireReady();
      const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      return runDocument(consumer.documentForRestore(lookup), signal, joined => consumer.reviewRestore(lookup, joined));
    },
    async confirmRestore(value: StopRestoreLookup, proposalDigest: string, signal?: AbortSignal) {
      requireReady();
      const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      return runDocument(consumer.documentForRestore(lookup), signal, joined => consumer.confirmRestore(lookup, proposalDigest, joined));
    },
    async completeRestore(value: StopRestoreLookup, proposalDigest: string, signal?: AbortSignal) {
      requireReady();
      const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      return runDocument(consumer.documentForRestore(lookup), signal, joined => consumer.completeRestore(lookup, proposalDigest, joined));
    },
    async stopRestore(value: StopRestoreLookup, signal?: AbortSignal) {
      requireReady();
      const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      return runDocument(consumer.documentForRestore(lookup), signal, joined => consumer.stopRestore(lookup, joined));
    },
    async settle(value: LiveDocumentKey, signal?: AbortSignal) {
      requireReady();
      const document = parseLiveDocumentKey(value), consumer = consumers.get(document.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      return runDocument(document, signal, joined => consumer.settle(document, joined));
    },
    close(): void {
      if (closed) return;
      closed = true; ready = false; clearTimeout(timer); invalidated.abort(); stopObserving(); stopOwnerEvents(); ownerWake.close(); changes?.notify(); client?.close(); connection?.close(); consumers.clear();
    },
  };
}
