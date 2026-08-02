import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  WorkspaceSettings,
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

// Settings saves write the whole RESOLVED object. Over a file dohc cannot
// read, the resolved object carries the fail-closed opt-out, so one unrelated
// control would land `workspaceEngineAlpha: false` on disk as a choice the
// user never made — and the warning would disappear with it. Refuse instead.
// Reset stays open as the deliberate way to replace the file.
export async function saveWorkspaceSettingsFile(
  rootPath: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettingsResult> {
  const current = await readWorkspaceSettingsFile(rootPath);
  if (current.source === "recovered") {
    const path = await workspaceSettingsPath(rootPath);
    return {
      ...current,
      refusal: `dohc did not save workspace settings. dohc cannot read ${path}. Fix that file, or select Reset workspace in Advanced to replace it.`,
    };
  }
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
