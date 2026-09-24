import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceSettings as WorkspaceSettingsContract } from "@dohc/workspace-contracts/workspace-settings";
import * as Schema from "effect/Schema";
import {
  isSettingsObject,
  overlaySettings,
  readSettingsLeniently,
  settingKinds,
} from "../settings/settingsFile";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  WorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsResult,
} from "./workspaceSettings";
import { moveIntoWorkspaceTrash } from "./workspaceFiles";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

export const WORKSPACE_SETTINGS_FILE = "settings.local.json";
export const MAX_WORKSPACE_SETTINGS_FILE_BYTES = 256 * 1024;

const decodeWorkspaceSettings = Schema.decodeUnknownSync(WorkspaceSettingsContract);
// The contract decides what is valid; the IPC mirror, bound to the contract
// by type, lists the keys.
const workspaceSettingKinds = settingKinds(WorkspaceSettings, DEFAULT_WORKSPACE_SETTINGS);

function decodedOrNull(candidate: unknown): WorkspaceSettings | null {
  try {
    return decodeWorkspaceSettings(candidate);
  } catch {
    return null;
  }
}

// The file as dohc found it, and what it means. A save writes onto `raw`, so
// keys dohc does not use stay in the file.
interface WorkspaceSettingsOnDisk {
  raw: Record<string, unknown> | null;
  result: WorkspaceSettingsResult;
}

// An unknown key, or a value dohc cannot use, turns off only that key.
function settingsFromObject(raw: Record<string, unknown>): WorkspaceSettingsResult {
  const { settings, ignored } = readSettingsLeniently({
    raw,
    defaults: DEFAULT_WORKSPACE_SETTINGS,
    kind: workspaceSettingKinds,
    parse: decodedOrNull,
  });
  return { settings, source: "stored", ...(ignored.length > 0 ? { ignored } : {}) };
}

// A settings file that EXISTS but cannot be read runs on defaults and carries
// a warning Settings shows, so the user knows their choices are not in
// effect. An ABSENT file is the ordinary new-workspace case and warns nothing.
function unreadableSettings(
  reason: string,
  path: string,
): WorkspaceSettingsResult {
  return {
    settings: DEFAULT_WORKSPACE_SETTINGS,
    source: "recovered",
    warning: `${reason} dohc is using default settings. Fix ${path}. Or select Reset workspace in Advanced to replace it.`,
  };
}

async function workspaceSettingsPath(rootPath: string): Promise<string> {
  return join(await resolveWorkspaceMetadataDir(rootPath), WORKSPACE_SETTINGS_FILE);
}

export async function readWorkspaceSettingsFile(
  rootPath: string,
): Promise<WorkspaceSettingsResult> {
  return (await loadWorkspaceSettings(rootPath)).result;
}

async function loadWorkspaceSettings(
  rootPath: string,
): Promise<WorkspaceSettingsOnDisk> {
  // The metadata resolver refuses a symlinked or non-directory .dohc by
  // throwing, and its contract says readers stay tolerant by catching. A
  // throw here is the settings-unreadable class one level up — the FOLDER is
  // untrustworthy — so it takes the same fail-closed path, with a warning
  // that names the folder to repair. Restart alone cannot fix this class.
  let path: string;
  try {
    path = await workspaceSettingsPath(rootPath);
  } catch {
    return {
      raw: null,
      result: unreadableSettings(
        "dohc cannot use the workspace's .dohc folder.",
        join(rootPath, ".dohc"),
      ),
    };
  }
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      return {
        raw: null,
        result: unreadableSettings("Workspace settings are not a file dohc can read.", path),
      };
    }
    if (fileStats.size > MAX_WORKSPACE_SETTINGS_FILE_BYTES) {
      return {
        raw: null,
        result: unreadableSettings("Workspace settings are too large to read.", path),
      };
    }
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    // Another version is a format this build cannot read, not one bad key.
    if (
      isSettingsObject(raw) &&
      (raw.version === undefined || raw.version === DEFAULT_WORKSPACE_SETTINGS.version)
    ) {
      return { raw, result: settingsFromObject(raw) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: null, result: { settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" } };
    }
  }
  return {
    raw: null,
    result: unreadableSettings("Workspace settings could not be read.", path),
  };
}

// Every write for one workspace runs on this queue, one at a time. Two
// controls changed before the first save settles would otherwise both read the
// same old file, and the later merge would drop the earlier patch while the
// dialog reported it saved. Reset joins the same queue for the same reason:
// off it, a patch already in flight reads pre-reset settings and writes them
// back after the reset returns, leaving the file somewhere the user never
// asked for while the dialog says the reset landed.
const settingsWriteQueues = new Map<string, Promise<unknown>>();

