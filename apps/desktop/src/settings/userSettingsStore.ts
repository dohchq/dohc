import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_USER_SETTINGS,
  DesktopUserSettings,
  DesktopUserSettingsResult,
} from "./userSettings";

export const USER_SETTINGS_FILE = "dohc-settings.json";
export const MAX_USER_SETTINGS_FILE_BYTES = 256 * 1024;

const cachedSettingsReads = new Map<
  string,
  Promise<DesktopUserSettingsResult>
>();

export async function readUserSettingsFile(
  dir: string,
): Promise<DesktopUserSettingsResult> {
  const path = join(dir, USER_SETTINGS_FILE);
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      return {
        settings: DEFAULT_USER_SETTINGS,
        source: "recovered",
        warning: "User settings were not a regular file and were ignored.",
      };
    }
    if (fileStats.size > MAX_USER_SETTINGS_FILE_BYTES) {
      return {
        settings: DEFAULT_USER_SETTINGS,
        source: "recovered",
        warning: "User settings were too large and were ignored.",
      };
    }
    const raw = JSON.parse(await readFile(path, "utf8"));
    const parsed = DesktopUserSettings.safeParse(raw);
    if (!parsed.success) {
      return {
        settings: DEFAULT_USER_SETTINGS,
        source: "recovered",
        warning: "User settings used an unsupported shape and were ignored.",
      };
    }
    return { settings: parsed.data, source: "stored" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: DEFAULT_USER_SETTINGS, source: "default" };
    }
    return {
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
      warning: "User settings could not be read and were reset to defaults.",
    };
  }
}

export function readCachedUserSettingsFile(
  dir: string,
): Promise<DesktopUserSettingsResult> {
  const root = resolve(dir);
  const existing = cachedSettingsReads.get(root);
  if (existing) return existing;
  const read = readUserSettingsFile(root);
  cachedSettingsReads.set(root, read);
  return read;
}

export async function writeUserSettingsFile(
  dir: string,
  settings: DesktopUserSettings,
): Promise<void> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const path = join(root, USER_SETTINGS_FILE);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(DesktopUserSettings.parse(settings), null, 2)}\n`);
    await rename(tmp, path);
    cachedSettingsReads.delete(root);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
