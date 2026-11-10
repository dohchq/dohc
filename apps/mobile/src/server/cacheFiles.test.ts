import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount, type StoredSignIn } from "./account";
import { CACHE_FORMAT, createCacheFiles, fileName, leastJsonBytes, SCOPE_MAX_BYTES, WRITE_DELAY_MS, WRITE_INTERVAL_MS, WRITE_MAX_DELAY_MS, type CacheFiles, type SavedView } from "./cacheFiles";
import { createServerClient } from "./client";
import { createOpenWorkspace } from "./openWorkspace";
import { memoryStore, testServer, type Answer } from "./testServer";
import { cacheScope, createReadCache, createWorkspaceData, views, type ReadCache } from "./workspaceData";
import { createWorkspaceList } from "./workspaceList";
import { FEED_HOLD_MS } from "./workspaceReads";

// A file system in memory. A write lands half its text first, then the rest, so a write held part way leaves a
// partial file as a closed app would. Reads and writes can be held until the test releases them.
const disk = vi.hoisted(() => ({
  files: new Map<string, { text: string; mtime: number }>(),
  folders: new Set<string>(),
  clock: 0,
  log: [] as string[],
  heldReads: null as Promise<void> | null,
  heldWrites: null as Promise<void> | null,
  failWrites: false,
  unreadable: new Set<string>(),
}));
vi.mock("expo-file-system", () => {
  type Part = string | { readonly uri: string };
  const uriOf = (parts: readonly Part[]) => parts.map(part => typeof part === "string" ? part : part.uri).join("/");
  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf("/"));
  class File {
    readonly uri: string;
    constructor(...parts: Part[]) { this.uri = uriOf(parts); }
    get name() { return this.uri.slice(this.uri.lastIndexOf("/") + 1); }
    get exists() { return disk.files.has(this.uri); }
    get size() { return Buffer.byteLength(disk.files.get(this.uri)?.text ?? "", "utf8"); }
    get modificationTime() { return disk.files.get(this.uri)?.mtime ?? null; }
    async text() {
      disk.log.push(`read ${this.name}`);
      if (disk.heldReads) await disk.heldReads;
      disk.log.push(`read done ${this.name}`);
      const file = disk.files.get(this.uri);
      if (!file || disk.unreadable.has(this.name)) throw new Error("The file couldn't be opened.");
      return file.text;
    }
    async write(text: string) {
      if (!disk.folders.has(parentOf(this.uri))) throw new Error("The folder doesn't exist.");
      disk.log.push(`write ${this.name}`);
      disk.files.set(this.uri, { text: text.slice(0, Math.floor(text.length / 2)), mtime: ++disk.clock });
      if (disk.heldWrites) await disk.heldWrites;
      if (disk.failWrites) throw new Error("No space left on device");
      disk.files.set(this.uri, { text, mtime: disk.clock });
    }
    async move(to: File, options?: { overwrite?: boolean }) {
      const file = disk.files.get(this.uri);
      if (!file) throw new Error("path does not exist");
      if (disk.files.has(to.uri) && !options?.overwrite) throw new Error("already exists");
      disk.files.delete(this.uri);
      disk.files.set(to.uri, file);
      disk.log.push(`move ${this.name} ${to.name}`);
    }
    delete() {
      if (!disk.files.delete(this.uri)) throw new Error("path does not exist");
    }
  }
  class Directory {
    readonly uri: string;
    constructor(...parts: Part[]) { this.uri = uriOf(parts); }
    get exists() { return disk.folders.has(this.uri); }
    create() { disk.folders.add(this.uri); }
    delete() {
      if (!disk.folders.delete(this.uri)) throw new Error("path does not exist");
      for (const path of [...disk.files.keys()]) if (path.startsWith(`${this.uri}/`)) disk.files.delete(path);
    }
    list() { return [...disk.files.keys()].filter(path => parentOf(path) === this.uri).map(path => new File(path)); }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

const FOLDER = "cache/dohc-read-cache";
const pathOf = (scope: string, extension = "json") => `${FOLDER}/${fileName(scope)}.${extension}`;
const names = () => [...disk.files.keys()].map(path => path.slice(FOLDER.length + 1)).sort();
const hold = (which: "heldReads" | "heldWrites") => {
  let release!: () => void;
  disk[which] = new Promise<void>(done => { release = done; });
  return () => { disk[which] = null; release(); };
};

const made: CacheFiles[] = [];
/** The cache's files as one launch of the app makes them, over the same folder as every other launch. */
function launch(options: { totalMaxBytes?: number; now?: () => number } = {}) {
  const files = createCacheFiles({ now: () => ++disk.clock, ...options });
  made.push(files);
  return { files, cache: createReadCache(files) };
}

beforeEach(() => {
  disk.files.clear();
  disk.folders.clear();
  disk.log.length = 0;
  disk.heldReads = disk.heldWrites = null;
  disk.failWrites = false;
  disk.unreadable.clear();
});
// A test's last write waits on a timer: it lands before the next test's disk is cleared.
afterEach(async () => {
  for (const files of made.splice(0)) await files.flush();
});

const SCOPE_A = JSON.stringify(["https://dohc.example.com", "u-1", "ws-a"]);
const SCOPE_B = JSON.stringify(["https://dohc.example.com", "u-1", "ws-b"]);
const saved = (id: string, value: unknown, cursor = "0.5.2", stale = false): SavedView => ({ id, value, cursor, stale });
const fileText = (scope: string, views: readonly SavedView[], format = CACHE_FORMAT) => JSON.stringify({ format, scope, views });
function place(path: string, text: string) {
  disk.folders.add(FOLDER);
  disk.files.set(path, { text, mtime: ++disk.clock });
}

describe("a scope's file", () => {
  it("keeps each view's value, cursor and staleness, under a name that holds no account detail", async () => {
    const { files } = launch();
    const views = [saved("files", [{ path: "a.md", objectId: "object-a", page: true }]), saved("page:a.md", { kind: "page", markdown: "# A" }, "0.6.1", true)];
    files.write(SCOPE_A, () => views);
    await files.flush();

    expect(names()).toEqual([`${fileName(SCOPE_A)}.json`]);
    expect(fileName(SCOPE_A)).toMatch(/^[0-9a-f]{16}$/);
    expect(fileName(SCOPE_A)).toBe(fileName(JSON.stringify(["https://dohc.example.com", "u-1", "ws-a"])));
    expect(fileName(SCOPE_A)).not.toBe(fileName(SCOPE_B));
    expect(JSON.parse(disk.files.get(pathOf(SCOPE_A))!.text)).toEqual({ format: CACHE_FORMAT, scope: SCOPE_A, views });
    // Another launch reads the same file.
    await expect(launch().files.read(SCOPE_A)).resolves.toEqual(views);
  });

  it("is discarded when it was written for another scope", async () => {
    place(pathOf(SCOPE_A), fileText(SCOPE_B, [saved("files", [])]));
    const { files } = launch();
    await expect(files.read(SCOPE_A)).resolves.toEqual([]);
    await files.flush();
    expect(names()).toEqual([]);
  });

  it("is deleted when it doesn't parse, is of another format, or can't be read", async () => {
    const { files } = launch();
    for (const text of ["{\"format\":1,\"scope\":", fileText(SCOPE_A, [saved("files", [])], CACHE_FORMAT + 1),
      JSON.stringify({ format: CACHE_FORMAT, scope: SCOPE_A, views: [{ id: "files", cursor: "0.5.2" }] })]) {
      place(pathOf(SCOPE_A), text);
      await expect(files.read(SCOPE_A)).resolves.toEqual([]);
      await files.flush();
      expect(names(), text).toEqual([]);
    }
    place(pathOf(SCOPE_A), fileText(SCOPE_A, [saved("files", [])]));
    disk.unreadable.add(`${fileName(SCOPE_A)}.json`);
    await expect(files.read(SCOPE_A)).resolves.toEqual([]);
    await files.flush();
    expect(names()).toEqual([]);
  });

  it("replaces the last one only once the new one is whole, and ignores a partial temporary file", async () => {
    const { files } = launch();
    const before = [saved("files", [])];
    files.write(SCOPE_A, () => before);
    await files.flush();

    const release = hold("heldWrites");
    const after = [saved("files", [{ path: "b.md", objectId: "object-b", page: true }], "0.7.1")];
    files.write(SCOPE_A, () => after);
    const writing = files.flush();
    await vi.waitFor(() => expect(names()).toContain(`${fileName(SCOPE_A)}.json.tmp`));
    // Half the new file is on disk, and a read finds only the whole last one.
    await expect(launch().files.read(SCOPE_A)).resolves.toEqual(before);
    release();
    await writing;
    expect(names()).toEqual([`${fileName(SCOPE_A)}.json`]);
    expect(disk.log.filter(line => line.startsWith("write") || line.startsWith("move")).slice(-2))
      .toEqual([`write ${fileName(SCOPE_A)}.json.tmp`, `move ${fileName(SCOPE_A)}.json.tmp ${fileName(SCOPE_A)}.json`]);
    await expect(launch().files.read(SCOPE_A)).resolves.toEqual(after);
  });

  it("keeps the whole last one when a write fails, says nothing, and deletes what a closed app left half-written", async () => {
    const { files } = launch();
    const before = [saved("files", [])];
    files.write(SCOPE_A, () => before);
    await files.flush();
    disk.failWrites = true;
    files.write(SCOPE_A, () => [saved("files", [{ path: "b.md", objectId: "object-b", page: true }])]);
    await expect(files.flush()).resolves.toBeUndefined();
    expect(names()).toEqual([`${fileName(SCOPE_A)}.json`]);
    await expect(files.read(SCOPE_A)).resolves.toEqual(before);

    // A partial file a closed app left, for a scope with no whole file: no read finds it, and the next write deletes it.
    disk.failWrites = false;
    place(pathOf(SCOPE_B, "json.tmp"), fileText(SCOPE_B, [saved("files", [])]).slice(0, 20));
    await expect(files.read(SCOPE_B)).resolves.toEqual([]);
    files.write(SCOPE_A, () => before);
    await files.flush();
    expect(names()).toEqual([`${fileName(SCOPE_A)}.json`]);
  });
});

describe("writing the files", () => {
  it("waits for a new scope's changes to stop, saves them together, and waits no longer than its cap", async () => {
    vi.useFakeTimers();
    try {
      const { files } = launch({ now: Date.now });
      const writes = () => disk.log.filter(line => line.startsWith("write")).length;
      files.write(SCOPE_A, () => [saved("files", [])]);
      files.write(SCOPE_B, () => [saved("files", [])]);
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS - 1);
      expect(writes()).toBe(0);
      files.write(SCOPE_A, () => [saved("chats", [])]);
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
      expect(writes()).toBe(2);
      await expect(files.read(SCOPE_A)).resolves.toEqual([saved("chats", [])]);

      // A change every half of the delay never lets a new scope go quiet: the write lands at the cap anyway.
      const scopeC = JSON.stringify(["https://dohc.example.com", "u-1", "ws-c"]);
      for (let elapsed = 0; elapsed < WRITE_MAX_DELAY_MS; elapsed += WRITE_DELAY_MS / 2) {
        files.write(scopeC, () => [saved("files", [])]);
        await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS / 2);
      }
      expect(writes()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a scope at most once every 30 s in the foreground, and at once when the app goes to the background", async () => {
    vi.useFakeTimers();
    try {
      const { files } = launch({ now: Date.now });
      const writes = () => disk.log.filter(line => line.startsWith("write")).length;
      const reply = (length: number) => [saved("thread:t-1", { kind: "thread", id: "t-1", title: "", messages: [], body: "x".repeat(length) })];
      files.write(SCOPE_A, () => reply(0));
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
      expect(writes()).toBe(1);

      // A reply streams in: a change every 250 ms for most of the next 30 s writes nothing more.
      let length = 0;
      for (let elapsed = 0; elapsed < WRITE_INTERVAL_MS - 2 * WRITE_DELAY_MS; elapsed += 250) {
        const now = ++length;
        files.write(SCOPE_A, () => reply(now));
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(writes()).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * WRITE_DELAY_MS);
      expect(writes()).toBe(2);
      await expect(files.read(SCOPE_A)).resolves.toEqual(reply(length));

      files.write(SCOPE_A, () => reply(length + 1));
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS);
      expect(writes()).toBe(2);
      // Going to the background saves at once.
      await files.flush();
      expect(writes()).toBe(3);
      await expect(files.read(SCOPE_A)).resolves.toEqual(reply(length + 1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a 2 MiB page, and leaves out the views past a scope's cap, keeping the listings", async () => {
    const { files } = launch();
    const page = (n: number) => saved(`page:${n}.md`, { kind: "page", markdown: `${n}`.repeat(2 * 1024 * 1024) });
    const listings = [saved("files", [{ path: "0.md", objectId: "object-0", page: true }]), saved("chats", [])];
    files.write(SCOPE_A, () => [...listings, page(1)]);
    await files.flush();
    await expect(files.read(SCOPE_A)).resolves.toEqual([...listings, page(1)]);

    files.write(SCOPE_A, () => [...listings, ...[1, 2, 3, 4, 5, 6].map(page)]);
    await files.flush();
    const kept = await files.read(SCOPE_A);
    expect(disk.files.get(pathOf(SCOPE_A))!.text.length).toBeLessThanOrEqual(SCOPE_MAX_BYTES);
    expect(kept.map(view => view.id)).toEqual(["files", "chats", "page:1.md", "page:2.md", "page:3.md", "page:4.md"]);
  });

  it("keeps the files under the total cap by deleting the scopes used least recently, across a relaunch", async () => {
    const scope = (n: number) => JSON.stringify(["https://dohc.example.com", "u-1", `ws-${n}`]);
    const views = [saved("page:a.md", { kind: "page", markdown: "x".repeat(1000) })];
    // Room for three scopes' files, each the same size.
    const totalMaxBytes = 3 * Buffer.byteLength(fileText(scope(1), views));
    const first = launch({ totalMaxBytes }).files;
    for (const n of [1, 2, 3]) {
      first.write(scope(n), () => views);
      await first.flush();
    }
    // Reading 1 uses it, so 2 is now the one used least recently.
    await first.read(scope(1));
    first.write(scope(4), () => views);
    await first.flush();
    expect(names()).toEqual([1, 3, 4].map(n => `${fileName(scope(n))}.json`).sort());

    // After a relaunch, the files go by when they were last written: 1, read but not written since, goes first.
    const second = launch({ totalMaxBytes }).files;
    second.write(scope(5), () => views);
    await second.flush();
    expect(names()).toEqual([3, 4, 5].map(n => `${fileName(scope(n))}.json`).sort());
  });
});

describe("deleting the files", () => {
  it("wins over a write in flight, and over one waiting on its timer", async () => {
    const { files } = launch();
    files.write(SCOPE_B, () => [saved("files", [])]);
    await files.flush();
    const release = hold("heldWrites");
    files.write(SCOPE_A, () => [saved("files", [])]);
    const writing = files.flush();
    await vi.waitFor(() => expect(names()).toContain(`${fileName(SCOPE_A)}.json.tmp`));
    files.write(SCOPE_B, () => [saved("chats", [])]);
    const removing = files.removeAll();
    release();
    await writing;
    await removing;
    await files.flush();
    expect(names()).toEqual([]);
  });

  it("deletes one scope's file over its write in flight, and keeps the others", async () => {
    const { files } = launch();
    files.write(SCOPE_B, () => [saved("files", [])]);
    await files.flush();
    const release = hold("heldWrites");
    files.write(SCOPE_A, () => [saved("files", [])]);
    const writing = files.flush();
    await vi.waitFor(() => expect(names()).toContain(`${fileName(SCOPE_A)}.json.tmp`));
    const removing = files.remove(SCOPE_A);
    release();
    await writing;
    await removing;
    expect(names()).toEqual([`${fileName(SCOPE_B)}.json`]);
  });

  it("answers no views to a read that a delete overtakes", async () => {
    place(pathOf(SCOPE_A), fileText(SCOPE_A, [saved("files", [])]));
    const { files } = launch();
    const release = hold("heldReads");
    const reading = files.read(SCOPE_A);
    void files.removeAll();
    release();
    await expect(reading).resolves.toEqual([]);
  });
});

// --- the read cache over the files ----------------------------------------------------------------------------------

const ops = (result: unknown, cursor: string): Answer => ({ status: 200, body: { ok: true, result, cursor } });
const listing = (...paths: [string, string][]) => ({ ok: true, files: paths.map(([path, objectId]) => ({ path, objectId, contentKind: "text", byteLength: 1 })), folders: [] });
const feedPath = (workspaceId: string, since: string) => `/sync/${workspaceId}/ops/changes?since=${since}&hold=${FEED_HOLD_MS}`;
const NOT_FOUND: Answer = { status: 404, body: { ok: false, error: "not found", code: "not_found" } };
const held = () => new Promise<Answer>(() => {});
const count = (server: ReturnType<typeof testServer>, path: string) => server.calls.filter(call => call.path === path).length;
const A_FILES = [{ path: "a.md", objectId: "object-a", page: true }];

function serverWithA() {
  const server = testServer();
  server.on("POST", "/sync/ws-a/ops/listFiles", ops(listing(["a.md", "object-a"]), "0.5.2"));
  server.on("POST", "/sync/ws-a/ops/documentRead", ops({ ok: true, path: "a.md", markdown: "# A" }, "0.6.2"));
  server.on("POST", "/sync/ws-b/ops/listFiles", ops(listing(["b.md", "object-b"]), "0.5.2"));
  server.on("GET", feedPath("ws-a", "0.5.2"), held);
  server.on("GET", feedPath("ws-b", "0.5.2"), held);
  return server;
}

function signInTo(server: ReturnType<typeof testServer>) {
  return {
    client: createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal }),
    isCurrent: () => true, origin: server.origin, userId: "u-1",
  };
}

function open(server: ReturnType<typeof testServer>, cache: ReadCache, workspaceId = "ws-a", signIn = signInTo(server)) {
  const data = createWorkspaceData({ signIn, workspaceId, cache });
  data.resume();
  return data;
}

/** A first launch that reads A's files and a page, and saves them. */
async function readBeforeRelaunch(server: ReturnType<typeof testServer>) {
  const { files, cache } = launch();
  const data = open(server, cache);
  data.subscribe(views.files, () => {});
  data.subscribe(views.page("a.md"), () => {});
  await vi.waitFor(() => expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" }));
  await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
  await files.flush();
  data.stop();
}

describe("a relaunch", () => {
  it("shows what was read before, without reading it again, and resumes the feed from its cursor", async () => {
    const server = serverWithA();
    await readBeforeRelaunch(server);
    const reads = server.calls.filter(call => call.method === "POST").length;

    const { cache } = launch();
    const data = open(server, cache);
    data.subscribe(views.files, () => {});
    data.subscribe(views.page("a.md"), () => {});
    await vi.waitFor(() => expect(data.state(views.files)).toMatchObject({ value: A_FILES, loading: false }));
    expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A" });
    // The feed starts from the oldest cursor the file held: the listing's 0.5.2, not the page's 0.6.2.
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    expect(server.calls.filter(call => call.method === "POST")).toHaveLength(reads);
  });

  it("paints the loading state before the file is read, and asks the server nothing until it is", async () => {
    const server = serverWithA();
    await readBeforeRelaunch(server);
    const calls = server.calls.length;
    const release = hold("heldReads");
    disk.log.length = 0;

    const { cache } = launch();
    const data = open(server, cache);
    const painted = vi.fn();
    data.subscribe(views.files, painted);
    // The first frame: the read has started, hasn't settled, and the screen shows the loading state it shows today.
    disk.log.push("first frame");
    expect(data.state(views.files)).toMatchObject({ value: null, loading: true, problem: null });
    data.retry(views.files);
    expect(server.calls).toHaveLength(calls);
    release();
    await vi.waitFor(() => expect(data.state(views.files).value).toEqual(A_FILES));
    expect(disk.log.slice(0, 3)).toEqual([`read ${fileName(cacheScope(signInTo(server), "ws-a"))}.json`, "first frame",
      `read done ${fileName(cacheScope(signInTo(server), "ws-a"))}.json`]);
    expect(painted).toHaveBeenCalled();
  });

  it("reads a stale view again on open, and everything again when the server can't continue from the cursor", async () => {
    const server = serverWithA();
    await readBeforeRelaunch(server);
    const scope = cacheScope(signInTo(server), "ws-a");
    const marked = launch();
    await marked.cache.restore(scope);
    const page = marked.cache.get(scope, "page:a.md")!;
    marked.cache.set(scope, { ...page, stale: true });
    await marked.files.flush();

    let answer!: (value: Answer) => void;
    server.on("GET", feedPath("ws-a", "0.5.2"), () => new Promise<Answer>(done => { answer = done; }));
    server.on("GET", feedPath("ws-a", "1.0.0"), held);
    server.on("POST", "/sync/ws-a/ops/documentRead", ops({ ok: true, path: "a.md", markdown: "# A again" }, "1.0.0"));
    server.on("POST", "/sync/ws-a/ops/listFiles", ops(listing(["a.md", "object-a"], ["b.md", "object-b"]), "1.0.0"));
    const { files, cache } = launch();
    const data = open(server, cache);
    data.subscribe(views.page("a.md"), () => {});
    data.subscribe(views.files, () => {});
    // The stale page reads at once; the fresh listing waits for the feed.
    await vi.waitFor(() => expect(data.state(views.page("a.md")).value).toEqual({ kind: "page", markdown: "# A again" }));
    expect(data.state(views.files).value).toEqual(A_FILES);
    expect(count(server, "/sync/ws-a/ops/listFiles")).toBe(1);

    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(2));
    answer({ status: 200, body: { ok: true, cursor: "1.0.0", replace: true } });
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(2));
    await files.flush();
    expect((await launch().files.read(scope)).find(view => view.id === "files")?.cursor).toBe("1.0.0");
  });
});

describe("wiping the files", () => {
  const SAVED: StoredSignIn = { origin: "https://dohc.example.com", token: "tok-1", userId: "u-1", email: "ice@example.com" };

  async function signedIn(server: ReturnType<typeof testServer>) {
    const { files, cache } = launch();
    const account = createAccount({ store: memoryStore(SAVED).store, fetch: server.fetch, sleep: async () => {} });
    // The cache follows the account from launch, before the saved sign-in is read, as the app's does.
    cache.follow(account);
    await account.restore();
    const state = account.state();
    if (state.status !== "signed-in") throw new Error("expected signed-in");
    return { files, cache, account, signIn: state.signIn };
  }

  it("keeps the files when the saved sign-in is read at launch, and deletes them at a launch with none", async () => {
    const server = serverWithA();
    await readBeforeRelaunch(server);
    const { files } = await signedIn(server);
    await files.flush();
    expect(names()).toHaveLength(1);

    const signedOut = launch();
    const account = createAccount({ store: memoryStore(null).store, fetch: server.fetch });
    signedOut.cache.follow(account);
    await account.restore();
    await signedOut.files.flush();
    expect(names()).toEqual([]);
  });

  it("deletes every file at sign-out, even with a write in flight", async () => {
    const server = serverWithA();
    const { files, cache, account, signIn } = await signedIn(server);
    const b = open(server, cache, "ws-b", signIn);
    b.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(b.state(views.files).value).toHaveLength(1));
    await files.flush();
    b.stop();
    const release = hold("heldWrites");
    const a = open(server, cache, "ws-a", signIn);
    a.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(a.state(views.files).value).toHaveLength(1));
    const writing = files.flush();
    await vi.waitFor(() => expect(names()).toContain(`${fileName(cacheScope(signIn, "ws-a"))}.json.tmp`));

    await account.signOut();
    release();
    await writing;
    await files.flush();
    expect(names()).toEqual([]);
    expect(disk.folders.size).toBe(0);
  });

  it("deletes every file at a 401", async () => {
    const server = serverWithA();
    const { files, cache, account, signIn } = await signedIn(server);
    let answer!: (value: Answer) => void;
    server.on("GET", feedPath("ws-a", "0.5.2"), () => new Promise<Answer>(done => { answer = done; }));
    const a = open(server, cache, "ws-a", signIn);
    a.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    await files.flush();
    expect(names()).toHaveLength(1);

    answer({ status: 401 });
    await vi.waitFor(() => expect(account.state()).toMatchObject({ status: "signed-out", ended: true }));
    await files.flush();
    expect(names()).toEqual([]);
  });

  it("deletes a gone workspace's file, and keeps the others", async () => {
    const server = serverWithA();
    const { files, cache } = launch();
    const b = open(server, cache, "ws-b");
    b.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(b.state(views.files).value).toHaveLength(1));
    b.stop();
    let answer!: (value: Answer) => void;
    server.on("GET", feedPath("ws-a", "0.5.2"), () => new Promise<Answer>(done => { answer = done; }));
    const onGone = vi.fn();
    const a = createWorkspaceData({ signIn: signInTo(server), workspaceId: "ws-a", cache, onGone });
    a.resume();
    a.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(count(server, feedPath("ws-a", "0.5.2"))).toBe(1));
    await files.flush();
    expect(names()).toHaveLength(2);

    answer(NOT_FOUND);
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
    await files.flush();
    expect(names()).toEqual([`${fileName(cacheScope(signInTo(server), "ws-b"))}.json`]);
  });

  it("deletes the file of a workspace hidden on this phone", async () => {
    const server = serverWithA();
    server.on("GET", "/sync/account/workspaces", { status: 200, body: { ok: true, workspaces: [
      { workspaceId: "ws-a", name: "Trip", canOpen: true, showOnPhone: true },
    ] } });
    server.on("POST", "/sync/account/workspaces/ws-a/show-on-phone", { status: 200, body: { ok: true } });
    const { files, cache } = launch();
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
    expect(names()).toHaveLength(1);

    workspace.setShowOnPhone("ws-a", false);
    await files.flush();
    expect(names()).toEqual([]);
    workspace.stop();
  });
});

