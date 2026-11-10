import { describe, expect, it, vi } from "vitest";
import { createAccount, type StoredSignIn } from "./account";
import { createServerClient } from "./client";
import { deferred, memoryStore, testServer, type Answer } from "./testServer";
import { cacheScope, createReadCache, createWorkspaceData, FEED_RETRY_MS, views, type ReadCache } from "./workspaceData";
import { FEED_HOLD_MS } from "./workspaceReads";

type Server = ReturnType<typeof testServer>;

const ops = (result: unknown, cursor: string): Answer => ({ status: 200, body: { ok: true, result, cursor } });
const files = (...paths: [string, string][]) => ({ ok: true, files: paths.map(([path, objectId]) => ({ path, objectId, contentKind: "text", byteLength: 1 })), folders: [] });
const groups = (...entries: [string, string[]][]) => ({
  ok: true, groups: entries.map(([id, threads]) => ({ id, name: id, slug: id, kind: "group", threadCount: threads.length,
    threads: threads.map(thread => ({ id: thread, title: "", messageCount: 1, updatedAtMs: 1 })) })),
});
const message = (id: string, threadId: string, body: string) => ({
  id, threadId, authorKind: "human", authorDisplayName: "Maya Chen", body, createdAtMs: 1, attachments: [], needsDecision: false,
});
const thread = (id: string, body: string) => ({ ok: true, thread: { id, title: "Plans", createdAtMs: 1, updatedAtMs: 1 },
  dispatch: { paused: null, lastRun: null }, messages: [message("message-1", id, body)], projection: { path: "p", readOnly: true, text: "" } });
const feedPath = (workspaceId: string, since: string) => `/sync/${workspaceId}/ops/changes?since=${since}&hold=${FEED_HOLD_MS}`;
const feed = (answer: object): Answer => ({ status: 200, body: { ok: true, ...answer } });
/** A feed request the test never answers: it waits until its signal aborts. */
const held = () => new Promise<Answer>(() => {});

/** Lets every answer already given reach the store: no timer, only the macrotask after the answers' callbacks. */
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const count = (server: Server, path: string) => server.calls.filter(call => call.path === path).length;

function signInTo(server: Server) {
  return {
    client: createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal }),
    isCurrent: () => true, origin: server.origin, userId: "u-1",
  };
}

function open(server: Server, workspaceId = "ws-a", cache: ReadCache = createReadCache(), sleep?: (ms: number, signal: AbortSignal) => Promise<void>) {
  const data = createWorkspaceData({ signIn: signInTo(server), workspaceId, cache, ...(sleep ? { sleep } : {}) });
  data.resume();
  return { data, cache };
}

describe("a workspace's reads", () => {
  it("never let a slow read for one workspace land after a switch to another", async () => {
    const server = testServer();
    const cache = createReadCache();
    const slow = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/listFiles", () => slow.promise);
    server.on("POST", "/sync/ws-b/ops/listFiles", ops(files(["b.md", "object-b"]), "0.1.1"));
    server.on("GET", feedPath("ws-b", "0.1.1"), held);
    const { data: a } = open(server, "ws-a", cache);
    const paintedA = vi.fn();
    a.subscribe(views.files, paintedA);
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(1));

    // The switch: A's store stops, and B's opens.
    a.stop();
    const { data: b } = open(server, "ws-b", cache);
    b.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(b.state(views.files).value).toEqual([{ path: "b.md", objectId: "object-b", page: true }]));
    paintedA.mockClear();
    slow.resolve(ops(files(["a.md", "object-a"]), "0.9.9"));
    await settled();

    expect(server.calls.find(call => call.path === "/sync/ws-a/ops/listFiles")?.signal.aborted).toBe(true);
    expect(paintedA).not.toHaveBeenCalled();
    expect(a.state(views.files).value).toBeNull();
    expect(cache.get(cacheScope(signInTo(server), "ws-a"), "files")).toBeUndefined();
    expect(server.paths().some(path => path.startsWith("GET /sync/ws-a/"))).toBe(false);
  });

  it("keep what a view shows while it reads again", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.1.1"));
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.1.1"), () => change.promise);
    server.on("GET", feedPath("ws-a", "0.2.1"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(1));
    const next = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/listFiles", () => next.promise);
    change.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(data.state(views.files).loading).toBe(true));
    expect(data.state(views.files).value).toHaveLength(1);
    next.resolve(ops(files(["a.md", "object-a"], ["b.md", "object-b"]), "0.2.1"));
    await vi.waitFor(() => expect(data.state(views.files)).toMatchObject({ loading: false, problem: null }));
    expect(data.state(views.files).value).toHaveLength(2);
  });

  it("answer a page that's gone, one too large to read, and one being restored", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/documentRead", ({ body }) => {
      const path = (body as { path: string }).path;
      if (path === "gone.md") return ops({ ok: false, reason: "dohc: No document at gone.md." }, "0.1.1");
      if (path === "big.md") return ops({ ok: false, reason: "dohc: This page is too large to open here.", refusal: "too-large" }, "0.1.1");
      return { status: 409, body: { ok: false, error: "Stop live editing is waiting.", code: "restore-in-progress" } };
    });
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    for (const path of ["gone.md", "big.md", "restoring.md"]) data.subscribe(views.page(path), () => {});
    await vi.waitFor(() => expect(data.state(views.page("restoring.md")).problem).toBe("restoring"));
    await vi.waitFor(() => expect(data.state(views.page("big.md")).value).toEqual({ kind: "too-large" }));
    expect(data.state(views.page("gone.md")).value).toEqual({ kind: "missing" });
  });
});

