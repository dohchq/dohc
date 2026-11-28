import { describe, expect, it, vi } from "vitest";
import { createAccount, type StoredSignIn } from "./account";
import { createServerClient } from "./client";
import { deferred, memoryStore, serveSessionEnd, testServer, type Answer } from "./testServer";
import {
  cacheScope,
  createReadCache,
  createWorkspaceData,
  FEED_FAILURES_SHOWN,
  FEED_RETRY_MS,
  PREFETCH_MAX,
  views,
  type ReadCache,
} from "./workspaceData";
import { PREFETCH_AT_ONCE } from "./readLane";
import { FEED_HOLD_MS } from "./workspaceReads";

type Server = ReturnType<typeof testServer>;

const ops = (result: unknown, cursor: string): Answer => ({
  status: 200,
  body: { ok: true, result, cursor },
});
const files = (...paths: [string, string][]) => ({
  ok: true,
  files: paths.map(([path, objectId]) => ({ path, objectId, contentKind: "text", byteLength: 1 })),
  folders: [],
});
const groups = (...entries: [string, string[]][]) => ({
  ok: true,
  groups: entries.map(([id, threads]) => ({
    id,
    name: id,
    slug: id,
    kind: "group",
    threadCount: threads.length,
    threads: threads.map((thread) => ({
      id: thread,
      title: "",
      messageCount: 1,
      unreadCount: 0,
      updatedAtMs: 1,
    })),
  })),
});
const message = (id: string, threadId: string, body: string) => ({
  id,
  threadId,
  authorKind: "human",
  authorDisplayName: "Maya Chen",
  body,
  createdAtMs: 1,
  attachments: [],
  needsDecision: false,
});
const thread = (id: string, body: string) => ({
  ok: true,
  thread: { id, title: "Plans", createdAtMs: 1, updatedAtMs: 1 },
  dispatch: { paused: null, lastRun: null },
  messages: [message("message-1", id, body)],
  projection: { path: "p", readOnly: true, text: "" },
});
const feedPath = (workspaceId: string, since: string) =>
  `/sync/${workspaceId}/ops/changes?since=${since}&hold=${FEED_HOLD_MS}`;
const feed = (answer: object): Answer => ({ status: 200, body: { ok: true, ...answer } });
const NOT_FOUND: Answer = {
  status: 404,
  body: { ok: false, error: "not found", code: "not_found" },
};
const held = () => new Promise<Answer>(() => {});

