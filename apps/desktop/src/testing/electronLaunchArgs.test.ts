import { describe, expect, it } from "vitest";
import { electronLaunchArgs } from "./electronLaunchArgs";

const MAIN = "C:/repo/apps/desktop/dist/main/main.js";

describe("electronLaunchArgs", () => {
  it("points Electron at the run's own user data dir", () => {
    const args = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "C:/temp/dohc-desktop-e2e-ab12/electron-user-data",
      platform: "win32",
    });
    expect(args).toContain(
      "--user-data-dir=C:/temp/dohc-desktop-e2e-ab12/electron-user-data",
    );
  });

  // Two concurrent runs must not share a user data dir: that directory is what
  // Electron keys its single-instance lock on, so a shared one makes the second
  // app quit at launch (#530).
  it("gives two runs different user data dirs", () => {
    const first = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "/tmp/dohc-desktop-e2e-aaa/electron-user-data",
      platform: "linux",
    });
    const second = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "/tmp/dohc-desktop-e2e-bbb/electron-user-data",
      platform: "linux",
    });
    const dirOf = (args: string[]) =>
      args.find((arg) => arg.startsWith("--user-data-dir="));
    expect(dirOf(first)).toBeDefined();
    expect(dirOf(first)).not.toBe(dirOf(second));
  });

  it("keeps the app entry last so Electron still runs it", () => {
    const args = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "/tmp/dohc/electron-user-data",
      platform: "linux",
    });
    expect(args.at(-1)).toBe(MAIN);
    expect(args.filter((arg) => !arg.startsWith("--"))).toEqual([MAIN]);
  });

  it("keeps --no-sandbox on linux only", () => {
    const linux = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "/tmp/dohc/electron-user-data",
      platform: "linux",
    });
    const windows = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "C:/temp/dohc/electron-user-data",
      platform: "win32",
    });
    expect(linux).toContain("--no-sandbox");
    expect(windows).not.toContain("--no-sandbox");
  });
});
