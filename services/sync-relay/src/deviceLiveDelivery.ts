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

export function createDeviceLiveDelivery(options: {
  ws: WebSocket; limits: DeviceControlLimits; config: RelayDeviceDeliveryConfig;
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; host: LiveHostConnectionCoordinate;
  isCurrent: () => boolean; stop: () => void;
  ownerAdmission?: OwnerOutboxAdmission;
}) {
  const { ws, limits, config, storage, history, host } = options;
  const invalidated = new AbortController();
  const consumers = new Map<string, LiveCommittedDelivery | OwnerCommittedDelivery>();
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
      const ownerConnection = { client,workspace: row.workspaceHandle,host,deadlineMs: config.client.requestDeadlineMs,nextRequestId };
      if (ownerBounds && !options.ownerAdmission) throw new Error("Owner admission is not configured.");
      consumers.set(row.workspaceId, ownerBounds ? new OwnerCommittedDelivery(storage,history,{ ...ownerConnection,bounds: ownerBounds,ownerAdmission: options.ownerAdmission! }) : new LiveCommittedDelivery(storage,history,ownerConnection));
    }
    clearTimeout(timer);
    ready = true;
  }
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
    async drain(value: LiveDocumentKey, signal?: AbortSignal) {
      check();
      if (!ready || active >= config.maxActiveDrains) throw new Error("Device delivery is not ready or is full.");
      const document = parseLiveDocumentKey(value), consumer = consumers.get(document.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      active++;
      try {
        const outcome = await consumer.drain(document, AbortSignal.any([invalidated.signal, ...(signal ? [signal] : [])]));
        check();
        return outcome;
      } finally { active--; }
    },
    async stopRestore(value: StopRestoreLookup, signal?: AbortSignal) {
      check();
      if (!ready || active >= config.maxActiveDrains) throw new Error("Device delivery is not ready or is full.");
      const lookup = snapshotStopRestoreLookup(value), consumer = consumers.get(lookup.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      active++;
      try {
        const outcome = await consumer.stopRestore(lookup, AbortSignal.any([invalidated.signal, ...(signal ? [signal] : [])]));
        check();
        return outcome;
      } finally {active--;}
    },
    async settle(value: LiveDocumentKey, signal?: AbortSignal) {
      check();
      if (!ready || active >= config.maxActiveDrains) throw new Error("Device delivery is not ready or is full.");
      const document = parseLiveDocumentKey(value), consumer = consumers.get(document.workspaceId);
      if (!consumer) throw new Error("Workspace is not configured on this device host.");
      active++;
      try {
        const outcome = await consumer.settle(document, AbortSignal.any([invalidated.signal, ...(signal ? [signal] : [])]));
        check();
        return outcome;
      } finally { active--; }
    },
    close(): void {
      if (closed) return;
      closed = true; ready = false; clearTimeout(timer); invalidated.abort(); client?.close(); connection?.close(); consumers.clear();
    },
  };
}
