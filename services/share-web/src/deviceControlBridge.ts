import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DEVICE_CONTROL_PATH, DEVICE_CONTROL_PROTOCOL, parseDeviceControlLimits,
  parseDeviceControlRegistration, parseDeviceLiveHostStart, parseDeviceLiveHostTransport, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { BoundedSendQueue, createDeviceControlRequestParser, refuseDeviceControl, TokenBucketLimiter } from "@dohc/service-http";
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
    let started = false, attached = false;
    let toDevice: BoundedSendQueue | undefined, toRelay: BoundedSendQueue | undefined;
    let expectedPong: Buffer | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      toDevice?.close(); toRelay?.close();
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
    const sendQueue = (target: WebSocket) => new BoundedSendQueue({ maxBytes: limits.maxPendingBytes, maxSegmentBytes: limits.maxPayloadBytes,
      send(bytes, binary, callback) {
        if (!writable(target, bytes.length + 16)) throw new Error("Device bridge is full.");
        target.send(bytes, { binary }, callback);
      }, onDrain() {}, onError: stop });
    const earlyData = () => stop();
    connections.add(stop);
    socket.once("close", stop);
    socket.once("end", stop);
    socket.once("error", stop);
    // Observe cancellation during relay authentication and refuse pre-upgrade bytes.
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
        if (done) return;
        try {
          if (registered) {
            if (binary) {
              if (!attached) throw new Error("Early relay bytes.");
              toDevice!.write(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data), true);
            } else {
              if (started) throw new Error("Unexpected relay control.");
              const start = JSON.stringify(parseDeviceLiveHostStart(JSON.parse(data.toString())));
              started = true;
              toDevice!.write(Buffer.from(start), false);
            }
            return;
          }
          if (binary) throw new Error("Early relay bytes.");
          const notice = JSON.stringify(parseDeviceControlRegistration(JSON.parse(data.toString())));
          if (Buffer.byteLength(notice) > limits.maxPayloadBytes) { stop(); return; }
          socket.removeListener("data", earlyData);
          socket.pause();
          server.handleUpgrade(request, socket, head, accepted => {
            device = accepted;
            toDevice = sendQueue(device);
            toRelay = sendQueue(upstream!);
            device.on("error", stop);
            device.on("close", stop);
            device.on("message", (bytes, isBinary) => {
              try {
                if (!registered || !started) throw new Error("Early device bytes.");
                if (isBinary) {
                  if (!attached) throw new Error("Early native bytes.");
                  toRelay!.write(Buffer.isBuffer(bytes) ? bytes : Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes), true);
                } else {
                  if (attached) throw new Error("Unexpected device control.");
                  const transport = JSON.stringify(parseDeviceLiveHostTransport(JSON.parse(bytes.toString())));
                  attached = true;
                  toRelay!.write(Buffer.from(transport), false);
                }
              } catch { stop(); }
            });
            device.on("ping", stop);
            device.on("pong", pong => {
              if (!expectedPong || !pong.equals(expectedPong) || !writable(upstream, pong.length + 16)) { stop(); return; }
              expectedPong = undefined;
              upstream.pong(pong, undefined, error => { if (error) stop(); });
            });
            if (done || !writable(device, Buffer.byteLength(notice) + 16)) { stop(); return; }
            registered = true;
            toDevice.write(Buffer.from(notice), false);
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
