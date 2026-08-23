import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isInside } from "../security/pathContainment";
import { errorMessage } from "./pluginShared";

// A plugin icon is decoration. dohc advertises one only after it has checked
// the file is really there, really a file, and really small — so the renderer
// can point an <img> at it over dohc-file:// without a second thought, and a
// plugin that ships a broken icon still gets a row.
//
// The cap: the t3 plugin's own logo is 1 KiB, and marketplace icons run to
// tens of KiB at 256×256. 512 KiB clears the largest healthy icon by an order
// of magnitude while keeping a mistake — a screenshot dropped in as an icon —
// off the row.
export const MAX_PLUGIN_ICON_BYTES = 512 * 1024;

export type PluginIconCheck =
  | { icon: string; diagnostic: null }
  | { icon: null; diagnostic: string };

function refused(diagnostic: string): PluginIconCheck {
  return { icon: null, diagnostic };
}

/**
 * Checks a manifest's declared icon against the plugin root that declared it.
 * The schema has already refused absolute paths, `..` segments, and any
 * extension dohc cannot serve; this is the part only the file system can
 * answer. Returns the declared path when the icon is usable, or one
 * diagnostic naming why it is not.
 */
export async function verifyPluginIcon(
  pluginRoot: string,
  declaredPath: string,
): Promise<PluginIconCheck> {
  const iconPath = resolve(pluginRoot, ...declaredPath.split("/"));
  if (!isInside(pluginRoot, iconPath)) {
    return refused(
      `plugin icon at ${iconPath} is outside the plugin root at ${pluginRoot}`,
    );
  }

  let iconStats;
  try {
    iconStats = await lstat(iconPath);
  } catch (error) {
    return refused(
      `plugin icon at ${iconPath} could not be read: ${errorMessage(error)}`,
    );
  }

  // A symlink is refused rather than followed: the realpath check below would
  // pass for a link that stays inside the root, but an icon is not worth a
  // path that can be repointed after approval.
  if (iconStats.isSymbolicLink() || !iconStats.isFile()) {
    return refused(
      `plugin icon at ${iconPath} is not a readable file (symlink or directory)`,
    );
  }
  if (iconStats.size > MAX_PLUGIN_ICON_BYTES) {
    return refused(
      `plugin icon at ${iconPath} must be 512 KiB ` +
        `(${MAX_PLUGIN_ICON_BYTES} bytes) or smaller; found ${iconStats.size} bytes.`,
    );
  }

  // The root itself may be reached through a link; compare real to real so a
  // contained-looking icon cannot resolve outside the tree that was hashed.
  try {
    const realRoot = await realpath(pluginRoot);
    const realIcon = await realpath(iconPath);
    if (!isInside(realRoot, realIcon)) {
      return refused(
        `plugin icon at ${iconPath} resolves to ${realIcon}, outside the ` +
          `plugin root at ${realRoot}`,
      );
    }
  } catch (error) {
    return refused(
      `plugin icon at ${iconPath} could not be resolved: ${errorMessage(error)}`,
    );
  }

  return { icon: declaredPath, diagnostic: null };
}
