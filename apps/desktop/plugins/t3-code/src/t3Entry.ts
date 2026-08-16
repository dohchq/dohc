import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// The one t3 release this plugin is built against. The bridge enforces it
// twice: here, on the installed package before spawning it, and again on the
// running server's readiness descriptor. Never launch a PATH-resolved `t3`,
// never npx — only the pinned dependency's own entry.
export const T3_PINNED_VERSION = "0.0.33";

const T3_PACKAGE_RELATIVE = ["snapshot", "node_modules", "t3"] as const;
const T3_ENTRY_RELATIVE = [...T3_PACKAGE_RELATIVE, "dist", "bin.mjs"] as const;
/** POSIX-separated: the broker resolves it against the plugin's built root. */
export const T3_ENTRY_MODULE_PATH = T3_ENTRY_RELATIVE.join("/");

/**
 * Resolves the pinned t3 server entry from the installed dependency inside
 * the plugin's built root. The returned module path is relative to that root,
 * the form the child-process broker requires.
 */
export async function resolveT3Entry(pluginRoot: string): Promise<string> {
  const packageDir = join(pluginRoot, ...T3_PACKAGE_RELATIVE);
  const manifestPath = join(packageDir, "package.json");
  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(
      `The installed t3 package could not be read at ${manifestPath}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "Reinstall the t3-code plugin.",
    );
  }
  if (manifest.name !== "t3" || manifest.version !== T3_PINNED_VERSION) {
    throw new Error(
      `The installed t3 package is ${String(manifest.name)}@${String(manifest.version)}; ` +
        `this plugin requires exactly t3@${T3_PINNED_VERSION}. Reinstall the t3-code plugin.`,
    );
  }
  const bin = manifest.bin;
  const declaredEntry =
    typeof bin === "object" && bin !== null && "t3" in bin
      ? (bin as Record<string, unknown>).t3
      : undefined;
  if (declaredEntry !== "./dist/bin.mjs") {
    throw new Error(
      `The installed t3 package declares bin.t3 as ${JSON.stringify(declaredEntry)}; ` +
        `t3@${T3_PINNED_VERSION} declares "./dist/bin.mjs". Reinstall the t3-code plugin.`,
    );
  }
  const entryPath = join(pluginRoot, ...T3_ENTRY_RELATIVE);
  const entryStats = await stat(entryPath).catch(() => null);
  if (!entryStats?.isFile()) {
    throw new Error(
      `The t3 server entry is missing at ${entryPath}. Reinstall the t3-code plugin.`,
    );
  }
  return T3_ENTRY_MODULE_PATH;
}
