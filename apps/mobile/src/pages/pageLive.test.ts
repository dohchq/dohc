import { describe, expect, it, vi } from "vitest";
import { createServerClient } from "../server/client";
import type { Answer } from "../server/testServer";
import {
  frameWindow,
  fromBase64,
  incoming,
  outgoing,
  readToPage,
  toBase64,
  type LiveFacts,
  type ToPage,
} from "./liveBridge";
import {
  answer,
  facts,
  liveLimits,
  liveServer,
  OPEN,
  pageSide,
  ready,
  TICKET,
  TOKEN,
} from "./liveFixtures";
import { createPageLive, holdsPage, holdsUnsent, liveMark, type PageLiveState } from "./pageLive";

function setup(...answers: Answer[]) {
  const t = liveServer(...answers);
  const posted: ToPage[] = [];
  const live = createPageLive({
    client: t.client,
    workspaceId: "ws-1",
    path: "notes/plan.md",
    post: (message) => posted.push(message),
    sleep: async () => undefined,
  });
  return { ...t, posted, live, fromPage: pageSide(live) };
}

async function connected(...answers: Answer[]) {
  const t = setup(...(answers.length ? answers : [ready()]));
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
    const connect = {
      kind: "live",
      gen: 1,
      seq: 1,
      type: "connect",
      workspaceId: "w",
      objectId: "o",
    };
    expect(readToPage({ ...connect, limits: liveLimits() })).toMatchObject({ type: "connect" });
    // Limits the provider can't use, as the shared parser judges them.
    const { drainPollMs: _, ...partial } = liveLimits();
    expect(readToPage({ ...connect, limits: partial })).toBeNull();
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
    const t = await connected(ready(liveLimits({ frames: 2 })));
    t.latest().frame(1);
    t.latest().frame(2);
    t.latest().frame(3);
    expect(t.posted.filter((message) => message.type === "frame")).toHaveLength(2);
    expect(t.latest().closed).toBe(true);
    expect(t.live.state()).toMatchObject({ phase: "lost", reason: "bridge-full" });
    expect(t.posted.at(-1)).toMatchObject({ type: "lost" });
  });

  it("closes the connection on a page frame past the limits or not in base64, sending nothing", async () => {
    for (const data of [toBase64(new Uint8Array(1025)), "not base64!"]) {
      const t = await connected();
      t.fromPage(1)({ type: "frame", data });
      expect(t.latest().sent).toEqual([]);
      expect(t.live.state()).toMatchObject({ phase: "lost", reason: "bridge-order" });
    }
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
    const t = setup(ready());
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
    const t = setup(preparing, preparing, ready());
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
      [ready({ ...liveLimits(), maxSocketBufferedBytes: 10 }), "invalid", "readOnlyRefused"],
    ] as const) {
      const t = setup(failed, ready());
      t.live.start();
      await vi.waitFor(() => expect(t.live.state().phase).toBe("lost"));
      expect(t.live.state().reason).toBe(reason);
      expect(liveMark(t.live.state())).toBe(mark);
      t.live.retry();
      await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    }
  });

  it("never gives the web view the token or the ticket", async () => {
    const t = await connected(ready(), ready());
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

  it("opens a joined member's named live socket and passes named:<grantId> to the web view without leaking ticket or session", async () => {
    const SESSION = "AbCdEf123456";
    const namedReady = answer({
      status: "ready",
      mode: "named",
      session: SESSION,
      liveWorkspaceId: "named:grant-42",
      objectId: "obj-1",
      lineageClaimId: "claim-1",
      ticket: TICKET,
      expiresAtMs: 1,
      editorLimits: liveLimits(),
    });
    const t = await connected(namedReady);
    const [opened] = t.sockets;
    expect(opened!.url).toBe(`wss://dohc.example.com/sync/live/phone?session=${SESSION}`);
    expect(opened!.protocols).toEqual(["dohc-live-v1", `dohc-live-ticket.${TICKET}`]);
    expect(opened!.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(t.posted[0]).toMatchObject({
      type: "connect",
      gen: 1,
      seq: 1,
      workspaceId: "named:grant-42",
      objectId: "obj-1",
    });
    const everything = JSON.stringify(t.posted);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TICKET);
    expect(everything).not.toContain(SESSION);
  });

  it("rejects malformed named or mixed owner PageOpen payloads as invalid", async () => {
    const base = {
      status: "ready",
      objectId: "obj-1",
      lineageClaimId: "claim-1",
      ticket: TICKET,
      expiresAtMs: 1,
      editorLimits: liveLimits(),
    };
    for (const bad of [
      answer({ ...base, mode: "named", session: "short", liveWorkspaceId: "named:grant-1" }),
      answer({ ...base, mode: "named", session: "AbCdEf123456", liveWorkspaceId: "ws-1" }),
      answer({ ...base, mode: "named", session: "AbCdEf123456" }),
      answer({ ...base, mode: "owner", session: "AbCdEf123456" }),
      answer({ ...base, liveWorkspaceId: "named:grant-1" }),
    ]) {
      const t = setup(bad);
      t.live.start();
      await vi.waitFor(() => expect(t.live.state().phase).toBe("lost"));
      expect(t.live.state().reason).toBe("invalid");
      expect(t.sockets).toEqual([]);
    }
  });

  it("lets go of the sign-in once its socket closes", async () => {
    const t = await connected();
    t.live.end();
    expect(t.latest().closes).toBe(1);
    t.signIn.abort();
    expect(t.latest().closes).toBe(1);
  });
});

