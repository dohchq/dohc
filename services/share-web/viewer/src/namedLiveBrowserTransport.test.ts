import {
  LIVE_CONNECTION_LIMIT_CLOSE_CODE,
  LIVE_CONNECTION_LIMIT_MESSAGES,
} from "@dohc/live-session-contract/live-connection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import {
  createLiveFrameSession,
  encodeLiveFrameSync,
  type LiveFrame,
  type LiveFrameBegin,
} from "@dohc/live-session-contract/live-frame";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import {
  createNamedLiveBrowserTransport,
  LiveHostUnavailableError,
  type NamedLiveBrowserLimits,
  type NamedLiveSelection,
} from "@dohc/ydoc-projection/named-live-browser-transport";

const selection = {
  accountId: "reader",
  workspaceId: "named:grant",
  grantId: "grant",
  objectId: "document",
};
const binding: LiveObjectBinding = {
  workspaceId: "named:grant",
  mainVersionId: "main",
  objectId: "document",
  lineageClaimId: "lineage",
  currentPath: "document.md",
  selectorPaths: ["document.md"],
  restoreFenceGeneration: 0,
};
const limits = (): NamedLiveBrowserLimits => ({
  provider: {
    frames: {
      receive: {
        maxFrameBytes: 1024,
        maxStateVectorBytes: 4096,
        maxUpdateBytes: 8192,
        maxSyncBytes: 16384,
      },
      maxQueuedBytes: 16384,
      maxQueuedFrames: 64,
      maxControlBytes: 4096,
      maxControlFrames: 8,
      maxAssemblyBytes: 16384,
    },
    maxPendingUpdateBytes: 16384,
    maxPendingUpdates: 8,
    maxDeliveryAttempts: 4,
  },
  maxHttpResponseBytes: 4096,
  maxSocketBufferedBytes: 16384,
  connectTimeoutMs: 2000,
  sendTimeoutMs: 500,
  drainPollMs: 10,
});
type Session = ReturnType<ReturnType<typeof createNamedLiveBrowserTransport>["select"]>;
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function waitState(value: Session, check: (state: ReturnType<Session["state"]>) => boolean) {
  if (check(value.state())) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = value.subscribe((state) => {
      if (check(state)) {
        stop();
        resolve();
      }
    });
  });
}
class Socket extends EventTarget {
  readyState: WebSocket["readyState"] = 0;
  bufferedAmount = 0;
  protocol = "dohc-live-v1";
  extensions = "";
  binaryType: BinaryType = "blob";
  frames: Uint8Array[] = [];
  onSend?: (bytes: Uint8Array) => void;
  closed = 0;
  listenerCount = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listenerCount++;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listenerCount--;
    super.removeEventListener(...args);
  }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1 || !(value instanceof Uint8Array))
      throw new Error("Socket not writable.");
    this.frames.push(value.slice());
    this.onSend?.(value);
  }
  close() {
    this.closed++;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}
