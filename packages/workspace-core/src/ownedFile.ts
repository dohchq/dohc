// Reads one file of this computer's state whose content changes what dohc
// does, such as a workspace's settings or the automation steps a person
// allowed. Node only, so it is a subpath export ("@dohc/workspace-core/owned-file")
// and stays out of the barrel the renderer bundles.
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Why dohc does not trust a file it found. */
export type OwnedFileRefusal = "not-file" | "other-owner" | "writable-by-others" | "linked";

export type OwnedFileRead =
  | { readonly status: "read"; readonly content: string }
  | { readonly status: "missing" | OwnedFileRefusal | "too-large" };

/**
 * Why a file found at a name is not one only this user can change, or null
 * when it is. Windows reports no owner or mode, so there only the link count
 * is checked.
 */
export function ownedFileRefusal(stats: Stats): OwnedFileRefusal | null {
  if (!stats.isFile()) return "not-file";
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return "other-owner";
  // Group or other write lets another user rewrite it in place; on a Mac
  // every local user is in staff.
  if (uid !== undefined && (stats.mode & 0o022) !== 0) return "writable-by-others";
  // A second name is a second way to change it. More than one, not "not
  // one": a volume that reports no links would refuse every file.
  if (stats.nlink > 1) return "linked";
  return null;
}

/**
 * Reads a file and trusts it only if this user owns it, no other user can
 * write it, and it has no other name. The file is opened once without
 * following a link at its name, and checked on that same handle before it is
 * read, so a folder or path swapped meanwhile changes nothing: another local
 * user can't make a file this user owns. That is the only protection. A file
 * that came from a zip, a git checkout or a sync app belongs to this user and
 * is read. A caller that writes such a file gives it mode 0600, whatever the
 * umask.
 */
export async function readOwnedFile(path: string, maxBytes: number): Promise<OwnedFileRead> {
  // Windows has neither flag, so there a link at the name is refused first.
  const noFollow: number | undefined = constants.O_NOFOLLOW;
  const nonBlock: number | undefined = constants.O_NONBLOCK;
  if (noFollow === undefined) {
    const named = await lstat(path).catch(() => null);
    if (named?.isSymbolicLink()) return { status: "not-file" };
  }
  // O_NONBLOCK keeps a FIFO at the name from holding the open.
  const flags = constants.O_RDONLY | (noFollow ?? 0) | (nonBlock ?? 0);
  const handle = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing" as const;
    if (error.code === "ELOOP" || error.code === "EISDIR") return "not-file" as const;
    throw error;
  });
  if (typeof handle === "string") return { status: handle };
  try {
    const stats = await handle.stat();
    const refusal = ownedFileRefusal(stats);
    if (refusal !== null) return { status: refusal };
    if (stats.size > maxBytes) return { status: "too-large" };
    // Sized from the handle, and one byte past it, so a file that grew since
    // the check is read whole up to the cap, or refused instead of cut short.
    let buffer = Buffer.allocUnsafe(stats.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) return { status: "too-large" };
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, maxBytes + 1));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
    }
    return { status: "read", content: buffer.toString("utf8", 0, length) };
  } finally {
    await handle.close();
  }
}
