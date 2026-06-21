import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  WorkspaceSettings,
  type WorkspaceSettingsResult,
} from "./workspaceSettings";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

export const WORKSPACE_SETTINGS_FILE = "settings.local.json";
export const MAX_WORKSPACE_SETTINGS_FILE_BYTES = 256 * 1024;

export async function readWorkspaceSettingsFile(
  rootPath: string,
): Promise<WorkspaceSettingsResult> {
  try {
    const path = join(
      await resolveWorkspaceMetadataDir(rootPath),
      WORKSPACE_SETTINGS_FILE,
    );
    if ((await stat(path)).size > MAX_WORKSPACE_SETTINGS_FILE_BYTES) {
      return {
        settings: DEFAULT_WORKSPACE_SETTINGS,
        source: "recovered",
        warning: "Workspace settings were too large and were ignored.",
      };
    }
    const raw = JSON.parse(await readFile(path, "utf8"));
    const parsed = WorkspaceSettings.safeParse(raw);
    if (!parsed.success) {
      return {
        settings: DEFAULT_WORKSPACE_SETTINGS,
        source: "recovered",
        warning: "Workspace settings used an unsupported shape and were ignored.",
      };
    }
    return { settings: parsed.data, source: "stored" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" };
    }
    return {
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
      warning: "Workspace settings could not be read and were reset to defaults.",
    };
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
  await writeFile(tmp, `${JSON.stringify(WorkspaceSettings.parse(settings), null, 2)}\n`);
  await rename(tmp, path);
}
