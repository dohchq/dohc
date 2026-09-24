import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNNER_SETTINGS,
  DEFAULT_USER_SETTINGS,
  DesktopUserSettings,
  RunnerSettings,
  clampZoomLevel,
  effectiveThemeMode,
  zoomPercent,
} from "./userSettings";
import {
  ensureUserSettingsFile,
  MAX_USER_SETTINGS_FILE_BYTES,
  readCachedUserSettingsFile,
  readUserSettingsFile,
  reloadUserSettingsFile,
  replaceUserSettingsFile,
  USER_SETTINGS_FILE,
  writeUserSettingsFile,
} from "./userSettingsStore";

import { createTestScratch } from "../workspaces/testTemp";
// WSL can expose the Windows temp directory under /mnt, which is slower and
// more permission-sensitive for symlink tests; use the Linux temp dir there.
const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();

describe("desktop user settings model", () => {
  it("rejects missing, foreign, or future shapes", () => {
    expect(DesktopUserSettings.safeParse(null).success).toBe(false);
    expect(DesktopUserSettings.safeParse({ version: 2 }).success).toBe(false);
    expect(
      DesktopUserSettings.safeParse({ version: 1, token: "secret" }).success,
    ).toBe(false);
  });

  it("rejects removed sections instead of keeping a dual schema", () => {
    for (const removed of [
      { general: { launchBehavior: "recent" } },
      { notifications: { updates: true, agentRuns: true } },
    ]) {
      const obsolete = {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
        ...removed,
      };
      expect(DesktopUserSettings.safeParse(obsolete).success).toBe(false);
    }
  });

  it("adds runner defaults to settings written before runner support", () => {
    const legacySettings = {
      version: DEFAULT_USER_SETTINGS.version,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
      editor: DEFAULT_USER_SETTINGS.editor,
    };

    expect(DesktopUserSettings.parse(legacySettings)).toEqual({
      ...legacySettings,
      profile: {},
      runner: DEFAULT_RUNNER_SETTINGS,
    });
  });

  it("adds the default zoom level to settings written before zoom support", () => {
    const legacySettings = {
      version: DEFAULT_USER_SETTINGS.version,
      profile: {},
      appearance: {
        themeMode: "dark" as const,
      },
      editor: DEFAULT_USER_SETTINGS.editor,
      runner: DEFAULT_RUNNER_SETTINGS,
    };

    // The stored appearance choices survive; only the new field fills in.
    expect(DesktopUserSettings.parse(legacySettings).appearance).toEqual({
      themeMode: "dark",
      zoomLevel: 0,
    });

    for (const zoomLevel of [-6, 6, 0.5, Number.NaN]) {
      expect(
        DesktopUserSettings.safeParse({
          ...DEFAULT_USER_SETTINGS,
          appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel },
        }).success,
        String(zoomLevel),
      ).toBe(false);
    }
  });

  it("clamps zoom levels and maps them to 20%-per-step percentages", () => {
    expect(clampZoomLevel(99)).toBe(5);
    expect(clampZoomLevel(-99)).toBe(-5);
    expect(clampZoomLevel(Number.NaN)).toBe(0);
    expect(zoomPercent(0)).toBe(100);
    expect(zoomPercent(1)).toBe(120);
    expect(zoomPercent(-1)).toBe(83);
  });

  it("migrates preferred-name support into old v1 settings and validates names", () => {
    const legacy = {
      version: 1 as const,
      appearance: DEFAULT_USER_SETTINGS.appearance,
      editor: DEFAULT_USER_SETTINGS.editor,
      runner: DEFAULT_RUNNER_SETTINGS,
    };
    expect(DesktopUserSettings.parse(legacy).profile).toEqual({});

    const named = DesktopUserSettings.parse({
      ...DEFAULT_USER_SETTINGS,
      profile: { preferredName: "  Sam Rivera  " },
    });
    expect(named.profile.preferredName).toBe("Sam Rivera");
    expect(
      DesktopUserSettings.safeParse({
        ...DEFAULT_USER_SETTINGS,
        profile: { preferredName: "Sam\u0000Admin" },
      }).success,
    ).toBe(false);

    const tooLong = DesktopUserSettings.safeParse({
      ...DEFAULT_USER_SETTINGS,
      profile: { preferredName: "x".repeat(81) },
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues[0]?.message).toBe(
        "Names must contain 80 characters or fewer.",
      );
    }
  });

  it("requires and validates the agent name when dispatch is enabled", () => {
    const runner = { command: "node agent.mjs", enabled: true, timeoutMinutes: 30 };
    for (const agentName of [undefined, "", "x".repeat(81), "Bad\u0000name"]) {
      expect(DesktopUserSettings.safeParse({ ...DEFAULT_USER_SETTINGS, profile: { agentName }, runner }).success).toBe(false);
    }
    expect(DesktopUserSettings.parse({ ...DEFAULT_USER_SETTINGS, profile: { agentName: "  Nova  " }, runner }).profile.agentName).toBe("Nova");
  });

  it("validates runner timeout bounds", () => {
    const next = {
      ...DEFAULT_USER_SETTINGS,
      runner: { command: "codex exec", enabled: true, timeoutMinutes: 30 },
    };
    expect(
      DesktopUserSettings.safeParse({
        ...next,
        runner: { ...next.runner, timeoutMinutes: 0 },
      }).success,
    ).toBe(false);
    expect(
      DesktopUserSettings.safeParse({
        ...next,
        runner: { ...next.runner, timeoutMinutes: 1441 },
      }).success,
    ).toBe(false);
  });

  it("requires a non-empty command whenever the runner is enabled", () => {
    for (const command of ["", "   \t\n"]) {
      expect(
        RunnerSettings.safeParse({
          command,
          enabled: true,
          timeoutMinutes: 30,
        }).success,
      ).toBe(false);
    }
    expect(
      RunnerSettings.safeParse({
        command: "   ",
        enabled: false,
        timeoutMinutes: 30,
      }).success,
    ).toBe(true);
    expect(() =>
      DesktopUserSettings.parse({
        ...DEFAULT_USER_SETTINGS,
        runner: { ...DEFAULT_RUNNER_SETTINGS, enabled: true },
      }),
    ).toThrow("Runner command is required when dispatch is enabled.");
  });

  it("resolves system theme from the OS preference", () => {
    expect(effectiveThemeMode("system", true)).toBe("dark");
    expect(effectiveThemeMode("system", false)).toBe("light");
    expect(effectiveThemeMode("light", true)).toBe("light");
    expect(effectiveThemeMode("dark", false)).toBe("dark");
  });
});

