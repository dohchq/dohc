import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { parseRedeemedLiveTicket, type RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { decodeLiveFrame, encodeLiveFrame } from "@dohc/live-session-contract/live-frame";
import { createLiveGateway, type LiveGatewayHostReceiveOptions, type LiveGatewayHostRoute, type LiveGatewayLimits, type LiveGatewayOptions } from "./liveGateway.js";
import { createNamedLiveBrowserResolver } from "../../sync-relay/src/namedLiveBrowserAuth.js";
import { createNamedLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLiveHostBindingReports } from "../../sync-relay/src/liveHostBindingReports.js";
import { fixture as ticketFixture, scope, binding, host, key, audience } from "../../sync-relay/src/liveTickets.test-helper.js";

const origin = "https://share.example.test";
const discriminator = "abcdefghijkl";
const token = "ab".repeat(32);
const limits: LiveGatewayLimits = {
  maxConnections: 8, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 4, maxConnectionsPerGrant: 5,
  maxFrameBytes: 2048, maxPendingBytes: 4096, maxPendingFrames: 4, maxFragments: 8, maxBufferedChunks: 16,
  upgradeTimeoutMs: 2000, idleTimeoutMs: 2000, drainTimeoutMs: 100,
};
const session = { userId: "alice", workspaceId: "workspace", shareId: "share", grantId: "edit" };
function ticket(): RedeemedLiveTicket {
  return parseRedeemedLiveTicket({
    ticketId: "ticket", audience: origin,
    authority: { principalKind: "named", principalId: session.userId, grantId: session.grantId, grantGeneration: 1 },
    binding: { workspaceId: session.workspaceId, mainVersionId: "main", objectId: "doc", lineageClaimId: "a".repeat(64),
      currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 7 },
    hostEpoch: 1, mintedAtMs: 1000, expiresAtMs: 31000, redeemedAtMs: 1001,
  });
}
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
  const makeRoute = async (redeemed: RedeemedLiveTicket, receive: LiveGatewayHostReceiveOptions): Promise<LiveGatewayHostRoute> => {
    expect(receive).toEqual(receiveOptions);
    expect(Object.isFrozen(receive)).toBe(true);
    const socket = new WebSocket(`ws://127.0.0.1:${hostPort}`, receive);
    sockets.push(socket);
    // once owns connection errors until open. The fixture host sends no early
    // application bytes; this does not prove a production adapter's pause timing.
    await once(socket, "open");
    socket.pause();
    return { ticket: redeemed, socket, invalidated: invalidated.signal };
  };
  const resolve = vi.fn<LiveGatewayOptions["resolveNamedSession"]>(async () => session);
  const redeem = vi.fn<LiveGatewayOptions["redeem"]>(async () => ticket());
  const open = vi.fn<LiveGatewayOptions["openHostRoute"]>((redeemed, _signal, receive) => makeRoute(redeemed, receive));
  const gateway = createLiveGateway({ publicHosts: new Set(["share.example.test"]), publicOrigin: origin,
    limits, resolveNamedSession: resolve, redeem, openHostRoute: open, ...overrides });
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
    return { socket, status, messages };
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
  return { gateway, browser, raw, resolve, redeem, open, hosts, makeRoute, receiveOptions, invalidated, completions };
}

