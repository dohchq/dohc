// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSearchPayload } from "../../ipc/bridgeContract";
import { useWorkspaceSearch, type SearchRunOptions } from "./useWorkspaceSearch";

const bridgeMock = {
  searchWorkspace: vi.fn<(payload: WorkspaceSearchPayload) => Promise<void>>(),
  cancelWorkspaceSearch: vi.fn(async () => undefined),
  onSearchResults: vi.fn(() => () => undefined),
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
  bridgeMock.cancelWorkspaceSearch.mockResolvedValue(undefined);
  bridgeMock.onSearchResults.mockReturnValue(() => undefined);
});

afterEach(() => cleanup());

describe("useWorkspaceSearch", () => {
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
      older.reject(new Error("Workspace search stopped"));
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
