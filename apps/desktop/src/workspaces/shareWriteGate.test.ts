import { describe, expect, it } from "vitest";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  SHARE_VIEW_EMPTY_FOLDER_REFUSAL,
  shareViewTakesLocalWrites,
  shareViewWriteScopeOf,
  workspaceCreateOffers,
  workspaceWriteRefusal,
} from "./shareWriteGate";

function marker(access: ShareAccess | "unreadable", ended = false) {
  return {
    shareId: "share-1",
    granterEmail: "granter@dohc.test",
    relayUrl: "https://relay.test",
    ended,
    grantedSelector:
      access === "unreadable" ? { paths: ["docs"] } : { paths: ["docs"], versionId: null, access },
  };
}

describe("shareViewTakesLocalWrites", () => {
  it("takes writes at edit, and only at edit", () => {
    const levels: ShareAccess[] = ["view", "comment", "edit"];
    const takes = levels.filter((access) => shareViewTakesLocalWrites({ access, ended: false }));
    expect(takes).toEqual(["edit"]);
  });

  it("refuses a damaged grant, which names no level at all", () => {
    expect(
      shareViewTakesLocalWrites({ access: null, ended: false }),
      'an `!== "view"` test reads a damaged grant as writable',
    ).toBe(false);
  });

  it("refuses an ended share at every level", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      expect(
        shareViewTakesLocalWrites({ access, ended: true }),
        `${access}: an ended share takes a write nothing will ever send`,
      ).toBe(false);
    }
  });
});

// The other rule, and the one 27 handlers sit behind. It is deliberately not
// the rule above: those handlers write the workspace FOLDER, and a share
// view's folder is a projection of its engine store — so a raw-disk write
// there leaves a projection stating content no moment does, which nothing can
// ever send and the next pull silently overwrites.
//
// The level cannot widen it, and this is the property that matters: an edit
// share view is refused here exactly as a view share is. The one write a
// share view admits is routed to the engine through `ShareViewFiles.change`,
// which asks `shareViewTakesLocalWrites` instead.
describe("workspaceWriteRefusal", () => {
  it("gives the action that can represent a folder in a shared view", () => {
    expect(SHARE_VIEW_EMPTY_FOLDER_REFUSAL).toBe(
      "A shared view can't hold an empty folder. Make a file in the folder you want.",
    );
  });

  it("lets an ordinary workspace write", () => {
    expect(workspaceWriteRefusal(undefined)).toBeNull();
  });

  it("refuses every share view, at every level, including edit", () => {
    for (const access of ["view", "comment", "edit", "unreadable"] as const) {
      expect(
        workspaceWriteRefusal(marker(access)),
        `${access}: a level-aware ordinary-write gate opens every raw-disk writer on a share view`,
      ).toBe("This is a shared view — ask granter@dohc.test for changes.");
    }
  });

  it("refuses a marker whose value was lost", () => {
    expect(
      workspaceWriteRefusal(null),
      "`?? null` reads a damaged marker as an ordinary workspace",
    ).toBe("This is a shared view — ask the person who shared it for changes.");
  });

  it("names the granter when it can, and does not invent one when it cannot", () => {
    expect(workspaceWriteRefusal({ ...marker("edit"), granterEmail: null })).toBe(
      "This is a shared view — ask the person who shared it for changes.",
    );
  });
});

// What a joined workspace offers. A page needs Edit; a folder starts with its
// first page and only an admin starts one, as the relay decides.
describe("workspaceCreateOffers in a joined workspace", () => {
  const member = (access: ShareAccess, role?: "admin" | "member") =>
    workspaceCreateOffers({ access, ended: false, membership: true }, role);

  it("offers a new page at Edit only", () => {
    expect((["view", "comment", "edit"] as const).filter((access) => member(access, "member").write)).toEqual(["edit"]);
  });

  it("offers a new folder and a new Collection to an admin at Edit, and to nobody else", () => {
    expect(member("edit", "admin")).toEqual({ write: true, folder: true, collection: true });
    expect(member("edit", "member")).toEqual({ write: true, folder: false, collection: false });
    expect(member("edit")).toEqual({ write: true, folder: false, collection: false });
    expect(member("comment", "admin")).toEqual({ write: false, folder: false, collection: false });
    expect(workspaceCreateOffers({ access: "edit", ended: true, membership: true }, "admin").folder).toBe(false);
  });

  it("offers nothing while another account than the one that joined is signed in", () => {
    expect(workspaceCreateOffers({ access: "edit", ended: false, membership: true }, "admin", true))
      .toEqual({ write: false, folder: false, collection: false });
    expect(workspaceCreateOffers(null, undefined, true).write).toBe(true);
  });

  it("keeps a path share at Edit to files and Collections, with no folder", () => {
    expect(workspaceCreateOffers({ access: "edit", ended: false }, "admin")).toEqual({ write: true, folder: false, collection: true });
  });

  it("reads a membership from the pinned grant", () => {
    const pinned = { ...marker("edit"), grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true } };
    expect(shareViewWriteScopeOf(pinned)).toMatchObject({ membership: true });
    expect(shareViewWriteScopeOf(marker("edit"))).toMatchObject({ membership: false });
  });
});
