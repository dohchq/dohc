import { NOTICE_READ_RETENTION_MS, NOTICE_WAIT_MAX_MS } from "@dohc/workspace-contracts/relay";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountWorkspace } from "./api";
import { createServerClient, ServerError, type Fetch } from "./client";
import type { NoticeFiles } from "./noticeFiles";
import { createNoticeStore, noticeScope, type NoticeStore } from "./noticeStore";
import { noticePageBody, relayRow } from "./testServer";
import type { WorkspaceList } from "./workspaceList";

const ORIGIN = "https://dohc.example.com";

// A server whose every request waits until the test answers it, so each test steps the store one request at a time.
interface Call {
  readonly path: string;
  readonly body: unknown;
  answer(status: number, body?: unknown): void;
  offline(): void;
}

function fakeServer() {
  const open: Call[] = [];
  const waiters: { match(call: Call): boolean; take(call: Call): void }[] = [];
  const fetch: Fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const call: Call = {
        path: url.slice(ORIGIN.length),
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        answer: (status, body) => resolve({ status, json: async () => body }),
        offline: () => reject(new TypeError("Network request failed")),
      };
      init.signal.addEventListener("abort", () => {
        const index = open.indexOf(call);
        if (index >= 0) open.splice(index, 1);
        reject(new Error("aborted"));
      });
      const waiter = waiters.findIndex((entry) => entry.match(call));
      if (waiter >= 0) waiters.splice(waiter, 1)[0]?.take(call);
      else open.push(call);
    });
  const next = (match: (call: Call) => boolean) => {
    const index = open.findIndex(match);
    if (index >= 0) return Promise.resolve(open.splice(index, 1)[0]!);
    return new Promise<Call>((take) => waiters.push({ match, take }));
  };
  return {
    fetch,
    /** The next read of the list. */
    read: () => next((call) => call.path.startsWith("/sync/notices?")),
    /** The next request that sends marks. */
    marks: () => next((call) => call.path.startsWith("/sync/notices/marks")),
  };
}

/** The waits the store starts between tries, each ended by the test. */
function fakeSleep() {
  interface Wait {
    readonly ms: number;
    done(): void;
  }
  const open: Wait[] = [];
  let waiting: ((wait: Wait) => void) | null = null;
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const wait = { ms, done: resolve };
      signal.addEventListener("abort", () => reject(new ServerError("cancelled")));
      if (waiting) {
        const take = waiting;
        waiting = null;
        take(wait);
      } else open.push(wait);
    });
  /** The next wait the store starts. */
  const next = () =>
    open.length > 0
      ? Promise.resolve(open.shift()!)
      : new Promise<Wait>((take) => {
          waiting = take;
        });
  return { sleep, next };
}

function fakeList(workspaces: readonly AccountWorkspace[]) {
  let state: WorkspaceList = { status: "ready", workspaces, problem: null, pending: new Set() };
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: readonly AccountWorkspace[], pending: readonly string[] = []) {
      state = { status: "ready", workspaces: next, problem: null, pending: new Set(pending) };
      for (const listener of listeners) listener();
    },
  };
}

type MemoryFiles = NoticeFiles & {
  readonly lists: Map<string, unknown>;
  readonly marks: Map<string, unknown>;
};

/** Files in memory, where a write lands at once. */
function memoryFiles(): MemoryFiles {
  const lists = new Map<string, unknown>();
  const marks = new Map<string, unknown>();
  return {
    lists,
    marks,
    readList: async (scope) => lists.get(scope) ?? null,
    writeList: (scope, rows) => void lists.set(scope, rows()),
    readMarks: async (scope) => marks.get(scope) ?? null,
    async writeMarks(scope, list) {
      marks.set(scope, list);
    },
    flush: async () => undefined,
    async clear() {
      lists.clear();
      marks.clear();
    },
  };
}

const trip: AccountWorkspace = {
  workspaceId: "w1",
  name: "Trip",
  canOpen: true,
  showOnPhone: true,
};
const work: AccountWorkspace = {
  workspaceId: "w2",
  name: "Work",
  canOpen: true,
  showOnPhone: true,
};
const OK = { ok: true, dismissed: [] };
const scope = noticeScope({ origin: ORIGIN, userId: "u1" });

