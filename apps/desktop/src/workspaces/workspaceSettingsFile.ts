import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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
    // Repairing the file is only half the fix, and the second half is a
    // RESTART, not a reopen: main decides the recorder once per workspace per
    // app session (openWorkspaceActivity retains every opened workspace, and
    // workspaceActivity.open no-ops for one it already watches), so leaving
    // the workspace and coming back re-reads nothing.
    warning: `${reason} dohc records no history for this workspace. Fix ${path}. Then restart dohc.`,
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

// EVERY write for ONE workspace runs on this queue, one at a time. Two
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
    await writeWorkspaceSettingsFile(rootPath, DEFAULT_WORKSPACE_SETTINGS);
    return { settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" };
  });
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
async function applyWorkspaceSettingsPatch(
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
    // A directory or a link at the settings path reads as unreadable, and
    // Reset is what the refusal tells the user to reach for — but the atomic
    // rename cannot land on either, so the advertised way out would fail.
    // Clear exactly that path first. The other caller (a patch save) only
    // reaches here after the file read as a regular file, so it never takes
    // this branch.
    const target = await lstat(path).catch(() => null);
    if (target && !target.isFile()) await rm(path, { recursive: true, force: true });
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
