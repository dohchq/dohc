import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DEVICE_CONTROL_PATH, DEVICE_CONTROL_PROTOCOL, parseDeviceControlLimits,
  parseDeviceControlRegistration, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { createDeviceControlRequestParser, refuseDeviceControl } from "@dohc/service-http";
import { parseDeviceHostCredential } from "./deviceHostCredential.js";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity.js";
import type { SyncRelayStorage } from "./storage.js";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveJournalHistoryAuthority } from "./liveCommittedDelivery.js";
import { parseRelayDeviceDeliveryConfig,type RelayDeviceDeliveryConfig } from "./deviceLiveHostConfig.js";
import { createDeviceLiveDelivery } from "./deviceLiveDelivery.js";
import type { OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation.js";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {LiveHostChanges} from "./relayWriteChanges.js";

export function createDeviceControl(options: {
  storage: SyncRelayStorage; hosts: ReadonlySet<string>; relayExchangeKey: string; limits: DeviceControlLimits;
  delivery?: { config: RelayDeviceDeliveryConfig; history: LiveJournalHistoryAuthority; ownerAdmission?: OwnerOutboxAdmission; frameChanges?: LiveHostChanges };
}) {
  const limits = parseDeviceControlLimits(options.limits);
  const deliveryConfig = options.delivery ? parseRelayDeviceDeliveryConfig(options.delivery.config, limits) : undefined;
  if (options.delivery && !options.delivery.history.reconciled) throw new Error("Device delivery requires reconciled deployment history.");
  if (typeof options.relayExchangeKey !== "string" || options.relayExchangeKey.length < 32) {
    throw new TypeError("Device control requires a relay exchange key.");
  }
  const keyHash = hashRelayExchangeKey(options.relayExchangeKey);
  const parseRequest = createDeviceControlRequestParser({ hosts: options.hosts, path: DEVICE_CONTROL_PATH,
    protocol: DEVICE_CONTROL_PROTOCOL, ...limits });
  const receive = { noServer: true, clientTracking: false, perMessageDeflate: false as const, autoPong: false,
    maxPayload: limits.maxPayloadBytes, maxFragments: limits.maxFragments, maxBufferedChunks: limits.maxBufferedChunks,
    closeTimeout: limits.closeTimeoutMs, handleProtocols: () => DEVICE_CONTROL_PROTOCOL };
  const server = new WebSocketServer(receive);
  const connections = new Set<() => void>();
  let current: (() => void) | undefined;
  let currentDelivery: ReturnType<typeof createDeviceLiveDelivery> | undefined;
  let closed = false;
  server.on("wsClientError", (_error, socket) => refuseDeviceControl(socket, limits.closeTimeoutMs));

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (options.storage.unavailable.aborted) { refuseDeviceControl(socket, limits.closeTimeoutMs); return; }
    const checkStanding = options.storage.captureStanding();
    const headers = parseRequest(request);
    if (closed || connections.size >= limits.maxConnections || head.length > limits.maxPendingBytes || !headers ||
      !verifyRelayExchangeKey(headers.get("x-dohc-relay-exchange-key") ?? null, keyHash)) {
      refuseDeviceControl(socket, limits.closeTimeoutMs); return;
    }
    let credential;
    try {
      const encoded = headers.get("authorization")!.slice(7);
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw new Error();
      credential = parseDeviceHostCredential(JSON.parse(bytes.toString("utf8")));
      if (JSON.stringify(credential) !== bytes.toString("utf8")) throw new Error();
    } catch { refuseDeviceControl(socket, limits.closeTimeoutMs); return; }
    const connectionId = randomUUID();
    const notice = JSON.stringify(parseDeviceControlRegistration({ type: "registered", mode: "device",
      hostId: credential.hostId, hostEpoch: credential.hostEpoch, instanceId: credential.instanceId, connectionId }));
    if (Buffer.byteLength(notice) > limits.maxPayloadBytes) { refuseDeviceControl(socket, limits.closeTimeoutMs); return; }
    const parsedCredential = credential;
    let ws: WebSocket | undefined;
    let delivery: ReturnType<typeof createDeviceLiveDelivery> | undefined;
    let registered = false, done = false;
    let expectedPong: Buffer | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connections.delete(stop);
      if (current === stop) current = undefined;
      if (currentDelivery === delivery) currentDelivery = undefined;
      delivery?.close();
      if (ws) ws.terminate(); else socket.destroy();
      if (registered) {
        // Storage checks this incarnation; a stale close cannot disconnect its replacement.
        try { options.storage.disconnectDeviceHost({ credential: parsedCredential, connectionId, updatedAtMs: Date.now() }); }
        catch { console.error("Device control disconnect could not be persisted."); }
      }
    };
    const isCurrent = () => {
      checkStanding();
      const host = options.storage.getLiveHostControl();
      return host?.admissionState === "open" && host.configuredMode === "device" &&
        host.configuredHostId === parsedCredential.hostId && host.hostEpoch === parsedCredential.hostEpoch &&
        host.registeredInstanceId === parsedCredential.instanceId && host.registeredConnectionId === connectionId;
    };
    const schedulePing = () => {
      timer = setTimeout(() => {
        try {
          if (done || !isCurrent() || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > limits.maxPendingBytes - 32) { stop(); return; }
          expectedPong = randomBytes(16);
          ws.ping(expectedPong, undefined, error => { if (error) stop(); });
          timer = setTimeout(stop, limits.heartbeatTimeoutMs);
          timer.unref();
        } catch { stop(); }
      }, limits.heartbeatIntervalMs);
      timer.unref();
    };
    connections.add(stop);
    socket.once("close", stop);
    socket.once("error", stop);
    socket.pause();
    try {
      server.handleUpgrade(request, socket, head, accepted => {
        ws = accepted;
        ws.on("error", stop);
        ws.on("close", stop);
        ws.on("message", (data, binary) => {
          if (!delivery) { stop(); return; }
          delivery.receive(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data), binary);
        });
        ws.on("ping", stop);
        ws.on("pong", data => {
          if (!expectedPong || !data.equals(expectedPong)) { stop(); return; }
          expectedPong = undefined;
          clearTimeout(timer);
          try { if (!isCurrent()) { stop(); return; } } catch { stop(); return; }
          schedulePing();
        });
        if (done) { ws.terminate(); return; }
        const result = options.storage.registerDeviceHost({ credential: parsedCredential, connectionId, updatedAtMs: Date.now() });
        if (!result.ok) { stop(); return; }
        registered = true;
        current?.();
        current = stop;
        ws.send(notice, error => { if (error) stop(); });
        if (deliveryConfig && options.delivery) {
          delivery = createDeviceLiveDelivery({ ws, limits, config: deliveryConfig, storage: options.storage,
            history: options.delivery.history, ownerAdmission: options.delivery.ownerAdmission, frameChanges: options.delivery.frameChanges, host: { mode: "device", hostId: parsedCredential.hostId, hostEpoch: parsedCredential.hostEpoch,
              instanceId: parsedCredential.instanceId, connectionId }, isCurrent, stop });
          currentDelivery = delivery;
        }
        schedulePing();
        ws.resume();
      });
    } catch { stop(); }
  }

  const close = () => {
    if (closed) return;
    closed = true;
    for (const stop of connections) stop();
    server.close();
  };
  options.storage.unavailable.addEventListener("abort", close, { once: true });
  if (options.storage.unavailable.aborted) close();
  return { handleUpgrade, close,
    async captureNative(binding: LiveObjectBinding, signal?: AbortSignal) {
      if (!currentDelivery) throw new Error("Device delivery is unavailable.");
      return currentDelivery.captureNative(binding, signal);
    },
    async prepareRestore(lookup: StopRestoreLookup, signal?: AbortSignal) {
      if (!currentDelivery) throw new Error("Device delivery is unavailable.");
      return currentDelivery.prepareRestore(lookup, signal);
    },
    async completeRestore(lookup: StopRestoreLookup, proposalDigest: string, signal?: AbortSignal) {
      if (!currentDelivery) throw new Error("Device delivery is unavailable.");
      return currentDelivery.completeRestore(lookup, proposalDigest, signal);
    },
    async stopRestore(lookup: StopRestoreLookup, signal?: AbortSignal) {
      if (!currentDelivery) throw new Error("Device delivery is unavailable.");
      return currentDelivery.stopRestore(lookup, signal);
    },
    async settle(document: LiveDocumentKey, signal?: AbortSignal) {
      if (!currentDelivery) throw new Error("Device delivery is unavailable.");
      return currentDelivery.settle(document, signal);
    },
    async drain(document: LiveDocumentKey, signal?: AbortSignal) {
      if (!currentDelivery) throw new Error("Device delivery is unavailable.");
      return currentDelivery.drain(document, signal);
    },
  };
}