let stores: NoticeStore[] = [];
afterEach(() => {
  for (const store of stores) store.stop();
  stores = [];
});

function setup(
  options: {
    readonly files?: MemoryFiles;
    readonly workspaces?: readonly AccountWorkspace[];
    readonly now?: () => number;
  } = {},
) {
  const server = fakeServer();
  const timers = fakeSleep();
  const files = options.files ?? memoryFiles();
  const list = fakeList(options.workspaces ?? [trip, work]);
  let current = true;
  const signIn = {
    origin: ORIGIN,
    userId: "u1",
    isCurrent: () => current,
    client: createServerClient({
      origin: ORIGIN,
      token: "t",
      fetch: server.fetch,
      signal: new AbortController().signal,
    }),
  };
  const store = createNoticeStore({
    signIn,
    list,
    files,
    sleep: timers.sleep,
    ...(options.now ? { now: options.now } : {}),
  });
  stores.push(store);
  const ids = () => store.state().notices.map((row) => row.noticeId);
  return { server, timers, files, list, store, ids, signOut: () => void (current = false) };
}

/** Answers a read with a page, and resolves with the store's next read: by then it has taken the page. */
async function reply(
  server: ReturnType<typeof fakeServer>,
  call: Call | Promise<Call>,
  notices: unknown[],
  fields: Record<string, unknown> = {},
) {
  (await call).answer(200, noticePageBody(notices, fields));
  return server.read();
}

describe("the account's Notices", () => {
  it("reads the whole list, then holds a caught-up read open, always in the phone's scope", async () => {
    const { server, store, ids } = setup();
    store.resume();
    const first = await server.read();
    expect(first.path).toBe("/sync/notices?scope=phone&limit=100");
    const held = await reply(server, first, [relayRow("a")], { replace: true, nextCursor: "5" });
    expect(held.path).toBe(
      `/sync/notices?scope=phone&limit=100&cursor=5&wait=${NOTICE_WAIT_MAX_MS}`,
    );
    expect(ids()).toEqual(["a"]);
    expect(store.state().known).toBe(true);
    store.mark("a", "read");
    expect((await server.marks()).path).toBe("/sync/notices/marks?scope=phone");
  });

  it("isn't known until the last page, and reads on past pages the phone's scope emptied", async () => {
    const { server, store, ids, files } = setup();
    store.resume();
    let call = await reply(server, server.read(), [], {
      replace: true,
      hasMore: true,
      nextCursor: "100.300",
    });
    expect(call.path).toBe("/sync/notices?scope=phone&limit=100&cursor=100.300");
    expect(store.state().known).toBe(false);
    expect(files.lists.has(scope)).toBe(false);
    call = await reply(server, call, [relayRow("b")], { hasMore: true, nextCursor: "200.300" });
    expect(ids()).toEqual([]);
    await reply(server, call, [], { nextCursor: "300" });
    expect(ids()).toEqual(["b"]);
    expect(store.state().known).toBe(true);
    expect(files.lists.get(scope)).toHaveLength(1);
  });

  it("keeps the last whole list while a new one is read, then drops it once", async () => {
    const { server, store, ids } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("old")], { replace: true, nextCursor: "1" });
    store.refresh();
    const second = await reply(server, server.read(), [relayRow("new", { changeSeq: 2 })], {
      replace: true,
      hasMore: true,
      nextCursor: "2.3",
    });
    expect(ids()).toEqual(["old"]);
    // A continuation page keeps what the new list's first page read.
    await reply(server, second, [relayRow("newer", { changeSeq: 3, createdAtMs: 2000 })], {
      nextCursor: "3",
    });
    expect(ids()).toEqual(["newer", "new"]);
  });

  it("restarts from no cursor after a relaunch, never taking a part-read list as whole", async () => {
    const files = memoryFiles();
    const first = setup({ files });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    first.store.refresh();
    await reply(first.server, first.server.read(), [relayRow("b")], {
      replace: true,
      hasMore: true,
      nextCursor: "1.5",
    });
    first.store.stop();

    const second = setup({ files });
    second.store.resume();
    const call = await second.server.read();
    expect(call.path).toBe("/sync/notices?scope=phone&limit=100");
    expect(second.ids()).toEqual(["a"]);
    expect(second.store.state().known).toBe(true);
  });

  it("takes a newer change's cleared mark, and never an older change", async () => {
    const { server, store } = setup();
    store.resume();
    let call = await reply(server, server.read(), [relayRow("a", { changeSeq: 4, readAtMs: 50 })], {
      replace: true,
    });
    call = await reply(server, call, [relayRow("a", { changeSeq: 3, readAtMs: null })]);
    expect(store.state().notices[0]?.readAtMs).toBe(50);
    await reply(server, call, [relayRow("a", { changeSeq: 5, readAtMs: null })]);
    expect(store.state().notices[0]?.readAtMs).toBeNull();
  });

  it("deletes a row the server removed, and shows nothing of a removed row it never held", async () => {
    const { server, store, ids } = setup();
    store.resume();
    const call = await reply(server, server.read(), [relayRow("a")], { replace: true });
    await reply(server, call, [
      relayRow("a", { removed: true, title: "", changeSeq: 2 }),
      relayRow("ghost", { removed: true, title: "", senderLabel: "Secret label", changeSeq: 3 }),
    ]);
    expect(ids()).toEqual([]);
    expect(JSON.stringify(store.state())).not.toContain("Secret label");
  });

  it("lets a row go at its expiry with no answer, and keeps a marked row for the mark's retention", async () => {
    let now = 0;
    const { server, store, ids, list } = setup({ now: () => now });
    store.resume();
    await reply(
      server,
      server.read(),
      [relayRow("a", { expiresAtMs: 100 }), relayRow("b", { expiresAtMs: 100 })],
      { replace: true },
    );
    store.mark("b", "read");
    const first = await server.marks();
    store.mark("x", "read");
    first.answer(200, OK);
    // One request at a time: the second goes once the first answer is taken.
    await server.marks();
    now = 150;
    // Any change shows the list again; this one changes nothing else.
    list.set([trip, work]);
    expect(ids()).toEqual(["b"]);
    expect(store.state().notices[0]?.expiresAtMs).toBe(NOTICE_READ_RETENTION_MS);
  });
});

