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

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordFromCandidate(candidate: PluginDiscoveryCandidate): InstalledPluginRecord {
  const manifest = candidate.manifestResult?.ok
    ? candidate.manifestResult.manifest
    : null;
  const diagnostics = [
    ...candidate.diagnostics,
    ...(candidate.manifestResult && !candidate.manifestResult.ok
      ? candidate.manifestResult.diagnostics
      : []),
    ...candidate.nestedManifestPaths
      .slice()
      .sort(lexicalCompare)
      .map((path) => `nested manifest ignored at ${path}`),
  ];
  return {
    id: manifest?.name ?? candidate.directoryName,
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
): InstalledPluginRecord[] {
  const records = candidates
    .slice()
    .sort((left, right) => lexicalCompare(left.directoryName, right.directoryName))
    .map(recordFromCandidate);
  const firstRootByPluginId = new Map<string, string>();

  for (const record of records) {
    if (!record.manifest) continue;
    const firstRoot = firstRootByPluginId.get(record.id);
    if (firstRoot === undefined) {
      firstRootByPluginId.set(record.id, record.rootPath);
      continue;
    }
    record.valid = false;
    record.diagnostics.push(
      `duplicate plugin id "${record.id}": also declared at ${firstRoot}`,
    );
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

export async function discoverInstalledPlugins(
  workspaceRoot: string,
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
  return classifyInstalledPlugins(candidates);
}