/** Lets every answer already given reach the store: no timer, only the macrotask after the answers' callbacks. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const count = (server: Server, path: string) =>
  server.calls.filter((call) => call.path === path).length;

function signInTo(server: Server) {
  return {
    client: createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal: new AbortController().signal,
    }),
    isCurrent: () => true,
    origin: server.origin,
    userId: "u-1",
  };
}

function open(
  server: Server,
  workspaceId = "ws-a",
  cache: ReadCache = createReadCache(),
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
) {
  const data = createWorkspaceData({
    signIn: signInTo(server),
    workspaceId,
    cache,
    ...(sleep ? { sleep } : {}),
  });
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

    a.stop();
    const { data: b } = open(server, "ws-b", cache);
    b.subscribe(views.files, () => {});
    await vi.waitFor(() =>
      expect(b.state(views.files).value).toEqual([
        { path: "b.md", objectId: "object-b", page: true },
      ]),
    );
    paintedA.mockClear();
    slow.resolve(ops(files(["a.md", "object-a"]), "0.9.9"));
    await settled();

    expect(
      server.calls.find((call) => call.path === "/sync/ws-a/ops/listFiles")?.signal.aborted,
    ).toBe(true);
    expect(paintedA).not.toHaveBeenCalled();
    expect(a.state(views.files).value).toBeNull();
    expect(cache.get(cacheScope(signInTo(server), "ws-a"), "files")).toBeUndefined();
    expect(server.paths().some((path) => path.startsWith("GET /sync/ws-a/"))).toBe(false);
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
    await vi.waitFor(() =>
      expect(data.state(views.files)).toMatchObject({ loading: false, problem: null }),
    );
    expect(data.state(views.files).value).toHaveLength(2);
  });

  it("refresh reads now, past a read on its way, and settles when its own read answers", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.1.1"));
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(1));
    const first = deferred<Answer>();
    const pulled = deferred<Answer>();
    const later = deferred<Answer>();
    const answers = [first, pulled, later];
    server.on("POST", "/sync/ws-a/ops/listFiles", () => answers.shift()!.promise);
    data.retry(views.files);
    const refreshed = vi.fn();
    void data.refresh(views.files).then(refreshed);
    void data.refresh(views.files);
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(4));
    pulled.resolve(ops(files(["a.md", "object-a"]), "0.1.1"));
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalled());
    expect(data.state(views.files).loading).toBe(true);
    later.resolve(ops(files(["a.md", "object-a"]), "0.1.1"));
    await vi.waitFor(() => expect(data.state(views.files).loading).toBe(false));
    first.resolve(ops(files(), "0.1.1"));
  });

  it("answer a page that's gone and one too large to read", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/documentRead", ({ body }) => {
      const path = (body as { path: string }).path;
      if (path === "gone.md")
        return ops(
          { ok: false, reason: "dohc: No document at gone.md.", refusal: "missing" },
          "0.1.1",
        );
      if (path === "odd.md")
        return ops({ ok: false, reason: "dohc: No document at odd.md." }, "0.1.1");
      return ops(
        { ok: false, reason: "dohc: This page is too large to open here.", refusal: "too-large" },
        "0.1.1",
      );
    });
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    for (const path of ["gone.md", "odd.md", "big.md"]) data.subscribe(views.page(path), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("big.md")).value).toEqual({ kind: "too-large" }),
    );
    expect(data.state(views.page("gone.md")).value).toEqual({ kind: "missing" });
    // Only the server's code says a page is gone: any other refusal is a read that failed, which Try again repeats.
    expect(data.state(views.page("odd.md"))).toMatchObject({ value: null, problem: "refused" });
  });
});

describe("what a read answers", () => {
  it("reads a page over 1 MiB, up to the editor's limit", async () => {
    const server = testServer();
    const markdown = "a".repeat(1.5 * 1024 * 1024);
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      ops({ ok: true, path: "big.md", markdown }, "0.1.1"),
    );
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.subscribe(views.page("big.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("big.md")).value).toEqual({ kind: "page", markdown }),
    );
  });

  it("keeps a gone page's last text in its own workspace's store, never another's", async () => {
    const server = testServer();
    const cache = createReadCache();
    const gone = ops(
      { ok: false, reason: "dohc: No document at a.md.", refusal: "missing" },
      "0.1.1",
    );
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      ops({ ok: true, path: "a.md", markdown: "Text from A" }, "0.1.1"),
      gone,
    );
    server.on("POST", "/sync/ws-b/ops/documentRead", gone);
    for (const workspaceId of ["ws-a", "ws-b"])
      server.on("GET", feedPath(workspaceId, "0.1.1"), held);
    const a = open(server, "ws-a", cache).data;
    a.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(a.state(views.page("a.md")).value).toMatchObject({ kind: "page" }),
    );
    a.retry(views.page("a.md"));
    await vi.waitFor(() =>
      expect(a.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "Text from A" }),
    );

    a.stop();
    const b = open(server, "ws-b", cache).data;
    b.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(b.state(views.page("a.md")).value).toEqual({ kind: "missing" }));
    expect(JSON.stringify(cache.entries(cacheScope(signInTo(server), "ws-b")))).not.toContain(
      "Text from A",
    );
  });

  it("keeps a conversation when a refresh fails, and reads it as missing only by the server's code", async () => {
    const server = testServer();
    const answers: Answer[] = [
      ops(thread("thread-1", "hello"), "0.1.1"),
      ops({ ok: false, reason: "failed to read chat: thread-1" }, "0.1.1"),
      ops({ ok: false, reason: "chat thread not found: thread-1", refusal: "missing" }, "0.1.1"),
    ];
    server.on("POST", "/sync/ws-a/ops/chat", ...answers);
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.subscribe(views.thread("thread-1"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.thread("thread-1")).value).toMatchObject({ kind: "thread" }),
    );
    data.retry(views.thread("thread-1"));
    await vi.waitFor(() => expect(data.state(views.thread("thread-1")).problem).toBe("refused"));
    expect(data.state(views.thread("thread-1")).value).toMatchObject({
      kind: "thread",
      messages: [{ body: "hello" }],
    });
    data.retry(views.thread("thread-1"));
    await vi.waitFor(() =>
      expect(data.state(views.thread("thread-1")).value).toEqual({ kind: "missing" }),
    );
  });

  it("ignores a superseded read's 404: a newer read has landed, and the store stays as it is", async () => {
    const server = testServer();
    const old = deferred<Answer>();
    server.on(
      "POST",
      "/sync/ws-a/ops/listFiles",
      ops(files(), "0.5.2"),
      () => old.promise,
      ops(files(["a.md", "object-a"]), "0.7.2"),
    );
    const second = deferred<Answer>();
    server.on(
      "GET",
      feedPath("ws-a", "0.5.2"),
      feed({ cursor: "0.6.2", changed: { files: ["object-a"] } }),
    );
    server.on("GET", feedPath("ws-a", "0.6.2"), () => second.promise);
    server.on("GET", feedPath("ws-a", "0.7.2"), held);
    const onGone = vi.fn();
    const cache = createReadCache();
    const data = createWorkspaceData({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      cache,
      onGone,
    });
    data.resume();
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(2));
    second.resolve(feed({ cursor: "0.7.2", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(1));
    old.resolve(NOT_FOUND);
    await settled();
    expect(onGone).not.toHaveBeenCalled();
    expect(data.state(views.files)).toMatchObject({ problem: null, value: [{ path: "a.md" }] });
    expect(cache.entries(cacheScope(signInTo(server), "ws-a"))).toHaveLength(1);
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.7.2"))).toBe(1));
  });

  it("answers a 503 as a failed read and a feed failure, never as a workspace that has gone", async () => {
    const server = testServer();
    const busy: Answer = {
      status: 503,
      body: {
        ok: false,
        error: "Your server can't open workspaces for the phone right now. Try again later.",
        code: "server_busy",
      },
    };
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.5.2"));
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      busy,
      ops({ ok: true, path: "a.md", markdown: "# A" }, "0.5.2"),
    );
    server.on("GET", feedPath("ws-a", "0.5.2"), busy, held);
    const onGone = vi.fn();
    const data = createWorkspaceData({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      cache: createReadCache(),
      onGone,
      sleep: async () => {},
    });
    data.resume();
    data.subscribe(views.files, () => {});
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(data.state(views.page("a.md")).problem).toBe("server-busy"));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    data.retry(views.page("a.md"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" }),
    );
    expect(data.state(views.files).value).toHaveLength(1);
    expect(onGone).not.toHaveBeenCalled();
  });

  it("drops everything of a workspace the server answers 404 for, and stops", async () => {
    const server = testServer();
    const cache = createReadCache();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["a.md", "object-a"]), "0.5.2"));
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    server.on("POST", "/sync/ws-a/ops/documentRead", NOT_FOUND);
    const onGone = vi.fn();
    const data = createWorkspaceData({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      cache,
      onGone,
    });
    data.resume();
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
    expect(data.state(views.files)).toMatchObject({ value: null, problem: "refused" });
    expect(cache.entries(cacheScope(signInTo(server), "ws-a"))).toEqual([]);
    expect(
      server.calls.find((call) => call.path === feedPath("ws-a", "0.5.2"))?.signal.aborted,
    ).toBe(true);
    data.retry(views.files);
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(1);
    data.subscribe(views.chats, () => {});
    expect(data.state(views.chats)).toMatchObject({
      value: null,
      loading: false,
      problem: "refused",
    });
    expect(count(server, "/sync/ws-a/ops/groupsFull")).toBe(0);
  });
});

describe("the change feed", () => {
  it("starts from a read's cursor, and reads again only the views a change can touch", async () => {
    const server = testServer();
    // Each read answers the cursor the server has reached, as the server's own reads do.
    let now = "0.5.2";
    server.on("POST", "/sync/ws-a/ops/listFiles", () =>
      ops(files(["notes/a.md", "object-a"], ["b.md", "object-b"]), now),
    );
    server.on("POST", "/sync/ws-a/ops/groupsFull", () =>
      ops(groups(["channel-1", ["thread-1"]], ["channel-2", ["thread-2"]]), now),
    );
    server.on("POST", "/sync/ws-a/ops/chat", ({ body }) => {
      const args = body as { threadId?: string; group?: string };
      return args.threadId
        ? ops(thread(args.threadId, "hello"), now)
        : ops(
            {
              ok: true,
              stream: {
                group: { id: args.group, name: "planning", kind: "group" },
                items: [],
                nextBefore: null,
                readPosition: null,
              },
            },
            now,
          );
    });
    server.on("POST", "/sync/ws-a/ops/documentRead", () =>
      ops({ ok: true, path: "notes/a.md", markdown: "# A" }, now),
    );
    const first = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => first.promise);
    const { data } = open(server);
    for (const view of [
      views.files,
      views.chats,
      views.thread("thread-1"),
      views.stream("channel-2"),
      views.page("notes/a.md"),
    ])
      data.subscribe(view, () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("notes/a.md")).value).toEqual({ kind: "page", markdown: "# A" }),
    );
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    const reads = () =>
      server.calls
        .filter((call) => call.method === "POST")
        .map((call) => JSON.stringify([call.path.split("/").pop(), call.body]));
    const before = reads().length;

    const second = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.6.2"), () => second.promise);
    now = "0.6.2";
    first.resolve(feed({ cursor: "0.6.2", changed: { chats: ["thread-1"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    await vi.waitFor(() =>
      expect(reads().slice(before).sort()).toEqual([
        JSON.stringify(["chat", { threadId: "thread-1" }]),
        JSON.stringify(["groupsFull", {}]),
      ]),
    );

    const after = reads().length;
    server.on("GET", feedPath("ws-a", "0.7.3"), held);
    now = "0.7.3";
    second.resolve(
      feed({ cursor: "0.7.3", changed: { files: ["object-a"], pages: ["object-a"] } }),
    );
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.7.3"))).toBe(1));
    await vi.waitFor(() =>
      expect(reads().slice(after).sort()).toEqual([
        JSON.stringify(["documentRead", { path: "notes/a.md" }]),
        JSON.stringify(["listFiles", {}]),
      ]),
    );
  });

  it("reads a page again when another object takes its path, before the file listing says so", async () => {
    const server = testServer();
    let now = "0.5.2";
    const listing = deferred<Answer>();
    server.on(
      "POST",
      "/sync/ws-a/ops/listFiles",
      () => ops(files(["a.md", "object-a"]), now),
      () => listing.promise,
    );
    server.on("POST", "/sync/ws-a/ops/documentRead", () =>
      ops({ ok: true, path: "a.md", markdown: "A's text" }, now),
    );
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => change.promise);
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "A's text" }),
    );
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));

    // A is deleted and B made at a.md. The feed names only B, and the listing that would map a.md to B is still held.
    now = "0.6.2";
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      ops({ ok: true, path: "a.md", markdown: "B's text" }, now),
    );
    change.resolve(
      feed({ cursor: "0.6.2", changed: { files: ["object-b"], pages: ["object-b"] } }),
    );
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "B's text" }),
    );
    expect(data.state(views.files).value).toEqual([
      { path: "a.md", objectId: "object-a", page: true },
    ]);
    listing.resolve(ops(files(["a.md", "object-b"]), now));
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
    expect(
      server.calls.find((call) => call.path === feedPath("ws-a", "0.5.2"))?.signal.aborted,
    ).toBe(true);
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
    expect(server.paths().filter((path) => path.includes("since=0.4.2"))).toEqual([]);
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

  it("stops showing an open view's value on replace before its read answers", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(["hidden/a.md", "object-a"]), "0.5.2"));
    const answer = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => answer.promise);
    server.on("GET", feedPath("ws-a", "1.0.0"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(1));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    const reread = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/listFiles", () => reread.promise);
    answer.resolve(feed({ cursor: "1.0.0", replace: true }));
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(2));
    expect(data.state(views.files)).toMatchObject({ value: null, loading: true });
    reread.resolve(ops(files(), "1.0.0"));
    await vi.waitFor(() =>
      expect(data.state(views.files)).toMatchObject({ value: [], loading: false }),
    );
  });

  it("keeps a view's failures through a replace, so a second failure still reports", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"), {
      status: 503,
      body: { ok: false, code: "server_busy" },
    });
    const answer = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => answer.promise);
    server.on("GET", feedPath("ws-a", "1.0.0"), held);
    const { data } = open(server);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toEqual([]));
    await data.refresh(views.files);
    expect(data.state(views.files).failures).toBe(1);
    const reread = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/listFiles", () => reread.promise);
    answer.resolve(feed({ cursor: "1.0.0", replace: true }));
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(3));
    expect(data.state(views.files)).toMatchObject({ value: null, loading: true, failures: 1 });
    reread.resolve({ status: 503, body: { ok: false, code: "server_busy" } });
    await vi.waitFor(() => expect(data.state(views.files).failures).toBe(2));
  });

  it("shows nothing it saved under two reaches, and reads afresh", async () => {
    const server = testServer();
    const cache = createReadCache();
    const scope = cacheScope(signInTo(server), "ws-a", "member");
    cache.set(scope, {
      view: views.files,
      value: files(["a.md", "object-a"]).files,
      cursor: "0.5.2.0123456789abcdef",
      stale: false,
    });
    cache.set(scope, {
      view: views.chats,
      value: [],
      cursor: "0.4.2.fedcba9876543210",
      stale: false,
    });
    server.on("POST", "/sync/ws-a/ops/listFiles", held);
    const data = createWorkspaceData({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      role: "member",
      cache,
    });
    expect(data.state(views.files).value).toBeNull();
    expect(cache.entries(scope)).toEqual([]);
    data.stop();
  });

  it("opens a joined workspace afresh on replace, and refreshes the owner's in place", async () => {
    for (const [role, opens] of [
      ["member", 1],
      ["owner", 0],
    ] as const) {
      const server = testServer();
      server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
      const answer = deferred<Answer>();
      server.on("GET", feedPath("ws-a", "0.5.2"), () => answer.promise);
      server.on("GET", feedPath("ws-a", "1.0.0"), held);
      let reopened = 0;
      const data = createWorkspaceData({
        signIn: signInTo(server),
        workspaceId: "ws-a",
        role,
        cache: createReadCache(),
        reopen: () => void reopened++,
      });
      data.resume();
      data.subscribe(views.files, () => {});
      await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
      answer.resolve(feed({ cursor: "1.0.0", replace: true }));
      await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(2));
      expect(reopened, role).toBe(opens);
      data.stop();
    }
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
    await vi.waitFor(() =>
      expect(data.state(views.thread("thread-1")).value).toMatchObject({
        messages: [{ body: "after the change" }],
      }),
    );
  });

  it("backs off after a failure, doubling the wait, then carries on", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    server.on(
      "GET",
      feedPath("ws-a", "0.5.2"),
      { status: 503 },
      "offline",
      feed({ cursor: "0.6.2", changed: {} }),
    );
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    const waits: number[] = [];
    const { data } = open(server, "ws-a", createReadCache(), async (ms) => {
      waits.push(ms);
    });
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
    expect(
      server.calls.find((call) => call.path === feedPath("ws-a", "0.5.2"))?.signal.aborted,
    ).toBe(true);
    data.resume();
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
  });
});

describe("a failing feed", () => {
  const busy: Answer = { status: 503 };

  /** A feed whose answers are scripted, and whose backoff waits each last until the test lets them end. */
  async function failing(...answers: (Answer | (() => Promise<Answer>))[]) {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(files(), "0.5.2"));
    server.on("GET", feedPath("ws-a", "0.5.2"), ...answers);
    const waits: number[] = [];
    const ends: (() => void)[] = [];
    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        waits.push(ms);
        ends.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { data } = open(server, "ws-a", createReadCache(), sleep);
    data.subscribe(views.files, () => {});
    const pass = async (waited: number) => {
      await vi.waitFor(() => expect(waits).toHaveLength(waited));
      ends[waited - 1]!();
    };
    return { server, data, waits, pass, requests: () => count(server, feedPath("ws-a", "0.5.2")) };
  }

  it("shows its failure after three in a row, and only once", async () => {
    const { data, waits, pass, requests } = await failing(busy, busy, busy, busy, held);
    await pass(1);
    await pass(2);
    await vi.waitFor(() => expect(requests()).toBe(3));
    expect(data.feed().problem).toBeNull();
    await vi.waitFor(() => expect(waits).toHaveLength(FEED_FAILURES_SHOWN));
    expect(data.feed()).toEqual({ problem: "server-busy", failures: 1 });
    await pass(3);
    await pass(4);
    await vi.waitFor(() => expect(requests()).toBe(5));
    expect(data.feed()).toEqual({ problem: "server-busy", failures: 1 });
    expect(waits).toEqual([1, 2, 4, 8].map((times) => times * FEED_RETRY_MS));
  });

  it("starts again at once on Try again, with its backoff from the start", async () => {
    const { server, data, waits, pass, requests } = await failing(busy, busy, busy, held);
    await pass(1);
    await pass(2);
    await vi.waitFor(() => expect(waits).toHaveLength(FEED_FAILURES_SHOWN));
    expect(data.feed().problem).toBe("server-busy");
    // Try again during the third wait, which is never let end.
    server.on("GET", feedPath("ws-a", "0.5.2"), busy, held);
    data.retryFeed();
    await vi.waitFor(() => expect(waits).toHaveLength(FEED_FAILURES_SHOWN + 1));
    expect(requests()).toBe(FEED_FAILURES_SHOWN + 1);
    expect(waits).toEqual([1, 2, 4, 1].map((times) => times * FEED_RETRY_MS));
    // One failure since Try again: the failure shown stays until an answer, and isn't shown again.
    expect(data.feed()).toEqual({ problem: "server-busy", failures: 1 });
  });

  it("takes its failure back at the next answer", async () => {
    const { server, data, pass, requests } = await failing(
      busy,
      busy,
      busy,
      feed({ cursor: "0.6.2", changed: {} }),
    );
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    for (const waited of [1, 2, 3]) await pass(waited);
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    expect(requests()).toBe(FEED_FAILURES_SHOWN + 1);
    expect(data.feed()).toEqual({ problem: null, failures: 1 });
  });

  it("counts no failure from before the background once it returns", async () => {
    const { server, data, waits, pass } = await failing(busy, busy, held);
    await pass(1);
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    data.pause();
    server.on("GET", feedPath("ws-a", "0.5.2"), "offline", held);
    data.resume();
    await vi.waitFor(() => expect(waits).toHaveLength(3));
    expect(waits).toEqual([1, 2, 1].map((times) => times * FEED_RETRY_MS));
    expect(data.feed().problem).toBeNull();
  });
});

