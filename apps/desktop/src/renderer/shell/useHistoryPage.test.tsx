// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DohcDesktopBridge,
  EngineMomentRecord,
  ListHistoryPayload,
  ListHistoryResult,
  TimelineEntry,
} from "../../ipc/bridgeContract";
import type { HistoryCursor } from "@dohc/workspace-engine-client";
import { deferred, type Deferred } from "../../testing/deferred";
import { historyCursor, timelineCursor, timelinePage, type TimelinePage } from "../../testing/historyPageFixture";
import { readNewestMomentOrder, useHistoryPage } from "./useHistoryPage";

let previousBridge: DohcDesktopBridge | undefined;
const listHistory =
  vi.fn<(payload: ListHistoryPayload) => Promise<ListHistoryResult>>();
// Every read the hook issues, in issue order, with its settlement in the
// test's hands.
let reads: Deferred<ListHistoryResult>[] = [];

beforeEach(() => {
  reads = [];
  listHistory.mockImplementation(() => {
    const read = deferred<ListHistoryResult>();
    reads.push(read);
    return read.promise;
  });
  previousBridge = window.dohcDesktop;
  window.dohcDesktop = { listHistory } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.dohcDesktop = previousBridge;
  vi.resetAllMocks();
});

function moment(id: string): EngineMomentRecord {
  return {
    id,
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    momentOrder: 1,
    summary: id,
  };
}

const files = (...moments: EngineMomentRecord[]): TimelineEntry[] =>
  moments.map((entry) => ({ kind: "file", moment: entry }));

// A cursor into ws-1's timeline at a file position.
const cursorAt = (position: HistoryCursor | number) => timelineCursor(position, "ws-1");

function page(id: string, overrides: Partial<TimelinePage> = {}): TimelinePage {
  return timelinePage(files(moment(id)), { workspaceId: "ws-1", ...overrides });
}

const UPDATING: ListHistoryResult = { status: "updating" };

// The shell's shared counter and readiness marker, as the hook sees them.
// `take` issues a token the way the shell does for a refresh or a version
// callback; only the hook's own pagination and cleanup increment otherwise.
function mount(options: { strict?: boolean; receivedShare?: boolean } = {}) {
  const issue = { current: 0 };
  const markReady = vi.fn();
  const view = renderHook(
    ({ ready }: { ready: () => void }) => useHistoryPage(issue, "ws-1", ready, options.receivedShare),
    // The root option, not a wrapper: only a StrictMode root replays the
    // mount effects, which is what the lifetime test relies on.
    { initialProps: { ready: markReady }, reactStrictMode: options.strict === true },
  );
  const hook = () => view.result.current;
  return {
    issue,
    markReady,
    view,
    take: () => ++issue.current,
    hook,
    ids: () => hook().page?.entries.map((entry) => (entry.kind === "file" ? entry.moment.id : entry.kind)),
    refresh: () => {
      let pending!: Promise<void>;
      act(() => {
        pending = hook().refresh(++issue.current);
      });
      return pending;
    },
    loadMore: () => {
      let pending!: Promise<void>;
      act(() => {
        pending = hook().loadMore();
      });
      return pending;
    },
    observeVersion: (versionId: string) => {
      let dropped!: boolean;
      act(() => {
        dropped = hook().observeVersion(++issue.current, versionId);
      });
      return dropped;
    },
  };
}

const fileMoment = (entry: TimelineEntry | undefined) => (entry?.kind === "file" ? entry.moment : undefined);

async function settle(
  read: Deferred<ListHistoryResult>,
  answer: ListHistoryResult,
) {
  await act(async () => {
    read.resolve(answer);
    await read.promise;
  });
}

async function fail(read: Deferred<ListHistoryResult>, message: string) {
  await act(async () => {
    read.reject(new Error(message));
    await Promise.resolve();
  });
}

