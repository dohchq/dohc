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
import { NAMED_LIVE_STOPPED, linkRefusalBody } from "@dohc/security-contract/link-refusal";
import { draftNeedsReview } from "./NamedDocumentEditor";
import { memberDocument } from "./memberLive";
import {
  createNamedLiveBrowserTransport,
  LiveHostUnavailableError,
  namedLiveEditable,
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
    applied(bytes: Uint8Array, cursor: number) {
      const id = transferId++;
      send({
        kind: "begin",
        purpose: "applied-update",
        transferId: id,
        totalBytes: bytes.length,
        digest: hash(bytes),
        journalCursor: cursor,
      });
      for (let offset = 0; offset < bytes.length; offset += 900)
        send({
          kind: "chunk",
          transferId: id,
          offset,
          bytes: bytes.subarray(offset, offset + 900),
        });
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
    const content = (getDohcYDocBodyFragment(value.doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
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
  it("takes typing while it reconnects by itself, and sends it after the retried draft on a fresh ticket", async () => {
    const f = await live();
    edit(f.value, " draft");
    const first = await f.peer.submitted();
    Y.applyUpdate(f.doc, first.bytes);
    f.socket.close();
    expect(f.value.state()).toMatchObject({
      status: "disconnected",
      reason: "transport-closed",
      pendingUpdates: 1,
    });
    expect(edit(f.value, " offline")).toBe(true);
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value, 2);
    expect(edit(f.value, " opening")).toBe(true);
    socket.open();
    await connecting;
    await peer.greet();
    await peer.initial(f.doc, binding, 1);
    const retry = await peer.submitted();
    expect(retry.bytes).toEqual(first.bytes);
    expect(retry.begin).toMatchObject(first.begin);
    expect(f.protocols[1]).not.toEqual(f.protocols[0]);
    expect(f.urls[1]).not.toEqual(f.urls[0]);
    expect(f.value.state().pendingUpdates).toBe(2);
    peer.ack(retry, 1);
    const later = await peer.submitted(2);
    Y.applyUpdate(f.doc, later.bytes);
    peer.ack(later);
    await waitState(f.value, (state) => state.pendingUpdates === 0);
    expect(getDohcYDocBodyFragment(f.doc).toString()).toBe(
      getDohcYDocBodyFragment(f.value.doc).toString(),
    );
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toContain("base draft offline opening");
    expect(f.socket.listenerCount).toBe(0);
  });
  it("takes typing while it reconnects after it was live, even when its first open failed", async () => {
    const f = fixture(),
      failing = f.value.reconnect();
    (await f.socketAt(0)).close();
    await failing;
    expect(f.value.state()).toMatchObject({ status: "disconnected", typingStopped: true });
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value);
    socket.open();
    await connecting;
    await peer.greet();
    await peer.initial(document("base"));
    socket.close();
    expect(f.value.state()).toMatchObject({ status: "disconnected", typingStopped: false });
    expect(edit(f.value, " offline")).toBe(true);
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toContain("base offline");
  });
  it("takes no typing once it stops reconnecting by itself, and keeps the waiting draft", async () => {
    const f = await live();
    edit(f.value, " draft");
    await f.peer.submitted();
    f.value.disconnect();
    const mutate = vi.fn();
    expect(f.value.edit(mutate)).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "paused" });
    expect(draftNeedsReview(f.value.state())).toBe(true);
    expect(f.value.unsentText()).toMatchObject({ text: " draft" });
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
    expect(getDohcYDocBodyFragment(next.doc).length).toBe(0);
    expect(edit(f.value, " forbidden")).toBe(false);
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toContain("retained");
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
      reason: "document-gone",
      pendingUpdates: 1,
      lastApplied: null,
    });
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toContain("draft");
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
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toBe(
      getDohcYDocBodyFragment(f.doc).toString(),
    );
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
      expect(getDohcYDocBodyFragment(f.value.doc).length).toBe(0);
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
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toContain("draft");
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).not.toContain("RESTORED");
    expect(peer.submissions()).toHaveLength(0);
  });
  it("reopens on a fresh document when the relay replaces the note's lineage, and the next edit lands there", async () => {
    const f = await live();
    edit(f.value, " saved");
    f.peer.ack(await f.peer.submitted());
    await waitState(f.value, (state) => state.pendingUpdates === 0);
    const replaced = f.value.doc,
      successor = document("base saved"),
      next = { ...binding, lineageClaimId: "successor" };
    f.socket.close();
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value, 2);
    socket.open();
    await connecting;
    await peer.greet();
    const replacing = peer.initial(successor, next);
    const reopened = await f.socketAt(2),
      fresh = host(reopened, f.value, 2);
    reopened.open();
    await fresh.greet();
    await fresh.initial(successor, next);
    await replacing;
    expect(f.value.state()).toMatchObject({ status: "live", binding: next, pendingUpdates: 0 });
    expect(f.value.doc).not.toBe(replaced);
    expect(getDohcYDocBodyFragment(f.value.doc).toString()).toBe(
      getDohcYDocBodyFragment(successor).toString(),
    );
    expect(edit(f.value, " more")).toBe(true);
    Y.applyUpdate(successor, (await fresh.submitted()).bytes);
    expect(getDohcYDocBodyFragment(successor).toString()).toContain("base saved more");
    expect(peer.submissions()).toHaveLength(0);
  });
  it("keeps typing the relay never confirmed for review when the note's lineage is replaced", async () => {
    const f = await live();
    edit(f.value, " unconfirmed");
    await f.peer.submitted();
    f.socket.close();
    const connecting = f.value.reconnect(),
      socket = await f.socketAt(1),
      peer = host(socket, f.value, 2);
    socket.open();
    await connecting;
    await peer.greet();
    await peer.initial(document("base"), { ...binding, lineageClaimId: "successor" });
    expect(f.value.state()).toMatchObject({
      status: "quarantined",
      reason: "lineage-replaced",
      pendingUpdates: 1,
    });
    expect(draftNeedsReview(f.value.state())).toBe(true);
    expect(f.value.unsentText()).toMatchObject({ text: " unconfirmed" });
    expect(peer.submissions()).toHaveLength(0);
    expect(f.sockets).toHaveLength(2);
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

// The desktop's editor has its own doc and applies its changes here through edit(), so its
// typing carries the editor's client, not the session's.
it("counts a desktop editor's typing as its own when someone else's change removes it", async () => {
  const { value, peer, doc } = await live();
  const removed: string[] = [];
  value.onRemovedText((text) => removed.push(text.text));
  const editor = new Y.Doc();
  cleanup.push(() => editor.destroy());
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(value.doc));
  expect(editor.clientID).not.toBe(value.doc.clientID);
  const before = Y.encodeStateVector(editor);
  const line = (getDohcYDocBodyFragment(editor).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  line.insert(line.length, " from the desktop");
  const typed = Y.encodeStateAsUpdate(editor, before);
  expect(value.edit(() => Y.applyUpdate(value.doc, typed))).toBe(true);
  peer.ack(await peer.submitted());

  // Someone who never received the typing deletes its line.
  const hostBefore = Y.encodeStateVector(doc);
  getDohcYDocBodyFragment(doc).delete(0, 1);
  peer.applied(Y.encodeStateAsUpdate(doc, hostBefore), 2);

  await vi.waitFor(() => expect(getDohcYDocBodyFragment(value.doc).length).toBe(0));
  expect(removed).toEqual([" from the desktop"]);
});

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
// A busy live host also holds the ticket until it has woken the file. Only that wait is the server's.
it("reads a ticket that never answers as the server's, and an earlier request that never answers as the connection's", async () => {
  vi.useFakeTimers();
  const stalled = (path: string) => {
    const f = fixture();
    f.intercept((requested) => (requested === path ? new Promise<Response>(() => {}) : undefined));
    return f;
  };
  const ticket = stalled("/api/live/named-ticket"),
    connecting = ticket.value.reconnect();
  await vi.advanceTimersByTimeAsync(2000);
  await connecting;
  expect(ticket.value.state()).toMatchObject({
    status: "disconnected",
    reason: "host-unavailable",
  });
  const tickets = () => ticket.requests.filter(({ path }) => path === "/api/live/named-ticket");
  expect(tickets()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(tickets()).toHaveLength(2);
  // The link page and the desktop ask for their ticket through authorize.
  const link = fixture(
      limits(),
      (_, signal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    ),
    linking = link.value.reconnect();
  await vi.advanceTimersByTimeAsync(2000);
  await linking;
  expect(link.value.state()).toMatchObject({
    status: "disconnected",
    reason: "host-unavailable",
  });
  for (const path of ["/api/account/session", "/api/live/named-session"]) {
    const f = stalled(path),
      opening = f.value.reconnect();
    await vi.advanceTimersByTimeAsync(2000);
    await opening;
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "connect-timeout" });
  }
});
it("takes edits on the host's early state while a busy server holds the ticket, and none once that attempt stops, even while the page tries again", async () => {
  vi.useFakeTimers();
  const f = fixture(
      limits(),
      (_, signal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    ),
    state = document("base");
  const connecting = f.value.reconnect();
  expect(edit(f.value, " early")).toBe(false);
  expect(
    f.value.seed(
      encodeLiveFrameSync(
        {
          binding,
          hostVector: Y.encodeStateVector(state),
          missingStateUpdate: Y.encodeStateAsUpdate(state),
        },
        limits().provider.frames.receive,
      ),
      3,
    ),
  ).toBe(true);
  expect(f.value.state()).toMatchObject({ status: "authorizing", typingAhead: true });
  expect(edit(f.value, " draft")).toBe(true);
  expect(f.value.state().pendingUpdates).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  await connecting;
  expect(f.value.state()).toMatchObject({
    status: "disconnected",
    reason: "host-unavailable",
    pendingUpdates: 1,
  });
  expect(edit(f.value, " more")).toBe(false);
  // The page tries again by itself. Until it is live, the words stay under review and no more join them.
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({ status: "authorizing", typingAhead: true });
  expect(edit(f.value, " retry")).toBe(false);
  expect(draftNeedsReview(f.value.state())).toBe(true);
  expect(f.value.state().typingStopped).toBe(true);
  expect(getDohcYDocBodyFragment(f.value.doc).toString()).toContain("base draft");
  expect(getDohcYDocBodyFragment(f.value.doc).toString()).not.toContain("retry");
});
it("takes no edits on an early state that arrives while the page tries again after an attempt stopped", async () => {
  vi.useFakeTimers();
  const f = fixture(
      limits(),
      (_, signal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    ),
    state = document("base");
  const connecting = f.value.reconnect();
  await vi.advanceTimersByTimeAsync(2000);
  await connecting;
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state().status).toBe("authorizing");
  expect(
    f.value.seed(
      encodeLiveFrameSync(
        {
          binding,
          hostVector: Y.encodeStateVector(state),
          missingStateUpdate: Y.encodeStateAsUpdate(state),
        },
        limits().provider.frames.receive,
      ),
      3,
    ),
  ).toBe(true);
  expect(f.value.state()).toMatchObject({ status: "authorizing", typingAhead: true });
  expect(edit(f.value, " late")).toBe(false);
  expect(getDohcYDocBodyFragment(f.value.doc).toString()).not.toContain("late");
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
// A server restart is over in seconds, and the page must be trying when the server is back.
it("waits at most two seconds between failed attempts for a minute after it was live, then doubles its wait up to ten seconds", async () => {
  const f = await live();
  vi.useFakeTimers();
  f.socket.close();
  let index = 1;
  // The thirtieth two-second wait ends 61.75 s after the page was live. The wait is chosen as the one before
  // it ends, so it is the first chosen after the minute.
  const waits = [250, 500, 1_000, ...Array<number>(30).fill(2_000), 4_000, 8_000, 10_000, 10_000];
  for (const delay of waits) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.sockets).toHaveLength(index);
    await vi.advanceTimersByTimeAsync(1);
    const socket = await f.socketAt(index++);
    socket.close();
  }
  f.value.disconnect();
  expect(vi.getTimerCount()).toBe(0);
});
it("doubles its wait up to ten seconds from the start when the page was never live", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    connecting = f.value.reconnect();
  (await f.socketAt(0)).close();
  await connecting;
  let index = 1;
  for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.sockets).toHaveLength(index);
    await vi.advanceTimersByTimeAsync(1);
    (await f.socketAt(index++)).close();
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
  expect(getDohcYDocBodyFragment(f.value.doc).length).toBe(0);
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
it("keeps an invited editor's page read-only while live editing is off, checks every 30 seconds while it is visible, and sends the kept edit once the file is live", async () => {
  const f = await live();
  vi.useFakeTimers();
  edit(f.value, " draft");
  const first = await f.peer.submitted();
  let stopped = true;
  f.intercept((path) =>
    stopped && path === "/api/live/named-ticket"
      ? Response.json(NAMED_LIVE_STOPPED, { status: 404 })
      : undefined,
  );
  const tickets = () => f.requests.filter(({ path }) => path === "/api/live/named-ticket").length;
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({
    status: "disconnected",
    reason: "live-stopped",
    pendingUpdates: 1,
  });
  expect(edit(f.value, " more")).toBe(false);
  const asked = tickets();
  vi.stubGlobal("document", { visibilityState: "hidden" });
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tickets()).toBe(asked);
  } finally {
    vi.unstubAllGlobals();
  }
  await vi.advanceTimersByTimeAsync(30_000);
  expect(tickets()).toBe(asked + 1);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  expect(edit(f.value, " more")).toBe(false);

  stopped = false;
  await vi.advanceTimersByTimeAsync(30_000);
  const socket = await f.socketAt(1),
    peer = host(socket, f.value, 2);
  socket.open();
  await peer.greet();
  expect(edit(f.value, " more")).toBe(false);
  await peer.initial(f.doc, binding, 1);
  const retry = await peer.submitted();
  expect(retry.bytes).toEqual(first.bytes);
});
it("keeps checking an invited editor's off page after the server forgot its session while the tab was hidden, and joins once the file is live", async () => {
  const f = await live();
  vi.useFakeTimers();
  let stopped = true,
    forgot = false;
  f.intercept((path, init) =>
    path !== "/api/live/named-ticket"
      ? undefined
      : forgot && String(init.body).includes('"000000000001"')
        ? new Response(null, { status: 404 })
        : stopped
          ? Response.json(NAMED_LIVE_STOPPED, { status: 404 })
          : undefined,
  );
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  vi.stubGlobal("document", { visibilityState: "hidden" });
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  } finally {
    vi.unstubAllGlobals();
  }
  forgot = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.issued()).toBe(2);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  stopped = false;
  await vi.advanceTimersByTimeAsync(30_000);
  const socket = await f.socketAt(1);
  expect(f.urls[1]).toContain("session=000000000002");
  socket.open();
});
it("keeps an invited editor's off page checking when reading the invitation again times out", async () => {
  const f = await live();
  vi.useFakeTimers();
  let forgot = false;
  f.intercept((path) =>
    path === "/api/live/named-documents"
      ? new Promise<Response>(() => {})
      : path !== "/api/live/named-ticket"
        ? undefined
        : forgot
          ? new Response(null, { status: 404 })
          : Response.json(NAMED_LIVE_STOPPED, { status: 404 }),
  );
  const tickets = () => f.requests.filter(({ path }) => path === "/api/live/named-ticket").length;
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  forgot = true;
  await vi.advanceTimersByTimeAsync(30_000 + limits().connectTimeoutMs);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  const asked = tickets();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(tickets()).toBe(asked + 1);
});
it.each([
  ["an opaque 404", () => new Response(null, { status: 404 })],
  ["a 503", () => new Response(null, { status: 503 })],
  [
    "a network error",
    () => {
      throw new TypeError("Failed to fetch");
    },
  ],
] as const)(
  "keeps an invited editor's off page checking when reading the invitation again gives %s",
  async (_, listing) => {
    const f = await live();
    vi.useFakeTimers();
    let forgot = false;
    f.intercept((path) =>
      path === "/api/live/named-ticket"
        ? forgot
          ? new Response(null, { status: 404 })
          : Response.json(NAMED_LIVE_STOPPED, { status: 404 })
        : forgot && path === "/api/live/named-documents"
          ? listing()
          : undefined,
    );
    const tickets = () => f.requests.filter(({ path }) => path === "/api/live/named-ticket").length;
    f.socket.close();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
    forgot = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
    const asked = tickets();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tickets()).toBe(asked + 1);
  },
);
it("keeps an invited editor's off page checking through a network failure, after the server forgot its session", async () => {
  const f = await live();
  vi.useFakeTimers();
  let ticket: "stopped" | "network" | "forgot" | "live" = "stopped";
  f.intercept((path) => {
    if (path !== "/api/live/named-ticket" || ticket === "live") return undefined;
    if (ticket === "network") {
      ticket = "forgot";
      throw new TypeError("Failed to fetch");
    }
    return ticket === "forgot"
      ? new Response(null, { status: 404 })
      : Response.json(NAMED_LIVE_STOPPED, { status: 404 });
  });
  const tickets = () => f.requests.filter(({ path }) => path === "/api/live/named-ticket").length;
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  ticket = "network";
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  await vi.advanceTimersByTimeAsync(2 * 30_000);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
  const asked = tickets();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(tickets()).toBe(asked + 1);
  ticket = "live";
  await vi.advanceTimersByTimeAsync(30_000);
  await f.socketAt(1);
});
it("waits while live editing of the file is starting, takes no typing, and joins by itself once it is live", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let starting = true;
  f.intercept((path) =>
    starting && path === "/api/live/named-ticket"
      ? Response.json(linkRefusalBody("link_live_starting"), { status: 503 })
      : undefined,
  );
  await f.value.reconnect();
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "live-starting" });
  expect(namedLiveEditable(f.value.state())).toBe(false);
  const seen: string[] = [];
  f.value.subscribe((state) => seen.push(state.status));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.value.state()).toMatchObject({ reason: "live-starting" });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain("authorizing");
  starting = false;
  while (!f.sockets.length) await vi.advanceTimersByTimeAsync(250);
  const socket = await f.socketAt(0),
    peer = host(socket, f.value);
  socket.open();
  await peer.greet();
  await peer.initial(document("base"));
  await waitState(f.value, (state) => state.status === "live");
  expect(edit(f.value, " typed")).toBe(true);
});
it("tells an invited editor whose file left the invitation that it moved or was removed, and stops asking", async () => {
  const f = await live();
  vi.useFakeTimers();
  f.intercept((path) =>
    path === "/api/live/named-ticket"
      ? new Response(null, { status: 404 })
      : path === "/api/live/named-documents"
        ? Response.json({ access: "edit", grantId: "grant", files: [] })
        : undefined,
  );
  f.socket.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "document-gone" });
  const asked = f.requests.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.requests).toHaveLength(asked);
});
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

  it("stops once the page has used its new session, even when the invitation never answers", async () => {
    const f = await live();
    vi.useFakeTimers();
    let asked = 0,
      read = 0;
    f.intercept((path) => {
      if (path === "/api/live/named-documents") {
        read++;
        return new Promise<Response>(() => {});
      }
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
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(f.value.state()).toMatchObject({
      status: "disconnected",
      reason: "authority-unavailable",
    });
    const stoppedAt = read;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).toBe(stoppedAt);
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

it("connects the owner's socket by the page its URL names, with no browser session", async () => {
  const token = "ab".repeat(32),
    page = `workspaceId=ws-1&objectId=document&lineageClaimId=${"c".repeat(64)}`;
  const f = await live(async () => ({
    ticketToken: token,
    websocketUrl: `wss://share.example/api/live/owner?${page}`,
  }));
  expect(f.urls).toEqual([`wss://share.example/api/live/owner?${page}`]);
  expect(f.protocols).toEqual([["dohc-live-v1", `dohc-live-ticket.${token}`]]);
  expect(f.requests).toEqual([]);
  // A URL that names a browser session needs the answer to give the same one.
  const stray = fixture(limits(), async () => ({
    ticketToken: token,
    websocketUrl: "wss://share.example/api/live?session=abcdefghijkl",
  }));
  await stray.value.reconnect();
  expect(stray.urls).toEqual([]);
});

it("opens the owner's page live on the binding the relay's owner socket sends, and takes an edit", async () => {
  const lineageClaimId = "c".repeat(64),
    sockets: Socket[] = [],
    urls: string[] = [];
  vi.stubGlobal("location", { origin: "https://share.example", host: "share.example" });
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor(url: string) {
        super();
        sockets.push(this);
        urls.push(url);
      }
    },
  );
  cleanup.push(() => vi.unstubAllGlobals());
  const opened = memberDocument({
    target: { workspaceId: "ws-1" },
    path: "document.md",
    accountId: "owner",
    admission: {
      kind: "owner",
      objectId: "document",
      lineageClaimId,
      token: "ab".repeat(32),
      limits: limits(),
    },
    onRefused: () => undefined,
  });
  cleanup.push(() => opened.close());
  const connecting = opened.session.reconnect();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0]!,
    peer = host(socket, opened.session);
  socket.open();
  await connecting;
  await peer.greet();
  // The owner's socket sends the page's own workspace, as it does to the owner's phone.
  await peer.initial(document("base"), { ...binding, workspaceId: "ws-1" });
  expect(urls).toEqual([
    `wss://share.example/api/live/owner?workspaceId=ws-1&objectId=document&lineageClaimId=${lineageClaimId}`,
  ]);
  expect(opened.session.state()).toMatchObject({ status: "live", reason: null });
  expect(edit(opened.session, " draft")).toBe(true);
  await peer.submitted();
});

it("stops on a socket the server closed because it turned off the note's format, and never reconnects by itself", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    connecting = f.value.reconnect(),
    socket = await f.socketAt(0);
  socket.open();
  await connecting;
  const event = new Event("close");
  Object.assign(event, { code: 1013, reason: "note_format_off" });
  socket.dispatchEvent(event);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "note-format-off" });
  expect(socket.listenerCount).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("still reconnects after a try-again close with any other reason", async () => {
  const f = fixture(),
    connecting = f.value.reconnect(),
    socket = await f.socketAt(0);
  socket.open();
  await connecting;
  const event = new Event("close");
  Object.assign(event, { code: 1013, reason: "personal_agent_unavailable" });
  socket.dispatchEvent(event);
  expect(f.value.state()).toMatchObject({ status: "disconnected", reason: "transport-closed" });
});
