import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonLaunch,
  beginLaunch,
  finishLaunch,
  type MarkerFileSystem,
} from "./launchMarker";

const PATH = "/profile/dohc-launch.json";

function memoryFs(initial?: string) {
  const files = new Map<string, string>(initial === undefined ? [] : [[PATH, initial]]);
  const fs: MarkerFileSystem = {
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return content;
    },
    writeFileSync: (path, data) => { files.set(path, data); },
    rmSync: (path) => { files.delete(path); },
  };
  return { fs, read: () => files.get(PATH) };
}

afterEach(() => {
  // Each test's launch ends here so the module holds no launch across tests.
  finishLaunch();
  vi.restoreAllMocks();
});

describe("launch marker", () => {
  it("counts launches in a row that never finished", () => {
    const disk = memoryFs();
    expect(beginLaunch(PATH, "1.0.0", disk.fs)).toBe(0);
    expect(JSON.parse(disk.read()!)).toEqual({ version: "1.0.0", unfinished: 1 });
    // The process died: nothing finished or abandoned it.
    expect(beginLaunch(PATH, "1.0.0", disk.fs)).toBe(1);
    expect(beginLaunch(PATH, "1.0.0", disk.fs)).toBe(2);
    expect(JSON.parse(disk.read()!)).toEqual({ version: "1.0.0", unfinished: 3 });
  });

  it("removes the marker once a launch finishes", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 4 }));
    expect(beginLaunch(PATH, "1.0.0", disk.fs)).toBe(4);
    finishLaunch();
    expect(disk.read()).toBeUndefined();
    expect(beginLaunch(PATH, "1.0.0", disk.fs)).toBe(0);
  });

  it("puts the count back when a launch hands off to the running instance", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 1 }));
    beginLaunch(PATH, "1.0.0", disk.fs);
    abandonLaunch();
    expect(JSON.parse(disk.read()!)).toEqual({ version: "1.0.0", unfinished: 1 });
    const clean = memoryFs();
    beginLaunch(PATH, "1.0.0", clean.fs);
    abandonLaunch();
    expect(clean.read()).toBeUndefined();
  });

  it("starts another version from zero", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 5 }));
    expect(beginLaunch(PATH, "1.0.1", disk.fs)).toBe(0);
    expect(JSON.parse(disk.read()!)).toEqual({ version: "1.0.1", unfinished: 1 });
  });

  it.each(["not json", "null", "{}", JSON.stringify({ version: "1.0.0", unfinished: -2 }), JSON.stringify({ version: "1.0.0", unfinished: "3" })])(
    "treats an unreadable marker (%s) as no unfinished launches",
    (content) => {
      expect(beginLaunch(PATH, "1.0.0", memoryFs(content).fs)).toBe(0);
    },
  );

  it("never stops a launch when the profile cannot be written", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const disk = memoryFs();
    disk.fs.writeFileSync = () => { throw new Error("read-only profile"); };
    disk.fs.rmSync = () => { throw new Error("read-only profile"); };
    expect(beginLaunch(PATH, "1.0.0", disk.fs)).toBe(0);
    finishLaunch();
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it("does nothing for main loaded without the entry module", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 2 }));
    finishLaunch();
    abandonLaunch();
    expect(JSON.parse(disk.read()!)).toEqual({ version: "1.0.0", unfinished: 2 });
  });
});
