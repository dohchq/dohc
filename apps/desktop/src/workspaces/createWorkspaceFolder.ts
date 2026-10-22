import {
  checkManifest,
  DISK_ROOT_REFUSAL,
  FILESYSTEM_ROOT_REFUSAL,
  HOME_FOLDER_REFUSAL,
  ReservedWorkspaceIdError,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  normalizeRootPath,
  sameFsEntry,
  validateAttachedFolder,
  validateWorkspaceRootChoice,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { recordNeverSynced, recordSynced, type Computer } from "./syncHistory";
import { recordNewCollectionsHolder } from "./collectionsHolder";
import { identityOf } from "./workspaceTrust";

export interface CreatedWorkspace {
  workspaceId: string;
  // Always canonicalWorkspaceRoot's spelling.
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

// The registry lists this spelling of the real path after every link.
// A workspace operation receives the physical real path, which uses native
// separators on Windows. Throws when the folder does not exist.
export function canonicalWorkspaceRoot(rootPath: string): string {
  return rootSpelling(realpathSync.native(rootPath));
}

// Forward slashes on Windows, as the app spells paths there. Elsewhere the
// real path stays as it is, backslashes in names included.
function rootSpelling(realPath: string): string {
  return normalizeRootPath(realPath, process.platform);
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
  const path = join(metadataDir, "manifest.json");
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry === null) return { kind: "absent" };
  if (!entry.isFile()) {
    throw new WorkspaceManifestError("unreadable", "dohc didn't open .dohc/manifest.json because it isn't a regular file. Replace it with this workspace's manifest file.");
  }
  const raw = await readFile(path, "utf8");
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
  // A drive's root is refused here, while its real path still reads "C:\".
  // The app spells it "C:", which names the drive's current folder instead.
  const real = realpathSync.native(path);
  if (parse(real).root === real) throw new Error(FILESYSTEM_ROOT_REFUSAL);
  return rootSpelling(real);
}

// The folder at a real path, while that path still has no link in it.
async function folderAt(rootPath: string): Promise<BigIntStats> {
  const folder = await lstat(rootPath, { bigint: true });
  if (!folder.isDirectory() || rootSpelling(await realpath(rootPath)) !== rootPath) {
    throw new Error(FOLDER_CHANGED);
  }
  return folder;
}

// The filesystem root under any name, as a bind mount of / gives it.
async function isFilesystemRoot(folder: BigIntStats): Promise<boolean> {
  return sameFsEntry(folder, await stat("/", { bigint: true })) === "same";
}

// Where a disk or share is mounted: a folder on another device than its parent,
// wherever it is (/Volumes/<disk>, /mnt, a folder in home), and macOS's
// /Volumes, which holds every disk but reports the system's device. /Volumes
// is matched by identity: on a case-sensitive disk, /volumes is another folder.
async function isDiskRoot(rootPath: string, folder: BigIntStats): Promise<boolean> {
  if (process.platform === "darwin" && sameFsEntry(folder, await stat("/Volumes", { bigint: true })) === "same") return true;
  const parent = dirname(rootPath);
  return parent !== rootPath && (await stat(parent, { bigint: true })).dev !== folder.dev;
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

// What New workspace may trust: the folder this call made a workspace from
// nothing, by its identity.
export interface FreshWorkspaceFolder {
  folder: string | null;
}

export async function createWorkspaceFolder(
  input: Parameters<typeof createWorkspaceFolderWithFreshness>[0],
): Promise<CreatedWorkspace> {
  return (await createWorkspaceFolderWithFreshness(input)).workspace;
}

// Only dohc's own records, which this call wrote, and nothing else.
async function holdsOnlyNewMetadata(rootPath: string, metadataDir: string): Promise<boolean> {
  const [entries, metadata] = await Promise.all([readdir(rootPath), readdir(metadataDir)]);
  return entries.length === 1 && entries[0] === ".dohc" &&
    metadata.every((name) => name === "manifest.json" || name === "sync-history.json" || name === "collections.json");
}

/**
 * createWorkspaceFolder, saying whether the workspace is new: `fresh` names
 * the folder when this call wrote the manifest into a folder that was missing
 * or empty and still holds nothing else. An adopted manifest, a file that
 * arrived meanwhile, or a replaced folder leaves it null.
 */
export async function createWorkspaceFolderWithFreshness(input: {
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
  // This installation, which runs a new workspace's schedules until it syncs
  // and keeps its Collections.
  computer: Computer;
}): Promise<{ workspace: CreatedWorkspace; fresh: FreshWorkspaceFolder | null }> {
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
  const rootCheck = validateWorkspaceRootChoice(rootPath, home.path, process.platform);
  if (!rootCheck.ok) throw new Error(rootCheck.reason);
  if (home.identity && sameFsEntry(folder, home.identity) === "same") throw new Error(HOME_FOLDER_REFUSAL);
  if (await isFilesystemRoot(folder)) throw new Error(FILESYSTEM_ROOT_REFUSAL);
  if (await isDiskRoot(rootPath, folder)) throw new Error(DISK_ROOT_REFUSAL);
  const startedEmpty = (await readdir(rootPath)).length === 0;
  // Node cannot create files relative to an open folder, so writes go by path.
  // Each step below first checks that the path still leads to the folder
  // judged above. That detects a folder or link put in its place before the
  // step; it cannot prevent one swapped in between a check and its write.
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
      workspace: {
        workspaceId: state.workspaceId,
        rootPath,
        kind: state.workspaceKind === "cloud-only" ? input.kind : state.workspaceKind,
        mode: state.mode,
      },
      fresh: null,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: input.workspaceId ?? randomUUID(),
    kind: input.kind,
  });

  // inspectManifest checked the entry itself: Windows "wx" can follow a
  // dangling link. "wx" keeps a competing regular file from being replaced.
  await writeFile(
    join(metadataDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await assertSameFolder();
  // A folder that had no manifest was never a dohc workspace. A join names
  // the synced workspace's id, and its folder records that it synced.
  if (input.workspaceId === undefined) {
    await recordNeverSynced(rootPath, input.computer);
    await recordNewCollectionsHolder(rootPath, manifest.workspaceId, input.computer);
  } else await recordSynced(rootPath);
  const fresh = startedEmpty && await holdsOnlyNewMetadata(rootPath, metadataDir);
  await assertSameFolder();
  return {
    workspace: {
      workspaceId: manifest.workspaceId,
      rootPath,
      kind: input.kind,
      mode: manifest.mode,
    },
    fresh: fresh ? { folder: identityOf(folder) } : null,
  };
}
