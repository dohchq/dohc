import { link, lstat, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { diskSpelling, storedNameAmong } from "./diskSpelling";
import { createTestScratch } from "./testTemp";

describe("storedNameAmong", () => {
  it("uses the exact listed name without inspecting other entries", async () => {
    const sameFile = vi.fn(async () => true);
    expect(await storedNameAmong("Notes.md", ["notes.md", "Notes.md"], sameFile)).toBe("Notes.md");
    expect(sameFile).not.toHaveBeenCalled();
  });

  it("prefers the folded name to an unrelated hard link", async () => {
    const sameFile = vi.fn(async () => true);
    expect(await storedNameAmong("Notes.md", ["backup.md", "notes.md"], sameFile)).toBe("notes.md");
    expect(sameFile.mock.calls).toEqual([["notes.md"]]);
  });

  it("uses the share view's Unicode collision fold", async () => {
    expect(await storedNameAmong("STRASSE.md", ["Straße.md", "backup.md"], async () => true)).toBe("Straße.md");
  });

  it("falls back to identity when the disk folds a name differently", async () => {
    expect(await storedNameAmong("NOTES~1.MD", ["other.md", "Notes draft.md"], async (name) => name === "Notes draft.md")).toBe("Notes draft.md");
  });

  it("checks other names when no folded name is the same file", async () => {
    expect(await storedNameAmong("Notes.md", ["notes.md", "alias.md"], async (name) => name === "alias.md")).toBe("alias.md");
  });

  it.each([
    ["Notes.md", ["notes.md", "NOTES.md", "backup.md"]],
    ["NOTES~1.MD", ["a.md", "b.md"]],
  ] as const)("refuses ambiguous identity matches for %s", async (leaf, names) => {
    expect(await storedNameAmong(leaf, names, async () => true)).toBeNull();
  });

  it("returns null without an identity match", async () => {
    expect(await storedNameAmong("Notes.md", ["other.md"], async () => false)).toBeNull();
  });
});

describe("diskSpelling", () => {
  it("reads an exact name below the root", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "Docs"));
    const file = join(root, "Docs", "notes.md");
    await writeFile(file, "body");
    expect(await diskSpelling(root, file)).toBe(join(await realpath(root), "Docs", "notes.md"));
  });

  it("reads every stored name through another case, beside an unrelated hard link", async (context) => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "Docs"));
    const file = join(root, "Docs", "notes.md");
    await writeFile(file, "body");
    const lookup = join(root, "docs", "Notes.md");
    if (!(await lstat(lookup).then(() => true, () => false))) context.skip("this disk keeps case apart");
    await link(file, join(root, "Docs", "backup.md"));

    expect(await diskSpelling(root, lookup)).toBe(join(await realpath(root), "Docs", "notes.md"));
  });

  it("keeps each exact hard link's own name", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await writeFile(join(root, "notes.md"), "body");
    await link(join(root, "notes.md"), join(root, "backup.md"));
    for (const name of await readdir(root)) {
      expect(await diskSpelling(root, join(root, name))).toBe(join(await realpath(root), name));
    }
  });

  it("returns null for a missing entry", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    expect(await diskSpelling(root, join(root, "missing.md"))).toBeNull();
  });

  it("returns null when a symlink leaves the root", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const outside = await createTestScratch("dohc-disk-spelling-outside-");
    await writeFile(join(outside, "notes.md"), "outside");
    await symlink(outside, join(root, "escape"), "junction");
    expect(await diskSpelling(root, join(root, "escape", "notes.md"))).toBeNull();
  });

  it("resolves an in-root symlink before reading names", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "Docs"));
    await writeFile(join(root, "Docs", "notes.md"), "body");
    await symlink(join(root, "Docs"), join(root, "alias"), "junction");
    expect(await diskSpelling(root, join(root, "alias", "notes.md"))).toBe(join(await realpath(root), "Docs", "notes.md"));
  });
});
