import {
  checkManifest,
  FILESYSTEM_ROOT_REFUSAL,
  HOME_FOLDER_REFUSAL,
  ReservedWorkspaceIdError,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  normalizeAbsolutePath,
  sameFsEntry,
  validateAttachedFolder,
  validateWorkspaceRootChoice,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { recordNeverSynced, recordSynced } from "./syncHistory";

export interface CreatedWorkspace {
  workspaceId: string;
  // Always canonicalWorkspaceRoot's spelling.
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

// A workspace folder's one spelling: its real path after every link. The
// registry holds only this spelling, so the root it lists and the root a
// workspace operation receives are the same string. Throws when the folder
// does not exist.
export function canonicalWorkspaceRoot(rootPath: string): string {
  return rootSpelling(realpathSync.native(rootPath));
}

// The app spells Windows paths with forward slashes. Elsewhere a backslash is
// part of a folder's name, so the real path stays as it is.
function rootSpelling(realPath: string): string {
  return process.platform === "win32" ? normalizeAbsolutePath(realPath) : realPath;
}

// The mount code creates this on first use; it is exported so every path
// that addresses a mount spells the container the same way.
export const SHARED_WITH_ME_FOLDER = "shared-with-me";

// A .dohc/manifest.json dohc will not adopt or overwrite. ERROR_WORDS reads
// `code` into words; the message, with the parser's reason, is for Copy.
export class WorkspaceManifestError extends Error {
  override name = "WorkspaceManifestError";
  readonly code: "unreadable" | "newer-version";

  constructor(code: WorkspaceManifestError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type ManifestState =
  | { kind: "absent" }
  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] };

async function inspectManifest(metadataDir: string): Promise<ManifestState> {
  let raw: string;
  try {
    raw = await readFile(join(metadataDir, "manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceManifestError("unreadable", "this folder has a corrupt .dohc/manifest.json");
  }
  const check = checkManifest(parsed);
  if (check.status === "valid") {
    return {
      kind: "valid",
      workspaceId: check.manifest.workspaceId,
      workspaceKind: check.manifest.kind,
      mode: check.manifest.mode,
    };
  }
  if (check.status === "reserved-id") {
    throw new ReservedWorkspaceIdError(check.workspaceId);
  }
  if (check.status === "newer-version") {
    throw new WorkspaceManifestError(
      "newer-version",
      `this workspace was created by a newer version of dohc (manifest v${check.version})`,
    );
  }
  // A present-but-broken manifest must never be silently overwritten (it may
  // be the user's data). checkManifest never returns "absent" for a file that
  // exists, but narrow defensively.
  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
  throw new WorkspaceManifestError("unreadable", `this folder has an invalid .dohc/manifest.json: ${reason}`);
}

export const FOLDER_CHANGED = "The folder changed while dohc was opening it. Open it again.";

// An existing folder is judged before anything is made, so a refused link
// target gains nothing. Only a missing folder is created, and a file there
// fails as mkdir reports it.
async function realFolderPath(path: string): Promise<string> {
  const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing?.isDirectory()) await mkdir(path, { recursive: true });
  return canonicalWorkspaceRoot(path);
}

// The folder at a real path, while that path still has no link in it.
async function folderAt(rootPath: string): Promise<BigIntStats> {
  const folder = await lstat(rootPath, { bigint: true });
  if (!folder.isDirectory() || rootSpelling(await realpath(rootPath)) !== rootPath) {
    throw new Error(FOLDER_CHANGED);
  }
  return folder;
}

// A folder on another device than its parent is where a disk or share is
// mounted, wherever that is: /Volumes, /mnt, or a folder in home.
async function isMountRoot(rootPath: string, folder: BigIntStats): Promise<boolean> {
  const parent = dirname(rootPath);
  return parent === rootPath || (await stat(parent, { bigint: true })).dev !== folder.dev;
}

// The home folder's real path and identity. The identity also catches an
// alias realpath keeps, as macOS's /System/Volumes/Data/Users/<name>. Only a
// home folder that does not exist may go unresolved; any other failure stops
// before anything is written.
async function homeFolder(homeDir: string): Promise<{ path: string; identity: BigIntStats | null }> {
  try {
    return { path: canonicalWorkspaceRoot(homeDir), identity: await stat(homeDir, { bigint: true }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: homeDir, identity: null };
    throw error;
  }
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  // The home folder the root must not resolve to.
  homeDir: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
  // Join flow (0P-C): a fresh folder adopting a synced workspace's identity
  // gets the sync id instead of a random one, so the local engine store and
  // the relay bucket agree from the first pull. Ignored when the folder is
  // already a dohc workspace (an existing manifest's identity always wins —
  // silently rebinding it would sever history and sync).
  workspaceId?: string;
}): Promise<CreatedWorkspace> {
  const folderCheck = validateAttachedFolder(input.rootPath);
  if (!folderCheck.ok) {
    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
  }

  // Judge the folder a link leads to, not the link: a link to the home folder
  // or a disk is refused like the folder itself. Everything below writes and
  // registers this same real path.
  const rootPath = await realFolderPath(input.rootPath);
  const folder = await folderAt(rootPath);
  const home = await homeFolder(input.homeDir);
  const rootCheck = validateWorkspaceRootChoice(rootPath, home.path);
  if (!rootCheck.ok) throw new Error(rootCheck.reason);
  if (home.identity && sameFsEntry(folder, home.identity) === "same") throw new Error(HOME_FOLDER_REFUSAL);
  if (await isMountRoot(rootPath, folder)) throw new Error(FILESYSTEM_ROOT_REFUSAL);
  // Node cannot write relative to an open folder, so each step below first
  // proves the path still leads to the folder judged above. A folder or link
  // put in its place is refused.
  const assertSameFolder = async () => {
    if (sameFsEntry(folder, await folderAt(rootPath)) === "replaced") throw new Error(FOLDER_CHANGED);
  };
  await assertSameFolder();
  const metadataDir = await resolveWorkspaceMetadataDir(rootPath);
  // The metadata resolver reads the real path again. A different answer means
  // a folder on the path became a link meanwhile.
  if (rootSpelling(dirname(metadataDir)) !== rootPath) throw new Error(FOLDER_CHANGED);
  const state = await inspectManifest(metadataDir);
  await assertSameFolder();
  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  if (state.kind === "valid") {
    return {
      workspaceId: state.workspaceId,
      rootPath,
      kind: state.workspaceKind === "cloud-only" ? input.kind : state.workspaceKind,
      mode: state.mode,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: input.workspaceId ?? randomUUID(),
    kind: input.kind,
  });

  // wx: manifest is absent (inspectManifest returned "absent"); never clobber
  // an unexpected file, or follow a link, that appeared since the check.
  await writeFile(
    join(metadataDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await assertSameFolder();
  // A folder that had no manifest was never a dohc workspace. A join names
  // the synced workspace's id, and its folder records that it synced.
  if (input.workspaceId === undefined) await recordNeverSynced(rootPath);
  else await recordSynced(rootPath);
  return {
    workspaceId: manifest.workspaceId,
    rootPath,
    kind: input.kind,
    mode: manifest.mode,
  };
}
