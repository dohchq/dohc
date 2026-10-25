import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { join, resolve } from "node:path";
import {
  AgentId, AgentsSettings, DEFAULT_USER_SETTINGS, type AgentColors, type AgentProblem,
  StoredUserSettings,
  settingsDeepEqual,
  type StoredUserSettingsResult,
} from "./userSettings";
import { migrateVersion1 } from "./userSettingsMigration";
import {
  isSettingsObject,
  overlaySettings,
  readSettingsLeniently,
  settingKinds,
} from "./settingsFile";

export const USER_SETTINGS_FILE = "dohc-settings.json";
export const MAX_USER_SETTINGS_FILE_BYTES = 256 * 1024;

const schemaSettingKinds = settingKinds(StoredUserSettings, DEFAULT_USER_SETTINGS);
const userSettingKinds: typeof schemaSettingKinds = path =>
  path.length === 2 && path[0] === "appearance" && path[1] === "agentColors" ? "group" : schemaSettingKinds(path);

function parseUserSettings(candidate: unknown): StoredUserSettings | null {
  const parsed = StoredUserSettings.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// What the file held when dohc last read or wrote it. Its text and problem
// say whether the file changed since, so dohc's own save does not come back
// through the watcher as a second change.
interface UserSettingsSnapshot {
  text: string | null;
  problem: string | null;
  raw: Record<string, unknown> | null;
  result: StoredUserSettingsResult;
}

const snapshots = new Map<string, Promise<UserSettingsSnapshot>>();
const presentationColors = new Map<string, AgentColors | undefined>();
function rememberColors(root: string, snapshot: UserSettingsSnapshot): UserSettingsSnapshot {
  presentationColors.set(root, snapshot.result.settings.appearance.agentColors);
  return snapshot;
}

// A request reads once, then resolves against the current settings after its awaits.
export async function agentColorsForPresentation(dir: string): Promise<() => AgentColors | undefined> {
  const root = resolve(dir);
  await snapshotFor(root);
  return () => presentationColors.get(root);
}

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

// Why dohc could not use an agent entry, so Settings can still show it.
function agentProblem(id: string, entry: unknown): string {
  const badId = AgentId.safeParse(id);
  if (!badId.success) return badId.error.issues[0]!.message;
  const alone = AgentsSettings.safeParse({ [id]: entry });
  if (alone.success) return "Another agent has this name.";
  const issue = alone.error.issues[0]!;
  const where = issue.path.slice(1).join(".");
  return where ? `${where}: ${issue.message}` : issue.message;
}

function agentProblems(raw: Record<string, unknown>, settings: StoredUserSettings): AgentProblem[] {
  if (!isSettingsObject(raw.agents)) return [];
  return Object.entries(raw.agents).filter(([id]) => !Object.hasOwn(settings.agents, id)).slice(0, 50).map(([id, entry]) => {
    const name = isSettingsObject(entry) && typeof entry.name === "string" ? entry.name.trim().slice(0, 200) : "";
    return { id: id.slice(0, 200), ...(name ? { name } : {}), problem: agentProblem(id, entry).slice(0, 500) };
  });
}

function snapshotOfText(path: string, text: string): UserSettingsSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unusable(path, text, "it is not valid JSON");
  }
  if (!isSettingsObject(parsed)) return unusable(path, text, "it is not a JSON object");
  // The first save writes the migrated file.
  const raw = parsed.version === 1 ? migrateVersion1(parsed) : parsed;
  // Another version is a format this build cannot read, not one bad key.
  if (raw.version !== undefined && raw.version !== DEFAULT_USER_SETTINGS.version) {
    return unusable(path, text, `its version is not ${DEFAULT_USER_SETTINGS.version}`);
  }
  const { settings, ignored } = readSettingsLeniently({
    raw,
    defaults: DEFAULT_USER_SETTINGS,
    kind: userSettingKinds,
    parse: parseUserSettings,
    reportIgnored: path => !(path[0] === "appearance" && path[1] === "agentColors"),
  });
  const problems = agentProblems(raw, settings);
  return {
    text,
    problem: null,
    raw,
    result: {
      settings, source: "stored",
      ...(ignored.length > 0 ? { ignored } : {}),
      ...(problems.length > 0 ? { agentProblems: problems } : {}),
    },
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
  const read = loadUserSettings(settingsPath(root)).then(snapshot => {
    if (snapshots.get(root) === read) rememberColors(root, snapshot);
    return snapshot;
  });
  snapshots.set(root, read);
  return read;
}