describe("a restore that a delete overtakes", () => {
  /** Files whose read the test answers; the cache's continuation then runs after anything the test does next. */
  function heldFiles() {
    let answer!: (views: readonly SavedView[]) => void;
    const read = new Promise<readonly SavedView[]>(done => { answer = done; });
    const files: CacheFiles = {
      read: () => read, write: () => {}, flush: async () => {}, remove: async () => {}, removeAll: async () => {},
      keep: async () => {}, readList: async () => null, writeList: async () => {},
    };
    return { files, answer };
  }
  const SAVED_FILES = saved("files", A_FILES);

  it("adds nothing when the scope is dropped after the file is read", async () => {
    const { files, answer } = heldFiles();
    const cache = createReadCache(files);
    const restoring = cache.restore(SCOPE_A);
    answer([SAVED_FILES]);
    cache.drop(SCOPE_A);
    await restoring;
    expect(cache.entries(SCOPE_A)).toEqual([]);
  });

  it("adds nothing when the cache is cleared after the file is read", async () => {
    const { files, answer } = heldFiles();
    const cache = createReadCache(files);
    const restoring = cache.restore(SCOPE_A);
    answer([SAVED_FILES]);
    cache.clear();
    await restoring;
    expect(cache.entries(SCOPE_A)).toEqual([]);
  });

  it("reads a scope's file once for two restores, so a list that drops the scope meanwhile wins over both", async () => {
    const { files, answer } = heldFiles();
    let reads = 0;
    const counted: CacheFiles = { ...files, read: scope => { reads += 1; return files.read(scope); } };
    const cache = createReadCache(counted);
    // A, then B, then A again: the second store for A waits on the first one's read.
    const first = cache.restore(SCOPE_A);
    const second = cache.restore(SCOPE_A);
    expect(reads).toBe(1);
    cache.savedList({ origin: "https://dohc.example.com", userId: "u-1" })!
      .listed([{ workspaceId: "ws-b", name: "ws-b", canOpen: true, showOnPhone: true }]);
    answer([SAVED_FILES]);
    await Promise.all([first, second]);
    expect(cache.entries(SCOPE_A)).toEqual([]);
  });

  it("leaves a store that was waiting on the file with nothing restored, reading from the server", async () => {
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
    const { files } = launch();
    const body = "x".repeat(1024 * 1024);
    const items = Array.from({ length: 100 }, (_, i) => ({
      message: { id: `m-${i}`, threadId: "t-1", authorKind: "human", authorName: "Maya Chen", body, createdAtMs: 1 }, replyCount: 0, lastReplyAtMs: null,
    }));
    const stream = saved("stream:g-1", { kind: "stream", name: "General", groupKind: "group", items });
    files.write(SCOPE_A, () => [saved("files", A_FILES), stream]);
    const stringify = vi.spyOn(JSON, "stringify");
    let longest = 0;
    try {
      await files.flush();
      longest = Math.max(...stringify.mock.results.map(result => typeof result.value === "string" ? result.value.length : 0));
    } finally {
      stringify.mockRestore();
    }
    expect(longest).toBeLessThan(1024);
    expect((await files.read(SCOPE_A)).map(view => view.id)).toEqual(["files"]);
  });

  it("is measured by a floor that never passes its real size", () => {
    for (const value of [
      { kind: "missing", last: undefined }, { kind: "page", markdown: "line\n\"quoted\"\\ \u0001 é 中文 😀" }, [], {}, [null, 1.5, true, "x"],
      { items: [{ message: { body: "", createdAtMs: 0 }, lastReplyAtMs: null }] }, [undefined],
    ]) {
      expect(leastJsonBytes(value, Infinity), JSON.stringify(value)).toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(value), "utf8"));
    }
  });
});

