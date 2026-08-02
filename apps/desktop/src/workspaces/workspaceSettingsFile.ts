import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  WorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsResult,
} from "./workspaceSettings";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

export const WORKSPACE_SETTINGS_FILE = "settings.local.json";
export const MAX_WORKSPACE_SETTINGS_FILE_BYTES = 256 * 1024;

// A settings file that EXISTS but cannot be read may hold the engine opt-out.
// Reading it as defaults would turn recording back on for a workspace that
// asked for none, so an unreadable file reads as opted out and carries a
// warning the workspace shell shows outside Settings. An ABSENT file is the
// other case: a new workspace must not be born opted out.
const UNREADABLE_WORKSPACE_SETTINGS: WorkspaceSettings = {
  ...DEFAULT_WORKSPACE_SETTINGS,
  experimental: { workspaceEngineAlpha: false },
};

function unreadableSettings(
  reason: string,
  path: string,
): WorkspaceSettingsResult {
  return {
    settings: UNREADABLE_WORKSPACE_SETTINGS,
    source: "recovered",
    warning: `${reason} dohc records no history for this workspace until you fix ${path}.`,
  };
}

async function workspaceSettingsPath(rootPath: string): Promise<string> {
  return join(await resolveWorkspaceMetadataDir(rootPath), WORKSPACE_SETTINGS_FILE);
}

export async function readWorkspaceSettingsFile(
  rootPath: string,
): Promise<WorkspaceSettingsResult> {
  const path = await workspaceSettingsPath(rootPath);
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      return unreadableSettings(
        "Workspace settings are not a file dohc can read.",
        path,
      );
    }
    if (fileStats.size > MAX_WORKSPACE_SETTINGS_FILE_BYTES) {
      return unreadableSettings("Workspace settings are too large to read.", path);
    }
    const raw = JSON.parse(await readFile(path, "utf8"));
    const parsed = WorkspaceSettings.safeParse(raw);
    if (!parsed.success) {
      return unreadableSettings("Workspace settings could not be read.", path);
    }
    return { settings: parsed.data, source: "stored" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" };
    }
    return unreadableSettings("Workspace settings could not be read.", path);
  }
}

// THE save path: the changed controls, applied to the file as it is NOW.
//
// Two ways the old whole-object save wrote an opt-out nobody chose. Over a
// file dohc cannot read, the caller's resolved object carries the fail-closed
// `workspaceEngineAlpha: false`, so one unrelated control would land the
// opt-out on disk and the warning would disappear with it — that one is
// refused here, and reset stays open as the deliberate way to replace the
// file. And after the user repairs the file, the caller still holds the
// resolved copy from before the repair: writing that copy back would undo the
// repair through the very recovery path the refusal prescribes. Merging the
// patch onto a fresh read closes both, and every other stale-snapshot save
// with them.
export async function saveWorkspaceSettingsFile(
  rootPath: string,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsResult> {
  const current = await readWorkspaceSettingsFile(rootPath);
  if (current.source === "recovered") {
    const path = await workspaceSettingsPath(rootPath);
    return {
      ...current,
      refusal: `dohc did not save workspace settings. dohc cannot read ${path}. Fix that file. Or select Reset workspace in Advanced to replace it.`,
    };
  }
  const settings = mergeWorkspaceSettings(current.settings, patch);
  await writeWorkspaceSettingsFile(rootPath, settings);
  return { settings, source: "stored" };
}

export async function writeWorkspaceSettingsFile(
  rootPath: string,
  settings: WorkspaceSettings,
): Promise<void> {
  const path = await workspaceSettingsPath(rootPath);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(WorkspaceSettings.parse(settings), null, 2)}\n`);
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
