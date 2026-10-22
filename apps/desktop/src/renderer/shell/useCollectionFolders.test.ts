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

it("keeps a refusal to list the Collections here as the list's state, and reports nothing else that way", async () => {
  const { result, dataset } = setup();
  const words = "These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.";
  dataset.mockRejectedValueOnce(new Error(`Error invoking remote method 'desktop:dataset': CollectionsRefusalError [collections-elsewhere]: ${words}`));
  await act(async () => result.current.refreshDatasets());
  expect(result.current.collectionsRefusal).toEqual({ workspaceId: "share", kind: "elsewhere", words });
  expect(result.current.datasets).toEqual([]);
  await act(async () => result.current.refreshDatasets());
  expect(result.current.collectionsRefusal).toBeNull();
  expect(result.current.datasets).toEqual(page.datasets);
  dataset.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:dataset': Error: Collection storage is full."));
  await expect(act(async () => result.current.refreshDatasets())).rejects.toThrow("Collection storage is full.");
  expect(result.current.collectionsRefusal).toBeNull();
});

it("keeps where the other Collections are with the server's list, only for its own workspace", async () => {
  const { result, dataset, rerender } = setup();
  const elsewhere = { server: "https://relay.example", computer: { label: "Laptop", sameName: false } };
  dataset.mockResolvedValueOnce({ ...page, elsewhere });
  await act(async () => result.current.refreshDatasets());
  expect(result.current.datasets).toEqual(page.datasets);
  expect(result.current.collectionsElsewhere).toEqual(elsewhere);
  dataset.mockResolvedValueOnce({ ...page, nextCursor: null, elsewhere });
  await act(async () => result.current.loadMoreDatasets());
  expect(result.current.collectionsElsewhere).toEqual(elsewhere);
  rerender({ ended: true });
  expect(result.current.collectionsElsewhere).toBeNull();
  rerender({ ended: false });
  await act(async () => result.current.refreshDatasets());
  expect(result.current.collectionsElsewhere).toBeNull();
});

it("drops a server's list that answers after the window changed workspaces", async () => {
  const dataset = vi.fn(async (): Promise<DatasetResult> => page);
  vi.stubGlobal("dohcDesktop", { dataset, listCollections: vi.fn(async () => ({ collections: [] })) });
  const { result, rerender } = renderHook(({ workspaceId }) => useCollectionFolders(workspaceId, true, false), { initialProps: { workspaceId: "first" } });
  const read = deferred<DatasetResult>();
  dataset.mockReturnValueOnce(read.promise);
  let pending!: Promise<void>;
  act(() => { pending = result.current.refreshDatasets(); });
  rerender({ workspaceId: "second" });
  await act(async () => { read.resolve({ ...page, elsewhere: { server: "https://relay.example", computer: { label: "Laptop", sameName: false } } }); await pending; });
  expect(result.current.collectionsElsewhere).toBeNull();
  expect(result.current.datasets).toEqual([]);
});