function fixture(
  input = limits(),
  authorize?: Parameters<
    typeof createNamedLiveBrowserTransport<NamedLiveSelection>
  >[0]["authorize"],
) {
  const sockets: Socket[] = [],
    requests: { path: string; init: RequestInit }[] = [],
    protocols: string[][] = [],
    urls: string[] = [];
  let account = "reader",
    sessionCount = 0,
    ticketCount = 0,
    sessionMs = 12 * 60 * 60_000;
  let intercept:
    | ((path: string, init: RequestInit) => Promise<Response> | Response | undefined)
    | undefined;
  const watchers = new Set<() => void>();
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, init: init! });
    const reply = intercept?.(path, init!);
    if (reply) return reply;
    if (path === "/api/account/session")
      return Response.json({ user: { id: account, name: "Reader" } });
    if (path === "/api/live/named-session")
      return Response.json({
        discriminator: (++sessionCount).toString().padStart(12, "0"),
        expiresAtMs: Date.now() + sessionMs,
      });
    if (path === "/api/live/named-ticket")
      return Response.json({
        token: Buffer.alloc(32, ++ticketCount).toString("hex"),
        expiresAtMs: Date.now() + 10_000,
      });
    if (path === "/api/live/named-documents")
      return Response.json({
        access: "edit",
        grantId: "grant",
        files: [{ objectId: "document", path: "document.md" }],
      });
    throw new Error("Unexpected request.");
  });
  const manager = createNamedLiveBrowserTransport<NamedLiveSelection>({
    publicOrigin: "https://share.example",
    limits: input,
    fetch: fetcher,
    ...(authorize ? { authorize } : {}),
    openSocket(url, offered) {
      const socket = new Socket();
      sockets.push(socket);
      urls.push(url);
      protocols.push(offered);
      for (const watch of watchers) watch();
      return socket;
    },
  });
  cleanup.push(() => manager.close());
  function socketAt(index: number) {
    if (sockets[index]) return Promise.resolve(sockets[index]!);
    return new Promise<Socket>((resolve) => {
      const watch = () => {
        if (sockets[index]) {
          watchers.delete(watch);
          resolve(sockets[index]!);
        }
      };
      watchers.add(watch);
    });
  }
  const value = manager.select(selection);
  cleanup.push(() => value.doc.destroy());
  return {
    manager,
    value,
    sockets,
    requests,
    protocols,
    urls,
    fetcher,
    socketAt,
    account(id: string) {
      account = id;
    },
    /** How many sessions the page has received. */
    issued: () => sessionCount,
    sessionLifetime(ms: number) {
      sessionMs = ms;
    },
    intercept(callback: typeof intercept) {
      intercept = callback;
    },
  };
}
type Transfer = { begin: LiveFrameBegin; bytes: Uint8Array };
function host(socket: Socket, value: Session, epoch = 1, policy = limits().provider.frames) {
  const server = createLiveFrameSession("server", policy),
    transfers: Transfer[] = [],
    frames: LiveFrame[] = [];
  cleanup.push(() => server.close());
  const watchers = new Set<() => void>();
  let vector: Uint8Array | undefined,
    transferId = 1;
  function receive(bytes: Uint8Array) {
    const lease = server.receive(bytes);
    try {
      frames.push(lease.value.frame);
      const transfer = lease.value.transfer?.value;
      if (transfer) {
        transfers.push({ begin: transfer.begin, bytes: transfer.bytes.slice() });
        if (transfer.begin.purpose === "client-vector") vector = transfer.bytes.slice();
      }
    } finally {
      lease.value.transfer?.release();
      lease.release();
    }
    for (const watch of watchers) watch();
  }
  socket.frames.forEach(receive);
  socket.onSend = receive;
  function until(check: () => boolean) {
    if (check()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const watch = () => {
        if (check()) {
          watchers.delete(watch);
          resolve();
        }
      };
      watchers.add(watch);
    });
  }
  function send(frame: LiveFrame) {
    const lease = server.send(frame);
    try {
      socket.message(lease.value.slice().buffer);
    } finally {
      lease.release();
    }
  }
  const submissions = () => transfers.filter((row) => row.begin.purpose === "submit-update");
  return {
    send,
    frames,
    submissions,
    async greet() {
      await until(() => frames.some((frame) => frame.kind === "hello"));
      send({ kind: "welcome", hostEpoch: parseHostEpoch(epoch), receivePolicy: policy.receive });
      send({
        kind: "credit",
        grantedBytes: policy.maxQueuedBytes,
        grantedFrames: policy.maxQueuedFrames,
      });
      await until(() => vector !== undefined);
    },
    async initial(doc: Y.Doc, selected = binding, cursor = 0) {
      const bytes = encodeLiveFrameSync(
        {
          binding: selected,
          hostVector: Y.encodeStateVector(doc),
          missingStateUpdate: Y.encodeStateAsUpdate(doc, vector),
        },
        policy.receive,
      );
      const id = transferId++;
      send({
        kind: "begin",
        purpose: "initial-sync",
        transferId: id,
        totalBytes: bytes.length,
        digest: hash(bytes),
        appliedThroughJournalCursor: cursor,
      });
      for (let offset = 0; offset < bytes.length; offset += 900)
        send({
          kind: "chunk",
          transferId: id,
          offset,
          bytes: bytes.subarray(offset, offset + 900),
        });
      await waitState(value, (state) => ["live", "quarantined"].includes(state.status));
    },
    async submitted(count = 1) {
      await until(() => submissions().length >= count);
      return submissions()[count - 1]!;
    },
    ack(item: Transfer, acceptingHostEpoch = epoch) {
      if (item.begin.purpose !== "submit-update") throw new Error("Expected submission.");
      send({
        kind: "result",
        result: "success",
        ack: {
          deliveryId: item.begin.deliveryId,
          updateDigest: item.begin.digest,
          journalCursor: 1,
          acceptingHostEpoch: parseHostEpoch(acceptingHostEpoch),
          localYDocSequence: 1,
          applicationReplayed: acceptingHostEpoch !== epoch,
        },
      });
    },
  };
}
function document(text: string) {
  const doc = new Y.Doc(),
    paragraph = new Y.XmlElement("paragraph"),
    content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  cleanup.push(() => doc.destroy());
  return doc;
}
function edit(value: Session, text: string) {
  return value.edit(() => {
    const content = (value.body.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    content.insert(content.length, text);
  });
}
async function live(authorize?: Parameters<typeof fixture>[1]) {
  const f = fixture(limits(), authorize),
    connecting = f.value.reconnect(),
    socket = await f.socketAt(0),
    peer = host(socket, f.value),
    doc = document("base");
  socket.open();
  await connecting;
  await peer.greet();
  await peer.initial(doc);
  return { ...f, socket, peer, doc };
}

describe("named browser transport", () => {
  it("authenticates, bootstraps, obtains one ticket, and separates socket writes from durable ACK", async () => {
    const f = await live();
    expect(f.requests.map((row) => row.path)).toEqual([
      "/api/account/session",
      "/api/live/named-session",
      "/api/live/named-ticket",
    ]);
    for (const { init } of f.requests)
      expect(init).toMatchObject({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
    expect(JSON.parse(f.requests[1]!.init.body as string)).toEqual({ grantId: "grant" });
    expect(JSON.parse(f.requests[2]!.init.body as string)).toEqual({
      discriminator: "000000000001",
      objectId: "document",
    });
    expect(f.urls).toEqual(["wss://share.example/api/live?session=000000000001"]);
    expect(f.protocols[0]).toEqual([
      "dohc-live-v1",
      `dohc-live-ticket.${Buffer.alloc(32, 1).toString("hex")}`,
    ]);
    expect(f.socket.binaryType).toBe("arraybuffer");
    expect(edit(f.value, " draft")).toBe(true);
    const submitted = await f.peer.submitted();
    expect(f.value.state()).toMatchObject({ status: "live", pendingUpdates: 1, lastApplied: null });
    f.peer.ack(submitted);
    await waitState(f.value, (state) => state.pendingUpdates === 0);
    expect(f.value.state().lastApplied).toMatchObject({ journalCursor: 1, localYDocSequence: 1 });
  });
  it("blocks mutations before sync and after disconnect while retaining the draft for a fresh-ticket retry", async () => {
    const f = await live();
    edit(f.value, " draft");
    const first = await f.peer.submitted();
    Y.applyUpdate(f.doc, first.bytes);
    f.socket.close();
    const before = f.value.body.toString(),
      mutate = vi.fn();
    expect(f.value.edit(mutate)).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value, 2);
    expect(f.value.edit(mutate)).toBe(false);
    socket.open();
    await connecting;
    expect(f.value.edit(mutate)).toBe(false);
    await peer.greet();
    await peer.initial(f.doc, binding, 1);
    const retry = await peer.submitted();
    expect(retry.bytes).toEqual(first.bytes);
    expect(retry.begin).toMatchObject(first.begin);
    expect(f.protocols[1]).not.toEqual(f.protocols[0]);
    expect(f.urls[1]).not.toEqual(f.urls[0]);
    expect(f.value.body.toString()).toBe(before);
    expect(f.value.state().pendingUpdates).toBe(1);
    peer.ack(retry, 1);
    await waitState(f.value, (state) => state.pendingUpdates === 0);
    expect(f.value.state().lastApplied?.applicationReplayed).toBe(true);
    expect(f.socket.listenerCount).toBe(0);
  });
  it.each(["account", "document"])(
    "retires a pending HTTP attempt on %s switch, including an abort-ignoring fetch",
    async (kind) => {
      const f = fixture(),
        pending = deferred<Response>(),
        entered = deferred<void>();
      f.intercept((path) => {
        if (path === "/api/live/named-ticket") {
          entered.resolve();
          return pending.promise;
        }
      });
      const connecting = f.value.reconnect();
      await entered.promise;
      const next = f.manager.select(
        kind === "account"
          ? { ...selection, accountId: "other" }
          : { ...selection, objectId: "other-document" },
      );
      cleanup.push(() => next.doc.destroy());
      await connecting;
      expect(f.requests[2]!.init.signal?.aborted).toBe(true);
      expect(f.value.state().status).toBe("closed");
      pending.resolve(
        Response.json({
          token: Buffer.alloc(32, 2).toString("hex"),
          expiresAtMs: Date.now() + 1000,
        }),
      );
      await pending.promise;
      await Promise.resolve();
      expect(f.sockets).toHaveLength(0);
      expect(next.state().status).toBe("disconnected");
    },
  );
  it("retires the connected socket and prevents stale events from changing a replacement document", async () => {
    const f = await live();
    edit(f.value, " retained");
    await f.peer.submitted();
    const next = f.manager.select({ ...selection, objectId: "other-document" });
    cleanup.push(() => next.doc.destroy());
    expect(f.socket.listenerCount).toBe(0);
    expect(f.socket.readyState).toBe(3);
    expect(f.value.state()).toMatchObject({ status: "closed", pendingUpdates: 1 });
    f.socket.message("late invalid message");
    expect(next.state()).toMatchObject({ status: "disconnected", binding: null });
    expect(next.body.length).toBe(0);
    expect(edit(f.value, " forbidden")).toBe(false);
    expect(f.value.body.toString()).toContain("retained");
  });
  it("refuses a different signed-in account before bootstrap", async () => {
    const f = fixture();
    f.account("other");
    await f.value.reconnect();
    expect(f.value.state()).toMatchObject({ status: "refused", reason: "account-changed" });
    expect(f.requests).toHaveLength(1);
    expect(f.sockets).toHaveLength(0);
    f.value.disconnect();
    await f.value.reconnect();
    expect(f.requests).toHaveLength(1);
  });
  it("retains work across a generic ticket refusal and explicitly retries the same edit with fresh authority", async () => {
    const f = await live();
    edit(f.value, " draft");
    const first = await f.peer.submitted();
    f.socket.close();
    Y.applyUpdate(f.doc, first.bytes);
    f.intercept((path) =>
      path === "/api/live/named-ticket"
        ? Response.json({ ok: false }, { status: 404 })
        : path === "/api/live/named-documents"
          ? Response.json({ access: "edit", grantId: "grant", files: [] })
          : undefined,
    );
    await f.value.reconnect();
    expect(f.value.state()).toMatchObject({
      status: "disconnected",
      reason: "authority-unavailable",
      pendingUpdates: 1,
      lastApplied: null,
    });
    expect(f.value.body.toString()).toContain("draft");
    expect(f.sockets).toHaveLength(1);
    expect(edit(f.value, " blocked")).toBe(false);
    f.intercept(undefined);
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value, 2);
    socket.open();
    await connecting;
    await peer.greet();
    await peer.initial(f.doc, binding, 1);
    const retry = await peer.submitted();
    expect(retry.bytes).toEqual(first.bytes);
    expect(retry.begin).toMatchObject(first.begin);
    peer.ack(retry, 1);
    await waitState(f.value, (state) => state.pendingUpdates === 0);
    expect(f.requests).toHaveLength(10);
    expect(peer.submissions()).toHaveLength(1);
    expect(f.value.body.toString()).toBe(getDohcYDocBodyFragment(f.doc).toString());
  });
  it("quarantines pending work if a reconnect observes a different account", async () => {
    const f = await live();
    edit(f.value, " draft");
    await f.peer.submitted();
    f.socket.close();
    f.account("other");
    await f.value.reconnect();
    expect(f.value.state()).toMatchObject({
      status: "quarantined",
      reason: "account-changed",
      pendingUpdates: 1,
    });
    expect(f.requests).toHaveLength(4);
    expect(f.sockets).toHaveLength(1);
  });
  it.each(["workspaceId", "objectId"] as const)(
    "refuses a wrong initial %s before applying its content",
    async (field) => {
      const f = fixture(),
        connecting = f.value.reconnect(),
        socket = await f.socketAt(0),
        peer = host(socket, f.value);
      socket.open();
      await connecting;
      await peer.greet();
      await peer.initial(document("WRONG CONTENT"), { ...binding, [field]: "wrong" });
      expect(f.value.state()).toMatchObject({ status: "quarantined", reason: "binding-changed" });
      expect(f.value.body.length).toBe(0);
      expect(socket.listenerCount).toBe(0);
    },
  );
  it("keeps stale draft content separate when reconnect finds a restore fence", async () => {
    const f = await live();
    edit(f.value, " draft");
    await f.peer.submitted();
    f.socket.close();
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value, 2);
    socket.open();
    await connecting;
    await peer.greet();
    await peer.initial(document("RESTORED"), { ...binding, restoreFenceGeneration: 1 });
    expect(f.value.state()).toMatchObject({
      status: "quarantined",
      reason: "binding-changed",
      pendingUpdates: 1,
    });
    expect(f.value.body.toString()).toContain("draft");
    expect(f.value.body.toString()).not.toContain("RESTORED");
    expect(peer.submissions()).toHaveLength(0);
  });
  it("cancels a connecting socket without accepting a late open", async () => {
    const f = fixture(),
      connecting = f.value.reconnect(),
      socket = await f.socketAt(0);
    f.value.disconnect();
    await connecting;
    socket.open();
    expect(socket.listenerCount).toBe(0);
    expect(socket.frames).toHaveLength(0);
    expect(f.value.state().status).toBe("disconnected");
  });
  it("rejects text frames and unnegotiated socket protocols", async () => {
    const f = fixture(),
      connecting = f.value.reconnect(),
      socket = await f.socketAt(0);
    socket.protocol = "";
    socket.open();
    await connecting;
    expect(f.value.state()).toMatchObject({
      status: "quarantined",
      reason: "invalid-socket-protocol",
    });
    expect(socket.frames).toHaveLength(0);
    const second = fixture(),
      starting = second.value.reconnect(),
      next = await second.socketAt(0);
    next.open();
    await starting;
    next.message("unbounded text");
    expect(second.value.state()).toMatchObject({
      status: "quarantined",
      reason: "invalid-socket-message",
    });
  });
  it("bounds an HTTP response before JSON parsing and closes a timed-out attempt", async () => {
    const f = fixture();
    let cancelled = false;
    f.intercept(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4097));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    await f.value.reconnect();
    expect(cancelled).toBe(true);
    expect(f.sockets).toHaveLength(0);
    vi.useFakeTimers();
    const g = fixture(),
      entered = deferred<void>();
    g.intercept(() => {
      entered.resolve();
      return new Promise<Response>(() => {});
    });
    const connecting = g.value.reconnect();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(2000);
    await connecting;
    expect(g.value.state()).toMatchObject({ status: "disconnected", reason: "connect-timeout" });
    expect(g.requests[0]!.init.signal?.aborted).toBe(true);
  });
  it("waits within the browser socket byte budget and retires a blocked send on cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      connecting = f.value.reconnect(),
      socket = await f.socketAt(0);
    socket.bufferedAmount = limits().maxSocketBufferedBytes;
    socket.open();
    await connecting;
    expect(socket.frames).toHaveLength(0);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);
    expect(socket.frames.length).toBeGreaterThan(0);
    f.value.disconnect();
    const reconnecting = f.value.reconnect(),
      next = await f.socketAt(1);
    next.bufferedAmount = limits().maxSocketBufferedBytes;
    next.open();
    await reconnecting;
    f.value.disconnect();
    await vi.runOnlyPendingTimersAsync();
    expect(next.frames).toHaveLength(0);
    expect(next.listenerCount).toBe(0);
    expect(f.value.state().status).toBe("disconnected");
    const retrying = f.value.reconnect(),
      third = await f.socketAt(2);
    third.open();
    await retrying;
    expect(f.value.state().status).toBe("connecting");
    expect(third.frames.length).toBeGreaterThan(0);
  });
  it("closes a socket when its write buffer does not drain within the injected deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      connecting = f.value.reconnect(),
      socket = await f.socketAt(0);
    socket.bufferedAmount = limits().maxSocketBufferedBytes;
    socket.open();
    await connecting;
    await vi.advanceTimersByTimeAsync(limits().sendTimeoutMs);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "send-timeout" });
    expect(socket.readyState).toBe(3);
    expect(socket.frames).toHaveLength(0);
    expect(socket.listenerCount).toBe(0);
    f.value.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each(Object.keys(LIVE_CONNECTION_LIMIT_MESSAGES))(
  "retains %s from a refused socket before initial sync",
  async (reason) => {
    const f = fixture(),
      connecting = f.value.reconnect(),
      socket = await f.socketAt(0);
    socket.open();
    await connecting;
    const event = new Event("close");
    Object.assign(event, { code: LIVE_CONNECTION_LIMIT_CLOSE_CODE, reason });
    socket.dispatchEvent(event);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason });
    expect(socket.listenerCount).toBe(0);
  },
);

