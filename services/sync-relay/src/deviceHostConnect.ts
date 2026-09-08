import { WebSocket } from "ws";
import { DEVICE_CONTROL_PATH, DEVICE_CONTROL_PROTOCOL, parseDeviceControlLimits,
  parseDeviceControlRegistration, parseDeviceLiveHostStart, parseDeviceLiveHostCredit, type DeviceControlLimits, type DeviceControlRegistration } from "@dohc/live-session-contract/device-control";
import { parseDeviceHostCredential, type DeviceHostCredential } from "./deviceHostCredential.js";
import { readDeviceLiveHostConfig } from "./deviceLiveHostConfig.js";
import { startDeviceNativeTransport } from "./deviceNativeTransport.js";
import { startExistingOwnerDeviceTransport, type ExistingOwnerDeviceConfig } from "./deviceExistingOwnerTransport.js";

export function connectDeviceHost(options: {
  url: string; credential: DeviceHostCredential; limits: DeviceControlLimits;
  onRegistered: (registration: DeviceControlRegistration) => void;
  deliveryConfigPath?: string;
  existingOwner?: ExistingOwnerDeviceConfig;
}) {
  const limits = parseDeviceControlLimits(options.limits);
  const credential = parseDeviceHostCredential(options.credential);
  const config = options.deliveryConfigPath ? readDeviceLiveHostConfig(options.deliveryConfigPath, limits) : undefined;
  if (config && options.existingOwner) throw new TypeError("Choose one device host owner.");
  if (config && (config.hostId !== credential.hostId || config.hostEpoch !== credential.hostEpoch || config.instanceId !== credential.instanceId)) {
    throw new TypeError("Device delivery configuration does not match the credential.");
  }
  const url = new URL(options.url);
  if (url.protocol !== "wss:" || url.username || url.password || url.pathname !== DEVICE_CONTROL_PATH || url.search || url.hash) {
    throw new TypeError("Device host connection requires the WSS device control endpoint.");
  }
  const authorization = `Bearer ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;
  if (Buffer.byteLength(authorization) > limits.maxCredentialBytes) throw new TypeError("Device host credential exceeds the configured limit.");
  let registered = false, stopping = false;
  let registration: DeviceControlRegistration | undefined;
  let native: ReturnType<typeof startDeviceNativeTransport> | undefined;
  let nativeClosed: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let finish: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const receive = { headers: { authorization }, followRedirects: false,
    rejectUnauthorized: true, perMessageDeflate: false, autoPong: false, handshakeTimeout: limits.handshakeTimeoutMs,
    maxPayload: limits.maxPayloadBytes, maxFragments: limits.maxFragments, maxBufferedChunks: limits.maxBufferedChunks,
    closeTimeout: limits.closeTimeoutMs };
  const ws = new WebSocket(url, DEVICE_CONTROL_PROTOCOL, receive);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    nativeClosed ??= native?.close();
    ws.terminate();
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(stop, limits.heartbeatIntervalMs + limits.heartbeatTimeoutMs);
    timer.unref();
  };
  timer = setTimeout(stop, limits.handshakeTimeoutMs);
  timer.unref();
  ws.on("error", stop);
  ws.on("close", () => {
    stop();
    void Promise.resolve(nativeClosed).catch(() => console.error("Device native shutdown failed.")).finally(() => finish());
  });
  ws.on("message", (data, binary) => {
    if (stopping) return;
    try {
      if (registered) {
        if (binary) {
          if (!native) throw new Error("Early device bytes.");
          native.receive(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
        } else {
          if (native) { native.credit(parseDeviceLiveHostCredit(JSON.parse(data.toString()))); return; }
          if (!config && !options.existingOwner) throw new Error("Unexpected device control.");
          const start = parseDeviceLiveHostStart(JSON.parse(data.toString()));
          if (start.host.hostId !== registration!.hostId || start.host.hostEpoch !== registration!.hostEpoch ||
            start.host.instanceId !== registration!.instanceId || start.host.connectionId !== registration!.connectionId) throw new Error("Device start identity mismatch.");
          native = options.existingOwner ? startExistingOwnerDeviceTransport({ config: options.existingOwner,start,ws,limits,stop }) : startDeviceNativeTransport({ config: config!, start, ws, limits, stop });
        }
        return;
      }
      if (binary) throw new Error("Early device bytes.");
      const notice = parseDeviceControlRegistration(JSON.parse(data.toString()));
      if (notice.hostId !== credential.hostId || notice.instanceId !== credential.instanceId || notice.hostEpoch !== credential.hostEpoch) {
        stop(); return;
      }
      registered = true;
      registration = notice;
      touch();
      options.onRegistered(notice);
    } catch { stop(); }
  });
  ws.on("ping", data => {
    if (!registered || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + data.length + 16 > limits.maxPendingBytes) { stop(); return; }
    ws.pong(data, undefined, error => { if (error) stop(); });
    touch();
  });
  ws.on("pong", stop);
  return { closed, stop };
}
