import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { createLiveFrameSession, encodeLiveFrameSync, type LiveFrame, type LiveFrameBegin } from "@dohc/live-session-contract/live-frame";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { createNamedLiveBrowserTransport, type NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";

const selection = { accountId: "reader", workspaceId: "workspace", grantId: "grant", objectId: "document" };
const binding: LiveObjectBinding = { workspaceId: "workspace", mainVersionId: "main", objectId: "document",
  lineageClaimId: "lineage", currentPath: "document.md", selectorPaths: ["document.md"], restoreFenceGeneration: 0 };
const limits = (): NamedLiveBrowserLimits => ({ provider: {
  frames: { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384 },
    maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384 },
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4,
}, maxHttpResponseBytes: 4096, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10 });
type Session = ReturnType<ReturnType<typeof createNamedLiveBrowserTransport>["select"]>;
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function waitState(value: Session, check: (state: ReturnType<Session["state"]>) => boolean) {
  if (check(value.state())) return Promise.resolve();
  return new Promise<void>(resolve => { const stop = value.subscribe(state => { if (check(state)) { stop(); resolve(); } }); });
}
class Socket extends EventTarget {
  readyState: WebSocket["readyState"] = 0; bufferedAmount = 0; protocol = "dohc-live-v1"; extensions = ""; binaryType: BinaryType = "blob";
  frames: Uint8Array[] = []; onSend?: (bytes: Uint8Array) => void; closed = 0;
  listenerCount = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) { this.listenerCount++; super.addEventListener(...args); }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) { this.listenerCount--; super.removeEventListener(...args); }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1 || !(value instanceof Uint8Array)) throw new Error("Socket not writable.");
    this.frames.push(value.slice()); this.onSend?.(value);
  }
  close() { this.closed++; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}
function fixture(input = limits()) {
  const sockets: Socket[] = [], requests: { path: string; init: RequestInit }[] = [], protocols: string[][] = [], urls: string[] = [];
  let account = "reader", sessionCount = 0, ticketCount = 0;
  let intercept: ((path: string, init: RequestInit) => Promise<Response> | Response | undefined) | undefined;
  const watchers = new Set<() => void>();
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; requests.push({ path, init: init! });
    const reply = intercept?.(path, init!);
    if (reply) return reply;
    if (path === "/api/account/session") return Response.json({ user: { id: account, name: "Reader" } });
    if (path === "/api/live/named-session") return Response.json({ discriminator: (++sessionCount).toString().padStart(12, "0"), expiresAtMs: Date.now() + 10_000 });
    if (path === "/api/live/named-ticket") return Response.json({ token: Buffer.alloc(32, ++ticketCount).toString("hex"), expiresAtMs: Date.now() + 10_000 });
    throw new Error("Unexpected request.");
  });
  const manager = createNamedLiveBrowserTransport({ publicOrigin: "https://share.example", limits: input, fetch: fetcher,
    openSocket(url, offered) { const socket = new Socket(); sockets.push(socket); urls.push(url); protocols.push(offered); for (const watch of watchers) watch(); return socket; } });
  cleanup.push(() => manager.close());
  function socketAt(index: number) {
    if (sockets[index]) return Promise.resolve(sockets[index]!);
    return new Promise<Socket>(resolve => { const watch = () => { if (sockets[index]) { watchers.delete(watch); resolve(sockets[index]!); } }; watchers.add(watch); });
  }
  const value = manager.select(selection); cleanup.push(() => value.doc.destroy());
  return { manager, value, sockets, requests, protocols, urls, fetcher, socketAt,
    account(id: string) { account = id; }, intercept(callback: typeof intercept) { intercept = callback; } };
}
type Transfer = { begin: LiveFrameBegin; bytes: Uint8Array };
function host(socket: Socket, value: Session, epoch = 1, policy = limits().provider.frames) {
  const server = createLiveFrameSession("server", policy), transfers: Transfer[] = [], frames: LiveFrame[] = [];
  cleanup.push(() => server.close());
  const watchers = new Set<() => void>();
  let vector: Uint8Array | undefined, transferId = 1;
  function receive(bytes: Uint8Array) {
    const lease = server.receive(bytes);
    try {
      frames.push(lease.value.frame);
      const transfer = lease.value.transfer?.value;
      if (transfer) {
        transfers.push({ begin: transfer.begin, bytes: transfer.bytes.slice() });
        if (transfer.begin.purpose === "client-vector") vector = transfer.bytes.slice();
      }
    } finally { lease.value.transfer?.release(); lease.release(); }
    for (const watch of watchers) watch();
  }
  socket.frames.forEach(receive); socket.onSend = receive;
  function until(check: () => boolean) {
    if (check()) return Promise.resolve();
    return new Promise<void>(resolve => { const watch = () => { if (check()) { watchers.delete(watch); resolve(); } }; watchers.add(watch); });
  }
  function send(frame: LiveFrame) {
    const lease = server.send(frame);
    try { socket.message(lease.value.slice().buffer); } finally { lease.release(); }
  }
  const submissions = () => transfers.filter(row => row.begin.purpose === "submit-update");
  return {
    send, frames, submissions,
    async greet() {
      await until(() => frames.some(frame => frame.kind === "hello"));
      send({ kind: "welcome", hostEpoch: parseHostEpoch(epoch), receivePolicy: policy.receive });
      send({ kind: "credit", grantedBytes: policy.maxQueuedBytes, grantedFrames: policy.maxQueuedFrames });
      await until(() => vector !== undefined);
    },
    async initial(doc: Y.Doc, selected = binding, cursor = 0) {
      const bytes = encodeLiveFrameSync({ binding: selected, hostVector: Y.encodeStateVector(doc), missingStateUpdate: Y.encodeStateAsUpdate(doc, vector) }, policy.receive);
      const id = transferId++;
      send({ kind: "begin", purpose: "initial-sync", transferId: id, totalBytes: bytes.length, digest: hash(bytes), appliedThroughJournalCursor: cursor });
      for (let offset = 0; offset < bytes.length; offset += 900) send({ kind: "chunk", transferId: id, offset, bytes: bytes.subarray(offset, offset + 900) });
      await waitState(value, state => ["live", "quarantined"].includes(state.status));
    },
    async submitted() { await until(() => submissions().length > 0); return submissions()[0]!; },
    ack(item: Transfer, acceptingHostEpoch = epoch) {
      if (item.begin.purpose !== "submit-update") throw new Error("Expected submission.");
      send({ kind: "result", result: "success", ack: { deliveryId: item.begin.deliveryId, updateDigest: item.begin.digest,
        journalCursor: 1, acceptingHostEpoch: parseHostEpoch(acceptingHostEpoch), localYDocSequence: 1, applicationReplayed: acceptingHostEpoch !== epoch } });
    },
  };
}
function document(text: string) {
  const doc = new Y.Doc(), paragraph = new Y.XmlElement("paragraph"), content = new Y.XmlText();
  content.insert(0, text); paragraph.insert(0, [content]); getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  cleanup.push(() => doc.destroy()); return doc;
}
function edit(value: Session, text: string) {
  return value.edit(() => { const content = (value.body.get(0) as Y.XmlElement).get(0) as Y.XmlText; content.insert(content.length, text); });
}
async function live() {
  const f = fixture(), connecting = f.value.reconnect(), socket = await f.socketAt(0), peer = host(socket, f.value), doc = document("base");
  socket.open(); await connecting; await peer.greet(); await peer.initial(doc);
  return { ...f, socket, peer, doc };
}