it("keeps retryable admission editable and resubmits the same update on its socket", async () => {
  const f = await live();
  vi.useFakeTimers();
  edit(f.value, " draft");
  const first = await f.peer.submitted();
  if (first.begin.purpose !== "submit-update") throw new Error("Expected submit");
  f.peer.send({
    kind: "result",
    result: "retry",
    deliveryId: first.begin.deliveryId,
    updateDigest: first.begin.digest,
    reason: "admission-unavailable",
  });
  await waitState(f.value, (state) => state.reason === "admission-unavailable");
  expect(edit(f.value, " more")).toBe(true);
  expect(f.sockets).toHaveLength(1);
  expect(f.socket.closed).toBe(0);
  await vi.advanceTimersByTimeAsync(250);
  const retry = await f.peer.submitted(2);
  expect(retry.bytes).toEqual(first.bytes);
  expect(retry.begin).toMatchObject({
    deliveryId: first.begin.deliveryId,
    digest: first.begin.digest,
  });
  f.peer.ack(retry);
  await f.peer.submitted(3);
  expect(f.value.state().status).toBe("live");
});
it("reconnects automatically with a fresh ticket and preserves the pending delivery", async () => {
  const f = await live();
  vi.useFakeTimers();
  edit(f.value, " draft");
  const first = await f.peer.submitted();
  Y.applyUpdate(f.doc, first.bytes);
  f.socket.close();
  expect(f.value.state().status).toBe("disconnected");
  await vi.advanceTimersByTimeAsync(249);
  expect(f.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  const socket = await f.socketAt(1),
    peer = host(socket, f.value, 2);
  socket.open();
  await peer.greet();
  await peer.initial(f.doc, binding, 1);
  const retry = await peer.submitted();
  expect(retry.bytes).toEqual(first.bytes);
  expect(retry.begin).toMatchObject(first.begin);
  expect(f.protocols[1]).not.toEqual(f.protocols[0]);
  peer.ack(retry, 1);
  await waitState(f.value, (state) => state.pendingUpdates === 0);
  expect(f.value.state().status).toBe("live");
});
// A link page's ticket answers 503 while the servers restart. The editor comes back by itself.
it("brings a live editor back by itself after the server could not open the file for a while", async () => {
  let busy = false,
    tickets = 0;
  const f = await live(async () => {
    if (busy) throw new LiveHostUnavailableError("busy");
    return {
      discriminator: "abcdefghijkl",
      ticketToken: Buffer.alloc(32, ++tickets).toString("hex"),
      websocketUrl: "wss://share.example/api/live/link?session=abcdefghijkl",
    };
  });
  vi.useFakeTimers();
  edit(f.value, " draft");
  const first = await f.peer.submitted();
  Y.applyUpdate(f.doc, first.bytes);
  busy = true;
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
  expect(f.sockets).toHaveLength(1);
  busy = false;
  await vi.advanceTimersByTimeAsync(500);
  const socket = await f.socketAt(1),
    peer = host(socket, f.value, 2);
  socket.open();
  await peer.greet();
  await peer.initial(f.doc, binding, 1);
  const retry = await peer.submitted();
  expect(retry.bytes).toEqual(first.bytes);
  peer.ack(retry, 1);
  await waitState(f.value, (state) => state.pendingUpdates === 0);
  expect(f.value.state().status).toBe("live");
  expect(edit(f.value, " more")).toBe(true);
});
// A busy live host answers the ticket, then holds the socket until it has woken the file.
it("reads a ticketed socket that never opens as the server's, and one that opened as the connection's", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    connecting = f.value.reconnect(),
    first = await f.socketAt(0);
  await vi.advanceTimersByTimeAsync(2000);
  await connecting;
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
  expect(first.closed).toBe(1);
  await vi.advanceTimersByTimeAsync(250);
  const socket = await f.socketAt(1),
    peer = host(socket, f.value);
  socket.open();
  await peer.greet();
  await peer.initial(document("base"));
  expect(f.value.state().status).toBe("live");
  // Once the socket opens, a welcome that never comes can be the reader's connection again.
  const g = fixture(),
    opening = g.value.reconnect(),
    opened = await g.socketAt(0);
  opened.open();
  await opening;
  await vi.advanceTimersByTimeAsync(2000);
  expect(g.value.state()).toMatchObject({ status: "disconnected", reason: "connect-timeout" });
});
it("backs off repeated connection failures and cancels recovery when paused or replaced", async () => {
  const f = await live();
  vi.useFakeTimers();
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  const socket = await f.socketAt(1);
  socket.close();
  await vi.advanceTimersByTimeAsync(499);
  expect(f.sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  await f.socketAt(2);
  f.value.disconnect();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sockets).toHaveLength(3);
  const pending = f.value.reconnect();
  const next = await f.socketAt(3);
  next.close();
  await pending;
  f.manager.select({ ...selection, objectId: "another-document" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sockets).toHaveLength(4);
});
it("stops editing and automatic recovery after terminal admission refusal", async () => {
  const f = await live();
  vi.useFakeTimers();
  edit(f.value, " draft");
  const item = await f.peer.submitted();
  if (item.begin.purpose !== "submit-update") throw new Error("Expected submit");
  f.peer.send({
    kind: "result",
    result: "refused",
    deliveryId: item.begin.deliveryId,
    updateDigest: item.begin.digest,
    reason: "authority-refused",
  });
  await waitState(f.value, (state) => state.status === "quarantined");
  expect(edit(f.value, " blocked")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sockets).toHaveLength(1);
  expect(f.socket.listenerCount).toBe(0);
});

it("pauses a live socket without leaving an automatic reconnect timer", async () => {
  const f = await live();
  vi.useFakeTimers();
  f.value.disconnect();
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "paused" });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sockets).toHaveLength(1);
});
it("caps automatic reconnect backoff at ten seconds", async () => {
  const f = await live();
  vi.useFakeTimers();
  f.socket.close();
  let index = 1;
  for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.sockets).toHaveLength(index);
    await vi.advanceTimersByTimeAsync(1);
    const socket = await f.socketAt(index++);
    socket.close();
  }
  f.value.disconnect();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not retry a refusal over twenty seconds when the page never held the file", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.intercept((path) =>
    path === "/api/live/named-ticket" || path === "/api/live/named-documents"
      ? new Response(null, { status: 404 })
      : undefined,
  );
  await f.value.reconnect();
  expect(f.value.state()).toMatchObject({
    status: "disconnected",
    reason: "authority-unavailable",
  });
  expect(f.requests).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.requests).toHaveLength(4);
  expect(f.sockets).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("reconnects a live route once without tearing down the replacement", async () => {
  const f = await live();
  vi.useFakeTimers();
  const reconnecting = f.value.reconnect();
  const socket = await f.socketAt(1),
    peer = host(socket, f.value);
  socket.open();
  await reconnecting;
  await peer.greet();
  await peer.initial(f.doc);
  expect(f.value.state().status).toBe("live");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sockets).toHaveLength(2);
  expect(f.requests).toHaveLength(6);
  expect(socket.closed).toBe(0);
  expect(f.value.state().status).toBe("live");
});