describe("the read cache and the sign-in", () => {
  const SAVED: StoredSignIn = {
    origin: "https://dohc.example.com",
    token: "tok-1",
    userId: "u-1",
    email: "ice@example.com",
  };

  async function signedIn() {
    const server = testServer();
    serveSessionEnd(server);
    const account = createAccount({
      store: memoryStore(SAVED).store,
      fetch: server.fetch,
      sleep: async () => {},
    });
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
    await vi.waitFor(() =>
      expect(account.state()).toMatchObject({ status: "signed-out", ended: true }),
    );
    await settled();
    expect(cache.entries(scope)).toHaveLength(0);
    expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1);
    expect(server.paths().filter((path) => path.includes("/ops/"))).toHaveLength(2);
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
      expect(server.calls.find((call) => call.path === path)?.signal.aborted, path).toBe(true);
    }
    page.resolve(ops({ ok: true, path: "a.md", markdown: "# A" }, "0.6.0"));
    await settled();
    expect(data.state(views.page("a.md")).value).toBeNull();
    expect(cache.entries(scope)).toHaveLength(0);
    expect(server.paths().filter((path) => path.includes("/ops/"))).toHaveLength(3);
  });
});

describe("a workspace's read marks", () => {
  it("sends none in a workspace the account joined", async () => {
    const server = testServer();
    const data = createWorkspaceData({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      role: "member",
      cache: createReadCache(),
    });
    await data.markRead("thread-1", "message-1");
    expect(count(server, "/sync/ws-a/ops/markRead")).toBe(0);
    data.stop();
  });

  it("sends a thread's mark at a message once, again after it fails, and none once the store stops", async () => {
    const server = testServer();
    const path = "/sync/ws-a/ops/markRead";
    server.on(
      "POST",
      path,
      ops({ ok: true }, "0.1.1"),
      { status: 503, body: { ok: false, code: "server_busy" } },
      ops({ ok: true }, "0.1.1"),
    );
    const { data } = open(server);
    data.markRead("thread-1", "message-1");
    data.markRead("thread-1", "message-1");
    await vi.waitFor(() => expect(count(server, path)).toBe(1));
    data.markRead("thread-1", "message-2");
    await vi.waitFor(() => expect(count(server, path)).toBe(2));
    // The failed mark is sent again once a screen shows the message again, after the failure lands.
    await vi.waitFor(() => {
      data.markRead("thread-1", "message-2");
      expect(count(server, path)).toBe(3);
    });
    expect(server.calls.filter((call) => call.path === path).map((call) => call.body)).toEqual([
      { threadId: "thread-1", messageId: "message-1" },
      { threadId: "thread-1", messageId: "message-2" },
      { threadId: "thread-1", messageId: "message-2" },
    ]);
    data.stop();
    data.markRead("thread-2", "message-3");
    await settled();
    expect(count(server, path)).toBe(3);
  });
});

