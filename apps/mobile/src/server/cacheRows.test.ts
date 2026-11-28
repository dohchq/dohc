import { existsSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRunner, createWorkspaceApps } from "../apps/appStore";
import { createWorkspaceCollections } from "../collections/collectionStore";
import { createScopedEnds } from "../pages/pageLive";
import { createAccount, type StoredSignIn } from "./account";
import {
  createCacheRows,
  leastJsonBytes,
  SCOPE_MAX_BYTES,
  WRITE_DELAY_MS,
  WRITE_INTERVAL_MS,
  WRITE_MAX_DELAY_MS,
  type CacheRows,
  type SavedView,
} from "./cacheRows";
import { createServerClient } from "./client";
import { CACHE_FORMAT, openNow } from "./keptStore";
import { createOpenWorkspace } from "./openWorkspace";
import { pendingSignOuts } from "./pushRegistration";
import { A, memberPage, page, version } from "./testApps";
import { keptDisk, type KeptDisk } from "./testKeptDisk";
import { deferred, memoryStore, serveSessionEnd, testServer, type Answer } from "./testServer";
import {
  cacheScope,
  createReadCache,
  createWorkspaceData,
  views,
  type ReadCache,
} from "./workspaceData";
import { createWorkspaceList, workspaceGap } from "./workspaceList";
import { FEED_HOLD_MS } from "./workspaceReads";

// The read cache on cache.db, through Node's SQLite (testKeptDisk.ts). Each launch is one run of the app over the same
// files; a held commit holds the cache's queue, as a slow save would.

let clock = 0;
const made: CacheRows[] = [];
function launch(disk: KeptDisk, options: { totalMaxBytes?: number; now?: () => number } = {}) {
  const files = createCacheRows(disk.cache.launch(), { now: () => ++clock, ...options });
  made.push(files);
  return { files, cache: createReadCache(files) };
}
// A test's last write waits on a timer: it lands before the test's files are deleted.
afterEach(async () => {
  for (const files of made.splice(0)) await files.flush();
});

/** The scopes cache.db holds views for, in order. */
const stored = (disk: KeptDisk) =>
  disk.cache.sql("SELECT scope FROM views ORDER BY scope").map((row) => String(row.scope));
const sizeOf = (disk: KeptDisk, scope: string) =>
  Number(disk.cache.sql("SELECT bytes FROM views WHERE scope = ?", scope)[0]?.bytes);

const SCOPE_A = JSON.stringify(["https://dohc.example.com", "u-1", "ws-a"]);
const SCOPE_B = JSON.stringify(["https://dohc.example.com", "u-1", "ws-b"]);
const saved = (id: string, value: unknown, cursor = "0.5.2", stale = false): SavedView => ({
  id,
  value,
  cursor,
  stale,
});

describe("a scope's row", () => {
  it("keeps each view's value, cursor and staleness across a relaunch", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    const views = [
      saved("files", [{ path: "a.md", objectId: "object-a", page: true }]),
      saved("page:a.md", { kind: "page", markdown: "# A" }, "0.6.1", true),
    ];
    files.write(SCOPE_A, () => views);
    await files.flush();
    expect(stored(disk)).toEqual([SCOPE_A]);
    await expect(launch(disk).files.read(SCOPE_A)).resolves.toEqual(views);
  });

  it("is deleted when it doesn't parse or doesn't hold views", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    for (const text of ['[{"id":', JSON.stringify([{ id: "files", cursor: "0.5.2" }])]) {
      disk.cache.sql(
        "INSERT OR REPLACE INTO views (scope, value, bytes, used_at) VALUES (?, ?, 1, 0)",
        SCOPE_A,
        text,
      );
      await expect(files.read(SCOPE_A)).resolves.toEqual([]);
      expect(stored(disk), text).toEqual([]);
    }
  });

  it.each(["of another format", "damaged"])(
    "starts cache.db empty when it is %s, and leaves kept.db as it was",
    async (how) => {
      const disk = keptDisk();
      disk.sql("INSERT INTO notice_lists (origin, account_id, rows) VALUES ('o', 'u', '[]')");
      const first = launch(disk).files;
      first.write(SCOPE_A, () => [saved("files", [])]);
      await first.flush();
      disk.cache.crash();
      if (how === "damaged") {
        for (const suffix of ["-wal", "-shm"]) rmSync(disk.cache.path + suffix, { force: true });
        writeFileSync(disk.cache.path, "not a database ".repeat(1000));
      } else disk.cache.sql(`PRAGMA user_version = ${CACHE_FORMAT + 1}`);

      const { files } = launch(disk);
      await expect(files.read(SCOPE_A)).resolves.toEqual([]);
      files.write(SCOPE_B, () => [saved("chats", [])]);
      await files.flush();
      await expect(launch(disk).files.read(SCOPE_B)).resolves.toEqual([saved("chats", [])]);
      expect(disk.sql("SELECT rows FROM notice_lists")).toEqual([{ rows: "[]" }]);
    },
  );
});

describe("cache.db failing after it opened", () => {
  const ACCOUNT = JSON.stringify(["https://dohc.example.com", "u-1"]);

  it("answers a failing read with no views and no list", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    files.write(SCOPE_A, () => [saved("files", [])]);
    await files.flush();
    await files.writeList(ACCOUNT, []);
    disk.cache.failReads = /SELECT/;
    await expect(files.read(SCOPE_A)).resolves.toEqual([]);
    await expect(files.readList(ACCOUNT)).resolves.toBeNull();
    // Nothing was deleted: the next read that works finds both.
    disk.cache.failReads = null;
    await expect(files.read(SCOPE_A)).resolves.toEqual([saved("files", [])]);
    await expect(files.readList(ACCOUNT)).resolves.toEqual([]);
  });

  it("settles a flush whose write failed, and the next save works", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    disk.cache.failWrites = /INSERT INTO views/;
    files.write(SCOPE_A, () => [saved("files", [])]);
    await expect(files.flush()).resolves.toBeUndefined();
    expect(stored(disk)).toEqual([]);
    disk.cache.failWrites = null;
    files.write(SCOPE_A, () => [saved("chats", [])]);
    await expect(files.flush()).resolves.toBeUndefined();
    await expect(files.read(SCOPE_A)).resolves.toEqual([saved("chats", [])]);
  });

  it("deletes cache.db when a write finds it damaged, and the next call starts it empty", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    files.write(SCOPE_A, () => [saved("files", [])]);
    await files.flush();
    disk.cache.damaged = true;
    files.write(SCOPE_B, () => [saved("files", [])]);
    await expect(files.flush()).resolves.toBeUndefined();
    expect(existsSync(disk.cache.path)).toBe(false);
    disk.cache.damaged = false;
    await expect(files.read(SCOPE_A)).resolves.toEqual([]);
    files.write(SCOPE_B, () => [saved("chats", [])]);
    await expect(files.flush()).resolves.toBeUndefined();
    await expect(files.read(SCOPE_B)).resolves.toEqual([saved("chats", [])]);
  });
});