// A refresh that answers at once, for the page a scenario starts from.
async function committed(it0: ReturnType<typeof mount>, answer: ListHistoryResult) {
  const pending = it0.refresh();
  await settle(reads.at(-1)!, answer);
  await pending;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("history page ordering", () => {
  // Latest COMMITTED wins: an answer older than what is displayed is dropped,
  // and readiness belongs to the page that commits.
  it("ignores a page that resolves after a newer one committed", async () => {
    const it0 = mount();
    const older = it0.refresh();
    const newer = it0.refresh();
    await settle(reads[1]!, page("newer"));
    await newer;
    expect(it0.ids()).toEqual(["newer"]);
    expect(it0.markReady).toHaveBeenCalledTimes(1);

    await settle(reads[0]!, page("older"));
    await older;
    expect(it0.ids()).toEqual(["newer"]);
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  // A refresh someone asked again is superseded. Its answer commits neither
  // while the newer read is in flight nor after that read failed; the rows on
  // screen stay, and the failure is the newest refresh's to report.
  it("drops an older page while a newer refresh is in flight", async () => {
    const it0 = mount();
    await committed(it0, page("shown"));
    const older = it0.refresh();
    const newer = it0.refresh();
    await settle(reads[1]!, page("older"));
    await older;
    expect(it0.ids()).toEqual(["shown"]);

    await settle(reads[2]!, page("newer"));
    await newer;
    expect(it0.ids()).toEqual(["newer"]);
  });

  it("keeps the rows on screen when the newer refresh failed, and drops the older page", async () => {
    const it0 = mount();
    await committed(it0, page("shown"));
    const older = it0.refresh();
    const newer = it0.refresh();
    const newerFailed = expect(newer).rejects.toThrow("newer failed");
    await fail(reads[2]!, "newer failed");
    await newerFailed;
    expect(it0.hook().readState).toBe("failed");
    expect(it0.ids()).toEqual(["shown"]);

    await settle(reads[1]!, page("older"));
    await older;
    expect(it0.ids()).toEqual(["shown"]);
    expect(it0.hook().readState).toBe("failed");
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  it("keeps an older failure quiet while a newer refresh is in flight", async () => {
    const it0 = mount();
    const older = it0.refresh();
    const newer = it0.refresh();
    await fail(reads[0]!, "older failed");
    await older;
    expect(it0.hook().readState).toBe("loading");

    await settle(reads[1]!, page("newer"));
    await newer;
    expect(it0.ids()).toEqual(["newer"]);
  });

  it("shows a read on the way again when a failed read is retried", async () => {
    const it0 = mount();
    const first = it0.refresh();
    const firstFailed = expect(first).rejects.toThrow("first failed");
    await fail(reads[0]!, "first failed");
    await firstFailed;
    expect(it0.hook().readState).toBe("failed");

    const retry = it0.refresh();
    expect(it0.hook().readState).toBe("loading");
    await settle(reads[1]!, page("retried"));
    await retry;
    expect(it0.ids()).toEqual(["retried"]);
  });

  // Main also refuses replies for a retired workspace. A page that names
  // another workspace answers nothing here, from a refresh or a pagination.
  it("drops a page that names another workspace", async () => {
    const it0 = mount();
    await committed(it0, page("other", { workspaceId: "ws-2" }));
    expect(it0.hook().page).toBeNull();
    expect(it0.markReady).not.toHaveBeenCalled();

    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const loadMore = it0.loadMore();
    await settle(reads[2]!, page("other-earlier", { workspaceId: "ws-2" }));
    await loadMore;
    expect(it0.ids()).toEqual(["first"]);
    expect(it0.hook().loadingMore).toBe(false);
  });
});

describe("history page entries and sources", () => {
  it("keeps every entry kind in the order main merged them", async () => {
    const it0 = mount();
    const collection: TimelineEntry = { kind: "collection", datasetId: "00000000-0000-4000-8000-000000000001", name: "Budget", sortAtMs: 90, change: {
      revision: 2, operation: "addRow", callerReference: null, recordedAtMs: 90, approvedRevisionHash: "a".repeat(64), changesetBytes: 1, attachmentCount: 0,
    } };
    const version: TimelineEntry = { kind: "version", version: { id: "draft", workspaceId: "ws-1", kind: "named", name: "Draft", createdAtMs: 95 } };
    await committed(it0, timelinePage([...files({ ...moment("m-2"), momentOrder: 7 }), version, collection, ...files(moment("m-1"))], { workspaceId: "ws-1" }));
    expect(it0.ids()).toEqual(["m-2", "version", "collection", "m-1"]);
  });

  // The cursor is main's. The hook hands back the very object it received.
  it("forwards the cursor unchanged and appends the earlier page", async () => {
    const it0 = mount();
    const cursor = cursorAt(1);
    await committed(it0, page("first", { nextCursor: cursor }));
    expect(listHistory).toHaveBeenLastCalledWith({ workspaceId: "ws-1", limit: 50 });
    const loadMore = it0.loadMore();
    expect(it0.hook().loadingMore).toBe(true);
    expect(listHistory.mock.calls[1]![0]).toEqual({ workspaceId: "ws-1", limit: 50, cursor });
    expect(listHistory.mock.calls[1]![0].cursor).toBe(cursor);
    await settle(reads[1]!, page("earlier", { nextCursor: null }));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);
    expect(it0.hook().page?.nextCursor).toBeNull();
    expect(it0.hook().loadingMore).toBe(false);
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  // Each page describes the whole source chain, so a later page's missing
  // and omitted Collections stand, and a refresh starts a new chain.
  it("discloses missing and omitted Collections from the newest page of the chain", async () => {
    const it0 = mount();
    const budget = { datasetId: "00000000-0000-4000-8000-000000000001", reason: "deadline" as const };
    const guests = { datasetId: "00000000-0000-4000-8000-000000000002", reason: "unavailable" as const };
    await committed(it0, page("first", { nextCursor: cursorAt(1), unavailableSources: [budget], omittedSources: 3, completeness: "partial" }));
    expect(it0.hook().page).toMatchObject({ unavailableSources: [budget], omittedSources: 3 });
    const loadMore = it0.loadMore();
    await settle(reads[1]!, page("earlier", { unavailableSources: [budget, guests], omittedSources: 3, completeness: "partial" }));
    await loadMore;
    expect(it0.hook().page).toMatchObject({ unavailableSources: [budget, guests], omittedSources: 3 });
    await committed(it0, page("refreshed"));
    expect(it0.hook().page).toMatchObject({ unavailableSources: [], omittedSources: 0 });
  });

  it("keeps the single-Collection deadline page, which has no rows and no cursor", async () => {
    const it0 = mount();
    const budget = { datasetId: "00000000-0000-4000-8000-000000000001", reason: "deadline" as const };
    await committed(it0, timelinePage([], { workspaceId: "ws-1", unavailableSources: [budget], completeness: "partial" }));
    expect(it0.hook().page).toEqual({ entries: [], nextCursor: null, unavailableSources: [budget], omittedSources: 0 });
  });

  // A received share has only its imported file History.
  it("keeps only file History for a received share", async () => {
    const it0 = mount({ receivedShare: true });
    const version: TimelineEntry = { kind: "version", version: { id: "draft", workspaceId: "ws-1", kind: "named", name: "Draft", createdAtMs: 95 } };
    const collection: TimelineEntry = { kind: "collection", datasetId: "00000000-0000-4000-8000-000000000001", name: "Budget", sortAtMs: 90, change: {
      revision: 2, operation: "addRow", callerReference: null, recordedAtMs: 90, approvedRevisionHash: "a".repeat(64), changesetBytes: 1, attachmentCount: 0,
    } };
    await committed(it0, timelinePage([...files(moment("shared")), version, collection], {
      workspaceId: "ws-1", unavailableSources: [{ datasetId: collection.datasetId, reason: "deadline" }], omittedSources: 2, completeness: "partial",
    }));
    expect(it0.ids()).toEqual(["shared"]);
    expect(it0.hook().page).toMatchObject({ unavailableSources: [], omittedSources: 0 });
  });
});

describe("history page pagination", () => {
  it("issues one read for a double click and none without a cursor", async () => {
    const it0 = mount();
    await committed(it0, page("first"));
    await it0.loadMore();
    expect(listHistory).toHaveBeenCalledTimes(1);

    await committed(it0, page("again", { nextCursor: cursorAt(1) }));
    // Both clicks land before React renders the first one's loading state,
    // so the suppression has to be synchronous.
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = it0.hook().loadMore();
      second = it0.hook().loadMore();
    });
    expect(listHistory).toHaveBeenCalledTimes(3);
    await settle(reads[2]!, page("earlier"));
    await Promise.all([first, second]);
    expect(it0.ids()).toEqual(["again", "earlier"]);
  });

  // The pagination's cursor points into the displayed timeline, so an older
  // refresh must not reset the timeline under it. Held, not dropped: the
  // pagination may still fail.
  it("holds an older refresh behind a pagination and drops it once the page lands", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const refresh = it0.refresh();
    const loadMore = it0.loadMore();
    await settle(reads[1]!, page("refreshed"));
    await refresh;
    expect(it0.ids()).toEqual(["first"]);

    await settle(reads[2]!, page("earlier"));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  it("drops an older refresh that answers after the pagination it raced", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const refresh = it0.refresh();
    const loadMore = it0.loadMore();
    await settle(reads[2]!, page("earlier"));
    await loadMore;
    await settle(reads[1]!, page("refreshed"));
    await refresh;
    expect(it0.ids()).toEqual(["first", "earlier"]);
  });

  // Settlement, not success, releases what the pagination held. Its failure
  // is about the displayed timeline, so it is the caller's to report; the
  // held answer commits first.
  it("commits a held refresh when the pagination fails, and rejects that failure", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const refresh = it0.refresh();
    const loadMore = it0.loadMore();
    const loadMoreFailed = expect(loadMore).rejects.toThrow("pagination failed");
    await settle(reads[1]!, page("refreshed"));
    await refresh;
    expect(it0.ids()).toEqual(["first"]);

    await fail(reads[2]!, "pagination failed");
    await loadMoreFailed;
    expect(it0.ids()).toEqual(["refreshed"]);
    expect(it0.hook().loadingMore).toBe(false);
    expect(it0.markReady).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest held refresh", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const olderRefresh = it0.refresh();
    const newerRefresh = it0.refresh();
    const loadMore = it0.loadMore();
    const loadMoreFailed = expect(loadMore).rejects.toThrow("pagination failed");
    await settle(reads[2]!, page("newer"));
    await newerRefresh;
    await settle(reads[1]!, page("older"));
    await olderRefresh;
    expect(it0.ids()).toEqual(["first"]);

    await fail(reads[3]!, "pagination failed");
    await loadMoreFailed;
    expect(it0.ids()).toEqual(["newer"]);
  });

  it("commits a refresh that raced a pagination which then failed", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const refresh = it0.refresh();
    const loadMore = it0.loadMore();
    const loadMoreFailed = expect(loadMore).rejects.toThrow("pagination failed");
    await fail(reads[2]!, "pagination failed");
    await loadMoreFailed;
    expect(it0.hook().loadingMore).toBe(false);

    await settle(reads[1]!, page("refreshed"));
    await refresh;
    expect(it0.ids()).toEqual(["refreshed"]);
  });

  // A newer refresh that merely failed must not throw the asked-for page
  // away, nor leave the button disabled.
  it("commits a pagination whose newer refresh failed, and frees the button", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const loadMore = it0.loadMore();
    const refresh = it0.refresh();
    const refreshFailed = expect(refresh).rejects.toThrow("history failed");
    await fail(reads[2]!, "history failed");
    await refreshFailed;

    await settle(reads[1]!, page("earlier", { nextCursor: cursorAt(0) }));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);
    expect(it0.hook().loadingMore).toBe(false);
    expect(it0.hook().page?.nextCursor).toEqual(cursorAt(0));
  });

  // A refresh issued after the pagination replaces the page and frees the
  // button, but the pagination keeps its pending slot. A second pagination
  // then takes the slot; the first, superseded, settles without releasing
  // what the second now owns.
  it("lets a newer refresh replace the page while only the owning pagination releases the slot", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const firstLoadMore = it0.loadMore();
    await committed(it0, page("replaced", { nextCursor: cursorAt(2) }));
    expect(it0.ids()).toEqual(["replaced"]);
    expect(it0.hook().loadingMore).toBe(false);

    const secondLoadMore = it0.loadMore();
    expect(it0.hook().loadingMore).toBe(true);
    expect(listHistory).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      limit: 50,
      cursor: cursorAt(2),
    });

    await settle(reads[1]!, page("stale-earlier"));
    await firstLoadMore;
    expect(it0.ids()).toEqual(["replaced"]);
    expect(it0.hook().loadingMore).toBe(true);

    await settle(reads[3]!, page("earlier"));
    await secondLoadMore;
    expect(it0.ids()).toEqual(["replaced", "earlier"]);
    expect(it0.hook().loadingMore).toBe(false);
  });

  it("keeps a superseded pagination's failure quiet", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const loadMore = it0.loadMore();
    await committed(it0, page("replaced"));
    await fail(reads[1]!, "pagination failed");
    await loadMore;
    expect(it0.ids()).toEqual(["replaced"]);
  });
});

