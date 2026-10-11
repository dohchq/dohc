// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetResult } from "@dohc/cli/dataset";
import { deferred } from "../../testing/deferred";
import { useCollectionFolders } from "./useCollectionFolders";

const page: DatasetResult = { kind: "list", datasets: [{
  datasetId: "00000000-0000-4000-8000-000000000001", datasetPath: "remote/dataset.json", name: "Remote", revision: 1,
  revisionSha256: "a".repeat(64), tables: [], operations: [],
}], nextCursor: "next-page" };
function setup() {
  const dataset = vi.fn(async (): Promise<DatasetResult> => page);
  vi.stubGlobal("dohcDesktop", { dataset, listCollections: vi.fn(async () => ({ collections: [{ path: "local" }] })) });
  const hook = renderHook(({ ended }) => useCollectionFolders("share", true, true, true, ended), { initialProps: { ended: false } });
  return { ...hook, dataset };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("clears remote Collections and pagination after access ends while retaining local Collections", async () => {
  const { result, rerender } = setup();
  await act(async () => result.current.refreshDatasets());
  expect(result.current.datasets).toEqual(page.datasets);
  expect(result.current.nextDataset).toBe("next-page");
  expect(result.current.collectionFolders.has("local")).toBe(true);
  rerender({ ended: true });
  expect(result.current.datasets).toEqual([]);
  expect(result.current.nextDataset).toBeNull();
  expect(result.current.collectionFolders.has("local")).toBe(true);
  rerender({ ended: false });
  expect(result.current.datasets).toEqual([]);
});

it.each(["refresh", "load more"])("discards an old %s response across end and restoration", async action => {
  const { result, rerender, dataset } = setup();
  if (action === "load more") await act(async () => result.current.refreshDatasets());
  const read = deferred<DatasetResult>();
  dataset.mockReturnValueOnce(read.promise);
  let pending!: Promise<void>;
  act(() => { pending = action === "refresh" ? result.current.refreshDatasets() : result.current.loadMoreDatasets(); });
  rerender({ ended: true });
  rerender({ ended: false });
  await act(async () => { read.resolve(page); await pending; });
  expect(result.current.datasets).toEqual([]);
  expect(result.current.nextDataset).toBeNull();
});