describe("saving views", () => {
  it("waits for a new scope's changes to stop, saves them together, and waits no longer than its cap", async () => {
    vi.useFakeTimers();
    try {
      const disk = keptDisk();
      const { files } = launch(disk, { now: Date.now });
      files.write(SCOPE_A, () => [saved("files", [])]);
      files.write(SCOPE_B, () => [saved("files", [])]);
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS - 1);
      expect(stored(disk)).toEqual([]);
      files.write(SCOPE_A, () => [saved("chats", [])]);
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
      expect(stored(disk)).toEqual([SCOPE_A, SCOPE_B]);
      await expect(files.read(SCOPE_A)).resolves.toEqual([saved("chats", [])]);

      // A change every half of the delay never lets a new scope go quiet: the write lands at the cap anyway.
      const scopeC = JSON.stringify(["https://dohc.example.com", "u-1", "ws-c"]);
      for (let elapsed = 0; elapsed < WRITE_MAX_DELAY_MS; elapsed += WRITE_DELAY_MS / 2) {
        files.write(scopeC, () => [saved("files", [])]);
        await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS / 2);
      }
      expect(stored(disk)).toContain(scopeC);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes an unchanged view's JSON once, and again when its value, cursor or flags change", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    let walks = 0;
    const page = Object.defineProperty({}, "text", {
      enumerable: true,
      get: () => (walks++, "Packing list"),
    });
    const rowOf = () => String(disk.cache.sql("SELECT value FROM views")[0]?.value);
    const saveAs = async (...views: SavedView[]) => {
      files.write(SCOPE_A, () => views);
      await files.flush();
      return rowOf();
    };
    const list = { rows: ["a"] };
    const first = await saveAs(saved("files", list), saved("page:p-1", page));
    const once = walks;
    expect(once).toBeGreaterThan(0);

    expect(await saveAs(saved("files", { rows: ["a", "b"] }), saved("page:p-1", page))).toBe(
      JSON.stringify([
        saved("files", { rows: ["a", "b"] }),
        saved("page:p-1", { text: "Packing list" }),
      ]),
    );
    expect(walks).toBe(once);
    expect(await saveAs(saved("files", list), saved("page:p-1", page))).toBe(first);
    expect(walks).toBe(once);

    await saveAs(saved("files", list), saved("page:p-1", page, "0.5.3"));
    await saveAs(saved("files", list), saved("page:p-1", page, "0.5.3", true));
    await saveAs(saved("files", list), {
      ...saved("page:p-1", page, "0.5.3", true),
      prefetched: true,
    });
    expect(walks).toBe(once * 4);
    expect(JSON.parse(rowOf())[1]).toEqual({
      ...saved("page:p-1", { text: "Packing list" }, "0.5.3", true),
      prefetched: true,
    });
  });

  it("saves a scope at most once every 30 s in the foreground, and at once when the app goes to the background", async () => {
    vi.useFakeTimers();
    try {
      const disk = keptDisk();
      const { files } = launch(disk, { now: Date.now });
      const reply = (length: number) => [
        saved("thread:t-1", {
          kind: "thread",
          id: "t-1",
          title: "",
          messages: [],
          body: "x".repeat(length),
        }),
      ];
      const onDisk = () => launch(disk).files.read(SCOPE_A);
      files.write(SCOPE_A, () => reply(0));
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
      await expect(onDisk()).resolves.toEqual(reply(0));

      let length = 0;
      for (let elapsed = 0; elapsed < WRITE_INTERVAL_MS - 2 * WRITE_DELAY_MS; elapsed += 250) {
        const now = ++length;
        files.write(SCOPE_A, () => reply(now));
        await vi.advanceTimersByTimeAsync(250);
      }
      await expect(onDisk()).resolves.toEqual(reply(0));
      await vi.advanceTimersByTimeAsync(2 * WRITE_DELAY_MS);
      await expect(onDisk()).resolves.toEqual(reply(length));

      files.write(SCOPE_A, () => reply(length + 1));
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
      await expect(onDisk()).resolves.toEqual(reply(length));
      await files.flush();
      await expect(onDisk()).resolves.toEqual(reply(length + 1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a 2 MiB page, and leaves out the views past a scope's cap, keeping the listings", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    const page = (n: number) =>
      saved(`page:${n}.md`, { kind: "page", markdown: `${n}`.repeat(2 * 1024 * 1024) });
    const listings = [
      saved("files", [{ path: "0.md", objectId: "object-0", page: true }]),
      saved("chats", []),
    ];
    files.write(SCOPE_A, () => [...listings, page(1)]);
    await files.flush();
    await expect(files.read(SCOPE_A)).resolves.toEqual([...listings, page(1)]);

    files.write(SCOPE_A, () => [...listings, ...[1, 2, 3, 4, 5, 6].map(page)]);
    await files.flush();
    const kept = await files.read(SCOPE_A);
    expect(sizeOf(disk, SCOPE_A)).toBeLessThanOrEqual(SCOPE_MAX_BYTES);
    expect(kept.map((view) => view.id)).toEqual([
      "files",
      "chats",
      "page:1.md",
      "page:2.md",
      "page:3.md",
      "page:4.md",
    ]);
  });

  it("keeps every scope's views under the total cap by deleting the scopes used least recently, across a relaunch", async () => {
    const disk = keptDisk();
    const scope = (n: number) => JSON.stringify(["https://dohc.example.com", "u-1", `ws-${n}`]);
    const views = [saved("page:a.md", { kind: "page", markdown: "x".repeat(1000) })];
    const totalMaxBytes = 3 * Buffer.byteLength(JSON.stringify(views));
    const first = launch(disk, { totalMaxBytes }).files;
    for (const n of [1, 2, 3]) {
      first.write(scope(n), () => views);
      await first.flush();
    }
    await first.read(scope(1));
    first.write(scope(4), () => views);
    await first.flush();
    expect(stored(disk)).toEqual([1, 3, 4].map(scope).sort());

    // A relaunch keeps when each was last used, a read included: 3 goes first.
    const second = launch(disk, { totalMaxBytes }).files;
    second.write(scope(5), () => views);
    await second.flush();
    expect(stored(disk)).toEqual([1, 4, 5].map(scope).sort());
  });
});

describe("deleting views", () => {
  it("wins over a write in flight, and over one waiting on its timer", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    files.write(SCOPE_B, () => [saved("files", [])]);
    await files.flush();
    const release = disk.cache.holdCommits();
    files.write(SCOPE_A, () => [saved("files", [])]);
    const writing = files.flush();
    await vi.waitFor(() => expect(disk.cache.waiting()).toBe(1));
    files.write(SCOPE_B, () => [saved("chats", [])]);
    const removing = files.removeAll();
    release();
    await writing;
    await removing;
    await files.flush();
    expect(existsSync(disk.cache.path)).toBe(false);
  });

  it("deletes one scope's views over its write in flight, and keeps the others", async () => {
    const disk = keptDisk();
    const { files } = launch(disk);
    files.write(SCOPE_B, () => [saved("files", [])]);
    await files.flush();
    const release = disk.cache.holdCommits();
    files.write(SCOPE_A, () => [saved("files", [])]);
    const writing = files.flush();
    await vi.waitFor(() => expect(disk.cache.waiting()).toBe(1));
    const removing = files.remove(SCOPE_A);
    release();
    await writing;
    await removing;
    expect(stored(disk)).toEqual([SCOPE_B]);
  });
});

const ops = (result: unknown, cursor: string): Answer => ({
  status: 200,
  body: { ok: true, result, cursor },
});
const listing = (...paths: [string, string][]) => ({
  ok: true,
  files: paths.map(([path, objectId]) => ({ path, objectId, contentKind: "text", byteLength: 1 })),
  folders: [],
});
const feedPath = (workspaceId: string, since: string) =>
  `/sync/${workspaceId}/ops/changes?since=${since}&hold=${FEED_HOLD_MS}`;
const NOT_FOUND: Answer = {
  status: 404,
  body: { ok: false, error: "not found", code: "not_found" },
};
const held = () => new Promise<Answer>(() => {});
const count = (server: ReturnType<typeof testServer>, path: string) =>
  server.calls.filter((call) => call.path === path).length;
const A_FILES = [{ path: "a.md", objectId: "object-a", page: true }];

function serverWithA() {
  const server = testServer();
  server.on("POST", "/sync/ws-a/ops/listFiles", ops(listing(["a.md", "object-a"]), "0.5.2"));
  server.on(
    "POST",
    "/sync/ws-a/ops/documentRead",
    ops({ ok: true, path: "a.md", markdown: "# A" }, "0.6.2"),
  );
  server.on("POST", "/sync/ws-b/ops/listFiles", ops(listing(["b.md", "object-b"]), "0.5.2"));
  server.on("GET", feedPath("ws-a", "0.5.2"), held);
  server.on("GET", feedPath("ws-b", "0.5.2"), held);
  return server;
}

function signInTo(server: ReturnType<typeof testServer>) {
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
  server: ReturnType<typeof testServer>,
  cache: ReadCache,
  workspaceId = "ws-a",
  signIn = signInTo(server),
) {
  const data = createWorkspaceData({ signIn, workspaceId, cache });
  data.resume();
  return data;
}

async function readBeforeRelaunch(server: ReturnType<typeof testServer>, disk: KeptDisk) {
  const { files, cache } = launch(disk);
  const data = open(server, cache);
  data.subscribe(views.files, () => {});
  data.subscribe(views.page("a.md"), () => {});
  await vi.waitFor(() =>
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" }),
  );
  await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
  await files.flush();
  data.stop();
}

describe("a relaunch", () => {
  it("shows what was read before, without reading it again, and resumes the feed from its cursor", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const reads = server.calls.filter((call) => call.method === "POST").length;

    const { cache } = launch(disk);
    const data = open(server, cache);
    data.subscribe(views.files, () => {});
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(data.state(views.files)).toMatchObject({ value: A_FILES, loading: false }),
    );
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" });
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(reads);
  });

  it("marks a value from the cache on the state that shows it, which a later server answer leaves as it was", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const data = open(server, launch(disk).cache);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toEqual(A_FILES));
    const rendered = data.state(views.files);
    expect(rendered.fromCache).toBe(true);
    await data.refresh(views.files);
    expect(rendered.fromCache).toBe(true);
    expect(data.state(views.files).fromCache).toBeFalsy();
    data.stop();
  });

  it("drops the cache mark with the value when a feed replace drops a view no screen has open", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const feed = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.5.2"), () => feed.promise);
    server.on("GET", feedPath("ws-a", "1.0.0"), held);
    const data = open(server, launch(disk).cache);
    data.subscribe(views.files, () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md"))).toMatchObject({ fromCache: true }),
    );
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    feed.resolve({ status: 200, body: { ok: true, cursor: "1.0.0", replace: true } });
    await vi.waitFor(() => expect(data.state(views.page("a.md")).value).toBeNull());
    expect(data.state(views.page("a.md")).fromCache).toBeFalsy();
    data.stop();
  });

  it("shows no text after a relaunch for a page only prefetched that a change touched", async () => {
    const server = serverWithA();
    const reread = deferred<Answer>();
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      ops({ ok: true, path: "a.md", markdown: "# Old" }, "0.6.2"),
      () => reread.promise,
    );
    const change = deferred<Answer>();
    server.on("GET", feedPath("ws-a", "0.6.2"), () => change.promise);
    server.on("GET", feedPath("ws-a", "0.7.1"), held);
    const disk = keptDisk();
    const first = launch(disk);
    const before = open(server, first.cache);
    before.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(before.state(views.page("a.md")).value).not.toBeNull());
    change.resolve({
      status: 200,
      body: { ok: true, cursor: "0.7.1", changed: { files: ["object-a"] } },
    });
    const scope = cacheScope(signInTo(server), "ws-a");
    await vi.waitFor(() => expect(first.cache.get(scope, "page:a.md")?.stale).toBe(true));
    await first.files.flush();
    before.stop();

    const data = open(server, launch(disk).cache);
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/documentRead")).toBe(2));
    expect(data.state(views.page("a.md")).value).toBeNull();
    reread.resolve(ops({ ok: true, path: "a.md", markdown: "# New" }, "0.7.1"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# New" }),
    );
  });

  it("keeps a prefetched page's text as its last once the relaunch shows it on an open screen", async () => {
    const server = serverWithA();
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      ops({ ok: true, path: "a.md", markdown: "# A" }, "0.6.2"),
      ops({ ok: false, reason: "dohc: No document at a.md.", refusal: "missing" }, "0.6.2"),
    );
    server.on("GET", feedPath("ws-a", "0.6.2"), held);
    const disk = keptDisk();
    const first = launch(disk);
    const before = open(server, first.cache);
    before.prefetchPages(["a.md"]);
    await vi.waitFor(() => expect(before.state(views.page("a.md")).value).not.toBeNull());
    await first.files.flush();
    before.stop();

    const { cache } = launch(disk);
    const data = open(server, cache);
    data.subscribe(views.page("a.md"), () => {});
    expect(data.state(views.page("a.md"))).toMatchObject({ value: null, loading: true });
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" }),
    );
    expect(
      cache.get(cacheScope(signInTo(server), "ws-a"), "page:a.md")?.prefetched,
    ).toBeUndefined();
    data.retry(views.page("a.md"));
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "missing", last: "# A" }),
    );
  });

  it("paints the loading state before the row is read, and asks the server nothing until it is", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const calls = server.calls.length;
    const release = disk.cache.holdCommits();

    const { cache } = launch(disk);
    const data = open(server, cache);
    const painted = vi.fn();
    data.subscribe(views.files, painted);
    expect(data.state(views.files)).toMatchObject({ value: null, loading: true, problem: null });
    data.retry(views.files);
    expect(server.calls).toHaveLength(calls);
    release();
    await vi.waitFor(() => expect(data.state(views.files).value).toEqual(A_FILES));
    expect(painted).toHaveBeenCalled();
  });

  it("waits with a pull's refresh until the row is read, so the row keeps the views it restores", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const calls = server.calls.length;
    const release = disk.cache.holdCommits();

    const relaunched = launch(disk);
    const data = open(server, relaunched.cache);
    data.subscribe(views.files, () => {});
    const refreshed = data.refresh(views.files);
    expect(server.calls).toHaveLength(calls);
    release();
    await refreshed;
    expect(server.calls.length).toBeGreaterThan(calls);
    await relaunched.files.flush();
    data.stop();

    const reads = server.calls.filter((call) => call.method === "POST").length;
    const again = open(server, launch(disk).cache);
    again.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() =>
      expect(again.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" }),
    );
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(reads);
  });

  it("reads a stale view again on open, and everything again when the server can't continue from the cursor", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const scope = cacheScope(signInTo(server), "ws-a");
    const marked = launch(disk);
    await marked.cache.restore(scope);
    const page = marked.cache.get(scope, "page:a.md")!;
    marked.cache.set(scope, { ...page, stale: true });
    await marked.files.flush();

    let answer!: (value: Answer) => void;
    server.on(
      "GET",
      feedPath("ws-a", "0.5.2"),
      () =>
        new Promise<Answer>((done) => {
          answer = done;
        }),
    );
    server.on("GET", feedPath("ws-a", "1.0.0"), held);
    server.on(
      "POST",
      "/sync/ws-a/ops/documentRead",
      ops({ ok: true, path: "a.md", markdown: "# A again" }, "1.0.0"),
    );
    server.on(
      "POST",
      "/sync/ws-a/ops/listFiles",
      ops(listing(["a.md", "object-a"], ["b.md", "object-b"]), "1.0.0"),
    );
    const { files, cache } = launch(disk);
    const data = open(server, cache);
    data.subscribe(views.page("a.md"), () => {});
    data.subscribe(views.files, () => {});
    await vi.waitFor(() =>
      expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A again" }),
    );
    expect(data.state(views.files).value).toEqual(A_FILES);
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(1);

    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    answer({ status: 200, body: { ok: true, cursor: "1.0.0", replace: true } });
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(2));
    await files.flush();
    expect((await launch(disk).files.read(scope)).find((view) => view.id === "files")?.cursor).toBe(
      "1.0.0",
    );
  });
});