describe("the saved workspace list", () => {
  const SIGN_IN_SCOPE = JSON.stringify(["https://dohc.example.com", "u-1"]);
  const LIST_FILE = `${fileName(SIGN_IN_SCOPE)}.list`;
  const entry = (workspaceId: string, showOnPhone = true) => ({ workspaceId, name: workspaceId, canOpen: true, showOnPhone });
  const listAnswer = (...workspaces: ReturnType<typeof entry>[]): Answer => ({ status: 200, body: { ok: true, workspaces } });

  /** One launch of the app's account side: the list, with its saved copy, and the open workspace. */
  function launchAccount(server: ReturnType<typeof testServer>, signIn = signInTo(server)) {
    const { files, cache } = launch();
    const list = createWorkspaceList(signIn, cache.savedList(signIn));
    const workspace = createOpenWorkspace({ signIn, list, cache });
    workspace.subscribe(() => {});
    workspace.resume();
    list.reload();
    return { files, cache, list, workspace, signIn };
  }

  /** A first launch that lists A and B, and reads the files of each. */
  async function readBoth(server: ReturnType<typeof testServer>) {
    server.on("GET", "/sync/account/workspaces", listAnswer(entry("ws-a"), entry("ws-b")));
    const first = launchAccount(server);
    await vi.waitFor(() => expect(first.workspace.state().currentWorkspaceId).toBe("ws-a"));
    first.workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(first.cache.entries(cacheScope(first.signIn, "ws-a"))).toHaveLength(1));
    first.workspace.choose("ws-b");
    first.workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(first.cache.entries(cacheScope(first.signIn, "ws-b"))).toHaveLength(1));
    first.workspace.choose("ws-a");
    await first.files.flush();
    first.workspace.stop();
    expect(names()).toEqual([`${fileName(cacheScope(first.signIn, "ws-a"))}.json`, `${fileName(cacheScope(first.signIn, "ws-b"))}.json`, LIST_FILE].sort());
  }

  it("opens the last workspace from the cache after a relaunch, while the server's list is still on its way", async () => {
    const server = serverWithA();
    await readBoth(server);
    server.on("GET", "/sync/account/workspaces", held);
    const listReads = count(server, "/sync/account/workspaces");
    const reads = count(server, "/sync/ws-a/ops/listFiles");

    const { list, workspace } = launchAccount(server);
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
    await readBoth(server);
    server.on("GET", "/sync/account/workspaces", "offline");
    const { list, workspace } = launchAccount(server);
    await vi.waitFor(() => expect(list.state()).toMatchObject({ status: "ready", problem: "offline" }));
    expect(workspace.state().currentWorkspaceId).toBe("ws-a");
    workspace.stop();
  });

  it("lets the server's list decide: a workspace it drops goes, with its file, and one hidden elsewhere loses its file", async () => {
    const server = serverWithA();
    await readBoth(server);
    let answer!: (value: Answer) => void;
    server.on("GET", "/sync/account/workspaces", () => new Promise<Answer>(done => { answer = done; }));
    const { files, cache, list, workspace, signIn } = launchAccount(server);
    await vi.waitFor(() => expect(workspace.state().currentWorkspaceId).toBe("ws-a"));
    workspace.state().data!.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(cache.entries(cacheScope(signIn, "ws-a"))).toHaveLength(1));

    // A has gone from the account, and B was hidden on the desktop while the phone was closed.
    answer(listAnswer(entry("ws-b", false), entry("ws-c")));
    await vi.waitFor(() => expect(list.state()).toMatchObject({ status: "ready", workspaces: [{ workspaceId: "ws-b" }, { workspaceId: "ws-c" }] }));
    expect(workspace.state().currentWorkspaceId).toBe("ws-c");
    expect(cache.entries(cacheScope(signIn, "ws-a"))).toEqual([]);
    await files.flush();
    expect(names()).toEqual([LIST_FILE]);
    await expect(launch().files.readList(SIGN_IN_SCOPE)).resolves.toEqual([entry("ws-b", false), entry("ws-c")]);
    workspace.stop();
  });

  it("saves a Show on phone change made on this phone", async () => {
    const server = serverWithA();
    await readBoth(server);
    server.on("PATCH", "/sync/account/workspaces/ws-b", { status: 200, body: { ok: true, workspaceId: "ws-b", showOnPhone: false } });
    server.on("GET", "/sync/account/workspaces", listAnswer(entry("ws-a"), entry("ws-b")), listAnswer(entry("ws-a"), entry("ws-b", false)));
    const { files, list, workspace: open } = launchAccount(server);
    await vi.waitFor(() => expect(list.state()).toMatchObject({ status: "ready" }));
    await vi.waitFor(() => expect(count(server, "/sync/account/workspaces")).toBe(2));
    open.setShowOnPhone("ws-b", false);
    await vi.waitFor(() => expect(list.state()).toMatchObject({ pending: new Set() }));
    await files.flush();
    await expect(launch().files.readList(SIGN_IN_SCOPE)).resolves.toEqual([entry("ws-a"), entry("ws-b", false)]);
    expect(names()).not.toContain(`${fileName(SCOPE_B)}.json`);
    open.stop();
  });

  it("is deleted at sign-out", async () => {
    const server = serverWithA();
    server.on("GET", "/sync/account/workspaces", listAnswer(entry("ws-a")));
    const { files, cache } = launch();
    const account = createAccount({ store: memoryStore({ origin: server.origin, token: "tok-1", userId: "u-1", email: "ice@example.com" }).store, fetch: server.fetch });
    cache.follow(account);
    await account.restore();
    const state = account.state();
    if (state.status !== "signed-in") throw new Error("expected signed-in");
    const list = createWorkspaceList(state.signIn, cache.savedList(state.signIn));
    list.reload();
    await vi.waitFor(() => expect(list.state().status).toBe("ready"));
    await files.flush();
    expect(names()).toEqual([LIST_FILE]);

    await account.signOut();
    await files.flush();
    expect(names()).toEqual([]);
  });
});
