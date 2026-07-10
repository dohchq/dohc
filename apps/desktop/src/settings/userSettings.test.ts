import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNNER_SETTINGS,
  DEFAULT_USER_SETTINGS,
  DesktopUserSettings,
  effectiveThemeMode,
  mergeDesktopUserSettings,
  parseDesktopUserSettings,
  userSettingsModified,
} from "./userSettings";
import {
  MAX_USER_SETTINGS_FILE_BYTES,
  readCachedUserSettingsFile,
  readUserSettingsFile,
  USER_SETTINGS_FILE,
  writeUserSettingsFile,
} from "./userSettingsStore";

const roots: string[] = [];
// WSL can expose the Windows temp directory under /mnt, which is slower and
// more permission-sensitive for symlink tests; use the Linux temp dir there.
const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tempBase, "dohc-user-settings-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop user settings model", () => {
  it("falls back to defaults for missing, foreign, or future shapes", () => {
    expect(parseDesktopUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseDesktopUserSettings({ version: 2 })).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseDesktopUserSettings({ version: 1, token: "secret" })).toEqual(
      DEFAULT_USER_SETTINGS,
    );
  });

  it("merges patches without dropping sibling sections", () => {
    const next = mergeDesktopUserSettings(DEFAULT_USER_SETTINGS, {
      appearance: { themeMode: "dark", density: "compact", reduceMotion: true },
    });
    expect(next.appearance).toEqual({
      themeMode: "dark",
      density: "compact",
      reduceMotion: true,
    });
    expect(next.editor).toEqual(DEFAULT_USER_SETTINGS.editor);
    expect(userSettingsModified(next)).toBe(true);
    expect(userSettingsModified(DEFAULT_USER_SETTINGS)).toBe(false);
  });

  it("adds runner defaults to settings written before runner support", () => {
    const legacySettings = {
      version: DEFAULT_USER_SETTINGS.version,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
      general: DEFAULT_USER_SETTINGS.general,
      editor: DEFAULT_USER_SETTINGS.editor,
      notifications: DEFAULT_USER_SETTINGS.notifications,
    };

    expect(parseDesktopUserSettings(legacySettings)).toEqual({
      ...legacySettings,
      runner: DEFAULT_RUNNER_SETTINGS,
    });
  });

  it("merges runner fields independently and validates timeout bounds", () => {
    const next = mergeDesktopUserSettings(DEFAULT_USER_SETTINGS, {
      runner: { command: "codex exec", enabled: true },
    });

    expect(next.runner).toEqual({
      command: "codex exec",
      enabled: true,
      timeoutMinutes: 30,
    });
    expect(next.appearance).toEqual(DEFAULT_USER_SETTINGS.appearance);
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

  it("resolves system theme from the OS preference", () => {
    expect(effectiveThemeMode("system", true)).toBe("dark");
    expect(effectiveThemeMode("system", false)).toBe("light");
    expect(effectiveThemeMode("light", true)).toBe("light");
    expect(effectiveThemeMode("dark", false)).toBe("dark");
  });
});

describe("desktop user settings store", () => {
  it("round-trips pretty JSON through the user settings file", async () => {
    const root = await tempRoot();
    const settings = mergeDesktopUserSettings(DEFAULT_USER_SETTINGS, {
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
    });
    await writeUserSettingsFile(root, settings);
    expect(await readUserSettingsFile(root)).toEqual({
      settings,
      source: "stored",
    });
    const raw = await readFile(join(root, USER_SETTINGS_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("caches reads until the settings writer invalidates them", async () => {
    const root = await tempRoot();
    const first = mergeDesktopUserSettings(DEFAULT_USER_SETTINGS, {
      appearance: { themeMode: "dark" },
    });
    const second = mergeDesktopUserSettings(DEFAULT_USER_SETTINGS, {
      appearance: { themeMode: "light" },
    });
    await writeUserSettingsFile(root, first);
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(first);

    await writeFile(
      join(root, USER_SETTINGS_FILE),
      `${JSON.stringify(second)}\n`,
    );
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(first);

    await writeUserSettingsFile(root, second);
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(second);
  });

  it("a missing file reads as defaults", async () => {
    expect(await readUserSettingsFile(await tempRoot())).toEqual({
      settings: DEFAULT_USER_SETTINGS,
      source: "default",
    });
  });

  it("hydrates runner defaults when reading a legacy version-one file", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, USER_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        appearance: {
          ...DEFAULT_USER_SETTINGS.appearance,
          themeMode: "dark",
        },
        general: DEFAULT_USER_SETTINGS.general,
        editor: DEFAULT_USER_SETTINGS.editor,
        notifications: DEFAULT_USER_SETTINGS.notifications,
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
    const corrupt = await tempRoot();
    await writeFile(join(corrupt, USER_SETTINGS_FILE), "{not json");
    expect(await readUserSettingsFile(corrupt)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });

    const future = await tempRoot();
    await writeFile(join(future, USER_SETTINGS_FILE), JSON.stringify({ version: 2 }));
    expect(await readUserSettingsFile(future)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });

    const huge = await tempRoot();
    await writeFile(
      join(huge, USER_SETTINGS_FILE),
      JSON.stringify({ padding: "x".repeat(MAX_USER_SETTINGS_FILE_BYTES) }),
    );
    expect(await readUserSettingsFile(huge)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });
  });

  it("refuses to read a symlinked user settings file", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    const outsideSettings = join(outside, USER_SETTINGS_FILE);
    await writeFile(
      outsideSettings,
      JSON.stringify(
        mergeDesktopUserSettings(DEFAULT_USER_SETTINGS, {
          appearance: { themeMode: "dark" },
        }),
      ),
    );
    await unlink(join(root, USER_SETTINGS_FILE));
    await symlink(outsideSettings, join(root, USER_SETTINGS_FILE));

    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });
  });
});