describe("named browser transport", () => {
  it("authenticates, bootstraps, obtains one ticket, and separates socket writes from durable ACK", async () => {
    const f = await live();
    expect(f.requests.map(row => row.path)).toEqual(["/api/account/session", "/api/live/named-session", "/api/live/named-ticket"]);
    for (const { init } of f.requests) expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(JSON.parse(f.requests[1]!.init.body as string)).toEqual({ grantId: "grant" });
    expect(JSON.parse(f.requests[2]!.init.body as string)).toEqual({ discriminator: "000000000001", objectId: "document" });
    expect(f.urls).toEqual(["wss://share.example/api/live?session=000000000001"]);
    expect(f.protocols[0]).toEqual(["dohc-live-v1", `dohc-live-ticket.${Buffer.alloc(32, 1).toString("hex")}`]);
    expect(f.socket.binaryType).toBe("arraybuffer");
    expect(edit(f.value, " draft")).toBe(true);
    const submitted = await f.peer.submitted();
    expect(f.value.state()).toMatchObject({ status: "live", pendingUpdates: 1, lastApplied: null });
    f.peer.ack(submitted); await waitState(f.value, state => state.pendingUpdates === 0);
    expect(f.value.state().lastApplied).toMatchObject({ journalCursor: 1, localYDocSequence: 1 });
  });
  it("blocks mutations before sync and after disconnect while retaining the draft for a fresh-ticket retry", async () => {
    const f = await live(); edit(f.value, " draft"); const first = await f.peer.submitted();
    Y.applyUpdate(f.doc, first.bytes); f.socket.close();
    const before = f.value.body.toString(), mutate = vi.fn();
    expect(f.value.edit(mutate)).toBe(false); expect(mutate).not.toHaveBeenCalled();
    const connecting = f.value.reconnect(), socket = await f.socketAt(1), peer = host(socket, f.value, 2);
    expect(f.value.edit(mutate)).toBe(false); socket.open(); await connecting;
    expect(f.value.edit(mutate)).toBe(false); await peer.greet(); await peer.initial(f.doc, binding, 1);
    const retry = await peer.submitted();
    expect(retry.bytes).toEqual(first.bytes); expect(retry.begin).toMatchObject(first.begin);
    expect(f.protocols[1]).not.toEqual(f.protocols[0]); expect(f.urls[1]).not.toEqual(f.urls[0]);
    expect(f.value.body.toString()).toBe(before); expect(f.value.state().pendingUpdates).toBe(1);
    peer.ack(retry, 1); await waitState(f.value, state => state.pendingUpdates === 0);
    expect(f.value.state().lastApplied?.applicationReplayed).toBe(true);
    expect(f.socket.listenerCount).toBe(0);
  });
  it.each(["account", "document"])("retires a pending HTTP attempt on %s switch, including an abort-ignoring fetch", async kind => {
    const f = fixture(), pending = deferred<Response>(), entered = deferred<void>();
    f.intercept(path => { if (path === "/api/live/named-ticket") { entered.resolve(); return pending.promise; } });
    const connecting = f.value.reconnect(); await entered.promise;
    const next = f.manager.select(kind === "account" ? { ...selection, accountId: "other" } : { ...selection, objectId: "other-document" });
    cleanup.push(() => next.doc.destroy()); await connecting;
    expect(f.requests[2]!.init.signal?.aborted).toBe(true); expect(f.value.state().status).toBe("closed");
    pending.resolve(Response.json({ token: Buffer.alloc(32, 2).toString("hex"), expiresAtMs: Date.now() + 1000 }));
    await pending.promise; await Promise.resolve();
    expect(f.sockets).toHaveLength(0); expect(next.state().status).toBe("disconnected");
  });
  it("retires the connected socket and prevents stale events from changing a replacement document", async () => {
    const f = await live(); edit(f.value, " retained"); await f.peer.submitted();
    const next = f.manager.select({ ...selection, objectId: "other-document" }); cleanup.push(() => next.doc.destroy());
    expect(f.socket.listenerCount).toBe(0); expect(f.socket.readyState).toBe(3);
    expect(f.value.state()).toMatchObject({ status: "closed", pendingUpdates: 1 });
    f.socket.message("late invalid message");
    expect(next.state()).toMatchObject({ status: "disconnected", binding: null });
    expect(next.body.length).toBe(0); expect(edit(f.value, " forbidden")).toBe(false);
    expect(f.value.body.toString()).toContain("retained");
  });
  it("refuses a different signed-in account before bootstrap", async () => {
    const f = fixture(); f.account("other"); await f.value.reconnect();
    expect(f.value.state()).toMatchObject({ status: "refused", reason: "account-changed" });
    expect(f.requests).toHaveLength(1); expect(f.sockets).toHaveLength(0);
    f.value.disconnect(); await f.value.reconnect(); expect(f.requests).toHaveLength(1);
  });
  it("retains work across a generic ticket refusal and explicitly retries the same edit with fresh authority", async () => {
    const f = await live(); edit(f.value, " draft"); const first = await f.peer.submitted(); f.socket.close();
    Y.applyUpdate(f.doc, first.bytes);
    f.intercept(path => path === "/api/live/named-ticket" ? Response.json({ ok: false }, { status: 404 }) : undefined);
    await f.value.reconnect();
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "authority-unavailable", pendingUpdates: 1, lastApplied: null });
    expect(f.value.body.toString()).toContain("draft"); expect(f.sockets).toHaveLength(1);
    expect(edit(f.value, " blocked")).toBe(false); f.intercept(undefined);
    const connecting = f.value.reconnect(), socket = await f.socketAt(1), peer = host(socket, f.value, 2);
    socket.open(); await connecting; await peer.greet(); await peer.initial(f.doc, binding, 1);
    const retry = await peer.submitted(); expect(retry.bytes).toEqual(first.bytes); expect(retry.begin).toMatchObject(first.begin);
    peer.ack(retry, 1); await waitState(f.value, state => state.pendingUpdates === 0);
    expect(f.requests).toHaveLength(9); expect(peer.submissions()).toHaveLength(1);
    expect(f.value.body.toString()).toBe(getDohcYDocBodyFragment(f.doc).toString());
  });
  it("quarantines pending work if a reconnect observes a different account", async () => {
    const f = await live(); edit(f.value, " draft"); await f.peer.submitted(); f.socket.close(); f.account("other");
    await f.value.reconnect();
    expect(f.value.state()).toMatchObject({ status: "quarantined", reason: "account-changed", pendingUpdates: 1 });
    expect(f.requests).toHaveLength(4); expect(f.sockets).toHaveLength(1);
  });
  it.each(["workspaceId", "objectId"] as const)("refuses a wrong initial %s before applying its content", async field => {
    const f = fixture(), connecting = f.value.reconnect(), socket = await f.socketAt(0), peer = host(socket, f.value);
    socket.open(); await connecting; await peer.greet(); await peer.initial(document("WRONG CONTENT"), { ...binding, [field]: "wrong" });
    expect(f.value.state()).toMatchObject({ status: "quarantined", reason: "binding-changed" });
    expect(f.value.body.length).toBe(0); expect(socket.listenerCount).toBe(0);
  });
  it("keeps stale draft content separate when reconnect finds a restore fence", async () => {
    const f = await live(); edit(f.value, " draft"); await f.peer.submitted(); f.socket.close();
    const connecting = f.value.reconnect(), socket = await f.socketAt(1), peer = host(socket, f.value, 2);
    socket.open(); await connecting; await peer.greet(); await peer.initial(document("RESTORED"), { ...binding, restoreFenceGeneration: 1 });
    expect(f.value.state()).toMatchObject({ status: "quarantined", reason: "binding-changed", pendingUpdates: 1 });
    expect(f.value.body.toString()).toContain("draft"); expect(f.value.body.toString()).not.toContain("RESTORED");
    expect(peer.submissions()).toHaveLength(0);
  });
  it("cancels a connecting socket without accepting a late open", async () => {
    const f = fixture(), connecting = f.value.reconnect(), socket = await f.socketAt(0);
    f.value.disconnect(); await connecting; socket.open();
    expect(socket.listenerCount).toBe(0); expect(socket.frames).toHaveLength(0);
    expect(f.value.state().status).toBe("disconnected");
  });
  it("rejects text frames and unnegotiated socket protocols", async () => {
    const f = fixture(), connecting = f.value.reconnect(), socket = await f.socketAt(0);
    socket.protocol = ""; socket.open(); await connecting;
    expect(f.value.state()).toMatchObject({ status: "quarantined", reason: "invalid-socket-protocol" });
    expect(socket.frames).toHaveLength(0);
    const second = fixture(), starting = second.value.reconnect(), next = await second.socketAt(0);
    next.open(); await starting; next.message("unbounded text");
    expect(second.value.state()).toMatchObject({ status: "quarantined", reason: "invalid-socket-message" });
  });
  it("bounds an HTTP response before JSON parsing and closes a timed-out attempt", async () => {
    const f = fixture(); let cancelled = false;
    f.intercept(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } }),
      { headers: { "content-type": "application/json" } }));
    await f.value.reconnect(); expect(cancelled).toBe(true); expect(f.sockets).toHaveLength(0);
    vi.useFakeTimers();
    const g = fixture(), entered = deferred<void>();
    g.intercept(() => { entered.resolve(); return new Promise<Response>(() => {}); });
    const connecting = g.value.reconnect(); await entered.promise; await vi.advanceTimersByTimeAsync(2000); await connecting;
    expect(g.value.state()).toMatchObject({ status: "disconnected", reason: "connect-timeout" });
    expect(g.requests[0]!.init.signal?.aborted).toBe(true);
  });
  it("waits within the browser socket byte budget and retires a blocked send on cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture(), connecting = f.value.reconnect(), socket = await f.socketAt(0);
    socket.bufferedAmount = limits().maxSocketBufferedBytes; socket.open(); await connecting;
    expect(socket.frames).toHaveLength(0);
    socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(10);
    expect(socket.frames.length).toBeGreaterThan(0);
    f.value.disconnect();
    const reconnecting = f.value.reconnect(), next = await f.socketAt(1);
    next.bufferedAmount = limits().maxSocketBufferedBytes; next.open(); await reconnecting;
    f.value.disconnect(); await vi.runOnlyPendingTimersAsync();
    expect(next.frames).toHaveLength(0); expect(next.listenerCount).toBe(0);
    expect(f.value.state().status).toBe("disconnected");
    const retrying = f.value.reconnect(), third = await f.socketAt(2);
    third.open(); await retrying;
    expect(f.value.state().status).toBe("connecting"); expect(third.frames.length).toBeGreaterThan(0);
  });
  it("closes a socket when its write buffer does not drain within the injected deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(), connecting = f.value.reconnect(), socket = await f.socketAt(0);
    socket.bufferedAmount = limits().maxSocketBufferedBytes; socket.open(); await connecting;
    await vi.advanceTimersByTimeAsync(limits().sendTimeoutMs);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "send-timeout" });
    expect(socket.readyState).toBe(3); expect(socket.frames).toHaveLength(0); expect(socket.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
