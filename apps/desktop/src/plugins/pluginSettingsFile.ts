import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import {
  MAX_SETTING_VALUE_CHARS,
  type PluginSettingDeclaration,
  type PluginSettingValue,
} from "./pluginManifestSchema";

// A plugin's settings are the user's answers, so they live in the workspace as
// text — one file beside the workspace's own settings, keyed by directoryName:
//
//   .dohc/plugin-settings.local.json
//   { "t3-code-src": { "port": 4317 } }
//
// Keyed by directoryName, not plugin id: an id is only ever a broken
// manifest's directory-derived fallback, which can coincide with some OTHER,
// unrelated plugin's real id — two rows sharing an id would otherwise share
// one entry here too, each silently overwriting and reading the other's
// answers. directoryName is the one identity a broken manifest cannot take
// away, and every discovered entry carries exactly one (#779-offers round 18
// finding 4).
//
// One file rather than one per plugin, because that is what the reader wants
// open when they ask what this workspace has been told: every answer on one
// page. Plugin CODE and its build output stay out of the workspace (CERT779);
// this is data the user typed, and the manifest's declarations decide what any
// of it means. A value the manifest does not declare is dropped on read, so a
// file edited by hand — or arriving over sync — can only ever set a setting
// some plugin actually asked for, to a type that plugin actually declared.
export const PLUGIN_SETTINGS_FILE = "plugin-settings.local.json";

// The same cap the workspace's own settings file carries. These files hold a
// few values per plugin; anything near this is not settings.
export const MAX_PLUGIN_SETTINGS_FILE_BYTES = 256 * 1024;

/** Every plugin's stored answers, exactly as the file holds them. */
export type StoredPluginSettings = Record<
  string,
  Record<string, PluginSettingValue>
>;

function isSettingValue(value: unknown): value is PluginSettingValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every plugin's stored values, keeping only what could be a setting at all.
 * Shape checking stops here; whether a value is right for its setting is a
 * question only the plugin's declarations can answer, and resolvePluginSettings
 * asks it.
 */
function readStoredSettings(body: unknown): StoredPluginSettings {
  if (!isRecord(body)) return {};
  const stored: StoredPluginSettings = {};
  for (const [directoryName, values] of Object.entries(body)) {
    if (!isRecord(values)) continue;
    const kept: Record<string, PluginSettingValue> = {};
    for (const [key, value] of Object.entries(values)) {
      if (isSettingValue(value)) kept[key] = value;
    }
    stored[directoryName] = kept;
  }
  return stored;
}

/**
 * What a plugin's settings actually are: its declared defaults, with a stored
 * value replacing a default only when that value fits the declaration. Every
 * declared key is present and no undeclared key is, so a plugin never has to
 * check whether a setting exists. A stored value of the wrong type, a string
 * past the value cap, or a select answer that is no longer an option, falls
 * back to the default rather than reaching the plugin — the manifest is what
 * a value has to satisfy, and a manifest can change under a file that was
 * written for an older one.
 */
export function resolvePluginSettings(
  declared: readonly PluginSettingDeclaration[],
  stored: Readonly<Record<string, PluginSettingValue>> | undefined,
): Record<string, PluginSettingValue> {
  const values: Record<string, PluginSettingValue> = {};
  for (const setting of declared) {
    const value = stored?.[setting.key];
    values[setting.key] = fitsDeclaration(setting, value)
      ? value
      : setting.default;
  }
  return values;
}

function fitsDeclaration(
  setting: PluginSettingDeclaration,
  value: unknown,
): value is PluginSettingValue {
  switch (setting.type) {
    // The IPC contract caps a string at MAX_SETTING_VALUE_CHARS, and the
    // manifest caps every declared default the same way. A longer stored
    // value is not a settings value: kept, it would fail the contract on its
    // way to the renderer and the reader would get a validation error where
    // their settings should be, with nothing in the app to undo it.
    case "string":
      return typeof value === "string"
        && value.length <= MAX_SETTING_VALUE_CHARS;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "select":
      return typeof value === "string" && setting.options.includes(value);
  }
}

