import { describe, expect, it } from "vitest";
import { planDemoPathMove } from "./demoWorkspacePaths";

describe("planDemoPathMove", () => {
  it("rejects a missing source path", () => {
    expect(() =>
      planDemoPathMove(["notes/existing.md"], "missing", "archive"),
    ).toThrow("No workspace entry exists at missing");
  });

  it.each(["notes", "notes/archive"])(
    "rejects moving a workspace path to %s inside itself",
    (toPath) => {
      expect(() =>
        planDemoPathMove(
          ["notes", "notes/entry.md"],
          "notes",
          toPath,
        ),
      ).toThrow("A workspace path cannot be moved inside itself");
    },
  );

  it("rejects a destination path that already exists", () => {
    expect(() =>
      planDemoPathMove(
        ["notes/a.md", "archive/a.md"],
        "notes/a.md",
        "archive/a.md",
      ),
    ).toThrow("A document already exists at archive/a.md");
  });

  it("plans valid subtree moves", () => {
    expect(
      planDemoPathMove(
        ["notes", "notes/entry.md", "archive"],
        "notes",
        "archive/notes",
      ),
    ).toEqual([
      { sourcePath: "notes", targetPath: "archive/notes" },
      {
        sourcePath: "notes/entry.md",
        targetPath: "archive/notes/entry.md",
      },
    ]);
  });
});