describe("the apps and Collections lists", () => {
  const COLLECTIONS = [{ datasetId: "d-1", name: "Registrations" }];
  const stores = (server: ReturnType<typeof testServer>, cache: ReadCache) => ({
    apps: createWorkspaceApps({
      signIn: signInTo(server),
      workspaceId: "ws-a",
      runner: createAppRunner(),
      fetch: server.fetch,
      canOpen: true,
      cache,
      ends: createScopedEnds(),
    }),
    collections: createWorkspaceCollections(signInTo(server), "ws-a", createScopedEnds(), cache),
  });

  it("show what was read before after a relaunch, and an answer before the row is read keeps its other views", async () => {
    const server = serverWithA();
    server.on("POST", "/sync/ws-a/ops/apps", page([version(A, true)]));
    server.on("POST", "/sync/ws-a/ops/memberApps", memberPage([]));
    server.on(
      "POST",
      "/sync/ws-a/ops/collections",
      ops({ collections: COLLECTIONS, nextCursor: null }, "0.5.2"),
    );
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const first = launch(disk);
    const before = stores(server, first.cache);
    await Promise.all([before.apps.refresh(), before.collections.refresh()]);
    await first.files.flush();

    const release = disk.cache.holdCommits();
    const { cache } = launch(disk);
    const after = stores(server, cache);
    expect(after.apps.state().apps).toBeNull();
    const refreshed = Promise.all([after.apps.refresh(), after.collections.refresh()]);
    await vi.waitFor(() => expect(count(server, "/sync/ws-a/ops/collections")).toBe(2));
    expect(after.apps.state().apps).toBeNull();
    release();
    await vi.waitFor(() => expect(after.apps.state().apps).toEqual([version(A, true)]));
    expect(after.collections.state().collections).toEqual(COLLECTIONS);
    await refreshed;

    const reads = count(server, "/sync/ws-a/ops/listFiles");
    const data = open(server, cache);
    data.subscribe(views.files, () => {});
    expect(data.state(views.files).value).toEqual(A_FILES);
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(reads);
  });
});

