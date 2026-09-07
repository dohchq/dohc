import { describe, expect, it } from "vitest";
import { basenameOf, dirnameOf } from "./path";

describe("workspace-relative paths", () => {
  it.each([
    ["", "", ""],
    ["file.md", "file.md", ""],
    ["folder/file.md", "file.md", "folder"],
    ["folder/", "", "folder"],
    ["name\\with-backslash.md", "name\\with-backslash.md", ""],
  ])("preserves the workspace path boundary in %j", (path, basename, dirname) => {
    expect(basenameOf(path!)).toBe(basename);
    expect(dirnameOf(path!)).toBe(dirname);
  });
});
