import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import { readPluginManifestFile } from "./pluginManifest";
import {
  errorMessage,
  isInside,
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

/**
 * @param existingPluginIds The manifest ids the workspace's plugin pipeline
 * already knows about — identity is the manifest id, not the directory a
 * plugin happens to live in, so `codex` copied to `plugins/my-codex` still
 * suppresses the Codex offer: adding a second `codex` would only degrade to
 * discovery's existing duplicate-id handling, never a clean install.
 */
export async function listOfferedPlugins(
  builtinPluginsRoot: string,
  workspaceRoot: string,
  existingPluginIds: ReadonlySet<string>,
): Promise<OfferedPluginSource[]> {
  const offers: OfferedPluginSource[] = [];
  for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
    if (existingPluginIds.has(directoryName)) continue;
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

/**
 * Verifies (and creates, if absent) one path segment, refusing the moment it
 * is a symlink/junction or its real location escapes `realParent`. Never
 * calls `mkdir` with `recursive: true` on a multi-level path: that follows
 * a symlink in every intermediate segment transparently, so a `plugins` or
 * `.dohc` planted as a junction into a synced workspace folder could
 * redirect a later create through it before any check ever ran. Calling this
 * once per level, always against the PREVIOUS level's own verified real
 * path, closes that gap — each new segment's immediate parent is already
 * known real and contained by the time this creates or inspects it.
 */
async function ensureContainedDirectory(
  path: string,
  realParent: string,
  label: string,
): Promise<string> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw new OfferedPluginAddError(
        `${label} at ${path} could not be inspected: ${errorMessage(error)}`,
      );
    }
    try {
      await mkdir(path);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new OfferedPluginAddError(
          `${label} at ${path} could not be created: ${errorMessage(mkdirError)}`,
        );
      }
    }
    stats = await lstat(path);
  }
  if (stats.isSymbolicLink()) {
    throw new OfferedPluginAddError(
      `${label} at ${path} is a symlink or junction; refusing to use it.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new OfferedPluginAddError(`${label} at ${path} is not a directory.`);
  }
  const realDirectory = await realpath(path);
  if (!isInside(realParent, realDirectory)) {
    throw new OfferedPluginAddError(
      `${label} at ${path} resolves outside this workspace.`,
    );
  }
  return realDirectory;
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

  const realWorkspaceRoot = await realpath(workspaceRoot);
  const pluginsRoot = await ensureContainedDirectory(
    join(workspaceRoot, "plugins"),
    realWorkspaceRoot,
    "Plugins directory",
  );
  const target = join(pluginsRoot, directoryName);
  if (await pathExists(target)) throw existingTargetError(directoryName);

  // Staged under .dohc, never under plugins/: a mid-copy watcher batch would
  // otherwise list the staging directory itself as a phantom plugin
  // (discoverInstalledPlugins has no dot-prefix skip), and a crash between
  // the copy and the rename would strand it there for good. .dohc is on the
  // same volume as plugins/ (both live under workspaceRoot), so the rename
  // below stays atomic, and .dohc is already excluded from workspace
  // listing, capture, and plugin discovery.
  const dohcRoot = await ensureContainedDirectory(
    join(workspaceRoot, ".dohc"),
    realWorkspaceRoot,
    "Workspace metadata directory",
  );
  const stagingParent = await ensureContainedDirectory(
    join(dohcRoot, "plugin-offer-staging"),
    dohcRoot,
    "Plugin staging directory",
  );
  const staging = join(stagingParent, `${directoryName}-${randomUUID()}`);
  try {
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
