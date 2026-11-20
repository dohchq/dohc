import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_READ_RETENTION_MS,
  NOTICE_WAIT_MAX_MS,
} from "@dohc/workspace-contracts/relay";
import { noticeStorageWords } from "@dohc/interface-words/notices";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "./account";
import type { AccountWorkspace } from "./api";
import { createServerClient, ServerError, type Fetch } from "./client";
import {
  clearNoticeListsOnSignInChange,
  createNoticeStore,
  NOTICE_FAILURES_SHOWN,
  NOTICE_RETRY_MS,
  type NoticeListState,
  type NoticeStore,
} from "./noticeStore";
import { keptDisk, type KeptDisk } from "./testKeptDisk";
import { noticePageBody, relayRow } from "./testServer";
import type { WorkspaceList } from "./workspaceList";

const ORIGIN = "https://dohc.example.com";

interface Call {
  readonly path: string;
  readonly body: unknown;
  readonly keys: readonly unknown[];
  answer(status: number, body?: unknown): void;
  offline(): void;
}

function withoutKeys(body: unknown): { body: unknown; keys: unknown[] } {
  const marks = (body as { marks?: unknown } | undefined)?.marks;
  if (!Array.isArray(marks)) return { body, keys: [] };
  return {
    body: { ...(body as object), marks: marks.map(({ key: _, ...mark }) => mark) },
    keys: marks.map((mark: { key?: unknown }) => mark.key),
  };
}

function fakeServer() {
  const open: Call[] = [];
  const waiters: { match(call: Call): boolean; take(call: Call): void }[] = [];
  const fetch: Fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const call: Call = {
        path: url.slice(ORIGIN.length),
        ...withoutKeys(init.body === undefined ? undefined : JSON.parse(init.body)),
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
    read: () => next((call) => call.path.startsWith("/sync/notices?")),
    marks: () => next((call) => call.path.startsWith("/sync/notices/marks")),
  };
}

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

/** The account's list in kept.db, or undefined while it has none. */
function listed(disk: KeptDisk): unknown {
  const [row] = disk.sql(
    "SELECT rows FROM notice_lists WHERE origin = ? AND account_id = ?",
    ORIGIN,
    "u1",
  );
  return typeof row?.rows === "string" ? JSON.parse(row.rows) : undefined;
}

/** The account's marks in kept.db, in order. */
const marked = (disk: KeptDisk) =>
  disk
    .sql(
      "SELECT notice_id, mark, at_ms FROM notice_marks WHERE origin = ? AND account_id = ? ORDER BY sequence",
      ORIGIN,
      "u1",
    )
    .map((row) => ({ noticeId: row.notice_id, mark: row.mark, atMs: row.at_ms }));

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
/** The tests' clock: after the fixtures were made and before they expire (`relayRow`). */
const NOW = 5_000_000;
const DONE_RESULT = {
  readAtMs: null,
  dismissedAtMs: NOW,
  expiresAtMs: NOW + NOTICE_DISMISSED_RETENTION_MS,
};
const MARK_A = { noticeId: "a", mark: "dismissed", atMs: NOW };

let stores: NoticeStore[] = [];
afterEach(() => {
  for (const store of stores) store.stop();
  stores = [];
  vi.useRealTimers();
});

function setup(
  options: {
    readonly disk?: KeptDisk;
    readonly workspaces?: readonly AccountWorkspace[];
    readonly now?: () => number;
    readonly held?: () => boolean;
  } = {},
) {
  const server = fakeServer();
  const timers = fakeSleep();
  const disk = options.disk ?? keptDisk();
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
  const kept = disk.launch();
  const store = createNoticeStore({
    signIn,
    list,
    store: kept,
    held: options.held,
    listSaveMs: 0,
    sleep: timers.sleep,
    now: options.now ?? (() => NOW),
  });
  stores.push(store);
  const ids = () => store.state().notices.map((row) => row.noticeId);
  const signOut = () => {
    current = false;
    return new Promise<void>((done) => {
      checked = done;
    });
  };
  return { server, timers, disk, kept, list, store, ids, signIn, signOut };
}

