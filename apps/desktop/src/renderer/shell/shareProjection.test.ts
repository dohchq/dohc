import { describe, expect, it } from "vitest";
import { goneMountProjections, shareUnmountProjection } from "./shareProjection";

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
