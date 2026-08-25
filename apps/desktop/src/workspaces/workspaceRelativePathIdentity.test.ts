import { describe, expect, it } from "vitest";

import {
  workspaceRelativePathIdentity,
  workspaceRelativePathIsAtOrUnder,
  workspaceRelativePathsEqual,
} from "./workspaceRelativePathIdentity";

describe("workspace-relative path identity", () => {
  it("preserves the exact spelling produced by filesystem resolution", () => {
    expect(workspaceRelativePathIdentity("Notes/A.md")).toBe("Notes/A.md");
  });

  it("uses the same identity for equality and subtree matching", () => {
    expect(workspaceRelativePathsEqual("Notes/A.md", "notes/a.md")).toBe(false);
    expect(
      workspaceRelativePathIsAtOrUnder("Notes/Folder/A.md", "Notes/Folder"),
    ).toBe(true);
    expect(
      workspaceRelativePathIsAtOrUnder(
        "Notes/Folderish/A.md",
        "Notes/Folder",
      ),
    ).toBe(false);
  });
});
