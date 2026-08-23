import { describe, expect, it } from "vitest";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { shareViewTakesLocalWrites, workspaceWriteRefusal } from "./shareWriteGate";

// A registry entry's share-view marker, in the shape the registry stores it:
// the pinned grant under `grantedSelector`, which is where the level lives.
function marker(access: ShareAccess | "unreadable", ended = false) {
  return {
    shareId: "share-1",
    granterEmail: "granter@dohc.test",
    relayUrl: "https://relay.test",
    ended,
    grantedSelector:
      access === "unreadable"
        ? { paths: ["docs"] }
        : { paths: ["docs"], versionId: null, access },
  };
}

// The rule main's `assertWritableWorkspace` and the capture gate both ask.
// Both fail in a direction that costs something, so every input is stated.
describe("shareViewTakesLocalWrites", () => {
  it("takes writes at edit, and only at edit", () => {
    const levels: ShareAccess[] = ["view", "comment", "edit"];
    const takes = levels.filter((access) =>
      shareViewTakesLocalWrites({ access, ended: false }),
    );
    expect(takes).toEqual(["edit"]);
  });

  it("refuses a damaged grant, which names no level at all", () => {
    expect(
      shareViewTakesLocalWrites({ access: null, ended: false }),
      "MUTATION: an `!== \"view\"` test reads a damaged grant as writable",
    ).toBe(false);
  });

  it("refuses an ended share at every level", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      expect(
        shareViewTakesLocalWrites({ access, ended: true }),
        `${access}: MUTATION: an ended share takes a write nothing will ever send`,
      ).toBe(false);
    }
  });
});

// The OTHER rule, and the one 27 handlers sit behind. It is deliberately not
// the rule above: those handlers write the workspace FOLDER, and a share
// view's folder is a projection of its engine store — so a raw-disk write
// there leaves a projection stating content no moment does, which nothing can
// ever send and the next pull silently overwrites.
//
// The level cannot widen it, and this is the property that matters: an EDIT
// share view is refused here exactly as a view share is. The one write a
// share view admits is routed to the engine through `ShareViewFiles.change`,
// which asks `shareViewTakesLocalWrites` instead.
describe("workspaceWriteRefusal", () => {
  it("lets an ordinary workspace write", () => {
    expect(workspaceWriteRefusal(undefined)).toBeNull();
  });

  it("refuses EVERY share view, at every level, including edit", () => {
    for (const access of ["view", "comment", "edit", "unreadable"] as const) {
      expect(
        workspaceWriteRefusal(marker(access)),
        `${access}: MUTATION: a level-aware ordinary-write gate opens every raw-disk writer on a share view`,
      ).toBe("This is a shared view — ask granter@dohc.test for changes.");
    }
  });

  it("refuses a marker whose value was lost", () => {
    // PRESENCE, not truthiness: a stored `shareView: null` is a share view
    // whose marker lost its value, not a workspace that never had one.
    expect(
      workspaceWriteRefusal(null),
      "MUTATION: `?? null` reads a damaged marker as an ordinary workspace",
    ).toBe("This is a shared view — ask the person who shared it for changes.");
  });

  it("names the granter when it can, and does not invent one when it cannot", () => {
    expect(workspaceWriteRefusal({ ...marker("edit"), granterEmail: null })).toBe(
      "This is a shared view — ask the person who shared it for changes.",
    );
  });
});
