import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { diskSpelling } from "./diskSpelling";

export class StoredEntryIdentityUnavailable extends Error {
  constructor(path: string) {
    super(`dohc could not tell which file or folder on disk ${path} is. Check it in your file manager before trying again.`);
  }
}

// The caller has already found this entry. Absence here is a changed or
// unknown identity, not permission to proceed with the lookup spelling.
export async function storedEntryPath(realRoot: string, entry: string): Promise<string> {
  if (process.platform !== "linux") return relative(realRoot, await realpath(entry)).split(sep).join("/");
  const path = relative(realRoot, entry).split(sep).join("/");
  const stored = await diskSpelling(realRoot, entry).catch(() => { throw new StoredEntryIdentityUnavailable(path); });
  if (stored === null) throw new StoredEntryIdentityUnavailable(path);
  return relative(realRoot, stored).split(sep).join("/");
}
