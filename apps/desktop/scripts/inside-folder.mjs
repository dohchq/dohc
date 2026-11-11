import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

// Whether `path` is `folder` or inside it, by real paths, so a temporary
// folder reached through a symlink still matches: macOS's /var is
// /private/var, and /tmp can be a symlink on Linux. Both must exist.
export function insideFolder(path, folder) {
  const rest = relative(realpathSync(folder), realpathSync(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}
