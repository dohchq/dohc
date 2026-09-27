import { describe, expect, it, vi } from "vitest";
import { openLaunchMarker, type MarkerFileSystem } from "./launchMarker";
import {
  checkedPassFrom,
  checkedRelaunchArguments,
  LAUNCH_CHECKED_FLAG,
  runLaunchEntry,
  type LaunchFailure,
} from "./launchEntry";

function fixture(options: {
  unfinished?: number;
  // The pass in the marker; a launch carrying it skips the check.
  pass?: string;
  markerPath?: string | null;
  argv?: string[];
  loadMain?: () => Promise<unknown>;
  handled?: boolean | Error;
  lock?: boolean;
} = {}) {
  const log: string[] = [];
  const dependencies = {
    argv: options.argv ?? ["dohc.exe"],
    acquireLock: vi.fn(() => { log.push("lock"); return options.lock ?? true; }),
    markerPath: options.markerPath === undefined ? "/profile/dohc-launch.json" : options.markerPath,
    beginLaunch: vi.fn((_path: string, checkedPass: string | null) => {
      log.push("count");
      return { unfinished: options.unfinished ?? 0, checked: checkedPass !== null && checkedPass === options.pass };
    }),
    loadMain: vi.fn(options.loadMain ?? (async () => { log.push("main"); })),
    reportFailure: vi.fn(async (_error: unknown) => { log.push("report"); }),
    checkForUpdate: vi.fn(async (failure: LaunchFailure) => {
      log.push(`check:${failure}`);
      if (options.handled instanceof Error) throw options.handled;
      return options.handled ?? false;
    }),
    quit: vi.fn(() => { log.push("quit"); }),
    relaunchChecked: vi.fn(() => { log.push("relaunch"); }),
  };
  return { log, dependencies, run: () => runLaunchEntry(dependencies) };
}

