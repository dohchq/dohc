import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import { readPluginManifestFile } from "./pluginManifest";
import {
  errorMessage,
  removeStaging,
  renameWithWindowsRetry,
} from "./pluginShared";
import { EXCLUDED_SOURCE_NAMES } from "./pluginSourceSnapshot";

export interface OfferedPluginSource {
  directoryName: (typeof BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES)[number];
  displayName: string | null;
  description: string | null;
  publisher: string | null;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function listOfferedPlugins(
  builtinPluginsRoot: string,
  workspaceRoot: string,
): Promise<OfferedPluginSource[]> {
  const offers: OfferedPluginSource[] = [];
  for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
    const target = join(workspaceRoot, "plugins", directoryName);
    try {
      if (await pathExists(target)) continue;
    } catch {
      // Only a confirmed missing workspace path is safe to offer.
      continue;
    }

    const sourceRoot = join(builtinPluginsRoot, directoryName);
    const manifest = await readPluginManifestFile(sourceRoot);
    if (!manifest.ok) continue;
    offers.push({
      directoryName,
      displayName: manifest.manifest.displayName ?? null,
      description: manifest.manifest.description ?? null,
      publisher: manifest.manifest.publisher ?? null,
    });
  }
  return offers;
}

export class OfferedPluginAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferedPluginAddError";
  }
}

function isBuiltinDriverPlugin(
  directoryName: string,
): directoryName is (typeof BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES)[number] {
  return (BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES as readonly string[]).includes(
    directoryName,
  );
}

// The renderer composes the full sentence ("dohc could not add <name>. ...");
// every error here states only the cause, never repeats that prefix.
function existingTargetError(directoryName: string): OfferedPluginAddError {
  return new OfferedPluginAddError(
    `plugins/${directoryName} already exists in this workspace.`,
  );
}

function toOfferedPluginAddError(error: unknown): OfferedPluginAddError {
  return error instanceof OfferedPluginAddError
    ? error
    : new OfferedPluginAddError(errorMessage(error));
}

export async function addOfferedPlugin(params: {
  builtinPluginsRoot: string;
  workspaceRoot: string;
  directoryName: string;
}): Promise<{ rootPath: string }> {
  const { builtinPluginsRoot, workspaceRoot, directoryName } = params;
  if (!isBuiltinDriverPlugin(directoryName)) {
    throw new OfferedPluginAddError(
      `"${directoryName}" is not a built-in driver plugin.`,
    );
  }

  const target = join(workspaceRoot, "plugins", directoryName);
  if (await pathExists(target)) throw existingTargetError(directoryName);

  // Staged under .dohc, never under plugins/: a mid-copy watcher batch would
  // otherwise list the staging directory itself as a phantom plugin
  // (discoverInstalledPlugins has no dot-prefix skip), and a crash between
  // the copy and the rename would strand it there for good. .dohc is on the
  // same volume as plugins/ (both live under workspaceRoot), so the rename
  // below stays atomic, and .dohc is already excluded from workspace
  // listing, capture, and plugin discovery.
  const stagingRoot = join(workspaceRoot, ".dohc", "plugin-offer-staging");
  const staging = join(stagingRoot, `${directoryName}-${randomUUID()}`);
  try {
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    // The install pipeline's own source snapshot already rejects a symlink
    // or other non-regular entry with a proper diagnostic once this copy is
    // installed — duplicating that check here would only produce a second,
    // worse-worded rejection. fs.cp does not dereference by default, so a
    // hypothetical symlink in the built-in source lands inert (pointing
    // nowhere useful in the copy) rather than pulling in bytes from outside
    // the source tree.
    await cp(join(builtinPluginsRoot, directoryName), staging, {
      recursive: true,
      filter: (source) => !EXCLUDED_SOURCE_NAMES.has(basename(source)),
    });
    if (await pathExists(target)) throw existingTargetError(directoryName);
    await renameWithWindowsRetry(staging, target, toOfferedPluginAddError);
    return { rootPath: target };
  } catch (error) {
    await removeStaging(staging).catch(() => undefined);
    throw toOfferedPluginAddError(error);
  }
}