describe("a read mark the server couldn't send", () => {
  it("counts as unsent, so the next showing sends it again, and one the server took is not sent again", async () => {
    const server = testServer();
    const path = "/sync/ws-a/ops/markRead";
    server.on(
      "POST",
      path,
      ops({ ok: false, reason: "Couldn't send" }, "0.1.1"),
      ops({ ok: true }, "0.1.1"),
    );
    const { data } = open(server);
    await data.markRead("thread-1", "message-1");
    expect(count(server, path)).toBe(1);
    await data.markRead("thread-1", "message-1");
    expect(count(server, path)).toBe(2);
    await data.markRead("thread-1", "message-1");
    expect(count(server, path)).toBe(2);
  });

  it("stops and clears the store when a mark finds the workspace gone, and sends nothing after", async () => {
    const server = testServer();
    const path = "/sync/ws-a/ops/markRead";
    server.on("POST", path, NOT_FOUND);
    const onGone = vi.fn();
    const data = createWorkspaceData({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      cache: createReadCache(),
      onGone,
    });
    data.resume();
    await data.markRead("thread-1", "message-1");
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(data.state(views.files)).toMatchObject({ value: null, problem: "refused" });
    await data.markRead("thread-2", "message-2");
    expect(count(server, path)).toBe(1);
  });
});

