import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  PLUGIN_MANIFEST_FILE_NAME,
  readPluginManifestFile,
  type PluginManifestReadResult,
} from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import { verifyPluginIcon } from "./pluginIcon";
import { EXCLUDED_SOURCE_NAMES } from "./pluginSourceSnapshot";
import { errorMessage, lexicalCompare } from "./pluginShared";

type PluginRootKind = "directory" | "symlink" | "invalid";

interface PluginDiscoveryCandidate {
  directoryName: string;
  rootPath: string;
  rootKind: PluginRootKind;
  manifestResult: PluginManifestReadResult | null;
  /** The manifest's icon, once the file behind it checked out. */
  iconPath: string | null;
  iconDiagnostics: string[];
  nestedManifestPaths: string[];
  diagnostics: string[];
}

export interface InstalledPluginRecord {
  id: string;
  directoryName: string;
  rootPath: string;
  manifest: DohcPluginManifest | null;
  /**
   * The manifest's declared icon, plugin-root-relative, and only when the
   * file behind it is a real file inside the root and within the icon cap.
   * An icon that fails any of those is null with a diagnostic, never a
   * broken row.
   */
  iconPath: string | null;
  diagnostics: string[];
  valid: boolean;
  /**
   * Set only on a record that just lost discovery's duplicate-id tie-break:
   * the manifest id another directory kept instead. A caller that needs to
   * know whether ITS OWN directory got displaced by this one reads this
   * field, never `diagnostics` — that array is bounded and re-worded for
   * display, so it is not a stable place to detect a specific collision
   * from code (#779-style: display text and machine-checked state must not
   * be the same value).
   */
  supersededPluginId: string | null;
}

// Mirrors PLUGIN_ID in ipc/bridgeContract.ts. A directory name may be up to
// 255 characters, so a record with no manifest to name it would otherwise
// carry an id that ListPluginsResult.parse rejects — taking the whole list
// down with it, including the diagnostics needed to find the directory.
const PLUGIN_ID_MAX_LENGTH = 214;

function recordFromCandidate(candidate: PluginDiscoveryCandidate): InstalledPluginRecord {
  const manifest = candidate.manifestResult?.ok
    ? candidate.manifestResult.manifest
    : null;
  const overLongDirectoryName = manifest === null &&
    candidate.directoryName.length > PLUGIN_ID_MAX_LENGTH;
  const diagnostics = [
    ...candidate.diagnostics,
    ...candidate.iconDiagnostics,
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
    iconPath: candidate.iconPath,
    diagnostics,
    valid:
      candidate.rootKind === "directory" &&
      manifest !== null &&
      candidate.diagnostics.length === 0,
    supersededPluginId: null,
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
      // The loser keeps no claim on the shared id. Reporting it under that
      // id gave two records one id — duplicate list keys, a status event
      // for the owner collapsing the loser's diagnostics row, and id joins
      // (status seeding, door-write attribution) handing the loser the
      // owner's installation. Its directory names it instead, the same
      // identity a manifest-less candidate gets (#779 round 14 A4).
      record.id = record.directoryName.slice(0, PLUGIN_ID_MAX_LENGTH);
      record.supersededPluginId = pluginId;
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
      iconPath: null,
      iconDiagnostics: [],
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
      iconPath: null,
      iconDiagnostics: [],
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
      iconPath: null,
      iconDiagnostics: [],
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
      iconPath: null,
      iconDiagnostics: [],
      nestedManifestPaths: [],
      diagnostics: [
        `plugin root at ${rootPath} could not be fully inspected: ${errorMessage(error)}`,
      ],
    };
  }
  // Only a valid manifest can declare an icon, and only a checked icon is
  // advertised. A refusal is a diagnostic, never a reason to invalidate the
  // plugin — `valid` reads candidate.diagnostics, which this is not part of.
  const declaredIcon = manifestResult.ok ? manifestResult.manifest.icon : undefined;
  const iconCheck = declaredIcon
    ? await verifyPluginIcon(rootPath, declaredIcon)
    : { icon: null, diagnostic: null };

  return {
    directoryName,
    rootPath,
    rootKind: "directory",
    manifestResult,
    iconPath: iconCheck.icon,
    iconDiagnostics: iconCheck.diagnostic ? [iconCheck.diagnostic] : [],
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