describe("desktop user settings store", () => {
  it("round-trips pretty JSON through the user settings file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
    };
    await replaceUserSettingsFile(root, settings);
    expect(await readUserSettingsFile(root)).toEqual({
      settings,
      source: "stored",
    });
    const raw = await readFile(join(root, USER_SETTINGS_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("caches reads until the settings writer invalidates them", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const first = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
    };
    const second = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "light" as const },
    };
    await replaceUserSettingsFile(root, first);
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(first);

    await writeFile(
      join(root, USER_SETTINGS_FILE),
      `${JSON.stringify(second)}\n`,
    );
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(first);

    await writeUserSettingsFile(root, second, first);
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(second);
  });

  it("a missing file reads as defaults", async () => {
    expect(await readUserSettingsFile(await createTestScratch("dohc-user-settings-"))).toEqual({
      settings: DEFAULT_USER_SETTINGS,
      source: "default",
    });
  });

  it("hydrates runner defaults when reading a legacy version-one file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    await writeFile(
      join(root, USER_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        appearance: {
          ...DEFAULT_USER_SETTINGS.appearance,
          themeMode: "dark",
        },
        editor: DEFAULT_USER_SETTINGS.editor,
      }),
    );

    expect(await readUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: {
          ...DEFAULT_USER_SETTINGS.appearance,
          themeMode: "dark",
        },
        runner: DEFAULT_RUNNER_SETTINGS,
      },
      source: "stored",
    });
  });

  it("corrupt, unsupported, and oversized files recover to defaults", async () => {
    const corrupt = await createTestScratch("dohc-user-settings-");
    await writeFile(join(corrupt, USER_SETTINGS_FILE), "{not json");
    expect(await readUserSettingsFile(corrupt)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });

    const future = await createTestScratch("dohc-user-settings-");
    await writeFile(join(future, USER_SETTINGS_FILE), JSON.stringify({ version: 2 }));
    expect(await readUserSettingsFile(future)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });

    const huge = await createTestScratch("dohc-user-settings-");
    await writeFile(
      join(huge, USER_SETTINGS_FILE),
      JSON.stringify({ padding: "x".repeat(MAX_USER_SETTINGS_FILE_BYTES) }),
    );
    expect(await readUserSettingsFile(huge)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });
  });

  it("turns off only an unknown key or a key with a value dohc cannot use", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    await writeFile(
      join(root, USER_SETTINGS_FILE),
      JSON.stringify({
        appearance: { themeMode: "dark", zoomLevel: 9 },
        editor: { fontSize: 18, lineWrap: "yes" },
        accentColor: "teal",
      }),
    );
    expect(await readUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { themeMode: "dark", zoomLevel: 0 },
        editor: { ...DEFAULT_USER_SETTINGS.editor, fontSize: 18 },
      },
      source: "stored",
      ignored: [
        { key: "appearance.zoomLevel", reason: "invalid" },
        { key: "editor.lineWrap", reason: "invalid" },
        { key: "accentColor", reason: "unknown" },
      ],
    });
  });

  it("keeps keys that depend on each other in any order, and turns off the switch they cannot support", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    // Dispatch needs a command and an agent name, which come after it here.
    await writeFile(path, JSON.stringify({
      runner: { enabled: true, timeoutMinutes: 5, command: "agent run" },
      profile: { agentName: "Nova" },
    }));
    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: { runner: { enabled: true, command: "agent run", timeoutMinutes: 5 } },
      source: "stored",
    });
    await writeFile(path, JSON.stringify({ runner: { enabled: true, command: "agent run" } }));
    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: { runner: { enabled: false, command: "agent run" } },
      ignored: [{ key: "runner.enabled", reason: "invalid" }],
    });
  });

  it("saves only what changed, so keys dohc does not use stay in the file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await writeFile(path, JSON.stringify({
      appearance: { themeMode: "dark" },
      editor: { fontSize: 99 },
      accentColor: "teal",
    }));
    const current = await readUserSettingsFile(root);
    const saved = await writeUserSettingsFile(root, {
      ...current.settings,
      appearance: { ...current.settings.appearance, zoomLevel: 2 },
    }, current.settings);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      appearance: { themeMode: "dark", zoomLevel: 2 },
      editor: { fontSize: 99 },
      accentColor: "teal",
    });
    expect(saved).toEqual({
      settings: { ...current.settings, appearance: { themeMode: "dark", zoomLevel: 2 } },
      source: "stored",
      ignored: [
        { key: "editor.fontSize", reason: "invalid" },
        { key: "accentColor", reason: "unknown" },
      ],
    });
    // Changing the setting dohc could not use replaces the bad value.
    await writeUserSettingsFile(root, {
      ...saved.settings,
      editor: { ...saved.settings.editor, fontSize: 16 },
    }, saved.settings);
    expect(JSON.parse(await readFile(path, "utf8")).editor).toEqual({ fontSize: 16 });
  });

  it("keeps an edit made in the file after the caller read it", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    const seen = (await readUserSettingsFile(root)).settings;
    // The person switches to dark in the file before Settings hears of it.
    await writeFile(path, JSON.stringify({
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
    }));
    const saved = await writeUserSettingsFile(root, {
      ...seen,
      appearance: { ...seen.appearance, zoomLevel: 1 },
    }, seen);
    expect(saved.settings.appearance).toEqual({ themeMode: "dark", zoomLevel: 1 });
  });

  it("refuses to save over a file dohc cannot use, and reset replaces it", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await writeFile(path, "{ \"appearance\": ");
    await expect(writeUserSettingsFile(root, DEFAULT_USER_SETTINGS, DEFAULT_USER_SETTINGS)).rejects.toThrow(
      `dohc did not save settings. dohc could not use ${path}: it is not valid JSON. Fix the file, or select Reset user in Advanced to replace it.`,
    );
    expect(await readFile(path, "utf8")).toBe("{ \"appearance\": ");
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    expect(await readUserSettingsFile(root)).toEqual({
      settings: DEFAULT_USER_SETTINGS,
      source: "stored",
    });
  });

  it("reloads a changed file, ignores dohc's own save, and keeps the last settings while the file does not parse", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    const dark = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
    };
    await writeUserSettingsFile(root, dark, DEFAULT_USER_SETTINGS);
    expect(await reloadUserSettingsFile(root)).toBeNull();

    await writeFile(path, JSON.stringify({ appearance: { themeMode: "light" } }));
    expect(await reloadUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "light" },
      },
      source: "stored",
    });
    expect(await reloadUserSettingsFile(root)).toBeNull();

    // Half an edit: the light theme stays, and the warning names the file.
    await writeFile(path, "{ \"appearance\": { \"themeMode\": \"da");
    const broken = await reloadUserSettingsFile(root);
    expect(broken).toMatchObject({
      settings: { appearance: { themeMode: "light" } },
      source: "recovered",
      warning: expect.stringContaining(path),
    });
    expect(await readCachedUserSettingsFile(root)).toEqual(broken);

    await writeFile(path, JSON.stringify(dark));
    expect(await reloadUserSettingsFile(root)).toEqual({ settings: dark, source: "stored" });
  });

  it("creates the settings file with the defaults only when there is none", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = await ensureUserSettingsFile(root);
    expect(path).toBe(join(root, USER_SETTINGS_FILE));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DEFAULT_USER_SETTINGS);
    expect(await reloadUserSettingsFile(root)).toBeNull();
    await writeFile(path, "{}");
    await ensureUserSettingsFile(root);
    expect(await readFile(path, "utf8")).toBe("{}");
  });

  it("refuses to read a symlinked user settings file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const outside = await createTestScratch("dohc-user-settings-");
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    const outsideSettings = join(outside, USER_SETTINGS_FILE);
    await writeFile(
      outsideSettings,
      JSON.stringify({
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
      }),
    );
    await unlink(join(root, USER_SETTINGS_FILE));
    await symlink(outsideSettings, join(root, USER_SETTINGS_FILE));

    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });
  });
});
