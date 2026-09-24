import { describe, expect, it } from "vitest";
import type { NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { sentNoticeFolder, sentNoticePlace } from "./sentNoticePlace";

function workspace(workspaceId: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { workspaceId, rootPath: `/home/ana/${workspaceId}`, kind: "personal", mode: "local-first", ...extra };
}

type Placed = Pick<NoticeRow, "workspaceId" | "recipientShareId" | "target">;
const owned = (target: Placed["target"]): Placed => ({ workspaceId: "trip", recipientShareId: null, target });
const shared = (target: Placed["target"]): Placed => ({ workspaceId: null, recipientShareId: "share-1", target });

describe("where a sent notice opens", () => {
  it("says access ended once the target was cleared", () => {
    expect(sentNoticePlace(shared(null), [workspace("trip")], "trip")).toEqual({ kind: "access-ended" });
  });

  it("opens an owned workspace's file, here or after a switch", () => {
    const trip = workspace("trip");
    expect(sentNoticePlace(owned({ path: "plans/day-1.md" }), [trip], "notes"))
      .toEqual({ kind: "workspace", workspace: trip, path: "plans/day-1.md", mount: null });
    expect(sentNoticePlace(owned({ thread: "t-1" }), [trip], "trip"))
      .toEqual({ kind: "workspace", workspace: trip, path: null, mount: null });
    expect(sentNoticePlace(owned({ path: "plans/day-1.md" }), [], "notes")).toEqual({ kind: "not-here" });
  });

  it("finds a share in this workspace's shared-with-me before a separate view", () => {
    const view = workspace("view", { shareView: { shareId: "share-1", granterEmail: "owner@example.com" } });
    const here = workspace("notes", {
      shareMounts: [{ shareId: "share-1", label: "owner", granterEmail: "owner@example.com" }],
    });
    expect(sentNoticePlace(shared({ path: "trip/day-1.md" }), [view, here], "notes"))
      .toEqual({ kind: "workspace", workspace: here, path: "shared-with-me/owner/trip/day-1.md", mount: "owner" });
    expect(sentNoticePlace(shared({ path: "trip/day-1.md" }), [view, here], "other"))
      .toEqual({ kind: "workspace", workspace: view, path: "trip/day-1.md", mount: null });
  });

  it("offers to add a share this computer does not hold", () => {
    expect(sentNoticePlace(shared({ path: "trip/day-1.md" }), [workspace("notes")], "notes"))
      .toEqual({ kind: "share", shareId: "share-1", path: "trip/day-1.md" });
  });

  it("has nowhere to go for a notice about no workspace", () => {
    expect(sentNoticePlace({ workspaceId: null, recipientShareId: null, target: {} }, [], "notes"))
      .toEqual({ kind: "none" });
  });

  it("names the Collection folder from the target path", () => {
    expect(sentNoticeFolder({ target: { path: "Trips/Japan/day-1.md" } })).toBe("Japan");
    expect(sentNoticeFolder({ target: { path: "day-1.md" } })).toBeNull();
    expect(sentNoticeFolder({ target: null })).toBeNull();
  });
});
