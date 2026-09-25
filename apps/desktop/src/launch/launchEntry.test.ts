import { describe, expect, it, vi } from "vitest";
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
} = {}) {
  const log: string[] = [];
  const dependencies = {
    argv: options.argv ?? ["dohc.exe"],
    markerPath: options.markerPath === undefined ? "/profile/dohc-launch.json" : options.markerPath,
    beginLaunch: vi.fn((_path: string, checkedPass: string | null) => {
      log.push("count");
      return { unfinished: options.unfinished ?? 0, checked: checkedPass !== null && checkedPass === options.pass };
    }),
    loadMain: vi.fn(options.loadMain ?? (async () => { log.push("main"); })),
    reportFailure: vi.fn((_error: unknown) => { log.push("report"); }),
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
  it.each([0, 1])("counts the launch, then loads main with %i unfinished launches before it", async (unfinished) => {
    const f = fixture({ unfinished });
    const { recovery } = await f.run();
    expect(recovery).toBeNull();
    expect(f.log).toEqual(["count", "main"]);
    expect(f.dependencies.beginLaunch).toHaveBeenCalledWith("/profile/dohc-launch.json", null);
  });

  it("checks for a newer build instead of loading main after two unfinished launches", async () => {
    const f = fixture({ unfinished: 2 });
    const { recovery } = await f.run();
    await recovery;
    expect(f.dependencies.loadMain).not.toHaveBeenCalled();
    // Nothing found: this build opens again, without checking twice.
    expect(f.log).toEqual(["count", "check:unfinished-launch", "relaunch"]);
  });

  it("leaves the exit to the check when it restarts into an update or quits", async () => {
    const f = fixture({ unfinished: 3, handled: true });
    await (await f.run()).recovery;
    expect(f.log).toEqual(["count", "check:unfinished-launch"]);
  });

  it("relaunches when the check itself fails", async () => {
    const f = fixture({ unfinished: 2, handled: new Error("updater broke") });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await (await f.run()).recovery;
      expect(f.log).toEqual(["count", "check:unfinished-launch", "relaunch"]);
    } finally { logged.mockRestore(); }
  });

  it("loads main on the relaunch after a check, still counting the launch", async () => {
    const f = fixture({ unfinished: 2, pass: "pass-1", argv: ["dohc.exe", `${LAUNCH_CHECKED_FLAG}=pass-1`] });
    const { recovery } = await f.run();
    expect(recovery).toBeNull();
    expect(f.log).toEqual(["count", "main"]);
    expect(f.dependencies.beginLaunch).toHaveBeenCalledWith("/profile/dohc-launch.json", "pass-1");
  });

  it.each([
    ["the bare flag", [LAUNCH_CHECKED_FLAG]],
    ["a pass the marker does not hold", [`${LAUNCH_CHECKED_FLAG}=old-pass`]],
  ])("still checks when a launcher carries %s", async (_name, flags) => {
    const f = fixture({ unfinished: 2, pass: "pass-1", argv: ["dohc.exe", ...flags] });
    await (await f.run()).recovery;
    expect(f.dependencies.loadMain).not.toHaveBeenCalled();
    expect(f.log).toEqual(["count", "check:unfinished-launch", "relaunch"]);
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
    expect(f.log).toEqual(["count", "report", "check:startup", "quit"]);
  });

  it("does not quit a failed load when the check restarts into an update", async () => {
    const f = fixture({ loadMain: async () => { throw new Error("bad module"); }, handled: true });
    await (await f.run()).recovery;
    expect(f.log).toEqual(["count", "report", "check:startup"]);
  });

  it("keeps no marker for a build without an updater, but still checks a failed load", async () => {
    const f = fixture({ markerPath: null, unfinished: 5, loadMain: async () => { throw new Error("bad module"); } });
    await (await f.run()).recovery;
    expect(f.dependencies.beginLaunch).not.toHaveBeenCalled();
    expect(f.log).toEqual(["report", "check:startup", "quit"]);
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