describe("history page versions", () => {
  // An answer describing the version the user left is about somewhere else.
  // The page it contradicts is retracted, the read state is left alone, and
  // the retraction reports itself so the caller can ask again.
  it("retracts a page the newest version statement contradicts and rejects the old version's answers", async () => {
    const it0 = mount();
    await committed(it0, page("try", { versionId: "try-1" }));
    const stale = it0.refresh();
    expect(it0.observeVersion("main")).toBe(true);
    expect(it0.hook().page).toBeNull();
    expect(it0.hook().readState).toBe("loading");
    expect(it0.observeVersion("main")).toBe(false);

    await settle(reads[1]!, page("stale", { versionId: "try-1" }));
    await stale;
    expect(it0.hook().page).toBeNull();
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  it("keeps a page the version statement agrees with", async () => {
    const it0 = mount();
    await committed(it0, page("main"));
    expect(it0.observeVersion("main")).toBe(false);
    expect(it0.ids()).toEqual(["main"]);
  });

  // Main notifies the renderer before the switch invoke resolves, so a valid
  // new-version refresh can be issued before the statement arrives. Same
  // version, earlier token: not stale.
  it("keeps a same-version answer issued before the version statement", async () => {
    const it0 = mount();
    await committed(it0, page("try", { versionId: "try-1" }));
    const early = it0.refresh();
    it0.observeVersion("main");
    expect(it0.hook().page).toBeNull();

    await settle(reads[1]!, page("back-on-main"));
    await early;
    expect(it0.ids()).toEqual(["back-on-main"]);
  });

  it("rejects the version the user left before any page committed", async () => {
    const it0 = mount();
    const stranded = it0.refresh();
    expect(it0.observeVersion("main")).toBe(false);
    await settle(reads[0]!, page("stranded", { versionId: "try-1" }));
    await stranded;
    expect(it0.hook().page).toBeNull();
    expect(it0.markReady).not.toHaveBeenCalled();
  });

  // A failure is an answer for the version rule: it answers about somewhere
  // the user has left, so it is nobody's to report.
  it("says nothing about a pagination that failed for the version the user left", async () => {
    const it0 = mount();
    await committed(it0, page("try", { nextCursor: cursorAt(1), versionId: "try-1" }));
    const loadMore = it0.loadMore();
    it0.observeVersion("main");
    await fail(reads[1]!, "pagination failed");
    await loadMore;
    expect(it0.hook().loadingMore).toBe(false);
  });

  it("drops a pagination page from a version the timeline no longer shows", async () => {
    const it0 = mount();
    await committed(it0, page("try", { nextCursor: cursorAt(1), versionId: "try-1" }));
    const loadMore = it0.loadMore();
    await committed(it0, page("main-first", { nextCursor: cursorAt(3) }));
    await settle(reads[1]!, page("try-earlier", { versionId: "try-1" }));
    await loadMore;
    expect(it0.ids()).toEqual(["main-first"]);
  });

  // A merge or a conflict resolution names the version the page already
  // describes, so a held refresh survives it.
  it("keeps a held refresh across a version statement that changed nothing", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const refresh = it0.refresh();
    const loadMore = it0.loadMore();
    const loadMoreFailed = expect(loadMore).rejects.toThrow("pagination failed");
    await settle(reads[1]!, page("refreshed"));
    await refresh;
    expect(it0.observeVersion("main")).toBe(false);
    await fail(reads[2]!, "pagination failed");
    await loadMoreFailed;
    expect(it0.ids()).toEqual(["refreshed"]);
  });
});

describe("history page updating retries", () => {
  it("retries an updating answer along the ladder and then leaves the inline retry", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const refresh = it0.refresh();
    for (const [attempt, delay] of [100, 250, 500, 1_000].entries()) {
      await settle(reads[attempt]!, UPDATING);
      expect(it0.hook().readState).toBe("loading");
      await advance(delay - 1);
      expect(listHistory).toHaveBeenCalledTimes(attempt + 1);
      await advance(1);
      expect(listHistory).toHaveBeenCalledTimes(attempt + 2);
      expect(listHistory).toHaveBeenLastCalledWith({ workspaceId: "ws-1", limit: 50 });
    }
    await settle(reads[4]!, UPDATING);
    await refresh;
    expect(it0.hook().readState).toBe("updating");
    expect(it0.hook().page).toBeNull();
    await advance(5_000);
    expect(listHistory).toHaveBeenCalledTimes(5);
  });

  it("commits the page an updating answer is followed by", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const refresh = it0.refresh();
    await settle(reads[0]!, UPDATING);
    await advance(100);
    await settle(reads[1]!, page("ready"));
    await refresh;
    expect(it0.ids()).toEqual(["ready"]);
    expect(it0.hook().readState).toBe("loading");
  });

  // A page asked for from a cursor retries from the same cursor, in the same
  // workspace, while it is still the pagination that owns the button.
  it("retries an updating pagination from the same cursor, and stops once a refresh replaced the page", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const cursor = cursorAt(1);
    await committed(it0, page("first", { nextCursor: cursor }));
    const loadMore = it0.loadMore();
    await settle(reads[1]!, UPDATING);
    expect(it0.hook().loadingMore).toBe(true);
    await advance(100);
    expect(listHistory).toHaveBeenCalledTimes(3);
    expect(listHistory.mock.calls[2]![0]).toEqual({ workspaceId: "ws-1", limit: 50, cursor });
    expect(listHistory.mock.calls[2]![0].cursor).toBe(cursor);
    await settle(reads[2]!, page("earlier"));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);

    await committed(it0, page("again", { nextCursor: cursorAt(2) }));
    const stale = it0.loadMore();
    await settle(reads[4]!, UPDATING);
    await committed(it0, page("replaced"));
    await advance(2_000);
    await stale;
    expect(listHistory).toHaveBeenCalledTimes(6);
    expect(it0.ids()).toEqual(["replaced"]);
  });

  it("stops the ladder before the timer once a newer refresh is issued", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const older = it0.refresh();
    const newer = it0.refresh();
    await settle(reads[0]!, UPDATING);
    await older;
    expect(it0.hook().readState).toBe("loading");
    await advance(2_000);
    expect(listHistory).toHaveBeenCalledTimes(2);
    await settle(reads[1]!, page("newer"));
    await newer;
    expect(it0.ids()).toEqual(["newer"]);
  });

  it("stops the ladder after the timer once a newer refresh is issued", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const older = it0.refresh();
    await settle(reads[0]!, UPDATING);
    const newer = it0.refresh();
    await advance(100);
    await older;
    expect(listHistory).toHaveBeenCalledTimes(2);
    expect(it0.hook().readState).toBe("loading");
    await settle(reads[1]!, page("newer"));
    await newer;
    expect(it0.ids()).toEqual(["newer"]);
  });

  // A refresh that reads no page still supersedes the page reads before it:
  // their failure stays quiet and their ladder stops.
  it("lets a refresh with no page supersede an older page read", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const failing = it0.refresh();
    const updating = it0.refresh();
    act(() => {
      it0.hook().supersede(it0.take());
    });
    await fail(reads[0]!, "older failed");
    await failing;
    expect(it0.hook().readState).toBe("loading");

    await settle(reads[1]!, UPDATING);
    await updating;
    expect(it0.hook().readState).toBe("loading");
    await advance(2_000);
    expect(listHistory).toHaveBeenCalledTimes(2);
  });
});

