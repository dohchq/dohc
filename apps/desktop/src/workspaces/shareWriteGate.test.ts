import { describe, expect, it } from "vitest";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  joinedByAccount,
  SHARE_VIEW_EMPTY_FOLDER_REFUSAL,
  shareViewWriteLevel,
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

// The rule every local write gate asks: file changes, capture, sending,
// Collection buttons, chat and the CLI. Each fails in a direction that costs
// something, so every input is stated.
describe("shareViewWriteLevel", () => {
  const PLACES = [{ path: "docs/a.md" }, { folder: "docs" }, "group", "somewhere"] as const;

  it("gives a path share's level at every place", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      for (const place of PLACES)
        expect(shareViewWriteLevel({ access, ended: false }, place)).toBe(access);
    }
  });

  it("gives a damaged grant no level, which takes no write", () => {
    for (const place of PLACES) {
      expect(
        shareViewWriteLevel(shareViewWriteScopeOf(marker("unreadable"), null)!, place),
      ).toBeNull();
    }
  });

  it("gives an ended share no level at any place", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      for (const place of PLACES) {
        expect(
          shareViewWriteLevel({ access, ended: true }, place),
          `${access}: an ended share takes a write nothing will ever send`,
        ).toBeNull();
      }
    }
  });

  it("gives a joined workspace each path and folder its listed level, and a Group the member level", () => {
    const scope = shareViewWriteScopeOf(
      {
        shareId: "share-1",
        recipientUserId: "member-1",
        grantedSelector: { paths: [], versionId: null, access: "comment", wholeWorkspace: true },
        reach: {
          signature: "r",
          visibilitySignature: "v",
          rootLevel: "view",
          folders: [
            { path: "docs", level: "edit" },
            { path: "docs/held", level: "comment" },
          ],
        },
      },
      null,
    )!;
    expect(shareViewWriteLevel(scope, { path: "a.md" })).toBe("view");
    expect(shareViewWriteLevel(scope, { path: "docs/a.md" })).toBe("edit");
    expect(shareViewWriteLevel(scope, { path: "docs/held/a.md" })).toBe("comment");
    expect(shareViewWriteLevel(scope, { folder: "" })).toBe("view");
    expect(shareViewWriteLevel(scope, { folder: "docs" })).toBe("edit");
    expect(shareViewWriteLevel(scope, "group")).toBe("comment");
    expect(shareViewWriteLevel(scope, "somewhere")).toBe("edit");
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
// which asks `shareViewWriteLevel` at each path instead.
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
    expect(
      (["view", "comment", "edit"] as const).filter((access) => member(access, "member").write),
    ).toEqual(["edit"]);
  });

  it("offers a new folder and a new Collection to an admin at Edit, and to nobody else", () => {
    expect(member("edit", "admin")).toEqual({ write: true, folder: true, collection: true });
    expect(member("edit", "member")).toEqual({ write: true, folder: false, collection: false });
    expect(member("edit")).toEqual({ write: true, folder: false, collection: false });
    expect(member("comment", "admin")).toEqual({ write: false, folder: false, collection: false });
    expect(
      workspaceCreateOffers({ access: "edit", ended: true, membership: true }, "admin").folder,
    ).toBe(false);
  });

  it("keeps a path share at Edit to files and Collections, with no folder", () => {
    expect(workspaceCreateOffers({ access: "edit", ended: false }, "admin")).toEqual({
      write: true,
      folder: false,
      collection: true,
    });
  });

  it("reads a membership from the pinned grant", () => {
    const pinned = {
      ...marker("edit"),
      grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
    };
    expect(shareViewWriteScopeOf(pinned, null)).toMatchObject({ membership: true });
    expect(shareViewWriteScopeOf(marker("edit"), null)).toMatchObject({ membership: false });
  });
});

// A joined workspace's level belongs to the account that joined. Signed out, a
// local change waits for that account, and nothing goes to the relay. Another
// account gets neither. Each row fails if its writer reads as another.
describe("the joined-account rule", () => {
  const joinedView = {
    ...marker("edit"),
    recipientUserId: "recipient-a",
    grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
  };
  const joined = { userId: "recipient-a", relayUrl: "https://relay.test" };

  it.each([
    ["the account that joined", joined, "joined", true],
    ["another account", { userId: "someone-else", relayUrl: "https://relay.test" }, "other", false],
    [
      "the same user id on another relay",
      { userId: "recipient-a", relayUrl: "https://other-relay.test" },
      "other",
      false,
    ],
    ["nobody", null, "signed-out", false],
  ] as const)(
    "with %s signed in, names the writer and takes relay actions as it allows",
    (_name, credentials, writer, relay) => {
      expect(shareViewWriteScopeOf(joinedView, credentials)!.writer).toBe(writer);
      expect(joinedByAccount(joinedView, credentials)).toBe(relay);
    },
  );

  it("names no writer for a path share or an ended membership", () => {
    expect(
      shareViewWriteScopeOf({ ...marker("edit"), recipientUserId: "recipient-a" }, joined)?.writer,
    ).toBeUndefined();
    expect(shareViewWriteScopeOf({ ...joinedView, ended: true }, joined)?.writer).toBeUndefined();
  });
});
