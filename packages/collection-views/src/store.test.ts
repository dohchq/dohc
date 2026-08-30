import { describe, expect, it, vi } from "vitest";
import type { CollectionQueryResult, CollectionRecordGroup } from "@dohc/workspace-contracts";
import { createCollectionStore } from "./store";
import { deferred, indexedValue, makeQueryResult, makeRecord } from "./testSupport";

const CURSOR = {
  sortValues: [{ present: true, value: "a" }],
  recordPath: "tasks/rec-1.md",
  recordId: "rec-1",
};

describe("createCollectionStore", () => {
  it("refresh runs the query and stores the result", async () => {
    const record = makeRecord("rec-1", [indexedValue("title", "First")]);
    const executor = vi.fn().mockResolvedValue(makeQueryResult([record]));
    const store = createCollectionStore({ collectionPath: "tasks", executor });

    expect(store.getState().status).toBe("idle");
    await store.refresh();

    expect(executor).toHaveBeenCalledWith({ collectionPath: "tasks" });
    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.records).toEqual([record]);
    expect(state.collection?.path).toBe("tasks");
    expect(state.error).toBeNull();
  });

  it("setQuery merges input into the current query and forwards it", async () => {
    const executor = vi.fn().mockResolvedValue(makeQueryResult([]));
    const store = createCollectionStore({
      collectionPath: "tasks",
      executor,
      initialQuery: { sort: [{ field: "title", direction: "asc" }] },
    });

    await store.setQuery({ groupBy: "status" });

    expect(executor).toHaveBeenCalledWith({
      collectionPath: "tasks",
      sort: [{ field: "title", direction: "asc" }],
      groupBy: "status",
    });
    expect(store.getState().query).toEqual({
      sort: [{ field: "title", direction: "asc" }],
      groupBy: "status",
    });
  });

  it("drops a stale response that resolves after a newer one", async () => {
    const stale = deferred<CollectionQueryResult>();
    const fresh = deferred<CollectionQueryResult>();
    const executor = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const store = createCollectionStore({ collectionPath: "tasks", executor });

    const first = store.refresh();
    const second = store.refresh();
    fresh.resolve(makeQueryResult([makeRecord("rec-new")]));
    await second;
    stale.resolve(makeQueryResult([makeRecord("rec-old")]));
    await first;

    expect(store.getState().records.map((record) => record.id)).toEqual(["rec-new"]);
  });

  it("surfaces a query failure and recovers on the next refresh", async () => {
    const executor = vi
      .fn()
      .mockRejectedValueOnce(new Error("engine unavailable"))
      .mockResolvedValueOnce(makeQueryResult([makeRecord("rec-1")]));
    const store = createCollectionStore({ collectionPath: "tasks", executor });

    await store.refresh();
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("engine unavailable");

    await store.refresh();
    expect(store.getState().status).toBe("ready");
    expect(store.getState().error).toBeNull();
  });

  it("loadMore passes the cursor and appends the next page", async () => {
    const executor = vi
      .fn()
      .mockResolvedValueOnce(
        makeQueryResult([makeRecord("rec-1")], { nextCursor: CURSOR }),
      )
      .mockResolvedValueOnce(makeQueryResult([makeRecord("rec-2")]));
    const store = createCollectionStore({ collectionPath: "tasks", executor });

    await store.refresh();
    await store.loadMore();

    expect(executor).toHaveBeenLastCalledWith({ collectionPath: "tasks", cursor: CURSOR });
    expect(store.getState().records.map((record) => record.id)).toEqual(["rec-1", "rec-2"]);
    expect(store.getState().nextCursor).toBeNull();

    await store.loadMore();
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("stores grouped results and merges groups across pages", async () => {
    const pageOneGroups: CollectionRecordGroup[] = [
      { value: "todo", records: [makeRecord("rec-1")] },
    ];
    const pageTwoGroups: CollectionRecordGroup[] = [
      { value: "todo", records: [makeRecord("rec-2")] },
      { value: "shipped", records: [makeRecord("rec-3")] },
    ];
    const executor = vi
      .fn()
      .mockResolvedValueOnce(
        makeQueryResult([makeRecord("rec-1")], { groups: pageOneGroups, nextCursor: CURSOR }),
      )
      .mockResolvedValueOnce(
        makeQueryResult([makeRecord("rec-2"), makeRecord("rec-3")], { groups: pageTwoGroups }),
      );
    const store = createCollectionStore({
      collectionPath: "tasks",
      executor,
      initialQuery: { groupBy: "status" },
    });

    await store.refresh();
    await store.loadMore();

    const groups = store.getState().groups;
    expect(groups?.map((group) => group.value)).toEqual(["todo", "shipped"]);
    expect(groups?.[0]?.records.map((record) => record.id)).toEqual(["rec-1", "rec-2"]);
  });

  it("notifies subscribers on changes until they unsubscribe", async () => {
    const executor = vi.fn().mockResolvedValue(makeQueryResult([]));
    const store = createCollectionStore({ collectionPath: "tasks", executor });
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    await store.refresh();
    const callsAfterRefresh = listener.mock.calls.length;
    expect(callsAfterRefresh).toBeGreaterThan(0);

    unsubscribe();
    await store.refresh();
    expect(listener.mock.calls.length).toBe(callsAfterRefresh);
  });
});
