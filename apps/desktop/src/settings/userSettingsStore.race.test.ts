import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { DEFAULT_USER_SETTINGS } from "./userSettings";
import {
  readUserSettingsFile,
  reloadUserSettingsFile,
  USER_SETTINGS_FILE,
  writeUserSettingsFile,
} from "./userSettingsStore";

// A seam in the save: runs once dohc has written its temporary file and before
// it replaces the settings file, which is where an editor's save can land.
const race = vi.hoisted(() => ({ beforeReplace: null as (() => Promise<void>) | null, renameLocked: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      const hook = race.beforeReplace;
      if (hook && !race.renameLocked && String(args[0]).includes(".tmp-")) {
        race.beforeReplace = null;
        await hook();
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (race.renameLocked) {
        race.renameLocked = false;
        const hook = race.beforeReplace;
        race.beforeReplace = null;
        await hook?.();
        throw Object.assign(new Error("destination temporarily locked"), { code: "EPERM" });
      }
      await actual.rename(...args);
    },
  };
});

describe("a save while the settings file changes", () => {
  it.each(["temp write", "rename retry"])("merges onto the edit that landed during %s instead of replacing it", async (stage) => {
    const root = await createTestScratch("dohc-user-settings-race-");
    const path = join(root, USER_SETTINGS_FILE);
    await writeFile(path, JSON.stringify({ appearance: { themeMode: "light" } }));
    const seen = (await readUserSettingsFile(root)).settings;

    race.beforeReplace = () => writeFile(path, JSON.stringify({
      appearance: { themeMode: "dark" },
      profile: { preferredName: "Ada" },
      wallpaper: "teal",
    }));
    race.renameLocked = stage === "rename retry";
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    let saved;
    try {
      saved = await writeUserSettingsFile(root, {
        ...seen,
        appearance: { ...seen.appearance, zoomLevel: 2 },
      }, seen);
    } finally {
      race.renameLocked = false;
      race.beforeReplace = null;
      Object.defineProperty(process, "platform", descriptor);
    }

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 2,
      appearance: { themeMode: "dark", zoomLevel: 2 },
      profile: { preferredName: "Ada" },
      wallpaper: "teal",
    });
    expect(saved).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        profile: { preferredName: "Ada" },
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark", zoomLevel: 2 },
      },
      source: "stored",
      ignored: [{ key: "wallpaper", reason: "unknown" }],
    });
    // What the save answered is what is on disk, so the watcher finds nothing
    // left to apply.
    expect(await reloadUserSettingsFile(root)).toBeNull();
  });
});
