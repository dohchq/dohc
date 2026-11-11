import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { nameApp } from "./appName";

// Electron's own lookup (shell/common/electron_paths.cc): unless a run sets
// the folder, userData is the app data folder joined with the app's name,
// which Electron reads from package.json before main runs.
function electronApp(appData: string, join: (...parts: string[]) => string, userDataDir?: string) {
  const overridden = new Map<string, string>(userDataDir ? [["userData", userDataDir]] : []);
  return {
    name: "@dohc/desktop",
    getPath(name: "userData") {
      return overridden.get(name) ?? join(appData, this.name);
    },
    setPath(name: string, path: string) {
      overridden.set(name, path);
    },
  };
}

describe("nameApp", () => {
  it.each([
    ["Windows", "C:\\Users\\ana\\AppData\\Roaming", win32.join, "C:\\Users\\ana\\AppData\\Roaming\\@dohc\\desktop"],
    ["macOS", "/Users/ana/Library/Application Support", posix.join, "/Users/ana/Library/Application Support/@dohc/desktop"],
    ["Linux", "/home/ana/.config", posix.join, "/home/ana/.config/@dohc/desktop"],
  ])("names the app dohc and keeps the settings folder on %s", (_platform, appData, join, folder) => {
    const app = electronApp(appData, join);
    nameApp(app);
    expect(app.name).toBe("dohc");
    expect(app.getPath("userData")).toBe(folder);
  });

  it("keeps a folder the run chose", () => {
    const app = electronApp("/home/ana/.config", posix.join, "/tmp/e2e/electron-user-data");
    nameApp(app);
    expect(app.getPath("userData")).toBe("/tmp/e2e/electron-user-data");
  });
});
