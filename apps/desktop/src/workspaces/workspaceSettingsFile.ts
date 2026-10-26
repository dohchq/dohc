import { lstat, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { join } from "node:path";
import { decodeWorkspaceSettings } from "@dohc/workspace-contracts/workspace-settings";
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
import { WORKSPACE_TRASH } from "./workspaceTrash";
import { readOwnedFile, type OwnedFileRead } from "@dohc/workspace-core/owned-file";
import {
  LOCAL_FOLDER_WORDS,
  localStateDir,
  LocalStateFolderError,
  LocalStateUnavailableError,
  readOwnedLocalState,
  type LocalStateRefusal,
  type LocalStateWorkspace,
} from "./workspaceLocalState";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// Each computer keeps its own settings for a workspace, in `.dohc/local`.
export const WORKSPACE_SETTINGS_FILE = "settings.local.json";
export const MAX_WORKSPACE_SETTINGS_FILE_BYTES = 256 * 1024;

// The contract schema decides both what is valid and which keys exist.
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
  // Why a save is refused when Reset can't help, because the folder is wrong.
  folderRefusal?: string;
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

/** Where the settings file is, to show and to open. Never creates `.dohc/local`. */
export async function workspaceSettingsPath(rootPath: string): Promise<string> {
  return join(await resolveWorkspaceMetadataDir(rootPath), "local", WORKSPACE_SETTINGS_FILE);
}

export async function readWorkspaceSettingsFile(
  workspace: LocalStateWorkspace,
): Promise<WorkspaceSettingsResult> {
  return (await loadWorkspaceSettings(workspace)).result;
}

const NO_SETTINGS_FILE: WorkspaceSettingsOnDisk = {
  raw: null,
  result: { settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" },
};

// A problem with `.dohc` or `.dohc/local` itself. Reset replaces only the
// settings file, so these name the folder's own way out.
function unusableFolder({ shown, problem }: LocalStateFolderError): WorkspaceSettingsOnDisk {
  const [fact, fix] = LOCAL_FOLDER_WORDS[problem];
  return {
    raw: null,
    result: {
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
      warning: `This workspace's ${shown} ${fact}, so dohc is using default settings. ${fix}`,
    },
    folderRefusal: `dohc did not save workspace settings because this workspace's ${shown} ${fact}. ${fix}`,
  };
}

async function loadWorkspaceSettings(
  workspace: LocalStateWorkspace,
): Promise<WorkspaceSettingsOnDisk> {
  // Reads then agree with saves, which refuse the same folders.
  try {
    return await readOwnedLocalState(workspace.rootPath, settingsIn);
  } catch (error) {
    if (error instanceof LocalStateFolderError) return unusableFolder(error);
    const refused = (error as Error).message;
    return {
      raw: null,
      result: {
        settings: DEFAULT_WORKSPACE_SETTINGS,
        source: "recovered",
        warning: `dohc is using default settings. ${refused}`,
      },
      folderRefusal: `dohc did not save workspace settings. ${refused}`,
    };
  }
}

// These settings change what dohc does, such as whether a link opens without
// asking, so dohc uses only a file this user owns and alone can change, read
// through one handle. On a Mac and Linux the read does not wait for the engine
// to prepare the folder, so the saved settings apply as the window opens. On
// Windows it waits for an open under way.
async function settingsIn(folder: string | null): Promise<WorkspaceSettingsOnDisk> {
  if (folder === null) return NO_SETTINGS_FILE;
  const path = join(folder, WORKSPACE_SETTINGS_FILE);
  const read = await readOwnedFile(path, MAX_WORKSPACE_SETTINGS_FILE_BYTES).catch(() => null);
  if (read?.status === "missing") return NO_SETTINGS_FILE;
  const refusedFile = read === null || read.status === "read" ? null : FILE_REFUSALS[read.status];
  if (refusedFile) return { raw: null, result: unreadableSettings(refusedFile, path) };
  if (read?.status === "read") {
    try {
      const raw: unknown = JSON.parse(read.content);
      // Another version is a format this build cannot read, not one bad key.
      if (
        isSettingsObject(raw) &&
        (raw.version === undefined || raw.version === DEFAULT_WORKSPACE_SETTINGS.version)
      ) {
        return { raw, result: settingsFromObject(raw) };
      }
    } catch {
      // Not JSON: unreadable, as below.
    }
  }
  return {
    raw: null,
    result: unreadableSettings("Workspace settings could not be read.", path),
  };
}

// Why a settings file is not used. Reset writes a fresh one in its place.
const FILE_REFUSALS: Record<Exclude<OwnedFileRead["status"], "read" | "missing">, string> = {
  "not-file": "Workspace settings are not a file dohc can read.",
  "other-owner": "Another user made the workspace settings file.",
  "writable-by-others": "Other users can change the workspace settings file.",
  linked: "The workspace settings file has a second name elsewhere.",
  "too-large": "Workspace settings are too large to read.",
};

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
  workspace: LocalStateWorkspace,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsResult> {
  return queueWorkspaceSettingsWrite(workspace.rootPath, () =>
    applyWorkspaceSettingsPatch(workspace, patch),
  );
}

// What the Reset workspace control does: replace the file with the defaults.
// This is also the way out the refusal names, so it must land even over a file
// dohc cannot read — including a directory or a link at that path.
export function resetWorkspaceSettingsFile(
  workspace: LocalStateWorkspace,
): Promise<WorkspaceSettingsResult> {
  return queueWorkspaceSettingsWrite(workspace.rootPath, async () => {
    const replaced = await writeWorkspaceSettingsFile(
      workspace,
      DEFAULT_WORKSPACE_SETTINGS,
      "reset",
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
            warning: `dohc replaced workspace settings. The ${replaced} that was in their place is now in this workspace's ${WORKSPACE_TRASH}.`,
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
  workspace: LocalStateWorkspace,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsResult> {
  const current = await loadWorkspaceSettings(workspace);
  if (current.result.source === "recovered") {
    return {
      ...current.result,
      refusal:
        current.folderRefusal ??
        `dohc did not save workspace settings. dohc cannot read ${await workspaceSettingsPath(workspace.rootPath)}. Fix that file. Or select Reset workspace in Advanced to replace it.`,
    };
  }
  const settings = mergeWorkspaceSettings(current.result.settings, patch);
  const content = current.raw
    ? overlaySettings(current.raw, current.result.settings, settings)
    : settings;
  await writeSettingsContent(workspace, content, "save");
  return settingsFromObject(content);
}

// Answers what it had to move aside to land, so a reset can tell the user
// where their folder went: "folder", "link", or nothing at all (the ordinary
// case — the settings artifact itself, whose content a reset discards by
// definition, is replaced atomically by the rename).
export async function writeWorkspaceSettingsFile(
  workspace: LocalStateWorkspace,
  settings: WorkspaceSettings,
  verb: "save" | "reset" = "save",
): Promise<"folder" | "link" | null> {
  return writeSettingsContent(workspace, decodeWorkspaceSettings(settings), verb);
}

// What a save or a reset tells the person when the engine has not prepared
// `.dohc/local` for this computer's settings. Nothing is written then.
function notWritten(verb: "save" | "reset", refusal: LocalStateRefusal): string {
  return refusal === "not-opened"
    ? `dohc did not ${verb} this workspace's settings because the workspace has not finished opening. Try again when it opens.`
    : `dohc did not ${verb} this workspace's settings because it can't keep this computer's settings out of iCloud Drive. Restart dohc to try again.`;
}

async function writeSettingsContent(
  workspace: LocalStateWorkspace,
  content: Record<string, unknown>,
  verb: "save" | "reset",
): Promise<"folder" | "link" | null> {
  let folder: string;
  try {
    folder = await localStateDir(workspace);
  } catch (error) {
    if (error instanceof LocalStateUnavailableError) {
      throw new LocalStateUnavailableError(error.refusal, notWritten(verb, error.refusal));
    }
    throw error;
  }
  const path = join(folder, WORKSPACE_SETTINGS_FILE);
  let squatter: "folder" | "link" | null = null;
  await atomicReplaceFile(path, async (tmp) => {
    // 0600 whatever the umask: the reader refuses a file others can write.
    await writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    // A directory or a link at the settings path reads as unreadable, and
    // Reset is what the refusal tells the user to reach for — but the atomic
    // rename cannot land on either, so the advertised way out would fail.
    // Move exactly that path into the workspace trash first. Never delete it:
    // a folder there can hold anything, and a reset the user asked for must
    // not destroy content it never named. The other caller (a patch save) only
    // reaches here after the file read as a regular file, so it never takes
    // this branch.
    const target = await lstat(path).catch(() => null);
    squatter = target && !target.isFile()
      ? target.isSymbolicLink()
        ? ("link" as const)
        : ("folder" as const)
      : null;
    if (squatter) await moveIntoWorkspaceTrash(workspace, path);
  });
  return squatter;
}