// The read that tells the shell an open file may have changed. It retries
// `updating` on the page's ladder while its refresh is current, and says so
// when the ladder ends still updating.
describe("newest moment order", () => {
  const ready = (latestMomentOrder: number) => ({ moments: [], nextCursor: null, latestMomentOrder, activeVersionId: "main",
    startCursor: historyCursor(), versionMarkers: [] });
  function stubMoments(...answers: unknown[]) {
    const listEngineMoments = vi.fn(async () => answers.shift());
    window.dohcDesktop = { listEngineMoments } as unknown as DohcDesktopBridge;
    return listEngineMoments;
  }

  it("retries an updating answer in the same workspace and returns the order", async () => {
    vi.useFakeTimers();
    const listEngineMoments = stubMoments(UPDATING, UPDATING, ready(7));
    const read = readNewestMomentOrder("ws-1", () => true, () => false);
    await advance(100 + 250);
    await expect(read).resolves.toBe(7);
    expect(listEngineMoments).toHaveBeenCalledTimes(3);
    expect(listEngineMoments).toHaveBeenLastCalledWith({ workspaceId: "ws-1", limit: 1 });
  });

  it("stops retrying once its refresh is no longer current", async () => {
    vi.useFakeTimers();
    let current = true;
    const listEngineMoments = stubMoments(UPDATING, ready(7));
    const read = readNewestMomentOrder("ws-1", () => current, () => true);
    await act(async () => { await Promise.resolve(); });
    current = false;
    await advance(2_000);
    await expect(read).resolves.toBeNull();
    expect(listEngineMoments).toHaveBeenCalledTimes(1);
  });

  it("answers nothing, without failing, when the ladder ends still updating while capture works", async () => {
    vi.useFakeTimers();
    const listEngineMoments = stubMoments(UPDATING, UPDATING, UPDATING, UPDATING, UPDATING);
    const read = readNewestMomentOrder("ws-1", () => true, () => false);
    await advance(2_000);
    await expect(read).resolves.toBeNull();
    expect(listEngineMoments).toHaveBeenCalledTimes(5);
  });

  it("rejects in words when the ladder ends still updating after capture failed", async () => {
    vi.useFakeTimers();
    const listEngineMoments = stubMoments(UPDATING, UPDATING, UPDATING, UPDATING, UPDATING);
    const read = readNewestMomentOrder("ws-1", () => true, () => true);
    const rejected = expect(read).rejects.toThrow("Recent changes are still being added to History.");
    await advance(2_000);
    await rejected;
    expect(listEngineMoments).toHaveBeenCalledTimes(5);
  });

  it("answers nothing while History's rules are unreadable", async () => {
    stubMoments({ status: "policy-unreadable", unreadable: [".dohc/files.toml"], policyErrors: ["files.toml"] });
    await expect(readNewestMomentOrder("ws-1", () => true, () => true)).resolves.toBeNull();
  });
});

