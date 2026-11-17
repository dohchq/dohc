import { describe, expect, it, vi } from "vitest";
import { appTeardown, createAppRunner } from "../apps/appStore";
import { createAccount } from "../server/account";
import { createServerClient, type LiveSocket, type OpenSocket } from "../server/client";
import { memoryStore, testServer, type Answer } from "../server/testServer";
import {
  frameWindow,
  fromBase64,
  incoming,
  outgoing,
  readToPage,
  toBase64,
  type FromPage,
  type LiveFacts,
  type ToPage,
} from "./liveBridge";
import {
  createLivePages,
  createPageLive,
  holdsUnsent,
  liveMark,
  type PageLiveState,
} from "./pageLive";

const TOKEN = "account-token-secret";
const TICKET = "ticket-secret-123";
const OPEN = "POST /sync/ws-1/ops/openPage";
const limits = {
  provider: {
    frames: { maxQueuedBytes: 64, maxQueuedFrames: 2, receive: { maxFrameBytes: 64 } },
    maxPendingUpdates: 8,
  },
  maxSocketBufferedBytes: 4096,
  connectTimeoutMs: 30_000,
};
const answer = (result: unknown): Answer => ({ status: 200, body: { ok: true, result } });
const ready = answer({
  status: "ready",
  objectId: "obj-1",
  lineageClaimId: "claim-1",
  ticket: TICKET,
  expiresAtMs: 1,
  editorLimits: limits,
});
const facts = (status: LiveFacts["status"], pendingUpdates = 0, unsent = pendingUpdates > 0) => ({
  status,
  reason: null,
  pendingUpdates,
  unsent,
});

