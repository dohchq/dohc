import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  PLUGIN_MANIFEST_FILE_NAME,
  readPluginManifestFile,
  type PluginManifestReadResult,
} from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import { EXCLUDED_SOURCE_NAMES } from "./pluginSourceSnapshot";

type PluginRootKind = "directory" | "symlink" | "invalid";

interface PluginDiscoveryCandidate {
  directoryName: string;
  rootPath: string;
  rootKind: PluginRootKind;
  manifestResult: PluginManifestReadResult | null;
  nestedManifestPaths: string[];
  diagnostics: string[];
}

export interface InstalledPluginRecord {
  id: string;
  directoryName: string;
  rootPath: string;
  manifest: DohcPluginManifest | null;
  diagnostics: string[];
  valid: boolean;
}

// Mirrors PLUGIN_ID in ipc/bridgeContract.ts. A directory name may be up to
// 255 characters, so a record with no manifest to name it would otherwise
// carry an id that ListPluginsResult.parse rejects — taking the whole list
// down with it, including the diagnostics needed to find the directory.
const PLUGIN_ID_MAX_LENGTH = 214;

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordFromCandidate(candidate: PluginDiscoveryCandidate): InstalledPluginRecord {
  const manifest = candidate.manifestResult?.ok
    ? candidate.manifestResult.manifest
    : null;
  const overLongDirectoryName = manifest === null &&
    candidate.directoryName.length > PLUGIN_ID_MAX_LENGTH;
  const diagnostics = [
    ...candidate.diagnostics,
    ...(overLongDirectoryName
      ? [
        `plugin directory name is ${candidate.directoryName.length} characters; ` +
        `a plugin id is at most ${PLUGIN_ID_MAX_LENGTH} characters, so this ` +
        "record reports a truncated id until its manifest names the plugin",
      ]
      : []),
    ...(candidate.manifestResult && !candidate.manifestResult.ok
      ? candidate.manifestResult.diagnostics
      : []),
    ...candidate.nestedManifestPaths
      .slice()
      .sort(lexicalCompare)
      .map((path) => `nested manifest ignored at ${path}`),
  ];
  return {
    id: manifest?.name ??
      candidate.directoryName.slice(0, PLUGIN_ID_MAX_LENGTH),
    directoryName: candidate.directoryName,
    rootPath: candidate.rootPath,
    manifest,
    diagnostics,
    valid:
      candidate.rootKind === "directory" &&
      manifest !== null &&
      candidate.diagnostics.length === 0,
  };
}

function classifyInstalledPlugins(
  candidates: readonly PluginDiscoveryCandidate[],
  installedDirectoryNames: ReadonlyMap<string, string>,
): InstalledPluginRecord[] {
  const records = candidates
    .slice()
    .sort((left, right) => lexicalCompare(left.directoryName, right.directoryName))
    .map(recordFromCandidate);
  const declaringPluginId = new Map<string, InstalledPluginRecord[]>();

  for (const record of records) {
    if (!record.manifest) continue;
    const declaring = declaringPluginId.get(record.id) ?? [];
    declaring.push(record);
    declaringPluginId.set(record.id, declaring);
  }
  for (const [pluginId, declaring] of declaringPluginId) {
    if (declaring.length < 2) continue;
    // The installed directory keeps the id it was installed under. Letting
    // lexical order decide handed an installation's approval, uninstall
    // paths, and identity to whichever new directory sorted first (#779
    // round 11 A4). With nothing installed under this id, first-in-order is
    // still the tiebreak.
    const installedDirectoryName = installedDirectoryNames.get(pluginId);
    const owner = declaring.find(
      (record) => record.directoryName === installedDirectoryName,
    ) ?? declaring[0];
    for (const record of declaring) {
      if (record === owner) continue;
      record.valid = false;
      record.diagnostics.push(
        `duplicate plugin id "${pluginId}": also declared at ${owner.rootPath}`,
      );
    }
  }
  return records;
}

function workspaceRelativePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

async function findNestedManifestPaths(
  workspaceRoot: string,
  pluginRoot: string,
  current = pluginRoot,
): Promise<string[]> {
  const nested: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_SOURCE_NAMES.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (current !== pluginRoot && entry.name === PLUGIN_MANIFEST_FILE_NAME) {
      nested.push(workspaceRelativePath(workspaceRoot, path));
    }
    if (entry.isDirectory()) {
      nested.push(...await findNestedManifestPaths(workspaceRoot, pluginRoot, path));
    }
  }
  return nested;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectCandidate(
  workspaceRoot: string,
  directoryName: string,
): Promise<PluginDiscoveryCandidate> {
  const rootPath = join(workspaceRoot, "plugins", directoryName);
  let rootStats: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStats = await lstat(rootPath);
  } catch (error) {
    return {
      directoryName,
      rootPath,
      rootKind: "invalid",
      manifestResult: null,
      nestedManifestPaths: [],
      diagnostics: [
        `plugin root at ${rootPath} could not be inspected: ${errorMessage(error)}`,
      ],
    };
  }

  if (rootStats.isSymbolicLink()) {
    return {
      directoryName,
      rootPath,
      rootKind: "symlink",
      manifestResult: null,
      nestedManifestPaths: [],
      diagnostics: [
        `plugin root at ${rootPath} is a symlink; plugin roots must be real directories`,
      ],
    };
  }
  if (!rootStats.isDirectory()) {
    return {
      directoryName,
      rootPath,
      rootKind: "invalid",
      manifestResult: null,
      nestedManifestPaths: [],
      diagnostics: [`plugin root at ${rootPath} is not a directory`],
    };
  }

  // An unreadable nested directory (EACCES/EPERM, e.g.) must invalidate only
  // this one candidate — not the whole discoverInstalledPlugins batch it's
  // Promise.all'd into below (CodeRabbit #779 R12).
  let manifestResult: PluginManifestReadResult;
  let nestedManifestPaths: string[];
  try {
    [manifestResult, nestedManifestPaths] = await Promise.all([
      readPluginManifestFile(rootPath),
      findNestedManifestPaths(workspaceRoot, rootPath),
    ]);
  } catch (error) {
    return {
      directoryName,
      rootPath,
      rootKind: "invalid",
      manifestResult: null,
      nestedManifestPaths: [],
      diagnostics: [
        `plugin root at ${rootPath} could not be fully inspected: ${errorMessage(error)}`,
      ],
    };
  }
  return {
    directoryName,
    rootPath,
    rootKind: "directory",
    manifestResult,
    nestedManifestPaths,
    diagnostics: [],
  };
}

/**
 * @param installedDirectoryNames The `plugins/` directory each installed
 * plugin id was installed from, from the workspace's plugin local state. It
 * decides which root keeps an id that two roots declare.
 */
export async function discoverInstalledPlugins(
  workspaceRoot: string,
  installedDirectoryNames: ReadonlyMap<string, string>,
): Promise<InstalledPluginRecord[]> {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const pluginsRoot = join(resolvedWorkspaceRoot, "plugins");
  let entries: Dirent[];
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const candidateNames = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(lexicalCompare);
  const candidates = await Promise.all(
    candidateNames.map((directoryName) =>
      inspectCandidate(resolvedWorkspaceRoot, directoryName),
    ),
  );
  return classifyInstalledPlugins(candidates, installedDirectoryNames);
}
