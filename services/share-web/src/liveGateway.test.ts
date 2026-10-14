import {selfHostLiveProfile} from "../../sync-relay/src/selfHostLiveProfile";
import {LIVE_CONNECTION_LIMIT_CLOSE_CODE, createLiveBufferBudget} from "@dohc/live-session-contract/live-connection";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { decodeLiveFrame, encodeLiveFrame, encodeLiveFrameSync, type LiveFrame } from "@dohc/live-session-contract/live-frame";
import { createLiveGateway, parseLiveGatewayLimits, type LiveGatewayHostReceiveOptions, type LiveGatewayHostRoute, type LiveGatewayLimits, type LiveGatewayOptions } from "./liveGateway.js";
import { createNamedLiveBrowserResolver } from "../../sync-relay/src/namedLiveBrowserAuth.js";
import { createLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLiveHostReports } from "../../sync-relay/src/namedLiveHostReports.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "../../sync-relay/src/namedLiveFrameHost.js";
import { fixture as ticketFixture, scope, binding, host, key, audience } from "../../sync-relay/src/liveTickets.test-helper.js";

const origin = "https://share.example.test";
const discriminator = "abcdefghijkl";
const token = "ab".repeat(32);
const limits: LiveGatewayLimits = {
  maxConnections: 8, maxConnectionsPerWorkspace: 96, reservedOwnerConnections: 0, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 4, maxConnectionsPerGrant: 5, maxBufferedBytes: 134217728,
  // Upgrades open a real host socket and forward real frames; a loaded gate host
  // can stall either past 2 s. Tests of these bounds override them.
  maxFrameBytes: 2048, maxPendingBytes: 4 * 1024 * 1024, maxPendingFrames: 4, maxFragments: 8, maxBufferedChunks: 16,
  upgradeTimeoutMs: 10_000, idleTimeoutMs: 10_000, drainTimeoutMs: 100,
};
const session = { kind: "named" as const, userId: "alice", workspaceId: "workspace", shareId: "share", grantId: "edit" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => { console.info(`NAMED_GATEWAY_TEST_PID=${process.pid}`); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function fixture(overrides: Partial<LiveGatewayOptions> = {}, onUpgrade?: (socket: Duplex) => void) {
  const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const hostHttp = createServer();
  const hostServer = new WebSocketServer({ server: hostHttp, perMessageDeflate: false, autoPong: false });
  const sockets: WebSocket[] = [];
  const rawSockets: Socket[] = [];
  const hosts: WebSocket[] = [];
  hostServer.on("connection", socket => {
    socket.on("error", () => undefined);
    hosts.push(socket);
    sockets.push(socket);
  });
  hostHttp.listen(0, "127.0.0.1");
  await once(hostHttp, "listening");
  const hostPort = (hostHttp.address() as { port: number }).port;
  const invalidated = new AbortController();
  const policy = overrides.limits ?? limits;
  const receiveOptions: LiveGatewayHostReceiveOptions = Object.freeze({ maxPayload: policy.maxFrameBytes,
    maxFragments: policy.maxFragments, maxBufferedChunks: policy.maxBufferedChunks, closeTimeout: policy.drainTimeoutMs,
    perMessageDeflate: false, autoPong: false });
  const makeRoute = async (receive: LiveGatewayHostReceiveOptions): Promise<LiveGatewayHostRoute> => {
    expect(receive).toEqual(receiveOptions);
    expect(Object.isFrozen(receive)).toBe(true);
    const socket = new WebSocket(`ws://127.0.0.1:${hostPort}`, receive);
    sockets.push(socket);
    // once owns connection errors until open. The fixture host sends no early
    // application bytes; this does not prove a production adapter's pause timing.
    await once(socket, "open");
    socket.pause();
    return { socket, invalidated: invalidated.signal };
  };
  const resolve = vi.fn<LiveGatewayOptions["resolveSession"]>(async () => session);
  const open = vi.fn<LiveGatewayOptions["openHostRoute"]>((_input, _signal, receive) => makeRoute(receive));
  const gateway = createLiveGateway({ publicHosts: new Set(["share.example.test"]), publicOrigin: origin,
    limits, resolveSession: resolve, openHostRoute: open, ...overrides });
  const completions: Promise<void>[] = [];
  http.on("upgrade", (request, socket, head) => {
    onUpgrade?.(socket);
    completions.push(gateway.handleUpgrade(request, socket, head));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = (http.address() as { port: number }).port;

  function browser(options: { token?: string; cookie?: string; session?: string } = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live?session=${options.session ?? discriminator}`,
      ["dohc-live-v1", `dohc-live-ticket.${options.token ?? token}`], {
        headers: { host: "share.example.test", origin, cookie: options.cookie ?? "account=alice" },
        perMessageDeflate: false, autoPong: false,
      });
    sockets.push(socket);
    const messages: Buffer[] = [];
    socket.on("message", bytes => messages.push(Buffer.from(bytes as Buffer)));
    socket.on("error", () => undefined);
    const status = new Promise<number>(accept => {
      socket.once("open", () => accept(101));
      socket.once("unexpected-response", (_request, response) => { response.resume(); accept(response.statusCode!); socket.terminate(); });
      socket.once("error", () => accept(0));
    });
    const closed = new Promise<[number, string]>(resolve => socket.once("close", (code, reason) => resolve([code, reason.toString()])));
    return { socket, status, messages, closed };
  }
  async function raw(headers: string[], handshake = { key: "dGhlIHNhbXBsZSBub25jZQ==", version: "13" }) {
    const socket = connect(port, "127.0.0.1");
    rawSockets.push(socket);
    socket.on("error", () => undefined);
    let received = "";
    socket.on("data", bytes => { received += bytes.toString(); });
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write([`GET /api/live?session=${discriminator} HTTP/1.1`, "Connection: Upgrade", "Upgrade: websocket",
      `Sec-WebSocket-Key: ${handshake.key}`, `Sec-WebSocket-Version: ${handshake.version}`, ...headers, "", ""].join("\r\n"));
    await closed;
    return received;
  }
  cleanups.push(async () => {
    gateway.close();
    for (const socket of sockets) socket.terminate();
    for (const socket of rawSockets) socket.destroy();
    await Promise.all([
      new Promise<void>(accept => http.close(() => accept())),
      new Promise<void>(accept => hostServer.close(() => accept())),
      new Promise<void>(accept => hostHttp.close(() => accept())),
      ...completions,
    ]);
  });
  return { gateway, browser, raw, resolve, open, hosts, makeRoute, receiveOptions, invalidated, completions };
}

function stalledRefusal() {
  let flush!: () => void;
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { flush = () => callback(); } });
  const ports = { resolveSession: vi.fn(async () => null), openHostRoute: vi.fn(async () => null) };
  const gateway = createLiveGateway({ publicHosts: new Set(["share.example.test"]), publicOrigin: origin, limits, ...ports });
  const request = { method: "GET", url: `/api/live?session=${discriminator}`, rawHeaders: ["Host", "share.example.test"] } as IncomingMessage;
  cleanups.push(async () => { gateway.close(); socket.destroy(); });
  return { socket, ports, flush: () => flush(), refuse: () => gateway.handleUpgrade(request, socket, Buffer.alloc(0)) };
}

describe("private named live gateway", () => {
  it("bounds a stalled refusal without extending its deadline on repeated refusal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = stalledRefusal();
    await state.refuse();
    expect(state.socket.writableEnded).toBe(true);
    expect(state.socket.writableFinished).toBe(false);
    vi.advanceTimersByTime(limits.drainTimeoutMs / 2);
    await state.refuse();
    vi.advanceTimersByTime(limits.drainTimeoutMs / 2 - 1);
    expect(state.socket.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(state.socket.destroyed).toBe(true);
    for (const port of Object.values(state.ports)) expect(port).not.toHaveBeenCalled();
  });

  it.each(["finish", "close"])("clears the refusal deadline after early %s", async ending => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = stalledRefusal();
    const destroy = vi.spyOn(state.socket, "destroy");
    await state.refuse();
    vi.advanceTimersByTime(limits.drainTimeoutMs - 1);
    const closed = once(state.socket, "close");
    if (ending === "finish") state.flush(); else state.socket.destroy();
    await closed;
    expect(state.socket.writableFinished).toBe(ending === "finish");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(limits.drainTimeoutMs);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Host: share.example.test"],
    ["Host: share.example.test", "Origin: https://evil.example.test"],
    ["Host: share.example.test", `Origin: ${origin}`, `Origin: ${origin}`],
    ["Host: evil.example.test", `Origin: ${origin}`],
    ["Host: share.example.test", "Host: share.example.test", `Origin: ${origin}`],
    ["Host: share.example.test", `Origin: ${origin}, ${origin}`],
  ].map(headers => ({ headers })))("refuses raw Host/Origin ambiguity before authentication and redemption: $headers", async ({ headers }) => {
    const state = await fixture();
    const response = await state.raw([...headers, `Sec-WebSocket-Protocol: dohc-live-v1, dohc-live-ticket.${token}`]);
    expect(response).toContain("HTTP/1.1 404");
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
  });

  it("upgrades once, echoes only the version, and forwards real frames unchanged in both directions", async () => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    expect(client.socket.protocol).toBe("dohc-live-v1");
    expect(state.open).toHaveBeenCalledWith(expect.objectContaining({discriminator, ticketToken: token, request: expect.anything()}), expect.any(AbortSignal), state.receiveOptions);
    const receivePolicy = { maxFrameBytes: 2048, maxStateVectorBytes: 512, maxUpdateBytes: 1024, maxSyncBytes: 2048 };
    const hello = encodeLiveFrame({ kind: "hello", receivePolicy }, 2048);
    const received = once(state.hosts[0]!, "message");
    client.socket.send(hello);
    expect(Buffer.from((await received)[0])).toEqual(Buffer.from(hello));
    const welcome = encodeLiveFrame({ kind: "welcome", hostEpoch: parseHostEpoch(1), receivePolicy }, 2048);
    const returned = once(client.socket, "message");
    state.hosts[0]!.send(welcome);
    expect(Buffer.from((await returned)[0])).toEqual(Buffer.from(welcome));
  });

  it("does not manufacture success while the host holds an update for durable application", async () => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    const digest = createHash("sha256").update("update").digest("hex");
    const frame = encodeLiveFrame({ kind: "begin", purpose: "submit-update", transferId: 1, totalBytes: 6, digest, deliveryId: "delivery" }, 2048);
    const received = once(state.hosts[0]!, "message");
    client.socket.send(frame);
    expect(Buffer.from((await received)[0])).toEqual(Buffer.from(frame));
    expect(client.messages).toEqual([]);
    const ack = { deliveryId: "delivery", updateDigest: digest, journalCursor: 17, acceptingHostEpoch: parseHostEpoch(1),
      localYDocSequence: 9, applicationReplayed: false };
    const applied = once(client.socket, "message");
    state.hosts[0]!.send(encodeLiveFrame({ kind: "result", result: "success", ack }, 2048));
    expect(decodeLiveFrame((await applied)[0], 2048)).toEqual({ kind: "result", result: "success", ack });
  });

  it.each(["invalidated", "unpaused"])("refuses and closes a %s host route before 101", async changed => {
    const state = await fixture();
    state.open.mockImplementation(async (_input, _signal, receive) => {
      const route = await state.makeRoute(receive);
      if (changed === "invalidated") state.invalidated.abort();
      if (changed === "unpaused") route.socket.resume();
      return route;
    });
    expect(await state.browser().status).toBe(404);
    await Promise.all(state.completions);
    expect(state.hosts).toHaveLength(1);
  });

  it("cancels a timed-out route request and closes its late transport without upgrading", async () => {
    const ready = deferred<void>();
    const late = deferred<LiveGatewayHostRoute>();
    let signal!: AbortSignal;
    let receive!: LiveGatewayHostReceiveOptions;
    const state = await fixture({ openHostRoute: async (_ticket, cancellation, options) => {
      signal = cancellation; receive = options; ready.resolve(); return late.promise;
    } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = state.browser();
    await ready.promise;
    await vi.advanceTimersByTimeAsync(limits.upgradeTimeoutMs);
    expect(await client.status).toBe(404);
    expect(signal.aborted).toBe(true);
    await Promise.all(state.completions);
    vi.useRealTimers();
    const route = await state.makeRoute(receive);
    const closed = once(route.socket, "close");
    late.resolve(route);
    await closed;
    expect(client.messages).toEqual([]);
  });

  it("disposes a fulfilled host route when shutdown wins before delivery", async () => {
    const state = await fixture();
    const route = await state.makeRoute(state.receiveOptions);
    expect(route.socket.listenerCount("error")).toBe(0);
    let terminationErrorHandled = false;
    const originalTerminate = route.socket.terminate.bind(route.socket);
    const terminate = vi.spyOn(route.socket, "terminate").mockImplementation(() => {
      originalTerminate();
      route.socket.emit("error", new Error("queued host write failed during termination"));
      terminationErrorHandled = true;
    });
    state.open.mockImplementation(() => {
      queueMicrotask(() => queueMicrotask(() => state.gateway.close()));
      return Promise.resolve(route);
    });
    const client = state.browser();
    expect(await client.status).toBe(404);
    await Promise.all(state.completions);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminationErrorHandled).toBe(true);
    expect(client.messages).toEqual([]);
  });

  it.each([
    { key: "invalid", version: "13" },
    { key: "dGhlIHNhbXBsZSBub25jZQ==", version: "7" },
  ])("flushes an invalid WebSocket handshake refusal and releases the host and reservation: $version/$key", async handshake => {
    let destroyedBeforeFlush = false;
    const state = await fixture({ limits: { ...limits, maxConnections: 1, maxConnectionsPerWorkspace: 96, reservedOwnerConnections: 0, maxConnectionsPerSession: 1 } }, socket => {
      const destroy = socket.destroy.bind(socket);
      vi.spyOn(socket, "destroy").mockImplementation(error => {
        if (socket.writableEnded && !socket.writableFinished) destroyedBeforeFlush = true;
        return destroy(error);
      });
    });
    const response = await state.raw(["Host: share.example.test", `Origin: ${origin}`,
      `Sec-WebSocket-Protocol: dohc-live-v1, dohc-live-ticket.${token}`], handshake);
    await Promise.all(state.completions);
    expect(state.open).toHaveBeenCalledTimes(1);
    const route = (await state.open.mock.results[0]!.value)!;
    if (route.socket.readyState !== WebSocket.CLOSED) await once(route.socket, "close");
    expect(route.socket.readyState).toBe(WebSocket.CLOSED);
    expect(await state.browser().status).toBe(101);
    expect(response).toBe("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    expect(destroyedBeforeFlush).toBe(false);
  });

  it("normalizes a Blob-mode host socket before forwarding real binary frames", async () => {
    const state = await fixture();
    state.open.mockImplementation(async (_input, _signal, receive) => {
      const route = await state.makeRoute(receive);
      Reflect.set(route.socket, "binaryType", "blob");
      expect(route.socket.binaryType).toBe("blob");
      return route;
    });
    const client = state.browser();
    expect(await client.status).toBe(101);
    const route = (await state.open.mock.results[0]!.value)!;
    expect(route.socket.binaryType).toBe("nodebuffer");
    const received = once(client.socket, "message");
    state.hosts[0]!.send(Buffer.from("host frame"));
    expect((await received)[0]).toEqual(Buffer.from("host frame"));
  });

  it.each([
    { name: "Blob", payload: new Blob(["unexpected"]) },
    { name: "ArrayBuffer", payload: new ArrayBuffer(1) },
    { name: "fragments", payload: [Buffer.from("unexpected")] },
  ])("contains an unexpected $name payload after admission", async ({ payload }) => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    const route = (await state.open.mock.results[0]!.value)!;
    const closed = once(client.socket, "close");
    expect(() => route.socket.emit("message", payload, true)).not.toThrow();
    expect(route.socket.readyState).not.toBe(WebSocket.OPEN);
    await closed;
    expect(client.messages).toEqual([]);
  });

  it("returns after cancellation even when named authentication never resolves", async () => {
    const state = await fixture({ limits: { ...limits, upgradeTimeoutMs: 20 }, resolveSession: async () => new Promise(() => {}) });
    expect(await state.browser().status).toBe(404);
    await Promise.all(state.completions);
    expect(state.open).not.toHaveBeenCalled();
  });

  it("pauses the raw socket throughout asynchronous named authentication", async () => {
    const entered = deferred<IncomingMessage>();
    const resolved = deferred<typeof session>();
    const state = await fixture({ resolveSession: async request => { entered.resolve(request); return resolved.promise; } });
    const client = state.browser();
    const request = await entered.promise;
    expect(request.socket.isPaused()).toBe(true);
    expect(state.open).not.toHaveBeenCalled();
    resolved.resolve(session);
    expect(await client.status).toBe(101);
  });

  it("closes both directions on host invalidation without acknowledging", async () => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    const closed = once(client.socket, "close");
    const hostClosed = once(state.hosts[0]!, "close");
    state.invalidated.abort();
    await Promise.all([closed, hostClosed]);
    expect(client.messages).toEqual([]);
  });

  it.each(["browser", "host"])("answers %s Ping with the unchanged Pong payload", async side => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    const peer = side === "browser" ? client.socket : state.hosts[0]!;
    const pong = once(peer, "pong");
    peer.ping(Buffer.from("heartbeat"));
    expect((await pong)[0]).toEqual(Buffer.from("heartbeat"));
    expect(client.messages).toEqual([]);
  });

  it.each(["browser", "host"])("bounds %s empty-Ping replies while a Pong write is pending", async side => {
    const state = await fixture({ limits: { ...limits, maxPendingFrames: 1 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    const peer = side === "browser" ? client.socket : state.hosts[0]!;
    const sent = deferred<void>();
    const pong = vi.spyOn(WebSocket.prototype, "pong").mockImplementation(() => { sent.resolve(); });
    const closed = once(client.socket, "close");
    peer.ping(Buffer.alloc(0));
    await sent.promise;
    peer.ping(Buffer.alloc(0));
    await closed;
    expect(pong).toHaveBeenCalledTimes(1);
    expect(client.messages).toEqual([]);
  });

  it("charges Pong and application writes to the same destination queue", async () => {
    const state = await fixture({ limits: { ...limits, maxPendingFrames: 1 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    const route = (await state.open.mock.results[0]!.value)!;
    const sent = deferred<void>();
    vi.spyOn(route.socket, "send").mockImplementation(() => { sent.resolve(); });
    const pong = vi.spyOn(route.socket, "pong");
    const closed = once(client.socket, "close");
    client.socket.send(Buffer.from("pending"));
    await sent.promise;
    state.hosts[0]!.ping(Buffer.alloc(0));
    await closed;
    expect(pong).not.toHaveBeenCalled();
  });

  it.each(["payload", "fragments"])("applies required host construction limits before %s reaches a message handler", async axis => {
    const state = await fixture({ limits: { ...limits, maxFrameBytes: 64, maxFragments: 2 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    const route = (await state.open.mock.results[0]!.value)!;
    const messages = vi.fn(), errors = vi.fn();
    route.socket.on("message", messages);
    route.socket.on("error", errors);
    const closed = once(client.socket, "close");
    if (axis === "payload") state.hosts[0]!.send(Buffer.alloc(65));
    else {
      for (let index = 0; index < 3; index++) state.hosts[0]!.send(Buffer.from([index]), { fin: false });
    }
    await closed;
    expect(messages).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code:
      axis === "payload" ? "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" : "WS_ERR_TOO_MANY_BUFFERED_PARTS" }));
    expect(client.messages).toEqual([]);
    expect(state.open.mock.calls[0]![2]).toEqual(state.receiveOptions);
  });

  it.each(["text", "oversized"])("closes a %s sender without forwarding", async mode => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    const received = vi.fn();
    state.hosts[0]!.on("message", received);
    const closed = once(client.socket, "close");
    client.socket.send(mode === "text" ? "text" : Buffer.alloc(limits.maxFrameBytes + 1));
    await closed;
    expect(received).not.toHaveBeenCalled();
  });

  it.each(["maxConnections", "maxConnectionsPerWorkspace", "maxConnectionsPerSession", "maxConnectionsPerPrincipal", "maxConnectionsPerGrant"] as const)(
    "names %s after ticket redemption and releases the reservation", async limit => {
      const state = await fixture({ limits: { ...limits, [limit]: 1 } });
      const first = state.browser();
      expect(await first.status).toBe(101);
      const refused = state.browser(); expect(await refused.status).toBe(101);
      const codes = {maxConnections: "live_total_limit", maxConnectionsPerWorkspace: "live_workspace_limit", maxConnectionsPerSession: "live_session_limit",
        maxConnectionsPerPrincipal: "live_person_limit", maxConnectionsPerGrant: "live_grant_limit"};
      expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, codes[limit]]);
      expect(state.open).toHaveBeenCalledTimes(2);
      const closed = once(state.hosts[0]!, "close");
      first.socket.terminate();
      await closed;
      expect(await state.browser().status).toBe(101);
    });

  it.each(["bytes", "frames"])("bounds pending %s while a destination withholds send completion", async axis => {
    const state = await fixture({ limits: { ...limits, maxFrameBytes: 3 * 1024 * 1024, maxBufferedChunks: 128, maxPendingFrames: axis === "frames" ? 1 : 4 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    const route = (await state.open.mock.results[0]!.value)!;
    const sent = deferred<void>();
    const send = vi.spyOn(route.socket, "send").mockImplementation(() => { sent.resolve(); });
    const closed = once(client.socket, "close");
    client.socket.send(Buffer.alloc(axis === "bytes" ? 3 * 1024 * 1024 : 6));
    await sent.promise;
    client.socket.send(Buffer.alloc(axis === "bytes" ? 2 * 1024 * 1024 : 1));
    await closed;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("closes an idle connection and rejects upgrades after shutdown", async () => {
    const state = await fixture({ limits: { ...limits, idleTimeoutMs: 25 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    await once(client.socket, "close");
    state.gateway.close();
    expect(await state.browser().status).toBe(404);
  });

  it("bounds shutdown when both peers stop reading", async () => {
    const state = await fixture({ limits: { ...limits, drainTimeoutMs: 20 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    client.socket.pause();
    state.hosts[0]!.pause();
    const route = (await state.open.mock.results[0]!.value)!;
    const closed = once(route.socket, "close");
    state.gateway.close();
    await closed;
    expect(route.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("requires every injected limit to be a positive finite integer", () => {
    const base = { publicHosts: new Set(["share.example.test"]), publicOrigin: origin,
      resolveSession: async () => null, openHostRoute: async () => null };
    for (const name of Object.keys(limits)) for (const bad of [undefined, ...(name === "reservedOwnerConnections" ? [] : [0]), -1, 1.5, Infinity, NaN]) {
      expect(() => createLiveGateway({ ...base, limits: { ...limits, [name]: bad } as LiveGatewayLimits })).toThrow();
    }
    // ws receiver fields use signed 32-bit coercion; larger inputs can disable a bound.
    for (const name of ["maxFrameBytes", "maxFragments", "maxBufferedChunks", "upgradeTimeoutMs", "idleTimeoutMs", "drainTimeoutMs"]) {
      expect(() => createLiveGateway({ ...base, limits: { ...limits, [name]: 2_147_483_648 } })).toThrow();
    }
  });

  it("composes actual named authentication, durable one-use tickets, and current host reports", async () => {
    const stored = await ticketFixture();
    cleanups.push(() => stored.close());
    // Native sync is outside this gateway; the capture only reports the authenticated registration.
    const native: NamedFrameNativeHost = { workspace: "native-handle", registrationId: 1, binding, coordinate: host,
      invalidated: new AbortController().signal, changes: createNamedFrameChanges(1), deadlineMs: 1000,
      nextRequestId: () => 1, drain: async () => undefined,
      client: { openLiveAppliedSync: async () => { throw new Error("Native sync is not part of this test."); },
        readNextLiveApplied: async () => null, readLiveApplicationAck: async () => null } };
    const captureNative = vi.fn(async () => native);
    const tickets = createLiveTickets({ storage: stored.storage, audience, key,
      hostReports: createLiveHostReports({ storage: stored.storage, captureNative }) });
    const minted = await tickets.mint({ objectId: binding.objectId }, scope);
    expect(minted).not.toBeNull();
    expect(captureNative).toHaveBeenCalledOnce();
    const resolveNamed = createNamedLiveBrowserResolver({ storage: stored.storage,
      resolveActor: async (request, workspaceId) => ({ workspaceId,
        userId: request.headers.get("cookie") === "account=alice" ? scope.userId : "other-account" }) });
    const redeem = vi.fn((value: string) => tickets.redeem(value, scope));
    // Trusted fixture scope is explicit. This does not implement a public
    // discriminator-to-named-scope mapping or real account sign-in service.
    const state = await fixture({
      resolveSession: (request: IncomingMessage) => resolveNamed(new Request(`${origin}/api/live`, {
        headers: { cookie: request.headers.cookie ?? "" },
      }), scope),
    });
    state.open.mockImplementation(async (input, _signal, receive) => {
      const redeemed = await redeem(input.ticketToken);
      return redeemed ? state.makeRoute(receive) : null;
    });
    expect(await state.browser({ token: minted!.token, cookie: "account=bob" }).status).toBe(404);
    expect(redeem).not.toHaveBeenCalled();
    const attempts = [state.browser({ token: minted!.token }), state.browser({ token: minted!.token })];
    expect((await Promise.all(attempts.map(attempt => attempt.status))).sort()).toEqual([101, 404]);
    expect(state.open).toHaveBeenCalledTimes(2);
    expect(redeem).toHaveBeenCalledTimes(2);
  });
});

it("shares aggregate send capacity across connections and releases completed sends", async () => {
  const buffers = createLiveBufferBudget(12), state = await fixture({bufferBudget: buffers});
  const first = state.browser(), second = state.browser();
  expect(await first.status).toBe(101); expect(await second.status).toBe(101);
  const route = (await state.open.mock.results[0]!.value)!;
  let completed: (() => void) | undefined;
  vi.spyOn(route.socket, "send").mockImplementation((_data, _options, callback) => {completed = () => { if (typeof callback === "function") callback(); };});
  first.socket.send(Buffer.alloc(6));
  await vi.waitFor(() => expect(buffers.usage()).toBe(12));
  second.socket.send(Buffer.alloc(1));
  expect(await second.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
  completed?.(); expect(buffers.usage()).toBe(0);
  first.socket.terminate(); await first.closed; expect(buffers.usage()).toBe(0);
});

it("forwards a relay capacity refusal without replacing its reason", async () => {
  const state = await fixture(), client = state.browser();
  expect(await client.status).toBe(101);
  state.hosts[0]!.close(LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_grant_limit");
  expect(await client.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_grant_limit"]);
});

it("bounds pending gateway handshakes before authentication", async () => {
  const state = await fixture({limits: {...limits, maxConnections: 1}});
  state.resolve.mockImplementation((_request, _discriminator, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve(null), {once: true});
  }));
  state.browser();
  await vi.waitFor(() => expect(state.resolve).toHaveBeenCalledTimes(1));
  state.browser();
  await vi.waitFor(() => expect(state.resolve).toHaveBeenCalledTimes(2));
  expect(await state.browser().status).toBe(404);
  expect(state.resolve).toHaveBeenCalledTimes(2);
  expect(state.open).not.toHaveBeenCalled();
  state.gateway.close();
});

it("requires a gateway pending window at least as large as production browser credit", () => {
  const profile = selfHostLiveProfile();
  expect(profile.gateway.maxPendingBytes).toBe(profile.frames.maxQueuedBytes);
  expect(profile.namedLive.transport.maxPendingBytes).toBe(256 * 1024);
  const options = {publicHosts: new Set(["share.example.test"]), publicOrigin: origin,
    resolveSession: async () => null, openHostRoute: async () => null};
  for (const maxPendingBytes of [256 * 1024, profile.frames.maxQueuedBytes - 1])
    expect(() => createLiveGateway({...options, limits: {...profile.gateway, maxPendingBytes}})).toThrow("browser credit window");
});

it("delivers a sync above 300 KiB to a slow link holder under production limits", async () => {
  const profile = selfHostLiveProfile(), state = await fixture({limits: profile.gateway,
    resolveSession: async () => ({...session, kind: "link", principalId: "browser", sessionId: "link-session"})});
  const browser = state.browser(); expect(await browser.status).toBe(101); browser.socket.pause();
  const callbacks: (() => void)[] = [], original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function(this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
    if (this.url === undefined && this !== state.hosts[0]) {
      const callback = args.at(-1); callbacks.push(() => {if (typeof callback === "function") callback();});
      original.call(this, args[0], {binary: true, compress: false});
    } else original.apply(this, args);
  });
  const bytes = encodeLiveFrameSync({binding, hostVector: Uint8Array.of(0), missingStateUpdate: new Uint8Array(320 * 1024)}, profile.frames.receive);
  const frames: LiveFrame[] = [{kind: "begin", purpose: "initial-sync", transferId: 1, totalBytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), appliedThroughJournalCursor: 0}];
  for (let offset = 0; offset < bytes.length; offset += 60 * 1024) frames.push({kind: "chunk", transferId: 1, offset, bytes: bytes.subarray(offset, offset + 60 * 1024)});
  for (const frame of frames) state.hosts[0]!.send(encodeLiveFrame(frame, profile.frames.receive.maxFrameBytes));
  await vi.waitFor(() => expect(callbacks).toHaveLength(frames.length));
  expect(browser.socket.readyState).toBe(WebSocket.OPEN);
  browser.socket.resume();
  await vi.waitFor(() => expect(browser.messages).toHaveLength(frames.length));
  const chunks = browser.messages.map(frame => decodeLiveFrame(frame, profile.frames.receive.maxFrameBytes))
    .filter((frame): frame is Extract<LiveFrame, {kind: "chunk"}> => frame.kind === "chunk");
  expect(Buffer.concat(chunks.map(frame => Buffer.from(frame.bytes)))).toEqual(Buffer.from(bytes));
  callbacks.forEach(callback => callback());
  expect(browser.socket.readyState).toBe(WebSocket.OPEN);
});

it.each(["principal", "share"])("contains production gateway %s byte pressure and leaves another workspace connected", async scope => {
  const profile = selfHostLiveProfile(), budget = createLiveBufferBudget(profile.gateway.maxBufferedBytes);
  const state = await fixture({limits: profile.gateway, bufferBudget: budget});
  const browser = state.browser(); expect(await browser.status).toBe(101);
  const size = profile.gateway.maxBufferedBytes * (scope === "principal" ? profile.gateway.maxConnectionsPerPrincipal : profile.gateway.maxConnectionsPerGrant) / profile.gateway.maxConnections;
  const key = JSON.stringify(scope === "principal" ? ["principal", "named", session.userId] : ["share", session.workspaceId, session.shareId]);
  const release = budget.reserve(size, [[key, size]]);
  try {
    browser.socket.send(Buffer.alloc(1));
    await vi.waitFor(() => expect(browser.socket.readyState).toBe(WebSocket.CLOSED), {timeout: 2000});
    expect(await browser.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
    state.resolve.mockResolvedValue({...session, userId: "other-person", workspaceId: "other-workspace", shareId: "other-share"});
    const other = state.browser(); expect(await other.status).toBe(101);
    const received = once(state.hosts.at(-1)!, "message"); other.socket.send(Buffer.from("other"));
    expect((await received)[0]).toEqual(Buffer.from("other"));
    expect(other.socket.readyState).toBe(WebSocket.OPEN);
  } finally {release();}
});

it.each(["server", "workspace"])("leaves the configured %s owner capacity at the gateway", async mode => {
  const state = await fixture({limits: {...limits, reservedOwnerConnections: 1,
    maxConnections: mode === "server" ? 2 : 8, maxConnectionsPerWorkspace: mode === "workspace" ? 2 : 8}});
  const first = state.browser(); expect(await first.status).toBe(101);
  const refused = state.browser(); expect(await refused.status).toBe(101);
  expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, mode === "server" ? "live_total_limit" : "live_workspace_limit"]);
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
});

it("rejects a gateway owner reserve that exhausts total or workspace capacity", () => {
  const profile = selfHostLiveProfile().gateway;
  for (const reservedOwnerConnections of [profile.maxConnections, profile.maxConnectionsPerWorkspace])
    expect(() => parseLiveGatewayLimits({...profile, reservedOwnerConnections})).toThrow("Invalid live gateway limits");
});

it("contains stalled writes across two links in one workspace while another workspace stays open", async () => {
  const profile = selfHostLiveProfile(), limits = profile.gateway, budget = createLiveBufferBudget(limits.maxBufferedBytes);
  const state = await fixture({limits, bufferBudget: budget}), completions: (() => void)[] = [], browsers = [], MiB = 1024 * 1024;
  const other = state.browser(); expect(await other.status).toBe(101);
  const otherHost = state.hosts[0]!;
  const workspacePortion = limits.maxBufferedBytes * (limits.maxConnectionsPerWorkspace - limits.reservedOwnerConnections) / limits.maxConnections;
  expect(workspacePortion).toBe(80 * MiB);
  try {
    for (let index = 0; index < 21; index++) {
      state.resolve.mockResolvedValue({kind: "link", workspaceId: "stalled-workspace", shareId: index < 10 ? "first-share" : "second-share",
        grantId: index < 10 ? "first-link" : "second-link", principalId: "person-" + index, sessionId: "session-" + index});
      const browser = state.browser(); expect(await browser.status).toBe(101);
      const route = (await state.open.mock.results.at(-1)!.value)!;
      vi.spyOn(route.socket, "send").mockImplementation((_data, _options, callback) => {
        completions.push(() => { if (typeof callback === "function") callback(); });
      });
      for (let frame = 0; frame < (index < 20 ? 32 : 1); frame++) browser.socket.send(Buffer.alloc(limits.maxFrameBytes));
      if (index < 20) {
        await vi.waitFor(() => expect(budget.usage()).toBe((index + 1) * 4 * MiB)); browsers.push(browser);
      } else {
        await vi.waitFor(() => expect(browser.socket.readyState === WebSocket.CLOSED || budget.usage() > workspacePortion).toBe(true));
        expect(budget.usage()).toBeLessThanOrEqual(workspacePortion);
        expect(await browser.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
      }
    }
    expect(budget.usage()).toBe(workspacePortion);
    expect(browsers.every(browser => browser.socket.readyState === WebSocket.OPEN)).toBe(true);
    const received = once(otherHost, "message"); other.socket.send(Buffer.from("still-live"));
    expect((await received)[0]).toEqual(Buffer.from("still-live")); expect(other.socket.readyState).toBe(WebSocket.OPEN);
  } finally {completions.forEach(complete => complete());}
  await vi.waitFor(() => expect(budget.usage()).toBe(0));
}, 60_000);
