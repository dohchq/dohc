import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake file system: paths that exist, and a write that fails while `failing` is set.
const disk = vi.hoisted(() => ({ paths: new Set<string>(), failing: false, noFolder: false }));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) { this.uri = `${typeof parent === "string" ? parent : parent.uri}/${name}`; }
    get exists() { return disk.paths.has(this.uri); }
    create() { if (disk.noFolder) throw new Error("No space left on device"); disk.paths.add(this.uri); }
    delete() { for (const path of [...disk.paths]) if (path.startsWith(this.uri)) disk.paths.delete(path); }
  }
  class File {
    readonly uri: string;
    constructor(parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; }
    get exists() { return disk.paths.has(this.uri); }
    async write() {
      if (disk.failing) { disk.paths.add(this.uri); throw new Error("No space left on device"); }
      disk.paths.add(this.uri);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

beforeEach(() => { disk.paths.clear(); disk.failing = false; disk.noFolder = false; vi.resetModules(); });

describe("a write that ran out of space", () => {
  it("is told apart from other failures by the system's message", async () => {
    const { isOutOfSpace } = await import("./editorFile");
    expect(isOutOfSpace(new Error("The file “page.js” couldn’t be saved because there isn’t enough space."))).toBe(true);
    expect(isOutOfSpace(new Error("No space left on device"))).toBe(true);
    expect(isOutOfSpace(new Error("The file “page.js” couldn’t be saved because you don’t have permission."))).toBe(false);
    expect(isOutOfSpace("unknown")).toBe(false);
  });
});

// A page whose editor files couldn't be written once must be able to try again, not wait forever.
describe("the editor files", () => {
  it("are written again after a write fails, and nothing half-written is kept", async () => {
    const { editorHtmlUri } = await import("./editorFile");
    disk.failing = true;
    await expect(editorHtmlUri()).rejects.toThrow("No space left on device");
    expect([...disk.paths]).toEqual([]);
    disk.failing = false;
    await expect(editorHtmlUri()).resolves.toMatch(/page\.html$/);
  });

  it("are written again when the cache was cleared after they were written", async () => {
    const { editorHtmlUri } = await import("./editorFile");
    await expect(editorHtmlUri()).resolves.toMatch(/page\.html$/);
    disk.paths.clear();
    await expect(editorHtmlUri()).resolves.toMatch(/page\.html$/);
    expect([...disk.paths].some(path => path.endsWith("page.js"))).toBe(true);
    for (const name of ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2", "inter-vietnamese-wght-normal.woff2"]) {
      expect([...disk.paths].some(path => path.endsWith(name)), name).toBe(true);
    }
  });

  it("are written again after the folder itself can't be made", async () => {
    const { editorHtmlUri } = await import("./editorFile");
    disk.noFolder = true;
    await expect(editorHtmlUri()).rejects.toThrow("No space left on device");
    disk.noFolder = false;
    await expect(editorHtmlUri()).resolves.toMatch(/page\.html$/);
  });
});

// The page body's typeface is the desktop's Inter: the same package's variable wght files, with its faces as the
// desktop declares them, for the Latin-script subsets only, so other scripts fall back to the system font.
describe("the page's typeface", () => {
  it("declares the desktop's Inter faces for the Latin-script subsets, and no others", async () => {
    const { pageFonts, pageHtml } = await import("../editorHtml.generated");
    const css = readFileSync(createRequire(import.meta.url).resolve("@fontsource-variable/inter/index.css"), "utf8");
    const range = (subset: string) => css.match(new RegExp(`/\\* inter-${subset}-wght-normal \\*/[^}]*unicode-range: ([^;]*);`))?.[1];
    expect(pageFonts.map(font => font.name)).toEqual(["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2", "inter-vietnamese-wght-normal.woff2"]);
    for (const subset of ["latin", "latin-ext", "vietnamese"]) {
      expect(pageHtml).toContain(`url(inter-${subset}-wght-normal.woff2)`);
      expect(pageHtml).toContain(`unicode-range: ${range(subset) ?? "missing"};`);
    }
    expect(pageHtml).not.toMatch(/inter-(cyrillic|greek)/);
    expect(pageHtml).toContain('font: 1rem/1.6 "Inter Variable", -apple-system');
  });
});