function stalledRefusal() {
  let flush!: () => void;
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { flush = () => callback(); } });
  const ports = { resolveNamedSession: vi.fn(async () => null), redeem: vi.fn(async () => null), openHostRoute: vi.fn(async () => null) };
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
    expect(state.redeem).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
  });

  it("upgrades once, echoes only the version, and forwards real frames unchanged in both directions", async () => {
    const state = await fixture();
    const client = state.browser();
    expect(await client.status).toBe(101);
    expect(client.socket.protocol).toBe("dohc-live-v1");
    expect(state.redeem).toHaveBeenCalledTimes(1);
    expect(state.redeem.mock.calls[0]!.slice(0, 2)).toEqual([token, session]);
    expect(state.open).toHaveBeenCalledWith(ticket(), expect.any(AbortSignal), state.receiveOptions);
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

  it.each(["principal", "grant", "workspace", "audience", "anonymous"])("refuses mismatched redeemed %s before routing", async changed => {
    const wrong = ticket();
    const mutation = structuredClone(wrong) as any;
    if (changed === "principal") mutation.authority.principalId = "bob";
    if (changed === "grant") mutation.authority.grantId = "other";
    if (changed === "workspace") mutation.binding.workspaceId = "other";
    if (changed === "audience") mutation.audience = "https://other.example.test";
    if (changed === "anonymous") mutation.authority.principalKind = "link";
    const state = await fixture({ redeem: async () => mutation });
    expect(await state.browser().status).toBe(404);
    expect(state.open).not.toHaveBeenCalled();
  });

  it.each(["epoch", "binding", "authority", "fence", "invalidated", "unpaused"])("refuses and closes a %s host route before 101", async changed => {
    const state = await fixture();
    state.open.mockImplementation(async (redeemed, _signal, receive) => {
      const route = await state.makeRoute(redeemed, receive);
      if (changed === "epoch") (route.ticket as any).hostEpoch = 2;
      if (changed === "binding") (route.ticket.binding as any).objectId = "other";
      if (changed === "authority") (route.ticket.authority as any).grantGeneration = 2;
      if (changed === "fence") (route.ticket.binding as any).restoreFenceGeneration = 8;
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
    const route = await state.makeRoute(ticket(), receive);
    const closed = once(route.socket, "close");
    late.resolve(route);
    await closed;
    expect(client.messages).toEqual([]);
  });

  it("disposes a fulfilled host route when shutdown wins before delivery", async () => {
    const state = await fixture();
    const route = await state.makeRoute(ticket(), state.receiveOptions);
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
    const state = await fixture({ limits: { ...limits, maxConnections: 1, maxConnectionsPerSession: 1 } }, socket => {
      const destroy = socket.destroy.bind(socket);
      vi.spyOn(socket, "destroy").mockImplementation(error => {
        if (socket.writableEnded && !socket.writableFinished) destroyedBeforeFlush = true;
        return destroy(error);
      });
    });
    const response = await state.raw(["Host: share.example.test", `Origin: ${origin}`,
      `Sec-WebSocket-Protocol: dohc-live-v1, dohc-live-ticket.${token}`], handshake);
    await Promise.all(state.completions);
    expect(state.redeem).toHaveBeenCalledTimes(1);
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
    state.open.mockImplementation(async (redeemed, _signal, receive) => {
      const route = await state.makeRoute(redeemed, receive);
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
    const state = await fixture({ limits: { ...limits, upgradeTimeoutMs: 20 }, resolveNamedSession: async () => new Promise(() => {}) });
    expect(await state.browser().status).toBe(404);
    await Promise.all(state.completions);
    expect(state.redeem).not.toHaveBeenCalled();
  });

  it("pauses the raw socket throughout asynchronous named authentication", async () => {
    const entered = deferred<IncomingMessage>();
    const resolved = deferred<typeof session>();
    const state = await fixture({ resolveNamedSession: async request => { entered.resolve(request); return resolved.promise; } });
    const client = state.browser();
    const request = await entered.promise;
    expect(request.socket.isPaused()).toBe(true);
    expect(state.redeem).not.toHaveBeenCalled();
    resolved.resolve(session);
    expect(await client.status).toBe(101);
  });

  it("closes the acquired transport when a host returns malformed ticket metadata", async () => {
    const state = await fixture();
    let acquired!: LiveGatewayHostRoute;
    state.open.mockImplementation(async (redeemed, _signal, receive) => {
      acquired = await state.makeRoute(redeemed, receive);
      (acquired.ticket as any).hostEpoch = 0;
      return acquired;
    });
    expect(await state.browser().status).toBe(404);
    expect(acquired.socket.readyState).not.toBe(WebSocket.OPEN);
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

  it.each(["maxConnections", "maxConnectionsPerSession", "maxConnectionsPerPrincipal", "maxConnectionsPerGrant"] as const)(
    "refuses %s exhaustion before redemption or host allocation, and releases the reservation", async limit => {
      const state = await fixture({ limits: { ...limits, [limit]: 1 } });
      const first = state.browser();
      expect(await first.status).toBe(101);
      expect(await state.browser().status).toBe(404);
      expect(state.redeem).toHaveBeenCalledTimes(1);
      expect(state.open).toHaveBeenCalledTimes(1);
      const closed = once(state.hosts[0]!, "close");
      first.socket.terminate();
      await closed;
      expect(await state.browser().status).toBe(101);
    });

  it.each(["bytes", "frames"])("bounds pending %s while a destination withholds send completion", async axis => {
    const state = await fixture({ limits: { ...limits, maxPendingBytes: 10, maxPendingFrames: axis === "frames" ? 1 : 4 } });
    const client = state.browser();
    expect(await client.status).toBe(101);
    const route = (await state.open.mock.results[0]!.value)!;
    const sent = deferred<void>();
    const send = vi.spyOn(route.socket, "send").mockImplementation(() => { sent.resolve(); });
    const closed = once(client.socket, "close");
    client.socket.send(Buffer.alloc(6));
    await sent.promise;
    client.socket.send(Buffer.alloc(axis === "bytes" ? 6 : 1));
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
      resolveNamedSession: async () => null, redeem: async () => null, openHostRoute: async () => null };
    for (const name of Object.keys(limits)) for (const bad of [undefined, 0, -1, 1.5, Infinity, NaN]) {
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
    const held = { coordinate: host, invalidated: new AbortController().signal, requestBinding: async () => binding };
    const tickets = createNamedLiveTickets({ storage: stored.storage, audience, key,
      hostReports: createLiveHostBindingReports({ storage: stored.storage, connections: { current: () => held } }) });
    const minted = await tickets.mint({ objectId: binding.objectId }, scope);
    expect(minted).not.toBeNull();
    const resolveNamed = createNamedLiveBrowserResolver({ storage: stored.storage,
      resolveActor: async (request, workspaceId) => ({ workspaceId,
        userId: request.headers.get("cookie") === "account=alice" ? scope.userId : "other-account" }) });
    const redeem = vi.fn<LiveGatewayOptions["redeem"]>((value, context) => tickets.redeem(value, context));
    // Trusted fixture scope is explicit. This does not implement a public
    // discriminator-to-named-scope mapping or real account sign-in service.
    const state = await fixture({
      resolveNamedSession: (request: IncomingMessage) => resolveNamed(new Request(`${origin}/api/live`, {
        headers: { cookie: request.headers.cookie ?? "" },
      }), scope), redeem,
    });
    expect(await state.browser({ token: minted!.token, cookie: "account=bob" }).status).toBe(404);
    expect(redeem).not.toHaveBeenCalled();
    const attempts = [state.browser({ token: minted!.token }), state.browser({ token: minted!.token })];
    expect((await Promise.all(attempts.map(attempt => attempt.status))).sort()).toEqual([101, 404]);
    expect(state.open).toHaveBeenCalledTimes(1);
    expect(state.open.mock.calls[0]![0].authority).toEqual({ principalKind: "named", principalId: scope.userId,
      grantId: scope.grantId, grantGeneration: 4 });
  });
});