describe("history page readiness and lifetime", () => {
  // The marker changes identity with the selection generation. A refresh
  // marks the generation it was issued under, even when it commits late.
  it("marks readiness with the marker captured when the refresh was issued", async () => {
    const it0 = mount();
    const first = it0.refresh();
    const later = vi.fn();
    it0.view.rerender({ ready: later });
    await settle(reads[0]!, page("first"));
    await first;
    expect(it0.markReady).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();

    await committed(it0, page("second"));
    expect(it0.markReady).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("marks a held refresh with its own marker when the pagination releases it", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    const refresh = it0.refresh();
    const loadMore = it0.loadMore();
    const loadMoreFailed = expect(loadMore).rejects.toThrow("pagination failed");
    const later = vi.fn();
    it0.view.rerender({ ready: later });
    await settle(reads[1]!, page("refreshed"));
    await refresh;
    await fail(reads[2]!, "pagination failed");
    await loadMoreFailed;
    expect(it0.ids()).toEqual(["refreshed"]);
    expect(it0.markReady).toHaveBeenCalledTimes(2);
    expect(later).not.toHaveBeenCalled();
  });

  // Unmount moves the counter past every issued token. A late answer commits
  // nothing, a late statement retracts nothing, and the held refresh is gone
  // before the pagination that held it settles.
  it("invalidates every read in flight on unmount and retracts nothing after", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextCursor: cursorAt(1), versionId: "try-1" }));
    const held = it0.refresh();
    const loadMore = it0.loadMore();
    await settle(reads[1]!, page("held", { versionId: "try-1" }));
    await held;
    const late = it0.refresh();
    const lookupToken = it0.take();

    it0.view.unmount();
    expect(it0.issue.current).toBe(lookupToken + 1);
    expect(it0.hook().observeVersion(lookupToken, "main")).toBe(false);

    await fail(reads[2]!, "pagination failed");
    await loadMore;
    await settle(reads[3]!, page("late"));
    await late;
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  it("keeps working after StrictMode replays its effects", async () => {
    const it0 = mount({ strict: true });
    expect(it0.issue.current).toBe(1);
    await committed(it0, page("first", { nextCursor: cursorAt(1) }));
    expect(it0.ids()).toEqual(["first"]);
    expect(it0.markReady).toHaveBeenCalledTimes(1);

    const loadMore = it0.loadMore();
    await settle(reads[1]!, page("earlier"));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);
    expect(it0.hook().loadingMore).toBe(false);
  });
});


