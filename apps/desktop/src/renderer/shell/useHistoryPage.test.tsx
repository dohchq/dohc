// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DohcDesktopBridge,
  EngineMomentRecord,
  ListEngineMomentsPayload,
  ListEngineMomentsResponse,
  ListEngineMomentsResult,
} from "../../ipc/bridgeContract";
import { deferred, type Deferred } from "../../testing/deferred";
import { useHistoryPage } from "./useHistoryPage";

let previousBridge: DohcDesktopBridge | undefined;
const listEngineMoments =
  vi.fn<(payload: ListEngineMomentsPayload) => Promise<ListEngineMomentsResponse>>();
// Every read the hook issues, in issue order, with its settlement in the
// test's hands.
let reads: Deferred<ListEngineMomentsResponse>[] = [];

beforeEach(() => {
  reads = [];
  listEngineMoments.mockImplementation(() => {
    const read = deferred<ListEngineMomentsResponse>();
    reads.push(read);
    return read.promise;
  });
  previousBridge = window.dohcDesktop;
  window.dohcDesktop = { listEngineMoments } as unknown as DohcDesktopBridge;
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

function page(
  id: string,
  overrides: Partial<Omit<ListEngineMomentsResult, "moments">> = {},
): ListEngineMomentsResult {
  return {
    moments: [moment(id)],
    nextBeforeMomentOrder: null,
    latestMomentOrder: 1,
    activeVersionId: "main",
    protectedTruncated: false,
    ...overrides,
  };
}

const UPDATING: ListEngineMomentsResponse = { status: "updating" };

// The shell's shared counter and readiness marker, as the hook sees them.
// `take` issues a token the way the shell does for a refresh or a version
// callback; only the hook's own pagination and cleanup increment otherwise.
function mount(options: { strict?: boolean } = {}) {
  const issue = { current: 0 };
  const markReady = vi.fn();
  const view = renderHook(
    ({ ready }: { ready: () => void }) => useHistoryPage(issue, "ws-1", ready),
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
    ids: () => hook().page?.moments.map((entry) => entry.id),
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

async function settle(
  read: Deferred<ListEngineMomentsResponse>,
  answer: ListEngineMomentsResponse,
) {
  await act(async () => {
    read.resolve(answer);
    await read.promise;
  });
}

async function fail(read: Deferred<ListEngineMomentsResponse>, message: string) {
  await act(async () => {
    read.reject(new Error(message));
    await Promise.resolve();
  });
}

// A refresh that answers at once, for the page a scenario starts from.
async function committed(it0: ReturnType<typeof mount>, answer: ListEngineMomentsResult) {
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

  // A failed newer refresh has answered nothing, so the older answer is the
  // only one there is. The failure is the newest refresh's to report, and the
  // commit does not reset the read state it left behind.
  it("commits an older page when the newer refresh failed", async () => {
    const it0 = mount();
    const older = it0.refresh();
    const newer = it0.refresh();
    const newerFailed = expect(newer).rejects.toThrow("newer failed");
    await fail(reads[1]!, "newer failed");
    await newerFailed;
    expect(it0.hook().readState).toBe("failed");
    expect(it0.hook().page).toBeNull();

    await settle(reads[0]!, page("older"));
    await older;
    expect(it0.ids()).toEqual(["older"]);
    expect(it0.hook().readState).toBe("failed");
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
});

describe("history page pagination", () => {
  it("appends the earlier page, keeps the highest order and any protected truncation", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextBeforeMomentOrder: 1, latestMomentOrder: 5 }));
    const loadMore = it0.loadMore();
    expect(it0.hook().loadingMore).toBe(true);
    expect(listEngineMoments).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      limit: 200,
      beforeMomentOrder: 1,
    });
    await settle(
      reads[1]!,
      page("earlier", { nextBeforeMomentOrder: 0, latestMomentOrder: 2, protectedTruncated: true }),
    );
    await loadMore;
    expect(it0.hook().page).toEqual({
      moments: [moment("first"), moment("earlier")],
      nextBeforeMomentOrder: 0,
      latestMomentOrder: 5,
      protectedTruncated: true,
    });
    expect(it0.hook().loadingMore).toBe(false);
    expect(it0.markReady).toHaveBeenCalledTimes(1);
  });

  it("issues one read for a double click and none without a cursor", async () => {
    const it0 = mount();
    await committed(it0, page("first"));
    await it0.loadMore();
    expect(listEngineMoments).toHaveBeenCalledTimes(1);

    await committed(it0, page("again", { nextBeforeMomentOrder: 1 }));
    const first = it0.loadMore();
    const second = it0.loadMore();
    expect(listEngineMoments).toHaveBeenCalledTimes(3);
    await settle(reads[2]!, page("earlier"));
    await Promise.all([first, second]);
    expect(it0.ids()).toEqual(["again", "earlier"]);
  });

  // The pagination's cursor points into the displayed timeline, so an older
  // refresh must not reset the timeline under it. Held, not dropped: the
  // pagination may still fail.
  it("holds an older refresh behind a pagination and drops it once the page lands", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
    const loadMore = it0.loadMore();
    const refresh = it0.refresh();
    const refreshFailed = expect(refresh).rejects.toThrow("history failed");
    await fail(reads[2]!, "history failed");
    await refreshFailed;

    await settle(reads[1]!, page("earlier", { nextBeforeMomentOrder: 0 }));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);
    expect(it0.hook().loadingMore).toBe(false);
    expect(it0.hook().page?.nextBeforeMomentOrder).toBe(0);
  });

  // A refresh issued after the pagination replaces the page and frees the
  // button, but the pagination keeps its pending slot. A second pagination
  // then takes the slot; the first, superseded, settles without releasing
  // what the second now owns.
  it("lets a newer refresh replace the page while only the owning pagination releases the slot", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
    const firstLoadMore = it0.loadMore();
    await committed(it0, page("replaced", { nextBeforeMomentOrder: 2 }));
    expect(it0.ids()).toEqual(["replaced"]);
    expect(it0.hook().loadingMore).toBe(false);

    const secondLoadMore = it0.loadMore();
    expect(it0.hook().loadingMore).toBe(true);
    expect(listEngineMoments).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      limit: 200,
      beforeMomentOrder: 2,
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("try", { activeVersionId: "try-1" }));
    const stale = it0.refresh();
    expect(it0.observeVersion("main")).toBe(true);
    expect(it0.hook().page).toBeNull();
    expect(it0.hook().readState).toBe("loading");
    expect(it0.observeVersion("main")).toBe(false);

    await settle(reads[1]!, page("stale", { activeVersionId: "try-1" }));
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
    await committed(it0, page("try", { activeVersionId: "try-1" }));
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
    await settle(reads[0]!, page("stranded", { activeVersionId: "try-1" }));
    await stranded;
    expect(it0.hook().page).toBeNull();
    expect(it0.markReady).not.toHaveBeenCalled();
  });

  // A failure is an answer for the version rule: it answers about somewhere
  // the user has left, so it is nobody's to report.
  it("says nothing about a pagination that failed for the version the user left", async () => {
    const it0 = mount();
    await committed(it0, page("try", { nextBeforeMomentOrder: 1, activeVersionId: "try-1" }));
    const loadMore = it0.loadMore();
    it0.observeVersion("main");
    await fail(reads[1]!, "pagination failed");
    await loadMore;
    expect(it0.hook().loadingMore).toBe(false);
  });

  it("drops a pagination page from a version the timeline no longer shows", async () => {
    const it0 = mount();
    await committed(it0, page("try", { nextBeforeMomentOrder: 1, activeVersionId: "try-1" }));
    const loadMore = it0.loadMore();
    await committed(it0, page("main-first", { nextBeforeMomentOrder: 3 }));
    await settle(reads[1]!, page("try-earlier", { activeVersionId: "try-1" }));
    await loadMore;
    expect(it0.ids()).toEqual(["main-first"]);
  });

  // A merge or a conflict resolution names the version the page already
  // describes, so a held refresh survives it.
  it("keeps a held refresh across a version statement that changed nothing", async () => {
    const it0 = mount();
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
      expect(listEngineMoments).toHaveBeenCalledTimes(attempt + 1);
      await advance(1);
      expect(listEngineMoments).toHaveBeenCalledTimes(attempt + 2);
    }
    await settle(reads[4]!, UPDATING);
    await refresh;
    expect(it0.hook().readState).toBe("updating");
    expect(it0.hook().page).toBeNull();
    await advance(5_000);
    expect(listEngineMoments).toHaveBeenCalledTimes(5);
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

  it("stops the ladder before the timer once a newer refresh is issued", async () => {
    vi.useFakeTimers();
    const it0 = mount();
    const older = it0.refresh();
    const newer = it0.refresh();
    await settle(reads[0]!, UPDATING);
    await older;
    expect(it0.hook().readState).toBe("loading");
    await advance(2_000);
    expect(listEngineMoments).toHaveBeenCalledTimes(2);
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
    expect(listEngineMoments).toHaveBeenCalledTimes(2);
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
    expect(listEngineMoments).toHaveBeenCalledTimes(2);
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1, activeVersionId: "try-1" }));
    const held = it0.refresh();
    const loadMore = it0.loadMore();
    await settle(reads[1]!, page("held", { activeVersionId: "try-1" }));
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
    await committed(it0, page("first", { nextBeforeMomentOrder: 1 }));
    expect(it0.ids()).toEqual(["first"]);
    expect(it0.markReady).toHaveBeenCalledTimes(1);

    const loadMore = it0.loadMore();
    await settle(reads[1]!, page("earlier"));
    await loadMore;
    expect(it0.ids()).toEqual(["first", "earlier"]);
    expect(it0.hook().loadingMore).toBe(false);
  });
});
