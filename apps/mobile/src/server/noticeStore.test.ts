import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_READ_RETENTION_MS,
  NOTICE_WAIT_MAX_MS,
} from "@dohc/workspace-contracts/relay";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "./account";
import type { AccountWorkspace } from "./api";
import { createServerClient, ServerError, type Fetch } from "./client";
import type { NoticeFiles } from "./noticeFiles";
import {
  clearNoticesOnSignInChange,
  createNoticeStore,
  NOTICE_FAILURES_SHOWN,
  NOTICE_RETRY_MS,
  noticeScope,
  type NoticeListState,
  type NoticeStore,
} from "./noticeStore";
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
  /** Any state, such as a list not read yet or one that failed. */
  const replace = (next: WorkspaceList) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: readonly AccountWorkspace[], pending: readonly string[] = []) {
      replace({ status: "ready", workspaces: next, problem: null, pending: new Set(pending) });
    },
    replace,
  };
}

/** A point a save stops at until the test releases it, as a closed app would stop it for good. */
function gate() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => {
    reach = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  return {
    reached,
    release,
    /** Where the save stops: says it got there, then waits. */
    pass() {
      reach();
      return released;
    },
  };
}

type MemoryFiles = NoticeFiles & {
  readonly lists: Map<string, unknown>;
  readonly marks: Map<string, unknown>;
  /** Stops an ordered save before its list lands, or between its list and its marks. */
  hold: { beforeList?: ReturnType<typeof gate>; beforeMarks?: ReturnType<typeof gate> };
  /** An ordered save's list write fails. */
  failList: boolean;
  /** Every save of the marks fails, as on a full disk. */
  failMarks: boolean;
  /** A list save waits for its debounce, which a closed app never lets run. */
  deferList: boolean;
};