describe("History policy read failure", () => {
  beforeEach(() => vi.useFakeTimers());
  const blocked = { status: "policy-unreadable" as const, unreadable: [".dohc/files.toml" as const], policyErrors: ["files.toml could not be read and was ignored."] };
  it("hides the previous page without retrying, keeps the typed cause, and recovers", async () => {
    const it0 = mount();
    await committed(it0, page("old"));
    const pending = it0.refresh();
    await settle(reads.at(-1)!, blocked);
    expect(it0.hook().page).toBeNull();
    expect(it0.hook().readState).toBe("failed");
    expect(it0.hook().policyError).toEqual(blocked);
    expect(reads).toHaveLength(2);
    await pending;
    await committed(it0, page("fixed"));
    expect(it0.hook().policyError).toBeNull();
    expect(it0.ids()).toEqual(["fixed"]);
  });

  it("retracts the whole page when pagination discovers a broken policy", async () => {
    const it0 = mount();
    await committed(it0, page("old", { nextCursor: cursorAt(10) }));
    const pending = it0.loadMore();
    await settle(reads.at(-1)!, blocked);
    await pending;
    expect(it0.hook().page).toBeNull();
    expect(it0.hook().policyError).toEqual(blocked);
    expect(it0.hook().loadingMore).toBe(false);
    await pending;
  });

  it("does not let an older success repaint policy-hidden history", async () => {
    const it0 = mount();
    const older = it0.refresh();
    const newer = it0.refresh();
    await settle(reads[1]!, blocked);
    expect(it0.hook().policyError).toEqual(blocked);
    await newer;
    await settle(reads[0]!, page("stale"));
    await older;
    expect(it0.hook().page).toBeNull();
    expect(it0.hook().policyError).toEqual(blocked);
  });

  it("ignores a stale policy failure after a newer success or unmount", async () => {
    const it0 = mount();
    const older = it0.refresh();
    await committed(it0, page("new"));
    await settle(reads[0]!, blocked);
    await older;
    expect(it0.ids()).toEqual(["new"]);
    expect(it0.hook().policyError).toBeNull();
    const gone = it0.refresh();
    it0.view.unmount();
    await settle(reads.at(-1)!, blocked);
    await gone;
  });
});


it("keeps a newer committed pagination when an older refresh reports unreadable policy", async () => {
  vi.useFakeTimers();
  const it0 = mount();
  await committed(it0, page("newest", { nextCursor: cursorAt(10) }));
  const refresh = it0.refresh();
  const olderPage = it0.loadMore();
  await settle(reads[2]!, page("older"));
  await olderPage;
  await settle(reads[1]!, { status: "policy-unreadable", unreadable: [".dohc/files.toml"], policyErrors: ["files.toml"] });
  expect(it0.ids()).toEqual(["newest", "older"]);
  expect(it0.hook().policyError).toBeNull();
  await refresh;
});

it("never appends an old pagination after a policy refusal hides the page", async () => {
  vi.useFakeTimers();
  const it0 = mount();
  await committed(it0, page("newest", { nextCursor: cursorAt(10) }));
  const olderPage = it0.loadMore();
  const refresh = it0.refresh();
  await settle(reads[2]!, { status: "policy-unreadable", unreadable: [".dohc/files.toml"], policyErrors: ["files.toml"] });
  expect(it0.hook().page).toBeNull();
  await refresh;
  await settle(reads[1]!, page("older"));
  await olderPage;
  expect(it0.hook().page).toBeNull();
  expect(it0.hook().policyError).toMatchObject({ status: "policy-unreadable" });
});

const SHARED = { userId: "ben", label: "ben@test.example (via share link)" };

it("re-reads cached names and ignores a late naming answer after a workspace switch", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const issue = { current: 0 };
  const ready = () => {};
  const view = renderHook(({ workspaceId }) => useHistoryPage(issue, workspaceId, ready), { initialProps: { workspaceId: "ws-1" } });
  let first!: Promise<void>;
  act(() => { first = view.result.current.refresh(++issue.current); });
  await settle(reads[0]!, page("old")); await first;
  act(() => notify({ workspaceId: "ws-1" }));
  expect(reads).toHaveLength(2);
  expect(listHistory.mock.calls[1]![0]).toEqual({ workspaceId: "ws-1", limit: 50 });
  await settle(reads[1]!, timelinePage(files({ ...moment("old"), namedAuthor: SHARED }), { workspaceId: "ws-1" }));
  expect(fileMoment(view.result.current.page?.entries[0])?.namedAuthor?.label).toContain("via share link");
  act(() => notify({ workspaceId: "ws-1" }));
  const late = reads[2]!;
  view.rerender({ workspaceId: "ws-2" });
  let next!: Promise<void>;
  act(() => { next = view.result.current.refresh(++issue.current); });
  await settle(reads[3]!, page("new", { workspaceId: "ws-2" })); await next;
  await settle(late, page("late-old"));
  expect(view.result.current.page?.entries.map(entry => fileMoment(entry)?.id)).toEqual(["new"]);
});

it("re-reads each names revision once, without scanning again on refresh or load-more", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  const orderedPage = (id: string, order: number, next: number | null) =>
    timelinePage(files({ ...moment(id), recordedAtMs: order, momentOrder: order }), { workspaceId: "ws-1", nextCursor: next === null ? null : cursorAt(next) });
  await committed(it0, orderedPage("first", 3, 3));
  act(() => notify({ workspaceId: "ws-1" }));
  await settle(reads[1]!, orderedPage("first", 3, 3));
  expect(reads).toHaveLength(2);

  await committed(it0, orderedPage("refreshed", 3, 3));
  expect(reads).toHaveLength(3);
  const older = it0.loadMore();
  await settle(reads[3]!, orderedPage("older", 2, 2));
  await older;
  expect(reads).toHaveLength(4);
  const oldest = it0.loadMore();
  await settle(reads[4]!, orderedPage("oldest", 1, null));
  await oldest;
  expect(reads).toHaveLength(5);

  act(() => notify({ workspaceId: "ws-1" }));
  expect(reads).toHaveLength(6);
  await settle(reads[5]!, orderedPage("refreshed", 3, 3));
  await settle(reads[6]!, orderedPage("older", 2, 2));
  await settle(reads[7]!, orderedPage("oldest", 1, null));
  expect(listHistory.mock.calls.map(([payload]) => payload.cursor?.engine?.text?.momentOrder)).toEqual([undefined, undefined, undefined, 3, 2, undefined, 3, 2]);
  expect(reads).toHaveLength(8);
  expect(it0.ids()).toEqual(["refreshed", "older", "oldest"]);
});