class FakeSocket implements LiveSocket {
  binaryType = "blob";
  protocol = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;
  send(data: ArrayBuffer) {
    this.sent.push(new Uint8Array(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open(protocol = "dohc-live-v1") {
    this.protocol = protocol;
    this.readyState = 1;
    this.onopen?.();
  }
  frame(...bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
}

function setup(...answers: Answer[]) {
  const server = testServer();
  server.on("POST", "/sync/ws-1/ops/openPage", ...answers);
  const sockets: { url: string; protocols: string[]; headers: object; socket: FakeSocket }[] = [];
  const openSocket: OpenSocket = (url, protocols, options) => {
    const socket = new FakeSocket();
    sockets.push({ url, protocols: [...protocols], headers: options.headers, socket });
    return socket;
  };
  const signIn = new AbortController();
  const client = createServerClient({
    origin: server.origin,
    token: TOKEN,
    fetch: server.fetch,
    signal: signIn.signal,
    openSocket,
  });
  const posted: ToPage[] = [];
  const live = createPageLive({
    client,
    workspaceId: "ws-1",
    path: "notes/plan.md",
    post: (message) => posted.push(message),
    sleep: async () => undefined,
  });
  const latest = () => sockets.at(-1)!.socket;
  // The page's side of the stream, numbered as the editor numbers it.
  const fromPage = (gen: number) => outgoing<FromPage>(gen, (message) => live.receive(message));
  return { server, sockets, latest, posted, live, fromPage, signIn };
}

async function connected(...answers: Answer[]) {
  const t = setup(...(answers.length ? answers : [ready]));
  t.live.start();
  await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
  t.latest().open();
  return t;
}

describe("the bridge", () => {
  it("numbers each open's messages, ignores an earlier open's, and breaks on a gap or a repeat", () => {
    const check = incoming(2);
    expect(check({ kind: "live", gen: 1, seq: 1 })).toBe("stale");
    expect(check({ kind: "live", gen: 2, seq: 1 })).toBe("next");
    expect(check({ kind: "live", gen: 2, seq: 1 })).toBe("broken");
    expect(incoming(2)({ kind: "live", gen: 2, seq: 2 })).toBe("broken");
    const sent: ToPage[] = [];
    const send = outgoing<ToPage>(3, (message) => sent.push(message));
    send({ type: "lost" });
    send({ type: "sent" });
    expect(sent.map(({ gen, seq }) => [gen, seq])).toEqual([
      [3, 1],
      [3, 2],
    ]);
  });

  it("holds a window of frames, and refuses one past either bound", () => {
    const window = frameWindow(2, 10);
    expect(window.add(6)).toBe(true);
    expect(window.add(5)).toBe(false);
    expect(window.add(4)).toBe(true);
    expect(window.add(0)).toBe(false);
    expect(window.release()).toBe(true);
    expect(window.add(6)).toBe(true);
    expect(window.release() && window.release()).toBe(true);
    expect(window.release()).toBe(false);
  });

  it("carries bytes as base64 both ways and drops messages it doesn't know", () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 128]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    expect(readToPage({ kind: "painted" })).toBeNull();
    expect(readToPage({ kind: "live", gen: 1, seq: 1, type: "unknown" })).toBeNull();
    expect(readToPage({ kind: "live", gen: 0, seq: 1, type: "lost" })).toBeNull();
  });

  it("passes frames in order both ways, and acknowledges each send", async () => {
    const t = await connected();
    expect(t.posted[0]).toMatchObject({ type: "connect", gen: 1, seq: 1, objectId: "obj-1" });
    t.latest().frame(1, 2, 3);
    expect(t.posted[1]).toEqual({ kind: "live", gen: 1, seq: 2, type: "frame", data: "AQID" });
    const page = t.fromPage(1);
    page({ type: "frame", data: toBase64(new Uint8Array([9])) });
    expect([...t.latest().sent[0]!]).toEqual([9]);
    expect(t.posted[2]).toMatchObject({ type: "sent", seq: 3 });
    page({ type: "took" });
    expect(t.live.state().phase).toBe("open");
  });

  it("closes the connection when the page falls behind the window, never dropping a frame", async () => {
    const t = await connected();
    t.latest().frame(1);
    t.latest().frame(2);
    t.latest().frame(3);
    expect(t.posted.filter((message) => message.type === "frame")).toHaveLength(2);
    expect(t.latest().closed).toBe(true);
    expect(t.live.state()).toMatchObject({ phase: "lost", reason: "bridge-full" });
    expect(t.posted.at(-1)).toMatchObject({ type: "lost" });
  });

  it("closes the connection on a gap in the page's messages, and ignores an earlier open's", async () => {
    const t = await connected();
    t.live.receive({ kind: "live", gen: 0, seq: 1, type: "close" });
    t.live.receive({ kind: "live", gen: 9, seq: 1, type: "close" });
    expect(t.live.state().phase).toBe("open");
    t.live.receive({ kind: "live", gen: 1, seq: 2, type: "took" });
    expect(t.live.state()).toMatchObject({ phase: "lost", reason: "bridge-order" });
  });

  it("refuses a socket whose server chose another protocol", async () => {
    const t = setup(ready);
    t.live.start();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    t.latest().open("dohc-live-v2");
    expect(t.live.state()).toMatchObject({ phase: "refused", reason: "invalid-socket-protocol" });
    expect(t.posted).toEqual([]);
  });
});

describe("opening", () => {
  it("asks again while the server prepares the page, then connects with the token and the ticket", async () => {
    const preparing = answer({ status: "preparing" });
    const t = setup(preparing, preparing, ready);
    t.live.start();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    expect(t.server.paths().filter((path) => path === OPEN)).toHaveLength(3);
    expect(t.server.calls[0]!.body).toEqual({ path: "notes/plan.md" });
    const [opened] = t.sockets;
    expect(opened!.url).toBe(
      "wss://dohc.example.com/sync/workspaces/ws-1/live/owner?objectId=obj-1&lineageClaimId=claim-1",
    );
    expect(opened!.protocols).toEqual(["dohc-live-v1", `dohc-live-ticket.${TICKET}`]);
    expect(opened!.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(opened!.socket.binaryType).toBe("arraybuffer");
    expect(liveMark(t.live.state())).toBe("opening");
  });

  it("stops asking when the page leaves", async () => {
    const t = setup(answer({ status: "preparing" }));
    let waits = 0;
    const live = createPageLive({
      client: createServerClient({
        origin: t.server.origin,
        token: TOKEN,
        fetch: t.server.fetch,
        signal: new AbortController().signal,
      }),
      workspaceId: "ws-1",
      path: "notes/plan.md",
      post: () => undefined,
      sleep: (_ms, signal) => {
        waits++;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    });
    live.start();
    await vi.waitFor(() => expect(waits).toBe(1));
    live.end();
    await Promise.resolve();
    expect(t.server.paths()).toEqual([OPEN]);
    expect(live.state().phase).toBe("ended");
  });

  it("keeps the page read-only with the server's reason when it refuses", async () => {
    const t = setup(answer({ status: "refused", reason: "live-document-without-lineage" }));
    t.live.start();
    await vi.waitFor(() => expect(t.live.state().phase).toBe("refused"));
    expect(liveMark(t.live.state())).toBe("readOnlyNeedsComputer");
    t.live.retry();
    expect(t.server.paths()).toEqual([OPEN]);
    expect(t.sockets).toEqual([]);
  });

  it("keeps the page read-only with Try again when the open fails or answers nothing it can use", async () => {
    for (const [failed, reason, mark] of [
      ["offline", "offline", "readOnlyOffline"],
      [{ status: 503 }, "server-busy", "readOnlyRefused"],
      [answer({ status: "ready" }), "invalid", "readOnlyRefused"],
    ] as const) {
      const t = setup(failed, ready);
      t.live.start();
      await vi.waitFor(() => expect(t.live.state().phase).toBe("lost"));
      expect(t.live.state().reason).toBe(reason);
      expect(liveMark(t.live.state())).toBe(mark);
      t.live.retry();
      await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    }
  });

  it("never gives the web view the token or the ticket", async () => {
    const t = await connected();
    t.latest().frame(7);
    t.latest().close();
    t.live.retry();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    const everything = JSON.stringify(t.posted);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TICKET);
    expect(everything).not.toContain("ticket");
  });
});

describe("the save mark", () => {
  const state = (
    phase: PageLiveState["phase"],
    value: LiveFacts | null,
    reason: string | null = null,
  ) => ({
    phase,
    reason,
    facts: value,
  });

  it("says Saved only while live with no update waiting for the server's host", () => {
    expect(liveMark(state("open", facts("live")))).toBe("saved");
    expect(liveMark(state("open", facts("live", 1)))).toBe("saving");
    expect(liveMark(state("open", facts("syncing")))).toBe("opening");
    expect(liveMark(state("open", null))).toBe("opening");
    expect(liveMark(state("opening", facts("disconnected", 2)))).toBe("saving");
    expect(liveMark(state("lost", facts("disconnected", 1), "connection"))).toBe("readOnlyOffline");
    expect(liveMark(state("refused", facts("quarantined", 0, true), "edit-refused"))).toBe(
      "readOnlySetAside",
    );
    expect(liveMark(state("refused", null, "paused"))).toBe("readOnlyRefused");
    expect(liveMark(state("ended", null))).toBe("readOnlyPhone");
  });

  it("follows the provider's reports, and asks before leaving text the server hasn't applied", async () => {
    const t = await connected();
    const page = t.fromPage(1);
    page({ type: "state", facts: facts("live") });
    expect(liveMark(t.live.state())).toBe("saved");
    expect(holdsUnsent(t.live.state())).toBe(false);
    page({ type: "state", facts: facts("live", 1) });
    expect(liveMark(t.live.state())).toBe("saving");
    expect(holdsUnsent(t.live.state())).toBe(true);
    page({ type: "state", facts: facts("live") });
    expect(liveMark(t.live.state())).toBe("saved");
  });
});

describe("drops", () => {
  it("reconnects the same page after a lost connection, with a new open and a new numbering", async () => {
    const t = await connected(ready, ready);
    t.fromPage(1)({ type: "state", facts: facts("live", 1) });
    t.latest().onclose?.();
    expect(t.live.state()).toMatchObject({ phase: "lost", reason: "connection" });
    expect(t.posted.at(-1)).toMatchObject({ type: "lost", gen: 1 });
    // The page's report after the loss still arrives, on the lost connection's numbering.
    t.fromPage(1)({ type: "state", facts: facts("live", 0) });
    t.fromPage(1)({ type: "state", facts: facts("disconnected", 1) });
    expect(t.live.state().facts?.pendingUpdates).toBe(1);
    expect(holdsUnsent(t.live.state())).toBe(true);
    t.live.retry();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    expect(t.server.paths()).toEqual([OPEN, OPEN]);
    expect(t.posted.at(-1)).toMatchObject({ type: "connect", gen: 2, seq: 1 });
    // The first connection's numbering is now stale.
    t.live.receive({ kind: "live", gen: 1, seq: 4, type: "close" });
    expect(t.live.state().phase).toBe("open");
  });

  it("never reconnects a provider that quarantined", async () => {
    const t = await connected();
    t.fromPage(1)({
      type: "state",
      facts: {
        status: "quarantined",
        reason: "foreign-ack-epoch",
        pendingUpdates: 1,
        unsent: true,
      },
    });
    expect(t.live.state()).toMatchObject({ phase: "refused", reason: "foreign-ack-epoch" });
    expect(t.latest().closed).toBe(true);
    expect(holdsUnsent(t.live.state())).toBe(true);
    t.live.retry();
    expect(t.server.paths()).toEqual([OPEN]);
  });

  it("closes the socket when the sign-in ends", async () => {
    const t = await connected();
    t.signIn.abort();
    expect(t.latest().closed).toBe(true);
    expect(t.live.state().phase).toBe("lost");
  });
});

describe("teardown", () => {
  it("closes the page's socket at Sign out, a 401, another workspace and Show on phone off", async () => {
    const triggers = ["sign-out", "401", "another workspace", "hidden"] as const;
    for (const trigger of triggers) {
      const server = testServer();
      const stored = { origin: server.origin, token: "tok", userId: "u-1", email: "a@example.com" };
      const pages = createLivePages();
      const teardown = appTeardown(createAppRunner(), pages);
      let atDelete: string | null = null;
      const account = createAccount({
        store: memoryStore(stored).store,
        fetch: server.fetch,
        onSignOut: teardown.signOut(async (leave) => {
          atDelete = t.live.state().phase;
          await leave();
        }),
      });
      teardown.follow(account);
      await account.restore();
      const signedIn = account.state();
      if (signedIn.status !== "signed-in") throw Error("not signed in");
      const t = await connected();
      pages.add({ signIn: signedIn.signIn, workspaceId: "ws-1" }, t.live);
      // Ending another workspace's pages leaves this one open.
      teardown.hide("ws-2");
      expect(t.live.state().phase, trigger).toBe("open");
      if (trigger === "sign-out") await account.signOut();
      else if (trigger === "401") {
        server.on("GET", "/sync/account/workspaces", { status: 401 });
        await signedIn.signIn.client
          .send("GET", "/sync/account/workspaces", () => null)
          .catch(() => undefined);
      } else if (trigger === "another workspace") teardown.open("ws-2");
      else teardown.hide("ws-1");
      expect(t.live.state().phase, trigger).toBe("ended");
      expect(t.latest().closed, trigger).toBe(true);
      if (trigger === "sign-out") expect(atDelete).toBe("ended");
      // Nothing the page posts afterwards reaches the session.
      t.fromPage(1)({ type: "state", facts: facts("live") });
      expect(t.live.state().facts, trigger).toBeNull();
    }
  });
});