async function pluginSettingsPath(workspaceRoot: string): Promise<string> {
  return join(
    await resolveWorkspaceMetadataDir(workspaceRoot),
    PLUGIN_SETTINGS_FILE,
  );
}

/**
 * Every plugin's stored answers. Tolerant by design: a missing file is a
 * workspace nobody has changed a setting in, and an unreadable one must not
 * stop plugins from running. Either way the caller resolves against the
 * manifest's defaults, so the plugin gets a complete, valid set regardless.
 */
export async function readPluginSettingsFile(
  workspaceRoot: string,
): Promise<StoredPluginSettings> {
  let path: string;
  try {
    path = await pluginSettingsPath(workspaceRoot);
  } catch {
    return {};
  }
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) return {};
    if (fileStats.size > MAX_PLUGIN_SETTINGS_FILE_BYTES) return {};
    return readStoredSettings(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return {};
  }
}

// Every write for one workspace runs on this queue, one at a time. Two
// settings changed before the first save settles would otherwise both read the
// same file and the later write would drop the earlier one, while both
// controls showed the value they had just set (the workspace settings file
// carries this queue for the same reason).
const writeQueues = new Map<string, Promise<unknown>>();

function queueWrite<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const queue = writeQueues.get(workspaceRoot) ?? Promise.resolve();
  // A failed write must not block the next one, so both settlements continue.
  const result = queue.then(run, run);
  const settled = result.then(() => undefined, () => undefined);
  writeQueues.set(workspaceRoot, settled);
  void settled.then(() => {
    if (writeQueues.get(workspaceRoot) === settled) {
      writeQueues.delete(workspaceRoot);
    }
  });
  return result;
}

/**
 * Records one plugin's answers and returns what its settings now are. The
 * patch is validated against the plugin's declarations before anything is
 * written, so the file can only ever hold values the manifest allows: an
 * undeclared key or a value of the wrong type is refused, not stored and
 * quietly ignored later. Other rows' entries are read and written back
 * untouched — keyed by directoryName, so a row that shares an id with an
 * unrelated plugin still gets its own entry rather than sharing one
 * (#779-offers round 18 finding 4). `pluginId` names the plugin only in the
 * error messages below; the file itself never reads or writes under it.
 */
export function savePluginSettings(
  workspaceRoot: string,
  directoryName: string,
  pluginId: string,
  declared: readonly PluginSettingDeclaration[],
  patch: Readonly<Record<string, unknown>>,
): Promise<Record<string, PluginSettingValue>> {
  return queueWrite(workspaceRoot, async () => {
    for (const [key, value] of Object.entries(patch)) {
      const setting = declared.find((entry) => entry.key === key);
      if (!setting) {
        throw new Error(
          `Plugin "${pluginId}" does not declare a setting named "${key}".`,
        );
      }
      if (!fitsDeclaration(setting, value)) {
        throw new Error(
          `Setting "${key}" of plugin "${pluginId}" must be a ${settingTypeName(setting)}.`,
        );
      }
    }

    const stored = await readPluginSettingsFile(workspaceRoot);
    const merged = { ...stored[directoryName], ...patch } as Record<
      string,
      PluginSettingValue
    >;
    // Only declared keys survive a write, so a manifest that drops a setting
    // drops its stored answer the next time the user changes anything.
    const values = resolvePluginSettings(declared, merged);
    await writePluginSettingsFile(workspaceRoot, {
      ...stored,
      [directoryName]: values,
    });
    return values;
  });
}

function settingTypeName(setting: PluginSettingDeclaration): string {
  switch (setting.type) {
    case "select":
      return `one of ${setting.options.map((option) => `"${option}"`).join(", ")}`;
    // Names the cap, because a refused string is as likely to be too long as
    // to be the wrong type.
    case "string":
      return `string of ${MAX_SETTING_VALUE_CHARS} characters or fewer`;
    default:
      return setting.type;
  }
}

async function writePluginSettingsFile(
  workspaceRoot: string,
  stored: StoredPluginSettings,
): Promise<void> {
  const path = await pluginSettingsPath(workspaceRoot);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    // Written whole and renamed into place, so a reader never sees half a
    // file — the same discipline the workspace's own settings file uses.
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
