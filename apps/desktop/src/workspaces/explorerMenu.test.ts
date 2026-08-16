import { describe, expect, it } from "vitest";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { explorerMenuEntries, type ExplorerMenuScope } from "./explorerMenu";

// WHAT THE MENU OFFERS, driven rather than read (#802).
//
// This menu is a security surface: main owns it so a renderer cannot add an
// item back, and it has to mirror the write gates behind it. Until this suite
// it could only be pinned by reading main's source, and a source pin proves
// position, never behaviour — it cannot tell a menu that offers the right
// items from one that offers all of them.

const WRITES = ["new-file", "new-folder", "import-files", "rename", "delete"];

function scope(overrides: Partial<ExplorerMenuScope> = {}): ExplorerMenuScope {
  return {
    kind: "file",
    pinned: false,
    isMountPath: false,
    hasMountRecord: false,
    canShare: false,
    shareView: null,
    ...overrides,
  };
}

function commands(overrides: Partial<ExplorerMenuScope> = {}): string[] {
  return explorerMenuEntries(scope(overrides)).flatMap((entry) =>
    entry.kind === "item" ? [entry.id] : [],
  );
}

const shareView = (access: ShareAccess | null, ended = false) => ({ access, ended });

describe("an ordinary workspace", () => {
  it("offers every file operation", () => {
    expect(commands({ kind: "root" })).toEqual([
      "new-file",
      "new-folder",
      "import-files",
      "export-zip",
    ]);
    expect(commands({ kind: "folder" })).toEqual([
      "new-file",
      "new-folder",
      "import-files",
      "rename",
      "delete",
      "pin",
      "export-zip",
      "open-externally",
    ]);
    expect(commands({ kind: "file" })).toEqual([
      "rename",
      "delete",
      "pin",
      "export-zip",
      "open-externally",
    ]);
  });

  it("offers Share… only where the workspace can grant one", () => {
    expect(commands({ kind: "file", canShare: true })).toContain("share");
    expect(commands({ kind: "file", canShare: false })).not.toContain("share");
  });

  it("offers Unpin for a pinned path", () => {
    expect(commands({ pinned: true })).toContain("unpin");
    expect(commands({ pinned: true })).not.toContain("pin");
  });
});

describe("a share view", () => {
  it("offers the four routed operations at edit, and never New folder", () => {
    expect(commands({ kind: "folder", shareView: shareView("edit") })).toEqual([
      "new-file",
      "import-files",
      "rename",
      "delete",
      "pin",
      "export-zip",
      "open-externally",
    ]);
    expect(commands({ kind: "root", shareView: shareView("edit") })).toEqual([
      "new-file",
      "import-files",
      "export-zip",
    ]);
    expect(
      commands({ kind: "folder", shareView: shareView("edit") }),
      "MUTATION: a share view offering New folder promises a change no moment can state",
    ).not.toContain("new-folder");
  });

  for (const [label, view] of [
    ["view", shareView("view")],
    ["comment", shareView("comment")],
    ["a grant this process cannot read", shareView(null)],
    ["an ended edit share", shareView("edit", true)],
  ] as const) {
    it(`offers no file operation at ${label}`, () => {
      for (const kind of ["root", "folder", "file"] as const) {
        const offered = commands({ kind, shareView: view });
        for (const write of WRITES) {
          expect(
            offered,
            `MUTATION: a menu that ignores the level offers ${write} at ${label}, which the handler behind it refuses`,
          ).not.toContain(write);
        }
      }
      expect(commands({ kind: "file", shareView: view })).toEqual([
        "pin",
        "export-zip",
        "open-externally",
      ]);
      expect(commands({ kind: "root", shareView: view })).toEqual(["export-zip"]);
    });
  }

  it("never offers Share…, even when told it could", () => {
    // Someone else's files are not this account's to grant. main computes
    // `canShare` from the same fact, but a defense that only exists in main is
    // not one the menu performs — so this asks with canShare TRUE, which is
    // the only way the assertion can fail when the guard is absent.
    for (const access of ["edit", "comment", "view"] as const) {
      expect(
        commands({ kind: "file", shareView: shareView(access), canShare: true }),
        "MUTATION: a share view offers Share… for files this account cannot grant",
      ).not.toContain("share");
    }
    // And an ordinary workspace still gets it, so the guard above is not
    // simply switching the item off everywhere.
    expect(commands({ kind: "file", shareView: null, canShare: true })).toContain("share");
  });
});

describe("a share mount inside an ordinary workspace", () => {
  it("stays read-only, and offers mount controls at its root", () => {
    const atRoot = commands({
      kind: "folder",
      isMountPath: true,
      hasMountRecord: true,
    });
    expect(atRoot).toEqual([
      "refresh-share-mount",
      "unmount-share",
      "pin",
      "export-zip",
      "open-externally",
    ]);
    for (const write of WRITES) {
      expect(
        atRoot,
        `MUTATION: a mount offering ${write} writes a projection of someone else's files`,
      ).not.toContain(write);
    }
    expect(commands({ kind: "file", isMountPath: true, hasMountRecord: false })).toEqual([
      "refresh-share-mount",
      "pin",
      "export-zip",
      "open-externally",
    ]);
  });
});
