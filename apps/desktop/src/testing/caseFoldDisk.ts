import { posix } from "node:path";
import type { FolderIdentity, FolderStat } from "../workspaces/workspaceRootIdentity";

export interface CaseFoldDisk {
  // The stored path a lookup reaches, or null when nothing is there.
  stored(path: string): string | null;
  // Linux realpath: the path as given, capitals and all, when it exists.
  realPath(path: string): string | null;
  kindOf(path: string): "file" | "folder" | null;
  // The names a folder lists, in the capitals they were made with.
  names(path: string): string[] | null;
  // A bigint stat, one per stored entry whatever spelling reaches it.
  stat(path: string): FolderStat;
}

/**
 * A Linux disk in memory, POSIX paths only. Inside a folder that `foldsCase`
 * accepts, as on an ext4 casefold folder, a name matches in any capitals but
 * keeps the capitals it was made with. Elsewhere names match exactly, so
 * `Notes` and `notes` can be two folders. Nothing canonicalizes capitals.
 */
export function caseFoldDisk(
  entries: Record<string, "file" | "folder">,
  options: {
    foldsCase(folder: string): boolean;
    // Stat numbers for some stored paths. Others get dev 1 and their own inode.
    identities?: Record<string, FolderIdentity>;
  },
): CaseFoldDisk {
  const kinds = new Map<string, "file" | "folder">([["/", "folder"]]);
  for (const [path, kind] of Object.entries(entries)) {
    for (let at = posix.dirname(path); !kinds.has(at); at = posix.dirname(at)) kinds.set(at, "folder");
    kinds.set(path, kind);
  }
  const inodes = new Map([...kinds.keys()].map((path, index) => [path, BigInt(index + 1)]));

  const namesIn = (folder: string) => [...kinds.keys()]
    .filter((candidate) => candidate !== "/" && posix.dirname(candidate) === folder)
    .map((candidate) => posix.basename(candidate));

  function stored(path: string): string | null {
    const spelled = path.replaceAll("\\", "/");
    if (!spelled.startsWith("/")) return null;
    let at = "/";
    for (const name of spelled.split("/").filter(Boolean)) {
      if (kinds.get(at) !== "folder") return null;
      const names = namesIn(at);
      const found = names.includes(name)
        ? name
        : options.foldsCase(at) ? names.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) : undefined;
      if (found === undefined) return null;
      at = posix.join(at, found);
    }
    return at;
  }

  return {
    stored,
    realPath: (path) => stored(path) === null ? null : posix.normalize(path.replaceAll("\\", "/")).replace(/(.)\/$/u, "$1"),
    names: (path) => {
      const at = stored(path);
      return at !== null && kinds.get(at) === "folder" ? namesIn(at) : null;
    },
    kindOf: (path) => {
      const at = stored(path);
      return at === null ? null : kinds.get(at) ?? null;
    },
    stat: (path) => {
      const at = stored(path);
      if (at === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      const identity = options.identities?.[at] ?? { dev: 1n, ino: inodes.get(at) ?? 0n };
      return { dev: identity.dev, ino: identity.ino, isDirectory: () => kinds.get(at) === "folder" };
    },
  };
}
