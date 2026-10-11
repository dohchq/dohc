// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { useSharingSearch } from "./SharingSearchResults";

type Lane = "granted" | "received";
const listSharingAccess = vi.fn<(input: { workspaceId: string; lane: Lane; cursor?: string }) => Promise<AccessAnswer>>();
const requestAccessRefresh = vi.fn(async () => undefined);

beforeEach(() => {
  listSharingAccess.mockReset();
  requestAccessRefresh.mockClear();
  vi.stubGlobal("dohcDesktop", { listSharingAccess, requestAccessRefresh });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function share(index: number): AccessShareRow {
  return {
    kind: "share", shareId: `share-${index}`, grantId: `grant-${index}`, via: "named", granterUserId: "me", granterEmail: null,
    recipientUserId: "sam", recipientEmail: "sam@example.com", subjectName: null, sharerName: null,
    selector: { paths: [`notes/file-${index}.md`], versionId: null }, access: "view", status: "active", generation: 1,
  };
}
function page(rows: AccessShareRow[], nextCursor: string | null, coverage: AccessAnswer["coverage"]["kind"] = "granted"): AccessAnswer {
  return {
    ref: null, rows, visibility: "visible", coverage: { kind: coverage, complete: true, observation: "interval" },
    checkedAtMs: 1, freshness: "fresh", nextCursor,
  };
}
const FIRST = Array.from({ length: 100 }, (_, index) => share(index));

it("finds a share on a lane's second page", async () => {
  listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
    lane === "received" ? page([], null, "received-account") : cursor === "page-2" ? page([share(150)], null) : page(FIRST, "page-2"));
  const { result } = renderHook(() => useSharingSearch("ws-1", false, "file-150"));
  await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-150"]));
  expect(listSharingAccess).toHaveBeenCalledWith({ workspaceId: "ws-1", lane: "granted", cursor: "page-2" });
});

it("keeps what it read when main refuses a later page", async () => {
  listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
    lane === "received" ? page([], null, "received-account")
      : cursor ? page([], null, "unavailable") : page([share(7)], "stale"));
  const { result } = renderHook(() => useSharingSearch("ws-1", false, "file-7"));
  await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-7"]));
  expect(listSharingAccess).toHaveBeenCalledTimes(3);
});

it("reads again on the next query after every lane's first read failed, and does not loop", async () => {
  listSharingAccess.mockRejectedValue(new Error("relay down"));
  const { result, rerender } = renderHook(({ query }) => useSharingSearch("ws-1", false, query), { initialProps: { query: "file" } });
  await waitFor(() => expect(listSharingAccess).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(listSharingAccess).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual([]);

  listSharingAccess.mockImplementation(async ({ lane }) => lane === "granted" ? page([share(3)], null) : page([], null, "received-account"));
  rerender({ query: "file-3" });
  await waitFor(() => expect(result.current.map((found) => found.shareId)).toEqual(["share-3"]));
  expect(listSharingAccess).toHaveBeenCalledTimes(4);
});
