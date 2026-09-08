import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { DEVICE_CONTROL_PROTOCOL, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { createDeviceControlBridge } from "./deviceControlBridge.js";

const limits: DeviceControlLimits = { maxConnections: 2, maxHeaderBytes: 8192, maxCredentialBytes: 4096,
  maxPayloadBytes: 4096, maxPendingBytes: 8192, maxFragments: 8, maxBufferedChunks: 8,
  handshakeTimeoutMs: 200, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 300, closeTimeoutMs: 50 };
const key = "configured-device-control-relay-key";
const notice = { type: "registered", mode: "device", hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection" };
const admission = { capacity: 20, refillPerSecond: 1, maxKeys: 8 };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(overrides: Partial<DeviceControlLimits> = {}, ingress = {
  admission, trustedProxies: new Set<string>(), now: Date.now,
}) {
  const relayHttp = createServer(), relay = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  relayHttp.listen(0, "127.0.0.1");
  await once(relayHttp, "listening");
  const relayAddress = relayHttp.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error();
  const bridge = createDeviceControlBridge({ publicHosts: new Set(["share.test"]), relayExchangeKey: key,
    relayUrl: `http://127.0.0.1:${relayAddress.port}`, limits: { ...limits, ...overrides }, ...ingress });
  const share = createServer();
  share.on("upgrade", bridge.handleUpgrade);
  share.listen(0, "127.0.0.1");
  await once(share, "listening");
  const address = share.address();
  if (!address || typeof address === "string") throw new Error();
  let upstream: WebSocket | undefined, headers: IncomingMessage["headers"] | undefined;
  let rawSocket: Duplex | undefined;
  const rawSockets = new Set<Duplex>();
  let requestCount = 0;
  let accept: (() => void) | undefined;
  let seen: () => void;
  const upgraded = new Promise<void>(resolve => { seen = resolve; });
  relayHttp.on("upgrade", (request, socket, head) => {
    headers = request.headers;
    requestCount += 1;
    rawSocket = socket;
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("end", () => socket.destroy());
    socket.resume();
    accept = () => relay.handleUpgrade(request, socket, head, ws => {
      upstream = ws;
      ws.on("error", () => {});
      ws.send(JSON.stringify(notice));
    });
    seen();
  });
  cleanups.push(async () => {
    bridge.close();
    for (const socket of rawSockets) socket.destroy();
    for (const ws of relay.clients) ws.terminate();
    relay.close();
    relayHttp.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => share.close(() => resolve())), new Promise<void>(resolve => relayHttp.close(() => resolve()))]);
  });
  const port = address.port;
  function connect(headers: Record<string, string> = {}) {
    const device = new WebSocket(`ws://127.0.0.1:${port}/api/device-control`, DEVICE_CONTROL_PROTOCOL, {
    perMessageDeflate: false, headers: { host: "share.test", authorization: "Bearer Y3JlZGVudGlhbA",
      "x-dohc-relay-exchange-key": "attacker-key", "x-private-extra": "never-forward-this",
      "x-forwarded-for": "198.51.100.1", ...headers },
    });
    device.on("error", () => {});
    const closed = new Promise<void>(resolve => device.once("close", () => resolve()));
    return { device, closed };
  }
  const { device, closed } = connect();
  await upgraded;
  return { bridge, relayHttp, device, closed, connect, requestCount: () => requestCount,
    headers: () => headers, upstream: () => upstream, rawSocket: () => rawSocket!,
    async register() { const message = once(device, "message"); accept!(); await message; } };
}

it("supplies its configured exchange key and forwards no caller internal headers", async () => {
  const fixture = await setup();
  await fixture.register();
  expect(fixture.headers()).toMatchObject({ authorization: "Bearer Y3JlZGVudGlhbA", "x-dohc-relay-exchange-key": key });
  expect(fixture.headers()?.["x-private-extra"]).toBeUndefined();
  fixture.bridge.close();
  await fixture.closed;
});