describe("emptying the cache", () => {
  const SAVED: StoredSignIn = {
    origin: "https://dohc.example.com",
    token: "tok-1",
    userId: "u-1",
    email: "ice@example.com",
  };

  async function signedIn(server: ReturnType<typeof testServer>, disk: KeptDisk) {
    serveSessionEnd(server);
    const { files, cache } = launch(disk);
    const account = createAccount({
      store: memoryStore(SAVED).store,
      fetch: server.fetch,
      sleep: async () => {},
    });
    // The cache follows the account from launch, before the saved sign-in is read, as the app's does.
    cache.follow(account);
    await account.restore();
    const state = account.state();
    if (state.status !== "signed-in") throw new Error("expected signed-in");
    return { files, cache, account, signIn: state.signIn };
  }

  it("keeps cache.db when the saved sign-in is read at launch, and deletes it at a launch with none", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBeforeRelaunch(server, disk);
    const { files } = await signedIn(server, disk);
    await files.flush();
    expect(stored(disk)).toHaveLength(1);
    disk.cache.crash();

    const signedOut = launch(disk);
    const account = createAccount({ store: memoryStore(null).store, fetch: server.fetch });
    signedOut.cache.follow(account);
    await account.restore();
    await signedOut.files.flush();
    expect(existsSync(disk.cache.path)).toBe(false);
  });

  it("deletes cache.db at sign-out, even with a write in flight", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    const { files, cache, account, signIn } = await signedIn(server, disk);
    const b = open(server, cache, "ws-b", signIn);
    b.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(b.state(views.files).value).toHaveLength(1));
    await files.flush();
    b.stop();
    const a = open(server, cache, "ws-a", signIn);
    a.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(a.state(views.files).value).toHaveLength(1));
    const release = disk.cache.holdCommits();
    const writing = files.flush();
    await vi.waitFor(() => expect(disk.cache.waiting()).toBe(1));

    await account.signOut();
    release();
    await writing;
    await files.flush();
    expect(existsSync(disk.cache.path)).toBe(false);
  });

  it("deletes cache.db at a 401", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    const { files, cache, account, signIn } = await signedIn(server, disk);
    let answer!: (value: Answer) => void;
    server.on(
      "GET",
      feedPath("ws-a", "0.5.2"),
      () =>
        new Promise<Answer>((done) => {
          answer = done;
        }),
    );
    const a = open(server, cache, "ws-a", signIn);
    a.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    await files.flush();
    expect(stored(disk)).toHaveLength(1);

    answer({ status: 401 });
    await vi.waitFor(() =>
      expect(account.state()).toMatchObject({ status: "signed-out", ended: true }),
    );
    await files.flush();
    expect(existsSync(disk.cache.path)).toBe(false);
  });

  it("deletes a gone workspace's views, and keeps the others", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    const { files, cache } = launch(disk);
    const b = open(server, cache, "ws-b");
    b.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(b.state(views.files).value).toHaveLength(1));
    b.stop();
    let answer!: (value: Answer) => void;
    server.on(
      "GET",
      feedPath("ws-a", "0.5.2"),
      () =>
        new Promise<Answer>((done) => {
          answer = done;
        }),
    );
    const onGone = vi.fn();
    const a = createWorkspaceData({ signIn: signInTo(server), workspaceId: "ws-a", cache, onGone });
    a.resume();
    a.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    await files.flush();
    expect(stored(disk)).toHaveLength(2);

    answer(NOT_FOUND);
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
    await files.flush();
    expect(stored(disk)).toEqual([cacheScope(signInTo(server), "ws-b")]);
  });

  it("deletes the views of a workspace hidden on this phone", async () => {
    const server = serverWithA();
    server.on("GET", "/sync/account/workspaces", {
      status: 200,
      body: {
        ok: true,
        workspaces: [
          { workspaceId: "ws-a", name: "Trip", canOpen: true, showOnPhone: true, role: "owner" },
        ],
      },
    });
    server.on("POST", "/sync/account/workspaces/ws-a/show-on-phone", {
      status: 200,
      body: { ok: true },
    });
    const disk = keptDisk();
    const { files, cache } = launch(disk);
    const signIn = signInTo(server);
    const list = createWorkspaceList(signIn);
    const workspace = createOpenWorkspace({ signIn, list, cache });
    workspace.subscribe(() => {});
    workspace.resume();
    list.reload();
    await vi.waitFor(() => expect(workspace.state().data).not.toBeNull());
    workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(cache.entries(cacheScope(signIn, "ws-a"))).toHaveLength(1));
    await files.flush();
    expect(stored(disk)).toHaveLength(1);

    workspace.setShowOnPhone("ws-a", false);
    await files.flush();
    expect(stored(disk)).toEqual([]);
    workspace.stop();
  });
});

