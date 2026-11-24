// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ReactNode } from "react";
import { deferred } from "../../testing/deferred";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { useSharingSearch } from "./SharingSearchResults";

type Lane = "granted" | "received";
const listSharingAccess =
  vi.fn<(input: { workspaceId: string; lane: Lane; cursor?: string }) => Promise<AccessAnswer>>();
const requestAccessRefresh = vi.fn<
  (input: {
    workspaceId: string;
    reason: string;
    wait?: true;
  }) => Promise<{ status: string } | undefined>
>(async () => undefined);

beforeEach(() => {
  listSharingAccess.mockReset();
  requestAccessRefresh.mockReset();
  requestAccessRefresh.mockResolvedValue(undefined);
  vi.stubGlobal("dohcDesktop", { listSharingAccess, requestAccessRefresh });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function share(index: number): AccessShareRow {
  return {
    kind: "share",
    shareId: `share-${index}`,
    grantId: `grant-${index}`,
    via: "named",
    granterUserId: "me",
    granterEmail: null,
    recipientUserId: "sam",
    recipientEmail: "sam@example.com",
    subjectName: null,
    sharerName: null,
    selector: { paths: [`notes/file-${index}.md`], versionId: null },
    access: "view",
    status: "active",
    generation: 1,
  };
}
function page(
  rows: AccessShareRow[],
  nextCursor: string | null,
  coverage: AccessAnswer["coverage"]["kind"] = "granted",
): AccessAnswer {
  return {
    ref: null,
    rows,
    visibility: "visible",
    unknownReason: null,
    coverage: { kind: coverage, complete: true, observation: "interval" },
    checkedAtMs: 1,
    freshness: "fresh",
    nextCursor,
  };
}
const FIRST = Array.from({ length: 100 }, (_, index) => share(index));
const wrapper = ({ children }: { children?: ReactNode }) => (
  <WorkspaceSessionProvider workspaceId="ws-1">{children}</WorkspaceSessionProvider>
);

it("finds a share on a lane's second page", async () => {
  listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
    lane === "received"
      ? page([], null, "received-account")
      : cursor === "page-2"
        ? page([share(150)], null)
        : page(FIRST, "page-2"),
  );
  const { result } = renderHook(() => useSharingSearch("ws-1", false, "file-150"), { wrapper });
  await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-150"]));
  expect(listSharingAccess).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    lane: "granted",
    cursor: "page-2",
  });
});

it.each([false, true])(
  "drops a previous workspace's sharing search after a paced refresh: %s",
  async (paced) => {
    const pending = deferred<AccessAnswer>();
    const refreshed = deferred<{ status: string }>();
    requestAccessRefresh.mockImplementation(async (input) => {
      if (input.workspaceId !== "ws-1" || !paced) return undefined;
      return input.wait ? refreshed.promise : { status: "paced" };
    });
    let workspaceId = "ws-1";
    listSharingAccess.mockImplementation(async (input) => {
      if (input.lane === "received") return page([], null, "received-account");
      if (input.workspaceId === "ws-2") return page([share(2)], null);
      return paced ? page([share(1)], null) : pending.promise;
    });
    const { result, rerender } = renderHook(() => useSharingSearch(workspaceId, false, "file"), {
      wrapper: ({ children }) => (
        <WorkspaceSessionProvider workspaceId={workspaceId}>{children}</WorkspaceSessionProvider>
      ),
    });
    await waitFor(() =>
      expect(
        paced
          ? requestAccessRefresh.mock.calls.some(([input]) => input.wait)
          : listSharingAccess.mock.calls.some(([input]) => input.workspaceId === "ws-1"),
      ).toBe(true),
    );
    workspaceId = "ws-2";
    rerender();
    await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-2"]));
    await act(async () => {
      pending.resolve(page([share(1)], null));
      refreshed.resolve({ status: "joined" });
    });
    expect(result.current.map((found) => found.shareId)).toEqual(["share-2"]);
  },
);

it("keeps what it read when main refuses a later page", async () => {
  listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
    lane === "received"
      ? page([], null, "received-account")
      : cursor
        ? page([], null, "unavailable")
        : page([share(7)], "stale"),
  );
  const { result } = renderHook(() => useSharingSearch("ws-1", false, "file-7"), { wrapper });
  await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-7"]));
  expect(listSharingAccess).toHaveBeenCalledTimes(3);
});

it("reads again on the next query after every lane's first read failed, and does not loop", async () => {
  listSharingAccess.mockRejectedValue(new Error("relay down"));
  const { result, rerender } = renderHook(({ query }) => useSharingSearch("ws-1", false, query), {
    initialProps: { query: "file" },
    wrapper,
  });
  await waitFor(() => expect(listSharingAccess).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(listSharingAccess).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual([]);

  listSharingAccess.mockImplementation(async ({ lane }) =>
    lane === "granted" ? page([share(3)], null) : page([], null, "received-account"),
  );
  rerender({ query: "file-3" });
  await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-3"]));
  expect(listSharingAccess).toHaveBeenCalledTimes(4);
});

// Main listed less than a minute ago, so it paces the refresh. Search shows
// what it has, then reads again when main's next check ends.
it("reads again when a paced check ends, so a share made in the last minute is found", async () => {
  vi.useFakeTimers();
  try {
    let rows: AccessShareRow[] = [];
    requestAccessRefresh.mockImplementation(async (input) => {
      if (!input.wait) return { status: "paced" };
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      rows = [share(3)];
      return { status: "joined" };
    });
    listSharingAccess.mockImplementation(async ({ lane }) =>
      lane === "granted" ? page(rows, null) : page([], null, "received-account"),
    );
    const { result } = renderHook(() => useSharingSearch("ws-1", false, "file-3"), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.map((found) => found.shareId)).toEqual(["share-3"]);
  } finally {
    vi.useRealTimers();
  }
});