describe("a chat read before it opens", () => {
  const stream = (group: string): Answer =>
    ops(
      {
        ok: true,
        stream: {
          group: { id: group, name: group, kind: "group" },
          items: [],
          nextBefore: null,
          readPosition: null,
        },
      },
      "0.5.2",
    );

  it("reads once, and the screen that opens it reads nothing more", async () => {
    const server = testServer();
    const answer = deferred<Answer>();
    server.on("POST", "/sync/ws-a/ops/chat", () => answer.promise);
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    const { data } = open(server);
    const view = views.stream("channel-1");
    data.prefetch(view);
    data.prefetch(view);
    data.subscribe(view, () => {});
    answer.resolve(stream("channel-1"));
    await vi.waitFor(() => expect(data.state(view).value).toMatchObject({ kind: "stream" }));
    data.prefetch(view);
    await settled();
    expect(count(server, "/sync/ws-a/ops/chat")).toBe(1);
  });

  it("never marks a chat read ahead as a page no screen has shown", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/chat", stream("channel-1"));
    server.on("GET", feedPath("ws-a", "0.5.2"), held);
    const cache = createReadCache();
    const { data } = open(server, "ws-a", cache);
    const view = views.stream("channel-1");
    data.prefetch(view);
    await vi.waitFor(() => expect(data.state(view).value).toMatchObject({ kind: "stream" }));
    expect(cache.get(cacheScope(signInTo(server), "ws-a"), view.id)?.prefetched).toBeUndefined();
  });

  it("reads again only once a change makes it stale", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/chat", stream("channel-1"));
    server.on("POST", "/sync/ws-a/ops/groupsFull", ops(groups(), "0.5.2"));
    const changed = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => changed.promise);
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    const { data } = open(server);
    const view = views.stream("channel-1");
    data.prefetch(view);
    await vi.waitFor(() => expect(data.state(view).value).toMatchObject({ kind: "stream" }));
    data.prefetch(view);
    await settled();
    expect(count(server, "/sync/ws-a/ops/chat")).toBe(1);

    changed.resolve(feed({ cursor: "0.6.2", changed: { chats: [] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.6.2"))).toBe(1));
    data.prefetch(view);
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/chat")).toBe(2));
  });
});

describe("prefetching pages", () => {
  const page = (markdown: string) => ops({ ok: true, path: "p.md", markdown }, "0.1.1");
  const reads = (server: Server) =>
    server.calls.filter((call) => call.path.endsWith("/ops/documentRead")).length;
  function serve(workspaceId: string, ...answers: Parameters<Server["on"]>[2][]) {
    const server = testServer();
    server.on("POST", `/sync/${workspaceId}/ops/documentRead`, ...answers);
    server.on("GET", feedPath(workspaceId, "0.1.1"), held);
    return server;
  }
  const paths = (count: number) => Array.from({ length: count }, (_, index) => `p${index}.md`);

  it("reads only views with no value, two at a time, and ten per workspace in a run", async () => {
    const waiting: ReturnType<typeof deferred<Answer>>[] = [];
    const server = serve("ws-prefetch-cap", () => {
      const answer = deferred<Answer>();
      waiting.push(answer);
      return answer.promise;
    });
    const cache = createReadCache();
    const { data } = open(server, "ws-prefetch-cap", cache);
    const close = data.subscribe(views.page("p0.md"), () => {});
    await vi.waitFor(() => expect(reads(server)).toBe(1));
    waiting.shift()!.resolve(page("Shown"));
    await vi.waitFor(() => expect(data.state(views.page("p0.md")).value).not.toBeNull());
    close();

    data.prefetchPages(paths(14));
    await settled();
    expect(reads(server)).toBe(1 + PREFETCH_AT_ONCE);
    while (waiting.length > 0) {
      waiting.shift()!.resolve(page("Read ahead"));
      await settled();
      expect(waiting.length).toBeLessThanOrEqual(PREFETCH_AT_ONCE);
    }
    expect(reads(server)).toBe(1 + PREFETCH_MAX);
    expect(data.state(views.page("p1.md")).value).toEqual({ kind: "page", markdown: "Read ahead" });
    expect(data.state(views.page("p0.md")).value).toEqual({ kind: "page", markdown: "Shown" });

    data.prefetchPages(["other.md"]);
    await settled();
    expect(reads(server)).toBe(1 + PREFETCH_MAX);
    data.stop();
    const again = open(server, "ws-prefetch-cap", cache).data;
    again.prefetchPages(["other.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(2 + PREFETCH_MAX));
  });

  it("reads ten pages ahead in each folder", async () => {
    const server = serve("ws-prefetch-folders", page("Read ahead"));
    const { data } = open(server, "ws-prefetch-folders");
    data.prefetchPages([...paths(12), ...paths(12).map((path) => `notes/${path}`)]);
    await vi.waitFor(() => expect(reads(server)).toBe(2 * PREFETCH_MAX));
    await settled();
    expect(reads(server)).toBe(2 * PREFETCH_MAX);
    expect(data.state(views.page("notes/p9.md")).value).not.toBeNull();
  });

  it("doesn't count a failed read ahead, and tries each page once in a run", async () => {
    const busy: Answer = { status: 503, body: { ok: false, error: "busy", code: "server_busy" } };
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/documentRead", (call) =>
      (call.body as { path: string }).path.endsWith("bad.md") ? busy : page("Read ahead"),
    );
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.prefetchPages(["bad.md", ...paths(PREFETCH_MAX)]);
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_MAX + 1));
    expect(data.state(views.page(`p${PREFETCH_MAX - 1}.md`)).value).not.toBeNull();

    data.prefetchPages(["notes/bad.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_MAX + 2));
    data.prefetchPages(["notes/bad.md"]);
    await settled();
    expect(reads(server)).toBe(PREFETCH_MAX + 2);
    expect(data.state(views.page("notes/bad.md")).value).toBeNull();
  });

  it("reads the pages listed last first", async () => {
    const waiting: ReturnType<typeof deferred<Answer>>[] = [];
    const server = serve("ws-prefetch-order", () => {
      const answer = deferred<Answer>();
      waiting.push(answer);
      return answer.promise;
    });
    const { data } = open(server, "ws-prefetch-order");
    data.prefetchPages(paths(4));
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_AT_ONCE));
    data.prefetchPages(["notes/a.md", "notes/b.md", "p3.md"]);
    waiting.shift()!.resolve(page("Read ahead"));
    waiting.shift()!.resolve(page("Read ahead"));
    await vi.waitFor(() => expect(reads(server)).toBe(4));
    const bodies = () =>
      server.calls
        .filter((call) => call.path.endsWith("/ops/documentRead"))
        .map((call) => call.body);
    expect(bodies().slice(-2)).toEqual([{ path: "notes/a.md" }, { path: "notes/b.md" }]);
    waiting.shift()!.resolve(page("Read ahead"));
    await vi.waitFor(() => expect(reads(server)).toBe(5));
    expect(bodies().at(-1)).toEqual({ path: "p3.md" });
  });

  it("reads a page listed twice in one batch once", async () => {
    const server = serve("ws-prefetch-twice", page("Read ahead"));
    const { data } = open(server, "ws-prefetch-twice");
    data.prefetchPages(["a.md", "a.md"]);
    await vi.waitFor(() => expect(data.state(views.page("a.md")).value).not.toBeNull());
    await settled();
    expect(reads(server)).toBe(1);
  });

  it("counts only pages that read toward a folder's ten", async () => {
    const missing = ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.1.1");
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/documentRead", (call) =>
      (call.body as { path: string }).path.startsWith("gone") ? missing : page("Read ahead"),
    );
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.prefetchPages([...paths(PREFETCH_MAX).map((path) => `gone-${path}`), ...paths(2)]);
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_MAX + 2));
    expect(data.state(views.page("p1.md")).value).not.toBeNull();
  });

  it("aborts read-ahead on its way when a screen reads, and reads it again after", async () => {
    const shown = deferred<Answer>();
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      () => new Promise<Answer>(() => {}),
      () => shown.promise,
      page("Read ahead"),
    );
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(1));
    data.subscribe(views.page("open.md"), () => {});
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    expect(
      server.calls.find((call) => call.path.endsWith("/ops/documentRead"))?.signal.aborted,
    ).toBe(true);
    shown.resolve(page("Shown"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({
        kind: "page",
        markdown: "Read ahead",
      }),
    );
  });

  it("reads a page a person's read aborted after the batches listed since", async () => {
    const shown = deferred<Answer>();
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      () => new Promise<Answer>(() => {}),
      () => new Promise<Answer>(() => {}),
      () => shown.promise,
      page("Read ahead"),
    );
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    const { data } = open(server);
    data.prefetchPages(["a.md", "b.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_AT_ONCE));
    data.prefetchPages(["c.md"]);
    data.subscribe(views.page("open.md"), () => {});
    shown.resolve(page("Shown"));
    await vi.waitFor(() => expect(reads(server)).toBe(6));
    const bodies = server.calls
      .filter((call) => call.path.endsWith("/ops/documentRead"))
      .map((call) => call.body);
    expect(bodies.slice(3)).toEqual([{ path: "c.md" }, { path: "a.md" }, { path: "b.md" }]);
  });

  it("gives Notices' pages their own ten", async () => {
    const server = serve("ws-prefetch-notices", page("Read ahead"));
    const { data } = open(server, "ws-prefetch-notices");
    data.prefetchPages(paths(PREFETCH_MAX));
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_MAX));
    data.prefetchPages(["noted.md"], "notices");
    await vi.waitFor(() => expect(data.state(views.page("noted.md")).value).not.toBeNull());
  });

  it("keeps reading ahead while the feed rereads an open page", async () => {
    const change = deferred<Answer>();
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      page("Shown"),
      () => new Promise<Answer>(() => {}),
      page("Shown again"),
    );
    server.on("GET", feedPath("ws-a", "0.1.1"), () => change.promise);
    server.on("GET", feedPath("ws-a", "0.2.1"), held);
    const { data } = open(server);
    data.subscribe(views.page("open.md"), () => {});
    await vi.waitFor(() => expect(data.state(views.page("open.md")).value).not.toBeNull());
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    change.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() =>
      expect(data.state(views.page("open.md")).value).toEqual({
        kind: "page",
        markdown: "Shown again",
      }),
    );
    const ahead = server.calls.filter((call) => call.path.endsWith("/ops/documentRead"))[1];
    expect(ahead?.body).toEqual({ path: "a.md" });
    expect(ahead?.signal.aborted).toBe(false);
  });

  it("waits for a screen's read, and shares two reads at once across the sign-in's stores", async () => {
    const shown = deferred<Answer>();
    const ahead = deferred<Answer>();
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      () => shown.promise,
      () => ahead.promise,
    );
    server.on("POST", "/sync/ws-b/ops/documentRead", page("Read ahead"));
    server.on("GET", feedPath("ws-a", "0.1.1"), held);
    server.on("GET", feedPath("ws-b", "0.1.1"), held);
    const signIn = signInTo(server);
    const cache = createReadCache();
    const a = createWorkspaceData({ signIn, workspaceId: "ws-a", cache });
    const b = createWorkspaceData({ signIn, workspaceId: "ws-b", cache });
    a.resume();
    b.resume();
    a.subscribe(views.page("open.md"), () => {});
    a.prefetchPages(["a1.md", "a2.md"]);
    b.prefetchPages(["b1.md"]);
    await settled();
    expect(reads(server)).toBe(1);

    shown.resolve(page("Shown"));
    await vi.waitFor(() => expect(reads(server)).toBe(1 + PREFETCH_AT_ONCE));
    expect(count(server, "/sync/ws-b/ops/documentRead")).toBe(0);
    ahead.resolve(page("Read ahead"));
    await vi.waitFor(() => expect(count(server, "/sync/ws-b/ops/documentRead")).toBe(1));
  });

  it("leaves a view empty, with no problem, when its prefetch fails, and the open reads it", async () => {
    const busy: Answer = { status: 503, body: { ok: false, error: "busy", code: "server_busy" } };
    const server = serve("ws-prefetch-fail", busy, page("Read on open"));
    const { data } = open(server, "ws-prefetch-fail");
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(1));
    await settled();
    expect(data.state(views.page("a.md"))).toEqual({
      value: null,
      loading: false,
      problem: null,
      failures: 0,
    });
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({
        kind: "page",
        markdown: "Read on open",
      }),
    );
  });

  it("keeps a prefetched page's text as its last once a screen opens it, in memory and in the cache", async () => {
    const gone = ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.1.1");
    const server = serve("ws-prefetch-opened", page("Seen text"), gone);
    const cache = createReadCache();
    const { data } = open(server, "ws-prefetch-opened", cache);
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(data.state(views.page("a.md")).value).not.toBeNull());
    const scope = cacheScope(signInTo(server), "ws-prefetch-opened");
    expect(cache.get(scope, "page:a.md")?.prefetched).toBe(true);
    data.subscribe(views.page("a.md"), () => {});
    expect(cache.get(scope, "page:a.md")?.prefetched).toBeUndefined();
    data.retry(views.page("a.md"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "Seen text" }),
    );
  });

  it("keeps a prefetched page's text, stale, through a change, and none as its last if no screen showed it before it went", async () => {
    const gone = ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.2.1");
    const reread = deferred<Answer>();
    const server = serve("ws-prefetch-changed", page("Old text"), () => reread.promise);
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-changed", "0.1.1"), () => change.promise);
    server.on("GET", feedPath("ws-prefetch-changed", "0.2.1"), held);
    const { data } = open(server, "ws-prefetch-changed");
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(data.state(views.page("a.md")).value).not.toBeNull());
    change.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-prefetch-changed", "0.2.1"))).toBe(1));
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "Old text" });

    data.subscribe(views.page("a.md"), () => {});
    expect(data.state(views.page("a.md"))).toMatchObject({
      value: { kind: "page", markdown: "Old text" },
      loading: true,
    });
    reread.resolve(gone);
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing" }),
    );
  });

  it("keeps a page's last text once a screen's own read of it has landed", async () => {
    const gone = ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.2.1");
    const server = serve("ws-prefetch-reread", page("Old text"), page("New text"), gone);
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-reread", "0.1.1"), () => change.promise);
    server.on("GET", feedPath("ws-prefetch-reread", "0.2.1"), held);
    const { data } = open(server, "ws-prefetch-reread");
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(data.state(views.page("a.md")).value).not.toBeNull());
    change.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-prefetch-reread", "0.2.1"))).toBe(1));
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "New text" }),
    );
    data.retry(views.page("a.md"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "New text" }),
    );
  });

  it("keeps a shown page's last text when its deletion lands after the screen closed", async () => {
    const deletion = deferred<Answer>();
    const missing = (cursor: string) =>
      ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, cursor);
    const server = serve(
      "ws-prefetch-left",
      page("Seen text"),
      () => deletion.promise,
      missing("0.3.1"),
    );
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-left", "0.1.1"), () => first.promise);
    server.on("GET", feedPath("ws-prefetch-left", "0.2.1"), () => second.promise);
    server.on("GET", feedPath("ws-prefetch-left", "0.3.1"), held);
    const { data } = open(server, "ws-prefetch-left");
    const close = data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "Seen text" }),
    );
    first.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    close();
    deletion.resolve(missing("0.2.1"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "Seen text" }),
    );
    second.resolve(feed({ cursor: "0.3.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-prefetch-left", "0.3.1"))).toBe(1));

    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(reads(server)).toBe(3));
    await settled();
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "Seen text" });
  });

  it("keeps no last text from a refresh that landed after the screen closed", async () => {
    const refresh = deferred<Answer>();
    const server = serve(
      "ws-prefetch-refreshed",
      page("Seen text"),
      () => refresh.promise,
      ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.3.1"),
    );
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-refreshed", "0.1.1"), () => first.promise);
    server.on("GET", feedPath("ws-prefetch-refreshed", "0.2.1"), () => second.promise);
    server.on("GET", feedPath("ws-prefetch-refreshed", "0.3.1"), held);
    const { data } = open(server, "ws-prefetch-refreshed");
    const close = data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "Seen text" }),
    );
    first.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    close();
    refresh.resolve(ops({ ok: true, path: "a.md", markdown: "Never shown" }, "0.2.1"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({
        kind: "page",
        markdown: "Never shown",
      }),
    );
    second.resolve(feed({ cursor: "0.3.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() =>
      expect(count(server, feedPath("ws-prefetch-refreshed", "0.3.1"))).toBe(1),
    );

    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(reads(server)).toBe(3));
    await settled();
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing" });
  });

  it("keeps the last text from a refresh that landed unchanged after the screen closed", async () => {
    const refresh = deferred<Answer>();
    const server = serve(
      "ws-prefetch-unchanged",
      page("Seen text"),
      () => refresh.promise,
      ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.3.1"),
    );
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-unchanged", "0.1.1"), () => first.promise);
    server.on("GET", feedPath("ws-prefetch-unchanged", "0.2.1"), () => second.promise);
    server.on("GET", feedPath("ws-prefetch-unchanged", "0.3.1"), held);
    const { data } = open(server, "ws-prefetch-unchanged");
    const close = data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "Seen text" }),
    );
    first.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    close();
    refresh.resolve(ops({ ok: true, path: "a.md", markdown: "Seen text" }, "0.2.1"));
    await settled();
    second.resolve(feed({ cursor: "0.3.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() =>
      expect(count(server, feedPath("ws-prefetch-unchanged", "0.3.1"))).toBe(1),
    );

    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(reads(server)).toBe(3));
    await settled();
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "Seen text" });
  });

  it("marks unseen a refresh that turned a too-large page missing after the screen closed", async () => {
    const refresh = deferred<Answer>();
    const tooLarge = ops(
      { ok: false, reason: "dohc: This page is too large to open here.", refusal: "too-large" },
      "0.1.1",
    );
    const server = serve("ws-prefetch-kind", tooLarge, () => refresh.promise);
    const first = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-kind", "0.1.1"), () => first.promise);
    server.on("GET", feedPath("ws-prefetch-kind", "0.2.1"), held);
    const cache = createReadCache();
    const { data } = open(server, "ws-prefetch-kind", cache);
    const close = data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "too-large" }),
    );
    first.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-a"] } }));
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    close();
    refresh.resolve(ops({ ok: false, reason: "dohc: No document.", refusal: "missing" }, "0.2.1"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing" }),
    );
    const scope = cacheScope(signInTo(server), "ws-prefetch-kind");
    expect(cache.get(scope, "page:a.md")?.prefetched).toBe(true);
  });

  it("keeps ten prefetched pages through a file change, and reads none of them again until opened", async () => {
    const server = serve("ws-prefetch-ten", page("Read ahead"));
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-prefetch-ten", "0.1.1"), () => change.promise);
    server.on("GET", feedPath("ws-prefetch-ten", "0.2.1"), held);
    const { data } = open(server, "ws-prefetch-ten");
    data.prefetchPages(paths(PREFETCH_MAX));
    await vi.waitFor(() => expect(reads(server)).toBe(PREFETCH_MAX));
    await settled();
    change.resolve(feed({ cursor: "0.2.1", changed: { files: ["object-z"] } }));
    await vi.waitFor(() => expect(count(server, feedPath("ws-prefetch-ten", "0.2.1"))).toBe(1));
    data.prefetchPages(paths(PREFETCH_MAX));
    await settled();
    expect(reads(server)).toBe(PREFETCH_MAX);
    for (const path of paths(PREFETCH_MAX))
      expect(data.state(views.page(path)).value).toEqual({ kind: "page", markdown: "Read ahead" });
  });

  it("reads a page once when Home lists it again while it's queued or reading", async () => {
    const waiting: ReturnType<typeof deferred<Answer>>[] = [];
    const server = serve("ws-prefetch-twice", () => {
      const answer = deferred<Answer>();
      waiting.push(answer);
      return answer.promise;
    });
    const { data } = open(server, "ws-prefetch-twice");
    data.prefetchPages(["a.md", "b.md"]);
    await settled();
    data.prefetchPages(["a.md", "b.md", "c.md"]);
    waiting.shift()!.resolve({
      status: 503,
      body: { ok: false, error: "busy", code: "server_busy" },
    });
    await settled();
    while (waiting.length > 0) {
      waiting.shift()!.resolve(page("Read ahead"));
      await settled();
    }
    const paths = server.calls.map((call) => (call.body as { path?: string } | undefined)?.path);
    expect(paths.filter(Boolean)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("reads nothing while the store is in the background or after it stops", async () => {
    const server = serve("ws-prefetch-paused", page("Later"));
    const { data } = open(server, "ws-prefetch-paused");
    data.pause();
    data.prefetchPages(["a.md"]);
    await settled();
    expect(reads(server)).toBe(0);
    data.resume();
    await vi.waitFor(() => expect(reads(server)).toBe(1));

    data.stop();
    data.prefetchPages(["b.md"]);
    await settled();
    expect(reads(server)).toBe(1);
  });

  it("promotes an in-flight read-ahead when a person opens that same view instead of aborting and restarting it", async () => {
    const a = deferred<Answer>();
    const b = deferred<Answer>();
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-promote/ops/documentRead",
      () => a.promise,
      () => b.promise,
    );
    server.on("GET", feedPath("ws-promote", "0.1.1"), held);
    const { data } = open(server, "ws-promote");
    data.prefetchPages(["a.md", "b.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(2));
    const [callA, callB] = server.calls.filter((call) => call.path.endsWith("/ops/documentRead"));

    data.subscribe(views.page("a.md"), () => {});
    expect(reads(server)).toBe(2);
    expect(callA?.signal.aborted).toBe(false);
    expect(callB?.signal.aborted).toBe(true);
    expect(data.state(views.page("a.md")).loading).toBe(true);

    a.resolve(page("Promoted"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md"))).toMatchObject({
        value: { kind: "page", markdown: "Promoted" },
        loading: false,
      }),
    );
    expect(reads(server)).toBe(3);
  });

  it("surfaces errors when a promoted read-ahead fails", async () => {
    const a = deferred<Answer>();
    const server = testServer();
    server.on("POST", "/sync/ws-promote-err/ops/documentRead", () => a.promise);
    const { data } = open(server, "ws-promote-err");
    data.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(reads(server)).toBe(1));
    data.subscribe(views.page("a.md"), () => {});
    expect(data.state(views.page("a.md")).loading).toBe(true);
    a.resolve({ status: 503, body: { ok: false, error: "busy", code: "server_busy" } });
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md"))).toMatchObject({
        loading: false,
        problem: "server-busy",
        failures: 1,
      }),
    );
  });

  it("caps prefetchAhead views at PREFETCH_AT_ONCE, yields and requeues on a different tap, and ignores background errors", async () => {
    let active = 0;
    let maxActive = 0;
    const waiters: ReturnType<typeof deferred<Answer>>[] = [];
    const foreground = deferred<Answer>();
    const server = testServer();
    server.on("POST", "/sync/ws-ahead/ops/chat", () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const wait = deferred<Answer>();
      waiters.push(wait);
      return wait.promise.finally(() => {
        active -= 1;
      });
    });
    server.on("POST", "/sync/ws-ahead/ops/documentRead", () => foreground.promise);
    server.on("POST", "/sync/ws-ahead/ops/listFiles", {
      status: 503,
      body: { ok: false, error: "busy", code: "server_busy" },
    });
    server.on("GET", feedPath("ws-ahead", "0.1.1"), held);
    const { data } = open(server, "ws-ahead");
    data.prefetchAhead([
      views.stream("g-1"),
      views.stream("g-2"),
      views.stream("g-3"),
      views.files,
    ]);
    await vi.waitFor(() => expect(waiters).toHaveLength(PREFETCH_AT_ONCE));
    expect(maxActive).toBe(PREFETCH_AT_ONCE);

    const firstCalls = server.calls.filter((call) => call.path.endsWith("/ops/chat"));
    data.subscribe(views.page("open.md"), () => {});
    await vi.waitFor(() => expect(reads(server)).toBe(1));
    expect(firstCalls.every((call) => call.signal.aborted)).toBe(true);
    waiters.shift()!.resolve({ status: 503 });
    waiters.shift()!.resolve({ status: 503 });
    foreground.resolve(page("Opened"));

    const streamAnswer = (id: string): Answer =>
      ops(
        {
          ok: true,
          stream: {
            group: { id, name: id, kind: "group" },
            items: [],
            readPosition: null,
          },
        },
        "0.1.1",
      );
    await vi.waitFor(() => expect(waiters.length).toBeGreaterThanOrEqual(1));
    while (
      count(server, "/sync/ws-ahead/ops/listFiles") === 0 ||
      waiters.length > 0 ||
      !data.state(views.stream("g-1")).value ||
      !data.state(views.stream("g-2")).value ||
      !data.state(views.stream("g-3")).value
    ) {
      if (waiters.length > 0) waiters.shift()!.resolve(streamAnswer("g"));
      await settled();
    }
    expect(maxActive).toBe(PREFETCH_AT_ONCE);
    expect(data.state(views.files)).toMatchObject({ value: null, problem: null, failures: 0 });
  });
});
