import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isInside } from "./pathContainment";

const root = join(process.cwd(), "containment-root");

describe("isInside", () => {
  it("counts the parent itself as inside", () => {
    expect(isInside(root, root)).toBe(true);
  });

  it("counts equality after normalization as inside", () => {
    // A trailing separator names the same directory.
    expect(isInside(`${root}${sep}`, root)).toBe(true);
    expect(isInside(root, `${root}${sep}`)).toBe(true);
  });

  it("accepts direct children and deep descendants", () => {
    expect(isInside(root, join(root, "child"))).toBe(true);
    expect(isInside(root, join(root, "a", "b", "c.txt"))).toBe(true);
  });

  it("rejects the parent of the root, siblings, and unrelated paths", () => {
    expect(isInside(root, join(root, ".."))).toBe(false);
    expect(isInside(root, join(root, "..", "sibling"))).toBe(false);
    expect(isInside(join(root, "a"), join(root, "b"))).toBe(false);
  });

  it("rejects an escape that climbs out and back down", () => {
    expect(isInside(root, join(root, "..", "..", "elsewhere", "x"))).toBe(false);
  });

  // MUTATION (..-segment): weaken the whole-segment test back to a bare
  // "..-prefix" test and this pin goes red — the historical bug rejected
  // real contained names.
  it("counts a child under a '..'-prefixed NAME as inside — '..' must be a whole segment", () => {
    expect(isInside(root, join(root, "..cache"))).toBe(true);
    expect(isInside(root, join(root, "..cache", "server.mjs"))).toBe(true);
  });

  if (process.platform === "win32") {
    it("rejects a child on another drive (relative() yields an absolute path)", () => {
      expect(isInside("C:\\ws", "D:\\evil")).toBe(false);
      expect(isInside("C:\\ws", "D:\\evil\\x")).toBe(false);
    });

    it("folds case like the filesystem does", () => {
      expect(isInside(root.toUpperCase(), join(root, "child"))).toBe(true);
      expect(isInside(root.toUpperCase(), root.toLowerCase())).toBe(true);
    });
  }
});
