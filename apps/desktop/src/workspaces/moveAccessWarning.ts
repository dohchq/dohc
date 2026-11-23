import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { FOLDER_MARKER_FILE } from "@dohc/security-contract/access-rules";

/**
 * A move asked without `confirmAccessChange` that would change which folder
 * rules sit above the item. The message is the sentence to ask with.
 */
export class AccessChangeError extends Error {
  override name = "AccessChangeError";
}

// The folders above `parent`, and `parent` itself, that hold a rule's marker.
// A moved folder's own marker moves with it, so only its parents count.
async function ruleFoldersAt(rootPath: string, parent: string): Promise<Set<string>> {
  const parts = parent.split("/").filter(Boolean);
  const folders = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  const held = await Promise.all(
    folders.map((folder) =>
      lstat(join(rootPath, ...folder.split("/"), FOLDER_MARKER_FILE)).then(
        (entry) => entry.isFile(),
        () => false,
      ),
    ),
  );
  return new Set(folders.filter((_, index) => held[index]));
}

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const nameOf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * Why a move may change who can see an item: the folders holding a
 * `.dohc-access` marker above its old and new places differ. It parses no rule, so
 * two rules that give the same access still warn. Null when nothing differs.
 */
export async function moveAccessWarning(
  rootPath: string,
  fromPath: string,
  toPath: string,
): Promise<string | null> {
  const fromParent = parentOf(fromPath),
    toParent = parentOf(toPath);
  if (fromParent === toParent) return null;
  const [before, after] = await Promise.all([
    ruleFoldersAt(rootPath, fromParent),
    ruleFoldersAt(rootPath, toParent),
  ]);
  if (before.size === after.size && [...before].every((folder) => after.has(folder))) return null;
  const where = toParent ? `into ${nameOf(toParent)}` : `out of ${nameOf(fromParent)}`;
  return `Moving ${nameOf(fromPath)} ${where} may change who can see it. People who could read it may keep a copy.`;
}
