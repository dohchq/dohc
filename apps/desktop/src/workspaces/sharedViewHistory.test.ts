import { describe, expect, it, vi } from "vitest";
import { sharedViewHistory } from "./sharedViewHistory";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";

type Store = Parameters<typeof sharedViewHistory>[0];
type Page = Awaited<ReturnType<Store["listHistoryPage"]>>;

describe("sharedViewHistory", () => {
  it("filters imported objects inside the received share store", async () => {
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: "shared-workspace", path: "a.md", text: "first", objectId: "shared-a" });
    loopback.seedTextFile({ workspace: "shared-workspace", path: "b.md", text: "second", objectId: "shared-b" });
    loopback.seedTextFile({ workspace: "owner-workspace", path: "hidden.md", text: "private", objectId: "hidden" });
    const { store } = createCaptureLiveStores({ workspaceId: "shared-workspace", rootPath: await createTestScratch("history-share-"), attachmentId: Symbol("share") }, mockLiveSessions(loopback));
    const history = sharedViewHistory(store, "shared-workspace");
    expect((await history.listMoments({ objectId: "shared-a" })).moments.map((moment) => moment.objectId)).toEqual(["shared-a"]);
    await expect(history.listMoments({ objectId: "hidden" })).resolves.toMatchObject({ moments: [], latestMomentOrder: -1, protectedTruncated: false });
    expect((await history.listMoments()).moments).toHaveLength(2);
  });

  // A recipient reads only the share's text moments. A protected row the
  // store holds is neither listed nor counted, and no secret store is asked.
  it("lists and opens only the share store's text moments", async () => {
    const text = { id: "moment-1", path: "notes/plan.md", momentOrder: 1 };
    const page = {
      activeVersion: { id: "main" },
      textMomentPage: { moments: [text], nextBeforeMomentOrder: null, latestMomentOrder: 1 },
      protectedMoments: [{ id: "secret-1", path: "private/key.md" }],
      protectedTruncated: true,
    } as unknown as Page;
    const store = { listHistoryPage: vi.fn(async () => page), getMoment: vi.fn(async () => null) };
    const history = sharedViewHistory(store, "shared-workspace");

    expect(await history.listMoments({ limit: 5 })).toEqual({
      moments: [{ ...text, protected: false }],
      nextBeforeMomentOrder: null,
      latestMomentOrder: 1,
      activeVersionId: "main",
      protectedTruncated: false,
    });
    expect(store.listHistoryPage).toHaveBeenCalledWith({ workspaceId: "shared-workspace", limit: 5 });
    expect(await history.readMoment("secret-1")).toBeNull();
    expect(store.getMoment).toHaveBeenCalledWith({ workspaceId: "shared-workspace", momentId: "secret-1" });
    await expect(history.listMoments({ objectId: "object-1", limit: 1, beforeMomentOrder: 8 })).resolves.toMatchObject({ moments: [{ ...text, protected: false }] });
    expect(store.listHistoryPage).toHaveBeenLastCalledWith({ workspaceId: "shared-workspace", objectId: "object-1", limit: 1, beforeMomentOrder: 8 });
  });
});