it("refuses an initial frame bound to another named grant before applying content", async () => {
  const f = fixture(),
    connecting = f.value.reconnect(),
    socket = await f.socketAt(0),
    peer = host(socket, f.value);
  socket.open();
  await connecting;
  await peer.greet();
  await peer.initial(document("OTHER GRANT CONTENT"), {
    ...binding,
    workspaceId: "named:other-grant",
  });
  expect(f.value.state()).toMatchObject({
    status: "quarantined",
    reason: "binding-changed",
    binding: null,
  });
  expect(f.value.body.length).toBe(0);
});
// A restarting or busy server answers an invited account's session and ticket requests with the
// same 404 as lost access. The page reads its invitation again to tell them apart.
it("keeps an invited editor trying while its invitation names the file, and stops once the owner removes access", async () => {
  const f = await live();
  vi.useFakeTimers();
  edit(f.value, " draft");
  const first = await f.peer.submitted();
  Y.applyUpdate(f.doc, first.bytes);
  let busy = true;
  f.intercept((path) =>
    busy && path === "/api/live/named-ticket" ? new Response(null, { status: 404 }) : undefined,
  );
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({
    status: "disconnected",
    reason: "host-unavailable",
    pendingUpdates: 1,
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.value.state()).toMatchObject({ reason: "host-unavailable" });
  expect(f.requests.filter(({ path }) => path === "/api/live/named-documents")).toHaveLength(2);
  busy = false;
  await vi.advanceTimersByTimeAsync(1_000);
  const socket = await f.socketAt(1),
    peer = host(socket, f.value, 2);
  socket.open();
  await peer.greet();
  await peer.initial(f.doc, binding, 1);
  const retry = await peer.submitted();
  expect(retry.bytes).toEqual(first.bytes);
  peer.ack(retry, 1);
  await waitState(f.value, (state) => state.pendingUpdates === 0);
  expect(f.value.state().status).toBe("live");

  f.intercept((path) =>
    path === "/api/live/named-ticket"
      ? new Response(null, { status: 404 })
      : path === "/api/live/named-documents"
        ? Response.json(
            { ok: false, code: "share_access_removed", error: "The owner removed your access." },
            { status: 404 },
          )
        : undefined,
  );
  socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "access-removed" });
  const asked = f.requests.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.requests).toHaveLength(asked);
  expect(vi.getTimerCount()).toBe(0);
});
// A page that can never open stops asking the server, even while the invitation names the file.
it.each([false, true])(
  "keeps trying through refusals for five minutes after the file was last open, then stops; invitation readable=%s",
  async (readable) => {
    const f = await live();
    vi.useFakeTimers();
    f.intercept((path) =>
      path === "/api/live/named-ticket" || (!readable && path === "/api/live/named-documents")
        ? new Response(null, { status: 404 })
        : undefined,
    );
    f.socket.close();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(f.value.state()).toMatchObject({
      status: "disconnected",
      reason: "authority-unavailable",
    });
    const asked = f.requests.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.requests).toHaveLength(asked);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("names the server, and keeps trying, when the deadline passes while the page reads its invitation", async () => {
  const f = await live();
  vi.useFakeTimers();
  f.intercept((path, init) =>
    path === "/api/live/named-ticket"
      ? new Response(null, { status: 404 })
      : path === "/api/live/named-documents"
        ? new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(new Error("Aborted."))),
          )
        : undefined,
  );
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250 + 2000);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
  f.intercept(undefined);
  await vi.advanceTimersByTimeAsync(500);
  await f.socketAt(1);
});