export async function readUserSettingsFile(
  dir: string,
): Promise<StoredUserSettingsResult> {
  return (await loadUserSettings(settingsPath(resolve(dir)))).result;
}

export async function readCachedUserSettingsFile(
  dir: string,
): Promise<StoredUserSettingsResult> {
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
): Promise<StoredUserSettingsResult>;
async function commitUserSettings(
  root: string,
  content: Record<string, unknown>,
  expected: { text: string | null },
): Promise<StoredUserSettingsResult | null>;
async function commitUserSettings(
  root: string,
  content: Record<string, unknown>,
  expected?: { text: string | null },
): Promise<StoredUserSettingsResult | null> {
  await mkdir(root, { recursive: true });
  const path = settingsPath(root);
  const text = `${JSON.stringify(content, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_USER_SETTINGS_FILE_BYTES) {
    throw new Error("dohc did not save settings because the file would exceed 256 KB. Clear some settings and try again.");
  }
  const snapshot = snapshotOfText(path, text);
  const conflict = Symbol("settings changed");
  try {
    await atomicReplaceFile(path, (tmp) => writeFile(tmp, text), {
      rename: async (source, destination) => {
        if (expected && (await textOnDisk(path)) !== expected.text) throw conflict;
        await rename(source, destination);
      },
    });
    snapshots.set(root, Promise.resolve(rememberColors(root, snapshot)));
    return snapshot.result;
  } catch (error) {
    if (error === conflict) return null;
    throw error;
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
  change: (current: StoredUserSettings) => StoredUserSettings,
): Promise<StoredUserSettingsResult> {
  const root = resolve(dir);
  const path = settingsPath(root);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const onDisk = await loadUserSettings(path);
    if (onDisk.problem !== null) {
      throw new Error(`dohc did not save settings. ${onDisk.result.warning}`);
    }
    const current = onDisk.result.settings;
    const next = StoredUserSettings.parse(change(current));
    if (settingsDeepEqual(next, current)) {
      snapshots.set(root, Promise.resolve(rememberColors(root, onDisk)));
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
  settings: StoredUserSettings,
  base: StoredUserSettings,
): Promise<StoredUserSettingsResult> {
  const next = StoredUserSettings.parse(settings);
  return updateUserSettingsFile(dir, (current) =>
    StoredUserSettings.parse(overlaySettings(current, base, next)));
}

/** Replaces the whole file. Reset user settings is the one caller. */
export async function replaceUserSettingsFile(
  dir: string,
  settings: StoredUserSettings,
): Promise<StoredUserSettingsResult> {
  return commitUserSettings(resolve(dir), StoredUserSettings.parse(settings));
}

/**
 * Writes the defaults when there is no settings file yet, so there is a file
 * to open. An existing file, readable or not, is never touched.
 */
export async function ensureUserSettingsFile(dir: string): Promise<string> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const path = settingsPath(root);
  // Leave every existing entry alone, including a dangling link: Windows
  // "wx" can follow one and put the defaults at its target.
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry !== null) return path;
  const text = `${JSON.stringify(DEFAULT_USER_SETTINGS, null, 2)}\n`;
  try {
    await writeFile(path, text, { flag: "wx" });
    snapshots.set(root, Promise.resolve(rememberColors(root, snapshotOfText(path, text))));
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
): Promise<StoredUserSettingsResult | null> {
  const root = resolve(dir);
  const previous = await snapshots.get(root);
  const loaded = await loadUserSettings(settingsPath(root));
  if (previous && previous.text === loaded.text && previous.problem === loaded.problem) {
    return null;
  }
  const snapshot = previous && loaded.problem !== null
    ? { ...loaded, result: { ...loaded.result, settings: previous.result.settings } }
    : loaded;
  snapshots.set(root, Promise.resolve(rememberColors(root, snapshot)));
  return snapshot.result;
}