describe("a restore that a delete overtakes", () => {
  function heldFiles() {
    let answer!: (views: readonly SavedView[]) => void;
    const read = new Promise<readonly SavedView[]>((done) => {
      answer = done;
    });
    const files: CacheRows = {
      read: () => read,
      write: () => {},
      flush: async () => {},
      remove: async () => {},
      removeAll: async () => {},
      keep: async () => {},
      readList: async () => null,
      writeList: async () => {},
    };
    return { files, answer };
  }
  const SAVED_FILES = saved("files", A_FILES);

  it("adds nothing when the scope is dropped after the row is read", async () => {
    const { files, answer } = heldFiles();
    const cache = createReadCache(files);
    const restoring = cache.restore(SCOPE_A);
    answer([SAVED_FILES]);
    cache.drop(SCOPE_A);
    await restoring;
    expect(cache.entries(SCOPE_A)).toEqual([]);
  });

  it("adds nothing when the cache is cleared after the row is read", async () => {
    const { files, answer } = heldFiles();
    const cache = createReadCache(files);
    const restoring = cache.restore(SCOPE_A);
    answer([SAVED_FILES]);
    cache.clear();
    await restoring;
    expect(cache.entries(SCOPE_A)).toEqual([]);
  });

  it("reads a scope's row once for two restores, so a list that drops the scope meanwhile wins over both", async () => {
    const { files, answer } = heldFiles();
    let reads = 0;
    const counted: CacheRows = {
      ...files,
      read: (scope) => {
        reads += 1;
        return files.read(scope);
      },
    };
    const cache = createReadCache(counted);
    const first = cache.restore(SCOPE_A);
    const second = cache.restore(SCOPE_A);
    expect(reads).toBe(1);
    cache
      .savedList({ origin: "https://dohc.example.com", userId: "u-1" })!
      .listed([
        { workspaceId: "ws-b", name: "ws-b", canOpen: true, showOnPhone: true, role: "owner" },
      ]);
    answer([SAVED_FILES]);
    await Promise.all([first, second]);
    expect(cache.entries(SCOPE_A)).toEqual([]);
  });

  it("leaves a store that was waiting on the row with nothing restored, reading from the server", async () => {
    const server = serverWithA();
    const { files, answer } = heldFiles();
    const cache = createReadCache(files);
    const data = open(server, cache);
    data.subscribe(views.files, () => {});
    answer([{ ...SAVED_FILES, value: [{ path: "old.md", objectId: "object-old", page: true }] }]);
    cache.drop(cacheScope(signInTo(server), "ws-a"));
    await vi.waitFor(() => expect(data.state(views.files).value).toEqual(A_FILES));
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(1);
  });
});

