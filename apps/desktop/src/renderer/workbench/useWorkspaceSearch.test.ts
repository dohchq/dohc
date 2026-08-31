// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSearchPayload } from "../../ipc/bridgeContract";
import type { SearchResultsEvent } from "../../ipc/channels";
import { useWorkspaceSearch, type SearchRunOptions } from "./useWorkspaceSearch";

let searchResultsListener: ((event: SearchResultsEvent) => void) | null = null;
const bridgeMock = {
  searchWorkspace: vi.fn<(payload: WorkspaceSearchPayload) => Promise<void>>(),
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

beforeEach(() => {
  vi.clearAllMocks();
  searchResultsListener = null;
  bridgeMock.searchWorkspace.mockReset();
  bridgeMock.searchWorkspace.mockResolvedValue(undefined);
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
        .mockRejectedValueOnce(
          new Error(
            "Error invoking remote method 'desktop:search-workspace': " +
              "Error: Workspace is still updating. Try again.",
          ),
        )
        .mockResolvedValueOnce(undefined);
      const view = renderHook(() => useWorkspaceSearch("workspace-1"));

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
      expect(view.result.current.model.status).toBe("updating");

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
      bridgeMock.searchWorkspace.mockRejectedValueOnce(
        new Error("Workspace is still updating. Try again."),
      );
      const view = renderHook(() => useWorkspaceSearch("workspace-1"));

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

  it("settles only a terminal batch with the current search id", () => {
    bridgeMock.searchWorkspace.mockResolvedValueOnce(undefined);
    const view = renderHook(() => useWorkspaceSearch("workspace-1"));

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

  it("settles a rejected current invocation without letting an older rejection settle it", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    bridgeMock.searchWorkspace
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const view = renderHook(() => useWorkspaceSearch("workspace-1"));

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
      searchId: newerSearchId,
      status: "complete",
    });
  });

  it("keeps an explicitly cleared search idle when its invocation rejects", async () => {
    const pending = deferred<void>();
    bridgeMock.searchWorkspace.mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useWorkspaceSearch("workspace-1"));

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
});