describe("launch entry", () => {
  it("hands a second launch to the running instance before it reads the marker", async () => {
    const f = fixture({ lock: false, unfinished: 5 });
    const { recovery } = await f.run();
    expect(recovery).toBeNull();
    expect(f.log).toEqual(["lock", "quit"]);
    expect(f.dependencies.beginLaunch).not.toHaveBeenCalled();
    expect(f.dependencies.loadMain).not.toHaveBeenCalled();
  });

  it("never lets a second launch touch the marker, whatever the running instance does meanwhile", async () => {
    const files = new Map<string, string>([["/m", JSON.stringify({ version: "1.0.0", unfinished: 2 })]]);
    const disk: MarkerFileSystem = {
      readFileSync: (path) => { const content = files.get(path); if (content === undefined) throw new Error("missing"); return content; },
      writeFileSync: (path, data) => { files.set(path, data); },
      rmSync: (path) => { files.delete(path); },
    };
    const marker = () => JSON.parse(files.get("/m") ?? "null") as unknown;
    let holder: string | null = null;
    let pass = "";
    const launch = (name: string, options: {
      argv?: string[];
      duringCheck?: () => Promise<void>;
      afterLoad?: (finish: () => void) => Promise<void>;
    } = {}) => {
      let record: ReturnType<typeof openLaunchMarker> | null = null;
      return runLaunchEntry({
        argv: options.argv ?? ["dohc.exe"], markerPath: "/m",
        acquireLock: () => (holder === null || holder === name ? ((holder = name), true) : false),
        beginLaunch: (path, checkedPass) => (record = openLaunchMarker(path, "1.0.0", checkedPass, disk)),
        loadMain: async () => { await options.afterLoad?.(() => record?.finish()); },
        reportFailure: vi.fn(async () => undefined),
        checkForUpdate: async () => { await options.duringCheck?.(); return false; },
        quit: vi.fn(),
        relaunchChecked: () => { pass = record!.grantCheckedRelaunch(); holder = null; },
      }).then(({ recovery }) => recovery);
    };

    // A checks after two unfinished launches. B starts while A checks and
    // again after A wrote its relaunch pass. B reads and writes nothing.
    await launch("A", { duringCheck: async () => {
      await launch("B");
      expect(marker()).toEqual({ version: "1.0.0", unfinished: 3 });
    } });
    expect(marker()).toEqual({ version: "1.0.0", unfinished: 2, checked: pass });
    holder = "A";
    await launch("B");
    expect(marker()).toEqual({ version: "1.0.0", unfinished: 2, checked: pass });

    // A's relaunch uses its pass, loads main, and finishes; B still changes nothing.
    holder = null;
    await launch("A2", { argv: ["dohc.exe", `${LAUNCH_CHECKED_FLAG}=${pass}`], afterLoad: async (finish) => {
      expect(marker()).toEqual({ version: "1.0.0", unfinished: 3 });
      finish();
      await launch("B");
    } });
    expect(files.has("/m")).toBe(false);
  });


  it.each([0, 1])("counts the launch, then loads main with %i unfinished launches before it", async (unfinished) => {
    const f = fixture({ unfinished });
    const { recovery } = await f.run();
    expect(recovery).toBeNull();
    expect(f.log).toEqual(["lock", "count", "main"]);
    expect(f.dependencies.beginLaunch).toHaveBeenCalledWith("/profile/dohc-launch.json", null);
  });

  it("checks for a newer build instead of loading main after two unfinished launches", async () => {
    const f = fixture({ unfinished: 2 });
    const { recovery } = await f.run();
    await recovery;
    expect(f.dependencies.loadMain).not.toHaveBeenCalled();
    // Nothing found: this build opens again, without checking twice.
    expect(f.log).toEqual(["lock", "count", "check:unfinished-launch", "relaunch"]);
  });

  it("leaves the exit to the check when it restarts into an update or quits", async () => {
    const f = fixture({ unfinished: 3, handled: true });
    await (await f.run()).recovery;
    expect(f.log).toEqual(["lock", "count", "check:unfinished-launch"]);
  });

  it("relaunches when the check itself fails", async () => {
    const f = fixture({ unfinished: 2, handled: new Error("updater broke") });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await (await f.run()).recovery;
      expect(f.log).toEqual(["lock", "count", "check:unfinished-launch", "relaunch"]);
    } finally { logged.mockRestore(); }
  });

  it("loads main on the relaunch after a check, still counting the launch", async () => {
    const f = fixture({ unfinished: 2, pass: "pass-1", argv: ["dohc.exe", `${LAUNCH_CHECKED_FLAG}=pass-1`] });
    const { recovery } = await f.run();
    expect(recovery).toBeNull();
    expect(f.log).toEqual(["lock", "count", "main"]);
    expect(f.dependencies.beginLaunch).toHaveBeenCalledWith("/profile/dohc-launch.json", "pass-1");
  });

  it.each([
    ["the bare flag", [LAUNCH_CHECKED_FLAG]],
    ["a pass the marker does not hold", [`${LAUNCH_CHECKED_FLAG}=old-pass`]],
  ])("still checks when a launcher carries %s", async (_name, flags) => {
    const f = fixture({ unfinished: 2, pass: "pass-1", argv: ["dohc.exe", ...flags] });
    await (await f.run()).recovery;
    expect(f.dependencies.loadMain).not.toHaveBeenCalled();
    expect(f.log).toEqual(["lock", "count", "check:unfinished-launch", "relaunch"]);
  });

  it("relaunches with this launch's arguments and only the new pass", () => {
    expect(checkedPassFrom(["dohc.exe", "--open-workspace=/w", `${LAUNCH_CHECKED_FLAG}=abc`])).toBe("abc");
    expect(checkedPassFrom(["dohc.exe", LAUNCH_CHECKED_FLAG, `${LAUNCH_CHECKED_FLAG}=`])).toBeNull();
    expect(checkedRelaunchArguments(
      ["dohc.exe", "--open-workspace=/w", LAUNCH_CHECKED_FLAG, `${LAUNCH_CHECKED_FLAG}=old`],
      "new",
    )).toEqual(["--open-workspace=/w", `${LAUNCH_CHECKED_FLAG}=new`]);
  });

  it("reports a main module that fails to load, checks for a newer build, then quits", async () => {
    const failure = new Error("Cannot find module './main-abc.js'");
    const f = fixture({ loadMain: async () => { throw failure; } });
    const { recovery } = await f.run();
    await recovery;
    expect(f.dependencies.reportFailure).toHaveBeenCalledWith(failure);
    expect(f.log).toEqual(["lock", "count", "report", "check:startup", "quit"]);
  });

  it("does not quit a failed load when the check restarts into an update", async () => {
    const f = fixture({ loadMain: async () => { throw new Error("bad module"); }, handled: true });
    await (await f.run()).recovery;
    expect(f.log).toEqual(["lock", "count", "report", "check:startup"]);
  });

  it("keeps no marker for a build without an updater, but still checks a failed load", async () => {
    const f = fixture({ markerPath: null, unfinished: 5, loadMain: async () => { throw new Error("bad module"); } });
    await (await f.run()).recovery;
    expect(f.dependencies.beginLaunch).not.toHaveBeenCalled();
    expect(f.log).toEqual(["lock", "report", "check:startup", "quit"]);
  });

  it("returns before the check finishes, so Electron can become ready", async () => {
    const f = fixture({ unfinished: 2 });
    let finish: (handled: boolean) => void = () => undefined;
    f.dependencies.checkForUpdate.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { recovery } = await f.run();
    expect(f.dependencies.relaunchChecked).not.toHaveBeenCalled();
    finish(false);
    await recovery;
    expect(f.dependencies.relaunchChecked).toHaveBeenCalledOnce();
  });
});
