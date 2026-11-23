import { describe, expect, it } from "vitest";
import { classifyFiles } from "./explorerHomeModel";

describe("classifyFiles", () => {
  it("excludes files inside hidden dot-folders like .obsidian from Home", () => {
    const result = classifyFiles(
      [
        { path: "README.md", kind: "file" },
        { path: ".obsidian/app.json", kind: "file" },
        { path: ".obsidian/workspace.json", kind: "file" },
        { path: "Assets/diagram.png", kind: "file" },
      ],
      new Set(),
      new Set(),
      new Set(),
    );
    expect(result.pages.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(result.others.shown.map((entry) => entry.path)).toEqual(["Assets/diagram.png"]);
    expect(result.others.count).toBe(1);
  });
});
