import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_USER_SETTINGS,
  DesktopUserSettings,
  settingsDeepEqual,
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

async function textOnDisk(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes `content` over the file. With `expected`, the file must still hold
 * that text just before the rename; otherwise nothing is written and the
 * answer is null, so the caller can merge onto what the file holds now.
 */
async function commitUserSettings(
  root: string,
  content: Record<string, unknown>,
): Promise<DesktopUserSettingsResult>;
async function commitUserSettings(
  root: string,
  content: Record<string, unknown>,
  expected: { text: string | null },
): Promise<DesktopUserSettingsResult | null>;
async function commitUserSettings(
  root: string,
  content: Record<string, unknown>,
  expected?: { text: string | null },
): Promise<DesktopUserSettingsResult | null> {
  await mkdir(root, { recursive: true });
  const path = settingsPath(root);
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const snapshot = snapshotOfText(path, text);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, text);
    if (expected && (await textOnDisk(path)) !== expected.text) return null;
    await rename(tmp, path);
    snapshots.set(root, Promise.resolve(snapshot));
    return snapshot.result;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

// An editor that saves over and over can outrun a merge; dohc stops rather
// than write over an edit it did not read.
const SAVE_ATTEMPTS = 5;

/**
 * Saves a change into the file as it is now. `change` gets the settings the
 * file holds and answers the settings to save. Only the settings that differ
 * are written, so keys dohc does not know, and values it could not use and
 * did not change, stay as the person wrote them. When the file changes
 * during the save, the change is merged again onto the new file. A file dohc
 * cannot use is refused rather than replaced: it may be an edit in progress.
 */
export async function updateUserSettingsFile(
  dir: string,
  change: (current: DesktopUserSettings) => DesktopUserSettings,
): Promise<DesktopUserSettingsResult> {
  const root = resolve(dir);
  const path = settingsPath(root);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const onDisk = await loadUserSettings(path);
    if (onDisk.problem !== null) {
      throw new Error(`dohc did not save settings. ${onDisk.result.warning}`);
    }
    const current = onDisk.result.settings;
    const next = DesktopUserSettings.parse(change(current));
    if (settingsDeepEqual(next, current)) {
      snapshots.set(root, Promise.resolve(onDisk));
      return onDisk.result;
    }
    const saved = await commitUserSettings(
      root,
      overlaySettings(onDisk.raw ?? current, current, next),
      { text: onDisk.text },
    );
    if (saved) return saved;
  }
  throw new Error(`dohc did not save settings because ${path} kept changing. Try again.`);
}

/**
 * Saves the settings a caller changed from `base`. Only that difference is
 * written onto the file as it is now, so an edit made in the file after the
 * caller read it stays.
 */
export function writeUserSettingsFile(
  dir: string,
  settings: DesktopUserSettings,
  base: DesktopUserSettings,
): Promise<DesktopUserSettingsResult> {
  const next = DesktopUserSettings.parse(settings);
  return updateUserSettingsFile(dir, (current) =>
    DesktopUserSettings.parse(overlaySettings(current, base, next)));
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
