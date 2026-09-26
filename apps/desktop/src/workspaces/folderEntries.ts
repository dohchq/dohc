import { readdir } from "node:fs/promises";

/**
 * The names in a folder, or none when the folder is confirmed missing. Any
 * other failure to read it, such as a permission or disk error, throws: an
 * unreadable folder is not an empty one.
 */
export async function folderEntriesOrNone(absolutePath: string): Promise<string[]> {
  try {
    return await readdir(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
