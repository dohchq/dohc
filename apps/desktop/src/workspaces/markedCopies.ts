import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isInside } from "../security/pathContainment";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";

// Files from other people open with the system's download mark, so the system
// checks them the way it checks a download. A file the person can edit under
// the share's grant is marked where it is. Every other one opens as a marked,
// read-only copy, so the other app asks before saving it anywhere. The copies
// live in the profile folder, which only one running dohc uses. Each copy gets
// a fresh folder inside this run's folder. Quit removes this run's folder, and
// the next start removes what earlier runs left.

export interface MarkedCopies {
  /** This run's folder, inside the profile's `opened` folder. Only copies live here. */
  readonly folder: string;
  copy(source: string, target: string): Promise<void>;
  mark(path: string): Promise<void>;
}

/** A marked copy could not be made. The message is the cause, for Copy details only. */
export class MarkedCopyError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "MarkedCopyError";
  }
}

export function systemMarkedCopies(profile: string): MarkedCopies {
  return {
    folder: join(profile, "opened", randomUUID()),
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
    // The flags macOS 27 writes for a file it downloads, read back from macOS.
    // Bit 0x0001 is QTN_FLAG_DOWNLOAD in WebKit's
    // Source/WebCore/PAL/pal/spi/mac/QuarantineSPI.h. Then seconds since 1970
    // in hex, and the name of the app that wrote the file.
    const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", `0081;${seconds};dohc;`, path],
        { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
    });
  }
  // Linux has no download mark.
}

type SharedPlaces = Pick<RegistryEntry, "workspaceId" | "rootPath" | "shareView">;

/**
 * Where a file came from. "own": the person's own work. "shared view": the
 * current standalone shared view, and no other shared place. "other": the
 * real shared-with-me of the current workspace or of any registered workspace,
 * or the real root of another registered shared view, since one can sit inside
 * another. When dohc cannot tell for the current workspace, it is "other".
 *
 * Registered roots are saved as real paths, so only entries whose saved place
 * could hold the file are resolved. One that fails to resolve holds nothing.
 */
export async function fileOrigin(
  workspace: SharedPlaces,
  registered: readonly SharedPlaces[],
  realTarget: string,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<"own" | "shared view" | "other"> {
  const target = fileSystemCase(realTarget);
  const holds = async (place: string, unclear: boolean) => {
    try {
      return isInside(fileSystemCase(await resolve(place)), target);
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ENOENT" ? false : unclear;
    }
  };
  const elsewhere = registered
    .filter((entry) => entry.workspaceId !== workspace.workspaceId)
    .map((entry) => shareViewIsPresent(entry.shareView) ? entry.rootPath : join(entry.rootPath, SHARED_WITH_ME_FOLDER))
    .filter((place) => isInside(fileSystemCase(place), target));
  const answers = await Promise.all([
    holds(join(workspace.rootPath, SHARED_WITH_ME_FOLDER), true),
    ...elsewhere.map((place) => holds(place, false)),
  ]);
  if (answers.includes(true)) return "other";
  return shareViewIsPresent(workspace.shareView) ? "shared view" : "own";
}

// Windows and macOS's default volumes ignore case. Folding on a volume that
// keeps case only makes more files open as copies.
function fileSystemCase(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** Marks a file the person can edit where it is. Opens nothing; throws when the mark fails. */
export async function markInPlace(copies: MarkedCopies, path: string): Promise<void> {
  try {
    await copies.mark(path);
  } catch (error) {
    throw new MarkedCopyError(error);
  }
}

/** Copies the file into a fresh folder, marks the copy and makes it read-only. Opens nothing; throws when any step fails. */
export async function markedCopyOf(copies: MarkedCopies, source: string): Promise<string> {
  let folder: string | undefined;
  try {
    for (const path of [dirname(copies.folder), copies.folder]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (!(await isRealFolder(path))) throw new Error(`${path} is a link or not a folder.`);
    }
    folder = await mkdtemp(join(copies.folder, "open-"));
    const target = join(folder, basename(source));
    await copies.copy(source, target);
    // Mark first: neither system writes the mark to a read-only file.
    await copies.mark(target);
    await chmod(target, 0o444);
    return target;
  } catch (error) {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw new MarkedCopyError(error);
  }
}

/** At quit: this run's folder only. A copy another program holds open stays for the next start. */
export async function removeMarkedCopies(copies: MarkedCopies): Promise<void> {
  if (await isRealFolder(dirname(copies.folder)) && await isRealFolder(copies.folder)) {
    await rm(copies.folder, { recursive: true, force: true });
  }
}

/** At start, after the instance lock: what earlier runs left, never this run's copies. */
export async function removeEarlierMarkedCopies(copies: MarkedCopies): Promise<void> {
  const root = dirname(copies.folder);
  if (!(await isRealFolder(root))) return;
  const names = await readdir(root).catch(() => []);
  await Promise.all(names.filter((name) => name !== basename(copies.folder)).map(async (name) => {
    const path = join(root, name);
    // Only a real folder is emptied. A link is removed itself.
    await rm(path, { recursive: await isRealFolder(path), force: true }).catch(() => undefined);
  }));
}

// A link here would lead outside, so dohc works only through a real folder.
async function isRealFolder(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info !== null && !info.isSymbolicLink() && info.isDirectory();
}
