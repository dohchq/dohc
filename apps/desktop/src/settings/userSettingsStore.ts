import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { AGENT_ID_TAKEN_ERROR } from "../ipc/errorWords";
import { join, resolve } from "node:path";
import { hasPreferredNameControlCharacters } from "@dohc/workspace-contracts/chat-identity-values";
import { AGENT_HUES } from "../renderer/tokens";
import {
  agentProblem, DEFAULT_USER_SETTINGS, type AgentColors, type AgentProblem,
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
// An agent starts from a tool or a command, never from parts of both.
const agentLaunch = (path: readonly string[]) => path.length === 3 && path[0] === "agents" && path[2] === "launch";

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

function agentProblems(raw: Record<string, unknown>, settings: StoredUserSettings): AgentProblem[] {
  if (!isSettingsObject(raw.agents)) return [];
  return Object.entries(raw.agents).flatMap(([id, entry], position) => {
    if (Object.hasOwn(settings.agents, id)) return [];
    const fields = isSettingsObject(entry) ? entry : {};
    // A name Settings can show, or none, so the row shows the id.
    const name = typeof fields.name === "string" && !hasPreferredNameControlCharacters(fields.name) ? fields.name.trim().slice(0, 200) : "";
    const hue = AGENT_HUES.find((value) => value === fields.hue);
    return [{ id: id.slice(0, 200), ...(name ? { name } : {}), ...(hue ? { hue } : {}), position, problem: agentProblem(id, entry).slice(0, 500) }];
  }).slice(0, 50);
}

function snapshotOfText(path: string, text: string): UserSettingsSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unusable(path, text, "it is not valid JSON");
  }
  if (!isSettingsObject(parsed)) return unusable(path, text, "it is not a JSON object");
  // The first save writes the migrated file. Version 1 read a file without a
  // version as its own, and migrating one without its keys changes nothing.
  const raw = parsed.version === 1 || parsed.version === undefined ? migrateVersion1(parsed) : parsed;
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
 * So is a change to an agent entry dohc could not use.
 */
export async function updateUserSettingsFile(
  dir: string,
  change: (current: StoredUserSettings) => Record<string, unknown>,
): Promise<StoredUserSettingsResult> {
  const root = resolve(dir);
  const path = settingsPath(root);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const onDisk = await loadUserSettings(path);
    if (onDisk.problem !== null) {
      throw new Error(`dohc did not save settings. ${onDisk.result.warning}`);
    }
    const current = onDisk.result.settings;
    const changed = change(current);
    // `current` leaves out the agents dohc could not use, so one in the
    // change would be written over what the person wrote there.
    const fileAgents = onDisk.raw?.agents;
    const changedIds = Object.keys(isSettingsObject(changed.agents) ? changed.agents : {});
    if (fileAgents !== undefined && !isSettingsObject(fileAgents) && changedIds.length > 0) {
      throw new Error(`dohc did not save settings. ${path} has an "agents" value dohc can't use. Fix or remove it in the file, then try again.`);
    }
    const replaced = changedIds.find((id) => isSettingsObject(fileAgents) && Object.hasOwn(fileAgents, id) && !Object.hasOwn(current.agents, id));
    if (replaced !== undefined) {
      throw new Error(`dohc did not save settings. ${path} has an agent "${replaced}" that dohc can't use. Fix or remove it in the file, then try again.`);
    }
    const next = StoredUserSettings.parse(changed);
    if (settingsDeepEqual(next, current)) {
      snapshots.set(root, Promise.resolve(rememberColors(root, onDisk)));
      return onDisk.result;
    }
    const saved = await commitUserSettings(
      root,
      overlaySettings(onDisk.raw ?? current, current, next, agentLaunch),
      { text: onDisk.text },
    );
    if (saved) return saved;
  }
  throw new Error(`dohc did not save settings because ${path} kept changing. Try again.`);
}

/** A save that adds an agent the file has by then, which came in after the caller read the file. */
export class AgentIdTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = AGENT_ID_TAKEN_ERROR;
  }
}

/**
 * Saves the settings a caller changed from `base`. Only that difference is
 * written onto the file as it is now, so an edit made in the file after the
 * caller read it stays. An agent the caller adds that the file has by then
 * is refused rather than written over.
 */
export function writeUserSettingsFile(
  dir: string,
  settings: StoredUserSettings,
  base: StoredUserSettings,
): Promise<StoredUserSettingsResult> {
  const next = StoredUserSettings.parse(settings);
  return updateUserSettingsFile(dir, (current) => {
    const taken = Object.keys(next.agents).find((id) => !Object.hasOwn(base.agents, id) && Object.hasOwn(current.agents, id));
    if (taken !== undefined) {
      throw new AgentIdTakenError(`dohc didn't add ${next.agents[taken]!.name} because the settings file changed at the same time.`);
    }
    return overlaySettings(current, base, next, agentLaunch);
  });
}

/**
 * Moves the agents in `order` to the front of the file, in that order. Every
 * other entry, one dohc could not use included, keeps its place after them.
 * Nothing but the agents' order changes.
 */
export async function orderUserSettingsAgents(
  dir: string,
  order: readonly string[],
): Promise<StoredUserSettingsResult> {
  const root = resolve(dir);
  const path = settingsPath(root);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const onDisk = await loadUserSettings(path);
    if (onDisk.problem !== null) {
      throw new Error(`dohc did not save settings. ${onDisk.result.warning}`);
    }
    const agents = onDisk.raw?.agents;
    const ids = isSettingsObject(agents) ? Object.keys(agents) : [];
    const next = [...new Set([...order.filter((id) => ids.includes(id)), ...ids])];
    if (onDisk.raw === null || !isSettingsObject(agents) || next.every((id, index) => id === ids[index])) {
      snapshots.set(root, Promise.resolve(rememberColors(root, onDisk)));
      return onDisk.result;
    }
    const saved = await commitUserSettings(
      root,
      { ...onDisk.raw, agents: Object.fromEntries(next.map((id) => [id, agents[id]])) },
      { text: onDisk.text },
    );
    if (saved) return saved;
  }
  throw new Error(`dohc did not save settings because ${path} kept changing. Try again.`);
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