// A page that was open counts the new sessions it asks for over five minutes of retrying.
describe("a retrying page keeps its session", () => {
  type Fixture = Awaited<ReturnType<typeof live>>;
  async function reopen(f: Fixture, index: number) {
    const socket = await f.socketAt(index),
      peer = host(socket, f.value);
    socket.open();
    await peer.greet();
    await peer.initial(f.doc);
    expect(f.value.state().status).toBe("live");
    return socket;
  }
  const refuseTickets = (f: Fixture, refused: (discriminator: string) => boolean) =>
    f.intercept((path, init) =>
      path === "/api/live/named-ticket" &&
      refused((JSON.parse(init.body as string) as { discriminator: string }).discriminator)
        ? new Response(null, { status: 404 })
        : undefined,
    );

  it("asks for one new session while tickets are refused throughout, then stops", async () => {
    const f = await live();
    vi.useFakeTimers();
    refuseTickets(f, () => true);
    f.socket.close();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(f.value.state()).toMatchObject({
      status: "disconnected",
      reason: "authority-unavailable",
    });
    expect(f.issued() - 1).toBe(1);
  });

  it("asks for one new session when the server lost the page's session, and keeps it", async () => {
    const f = await live();
    vi.useFakeTimers();
    refuseTickets(f, (discriminator) => discriminator === "000000000001");
    f.socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await reopen(f, 1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.value.state().status).toBe("live");
    expect(f.issued() - 1).toBe(1);
  });

  it.each([
    ["at once", 0],
    ["after two minutes open", 2 * 60_000],
  ])(
    "stops when the server loses its new session again %s, and Try again opens it",
    async (_, openMs) => {
      const f = await live();
      vi.useFakeTimers();
      const lost = new Set(["000000000001"]);
      refuseTickets(f, (discriminator) => lost.has(discriminator));
      f.socket.close();
      await vi.advanceTimersByTimeAsync(1_000);
      const socket = await reopen(f, 1);
      await vi.advanceTimersByTimeAsync(openMs);
      lost.add("000000000002");
      socket.close();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
      expect(f.value.state()).toMatchObject({
        status: "disconnected",
        reason: "authority-unavailable",
      });
      expect(f.issued() - 1).toBe(1);
      const opening = f.value.reconnect();
      await reopen(f, 2);
      await opening;
      expect(f.issued() - 1).toBe(2);
    },
  );

  it("asks for one new session when the server never answers that request, then stops", async () => {
    const f = await live();
    vi.useFakeTimers();
    let asked = 0;
    f.intercept((path) => {
      if (path === "/api/live/named-session") {
        asked++;
        return new Promise<Response>(() => {});
      }
      return path === "/api/live/named-ticket" ? new Response(null, { status: 404 }) : undefined;
    });
    f.socket.close();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(f.value.state()).toMatchObject({
      status: "disconnected",
      reason: "authority-unavailable",
    });
    expect(asked).toBe(1);
  });

  it("says the owner removed access when that happens after the page has used its new session", async () => {
    const f = await live();
    vi.useFakeTimers();
    let asked = 0,
      removed = false;
    const removal = () =>
      Response.json(
        { ok: false, code: "share_access_removed", error: "The owner removed your access." },
        { status: 404 },
      );
    f.intercept((path) => {
      if (removed && path !== "/api/account/session") return removal();
      if (path === "/api/live/named-session") {
        asked++;
        return new Promise<Response>(() => {});
      }
      return path === "/api/live/named-ticket" ? new Response(null, { status: 404 }) : undefined;
    });
    f.socket.close();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(250);
      expect(asked).toBe(1);
    });
    removed = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "access-removed" });
    expect(asked).toBe(1);
  });

  // Try again can start at any point while the attempt it replaces reads the account.
  it.each(Array.from({ length: 12 }, (_, ticks) => ticks))(
    "keeps Try again's new session separate from an attempt it replaced, %i ticks in",
    async (ticks) => {
      const f = await live();
      vi.useFakeTimers();
      let release: (() => void) | undefined;
      f.intercept((path) =>
        path === "/api/account/session" && !release
          ? new Promise<Response>((resolve) => {
              release = () => resolve(Response.json({ user: { id: "reader", name: "Reader" } }));
            })
          : undefined,
      );
      const replaced = f.value.reconnect();
      await vi.waitFor(() => expect(release).toBeDefined());
      release!();
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      const opening = f.value.reconnect();
      const socket = await reopen(f, 1);
      await Promise.all([replaced, opening]);
      const opened = f.issued();
      refuseTickets(f, (discriminator) => Number(discriminator) <= opened);
      socket.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await reopen(f, 2);
      expect(f.issued() - opened).toBe(1);
    },
  );

  it("returns to editing by itself with one new session after the server was away for a minute and lost it", async () => {
    const f = await live();
    vi.useFakeTimers();
    let away = true;
    f.intercept((path, init) => {
      if (away) return Promise.reject(new TypeError("Failed to fetch"));
      return path === "/api/live/named-ticket" &&
        (JSON.parse(init.body as string) as { discriminator: string }).discriminator ===
          "000000000001"
        ? new Response(null, { status: 404 })
        : undefined;
    });
    f.socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    away = false;
    // The server answers again. The page's next try finds its session gone, and the one after
    // opens with a new session. Each try is at most 10 s after the last.
    for (let waited = 0; f.sockets.length < 2 && waited < 30_000; waited += 250)
      await vi.advanceTimersByTimeAsync(250);
    await reopen(f, 1);
    expect(f.issued() - 1).toBe(1);
  });

  it("asks for no new session while its socket opens and drops ten times", async () => {
    const f = await live();
    vi.useFakeTimers();
    let socket = f.socket;
    for (let index = 1; index <= 10; index++) {
      socket.close();
      await vi.advanceTimersByTimeAsync(250);
      socket = await reopen(f, index);
    }
    expect(f.issued() - 1).toBe(0);
  });

  it("asks for no new session while its socket keeps failing for five minutes", async () => {
    const f = await live();
    vi.useFakeTimers();
    let failed = 0;
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 1_000) {
      while (failed < f.sockets.length) f.sockets[failed++]!.close();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(f.sockets.length).toBeGreaterThan(30);
    expect(f.issued() - 1).toBe(0);
  });

  it("asks for a new session once the page's session has expired", async () => {
    const f = fixture();
    f.sessionLifetime(60_000);
    const connecting = f.value.reconnect(),
      first = await f.socketAt(0),
      peer = host(first, f.value),
      doc = document("base");
    first.open();
    await connecting;
    await peer.greet();
    await peer.initial(doc);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    first.close();
    await vi.advanceTimersByTimeAsync(250);
    await f.socketAt(1);
    expect(f.issued()).toBe(2);
  });

  // The provider can end a live route itself. The five minutes start when the file was last open.
  it("keeps trying through a refusal after the server ends a route that was quiet for a long time", async () => {
    const f = await live();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    refuseTickets(f, () => true);
    f.peer.send({ kind: "close", reason: "shutdown" });
    await vi.advanceTimersByTimeAsync(250);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
  });
});