describe("marks on the account's Notices", () => {
  it("ends restored after Done then Undo, though the dismissal's answer was lost", async () => {
    const { server, timers, store, ids } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    expect(ids()).toEqual([]);
    const dismissal = await server.marks();
    expect(dismissal.body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
    store.mark("a", "restore");
    expect(ids()).toEqual(["a"]);
    dismissal.offline();
    (await timers.next()).done();
    // The next request sends only the later of the two.
    const retry = await server.marks();
    expect(retry.body).toEqual({ marks: [{ noticeId: "a", mark: "restore" }] });
    retry.answer(200, OK);
    store.mark("a", "read");
    await server.marks();
    expect(ids()).toEqual(["a"]);
  });

  it("ends unread after read then unread, sending the unread after the read's answer", async () => {
    const { server, store } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a", { changeSeq: 2 })], { replace: true });
    store.mark("a", "read");
    const read = await server.marks();
    store.mark("a", "unread");
    read.answer(200, OK);
    const unread = await server.marks();
    expect(unread.body).toEqual({ marks: [{ noticeId: "a", mark: "unread" }] });
    unread.answer(200, OK);
    store.mark("b", "read");
    await server.marks();
    expect(store.state().notices[0]?.readAtMs).toBeNull();
  });

  it("keeps a row another device restored while this phone's dismissal was on its way", async () => {
    const { server, store, ids } = setup();
    store.resume();
    const held = await reply(server, server.read(), [relayRow("a", { changeSeq: 2 })], {
      replace: true,
    });
    store.mark("a", "dismissed");
    const dismissal = await server.marks();
    // The server took the dismissal (3), then another device restored the row (4), before the answer came.
    await reply(server, held, [relayRow("a", { changeSeq: 4 })], { nextCursor: "4" });
    dismissal.answer(200, { ok: true, dismissed: ["a"] });
    store.mark("a", "read");
    await server.marks();
    expect(ids()).toEqual(["a"]);
  });

  it("sends the marks a relaunch found waiting", async () => {
    const files = memoryFiles();
    const first = setup({ files });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    first.store.mark("a", "dismissed");
    (await first.server.marks()).offline();
    await first.timers.next();
    first.store.stop();
    expect(files.marks.get(scope)).toMatchObject([{ noticeId: "a", mark: "dismissed" }]);

    const second = setup({ files });
    second.store.resume();
    const sent = await second.server.marks();
    expect(second.ids()).toEqual([]);
    expect(sent.body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
    sent.answer(200, { ok: true, dismissed: ["a"] });
    second.store.mark("b", "read");
    await second.server.marks();
    expect(files.marks.get(scope)).toMatchObject([{ noticeId: "b", mark: "read" }]);
  });

  it("marks read only the rows shown unread", async () => {
    const { server, store } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a"), relayRow("b", { readAtMs: 5 })], {
      replace: true,
    });
    store.markAllRead();
    expect((await server.marks()).body).toEqual({ marks: [{ noticeId: "a", mark: "read" }] });
  });
});

