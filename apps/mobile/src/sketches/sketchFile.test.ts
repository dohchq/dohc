import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ paths: new Set<string>(), failing: false, noFolder: false }));

vi.mock("./sketchAssets.generated", () => ({
  sketchVersion: "testver",
  sketchAssets: [
    { target: "sketch.html", module: 101 },
    { target: "sketch.js", module: 102 },
    { target: "fonts/Excalifont-Regular.woff2", module: 103 },
  ],
}));

vi.mock("expo-asset", () => ({
  Asset: {
    fromModule: (mod: number) => ({
      uri: `bundle://asset-${mod}`,
      localUri: `bundle://asset-${mod}`,
      downloadAsync: async () => undefined,
    }),
  },
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = `${typeof parent === "string" ? parent : parent.uri}/${name}`;
    }
    get exists() {
      return disk.paths.has(this.uri);
    }
    create() {
      if (disk.noFolder) throw new Error("No space left on device");
      disk.paths.add(this.uri);
    }
    delete() {
      for (const path of [...disk.paths]) if (path.startsWith(this.uri)) disk.paths.delete(path);
    }
  }
  class File {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri =
        name === undefined
          ? String(parent)
          : `${typeof parent === "string" ? parent : parent.uri}/${name}`;
    }
    get exists() {
      return disk.paths.has(this.uri);
    }
    async copy(destination: File) {
      if (disk.failing) {
        disk.paths.add(destination.uri);
        throw new Error("No space left on device");
      }
      disk.paths.add(destination.uri);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

beforeEach(() => {
  disk.paths.clear();
  disk.failing = false;
  disk.noFolder = false;
  vi.resetModules();
});

describe("sketch static native asset loader", () => {
  it("copies static Excalidraw assets on demand into cache and cleans up on out-of-space", async () => {
    const { sketchHtmlUri } = await import("./sketchFile");
    disk.failing = true;
    await expect(sketchHtmlUri()).rejects.toThrow("No space left on device");
    expect([...disk.paths]).toEqual([]);

    disk.failing = false;
    await expect(sketchHtmlUri()).resolves.toBe("cache/sketch-testver/sketch.html");
    expect(disk.paths.has("cache/sketch-testver/sketch.js")).toBe(true);
    expect(disk.paths.has("cache/sketch-testver/fonts/Excalifont-Regular.woff2")).toBe(true);
  });

  it("re-populates static assets if the OS clears the cache directory", async () => {
    const { sketchHtmlUri } = await import("./sketchFile");
    await expect(sketchHtmlUri()).resolves.toBe("cache/sketch-testver/sketch.html");
    disk.paths.clear();
    await expect(sketchHtmlUri()).resolves.toBe("cache/sketch-testver/sketch.html");
    expect(disk.paths.has("cache/sketch-testver/sketch.js")).toBe(true);
  });

  it("never inlines Excalidraw JS/CSS/fonts into the generated Hermes module", () => {
    const manifestPath = resolve(import.meta.dirname, "sketchAssets.generated.ts");
    if (!existsSync(manifestPath)) return;
    const text = readFileSync(manifestPath, "utf8");
    expect(text.length).toBeLessThan(8_192);
    expect(text).toContain("require(");
    expect(text).not.toContain("data:font");
    expect(text).not.toContain("data:application");
  });
});