describe("the change feed", () => {
  it("starts from a read's cursor, and reads again only the views a change can touch", async () => {
    const server = testServer();
    // Each read answers the cursor the server has reached, as the server's own reads do.
    let now = "0.5.2";
    server.on("POST", "/sync/ws-a/ops/listFiles", () => ops(files(["notes/a.md", "object-a"], ["b.md", "object-b"]), now));
    server.on("POST", "/sync/ws-a/ops/groupsFull", () => ops(groups(["channel-1", ["thread-1"]], ["channel-2", ["thread-2"]]), now));
    server.on("POST", "/sync/ws-a/ops/chat", ({ body }) => {
      const args = body as { threadId?: string; group?: string };
      return args.threadId ? ops(thread(args.threadId, "hello"), now)
        : ops({ ok: true, stream: { group: { id: args.group, name: "planning", kind: "group" }, items: [], nextBefore: null, readPosition: null } }, now);
    });
    server.on("POST", "/sync/ws-a/ops/documentRead", () => ops({ ok: true, path: "notes/a.md", markdown: "# A" }, now));
    const first = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => first.promise);
    const { data } = open(server);
    for (const view of [views.files, views.chats, views.thread("thread-1"), views.stream("channel-2"), views.page("notes/a.md")]) data.subscribe(view, () => {});
    await vi.waitFor(() => expect(data.state(views.page("notes/a.md")).value).toEqual({ kind: "page", markdown: "# A" }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    const reads = () => server.calls.filter(call => call.method === "POST").map(call => JSON.stringify([call.path.split("/").pop(), call.body]));
    const before = reads().length;

    const second = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.6.2"), () => second.promise);
    now = "0.6.2";
    first.resolve(feed({ cursor: "0.6.2", changed: { chats: ["thread-1"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    await vi.waitFor(() => expect(reads().slice(before).sort()).toEqual([
      JSON.stringify(["chat", { threadId: "thread-1" }]), JSON.stringify(["groupsFull", {}]),
    ]));

    const after = reads().length;
    server.on("GET", feedPath("ws-a", "0.7.3"), held);
    now = "0.7.3";
    second.resolve(feed({ cursor: "0.7.3", changed: { files: ["object-a"], pages: ["object-a"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.7.3"))).toBe(1));
    await vi.waitFor(() => expect(reads().slice(after).sort()).toEqual([
      JSON.stringify(["documentRead", { path: "notes/a.md" }]), JSON.stringify(["listFiles", {}]),
    ]));
  });

  it("goes back to an older read's cursor, so it misses nothing made after that read", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    const chats = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/groupsFull", () => chats.promise);
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    server.on("GET", feedPath("ws-a", "0.4.2"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    data.subscribe(views.chats, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    chats.resolve(ops(groups(), "0.4.2"));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.4.2"))).toBe(1));
    expect(server.calls.find(call => call.path === feedPath("ws-a", "0.5.2"))?.signal.aborted).toBe(true);
  });

  it("goes back no further than where it was when a read started", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    server.on("GET", feedPath("ws-a", "0.5.2"), feed({ cursor: "0.6.2", changed: {} }));
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    // A read that started once the feed was at 0.6.2 answers an older cursor: the changes before 0.6.2 are in it.
    server.on("POST", "/sync/ws-a/ops/groupsFull", ops(groups(), "0.4.2"));
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    data.subscribe(views.chats, () => {});
    await vi.waitFor(() => expect(data.state(views.chats).value).toEqual([]));
    await settled();
    expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1);
    expect(server.paths().filter(path => path.includes("since=0.4.2"))).toEqual([]);
  });

  it("resumes a workspace opened again from the cursors of what it shows, without reading it again", async () => {
    const server = testServer();
    const cache = createReadCache();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.5.2"));
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    const first = open(server, "ws-a", cache).data;
    first.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    first.stop();

    const again = open(server, "ws-a", cache).data;
    again.subscribe(views.files, () => {});
    expect(again.state(views.files).value).toHaveLength(1);
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(1);
  });

  it("reads every open view again on replace, and drops the rest", async () => {
    const server = testServer();
    const cache = createReadCache();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.5.2"));
    server.on("POST", "/sync/ws-a/ops/chat", ops(thread("thread-1", "hello"), "0.5.2"));
    const answer = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => answer.promise);
    server.on("GET", feedPath("ws-a", "1.0.0"), held);
    const { data } = open(server, "ws-a", cache);
    data.subscribe(views.files, () => {});
    const close = data.subscribe(views.thread("thread-1"), () => {});
    await vi.waitFor(() => expect(data.state(views.thread("thread-1")).value).not.toBeNull());
    close();
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));

    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "1.0.0"));
    answer.resolve(feed({ cursor: "1.0.0", replace: true }));
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(2));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "1.0.0"))).toBe(1));
    const scope = cacheScope(signInTo(server), "ws-a");
    expect(cache.get(scope, "thread:thread-1")).toBeUndefined();
    expect(data.state(views.thread("thread-1")).value).toBeNull();
    expect(count(server, "/sync/ws-a/ops/chat")).toBe(1);
  });

  it("drops a closed view's read that a change overtakes, and reads it again when it opens", async () => {
    const server = testServer();
    const cache = createReadCache();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => change.promise);
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    const slow = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/chat", () => slow.promise);
    const { data } = open(server, "ws-a", cache);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    const close = data.subscribe(views.thread("thread-1"), () => {});
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/chat")).toBe(1));
    close();

    change.resolve(feed({ cursor: "0.6.2", changed: { chats: ["thread-1"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    slow.resolve(ops(thread("thread-1", "before the change"), "0.5.2"));
    await settled();
    expect(cache.get(cacheScope(signInTo(server), "ws-a"), "thread:thread-1")).toBeUndefined();

    server.on("POST", "/sync/ws-a/ops/chat", ops(thread("thread-1", "after the change"), "0.6.2"));
    data.subscribe(views.thread("thread-1"), () => {});
    await vi.waitFor(() => expect(data.state(views.thread("thread-1")).value).toMatchObject({ messages: [{ body: "after the change" }] }));
  });

  it("backs off after a failure, doubling the wait, then carries on", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    server.on("GET", feedPath("ws-a", "0.5.2"), { status: 503 }, "offline", feed({ cursor: "0.6.2", changed: {} }));
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    const waits: number[] = [];
    const { data } = open(server, "ws-a", createReadCache(), async ms => { waits.push(ms); });
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    expect(waits).toEqual([FEED_RETRY_MS, 2 * FEED_RETRY_MS]);
  });

  it("stops in the background and starts again from where it was", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    data.pause();
    expect(server.calls.find(call => call.path === feedPath("ws-a", "0.5.2"))?.signal.aborted).toBe(true);
    data.resume();
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
  });
});

describe("the read cache and the sign-in", () => {
  const SAVED: StoredSignIn = { origin: "https://dohc.example.com", token: "tok-1", userId: "u-1", email: "ice@example.com" };

  async function signedIn() {
    const server = testServer();
    const account = createAccount({ store: memoryStore(SAVED).store, fetch: server.fetch, sleep: async () => {} });
    await account.restore();
    const state = account.state();
    if (state.status !== "signed-in") throw new Error("expected signed-in");
    const cache = createReadCache();
    cache.follow(account);
    const data = createWorkspaceData({ signIn: state.signIn, workspaceId: "ws-a", cache });
    data.resume();
    return { server, account, cache, data, scope: cacheScope(state.signIn, "ws-a") };
  }

  it("stops the feed and empties the cache on a 401", async () => {
    const { server, account, cache, data, scope } = await signedIn();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.5.2"));
    const answer = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => answer.promise);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(cache.entries(scope)).toHaveLength(1));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));

    answer.resolve({ status: 401 });
    await vi.waitFor(() => expect(account.state()).toMatchObject({ status: "signed-out", ended: true }));
    await settled();
    expect(cache.entries(scope)).toHaveLength(0);
    expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1);
    expect(server.paths().filter(path => path.includes("/ops/"))).toHaveLength(2);
  });

  it("aborts a held read and a held feed at sign-out, and lands neither", async () => {
    const { server, account, cache, data, scope } = await signedIn();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.5.2"));
    const page = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/documentRead", () => page.promise);
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    data.subscribe(views.files, () => {});
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/documentRead")).toBe(1));

    await account.signOut();
    for (const path of [feedPath("ws-a", "0.5.2"), "/sync/ws-a/ops/documentRead"]) {
      expect(server.calls.find(call => call.path === path)?.signal.aborted, path).toBe(true);
    }
    page.resolve(ops({ ok: true, path: "a.md", markdown: "# A" }, "0.6.0"));
    await settled();
    expect(data.state(views.page("a.md")).value).toBeNull();
    expect(cache.entries(scope)).toHaveLength(0);
    expect(server.paths().filter(path => path.includes("/ops/"))).toHaveLength(3);
  });
});
