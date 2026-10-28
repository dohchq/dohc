import * as fsPromises from "node:fs/promises";
import { link, lstat, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diskSpelling, lookAlikeSpelling, storedNameAmong } from "./diskSpelling";
import { storedEntryPath } from "./storedEntryPath";
import { createTestScratch } from "./testTemp";
import { forceStoredNameListing } from "../testing/storedNameListing";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));
afterEach(() => vi.restoreAllMocks());

it("covers exactly the non-ASCII characters that normalize to one ASCII character", () => {
  const derived = new Map<string, string>();
  for (let code = 0x80; code <= 0x10ffff; code++) {
    const character = String.fromCodePoint(code);
    for (const form of ["NFC", "NFD"] as const) {
      const normalized = character.normalize(form);
      if (normalized.length === 1 && normalized.charCodeAt(0) <= 0x7f) {
        derived.set(character, normalized);
      }
    }
  }
  const actual = new Map<string, string>();
  for (let code = 0; code <= 0x7f; code++) {
    const character = String.fromCodePoint(code);
    const spelling = lookAlikeSpelling(character);
    if (spelling !== character) actual.set(spelling, character);
  }
  expect(actual).toEqual(derived);
});

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
  it.each([
    ["1;2", "1\u037e2"],
    ["1`2", "1\u1fef2"],
    ["aK.md", "a\u212a.md"],
    ["2024.", "2024"],
    ["2024 ", "2024"],
  ])("lists the stored name when %s reaches %s", async (leaf, stored) => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const file = join(root, stored), lookup = join(root, leaf);
    await writeFile(file, "body");
    const original = fsPromises.lstat.bind(fsPromises);
    const swapped = join(root, leaf.replace(/[A-Za-z]/gu, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
    const lookupStat = vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
      if (swapped !== lookup && String(path) === swapped) return Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
      return original(String(path) === lookup ? file : path, options);
    });
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, lookup)).toBe(file);
    expect(listing).toHaveBeenCalledTimes(1);
    if (!/[. ]$/u.test(leaf)) {
      const probe = lookupStat.mock.calls.findIndex(([path]) => String(path) === file);
      expect(probe).toBeGreaterThanOrEqual(0);
      expect(lookupStat.mock.invocationCallOrder[probe]).toBeLessThan(listing.mock.invocationCallOrder[0]!);
    }
  });

  it.each(["1;2", "1`2", "Kickoff.md"])("does not list when case and normalization spellings of %s are absent", async leaf => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const file = join(root, leaf);
    await writeFile(file, "body");
    const alternate = lookAlikeSpelling(leaf);
    const swapped = leaf.replace(/[A-Za-z]/gu, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    const probes = [...new Set([swapped, alternate])].filter(name => name !== leaf).map(name => join(root, name));
    const original = fsPromises.lstat.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
      if (probes.includes(String(path))) return Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
      return original(path, options);
    });
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(listing).not.toHaveBeenCalled();
    expect(lookup.mock.calls.map(([path]) => String(path)).filter(path => probes.includes(path))).toEqual(probes);
  });

  it.each(["EACCES", "ENOTDIR", "EIO"])("lists when a look-alike probe fails with %s", async code => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const file = join(root, "Kickoff.md"), alternate = join(root, "\u212aickoff.md");
    await writeFile(file, "body");
    const original = fsPromises.lstat.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
      if (String(path) === join(root, "kICKOFF.MD")) return Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
      if (String(path) === alternate) return Promise.reject(Object.assign(new Error("unknown"), { code }));
      return original(path, options);
    });
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(lookup.mock.calls.map(([path]) => String(path))).toContain(alternate);
    expect(listing).toHaveBeenCalledTimes(1);
  });

  it("skips listings when every swapped ASCII name is absent", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    const file = join(root, "a", "b", "c", "target.md");
    await writeFile(file, "body");
    const swaps = [join(root, "A"), join(root, "a", "B"), join(root, "a", "b", "C"), join(root, "a", "b", "c", "TARGET.MD")];
    const original = fsPromises.lstat.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
      if (swaps.includes(String(path))) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return original(path, options);
    });
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(listing).not.toHaveBeenCalled();
    expect(lookup.mock.calls.map(([path]) => String(path)).filter(path => swaps.includes(path))).toEqual(swaps);
  });

  it.each(["café.md", "NOTES~1.MD"])("still lists a %s leaf after skipping a case-sensitive parent", async leaf => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "parent"));
    const file = join(root, "parent", leaf);
    await writeFile(file, "body");
    const original = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
      if (String(path) === join(root, "PARENT")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return original(path, options);
    });
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(listing.mock.calls.map(([path]) => String(path))).toEqual([join(root, "parent")]);
  });

  it("stops swap lookups after finding the first case-insensitive folder", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "a", "b"), { recursive: true });
    const file = join(root, "a", "b", "file.md");
    await writeFile(file, "body");
    const original = fsPromises.lstat.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => original(
      String(path) === join(root, "A") ? join(root, "a") : path, options));
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(lookup.mock.calls.map(([path]) => String(path)).filter(path => [join(root, "A"), join(root, "a", "B"), join(root, "a", "b", "FILE.MD")].includes(path))).toEqual([join(root, "A")]);
    expect(listing.mock.calls.map(([path]) => String(path))).toEqual([root, join(root, "a"), join(root, "a", "b")]);
  });

  it("keeps a printable ASCII leaf without letters without listing", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const file = join(root, "123-456");
    await writeFile(file, "body");
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(listing).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "ENOTDIR", "EIO"])("lists when a swapped lookup fails with %s", async code => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const file = join(root, "notes.md");
    await writeFile(file, "body");
    const original = fsPromises.lstat.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
      if (String(path) === join(root, "NOTES.MD")) throw Object.assign(new Error("unknown"), { code });
      return original(path, options);
    });
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(lookup.mock.calls.map(([path]) => String(path))).toContain(join(root, "NOTES.MD"));
    expect(listing).toHaveBeenCalledTimes(1);
  });

  it("does not list on a real disk that keeps case apart", async context => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await writeFile(join(root, "probe.md"), "body");
    if (await lstat(join(root, "PROBE.MD")).then(() => true, () => false)) context.skip("this disk ignores case");
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    const file = join(root, "a", "b", "c", "target.md");
    await writeFile(file, "body");
    const listing = vi.spyOn(fsPromises, "readdir");
    expect(await diskSpelling(root, file)).toBe(file);
    expect(listing).not.toHaveBeenCalled();
  });

  it.each([false, true])("names the relative entry when its stored identity is unavailable (missing=%s)", async missing => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "Docs"));
    const file = join(root, "Docs", "notes.md");
    await writeFile(file, "body");
    if (missing) {
      const original = fsPromises.lstat.bind(fsPromises);
      vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
        if (options?.bigint) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return original(path, options);
      });
    } else {
      forceStoredNameListing(join(root, "Docs"), file);
      vi.spyOn(fsPromises, "readdir").mockRejectedValue(Object.assign(new Error("unknown"), { code: "EIO" }));
    }
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      await expect(storedEntryPath(root, file)).rejects.toThrow("dohc could not tell which file or folder on disk Docs/notes.md is. Check it in your file manager before trying again.");
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it.each(["EIO", "EMFILE"])("throws when a folder listing fails with %s", async (code) => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await writeFile(join(root, "notes.md"), "body");
    const failure = Object.assign(new Error("listing unavailable"), { code });
    forceStoredNameListing(join(root, "notes.md"));
    vi.spyOn(fsPromises, "readdir").mockRejectedValue(failure);
    await expect(diskSpelling(root, join(root, "notes.md"))).rejects.toBe(failure);
  });

  it("refuses another hard link's unrelated leaf when the folder cannot be listed", async () => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "d"));
    await mkdir(join(root, "e"));
    const file = join(root, "d", "x.md");
    const otherLink = join(root, "e", "y.md");
    await writeFile(file, "shared");
    await link(file, otherLink);
    await writeFile(join(root, "d", "y.md"), "untracked");
    const originalRealpath = fsPromises.realpath.bind(fsPromises);
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    forceStoredNameListing(join(root, "d"), file);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => originalRealpath(String(path) === file ? otherLink : path));
    vi.spyOn(fsPromises, "readdir").mockImplementation((path, options) => {
      if (String(path) === join(root, "d")) throw Object.assign(new Error("listing denied"), { code: "EACCES" });
      return originalReaddir(path, options);
    });
    await expect(diskSpelling(root, file)).rejects.toThrow("Could not identify the stored name");
  });

  it.each(["EACCES", "EPERM"])("refuses an unlistable Linux folder (%s)", async code => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await writeFile(join(root, "notes.md"), "body");
    forceStoredNameListing(join(root, "notes.md"));
    const original = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async path => {
      const resolved = await original(path);
      return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
    });
    vi.spyOn(fsPromises, "readdir").mockRejectedValue(Object.assign(new Error("listing denied"), { code }));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      await expect(diskSpelling(root, join(root, "notes.md"))).rejects.toThrow("Could not identify the stored name");
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it.each(["win32", "darwin"])("keeps realpath's stored names in an unlistable folder on %s", async simulatedPlatform => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await mkdir(join(root, "Docs"));
    await writeFile(join(root, "Docs", "notes.md"), "body");
    const lookup = join(root, "docs", "Notes.md");
    const lookups = [lookup, join(root, "Docs", "Notes.md")];
    const expected = join(await realpath(root), "Docs", "notes.md");
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => originalLstat(lookups.includes(String(path)) ? expected : path, options));
    forceStoredNameListing(join(root, "Docs"), ...lookups);
    const originalRealpath = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(path => {
      if (lookups.includes(String(path))) return Promise.resolve(expected);
      return originalRealpath(String(path) === join(root, "docs") ? join(root, "Docs") : path);
    });
    vi.spyOn(fsPromises, "readdir").mockRejectedValue(Object.assign(new Error("listing denied"), { code: "EACCES" }));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: simulatedPlatform });
    try {
      expect(await diskSpelling(root, lookup)).toBe(expected);
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it.each(["EACCES", "EIO", "EMFILE"])("throws for an unknown lstat answer (%s)", async (code) => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const error = Object.assign(new Error("identity unavailable"), { code });
    vi.spyOn(fsPromises, "lstat").mockRejectedValue(error);
    await expect(diskSpelling(root, join(root, "notes.md"))).rejects.toBe(error);
  });

  it.each(["ENOENT", "ENOTDIR"])("distinguishes an absent parent from an unknown parent (%s)", async (code) => {
    const root = await createTestScratch("dohc-disk-spelling-");
    await writeFile(join(root, "notes.md"), "body");
    let parentErrorCode = "EIO";
    const original = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
      if (String(path) === join(root, "docs")) throw Object.assign(new Error("parent unavailable"), { code: parentErrorCode });
      return original(path);
    });
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => originalLstat(String(path) === join(root, "docs", "notes.md") ? join(root, "notes.md") : path, options));
    await expect(diskSpelling(root, join(root, "docs", "notes.md"))).rejects.toMatchObject({ code: "EIO" });
    parentErrorCode = code;
    await expect(diskSpelling(root, join(root, "docs", "notes.md"))).resolves.toBeNull();
  });

  it.each(["none", "two"])("throws when %s of the listed names identify the entry", async (matches) => {
    const root = await createTestScratch("dohc-disk-spelling-");
    const file = join(root, "notes.md");
    await writeFile(file, "body");
    await link(file, join(root, "first.md"));
    await link(file, join(root, "second.md"));
    forceStoredNameListing(file);
    vi.spyOn(fsPromises, "readdir").mockResolvedValue((matches === "two" ? ["first.md", "second.md"] : []) as never);
    await expect(diskSpelling(root, file)).rejects.toThrow();
  });

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