/** Files in memory, where a write lands at once unless the test holds it. */
function memoryFiles(): MemoryFiles {
  const lists = new Map<string, unknown>();
  const marks = new Map<string, unknown>();
  const files: MemoryFiles = {
    lists,
    marks,
    hold: {},
    failList: false,
    failMarks: false,
    deferList: false,
    readList: async (scope) => lists.get(scope) ?? null,
    writeList(scope, rows) {
      if (!files.deferList) lists.set(scope, rows());
    },
    readMarks: async (scope) => marks.get(scope) ?? null,
    async writeMarks(scope, list) {
      if (files.failMarks) return false;
      marks.set(scope, list);
      return true;
    },
    // With nothing held, it all lands before the call returns.
    async writeListThenMarks(scope, rows, list) {
      if (files.hold.beforeList) await files.hold.beforeList.pass();
      if (files.failList) return "list-failed";
      lists.set(scope, rows);
      if (files.hold.beforeMarks) await files.hold.beforeMarks.pass();
      const next = list();
      if (files.failMarks) return "marks-failed";
      marks.set(scope, next);
      return "saved";
    },
    flush: async () => undefined,
    async clear() {
      lists.clear();
      marks.clear();
    },
  };
  return files;
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
/** The tests' clock: after the fixtures were made and before they expire (`relayRow`). */
const NOW = 5_000_000;
/** What Done, taken at NOW, left a fixture row as. */
const DONE_RESULT = {
  readAtMs: null,
  dismissedAtMs: NOW,
  expiresAtMs: NOW + NOTICE_DISMISSED_RETENTION_MS,
};

let stores: NoticeStore[] = [];
afterEach(() => {
  for (const store of stores) store.stop();
  stores = [];
  vi.useRealTimers();
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
  let checked: (() => void) | null = null;
  const signIn = {
    origin: ORIGIN,
    userId: "u1",
    // Once the sign-in has ended, the next check says so to the test: the store has taken what it was handling.
    isCurrent() {
      if (!current && checked) {
        const done = checked;
        checked = null;
        done();
      }
      return current;
    },
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
    now: options.now ?? (() => NOW),
  });
  stores.push(store);
  const ids = () => store.state().notices.map((row) => row.noticeId);
  /** Ends the sign-in; resolves when the store next checks it. */
  const signOut = () => {
    current = false;
    return new Promise<void>((done) => {
      checked = done;
    });
  };
  return { server, timers, files, list, store, ids, signIn, signOut };
}

/** Resolves once the store's state passes `check`. */
function until(store: NoticeStore, check: (state: NoticeListState) => boolean) {
  return new Promise<void>((done) => {
    if (check(store.state())) return done();
    const off = store.subscribe(() => {
      if (!check(store.state())) return;
      off();
      done();
    });
  });
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
    expect(ids()).toEqual(["a"]);
    await reply(server, call, [
      relayRow("a", { removed: true, title: "", changeSeq: 2 }),
      relayRow("ghost", { removed: true, title: "", senderLabel: "Secret label", changeSeq: 3 }),
    ]);
    expect(ids()).toEqual([]);
    expect(JSON.stringify(store.state())).not.toContain("Secret label");
  });

  it("lets a row go at its expiry with no other event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { server, store, ids } = setup({ now: () => Date.now() });
    store.resume();
    await reply(
      server,
      server.read(),
      [relayRow("a", { expiresAtMs: 100 }), relayRow("b", { expiresAtMs: 200 })],
      { replace: true },
    );
    expect(ids()).toEqual(["a", "b"]);
    // Offline and idle: no answer, list change, or mark comes.
    vi.advanceTimersByTime(99);
    expect(ids()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual(["b"]);
    vi.advanceTimersByTime(100);
    expect(ids()).toEqual([]);
  });

  it("keeps a row it marked for the mark's retention, until a read gives the relay's", async () => {
    const { server, store } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("b")], { replace: true });
    store.mark("b", "read");
    const first = await server.marks();
    store.mark("x", "read");
    first.answer(200, OK);
    // One request at a time: the second goes once the first answer is taken.
    await server.marks();
    expect(store.state().notices[0]?.expiresAtMs).toBe(NOW + NOTICE_READ_RETENTION_MS);
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
    // The next request sends both, in order, so the restore lands last.
    const retry = await server.marks();
    expect(retry.body).toEqual({
      marks: [
        { noticeId: "a", mark: "dismissed" },
        { noticeId: "a", mark: "restore" },
      ],
    });
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

  it("keeps a Read made after an Undo, sending the Undo's restore before it", async () => {
    const { server, store, ids } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    const first = await server.marks();
    // Undo, Mark read, then Done again, all before the first Done's answer.
    store.mark("a", "restore");
    store.mark("a", "read");
    store.mark("a", "dismissed");
    expect(ids()).toEqual([]);
    first.answer(200, OK);
    const rest = await server.marks();
    expect(rest.body).toEqual({
      marks: [
        { noticeId: "a", mark: "restore" },
        { noticeId: "a", mark: "read" },
        { noticeId: "a", mark: "dismissed" },
      ],
    });
    rest.answer(200, OK);
    store.mark("a", "restore");
    (await server.marks()).answer(200, OK);
    expect(ids()).toEqual(["a"]);
    expect(store.state().notices[0]?.readAtMs).toBe(NOW);
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
    expect(files.marks.get(scope)).toEqual([{ noticeId: "a", mark: "dismissed", atMs: NOW }]);

    const second = setup({ files });
    second.store.resume();
    const sent = await second.server.marks();
    expect(second.ids()).toEqual([]);
    expect(sent.body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
    sent.answer(200, { ok: true, dismissed: ["a"] });
    second.store.mark("b", "read");
    await second.server.marks();
    expect(files.marks.get(scope)).toEqual([{ noticeId: "b", mark: "read", atMs: NOW }]);
  });

  it.each(["beforeList", "beforeMarks"] as const)(
    "keeps a taken Done across a relaunch stopped %s, without sending it again",
    async (point) => {
      const files = memoryFiles();
      const first = setup({ files });
      first.store.resume();
      await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
      first.store.mark("a", "dismissed");
      const stop = gate();
      files.hold[point] = stop;
      (await first.server.marks()).answer(200, { ok: true, dismissed: ["a"] });
      await stop.reached;
      // The app closes here; the held save never finishes.
      first.store.stop();
      files.hold = {};
      expect(files.marks.get(scope)).toEqual([
        { noticeId: "a", mark: "dismissed", atMs: NOW, taken: 1, result: DONE_RESULT },
      ]);

      const second = setup({ files });
      second.store.resume();
      await second.server.read();
      expect(second.ids()).toEqual([]);
      // A mark made now is the first one sent: the taken Done isn't sent again.
      second.store.mark("b", "read");
      expect((await second.server.marks()).body).toEqual({
        marks: [{ noticeId: "b", mark: "read" }],
      });
      expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a", dismissedAtMs: NOW }]);
      expect(files.marks.get(scope)).toEqual([{ noticeId: "b", mark: "read", atMs: NOW }]);
    },
  );

  it.each(["beforeList", "beforeMarks"] as const)(
    "keeps a Done whose row the feed changed before its answer, across a relaunch stopped %s",
    async (point) => {
      const files = memoryFiles();
      const first = setup({ files });
      first.store.resume();
      const held = await reply(first.server, first.server.read(), [relayRow("a")], {
        replace: true,
      });
      files.deferList = true;
      first.store.mark("a", "dismissed");
      const done = await first.server.marks();
      // The relay took Done, and the held read brings the row's new sequence before Done's answer.
      await reply(first.server, held, [relayRow("a", { changeSeq: 2, dismissedAtMs: NOW })], {
        nextCursor: "2",
      });
      expect(files.lists.get(scope)).toMatchObject([{ changeSeq: 1, dismissedAtMs: null }]);
      const stop = gate();
      files.hold[point] = stop;
      done.answer(200, { ok: true, dismissed: ["a"] });
      await stop.reached;
      first.store.stop();
      files.hold = {};
      files.deferList = false;

      // Offline: the relaunch's read is never answered.
      const second = setup({ files });
      second.store.resume();
      await second.server.read();
      expect(second.ids()).toEqual([]);
      second.store.mark("b", "read");
      expect((await second.server.marks()).body).toEqual({
        marks: [{ noticeId: "b", mark: "read" }],
      });
    },
  );

  it.each(["read", "dismissed"] as const)(
    "keeps a taken %s sent against a row newer than the list file, across a relaunch before the list lands",
    async (mark) => {
      const files = memoryFiles();
      const first = setup({ files });
      first.store.resume();
      const held = await reply(first.server, first.server.read(), [relayRow("a")], {
        replace: true,
      });
      // The feed brings sequence 2; its list save still waits when the mark goes.
      files.deferList = true;
      await reply(first.server, held, [relayRow("a", { changeSeq: 2 })], { nextCursor: "2" });
      first.store.mark("a", mark);
      const stop = gate();
      files.hold.beforeList = stop;
      (await first.server.marks()).answer(200, OK);
      await stop.reached;
      first.store.stop();
      files.hold = {};
      files.deferList = false;
      expect(files.lists.get(scope)).toMatchObject([{ changeSeq: 1 }]);
      expect(files.marks.get(scope)).toMatchObject([{ noticeId: "a", taken: 2 }]);

      const second = setup({ files });
      second.store.resume();
      await second.server.read();
      expect(second.ids()).toEqual(mark === "read" ? ["a"] : []);
      expect(files.lists.get(scope)).toMatchObject([
        mark === "read" ? { readAtMs: NOW } : { dismissedAtMs: NOW },
      ]);
      second.store.mark("b", "read");
      expect((await second.server.marks()).body).toEqual({
        marks: [{ noticeId: "b", mark: "read" }],
      });
      expect(files.marks.get(scope)).toEqual([{ noticeId: "b", mark: "read", atMs: NOW }]);
    },
  );

  it("keeps a taken mark whose row the list file lacks until a whole list is saved", async () => {
    const files = memoryFiles();
    const first = setup({ files });
    first.store.resume();
    const held = await reply(first.server, first.server.read(), [], { replace: true });
    files.deferList = true;
    await reply(first.server, held, [relayRow("a", { changeSeq: 2 })], { nextCursor: "2" });
    first.store.mark("a", "dismissed");
    const stop = gate();
    files.hold.beforeList = stop;
    (await first.server.marks()).answer(200, OK);
    await stop.reached;
    first.store.stop();
    files.hold = {};
    files.deferList = false;

    const second = setup({ files });
    second.store.resume();
    const call = await second.server.read();
    expect(files.marks.get(scope)).toMatchObject([{ noticeId: "a", taken: 2 }]);
    second.store.mark("b", "read");
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "b", mark: "read" }],
    });
    await reply(second.server, call, [relayRow("a", { changeSeq: 3, dismissedAtMs: NOW })], {
      replace: true,
    });
    expect(second.ids()).toEqual([]);
    expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a", changeSeq: 3 }]);
    expect(files.marks.get(scope)).toEqual([{ noticeId: "b", mark: "read", atMs: NOW }]);
  });

  const replays = (["read", "dismissed"] as const).flatMap((mark) =>
    (["beforeList", "beforeMarks"] as const).flatMap((point) =>
      (["before", "after"] as const).map((when) => [mark, point, when] as const),
    ),
  );
  it.each(replays)(
    "replays a taken %s stopped %s with the expiry its answer set, relaunched %s it",
    async (mark, point, when) => {
      let clock = NOW;
      const files = memoryFiles();
      const first = setup({ files, now: () => clock });
      first.store.resume();
      await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
      first.store.mark("a", mark);
      const stop = gate();
      files.hold[point] = stop;
      (await first.server.marks()).answer(200, OK);
      await stop.reached;
      first.store.stop();
      files.hold = {};

      const retention = mark === "read" ? NOTICE_READ_RETENTION_MS : NOTICE_DISMISSED_RETENTION_MS;
      const expires = NOW + retention;
      clock = when === "before" ? expires - 1 : expires + 1;
      const second = setup({ files, now: () => clock });
      second.store.resume();
      await second.server.read();
      if (when === "after") {
        expect(second.ids()).toEqual([]);
        expect(files.lists.get(scope)).toEqual([]);
      } else {
        expect(second.ids()).toEqual(mark === "read" ? ["a"] : []);
        expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a", expiresAtMs: expires }]);
      }
    },
  );

  it("keeps a taken mark in the marks file while the list can't be saved", async () => {
    const files = memoryFiles();
    const { server, store } = setup({ files });
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    files.failList = true;
    store.mark("a", "dismissed");
    (await server.marks()).answer(200, OK);
    store.mark("b", "read");
    await server.marks();
    expect(files.marks.get(scope)).toEqual([
      { noticeId: "a", mark: "dismissed", atMs: NOW, taken: 1, result: DONE_RESULT },
      { noticeId: "b", mark: "read", atMs: NOW },
    ]);
  });

  it("shows a marks save that failed, saves again until one lands, and keeps the mark for a relaunch", async () => {
    const files = memoryFiles();
    const first = setup({ files });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    files.failMarks = true;
    first.store.mark("a", "dismissed");
    // The relay hasn't answered the mark; only the save waits to try again.
    const retry = await first.timers.next();
    expect(retry.ms).toBe(NOTICE_RETRY_MS);
    expect(first.store.state().marks).toEqual({ problem: "storage", failures: 1 });
    expect(files.marks.has(scope)).toBe(false);
    files.failMarks = false;
    retry.done();
    await until(first.store, (state) => state.marks.problem === null);
    expect(first.store.state().marks).toEqual({ problem: null, failures: 1 });
    expect(files.marks.get(scope)).toEqual([{ noticeId: "a", mark: "dismissed", atMs: NOW }]);
    first.store.stop();

    const second = setup({ files });
    second.store.resume();
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "a", mark: "dismissed" }],
    });
    expect(second.ids()).toEqual([]);
  });

  it("shows a failed marks save before a relaunch, though no save ever lands", async () => {
    const files = memoryFiles();
    const first = setup({ files });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    files.failMarks = true;
    const shown = until(first.store, (state) => state.marks.problem === "storage");
    first.store.mark("a", "dismissed");
    await shown;
    expect(first.store.state().marks).toEqual({ problem: "storage", failures: 1 });
    // The app closes before any save lands, and before the relay answers.
    first.store.stop();

    // A disk that never takes a save can't keep the mark; the person was told while dohc was open.
    const second = setup({ files });
    second.store.resume();
    await second.server.read();
    expect(second.ids()).toEqual(["a"]);
  });

  it("drops an owed marks save when the sign-in ends", async () => {
    const { server, timers, store, files, signOut } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    files.failMarks = true;
    store.mark("a", "dismissed");
    const retry = await timers.next();
    const checked = signOut();
    files.failMarks = false;
    retry.done();
    await checked;
    expect(files.marks.has(scope)).toBe(false);
  });

  it("keeps marks a server error failed, and sends them again", async () => {
    const { server, timers, store, ids, files } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    (await server.marks()).answer(500, { ok: false, code: "internal_error" });
    // Dropping them would read the list again at once; keeping them waits for the next try.
    const next = await Promise.race([timers.next(), server.read().then(() => null)]);
    expect(next).not.toBeNull();
    expect(ids()).toEqual([]);
    expect(files.marks.get(scope)).toEqual([{ noticeId: "a", mark: "dismissed", atMs: NOW }]);
    next?.done();
    expect((await server.marks()).body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
  });

  it("drops marks only on a refusal the relay means, and reports it", async () => {
    const { server, store, files } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    (await server.marks()).answer(400, { ok: false, code: "bad_request" });
    // The list is read again, and the refusal shows.
    await server.read();
    expect(store.state().marks).toEqual({ problem: "refused", failures: 1 });
    expect(files.marks.get(scope)).toEqual([]);
  });

  it("reports a failure again after a request in between succeeds", async () => {
    const { server, timers, store } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a"), relayRow("b")], { replace: true });
    /** Fails the next requests until a failure is shown, and resolves with the wait after it. */
    const failUntilShown = async () => {
      for (let tries = 1; tries < NOTICE_FAILURES_SHOWN; tries += 1) {
        (await server.marks()).offline();
        (await timers.next()).done();
      }
      (await server.marks()).offline();
      return timers.next();
    };
    store.mark("a", "read");
    (await failUntilShown()).done();
    expect(store.state().marks).toEqual({ problem: "offline", failures: 1 });
    const success = await server.marks();
    // Made while that request is on its way, so the same run of the sender sends it next.
    store.mark("b", "read");
    success.answer(200, OK);
    await failUntilShown();
    expect(store.state().marks).toEqual({ problem: "offline", failures: 2 });
  });

  it("keeps a taken Done when a whole list read before it landed arrives after its answer", async () => {
    const { server, store, ids } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.refresh();
    const whole = await server.read();
    store.mark("a", "dismissed");
    (await server.marks()).answer(200, { ok: true, dismissed: ["a"] });
    // One request at a time: this one goes once Done's answer is taken.
    store.mark("x", "read");
    await server.marks();
    // The whole list the server read before Done landed still has the row at sequence 1.
    let call = await reply(server, whole, [relayRow("a")], { replace: true });
    expect(ids()).toEqual([]);
    // The row at a later sequence holds Done; then another device's restore shows.
    call = await reply(server, call, [relayRow("a", { changeSeq: 2, dismissedAtMs: NOW })]);
    expect(ids()).toEqual([]);
    await reply(server, call, [relayRow("a", { changeSeq: 3 })]);
    expect(ids()).toEqual(["a"]);
  });

  // In the next two tests, a late copy of the row at the sequence Done was sent at shows whether the store still
  // holds Done's result for it: a held result would hide the copy. A mark made later shows the list again at the
  // clock's new time.
  it("holds no result for a taken Done whose row changed before its answer, once that row expires", async () => {
    let clock = NOW;
    const { server, store, ids } = setup({ now: () => clock });
    store.resume();
    const held = await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    const done = await server.marks();
    // Another device restored the row (3) after Done landed (2), before Done's answer came.
    const call = await reply(
      server,
      held,
      [relayRow("a", { changeSeq: 3, expiresAtMs: NOW + 100 })],
      { nextCursor: "3" },
    );
    done.answer(200, { ok: true, dismissed: ["a"] });
    // One request at a time: this one goes once Done's answer is taken.
    store.mark("x", "read");
    await server.marks();
    expect(ids()).toEqual(["a"]);
    clock = NOW + 100;
    store.mark("y", "read");
    expect(ids()).toEqual([]);
    await reply(server, call, [relayRow("a", { expiresAtMs: 10 ** 12 })]);
    expect(ids()).toEqual(["a"]);
  });

  it("holds no result for a taken Done once the result expires", async () => {
    let clock = NOW;
    const { server, store, ids } = setup({ now: () => clock });
    store.resume();
    const call = await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    (await server.marks()).answer(200, { ok: true, dismissed: ["a"] });
    // One request at a time: this one goes once Done's answer is taken.
    store.mark("x", "read");
    await server.marks();
    clock = DONE_RESULT.expiresAtMs;
    store.mark("y", "read");
    await reply(server, call, [relayRow("a", { expiresAtMs: 10 ** 12 })]);
    expect(ids()).toEqual(["a"]);
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
    expect(ids()).toEqual(["a", "b"]);
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

describe("a workspace that leaves the list and the account's Notices", () => {
  it("drops its rows naming a path, thread, or message at once, before any read answers", async () => {
    const { server, store, ids, list, files } = setup();
    store.resume();
    await reply(
      server,
      server.read(),
      [
        relayRow("a"),
        relayRow("b", { workspaceId: "w2" }),
        relayRow("c", { workspaceId: "w2", kind: "mention", target: { path: "plan.md" } }),
      ],
      { replace: true },
    );
    expect(ids()).toEqual(["a", "b", "c"]);
    list.set([trip]);
    expect(ids()).toEqual(["a"]);
    expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a" }]);
    const restart = await server.read();
    expect(restart.path).toBe("/sync/notices?scope=phone&limit=100");
    // The relay checks ownership as it answers, so a row it serves after the list was read stays.
    await reply(server, restart, [relayRow("a"), relayRow("b", { workspaceId: "w2" })], {
      replace: true,
    });
    expect(ids()).toEqual(["a", "b"]);
  });

  it("keeps a located row the relay serves in a workspace made since the list was read", async () => {
    const { server, store, ids } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a"), relayRow("n", { workspaceId: "w9" })], {
      replace: true,
    });
    expect(ids()).toEqual(["a", "n"]);
  });

  it.each([
    [
      "a personal agent's sign-in in a workspace never listed",
      relayRow("kept", {
        kind: "personal-agent-signed-in",
        workspaceId: "w3",
        target: { settings: "agents", agent: "p-1" },
      }),
    ],
    [
      "a share's row, which names no workspace",
      relayRow("kept", {
        kind: "share-received",
        workspaceId: null,
        recipientShareId: "s1",
        target: { share: "s1", path: "plan.md" },
      }),
    ],
    [
      "a row naming no path, thread, or message",
      relayRow("kept", { workspaceId: "w2", target: { automation: "a1" } }),
    ],
  ])("keeps %s", async (_, row) => {
    const { server, store, ids, list, files } = setup();
    store.resume();
    await reply(server, server.read(), [row, relayRow("b", { workspaceId: "w2" })], {
      replace: true,
    });
    list.set([trip]);
    expect(ids()).toEqual(["kept"]);
    expect(files.lists.get(scope)).toMatchObject([{ noticeId: "kept" }]);
  });

  it("drops nothing while the list isn't read", async () => {
    const files = memoryFiles();
    files.lists.set(scope, [relayRow("a"), relayRow("b", { workspaceId: "w2" })]);
    const { server, store, ids, list } = setup({ files });
    list.replace({ status: "loading" });
    store.resume();
    const early = await server.read();
    expect(ids()).toEqual(["a", "b"]);
    list.replace({ status: "failed", problem: "offline" });
    expect(ids()).toEqual(["a", "b"]);
    expect(files.lists.get(scope)).toHaveLength(2);
    // Once read, the list rules out the workspace it lacks.
    list.set([trip]);
    expect(ids()).toEqual(["a"]);
    expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a" }]);
    // The read begun before the list was read is older than it, so it starts again, and its late answer lands nothing.
    const fresh = server.read();
    early.answer(
      200,
      noticePageBody([relayRow("a"), relayRow("b", { workspaceId: "w2" })], { replace: true }),
    );
    expect((await fresh).path).toBe("/sync/notices?scope=phone&limit=100");
    expect(ids()).toEqual(["a"]);
    expect(files.lists.get(scope)).toMatchObject([{ noticeId: "a" }]);
  });
});

/** An account whose state the test sets, for `clearNoticesOnSignInChange`. */
function fakeAccount(initial: AccountState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: AccountState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

const signedOut: AccountState = {
  status: "signed-out",
  origin: ORIGIN,
  ended: false,
  forgetFailed: false,
};

describe("the account's Notices across sign-out and failure", () => {
  it("lands nothing a read held before the sign-in ended answers, and its files go", async () => {
    const { server, store, ids, files, signIn, signOut } = setup();
    const account = fakeAccount({ status: "signed-in", signIn: { ...signIn, email: "a@b.c" } });
    clearNoticesOnSignInChange(account, files);
    store.resume();
    const held = await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "read");
    await server.marks();
    expect(files.lists.size).toBe(1);
    expect(files.marks.size).toBe(1);
    const checked = signOut();
    account.set(signedOut);
    held.answer(200, noticePageBody([relayRow("b", { changeSeq: 2 })]));
    await checked;
    store.mark("a", "unread");
    expect(ids()).toEqual(["a"]);
    expect(files.lists.size + files.marks.size).toBe(0);
  });

  it("deletes the files on sign-out, a new sign-in, or a launch with none, never on the saved one", () => {
    const signIn = (userId: string) => ({ ...setup().signIn, userId, email: `${userId}@b.c` });
    const run = (from: AccountState, to: AccountState) => {
      const files = memoryFiles();
      files.marks.set(scope, []);
      const account = fakeAccount(from);
      clearNoticesOnSignInChange(account, files);
      account.set(to);
      return files.marks.size === 0;
    };
    const first: AccountState = { status: "signed-in", signIn: signIn("u1") };
    expect(run({ status: "loading" }, first)).toBe(false);
    expect(run({ status: "loading" }, signedOut)).toBe(true);
    expect(run(first, signedOut)).toBe(true);
    expect(run(first, { status: "signed-in", signIn: signIn("u2") })).toBe(true);
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