describe("Show on phone and the account's Notices", () => {
  it("drops a hidden workspace's rows at once, and reads the whole list again at each step", async () => {
    const { server, store, ids, list, files } = setup();
    store.resume();
    const held = await reply(
      server,
      server.read(),
      [relayRow("a"), relayRow("b", { workspaceId: "w2" })],
      { replace: true },
    );
    list.set([trip, { ...work, showOnPhone: false }], ["w2"]);
    expect(ids()).toEqual(["a"]);
    expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a" }]);
    // The held read was cancelled first, so its late answer adds nothing.
    held.answer(200, noticePageBody([relayRow("c", { changeSeq: 9 })]));
    const restart = await server.read();
    expect(restart.path).toBe("/sync/notices?scope=phone&limit=100");
    // Until the server confirms the change, the relay may still send the hidden rows; the phone keeps them out.
    const next = await reply(
      server,
      restart,
      [relayRow("a"), relayRow("b", { workspaceId: "w2" })],
      { replace: true },
    );
    expect(next.path).toContain("wait=");
    expect(ids()).toEqual(["a"]);

    // The change failed and rolled back: the whole list again, with the workspace's rows.
    list.set([trip, work]);
    await reply(server, server.read(), [relayRow("a"), relayRow("b", { workspaceId: "w2" })], {
      replace: true,
    });
    expect(ids()).toEqual(["a", "b"]);
  });

  it("reads the whole list again when another device's change shows a workspace", async () => {
    const { server, store, list } = setup({ workspaces: [trip, { ...work, showOnPhone: false }] });
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true, nextCursor: "8" });
    list.set([trip, work]);
    expect((await server.read()).path).toBe("/sync/notices?scope=phone&limit=100");
  });
});

describe("the account's Notices across sign-out and failure", () => {
  it("lands nothing a read held before the sign-in ended answers", async () => {
    const { server, store, ids, files, signOut } = setup();
    store.resume();
    const held = await reply(server, server.read(), [relayRow("a")], { replace: true });
    signOut();
    await files.clear();
    held.answer(200, noticePageBody([relayRow("b", { changeSeq: 2 })]));
    store.mark("a", "read");
    expect(ids()).toEqual(["a"]);
    expect(files.lists.size + files.marks.size).toBe(0);
  });

  it("shows the first failure at once with nothing known, and takes it back on the next answer", async () => {
    const { server, timers, store } = setup();
    store.resume();
    (await server.read()).offline();
    const wait = await timers.next();
    expect(store.state().reads).toEqual({ problem: "offline", failures: 1 });
    expect(store.state().known).toBe(false);
    wait.done();
    await reply(server, server.read(), [], { replace: true });
    expect(store.state().reads).toEqual({ problem: null, failures: 1 });
    expect(store.state().known).toBe(true);
  });
});