it("cancels the internal pending handshake when the outbound device leaves", async () => {
  const fixture = await setup({ handshakeTimeoutMs: 60_000 });
  const socketClosed = once(fixture.rawSocket(), "close");
  fixture.device.terminate();
  await fixture.closed;
  await socketClosed;
});

it("bounds the internal handshake when the relay never sends registration", async () => {
  const fixture = await setup();
  await fixture.closed;
  expect(fixture.device.readyState).toBe(WebSocket.CLOSED);
});

it.each(["relay-loss", "extra-notice", "oversized", "application", "liveness"] as const)("closes the bridge on %s", async mode => {
  const fixture = await setup();
  await fixture.register();
  if (mode === "relay-loss") fixture.upstream()!.terminate();
  if (mode === "extra-notice") fixture.upstream()!.send(JSON.stringify(notice));
  if (mode === "oversized") fixture.upstream()!.send(Buffer.alloc(limits.maxPayloadBytes + 1));
  if (mode === "application") fixture.device.send("unsupported");
  await fixture.closed;
});

it("refuses missing internal keys and non-origin relay URLs before enabling", () => {
  const options = { publicHosts: new Set(["share.test"]), relayUrl: "http://relay.test", relayExchangeKey: key,
    limits, admission, trustedProxies: new Set<string>() };
  expect(() => createDeviceControlBridge({ ...options, relayExchangeKey: "" })).toThrow();
  expect(() => createDeviceControlBridge({ ...options, relayUrl: "http://relay.test/path" })).toThrow();
});

it("refuses exhausted and spoofed client budgets before dialing the relay, then refills", async () => {
  let now = 0;
  const fixture = await setup({ heartbeatIntervalMs: 60_000 }, {
    admission: { capacity: 1, refillPerSecond: 1, maxKeys: 8 }, trustedProxies: new Set(), now: () => now,
  });
  await fixture.register();
  const refused = fixture.connect({ "x-forwarded-for": "198.51.100.2", "x-dohc-share-web-client-ip": "198.51.100.3" });
  await refused.closed;
  expect(fixture.requestCount()).toBe(1);
  expect(fixture.device.readyState).toBe(WebSocket.OPEN);
  now = 1000;
  const upgraded = once(fixture.relayHttp, "upgrade");
  const refilled = fixture.connect();
  await upgraded;
  expect(fixture.requestCount()).toBe(2);
  refilled.device.terminate();
  await refilled.closed;
});

it("derives separate forwarded client budgets only through a configured trusted proxy", async () => {
  const fixture = await setup({ heartbeatIntervalMs: 60_000 }, {
    admission: { capacity: 1, refillPerSecond: 1, maxKeys: 8 }, trustedProxies: new Set(["127.0.0.1"]), now: () => 0,
  });
  await fixture.register();
  const refused = fixture.connect({ "x-forwarded-for": "198.51.100.77, 198.51.100.1, 127.0.0.1" });
  await refused.closed;
  expect(fixture.requestCount()).toBe(1);
  const upgraded = once(fixture.relayHttp, "upgrade");
  const other = fixture.connect({ "x-forwarded-for": "198.51.100.2, 127.0.0.1" });
  await upgraded;
  expect(fixture.requestCount()).toBe(2);
  other.device.terminate();
  await other.closed;
});

it("requires explicit finite admission limits before enabling control", () => {
  const options = { publicHosts: new Set(["share.test"]), relayUrl: "http://relay.test", relayExchangeKey: key,
    limits, admission, trustedProxies: new Set<string>() };
  for (const field of ["capacity", "maxKeys", "refillPerSecond"] as const) {
    for (const value of [undefined, 0, -1, NaN, Infinity]) {
      expect(() => createDeviceControlBridge({ ...options, admission: { ...admission, [field]: value } as typeof admission })).toThrow();
    }
  }
  for (const field of ["capacity", "maxKeys"] as const) {
    expect(() => createDeviceControlBridge({ ...options, admission: { ...admission, [field]: 1.5 } })).toThrow();
  }
});
