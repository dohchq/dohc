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

export async function readWorkspaceSettingsFile(
  rootPath: string,
): Promise<WorkspaceSettingsResult> {
  const dir = await resolveWorkspaceMetadataDir(rootPath);
  const path = join(dir, WORKSPACE_SETTINGS_FILE);
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

export async function writeWorkspaceSettingsFile(
  rootPath: string,
  settings: WorkspaceSettings,
): Promise<void> {
  const path = join(
    await resolveWorkspaceMetadataDir(rootPath),
    WORKSPACE_SETTINGS_FILE,
  );
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(WorkspaceSettings.parse(settings), null, 2)}\n`);
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