/** Resolves at the store's next change. */
const published = (store: NoticeStore) =>
  new Promise<void>((done) => {
    const off = store.subscribe(() => {
      off();
      done();
    });
  });

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
    const { server, store, ids, disk } = setup();
    store.resume();
    let call = await reply(server, server.read(), [], {
      replace: true,
      hasMore: true,
      nextCursor: "100.300",
    });
    expect(call.path).toBe("/sync/notices?scope=phone&limit=100&cursor=100.300");
    expect(store.state().known).toBe(false);
    expect(listed(disk)).toBeUndefined();
    call = await reply(server, call, [relayRow("b")], { hasMore: true, nextCursor: "200.300" });
    expect(ids()).toEqual([]);
    await reply(server, call, [], { nextCursor: "300" });
    expect(ids()).toEqual(["b"]);
    expect(store.state().known).toBe(true);
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
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
    await reply(server, second, [relayRow("newer", { changeSeq: 3, createdAtMs: 2000 })], {
      nextCursor: "3",
    });
    expect(ids()).toEqual(["newer", "new"]);
  });

  it("restarts from no cursor after a relaunch, never taking a part-read list as whole", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    first.store.refresh();
    await reply(first.server, first.server.read(), [relayRow("b")], {
      replace: true,
      hasMore: true,
      nextCursor: "1.5",
    });
    first.store.stop();

    const second = setup({ disk });
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
    // Shown once kept.db holds it.
    expect(ids()).toEqual(["a"]);
    await until(store, (state) => state.notices.length === 0);
    const dismissal = await server.marks();
    expect(dismissal.body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
    store.mark("a", "restore");
    await until(store, (state) => state.notices.length === 1);
    dismissal.offline();
    (await timers.next()).done();
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
    const { server, store, ids, disk } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    const first = await server.marks();
    store.mark("a", "restore");
    store.mark("a", "read");
    store.mark("a", "dismissed");
    await vi.waitFor(() => expect(marked(disk)).toHaveLength(4));
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

  it("applies nothing for a mark the relay names as repeated, keeping another device's later change", async () => {
    const { server, timers, store, ids } = setup();
    store.resume();
    const held = await reply(server, server.read(), [relayRow("a", { changeSeq: 2 })], {
      replace: true,
    });
    store.mark("a", "dismissed");
    const lost = await server.marks();
    await reply(server, held, [relayRow("a", { changeSeq: 4 })], { nextCursor: "4" });
    lost.offline();
    (await timers.next()).done();
    const retry = await server.marks();
    expect(retry.keys).toEqual(lost.keys);
    retry.answer(200, { ok: true, dismissed: [], repeated: lost.keys });
    await vi.waitFor(() => expect(ids()).toEqual(["a"]));
  });

  it("keeps a mark through a relaunch, and sends it then", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    first.store.mark("a", "dismissed");
    (await first.server.marks()).offline();
    await first.timers.next();
    first.store.stop();
    disk.crash();
    expect(marked(disk)).toEqual([MARK_A]);

    const second = setup({ disk });
    second.store.resume();
    const sent = await second.server.marks();
    expect(second.ids()).toEqual([]);
    expect(sent.body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
    sent.answer(200, { ok: true, dismissed: ["a"] });
    second.store.mark("b", "read");
    await second.server.marks();
    await vi.waitFor(() =>
      expect(marked(disk)).toEqual([{ noticeId: "b", mark: "read", atMs: NOW }]),
    );
  });

  it("commits a taken mark's result and the removal of its row together", async () => {
    const { server, store, disk } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    store.mark("a", "dismissed");
    const done = await server.marks();
    disk.failCommits = { match: /notice_lists/, lands: false };
    done.answer(200, { ok: true, dismissed: ["a"] });
    await until(store, (state) => state.marks.problem === "unrecorded");
    // Neither stands: the mark still waits, and the list still shows the row.
    expect(marked(disk)).toEqual([MARK_A]);
    expect(listed(disk)).toMatchObject([{ noticeId: "a", dismissedAtMs: null }]);
    disk.failCommits = null;
    store.retryMarks();
    await until(store, (state) => state.marks.problem === null);
    expect(marked(disk)).toEqual([]);
    expect(listed(disk)).toMatchObject([{ noticeId: "a", ...DONE_RESULT }]);

    // A relaunch shows the result, and sends nothing again.
    const second = setup({ disk });
    second.store.resume();
    await second.server.read();
    expect(second.ids()).toEqual([]);
    second.store.mark("b", "read");
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "b", mark: "read" }],
    });
  });

  it("neither shows nor sends a mark whose commit failed, commits it again until one lands, and keeps it for a relaunch", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    disk.failWrites = /notice_marks/;
    first.store.mark("a", "dismissed");
    // Nothing went to the relay; only the commit waits to try again.
    const retry = await first.timers.next();
    expect(retry.ms).toBe(NOTICE_RETRY_MS);
    expect(first.store.state().marks).toEqual({ problem: "unkept", failures: 1 });
    expect(first.ids()).toEqual(["a"]);
    expect(marked(disk)).toEqual([]);
    disk.failWrites = null;
    retry.done();
    await until(first.store, (state) => state.marks.problem === null);
    expect(first.store.state().marks).toEqual({ problem: null, failures: 1 });
    expect(first.ids()).toEqual([]);
    expect(marked(disk)).toEqual([MARK_A]);
    first.store.stop();

    const second = setup({ disk });
    second.store.resume();
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "a", mark: "dismissed" }],
    });
    expect(second.ids()).toEqual([]);
  });

  it("shows a failed commit before a relaunch, though none ever lands", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    disk.failWrites = /notice_marks/;
    const shown = until(first.store, (state) => state.marks.problem === "unkept");
    first.store.mark("a", "dismissed");
    await shown;
    expect(first.store.state().marks).toEqual({ problem: "unkept", failures: 1 });
    first.store.stop();

    // A disk that never takes a commit can't keep the mark; the person was told while dohc was open.
    disk.failWrites = null;
    const second = setup({ disk });
    second.store.resume();
    await second.server.read();
    expect(second.ids()).toEqual(["a"]);
  });

  it("drops an owed commit when the sign-in ends", async () => {
    const { server, timers, store, disk, signOut } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    disk.failWrites = /notice_marks/;
    store.mark("a", "dismissed");
    const retry = await timers.next();
    const checked = signOut();
    disk.failWrites = null;
    retry.done();
    await checked;
    expect(marked(disk)).toEqual([]);
  });

  it("writes and sends nothing while Sign out holds kept.db, and says why", async () => {
    let holding = false;
    const { server, store, ids, disk } = setup({ held: () => holding });
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    holding = true;
    await expect(store.mark("a", "dismissed")).resolves.toBe(false);
    expect(store.state().marks).toEqual({ problem: "held", failures: 1 });
    expect(ids()).toEqual(["a"]);
    expect(marked(disk)).toEqual([]);
  });

  it("keeps one row per mark when a commit lands but reports failure, so nothing dismisses again after Undo", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    disk.failCommits = { match: /INSERT INTO notice_marks/, lands: true };
    const kept = first.store.mark("a", "dismissed");
    const retry = await first.timers.next();
    expect(first.store.state().marks.problem).toBe("unkept");
    expect(marked(disk)).toEqual([MARK_A]);
    disk.failCommits = null;
    retry.done();
    await expect(kept).resolves.toBe(true);
    expect(marked(disk)).toEqual([MARK_A]);
    (await first.server.marks()).answer(200, { ok: true, dismissed: ["a"] });
    // Undo.
    await expect(first.store.mark("a", "restore")).resolves.toBe(true);
    (await first.server.marks()).answer(200, OK);
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
    first.store.stop();

    const second = setup({ disk });
    second.store.resume();
    await second.server.read();
    expect(second.ids()).toEqual(["a"]);
    second.store.mark("b", "read");
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "b", mark: "read" }],
    });
  });

  it("sends a taken mark again with its key after a relaunch when its removal never committed, and keeps another device's change", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    const [key] = done.keys;
    expect(key).toEqual(expect.any(String));
    disk.failCommits = { match: /notice_lists/, lands: false };
    done.answer(200, { ok: true, dismissed: ["a"] });
    await until(first.store, (state) => state.marks.problem === "unrecorded");
    disk.crash();
    disk.failCommits = null;

    // Another device restored the row meanwhile. The Done goes again with the same key, and the relay, which applied
    // that key, leaves the row restored and says so.
    const second = setup({ disk });
    second.store.resume();
    const sent = second.server.marks();
    await reply(second.server, second.server.read(), [relayRow("a", { changeSeq: 3 })], {
      replace: true,
    });
    const again = await sent;
    expect(again.body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
    expect(again.keys).toEqual([key]);
    again.answer(200, { ok: true, dismissed: [], repeated: [key] });
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
    expect(second.ids()).toEqual(["a"]);
    expect(listed(disk)).toMatchObject([{ noticeId: "a", changeSeq: 3, dismissedAtMs: null }]);
  });

  it("sends each mark with its own key, and the same key on every try", async () => {
    const { server, timers, store } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a"), relayRow("b")], { replace: true });
    store.markAllRead();
    const first = await server.marks();
    expect(new Set(first.keys).size).toBe(2);
    first.offline();
    (await timers.next()).done();
    const retry = await server.marks();
    expect(retry.keys).toEqual(first.keys);
  });

  it("records a mark the server took though a 401 stops the store before that commit runs", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    // A commit ahead in kept.db's queue holds the removal until after the 401.
    const release = disk.holdCommits();
    const ahead = first.kept.transaction(async () => undefined);
    await vi.waitFor(() => expect(disk.waiting()).toBe(1));
    const taken = published(first.store);
    done.answer(200, { ok: true, dismissed: ["a"] });
    await taken;
    void first.signOut();
    first.store.stop();
    release();
    await ahead;
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));

    const second = setup({ disk });
    second.store.resume();
    await second.server.read();
    second.store.mark("b", "read");
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "b", mark: "read" }],
    });
  });

  /** What the next sign-in to the account sends first, after a Read of its own: a mark left on disk would go first. */
  async function nextSignInSends(disk: KeptDisk) {
    const next = setup({ disk });
    next.store.resume();
    await next.server.read();
    void next.store.mark("z", "read");
    return (await next.server.marks()).body;
  }
  const ONLY_Z = { marks: [{ noticeId: "z", mark: "read" }] };

  it("records a mark the server took whose removal was backing off when a 401 stopped the store", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    void first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    disk.failCommits = { match: /notice_lists/, lands: false };
    done.answer(200, { ok: true, dismissed: ["a"] });
    const backingOff = await first.timers.next();
    expect(backingOff.ms).toBe(NOTICE_RETRY_MS);
    expect(marked(disk)).toEqual([MARK_A]);
    disk.failCommits = null;
    void first.signOut();
    first.store.stop();
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
    expect(await nextSignInSends(disk)).toEqual(ONLY_Z);
  });

  it("records a mark the server took whose removal waited behind a save already on its way, though a 401 stops the store", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    const held = await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    void first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    // A change the held read brings is saved, and that save, made before Done's answer, waits at its commit.
    const release = disk.holdCommits();
    await reply(first.server, held, [relayRow("b", { changeSeq: 2 })], { nextCursor: "2" });
    await vi.waitFor(() => expect(disk.waiting()).toBe(1));
    const taken = published(first.store);
    done.answer(200, { ok: true, dismissed: ["a"] });
    await taken;
    void first.signOut();
    first.store.stop();
    release();
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
    expect(await nextSignInSends(disk)).toEqual(ONLY_Z);
  });

  it("commits a taken mark's removal again when the commit on its way at a 401's stop fails", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    void first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    const release = disk.holdCommits();
    done.answer(200, { ok: true, dismissed: ["a"] });
    await vi.waitFor(() => expect(disk.waiting()).toBe(1));
    void first.signOut();
    first.store.stop();
    disk.failCommits = { match: /DELETE FROM notice_marks/, lands: false };
    release();
    const releaseRetry = disk.holdCommits();
    await vi.waitFor(() => expect(disk.waiting()).toBe(1));
    disk.failCommits = null;
    releaseRetry();
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
    expect(await nextSignInSends(disk)).toEqual(ONLY_Z);
  });

  it("records a mark the server took while another mark's insert was on its way, though a 401 stops the store", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    void first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    const release = disk.holdCommits();
    void first.store.mark("b", "read");
    await vi.waitFor(() => expect(disk.waiting()).toBe(1));
    const taken = published(first.store);
    done.answer(200, { ok: true, dismissed: ["a"] });
    await taken;
    void first.signOut();
    first.store.stop();
    release();
    // The Read's insert landed before the stop's removal ran; it waits for the next sign-in, and Done doesn't.
    await vi.waitFor(() =>
      expect(marked(disk)).toEqual([{ noticeId: "b", mark: "read", atMs: NOW }]),
    );
  });

  it("records a mark whose success answer arrives after the sign-in ended", async () => {
    const disk = keptDisk();
    const first = setup({ disk });
    first.store.resume();
    await reply(first.server, first.server.read(), [relayRow("a")], { replace: true });
    void first.store.mark("a", "dismissed");
    const done = await first.server.marks();
    void first.signOut();
    done.answer(200, { ok: true, dismissed: ["a"] });
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
    first.store.stop();
    expect(await nextSignInSends(disk)).toEqual(ONLY_Z);
  });

  it("never says the server took a refused mark whose removal failed", async () => {
    const { server, store, disk } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    void store.mark("a", "dismissed");
    const sent = await server.marks();
    disk.failWrites = /DELETE FROM notice_marks/;
    sent.answer(400, { ok: false, code: "bad_request" });
    await until(store, (state) => state.marks.problem === "unrecorded");
    expect(marked(disk)).toEqual([MARK_A]);
    const { title, body } = noticeStorageWords.unrecorded;
    expect(`${title} ${body}`).not.toMatch(/server (has|took|saved|kept)/i);
  });

  it("reports a failed read of the marks at the start, and sends a mark once storage recovers", async () => {
    const disk = keptDisk();
    disk.failReads = /notice_marks/;
    const { server, timers, store } = setup({ disk });
    store.resume();
    const retry = await timers.next();
    expect(store.state().marks).toEqual({ problem: "unread", failures: 1 });
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    disk.failReads = null;
    await expect(store.mark("a", "read")).resolves.toBe(true);
    expect((await server.marks()).body).toEqual({ marks: [{ noticeId: "a", mark: "read" }] });
    expect(store.state().marks.problem).toBeNull();
    retry.done();
  });

  it("keeps marks a server error failed, and sends them again", async () => {
    const { server, timers, store, ids, disk } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    (await server.marks()).answer(500, { ok: false, code: "internal_error" });
    // Dropping them would read the list again at once; keeping them waits for the next try.
    const next = await Promise.race([timers.next(), server.read().then(() => null)]);
    expect(next).not.toBeNull();
    expect(ids()).toEqual([]);
    expect(marked(disk)).toEqual([MARK_A]);
    next?.done();
    expect((await server.marks()).body).toEqual({ marks: [{ noticeId: "a", mark: "dismissed" }] });
  });

  it("drops marks only on a refusal the relay means, and reports it", async () => {
    const { server, store, disk } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "dismissed");
    (await server.marks()).answer(400, { ok: false, code: "bad_request" });
    await server.read();
    expect(store.state().marks).toEqual({ problem: "refused", failures: 1 });
    await vi.waitFor(() => expect(marked(disk)).toEqual([]));
  });

  it("reports a failure again after a request in between succeeds", async () => {
    const { server, timers, store } = setup();
    store.resume();
    await reply(server, server.read(), [relayRow("a"), relayRow("b")], { replace: true });
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
    const shown = published(store);
    store.mark("y", "read");
    await shown;
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
    const shown = published(store);
    store.mark("y", "read");
    await shown;
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
    const { server, store, ids, list, disk } = setup();
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
    await vi.waitFor(() => expect(listed(disk)).toMatchObject([{ noticeId: "a" }]));
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
    const { server, store, ids, list, disk } = setup();
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
    await vi.waitFor(() => expect(listed(disk)).toMatchObject([{ noticeId: "a" }]));
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
    const { server, store, ids, list, disk } = setup();
    store.resume();
    await reply(server, server.read(), [row, relayRow("b", { workspaceId: "w2" })], {
      replace: true,
    });
    list.set([trip]);
    expect(ids()).toEqual(["kept"]);
    await vi.waitFor(() => expect(listed(disk)).toMatchObject([{ noticeId: "kept" }]));
  });

  it("drops nothing while the list isn't read", async () => {
    const disk = keptDisk();
    disk.sql(
      "INSERT INTO notice_lists (origin, account_id, rows) VALUES (?, ?, ?)",
      ORIGIN,
      "u1",
      JSON.stringify([relayRow("a"), relayRow("b", { workspaceId: "w2" })]),
    );
    const { server, store, ids, list } = setup({ disk });
    list.replace({ status: "loading" });
    store.resume();
    const early = await server.read();
    expect(ids()).toEqual(["a", "b"]);
    list.replace({ status: "failed", problem: "offline" });
    expect(ids()).toEqual(["a", "b"]);
    expect(listed(disk)).toHaveLength(2);
    list.set([trip]);
    expect(ids()).toEqual(["a"]);
    await vi.waitFor(() => expect(listed(disk)).toMatchObject([{ noticeId: "a" }]));
    // The read begun before the list was read is older than it, so it starts again, and its late answer lands nothing.
    const fresh = server.read();
    early.answer(
      200,
      noticePageBody([relayRow("a"), relayRow("b", { workspaceId: "w2" })], { replace: true }),
    );
    expect((await fresh).path).toBe("/sync/notices?scope=phone&limit=100");
    expect(ids()).toEqual(["a"]);
    expect(listed(disk)).toMatchObject([{ noticeId: "a" }]);
  });
});

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
  it("lands nothing a read held before a 401 answers, deletes the list, and sends the marks after the next sign-in", async () => {
    const { server, store, ids, disk, kept, signIn, signOut } = setup();
    const account = fakeAccount({ status: "signed-in", signIn: { ...signIn, email: "a@b.c" } });
    clearNoticeListsOnSignInChange(account, kept);
    store.resume();
    const held = await reply(server, server.read(), [relayRow("a")], { replace: true });
    store.mark("a", "read");
    await server.marks();
    await vi.waitFor(() => expect(listed(disk)).toHaveLength(1));
    const checked = signOut();
    account.set({ ...signedOut, ended: true });
    held.answer(200, noticePageBody([relayRow("b", { changeSeq: 2 })]));
    await checked;
    store.mark("a", "unread");
    expect(ids()).toEqual(["a"]);
    await vi.waitFor(() => expect(listed(disk)).toBeUndefined());
    expect(marked(disk)).toEqual([{ noticeId: "a", mark: "read", atMs: NOW }]);

    const second = setup({ disk });
    second.store.resume();
    expect((await second.server.marks()).body).toEqual({
      marks: [{ noticeId: "a", mark: "read" }],
    });
  });

  it("deletes the list on sign-out, a new sign-in, or a launch with none, never on the saved one", async () => {
    const signIn = (userId: string) => ({ ...setup().signIn, userId, email: `${userId}@b.c` });
    const run = async (from: AccountState, to: AccountState) => {
      const disk = keptDisk();
      disk.sql(
        "INSERT INTO notice_lists (origin, account_id, rows) VALUES (?, 'u1', '[]')",
        ORIGIN,
      );
      const kept = disk.launch();
      const account = fakeAccount(from);
      clearNoticeListsOnSignInChange(account, kept);
      account.set(to);
      // After the delete, if one was asked.
      await kept.transaction(async () => undefined);
      return listed(disk) === undefined;
    };
    const first: AccountState = { status: "signed-in", signIn: signIn("u1") };
    expect(await run({ status: "loading" }, first)).toBe(false);
    expect(await run({ status: "loading" }, signedOut)).toBe(true);
    expect(await run(first, signedOut)).toBe(true);
    expect(await run(first, { status: "signed-in", signIn: signIn("u2") })).toBe(true);
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
