import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonLaunch,
  beginLaunch,
  finishLaunch,
  grantCheckedRelaunch,
  openLaunchMarker,
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
  return { fs, read: (): unknown => { const content = files.get(PATH); return content === undefined ? undefined : JSON.parse(content); } };
}

const open = (fs: MarkerFileSystem, pass: string | null = null, version = "1.0.0") =>
  openLaunchMarker(PATH, version, pass, fs);

afterEach(() => {
  // Each test's launch ends here so the module holds no launch across tests.
  finishLaunch();
  vi.restoreAllMocks();
});

describe("launch marker", () => {
  it("counts launches in a row that never finished", () => {
    const disk = memoryFs();
    expect(open(disk.fs).unfinished).toBe(0);
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 1 });
    // The process died: nothing finished or handed off its launch.
    expect(open(disk.fs).unfinished).toBe(1);
    expect(open(disk.fs).unfinished).toBe(2);
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 3 });
  });

  it("removes the marker once a launch finishes", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 4 }));
    const launch = open(disk.fs);
    expect(launch.unfinished).toBe(4);
    launch.finish();
    expect(disk.read()).toBeUndefined();
    expect(open(disk.fs).unfinished).toBe(0);
  });

  it("takes back only its own count when it hands off to the running instance", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 1 }));
    const running = open(disk.fs);
    const second = open(disk.fs);
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 3 });
    second.handOff();
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 2 });
    running.finish();
    expect(disk.read()).toBeUndefined();
  });

  it("does not bring back a count the running instance removed before the hand-off", () => {
    // One unfinished launch, then A starts, B starts, A finishes, B loses the lock.
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 1 }));
    const a = open(disk.fs);
    const b = open(disk.fs);
    a.finish();
    b.handOff();
    expect(disk.read()).toBeUndefined();
    expect(open(disk.fs).unfinished).toBe(0);
  });

  it("lets one relaunch skip the check, once, and only with the pass it was given", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 2 }));
    const checking = open(disk.fs);
    const pass = checking.grantCheckedRelaunch();
    // The checking process never loaded main, so it does not count.
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 2, checked: pass });

    const forged = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 2, checked: pass }));
    expect(open(forged.fs, "made-up").checked).toBe(false);
    expect(open(forged.fs, null).checked).toBe(false);

    const relaunch = open(disk.fs, pass);
    expect(relaunch).toMatchObject({ unfinished: 2, checked: true });
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 3 });
    // A shortcut that keeps the same argument gets no second pass.
    expect(open(disk.fs, pass).checked).toBe(false);
  });

  it("starts another version from zero", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 5, checked: "pass" }));
    expect(open(disk.fs, "pass", "1.0.1")).toMatchObject({ unfinished: 0, checked: false });
    expect(disk.read()).toEqual({ version: "1.0.1", unfinished: 1 });
  });

  it.each(["not json", "null", "{}", JSON.stringify({ version: "1.0.0", unfinished: -2 }), JSON.stringify({ version: "1.0.0", unfinished: "3" })])(
    "treats an unreadable marker (%s) as no unfinished launches",
    (content) => {
      expect(open(memoryFs(content).fs).unfinished).toBe(0);
    },
  );

  it("never stops a launch when the profile cannot be written", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const disk = memoryFs();
    disk.fs.writeFileSync = () => { throw new Error("read-only profile"); };
    disk.fs.rmSync = () => { throw new Error("read-only profile"); };
    const launch = open(disk.fs);
    expect(launch.unfinished).toBe(0);
    launch.finish();
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it("keeps this process's launch for main to finish or hand off", () => {
    const disk = memoryFs();
    beginLaunch(PATH, "1.0.0", null, disk.fs);
    finishLaunch();
    expect(disk.read()).toBeUndefined();
    beginLaunch(PATH, "1.0.0", null, disk.fs);
    abandonLaunch();
    expect(disk.read()).toBeUndefined();
    beginLaunch(PATH, "1.0.0", null, disk.fs);
    expect(grantCheckedRelaunch()).toEqual(expect.any(String));
    // Granting ends this process's launch; nothing is left to finish.
    finishLaunch();
    expect(disk.read()).toMatchObject({ checked: expect.any(String) });
  });

  it("does nothing for main loaded without the entry module", () => {
    const disk = memoryFs(JSON.stringify({ version: "1.0.0", unfinished: 2 }));
    finishLaunch();
    abandonLaunch();
    expect(grantCheckedRelaunch()).toBeNull();
    expect(disk.read()).toEqual({ version: "1.0.0", unfinished: 2 });
  });
});
