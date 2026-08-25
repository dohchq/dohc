import { describe, expect, it } from "vitest";

import {
  workspaceRelativePathIdentity,
  workspaceRelativePathIsAtOrUnder,
  workspaceRelativePathsEqual,
} from "./workspaceRelativePathIdentity";

describe("workspace-relative path identity", () => {
  it("folds case for Windows and preserves it on case-sensitive platforms", () => {
    expect(workspaceRelativePathIdentity("Notes/A.md", "win32")).toBe(
      "notes/a.md",
    );
    expect(workspaceRelativePathIdentity("Notes/A.md", "linux")).toBe(
      "Notes/A.md",
    );
  });

  it("uses the same identity for equality and subtree matching", () => {
    expect(
      workspaceRelativePathsEqual("Notes/A.md", "notes/a.md", "win32"),
    ).toBe(true);
    expect(
      workspaceRelativePathIsAtOrUnder(
        "Notes/Folder/A.md",
        "notes/folder",
        "win32",
      ),
    ).toBe(true);
    expect(
      workspaceRelativePathIsAtOrUnder(
        "Notes/Folderish/A.md",
        "notes/folder",
        "win32",
      ),
    ).toBe(false);
  });
});