it("defers a names event until pending load-more settles, then renames kept rows", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  const first = { ...moment("first"), momentOrder: 3, namedAuthor: { userId: "ben", label: "Someone you shared with" } };
  await committed(it0, timelinePage(files(first), { workspaceId: "ws-1", nextCursor: cursorAt(3) }));
  const older = it0.loadMore();
  act(() => notify({ workspaceId: "ws-1" }));
  expect.soft(reads).toHaveLength(2);
  expect(it0.hook().loadingMore).toBe(true);
  await settle(reads[1]!, timelinePage(files({ ...moment("older"), momentOrder: 2 }), { workspaceId: "ws-1" }));
  await older;
  expect(reads).toHaveLength(3);
  await settle(reads[2]!, timelinePage(files({ ...first, namedAuthor: SHARED }, { ...moment("older"), momentOrder: 2 }), { workspaceId: "ws-1" }));
  expect(fileMoment(it0.hook().page?.entries[0])?.namedAuthor?.label).toContain("ben@test.example");
  expect(reads).toHaveLength(3);
});

it("restarts an interrupted timeline scan after load-more commits", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  await committed(it0, page("first", { nextCursor: cursorAt(1) }));
  act(() => notify({ workspaceId: "ws-1" }));
  const interrupted = reads[1]!;
  const older = it0.loadMore();
  await settle(reads[2]!, page("older")); await older;
  await settle(interrupted, page("first"));
  expect(reads).toHaveLength(4);
  await settle(reads[3]!, timelinePage(files({ ...moment("first"), namedAuthor: SHARED }, moment("older")), { workspaceId: "ws-1" }));
  expect(fileMoment(it0.hook().page?.entries[0])?.namedAuthor?.label).toContain("ben@test.example");
  expect(reads).toHaveLength(4);
});

it("scans a new names event after A to B to A, even when B has no rows", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const issue = { current: 0 };
  const ready = () => {};
  const view = renderHook(({ workspaceId }) => useHistoryPage(issue, workspaceId, ready), { initialProps: { workspaceId: "A" } });
  const refresh = async (answer: ListHistoryResult) => {
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.refresh(++issue.current); });
    await settle(reads.at(-1)!, answer); await pending;
  };
  await refresh(page("A", { workspaceId: "A" }));
  act(() => notify({ workspaceId: "A" }));
  await settle(reads[1]!, page("A", { workspaceId: "A" }));
  view.rerender({ workspaceId: "B" });
  await refresh(timelinePage([], { workspaceId: "B" }));
  act(() => notify({ workspaceId: "B" }));
  expect(reads).toHaveLength(3);
  view.rerender({ workspaceId: "A" });
  await refresh(page("A", { workspaceId: "A" }));
  act(() => notify({ workspaceId: "A" }));
  expect(reads).toHaveLength(5);
  await settle(reads[4]!, timelinePage(files({ ...moment("A"), namedAuthor: SHARED }), { workspaceId: "A" }));
  expect(fileMoment(view.result.current.page?.entries[0])?.namedAuthor?.label).toContain("ben@test.example");
});

it.each(["failure", "updating"])("retries a %s naming scan once and consumes only its successful answer", async (outcome) => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  await committed(it0, page("first"));
  act(() => notify({ workspaceId: "ws-1" }));
  if (outcome === "failure") await fail(reads[1]!, "busy");
  else await settle(reads[1]!, UPDATING);
  expect(reads).toHaveLength(3);
  await settle(reads[2]!, timelinePage(files({ ...moment("first"), namedAuthor: SHARED }), { workspaceId: "ws-1" }));
  expect(fileMoment(it0.hook().page?.entries[0])?.namedAuthor?.label).toContain("ben@test.example");
  await committed(it0, page("refreshed"));
  expect(reads).toHaveLength(4);
});

const UNREADABLE_RULES = { status: "policy-unreadable" as const, unreadable: [".dohc/files.toml" as const], policyErrors: ["files.toml"] };

// The rules can turn unreadable under rows already shown. A names refresh
// that finds that hides History the way a refresh would, without a retry.
it("hides History when a names refresh finds the rules unreadable, and recovers on refresh", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  await committed(it0, page("first"));
  act(() => notify({ workspaceId: "ws-1" }));
  await settle(reads[1]!, UNREADABLE_RULES);
  expect(reads).toHaveLength(2);
  expect(it0.hook().page).toBeNull();
  expect(it0.hook().policyError).toEqual(UNREADABLE_RULES);
  expect(it0.hook().readState).toBe("failed");

  await committed(it0, page("fixed"));
  expect(it0.hook().policyError).toBeNull();
  expect(it0.ids()).toEqual(["fixed"]);
});

it("leaves a names refusal to a newer refresh that is already asking", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  await committed(it0, page("first"));
  act(() => notify({ workspaceId: "ws-1" }));
  const refresh = it0.refresh();
  await settle(reads[1]!, UNREADABLE_RULES);
  expect(it0.ids()).toEqual(["first"]);
  expect(it0.hook().policyError).toBeNull();
  await settle(reads[2]!, page("refreshed"));
  await refresh;
  expect(it0.ids()).toEqual(["refreshed"]);
});

it("renames file rows across a names page that holds only a version marker, and keeps the other rows", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  const start = { ...historyCursor(5), workspaceId: "ws-1", text: null };
  const afterMarker = cursorAt({ ...start, marker: { createdAtMs: 90, versionId: "draft" } });
  const marker: TimelineEntry = { kind: "version", version: { id: "draft", workspaceId: "ws-1", kind: "named", name: "Draft", createdAtMs: 90 } };
  const kept = { ...moment("kept"), recordedAtMs: 80 };
  await committed(it0, timelinePage([marker, ...files(kept)], { workspaceId: "ws-1" }));
  act(() => notify({ workspaceId: "ws-1" }));
  expect(listHistory.mock.calls[1]?.[0].cursor).toBeUndefined();
  await settle(reads[1]!, timelinePage([marker], { workspaceId: "ws-1", nextCursor: afterMarker }));
  expect(listHistory.mock.calls[2]?.[0].cursor).toBe(afterMarker);
  await settle(reads[2]!, timelinePage(files({ ...kept, namedAuthor: SHARED }), { workspaceId: "ws-1" }));
  expect(it0.ids()).toEqual(["version", "kept"]);
  expect(fileMoment(it0.hook().page?.entries[1])?.namedAuthor).toEqual(SHARED);
  expect(reads).toHaveLength(3);
});