describe("the save mark", () => {
  const state = (
    phase: PageLiveState["phase"],
    value: LiveFacts | null,
    reason: string | null = null,
  ): PageLiveState => ({
    phase,
    reason,
    facts: value,
    unsent: value?.unsent ?? false,
    shown: value?.status === "live",
  });

  it("says Saved only while live with no update waiting for the server's host", () => {
    expect(liveMark(state("open", facts("live")))).toBe("saved");
    expect(liveMark(state("open", facts("live", 1)))).toBe("saving");
    expect(liveMark(state("open", facts("syncing")))).toBe("opening");
    expect(liveMark(state("open", null))).toBe("opening");
    expect(liveMark(state("opening", facts("disconnected", 2)))).toBe("saving");
    expect(liveMark({ ...state("opening", null), unsent: true })).toBe("saving");
    expect(liveMark(state("lost", facts("disconnected", 1), "connection"))).toBe("readOnlyOffline");
    expect(liveMark(state("refused", facts("quarantined", 0, true), "edit-refused"))).toBe(
      "readOnlySetAside",
    );
    expect(liveMark(state("refused", null, "paused"))).toBe("readOnlyRefused");
    expect(liveMark(state("refused", null, "read-only"))).toBe("readOnlyShared");
    expect(liveMark(state("refused", null, "live_paused_by_owner"))).toBe("readOnlyPausedByOwner");
    expect(liveMark(state("refused", null, "authority-refused"))).toBe("readOnlyEnded");
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

  it("never says Saved on a retry until the new connection's provider reports", async () => {
    const t = await connected(ready(), ready());
    const page = t.fromPage(1);
    page({ type: "state", facts: facts("live") });
    expect(liveMark(t.live.state())).toBe("saved");
    // The page typed; its report is still on its way when the socket drops.
    t.latest().onclose?.();
    t.live.retry();
    expect(liveMark(t.live.state())).toBe("opening");
    // The late report, and a gap after it, belong to the lost connection: neither moves the new open.
    page({ type: "state", facts: facts("live", 0) });
    t.live.receive({ kind: "live", gen: 1, seq: 9, type: "took" });
    expect(t.live.state()).toMatchObject({ phase: "opening", facts: null });
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    expect(liveMark(t.live.state())).toBe("opening");
    t.fromPage(2)({ type: "state", facts: facts("live", 1) });
    expect(liveMark(t.live.state())).toBe("saving");
    t.fromPage(2)({ type: "state", facts: facts("live") });
    expect(liveMark(t.live.state())).toBe("saved");
  });

  it("still asks before leaving when an edit's report arrives after Try again, and the new open is refused", async () => {
    const t = await connected(ready(), answer({ status: "refused", reason: "paused" }));
    const page = t.fromPage(1);
    page({ type: "state", facts: facts("live") });
    expect(holdsUnsent(t.live.state())).toBe(false);
    // The page typed; its report is still on its way when the socket drops and Try again starts.
    t.latest().onclose?.();
    t.live.retry();
    page({ type: "state", facts: facts("disconnected", 1) });
    await vi.waitFor(() => expect(t.live.state().phase).toBe("refused"));
    expect(holdsUnsent(t.live.state())).toBe(true);
    expect(liveMark(t.live.state())).toBe("readOnlySetAside");
  });
});

describe("drops", () => {
  it("reconnects the same page after a lost connection, with a new open and a new numbering", async () => {
    const t = await connected(ready(), ready());
    const page = t.fromPage(1);
    page({ type: "state", facts: facts("live", 1) });
    t.latest().onclose?.();
    expect(t.live.state()).toMatchObject({ phase: "lost", reason: "connection" });
    expect(t.posted.at(-1)).toMatchObject({ type: "lost", gen: 1 });
    // The page's report after the loss still arrives, on the lost connection's numbering.
    page({ type: "state", facts: facts("disconnected", 2) });
    expect(t.live.state().facts?.pendingUpdates).toBe(2);
    expect(holdsUnsent(t.live.state())).toBe(true);
    t.live.retry();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    expect(t.server.paths()).toEqual([OPEN, OPEN]);
    expect(t.posted.at(-1)).toMatchObject({ type: "connect", gen: 2, seq: 1 });
    // The text is still unsent until the new connection's provider says otherwise.
    expect(holdsUnsent(t.live.state())).toBe(true);
    page({ type: "close" });
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

  it("opens the page again by itself when the note's lineage was replaced and nothing is unsent", async () => {
    const t = await connected(ready(), ready());
    const page = t.fromPage(1);
    page({ type: "close" });
    page({
      type: "state",
      facts: {
        status: "quarantined",
        reason: "lineage-replaced",
        pendingUpdates: 0,
        unsent: false,
      },
    });
    expect(t.sockets[0]!.socket.closed).toBe(true);
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    page({ type: "took" });
    expect(t.server.paths()).toEqual([OPEN, OPEN]);
    expect(t.posted.at(-1)).toMatchObject({ type: "connect", gen: 2, seq: 1 });
    expect(t.live.state().phase).toBe("open");
  });

  it("stays stopped when the note's lineage was replaced with typing unsent", async () => {
    const t = await connected(ready(), ready());
    t.fromPage(1)({
      type: "state",
      facts: { status: "quarantined", reason: "lineage-replaced", pendingUpdates: 1, unsent: true },
    });
    expect(t.live.state()).toMatchObject({ phase: "refused", reason: "lineage-replaced" });
    expect(holdsUnsent(t.live.state())).toBe(true);
    t.live.retry();
    expect(t.server.paths()).toEqual([OPEN]);
  });

  it("stays stopped on any other changed binding, even with nothing unsent", async () => {
    const t = await connected(ready(), ready());
    const page = t.fromPage(1);
    page({
      type: "state",
      facts: { status: "quarantined", reason: "binding-changed", pendingUpdates: 0, unsent: false },
    });
    expect(t.live.state()).toMatchObject({ phase: "refused", reason: "binding-changed" });
    page({
      type: "state",
      facts: {
        status: "quarantined",
        reason: "lineage-replaced",
        pendingUpdates: 0,
        unsent: false,
      },
    });
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

describe("text read later", () => {
  it("never replaces a page that shows the live document, or may yet", async () => {
    const t = await connected(ready(), answer({ status: "refused", reason: "paused" }));
    expect(holdsPage(t.live.state())).toBe(true);
    t.fromPage(1)({ type: "state", facts: facts("live") });
    t.latest().onclose?.();
    expect(holdsPage(t.live.state())).toBe(true);
    // Refused after it showed the live document: the person's view stays.
    t.live.retry();
    await vi.waitFor(() => expect(t.live.state().phase).toBe("refused"));
    expect(holdsPage(t.live.state())).toBe(true);
    // Refused before it ever was live, or ended: the text read may replace it.
    const refused = setup(answer({ status: "refused", reason: "paused" }));
    refused.live.start();
    await vi.waitFor(() => expect(refused.live.state().phase).toBe("refused"));
    expect(holdsPage(refused.live.state())).toBe(false);
    t.live.end();
    expect(holdsPage(t.live.state())).toBe(false);
  });

  it("binds objectId only when a live stream reaches live state so a failed reconnect keeps the displayed identity", async () => {
    const readyObj = (objectId: string) =>
      answer({
        status: "ready",
        objectId,
        lineageClaimId: "claim-1",
        ticket: TICKET,
        expiresAtMs: 1,
        editorLimits: liveLimits(),
      });
    const t = await connected(readyObj("obj-1"), readyObj("obj-2"), readyObj("obj-2"));
    expect(t.live.state().objectId).toBeUndefined();
    t.fromPage(1)({ type: "state", facts: facts("syncing") });
    expect(t.live.state().shown).toBe(false);
    expect(t.live.state().objectId).toBeUndefined();
    t.fromPage(1)({ type: "state", facts: facts("live") });
    expect(t.live.state()).toMatchObject({ shown: true, objectId: "obj-1" });

    t.latest().onclose?.();
    t.live.retry();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    t.fromPage(2)({ type: "state", facts: facts("syncing") });
    t.latest().onclose?.();
    expect(t.live.state()).toMatchObject({ phase: "lost", shown: true, objectId: "obj-1" });

    t.live.retry();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(3));
    t.latest().open();
    t.fromPage(3)({ type: "state", facts: facts("live") });
    expect(t.live.state()).toMatchObject({ phase: "open", shown: true, objectId: "obj-2" });
  });
});
