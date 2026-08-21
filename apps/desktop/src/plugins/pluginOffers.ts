import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
} from "node:fs/promises";
import { join, relative } from "node:path";
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

function existingTargetError(directoryName: string): OfferedPluginAddError {
  return new OfferedPluginAddError(
    `plugins/${directoryName} already exists in this workspace.`,
  );
}

function copyFailure(
  directoryName: string,
  error: unknown,
): OfferedPluginAddError {
  if (error instanceof OfferedPluginAddError) return error;
  return new OfferedPluginAddError(
    `dohc could not add plugins/${directoryName}. ${errorMessage(error)}`,
  );
}

async function copySourceTree(
  sourceRoot: string,
  destinationRoot: string,
  pluginRoot: string = sourceRoot,
): Promise<void> {
  const sourceStats = await lstat(sourceRoot);
  const sourcePath = relative(pluginRoot, sourceRoot).replaceAll("\\", "/") || ".";
  if (sourceStats.isSymbolicLink()) {
    throw new OfferedPluginAddError(
      `dohc could not add this plugin because its built-in source contains a link at ${sourcePath}.`,
    );
  }
  if (!sourceStats.isDirectory()) {
    throw new OfferedPluginAddError(
      "dohc could not add this plugin because its built-in source is not a directory.",
    );
  }

  await mkdir(destinationRoot, { recursive: true });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (EXCLUDED_SOURCE_NAMES.has(entry.name) || entry.name === "dist") continue;
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    const stats = await lstat(source);
    const entryPath = relative(pluginRoot, source).replaceAll("\\", "/");
    if (stats.isSymbolicLink()) {
      throw new OfferedPluginAddError(
        `dohc could not add this plugin because its built-in source contains a link at ${entryPath}.`,
      );
    }
    if (stats.isDirectory()) {
      await copySourceTree(source, destination, pluginRoot);
      continue;
    }
    if (!stats.isFile()) {
      throw new OfferedPluginAddError(
        `dohc could not add this plugin because its built-in source contains an unsupported entry at ${entryPath}.`,
      );
    }
    await copyFile(source, destination);
  }
}

export async function addOfferedPlugin(params: {
  builtinPluginsRoot: string;
  workspaceRoot: string;
  directoryName: string;
}): Promise<{ rootPath: string }> {
  const { builtinPluginsRoot, workspaceRoot, directoryName } = params;
  if (!isBuiltinDriverPlugin(directoryName)) {
    throw new OfferedPluginAddError(
      `dohc cannot add ${directoryName} because it is not a built-in driver plugin.`,
    );
  }

  const pluginsRoot = join(workspaceRoot, "plugins");
  const target = join(pluginsRoot, directoryName);
  try {
    if (await pathExists(target)) throw existingTargetError(directoryName);
  } catch (error) {
    throw copyFailure(directoryName, error);
  }

  const staging = join(pluginsRoot, `.offer-staging-${randomUUID()}`);
  try {
    await mkdir(pluginsRoot, { recursive: true });
    await copySourceTree(join(builtinPluginsRoot, directoryName), staging);
    if (await pathExists(target)) throw existingTargetError(directoryName);
    await renameWithWindowsRetry(staging, target, (error) =>
      copyFailure(directoryName, error));
    return { rootPath: target };
  } catch (error) {
    try {
      await removeStaging(staging);
    } catch (cleanupError) {
      throw copyFailure(directoryName, cleanupError);
    }
    throw copyFailure(directoryName, error);
  }
}