describe("a view too large for its scope's cap", () => {
  it("is left out without being written out in full", async () => {
    const { files } = launch(keptDisk());
    const body = "x".repeat(1024 * 1024);
    const items = Array.from({ length: 100 }, (_, i) => ({
      message: {
        id: `m-${i}`,
        threadId: "t-1",
        authorKind: "human",
        authorName: "Maya Chen",
        body,
        createdAtMs: 1,
      },
      replyCount: 0,
      lastReplyAtMs: null,
    }));
    const stream = saved("stream:g-1", {
      kind: "stream",
      name: "General",
      groupKind: "group",
      items,
    });
    files.write(SCOPE_A, () => [saved("files", A_FILES), stream]);
    const stringify = vi.spyOn(JSON, "stringify");
    let longest = 0;
    try {
      await files.flush();
      longest = Math.max(
        ...stringify.mock.results.map((result) =>
          typeof result.value === "string" ? result.value.length : 0,
        ),
      );
    } finally {
      stringify.mockRestore();
    }
    expect(longest).toBeLessThan(1024);
    expect((await files.read(SCOPE_A)).map((view) => view.id)).toEqual(["files"]);
  });

  it("is measured by a floor that never passes its real size", () => {
    for (const value of [
      { kind: "missing", last: undefined },
      { kind: "page", markdown: 'line\n"quoted"\\ \u0001 é 中文 😀' },
      [],
      {},
      [null, 1.5, true, "x"],
      { items: [{ message: { body: "", createdAtMs: 0 }, lastReplyAtMs: null }] },
      [undefined],
    ]) {
      expect(leastJsonBytes(value, Infinity), JSON.stringify(value)).toBeLessThanOrEqual(
        Buffer.byteLength(JSON.stringify(value), "utf8"),
      );
    }
  });
});

