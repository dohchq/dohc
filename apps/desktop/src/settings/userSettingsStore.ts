import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_USER_SETTINGS,
  DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "./userSettings";
import {
  isSettingsObject,
  overlaySettings,
  readSettingsLeniently,
  settingKinds,
} from "./settingsFile";

export const USER_SETTINGS_FILE = "dohc-settings.json";
export const MAX_USER_SETTINGS_FILE_BYTES = 256 * 1024;

const userSettingKinds = settingKinds(DesktopUserSettings, DEFAULT_USER_SETTINGS);

function parseUserSettings(candidate: unknown): DesktopUserSettings | null {
  const parsed = DesktopUserSettings.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// What the file held when dohc last read or wrote it. Its text and problem
// say whether the file changed since, so dohc's own save does not come back
// through the watcher as a second change.
interface UserSettingsSnapshot {
  text: string | null;
  problem: string | null;
  raw: Record<string, unknown> | null;
  result: DesktopUserSettingsResult;
}

const snapshots = new Map<string, Promise<UserSettingsSnapshot>>();

function unusable(
  path: string,
  text: string | null,
  problem: string,
): UserSettingsSnapshot {
  return {
    text,
    problem,
    raw: null,
    result: {
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
      warning: `dohc could not use ${path}: ${problem}. Fix the file, or select Reset user in Advanced to replace it.`,
    },
  };
}

function snapshotOfText(path: string, text: string): UserSettingsSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unusable(path, text, "it is not valid JSON");
  }
  if (!isSettingsObject(raw)) return unusable(path, text, "it is not a JSON object");
  // Another version is a format this build cannot read, not one bad key.
  if (raw.version !== undefined && raw.version !== DEFAULT_USER_SETTINGS.version) {
    return unusable(path, text, `its version is not ${DEFAULT_USER_SETTINGS.version}`);
  }
  const { settings, ignored } = readSettingsLeniently({
    raw,
    defaults: DEFAULT_USER_SETTINGS,
    kind: userSettingKinds,
    parse: parseUserSettings,
  });
  return {
    text,
    problem: null,
    raw,
    result: { settings, source: "stored", ...(ignored.length > 0 ? { ignored } : {}) },
  };
}

async function loadUserSettings(path: string): Promise<UserSettingsSnapshot> {
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      return unusable(path, null, "it is not a regular file");
    }
    if (fileStats.size > MAX_USER_SETTINGS_FILE_BYTES) {
      return unusable(path, null, "it is larger than 256 KB");
    }
    return snapshotOfText(path, await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        text: null,
        problem: null,
        raw: null,
        result: { settings: DEFAULT_USER_SETTINGS, source: "default" },
      };
    }
    return unusable(path, null, "reading it failed");
  }
}

function settingsPath(root: string): string {
  return join(root, USER_SETTINGS_FILE);
}

function snapshotFor(root: string): Promise<UserSettingsSnapshot> {
  const existing = snapshots.get(root);
  if (existing) return existing;
  const read = loadUserSettings(settingsPath(root));
  snapshots.set(root, read);
  return read;
}

export async function readUserSettingsFile(
  dir: string,
): Promise<DesktopUserSettingsResult> {
  return (await loadUserSettings(settingsPath(resolve(dir)))).result;
}

export async function readCachedUserSettingsFile(
  dir: string,
): Promise<DesktopUserSettingsResult> {
  return (await snapshotFor(resolve(dir))).result;
}

async function commitUserSettings(
  root: string,
  content: Record<string, unknown>,
): Promise<DesktopUserSettingsResult> {
  await mkdir(root, { recursive: true });
  const path = settingsPath(root);
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const snapshot = snapshotOfText(path, text);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
    snapshots.set(root, Promise.resolve(snapshot));
    return snapshot.result;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Saves a change into the file as it is now. Only the settings that differ
 * between `base`, what the caller changed, and `settings` are written. An
 * edit made in the file since the caller read it stays, and so do keys dohc
 * does not know and values it could not use. A file dohc cannot use is
 * refused rather than replaced: it may be a person's edit in progress.
 */
export async function writeUserSettingsFile(
  dir: string,
  settings: DesktopUserSettings,
  base: DesktopUserSettings,
): Promise<DesktopUserSettingsResult> {
  const root = resolve(dir);
  const next = DesktopUserSettings.parse(settings);
  const onDisk = await loadUserSettings(settingsPath(root));
  if (onDisk.problem !== null) {
    throw new Error(`dohc did not save settings. ${onDisk.result.warning}`);
  }
  return commitUserSettings(root, overlaySettings(onDisk.raw ?? onDisk.result.settings, base, next));
}

/** Replaces the whole file. Reset user settings is the one caller. */
export async function replaceUserSettingsFile(
  dir: string,
  settings: DesktopUserSettings,
): Promise<DesktopUserSettingsResult> {
  return commitUserSettings(resolve(dir), DesktopUserSettings.parse(settings));
}

/**
 * Writes the defaults when there is no settings file yet, so there is a file
 * to open. An existing file, readable or not, is never touched.
 */
export async function ensureUserSettingsFile(dir: string): Promise<string> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const path = settingsPath(root);
  const text = `${JSON.stringify(DEFAULT_USER_SETTINGS, null, 2)}\n`;
  try {
    await writeFile(path, text, { flag: "wx" });
    snapshots.set(root, Promise.resolve(snapshotOfText(path, text)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return path;
}

/**
 * Reads the file again after it changed on disk. Answers null when it holds
 * what dohc last read or wrote. A file that stops parsing, often an edit in
 * progress, keeps the settings dohc last read, so the window does not jump
 * to the defaults and back while the person types.
 */
export async function reloadUserSettingsFile(
  dir: string,
): Promise<DesktopUserSettingsResult | null> {
  const root = resolve(dir);
  const previous = await snapshots.get(root);
  const loaded = await loadUserSettings(settingsPath(root));
  if (previous && previous.text === loaded.text && previous.problem === loaded.problem) {
    return null;
  }
  const snapshot = previous && loaded.problem !== null
    ? { ...loaded, result: { ...loaded.result, settings: previous.result.settings } }
    : loaded;
  snapshots.set(root, Promise.resolve(snapshot));
  return snapshot.result;
}
