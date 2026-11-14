import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import {
  DEVICE_CONTROL_PROTOCOL,
  type DeviceControlLimits,
} from "@dohc/live-session-contract/device-control";
import { createDeviceControlBridge } from "./deviceControlBridge.js";
import { DeviceCreditSender } from "@dohc/service-http";

const limits: DeviceControlLimits = {
  maxConnections: 2,
  maxHeaderBytes: 8192,
  maxCredentialBytes: 4096,
  maxPayloadBytes: 4096,
  maxPendingBytes: 8192,
  maxFragments: 8,
  maxBufferedChunks: 8,
  handshakeTimeoutMs: 10_000,
  heartbeatIntervalMs: 200,
  heartbeatTimeoutMs: 300,
  closeTimeoutMs: 50,
};
const key = "configured-device-control-relay-key";
const notice = {
  type: "registered",
  mode: "device",
  hostId: "host",
  hostEpoch: 1,
  instanceId: "instance",
  connectionId: "connection",
};
const admission = { capacity: 20, refillPerSecond: 1, maxKeys: 8 };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  overrides: Partial<DeviceControlLimits> = {},
  ingress = {
    admission,
    trustedProxies: new Set<string>(),
    now: Date.now,
  },
) {
  const relayHttp = createServer(),
    relay = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  relayHttp.listen(0, "127.0.0.1");
  await once(relayHttp, "listening");
  const relayAddress = relayHttp.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error();
  const bridge = createDeviceControlBridge({
    publicHosts: new Set(["share.test"]),
    relayExchangeKey: key,
    relayUrl: `http://127.0.0.1:${relayAddress.port}`,
    limits: { ...limits, ...overrides },
    ...ingress,
  });
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
  const upgraded = new Promise<void>((resolve) => {
    seen = resolve;
  });
  relayHttp.on("upgrade", (request, socket, head) => {
    headers = request.headers;
    requestCount += 1;
    rawSocket = socket;
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("end", () => socket.destroy());
    socket.resume();
    accept = () =>
      relay.handleUpgrade(request, socket, head, (ws) => {
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
    await Promise.all([
      new Promise<void>((resolve) => share.close(() => resolve())),
      new Promise<void>((resolve) => relayHttp.close(() => resolve())),
    ]);
  });
  const port = address.port;
  function connect(headers: Record<string, string> = {}) {
    const device = new WebSocket(
      `ws://127.0.0.1:${port}/api/device-control`,
      DEVICE_CONTROL_PROTOCOL,
      {
        perMessageDeflate: false,
        headers: {
          host: "share.test",
          authorization: "Bearer Y3JlZGVudGlhbA",
          "x-dohc-relay-exchange-key": "attacker-key",
          "x-private-extra": "never-forward-this",
          "x-forwarded-for": "198.51.100.1",
          ...headers,
        },
      },
    );
    device.on("error", () => {});
    const closed = new Promise<void>((resolve) => device.once("close", () => resolve()));
    return { device, closed };
  }
  const { device, closed } = connect();
  await Promise.race([upgraded, closed]);
  return {
    bridge,
    relayHttp,
    device,
    closed,
    connect,
    requestCount: () => requestCount,
    headers: () => headers,
    upstream: () => upstream,
    rawSocket: () => rawSocket!,
    async register() {
      const message = once(device, "message");
      accept!();
      await message;
    },
  };
}

it("supplies its configured exchange key and forwards no caller internal headers", async () => {
  const fixture = await setup();
  await fixture.register();
  expect(fixture.headers()).toMatchObject({
    authorization: "Bearer Y3JlZGVudGlhbA",
    "x-dohc-relay-exchange-key": key,
  });
  expect(fixture.headers()?.["x-private-extra"]).toBeUndefined();
  fixture.bridge.close();
  await fixture.closed;
});

it.each(["early-device"])("refuses invalid document transport ordering: %s", async (mode) => {
  const fixture = await setup();
  await fixture.register();
  if (mode === "early-device") fixture.device.send(Buffer.from("DOP1"));
  if (mode === "early-relay") fixture.upstream()!.send(Buffer.from("DOP1"));
  if (mode === "unknown-device")
    fixture.device.send(
      JSON.stringify({
        type: "liveHost.transport",
        version: 1,
        receive: { maxPayloadBytes: 4096, maxPendingBytes: 8192 },
      }),
    );
  if (mode === "duplicate-start") {
    const start = JSON.stringify({
      type: "liveHost.start",
      version: 1,
      relayNamespace: "relay",
      receive: { maxPayloadBytes: 4096, maxPendingBytes: 8192 },
      authToken: "A".repeat(43),
      host: { hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection" },
    });
    fixture.upstream()!.send(start);
    fixture.upstream()!.send(start);
  }
  await fixture.closed;
});

it("carries frames larger than the bridge budget in both directions after a receiver stalls", async () => {
  const fixture = await setup({ heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 });
  await fixture.register();
  const receive = { maxPayloadBytes: 4096, maxPendingBytes: 8192 };
  const start = once(fixture.device, "message");
  fixture.upstream()!.send(
    JSON.stringify({
      type: "liveHost.start",
      version: 1,
      relayNamespace: "relay",
      receive,
      authToken: "A".repeat(43),
      host: { hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection" },
    }),
  );
  await start;
  const attached = once(fixture.upstream()!, "message");
  fixture.device.send(JSON.stringify({ type: "liveHost.transport", version: 1, receive }));
  await attached;
  const transfers = [
    [fixture.upstream()!, fixture.device, Buffer.alloc(32_768, 37)],
    [fixture.device, fixture.upstream()!, Buffer.alloc(24_576, 81)],
  ] as const;
  await Promise.all(
    transfers.map(async ([source, target, expected]) => {
      const chunks: Buffer[] = [];
      let count = 0,
        credit = 0,
        release!: () => void,
        first!: () => void,
        complete!: () => void;
      const firstReceived = new Promise<void>((resolve) => {
        first = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const queue = new DeviceCreditSender({
        maxQueuedBytes: expected.length + 16,
        maxPayloadBytes: 4096,
        windowBytes: 8192,
        send(bytes, done) {
          source.send(bytes, done);
        },
        onDrain() {},
        onError() {
          throw new Error("Transfer failed.");
        },
      });
      source.on("message", (bytes, binary) => {
        if (!binary) queue.acknowledge(JSON.parse(bytes.toString()).receivedBytes);
      });
      target.on("message", (bytes, binary) => {
        if (!binary) return;
        const chunk = Buffer.from(bytes as Buffer);
        chunks.push(chunk);
        count += chunk.length;
        credit += chunk.length + 16;
        const ack = () =>
          target.send(
            JSON.stringify({ type: "liveHost.credit", version: 1, receivedBytes: credit }),
          );
        if (chunks.length === 1) {
          release = ack;
          first();
        } else ack();
        if (count === expected.length) complete();
      });
      queue.write(expected);
      await firstReceived;
      expect(source.readyState).toBe(WebSocket.OPEN);
      expect(target.readyState).toBe(WebSocket.OPEN);
      release();
      await completed;
      expect(Buffer.concat(chunks)).toEqual(expected);
      queue.close();
    }),
  );
});

it("bounds the internal handshake when the relay never sends registration", async () => {
  const fixture = await setup({ handshakeTimeoutMs: 200 });
  await fixture.closed;
  expect(fixture.device.readyState).toBe(WebSocket.CLOSED);
});

it("refuses exhausted and spoofed client budgets before dialing the relay, then refills", async () => {
  let now = 0;
  const fixture = await setup(
    { heartbeatIntervalMs: 60_000 },
    {
      admission: { capacity: 1, refillPerSecond: 1, maxKeys: 8 },
      trustedProxies: new Set(),
      now: () => now,
    },
  );
  await fixture.register();
  const refused = fixture.connect({
    "x-forwarded-for": "198.51.100.2",
    "x-dohc-share-web-client-ip": "198.51.100.3",
  });
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
  const fixture = await setup(
    { heartbeatIntervalMs: 60_000 },
    {
      admission: { capacity: 1, refillPerSecond: 1, maxKeys: 8 },
      trustedProxies: new Set(["127.0.0.1"]),
      now: () => 0,
    },
  );
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
