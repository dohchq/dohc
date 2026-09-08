import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DEVICE_CONTROL_PATH, DEVICE_CONTROL_PROTOCOL, parseDeviceControlLimits,
  parseDeviceControlRegistration, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { createDeviceControlRequestParser, refuseDeviceControl, TokenBucketLimiter } from "@dohc/service-http";
import { clientAddress } from "./clientAddress.js";

export function createDeviceControlBridge(options: {
  publicHosts: ReadonlySet<string>; relayUrl: string; relayExchangeKey: string; limits: DeviceControlLimits;
  admission: { capacity: number; refillPerSecond: number; maxKeys: number };
  trustedProxies: ReadonlySet<string>;
  now?: () => number;
}) {
  const limits = parseDeviceControlLimits(options.limits);
  const admission = options.admission;
  if (admission === null || typeof admission !== "object" || Array.isArray(admission) ||
    Object.keys(admission).sort().join(",") !== "capacity,maxKeys,refillPerSecond" ||
    !Number.isSafeInteger(admission.capacity) || admission.capacity <= 0 ||
    !Number.isSafeInteger(admission.maxKeys) || admission.maxKeys <= 0 ||
    !Number.isFinite(admission.refillPerSecond) || admission.refillPerSecond <= 0) {
    throw new TypeError("Invalid device control admission limits.");
  }
  const limiter = new TokenBucketLimiter(admission.capacity, admission.refillPerSecond, admission.maxKeys);
  const trustedProxies = new Set(options.trustedProxies);
  const now = options.now ?? Date.now;
  if (typeof options.relayExchangeKey !== "string" || options.relayExchangeKey.length < 32) {
    throw new TypeError("Device control requires a relay exchange key.");
  }
  const relayExchangeKey = options.relayExchangeKey;
  const relay = new URL(options.relayUrl);
  if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/") {
    throw new TypeError("Device control requires a relay HTTP(S) origin.");
  }
  relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
  relay.pathname = DEVICE_CONTROL_PATH;
  const parseRequest = createDeviceControlRequestParser({ hosts: options.publicHosts, path: DEVICE_CONTROL_PATH,
    protocol: DEVICE_CONTROL_PROTOCOL, ...limits });
  const receive = { perMessageDeflate: false as const, autoPong: false, maxPayload: limits.maxPayloadBytes,
    maxFragments: limits.maxFragments, maxBufferedChunks: limits.maxBufferedChunks, closeTimeout: limits.closeTimeoutMs };
  const server = new WebSocketServer({ ...receive, noServer: true, clientTracking: false,
    handleProtocols: () => DEVICE_CONTROL_PROTOCOL });
  const connections = new Set<() => void>();
  let closed = false;
  server.on("wsClientError", (_error, socket) => refuseDeviceControl(socket, limits.closeTimeoutMs));

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const headers = parseRequest(request);
    if (closed || !headers || connections.size >= limits.maxConnections || head.length !== 0) {
      refuseDeviceControl(socket, limits.closeTimeoutMs); return;
    }
    const address = clientAddress(request.socket.remoteAddress, headers.get("x-forwarded-for") ?? null, trustedProxies);
    if (!limiter.allow(address, now())) { refuseDeviceControl(socket, limits.closeTimeoutMs); return; }
    let device: WebSocket | undefined, upstream: WebSocket | undefined;
    let done = false, registered = false;
    let expectedPong: Buffer | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connections.delete(stop);
      socket.removeListener("data", earlyData);
      upstream?.terminate();
      if (device) device.terminate(); else refuseDeviceControl(socket, limits.closeTimeoutMs);
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, limits.heartbeatIntervalMs + limits.heartbeatTimeoutMs);
      timer.unref();
    };
    const writable = (target: WebSocket | undefined, bytes: number): target is WebSocket =>
      target?.readyState === WebSocket.OPEN && target.bufferedAmount + bytes <= limits.maxPendingBytes;
    const earlyData = () => stop();
    connections.add(stop);
    socket.once("close", stop);
    socket.once("end", stop);
    socket.once("error", stop);
    // No device application frames exist in this protocol. Observe cancellation
    // while the relay authenticates, and refuse bytes sent before the upgrade.
    socket.on("data", earlyData);
    socket.resume();
    timer = setTimeout(stop, limits.handshakeTimeoutMs);
    timer.unref();
    try {
      // Copy only the device credential. Internal authentication always comes from this service.
      upstream = new WebSocket(relay, DEVICE_CONTROL_PROTOCOL, { ...receive, handshakeTimeout: limits.handshakeTimeoutMs,
        followRedirects: false, headers: { authorization: headers.get("authorization")!,
          "x-dohc-relay-exchange-key": relayExchangeKey } });
      upstream.on("error", stop);
      upstream.on("close", stop);
      upstream.on("message", (data, binary) => {
        if (done || registered || binary) { stop(); return; }
        try {
          const notice = JSON.stringify(parseDeviceControlRegistration(JSON.parse(data.toString())));
          if (Buffer.byteLength(notice) > limits.maxPayloadBytes) { stop(); return; }
          socket.removeListener("data", earlyData);
          socket.pause();
          server.handleUpgrade(request, socket, head, accepted => {
            device = accepted;
            device.on("error", stop);
            device.on("close", stop);
            device.on("message", stop);
            device.on("ping", stop);
            device.on("pong", pong => {
              if (!expectedPong || !pong.equals(expectedPong) || !writable(upstream, pong.length + 16)) { stop(); return; }
              expectedPong = undefined;
              upstream.pong(pong, undefined, error => { if (error) stop(); });
            });
            if (done || !writable(device, Buffer.byteLength(notice) + 16)) { stop(); return; }
            registered = true;
            device.send(notice, error => { if (error) stop(); });
            touch();
            device.resume();
          });
        } catch { stop(); }
      });
      upstream.on("ping", ping => {
        if (!registered || expectedPong || !writable(device, ping.length + 16)) { stop(); return; }
        expectedPong = Buffer.from(ping);
        device.ping(ping, undefined, error => { if (error) stop(); });
        touch();
      });
      upstream.on("pong", stop);
    } catch { stop(); }
  }
  return { handleUpgrade, close() {
    if (closed) return;
    closed = true;
    for (const stop of connections) stop();
    server.close();
  } };
}
