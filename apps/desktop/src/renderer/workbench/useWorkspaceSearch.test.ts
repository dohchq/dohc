// @vitest-environment jsdom
import { createElement, startTransition, Suspense } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceSearchPayload,
  WorkspaceSearchStartResult,
} from "../../ipc/bridgeContract";
import type { SearchResultsEvent } from "../../ipc/channels";
import {
  useWorkspaceSearch,
  type SearchRunOptions,
  type WorkspaceSearchApi,
} from "./useWorkspaceSearch";

let searchResultsListener: ((event: SearchResultsEvent) => void) | null = null;
const bridgeMock = {
  searchWorkspace: vi.fn<
    (payload: WorkspaceSearchPayload) => Promise<WorkspaceSearchStartResult>
  >(),
  cancelWorkspaceSearch: vi.fn(async () => undefined),
  onSearchResults: vi.fn((listener: (event: SearchResultsEvent) => void) => {
    searchResultsListener = listener;
    return () => {
      searchResultsListener = null;
    };
  }),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const options: SearchRunOptions = {
  query: "needle",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};
const reportSearchError = vi.fn<
  (error: unknown, retry: () => void) => void
>();
const clearSearchError = vi.fn<() => void>();

beforeEach(() => {
  vi.clearAllMocks();
  searchResultsListener = null;
  bridgeMock.searchWorkspace.mockReset();
  bridgeMock.searchWorkspace.mockResolvedValue({ status: "accepted" });
  bridgeMock.cancelWorkspaceSearch.mockResolvedValue(undefined);
  bridgeMock.onSearchResults.mockImplementation((listener) => {
    searchResultsListener = listener;
    return () => {
      searchResultsListener = null;
    };
  });
});

afterEach(() => cleanup());

describe("useWorkspaceSearch", () => {
  it("keeps an updating workspace search pending and retries it", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.searchWorkspace
        .mockResolvedValueOnce({
          status: "refused",
          code: "workspace-updating",
        })
        .mockResolvedValueOnce({ status: "accepted" });
      const view = renderHook(() =>
        useWorkspaceSearch("workspace-1", reportSearchError, clearSearchError),
      );

      await act(async () => {
        view.result.current.run(options);
        await Promise.resolve();
      });

      const firstPayload = bridgeMock.searchWorkspace.mock.calls[0]?.[0];
      expect(view.result.current.model).toMatchObject({
        searchId: firstPayload.searchId,
        status: "updating",
        totalMatches: 0,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(bridgeMock.searchWorkspace).toHaveBeenCalledTimes(2);
      expect(bridgeMock.searchWorkspace.mock.calls[1]?.[0]).toEqual(firstPayload);
      expect(view.result.current.model.status).toBe("searching");

      act(() => {
        searchResultsListener?.({
          searchId: firstPayload.searchId,
          entries: [],
          done: true,
          limitHit: false,
        });
      });
      expect(view.result.current.model.status).toBe("complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending updating retry when the search is cleared", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.searchWorkspace.mockResolvedValueOnce({
        status: "refused",
        code: "workspace-updating",
      });
      const view = renderHook(() =>
        useWorkspaceSearch("workspace-1", reportSearchError, clearSearchError),
      );

      await act(async () => {
        view.result.current.run(options);
        await Promise.resolve();
      });
      const searchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;
      expect(view.result.current.model.status).toBe("updating");

      act(() => view.result.current.clear());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(view.result.current.model.status).toBe("idle");
      expect(bridgeMock.searchWorkspace).toHaveBeenCalledTimes(1);
      expect(bridgeMock.cancelWorkspaceSearch).toHaveBeenCalledWith({ searchId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying through a valid long initial capture", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.searchWorkspace.mockImplementation(async () =>
        performance.now() < 26_011
          ? { status: "refused", code: "workspace-updating" }
          : { status: "accepted" },
      );
      const view = renderHook(() =>
        useWorkspaceSearch("workspace-1", reportSearchError, clearSearchError),
      );

      await act(async () => {
        view.result.current.run(options);
        await vi.advanceTimersByTimeAsync(27_000);
      });

      const searchIds = new Set(
        bridgeMock.searchWorkspace.mock.calls.map(([payload]) => payload.searchId),
      );
      expect(searchIds.size).toBe(1);
      expect(reportSearchError).not.toHaveBeenCalled();
      const searchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;
      act(() => {
        searchResultsListener?.({
          searchId,
          entries: [],
          done: true,
          limitHit: false,
        });
      });
      expect(view.result.current.model.status).toBe("complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an updating retry lane at its deadline and exposes a fresh retry", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.searchWorkspace.mockResolvedValue({
        status: "refused",
        code: "workspace-updating",
      });
      const onError = vi.fn<
        (error: unknown, retry: () => void) => void
      >();
      const view = renderHook(() =>
        useWorkspaceSearch("workspace-1", onError, clearSearchError),
      );

      await act(async () => {
        view.result.current.run(options);
        await vi.advanceTimersByTimeAsync(121_000);
      });

      expect(view.result.current.model).toMatchObject({
        searchId: null,
        status: "idle",
      });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toEqual(
        new Error("Workspace is still updating."),
      );
      const callsAtDeadline = bridgeMock.searchWorkspace.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(bridgeMock.searchWorkspace).toHaveBeenCalledTimes(callsAtDeadline);

      bridgeMock.searchWorkspace.mockResolvedValue({ status: "accepted" });
      act(() => onError.mock.calls[0]?.[1]());

      expect(view.result.current.model.status).toBe("searching");
      expect(bridgeMock.searchWorkspace.mock.calls.at(-1)?.[0].searchId).not.toBe(
        bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles only a terminal batch with the current search id", () => {
    bridgeMock.searchWorkspace.mockResolvedValueOnce({ status: "accepted" });
    const view = renderHook(() =>
      useWorkspaceSearch("workspace-1", reportSearchError, clearSearchError),
    );

    act(() => view.result.current.run(options));
    const searchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;
    act(() => {
      searchResultsListener?.({
        searchId: `${searchId}-other`,
        entries: [],
        done: true,
        limitHit: false,
      });
    });
    expect(view.result.current.model.status).toBe("searching");

    act(() => {
      searchResultsListener?.({
        searchId,
        entries: [],
        done: true,
        limitHit: false,
      });
    });
    expect(view.result.current.model).toMatchObject({
      searchId,
      status: "complete",
    });
  });

  it("reports only a rejected current invocation", async () => {
    const older = deferred<WorkspaceSearchStartResult>();
    const newer = deferred<WorkspaceSearchStartResult>();
    bridgeMock.searchWorkspace
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const view = renderHook(() =>
      useWorkspaceSearch("workspace-1", reportSearchError, clearSearchError),
    );

    act(() => view.result.current.run(options));
    const olderSearchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;
    act(() => view.result.current.run({ ...options, query: "newer" }));
    const newerSearchId = bridgeMock.searchWorkspace.mock.calls[1]?.[0].searchId;

    expect(olderSearchId).not.toBe(newerSearchId);
    expect(view.result.current.model).toMatchObject({
      searchId: newerSearchId,
      status: "searching",
    });

    await act(async () => {
      older.reject(
        new Error(
          "Error invoking remote method 'desktop:search-workspace': " +
            "Error: Workspace is still updating. Try again.",
        ),
      );
      await Promise.resolve();
    });
    expect(view.result.current.model).toMatchObject({
      searchId: newerSearchId,
      status: "searching",
    });

    await act(async () => {
      newer.reject(new Error("Workspace search stopped"));
      await Promise.resolve();
    });
    expect(view.result.current.model).toMatchObject({
      searchId: null,
      status: "idle",
    });
    expect(reportSearchError).toHaveBeenCalledTimes(1);
  });

  it("reports a current invocation failure with a retry that starts the search again", async () => {
    const onError = vi.fn<
      (error: unknown, retry: () => void) => void
    >();
    bridgeMock.searchWorkspace
      .mockRejectedValueOnce(new Error("Workspace search stopped"))
      .mockResolvedValueOnce({ status: "accepted" });
    const view = renderHook(() =>
      useWorkspaceSearch("workspace-1", onError, clearSearchError),
    );

    await act(async () => {
      view.result.current.run(options);
      await Promise.resolve();
    });

    expect(view.result.current.model).toMatchObject({
      searchId: null,
      status: "idle",
      totalMatches: 0,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error("Workspace search stopped"),
    );

    act(() => onError.mock.calls[0]?.[1]());

    expect(bridgeMock.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(bridgeMock.searchWorkspace.mock.calls[1]?.[0]).toMatchObject({
      workspaceId: "workspace-1",
      query: "needle",
    });
    expect(bridgeMock.searchWorkspace.mock.calls[1]?.[0].searchId).not.toBe(
      bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId,
    );
    expect(view.result.current.model.status).toBe("searching");
  });

  it("keeps an explicitly cleared search idle when its invocation rejects", async () => {
    const pending = deferred<WorkspaceSearchStartResult>();
    bridgeMock.searchWorkspace.mockReturnValueOnce(pending.promise);
    const view = renderHook(() =>
      useWorkspaceSearch("workspace-1", reportSearchError, clearSearchError),
    );

    act(() => view.result.current.run(options));
    act(() => view.result.current.clear());
    await act(async () => {
      pending.reject(new Error("Workspace search stopped"));
      await Promise.resolve();
    });

    expect(view.result.current.model).toMatchObject({
      searchId: null,
      status: "idle",
    });
  });

  it("drops a late batch after the workspace changes", () => {
    const view = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useWorkspaceSearch(workspaceId, reportSearchError, clearSearchError),
      { initialProps: { workspaceId: "workspace-1" } },
    );

    act(() => view.result.current.run(options));
    const searchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;

    view.rerender({ workspaceId: "workspace-2" });
    expect(bridgeMock.cancelWorkspaceSearch).toHaveBeenCalledWith({ searchId });
    act(() => {
      searchResultsListener?.({
        searchId,
        entries: [
          {
            path: "old-workspace.md",
            line: 1,
            column: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
          },
        ],
        done: true,
        limitHit: false,
      });
    });

    expect(view.result.current.model).toMatchObject({
      searchId: null,
      status: "idle",
      groups: [],
      totalMatches: 0,
    });
  });

  it("never renders the previous workspace's query or results during replacement", () => {
    const snapshots: Array<
      Pick<WorkspaceSearchApi, "model" | "criteria">
    > = [];
    let search!: WorkspaceSearchApi;
    function Probe({ workspaceId }: { workspaceId: string }) {
      search = useWorkspaceSearch(
        workspaceId,
        reportSearchError,
        clearSearchError,
      );
      snapshots.push({ model: search.model, criteria: search.criteria });
      return null;
    }
    const view = render(createElement(Probe, { workspaceId: "workspace-1" }));

    act(() => {
      search.setCriteria({ ...options, includeGlob: "", excludeGlob: "" });
      search.run(options);
    });
    const searchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;
    act(() => {
      searchResultsListener?.({
        searchId,
        entries: [
          {
            path: "old-workspace.md",
            line: 1,
            column: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
          },
        ],
        done: true,
        limitHit: false,
      });
    });

    snapshots.length = 0;
    view.rerender(createElement(Probe, { workspaceId: "workspace-2" }));

    expect(snapshots[0]?.model).toMatchObject({
      searchId: null,
      status: "idle",
      groups: [],
      totalMatches: 0,
    });
    expect(snapshots[0]?.criteria.query).toBe("");
  });

  it("keeps accepting committed-workspace results when a replacement render is interrupted", () => {
    const interrupted = new Promise<never>(() => undefined);
    let search!: WorkspaceSearchApi;
    function Probe({ workspaceId }: { workspaceId: string }) {
      search = useWorkspaceSearch(
        workspaceId,
        reportSearchError,
        clearSearchError,
      );
      if (workspaceId === "workspace-2") throw interrupted;
      return createElement(
        "output",
        { "data-testid": "committed-search-count" },
        search.model.totalMatches,
      );
    }
    const view = render(
      createElement(
        Suspense,
        { fallback: createElement("div", null, "Loading") },
        createElement(Probe, { workspaceId: "workspace-1" }),
      ),
    );

    act(() => search.run(options));
    const searchId = bridgeMock.searchWorkspace.mock.calls[0]?.[0].searchId;
    act(() => {
      startTransition(() => {
        view.rerender(
          createElement(
            Suspense,
            { fallback: createElement("div", null, "Loading") },
            createElement(Probe, { workspaceId: "workspace-2" }),
          ),
        );
      });
    });

    expect(view.getByTestId("committed-search-count").textContent).toBe("0");
    expect(view.queryByText("Loading")).toBeNull();

    act(() => {
      searchResultsListener?.({
        searchId,
        entries: [
          {
            path: "committed-workspace.md",
            line: 1,
            column: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
          },
        ],
        done: true,
        limitHit: false,
      });
    });

    expect(view.getByTestId("committed-search-count").textContent).toBe("1");
  });
});