describe("the saved workspace list", () => {
  const SIGN_IN_SCOPE = JSON.stringify(["https://dohc.example.com", "u-1"]);
  const entry = (workspaceId: string, showOnPhone = true) => ({
    workspaceId,
    name: workspaceId,
    canOpen: true,
    showOnPhone,
    role: "owner",
  });
  const listAnswer = (...workspaces: ReturnType<typeof entry>[]): Answer => ({
    status: 200,
    body: { ok: true, workspaces },
  });

  function launchAccount(
    server: ReturnType<typeof testServer>,
    disk: KeptDisk,
    signIn = signInTo(server),
  ) {
    const { files, cache } = launch(disk);
    const list = createWorkspaceList(signIn, cache.savedList(signIn));
    const workspace = createOpenWorkspace({ signIn, list, cache });
    workspace.subscribe(() => {});
    workspace.resume();
    list.reload();
    return { files, cache, list, workspace, signIn };
  }

  async function readBoth(server: ReturnType<typeof testServer>, disk: KeptDisk) {
    server.on("GET", "/sync/account/workspaces", listAnswer(entry("ws-a"), entry("ws-b")));
    const first = launchAccount(server, disk);
    await vi.waitFor(() => expect(first.workspace.state().currentWorkspaceId).toBe("ws-a"));
    first.workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() =>
      expect(first.cache.entries(cacheScope(first.signIn, "ws-a"))).toHaveLength(1),
    );
    first.workspace.choose("ws-b");
    first.workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() =>
      expect(first.cache.entries(cacheScope(first.signIn, "ws-b"))).toHaveLength(1),
    );
    first.workspace.choose("ws-a");
    await first.files.flush();
    first.workspace.stop();
    expect(stored(disk)).toEqual(
      [cacheScope(first.signIn, "ws-a"), cacheScope(first.signIn, "ws-b")].sort(),
    );
    await expect(first.files.readList(SIGN_IN_SCOPE)).resolves.toHaveLength(2);
  }

  it("opens the last workspace from the cache after a relaunch, while the server's list is still on its way", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBoth(server, disk);
    server.on("GET", "/sync/account/workspaces", held);
    const listReads = count(server, "/sync/account/workspaces");
    const reads = count(server, "/sync/ws-a/ops/listFiles");

    const { list, workspace } = launchAccount(server, disk);
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-a"));
    const data = workspace.state().data!;
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toEqual(A_FILES));
    expect(list.state()).toMatchObject({ status: "ready", problem: null });
    expect(count(server, "/sync/account/workspaces")).toBe(listReads + 1);
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(reads);
    workspace.stop();
  });

  it("shows the saved list with the problem when the server's list fails", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBoth(server, disk);
    server.on("GET", "/sync/account/workspaces", "offline");
    const { list, workspace } = launchAccount(server, disk);
    await vi.waitFor(() =>
      expect(list.state()).toMatchObject({ status: "ready", problem: "offline" }),
    );
    expect(workspace.state().currentWorkspaceId).toBe("ws-a");
    workspace.stop();
  });

  it("lets the server's list decide: a workspace it drops goes, with its views, and one hidden elsewhere loses its views", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBoth(server, disk);
    let answer!: (value: Answer) => void;
    server.on(
      "GET",
      "/sync/account/workspaces",
      () =>
        new Promise<Answer>((done) => {
          answer = done;
        }),
    );
    const { files, cache, list, workspace, signIn } = launchAccount(server, disk);
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-a"));
    workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(cache.entries(cacheScope(signIn, "ws-a"))).toHaveLength(1));

    answer(listAnswer(entry("ws-b", false), entry("ws-c")));
    await vi.waitFor(() =>
      expect(list.state()).toMatchObject({
        status: "ready",
        workspaces: [{ workspaceId: "ws-b" }, { workspaceId: "ws-c" }],
      }),
    );
    expect(workspace.state().currentWorkspaceId).toBe("ws-c");
    expect(cache.entries(cacheScope(signIn, "ws-a"))).toEqual([]);
    await files.flush();
    expect(stored(disk)).toEqual([]);
    await expect(launch(disk).files.readList(SIGN_IN_SCOPE)).resolves.toEqual([
      entry("ws-b", false),
      entry("ws-c"),
    ]);
    workspace.stop();
  });

  it("saves a Show on phone change made on this phone", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await readBoth(server, disk);
    server.on("PATCH", "/sync/account/workspaces/ws-b", {
      status: 200,
      body: { ok: true, workspaceId: "ws-b", showOnPhone: false },
    });
    server.on(
      "GET",
      "/sync/account/workspaces",
      listAnswer(entry("ws-a"), entry("ws-b")),
      listAnswer(entry("ws-a"), entry("ws-b", false)),
    );
    const { files, list, workspace: open } = launchAccount(server, disk);
    await vi.waitFor(() => expect(list.state()).toMatchObject({ status: "ready" }));
    await vi.waitFor(() => expect(count(server, "/sync/account/workspaces")).toBe(2));
    open.setShowOnPhone("ws-b", false);
    await vi.waitFor(() => expect(list.state()).toMatchObject({ pending: new Set() }));
    await files.flush();
    await expect(launch(disk).files.readList(SIGN_IN_SCOPE)).resolves.toEqual([
      entry("ws-a"),
      entry("ws-b", false),
    ]);
    expect(stored(disk)).not.toContain(SCOPE_B);
    open.stop();
  });

  async function chooseB(server: ReturnType<typeof testServer>, disk: KeptDisk) {
    await readBoth(server, disk);
    const { files, workspace } = launchAccount(server, disk);
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-a"));
    workspace.choose("ws-b");
    await files.flush();
    workspace.stop();
  }

  function relaunch(
    server: ReturnType<typeof testServer>,
    disk: KeptDisk,
    signIn = signInTo(server),
  ) {
    const launched = launchAccount(server, disk, signIn);
    const opened: string[] = [];
    launched.workspace.subscribe(() => {
      const current = launched.workspace.state().currentWorkspaceId;
      if (current !== null && opened.at(-1) !== current) opened.push(current);
    });
    return { ...launched, opened };
  }

  /** A relaunch whose read of the choice saved last waits for `choice`, after the list has landed. */
  async function slowChoice(server: ReturnType<typeof testServer>, disk: KeptDisk) {
    await chooseB(server, disk);
    server.on("GET", "/sync/account/workspaces", listAnswer(entry("ws-a"), entry("ws-b")));
    const { files } = launch(disk);
    const choice = deferred<void>();
    const cache = createReadCache({
      ...files,
      readList: (scope) =>
        scope.endsWith(',"chosen"]')
          ? choice.promise.then(() => files.readList(scope))
          : files.readList(scope),
    });
    const signIn = signInTo(server);
    const list = createWorkspaceList(signIn, cache.savedList(signIn));
    const workspace = createOpenWorkspace({ signIn, list, cache });
    workspace.subscribe(() => {});
    list.reload();
    await vi.waitFor(() =>
      expect(list.state()).toMatchObject({ status: "ready", pending: new Set() }),
    );
    await vi.waitFor(() => expect(count(server, "/sync/account/workspaces")).toBeGreaterThan(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { list, workspace, choice };
  }

  it("reads the choice saved last as the open workspace is made, before any screen subscribes", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await chooseB(server, disk);
    server.on("GET", "/sync/account/workspaces", held);
    const { cache } = launch(disk);
    const signIn = signInTo(server);
    const list = createWorkspaceList(signIn, cache.savedList(signIn));
    const workspace = createOpenWorkspace({ signIn, list, cache });
    await vi.waitFor(() =>
      expect(workspace.state()).toMatchObject({ currentWorkspaceId: "ws-b", choosing: false }),
    );
    workspace.subscribe(() => {});
    expect(workspace.state().currentWorkspaceId).toBe("ws-b");
    workspace.stop();
  });

  it("shows no reason for an empty phone while the choice saved last is read after the list", async () => {
    const server = serverWithA();
    const { list, workspace, choice } = await slowChoice(server, keptDisk());
    expect(workspace.state()).toMatchObject({ currentWorkspaceId: null, choosing: true });
    expect(workspaceGap(list.state(), workspace.state())).toBeNull();
    choice.resolve();
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-b"));
    expect(workspace.state().choosing).toBe(false);
    workspace.stop();
  });

  it("opens a workspace the person chooses while the choice saved last is read, and keeps it after", async () => {
    const server = serverWithA();
    const { workspace, choice } = await slowChoice(server, keptDisk());
    workspace.choose("ws-a");
    expect(workspace.state()).toMatchObject({ currentWorkspaceId: "ws-a", choosing: false });
    choice.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(workspace.state().currentWorkspaceId).toBe("ws-a");
    workspace.stop();
  });

  it("reopens the workspace chosen last, without opening another first, until it no longer shows", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await chooseB(server, disk);
    const answer = deferred<Answer>();
    server.on("GET", "/sync/account/workspaces", () => answer.promise);

    const { workspace, opened } = relaunch(server, disk);
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-b"));
    expect(opened).toEqual(["ws-b"]);
    answer.resolve(listAnswer(entry("ws-a"), entry("ws-b", false)));
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-a"));
    workspace.stop();
  });

  it("keeps the choice to its own account, and loses it when cache.db is deleted", async () => {
    const server = serverWithA();
    const disk = keptDisk();
    await chooseB(server, disk);
    server.on("GET", "/sync/account/workspaces", held);
    const otherAccount = { ...signInTo(server), userId: "u-2" };
    await launch(disk).files.writeList(JSON.stringify([server.origin, "u-2"]), [
      entry("ws-a"),
      entry("ws-b"),
    ]);

    const other = relaunch(server, disk, otherAccount);
    await vi.waitFor(() => expect(other.workspace.state().currentWorkspaceId).toBe("ws-a"));
    expect(other.opened).toEqual(["ws-a"]);
    other.workspace.stop();
    const same = relaunch(server, disk);
    await vi.waitFor(() => expect(same.workspace.state().currentWorkspaceId).toBe("ws-b"));
    same.workspace.stop();

    disk.cache.crash();
    await launch(disk).files.removeAll();
    server.on("GET", "/sync/account/workspaces", listAnswer(entry("ws-a"), entry("ws-b")));
    const emptied = relaunch(server, disk);
    await vi.waitFor(() => expect(emptied.workspace.state().currentWorkspaceId).toBe("ws-a"));
    expect(emptied.opened).toEqual(["ws-a"]);
    emptied.workspace.stop();
  });
});