it.each([
  ["text", "moment"], ["protected", "moment"],
  ["text", "marker"], ["protected", "marker"],
])("bounds a names rescan when a shown %s moment was deleted at a %s page cut", async (stream, cut) => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  const start = { ...historyCursor(), workspaceId: "ws-1", text: null };
  const kept = { ...moment("kept"), recordedAtMs: 100, momentOrder: 1 };
  // Old-dated sync moments can have a higher order than newer text moments.
  const missing = { ...moment("deleted"), recordedAtMs: 80, momentOrder: stream === "text" ? 500 : 5,
    ...(stream === "protected" ? { protected: true } : {}) };
  const originalEnd = cursorAt({ ...start, text: stream === "text"
    ? { recordedAtMs: 80, momentOrder: 500 } : { recordedAtMs: 100, momentOrder: 1 },
    protected: stream === "protected" ? { recordedAtMs: 80, momentOrder: 5 } : null });
  await committed(it0, timelinePage(files(kept, missing), { workspaceId: "ws-1", nextCursor: originalEnd }));

  const renamed = { ...kept, namedAuthor: SHARED };
  const newer = { ...moment("unshown-newer"), recordedAtMs: 90, momentOrder: 2 };
  const afterNewer = { ...start, text: { recordedAtMs: 90, momentOrder: 2 } };
  const afterMarker = { ...afterNewer, marker: { createdAtMs: 85, versionId: "draft" } };
  // Text at the same millisecond still precedes the protected boundary.
  const sameTimeText = { ...moment("unshown-same-time"), recordedAtMs: 80, momentOrder: stream === "text" ? 501 : 1 };
  const beforeBound = { ...afterMarker, text: { recordedAtMs: 80, momentOrder: sameTimeText.momentOrder } };
  const older = { ...moment("unshown-older"), recordedAtMs: 79, momentOrder: 1_000,
    ...(stream === "protected" ? { protected: true } : {}) };
  const pastBound = cut === "marker"
    ? { ...beforeBound, marker: { createdAtMs: 80, versionId: "older-draft" } }
    : { ...beforeBound, [stream]: { recordedAtMs: older.recordedAtMs, momentOrder: older.momentOrder } };
  const marker = (id: string, name: string, createdAtMs: number): TimelineEntry =>
    ({ kind: "version", version: { id, workspaceId: "ws-1", kind: "named", name, createdAtMs } });
  const scan = async () => {
    const offset = reads.length;
    act(() => notify({ workspaceId: "ws-1" }));
    expect(listHistory.mock.calls[offset]?.[0].cursor).toBeUndefined();
    await settle(reads[offset]!, timelinePage(files(renamed, newer), { workspaceId: "ws-1", nextCursor: cursorAt(afterNewer) }));
    expect(reads).toHaveLength(offset + 2);
    await settle(reads[offset + 1]!, timelinePage([marker("draft", "Draft", 85)], { workspaceId: "ws-1", nextCursor: cursorAt(afterMarker) }));
    expect(reads).toHaveLength(offset + 3);
    await settle(reads[offset + 2]!, timelinePage(files(sameTimeText), { workspaceId: "ws-1", nextCursor: cursorAt(beforeBound) }));
    expect(reads).toHaveLength(offset + 4);
    await settle(reads[offset + 3]!, timelinePage(cut === "moment" ? files(older) : [marker("older-draft", "Older draft", 80)],
      { workspaceId: "ws-1", nextCursor: cursorAt(pastBound) }));
    expect(reads).toHaveLength(offset + 4);
    await act(async () => { await Promise.resolve(); });
    expect(reads).toHaveLength(offset + 4);
  };
  await scan();
  expect(it0.ids()).toEqual(["kept", "deleted"]);
  expect(fileMoment(it0.hook().page?.entries[0])?.namedAuthor).toEqual(renamed.namedAuthor);
  expect(it0.hook().page?.nextCursor).toBe(originalEnd);
  await scan();
  expect(reads).toHaveLength(9);
});

it.each(["text", "protected"])("stops a names rescan exactly at the oldest shown %s moment", async (stream) => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  const start = { ...historyCursor(), workspaceId: "ws-1", text: null };
  const oldest = { ...moment("oldest"), recordedAtMs: 80, momentOrder: 500,
    ...(stream === "protected" ? { protected: true } : {}) };
  const newest = { ...moment("deleted-newest"), recordedAtMs: 100, momentOrder: 1 };
  const boundary = { recordedAtMs: oldest.recordedAtMs, momentOrder: oldest.momentOrder };
  const end = { ...start, [stream]: boundary };
  const originalEnd = stream === "protected" ? { ...end, text: { recordedAtMs: 100, momentOrder: 1 } } : end;
  await committed(it0, timelinePage(files(newest, oldest), { workspaceId: "ws-1", nextCursor: cursorAt(originalEnd) }));

  act(() => notify({ workspaceId: "ws-1" }));
  expect(listHistory.mock.calls[1]?.[0].cursor).toBeUndefined();
  // The oldest row still exists. A deleted newer row keeps the ID check from
  // ending the scan, so only the inclusive position bound stops another read.
  const renamed = { ...oldest, namedAuthor: SHARED };
  await settle(reads[1]!, timelinePage(files(renamed), { workspaceId: "ws-1", nextCursor: cursorAt(end) }));
  expect(reads).toHaveLength(2);
  expect(listHistory).toHaveBeenCalledTimes(2);
  expect(it0.ids()).toEqual(["deleted-newest", "oldest"]);
  expect(fileMoment(it0.hook().page?.entries[1])?.namedAuthor).toEqual(renamed.namedAuthor);
});

it("ends a names rescan when the file timeline ends, even with Collections left", async () => {
  let notify!: (event: { workspaceId: string }) => void;
  window.dohcDesktop!.onHistoryNamesChanged = listener => { notify = listener; return () => {}; };
  const it0 = mount();
  await committed(it0, page("deleted"));
  act(() => notify({ workspaceId: "ws-1" }));
  await settle(reads[1]!, timelinePage([], { workspaceId: "ws-1", nextCursor: { ...cursorAt(0), engineDone: true } }));
  expect(reads).toHaveLength(2);
});
