import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isInside } from "../security/pathContainment";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";

// Files from other people open as a copy with the system's download mark, so
// the system checks them the way it checks a download. Each copy gets a fresh
// folder inside this run's folder. Quit removes the copies, and the next start
// removes any a quit could not.

export interface MarkedCopies {
  /** This run's folder, inside the profile's folder. Only copies live here. */
  readonly folder: string;
  copy(source: string, target: string): Promise<void>;
  mark(path: string): Promise<void>;
}

/** One folder per profile, so a dohc with another profile never removes this one's copies. */
export function markedCopiesRoot(tempPath: string, profilePath: string): string {
  const profile = createHash("sha256").update(profilePath).digest("hex").slice(0, 16);
  return join(tempPath, `dohc-opened-${profile}`);
}

export function systemMarkedCopies(root: string): MarkedCopies {
  return {
    folder: join(root, randomUUID()),
    // A clone where the volume supports one. The copy keeps the original's
    // mode, plus the owner's write so the mark can be written.
    copy: async (source, target) => {
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const { mode } = await stat(target);
      if ((mode & 0o200) === 0) await chmod(target, (mode & 0o777) | 0o200);
    },
    mark: (path) => markAsDownloaded(path, process.platform),
  };
}

export async function markAsDownloaded(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    // Zone 3 is the Internet zone.
    await writeFile(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  } else if (platform === "darwin") {
    // Flags 0001 (downloaded, not yet approved); seconds since 1970 in hex;
    // the name of the app that wrote the file.
    const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", `0001;${seconds};dohc;`, path],
        { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
    });
  }
  // Linux has no download mark.
}

/**
 * Whether a file came from another person: every file in a standalone shared
 * view, and every file whose real path is in the workspace's real
 * shared-with-me. When dohc cannot tell, it did.
 */
export async function cameFromAnotherPerson(
  workspace: Pick<RegistryEntry, "rootPath" | "shareView">,
  realTarget: string,
): Promise<boolean> {
  if (shareViewIsPresent(workspace.shareView)) return true;
  let shared: string;
  try {
    shared = await realpath(join(workspace.rootPath, SHARED_WITH_ME_FOLDER));
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
  return isInside(fileSystemCase(shared), fileSystemCase(realTarget));
}

// Windows and macOS's default volumes ignore case. Folding on a volume that
// keeps case only makes more files open as copies.
function fileSystemCase(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** Copies the file into a fresh folder and marks the copy. Opens nothing; throws when either step fails. */
export async function markedCopyOf(copies: MarkedCopies, source: string): Promise<string> {
  const root = dirname(copies.folder);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateFolder(root);
  await mkdir(copies.folder, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(copies.folder, "open-"));
  const target = join(folder, basename(source));
  try {
    await copies.copy(source, target);
    await copies.mark(target);
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

/** At quit. A copy another program holds open stays for the next start. */
export async function removeMarkedCopies(copies: MarkedCopies): Promise<void> {
  await removeEntries(copies.folder);
  await removeEntries(dirname(copies.folder));
}

/** At start: removes what earlier runs left, never this run's copies. */
export async function removeEarlierMarkedCopies(copies: MarkedCopies): Promise<void> {
  await removeEntries(dirname(copies.folder), basename(copies.folder));
}

async function removeEntries(folder: string, keep?: string): Promise<void> {
  // A link here would lead outside, so dohc removes only through a folder it made.
  if (!(await isPrivateFolder(folder))) return;
  const names = await readdir(folder).catch(() => []);
  await Promise.all(names.filter((name) => name !== keep).map((name) =>
    rm(join(folder, name), { recursive: true, force: true }).catch(() => undefined)));
}

async function isPrivateFolder(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
  // The system temp folder can be shared with other accounts outside Windows.
  const uid = process.getuid?.();
  return uid === undefined || (info.uid === uid && (info.mode & 0o077) === 0);
}

async function assertPrivateFolder(path: string): Promise<void> {
  if (!(await isPrivateFolder(path))) {
    throw new Error(`dohc could not open a copy, because ${path} is not a private folder. Remove that folder, then try again.`);
  }
}