function queueWorkspaceSettingsWrite<T>(
  rootPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const queue = settingsWriteQueues.get(rootPath) ?? Promise.resolve();
  // A failed write must not block the next one, so both settlements continue.
  const result = queue.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  settingsWriteQueues.set(rootPath, settled);
  void settled.then(() => {
    // Drop the entry only if no later write has taken the tail, so the map
    // does not grow one promise per workspace for the life of the process.
    if (settingsWriteQueues.get(rootPath) === settled) {
      settingsWriteQueues.delete(rootPath);
    }
  });
  return result;
}

export function saveWorkspaceSettingsFile(
  rootPath: string,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsResult> {
  return queueWorkspaceSettingsWrite(rootPath, () =>
    applyWorkspaceSettingsPatch(rootPath, patch),
  );
}

// What the Reset workspace control does: replace the file with the defaults.
// This is also the way out the refusal names, so it must land even over a file
// dohc cannot read — including a directory or a link at that path.
export function resetWorkspaceSettingsFile(
  rootPath: string,
): Promise<WorkspaceSettingsResult> {
  return queueWorkspaceSettingsWrite(rootPath, async () => {
    const replaced = await writeWorkspaceSettingsFile(
      rootPath,
      DEFAULT_WORKSPACE_SETTINGS,
    );
    return {
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
      // A reset that moved something aside owes the user the reverse path,
      // named where they pressed the button. The trash location is the one
      // dohc already teaches for anything it removes, so it is named the same
      // way the delete dialog names it, without the entry's decorated name.
      ...(replaced
        ? {
            warning: `dohc replaced workspace settings. The ${replaced} that was in their place is now in this workspace's .dohc/trash.`,
          }
        : {}),
    };
  });
}

// The save path: the changed controls, applied to the file as it is NOW.
//
// A save over a file dohc cannot read is refused, and reset stays open as the
// deliberate way to replace the file. After the user repairs the file, the
// caller may still hold the resolved copy from before the repair: writing
// that copy back would undo the repair. Merging the patch onto a fresh read
// closes that, and every other stale-snapshot save with it. Only the changed
// keys are written, so keys dohc does not use stay as the person left them.
async function applyWorkspaceSettingsPatch(
  rootPath: string,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsResult> {
  const current = await loadWorkspaceSettings(rootPath);
  if (current.result.source === "recovered") {
    const path = await workspaceSettingsPath(rootPath);
    return {
      ...current.result,
      refusal: `dohc did not save workspace settings. dohc cannot read ${path}. Fix that file. Or select Reset workspace in Advanced to replace it.`,
    };
  }
  const settings = mergeWorkspaceSettings(current.result.settings, patch);
  const content = current.raw
    ? overlaySettings(current.raw, current.result.settings, settings)
    : settings;
  await writeSettingsContent(rootPath, content);
  return settingsFromObject(content);
}

// Answers what it had to move aside to land, so a reset can tell the user
// where their folder went: "folder", "link", or nothing at all (the ordinary
// case — the settings artifact itself, whose content a reset discards by
// definition, is replaced atomically by the rename).
export async function writeWorkspaceSettingsFile(
  rootPath: string,
  settings: WorkspaceSettings,
): Promise<"folder" | "link" | null> {
  return writeSettingsContent(rootPath, decodeWorkspaceSettings(settings));
}

async function writeSettingsContent(
  rootPath: string,
  content: Record<string, unknown>,
): Promise<"folder" | "link" | null> {
  const path = await workspaceSettingsPath(rootPath);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`);
    // A directory or a link at the settings path reads as unreadable, and
    // Reset is what the refusal tells the user to reach for — but the atomic
    // rename cannot land on either, so the advertised way out would fail.
    // Move exactly that path into the workspace trash first. Never delete it:
    // a folder there can hold anything, and a reset the user asked for must
    // not destroy content it never named. The other caller (a patch save) only
    // reaches here after the file read as a regular file, so it never takes
    // this branch.
    const target = await lstat(path).catch(() => null);
    const squatter = target && !target.isFile()
      ? target.isSymbolicLink()
        ? ("link" as const)
        : ("folder" as const)
      : null;
    if (squatter) await moveIntoWorkspaceTrash(rootPath, path);
    await rename(tmp, path);
    return squatter;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
