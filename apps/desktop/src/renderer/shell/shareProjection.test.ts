import { describe, expect, it } from "vitest";
import {
  goneMountProjections,
  shareRefreshSummary,
  shareUnmountProjection,
} from "./shareProjection";

describe("share unmount projection", () => {
  it("reprojects like a folder delete when the folder went", () => {
    expect(
      shareUnmountProjection({
        shareId: "share-1",
        label: "alex",
        folderLeft: false,
      }),
    ).toEqual([
      {
        id: "unmount-share-1",
        kind: "delete-folder",
        path: "shared-with-me/alex",
      },
    ]);
  });

  // Both removal surfaces funnel here. The Explorer records the share id
  // itself; Settings reports it through the files-changed callback. Either
  // way the reload must not delete state for files still on disk.
  it("skips a vanished mount whose folder stayed, whichever surface removed it", () => {
    const previous = [
      { shareId: "s-gone", label: "alex" },
      { shareId: "s-left", label: "sam" },
      { shareId: "s-stays", label: "kim" },
    ];
    const next = [{ shareId: "s-stays" }];
    const foldersLeftBehind = new Set(["s-left"]);

    expect(
      goneMountProjections({ previous, next, foldersLeftBehind }),
      "projecting a delete for a mount whose folder is still there",
    ).toEqual([
      {
        id: "unmount-s-gone",
        kind: "delete-folder",
        path: "shared-with-me/alex",
      },
    ]);
    // Consumed, so an unrelated later reload cannot read a stale exemption.
    expect(foldersLeftBehind.has("s-left")).toBe(false);
  });

  it("projects nothing when nothing vanished", () => {
    expect(
      goneMountProjections({
        previous: [{ shareId: "s-1", label: "alex" }],
        next: [{ shareId: "s-1" }],
        foldersLeftBehind: new Set(),
      }),
    ).toEqual([]);
  });

  it("projects nothing when the folder stayed", () => {
    expect(
      shareUnmountProjection({
        shareId: "share-1",
        label: "alex",
        folderLeft: true,
      }),
      "deleting path-keyed state for files that are still on disk",
    ).toEqual([]);
  });
});

// The closing line a manual refresh leaves behind. Damage has to reach it:
// reporting damage in a separate notice meant the summary replaced it, and
// the user was left with "Shares refreshed" — the wrong half.
describe("share refresh summary", () => {
  const row = (over: Partial<{ label: string; status: string; changedPaths: number }>) => ({
    label: "alex",
    status: "updated" as const,
    changedPaths: 0,
    ...over,
  }) as Parameters<typeof shareRefreshSummary>[0][number];

  it("states damage and how to fix it, alongside the refresh result", () => {
    const summary = shareRefreshSummary([
      row({ label: "kim", changedPaths: 2 }),
      row({ label: "alex", status: "damaged" }),
    ]);
    expect(summary).toContain("Shares refreshed — 2 files updated.");
    expect(
      summary,
      "the summary replaces the damage notice and the fix is lost",
    ).toContain("dohc can't read what alex grants. Remove it and add the share again.");
    expect(summary).not.toContain("grant.");
  });

  it("says nothing about damage when every mount is healthy", () => {
    const summary = shareRefreshSummary([row({ changedPaths: 1 })]);
    expect(summary).toBe("Shares refreshed — 1 file updated.");
    expect(summary).not.toContain("can't read");
  });

  it("keeps the ended report when damage is present too", () => {
    const summary = shareRefreshSummary([
      row({ label: "kim", status: "ended" }),
      row({ label: "alex", status: "damaged" }),
      row({ label: "sam", status: "damaged" }),
    ]);
    expect(summary).toContain("kim ended");
    // Plural subjects take the plural verb; the singular case keeps "grants".
    expect(
      summary,
      "two shares reading as one — \"what alex, sam grants\"",
    ).toContain("what alex, sam grant. Remove them and add those shares again.");
  });

  it("says so when there is nothing to refresh", () => {
    expect(shareRefreshSummary([])).toBe("No shares are added to this workspace.");
  });
});
