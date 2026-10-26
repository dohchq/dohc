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
    expect(args).toContain("--dohc-isolated-test");
  });

  // Two concurrent runs must not share a user data dir: that directory is what
  // Electron keys its single-instance lock on, so a shared one makes the second
  // app quit at launch.
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

  it("places a test's own switches before the entry", () => {
    const args = electronLaunchArgs({
      mainEntry: MAIN,
      userDataDir: "/tmp/dohc/electron-user-data",
      switches: ["--disable-gpu"],
      platform: "linux",
    });
    expect(args).toContain("--disable-gpu");
    expect(args.at(-1)).toBe(MAIN);
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

  it("gives Chromium a fake keychain on a Mac only", () => {
    const launch = (platform: NodeJS.Platform) => electronLaunchArgs({ mainEntry: MAIN, userDataDir: "/tmp/dohc/electron-user-data", platform });
    expect(launch("darwin")).toContain("--use-mock-keychain");
    expect(launch("darwin").at(-1)).toBe(MAIN);
    expect(launch("linux")).not.toContain("--use-mock-keychain");
    expect(launch("win32")).not.toContain("--use-mock-keychain");
  });
});