describe("a launch", () => {
  const SAVED: StoredSignIn = {
    origin: "https://dohc.example.com",
    token: "tok-1",
    userId: "u-1",
    email: "ice@example.com",
  };
  const entry = (workspaceId: string) => ({
    workspaceId,
    name: workspaceId,
    canOpen: true,
    showOnPhone: true,
    role: "owner",
  });

  async function relaunch(signingOut: boolean) {
    const disk = keptDisk();
    const seeded = launch(disk).files;
    await seeded.writeList(JSON.stringify([SAVED.origin, SAVED.userId]), [
      entry("ws-a"),
      entry("ws-b"),
    ]);
    await seeded.writeList(JSON.stringify([SAVED.origin, SAVED.userId, "chosen"]), "ws-b");
    disk.cache.crash();

    const kept = disk.launch();
    const cacheFile = disk.cache.launch();
    const files = createCacheRows(cacheFile);
    made.push(files);
    const reads: string[] = [];
    const cache = createReadCache({
      ...files,
      readList: (scope) => (reads.push(scope), files.readList(scope)),
    });
    const keychain = memoryStore(SAVED);
    const answerKeychain = keychain.holdLoads();
    const check = deferred<boolean>();
    const account = createAccount({
      store: keychain.store,
      fetch: testServer().fetch,
      pendingSignOuts: { ...pendingSignOuts(kept), isPending: () => check.promise },
      onSaved: (saved) => cache.preload(saved),
    });
    cache.follow(account);
    const opened = openNow([kept, cacheFile]);
    void account.restore();
    expect(await opened).toBe(true);
    expect(existsSync(disk.path)).toBe(true);
    expect(account.state().status).toBe("loading");

    answerKeychain();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(account.state().status).toBe("loading");
    check.resolve(signingOut);
    await vi.waitFor(() => expect(account.state().status).not.toBe("loading"));
    return { disk, files, cache, account, reads };
  }

  it("opens both files while the keychain is read, and reads the saved list and choice before the Sign out check answers", async () => {
    const { cache, account, reads } = await relaunch(false);
    const state = account.state();
    if (state.status !== "signed-in") throw new Error("expected signed-in");
    const signIn = state.signIn;
    const list = createWorkspaceList(signIn, cache.savedList(signIn));
    const workspace = createOpenWorkspace({ signIn, list, cache });
    await vi.waitFor(() =>
      expect(workspace.state()).toMatchObject({ currentWorkspaceId: "ws-b", choosing: false }),
    );
    expect(list.state()).toMatchObject({ workspaces: [entry("ws-a"), entry("ws-b")] });
    expect(reads).toHaveLength(2);
    workspace.stop();
  });

  it("stays signed out, and deletes the cache.db it read early, when a Sign out waits to finish", async () => {
    const { disk, files, account } = await relaunch(true);
    expect(account.state().status).toBe("signed-out");
    await files.flush();
    expect(existsSync(disk.cache.path)).toBe(false);
  });

  it("answers that the files didn't open while the phone is locked, and that they did once it opens", async () => {
    const disk = keptDisk();
    const kept = disk.launch();
    const cacheFile = disk.cache.launch();
    disk.locked = true;
    expect(await openNow([kept, cacheFile])).toBe(false);
    disk.locked = false;
    expect(await openNow([kept, cacheFile])).toBe(true);
  });

  it("deletes cache.db when Try again finds a Sign out waiting, after the first check couldn't read kept.db", async () => {
    const disk = keptDisk();
    await launch(disk).files.writeList(JSON.stringify([SAVED.origin, SAVED.userId]), [
      entry("ws-a"),
    ]);
    disk.cache.crash();
    const { files, cache } = launch(disk);
    let checks = 0;
    const account = createAccount({
      store: memoryStore(SAVED).store,
      fetch: testServer().fetch,
      pendingSignOuts: {
        ...pendingSignOuts(disk.launch()),
        isPending: async () => {
          checks += 1;
          if (checks === 1) throw new Error("kept.db couldn't be read");
          return true;
        },
      },
      onSaved: (saved) => cache.preload(saved),
    });
    cache.follow(account);
    await account.restore();
    expect(account.state().status).toBe("unreadable");
    await account.restore();
    expect(account.state().status).toBe("signed-out");
    await files.flush();
    expect(existsSync(disk.cache.path)).toBe(false);
  });

  it("restores the chosen openable workspace's cached views during preload and drops it after clear", async () => {
    const disk = keptDisk();
    const first = launch(disk);
    const saved = first.cache.savedList(SAVED)!;
    saved.listed([
      { ...entry("ws-a"), role: "owner" as const },
      { ...entry("ws-b"), role: "owner" as const },
    ]);
    saved.chose("ws-b");
    first.cache.set(cacheScope(SAVED, "ws-b"), {
      view: views.files,
      value: A_FILES,
      cursor: "0.1.1",
      stale: false,
    });
    first.cache.set(cacheScope(SAVED, "ws-a"), {
      view: views.files,
      value: A_FILES,
      cursor: "0.1.1",
      stale: false,
    });
    await first.files.flush();
    disk.cache.crash();

    const second = launch(disk);
    second.cache.preload(SAVED);
    await vi.waitFor(() =>
      expect(second.cache.get(cacheScope(SAVED, "ws-b"), "files")?.value).toEqual(A_FILES),
    );
    expect(second.cache.entries(cacheScope(SAVED, "ws-a"))).toEqual([]);

    const third = launch(disk);
    third.cache.preload(SAVED);
    third.cache.clear();
    await third.files.flush();
    expect(third.cache.entries(cacheScope(SAVED, "ws-b"))).toEqual([]);
  });
});
