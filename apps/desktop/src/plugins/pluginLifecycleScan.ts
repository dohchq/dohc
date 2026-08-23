import { constants, type Dirent } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { load } from "js-yaml";
import {
  NPM_PACKAGE_NAME,
  type DohcPluginManifest,
} from "./pluginManifestSchema";
import { isInside } from "../security/pathContainment";
import { errorMessage, lexicalCompare } from "./pluginShared";

// `prepublish` is deliberately absent. Measured against the pinned
// pnpm@11.20.0 on 2026-08-14, with `postinstall` as the control in every
// fixture:
//   - Root project, `pnpm install`: the postinstall marker appeared, the
//     prepublish marker did not.
//   - Dependency (single-hook tarball fixtures, `pnpm install`): the
//     postinstall-only dependency raised ERR_PNPM_IGNORED_BUILDS, while the
//     prepublish-only dependency installed clean with no such notice.
// pnpm never runs it on install, so listing it here would block packages that
// legitimately use `prepublish` for publish-time work.
const ROOT_HOOKS = [
  "pnpm:devPreinstall",
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
] as const;
// The design doc requires catching a skipped lifecycle script "whatever the
// hook's name" for every installed package, not a hand-picked subset — reuse
// ROOT_HOOKS verbatim so the two can never drift apart again (CERT779
// finding 2: a dependency declaring only preprepare scanned clean).
const DEPENDENCY_HOOKS = ROOT_HOOKS;

// Measured on 2026-08-13 from pnpm@11.20.0 isolated installs. The fresh
// small fixture's zod manifest was 3,796 bytes. The repository install's
// @babel/runtime and drizzle-orm manifests were 41,106 and 177,277 bytes.
// A 256 KiB bound stays above the largest measured healthy manifest.
export const PLUGIN_PACKAGE_MANIFEST_MAX_BYTES = 262_144;

const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export type PluginLifecycleHook =
  | typeof ROOT_HOOKS[number]
  | typeof DEPENDENCY_HOOKS[number];

export interface PluginLifecycleDiagnostic {
  name: string;
  version: string;
  hook: PluginLifecycleHook;
  command: string;
  manifestPath: string;
}

export class PluginInstallationIntegrityError extends Error {
  readonly code = "installation-integrity" as const;

  constructor(
    message: string,
    readonly path: string | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PluginInstallationIntegrityError";
  }
}

export class PluginLifecycleUnsupportedHooksError extends Error {
  readonly code = "unsupported-lifecycle-hook" as const;

  constructor(
    readonly findings: PluginLifecycleDiagnostic[],
    readonly userFacingLines: string[],
  ) {
    super(
      `Plugin install found ${userFacingLines.length} unsupported lifecycle ` +
        "hook entries. Remove the hooks or allow reviewed packages in allowSkippedScripts.",
    );
    this.name = "PluginLifecycleUnsupportedHooksError";
  }
}

export type PluginLifecycleScanResult =
  | {
    ok: true;
    warnings: PluginLifecycleDiagnostic[];
    warningLines: string[];
  }
  | {
    ok: false;
    error:
      | PluginInstallationIntegrityError
      | PluginLifecycleUnsupportedHooksError;
    warnings: PluginLifecycleDiagnostic[];
    warningLines: string[];
  };

export interface ScanPluginLifecycleInput {
  snapshotRoot: string;
  manifest: DohcPluginManifest;
}

interface PackageManifestRecord {
  name: string;
  version: string;
  scripts: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareDiagnostics(
  left: PluginLifecycleDiagnostic,
  right: PluginLifecycleDiagnostic,
): number {
  return (
    lexicalCompare(left.name, right.name) ||
    lexicalCompare(left.version, right.version) ||
    lexicalCompare(left.hook, right.hook) ||
    lexicalCompare(left.manifestPath, right.manifestPath)
  );
}

async function pathStats(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `Installation entry at ${path} could not be inspected: ${errorMessage(error)}`,
      path,
      error,
    );
  }
}

async function directoryEntries(
  path: string,
): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `Installation directory at ${path} could not be read: ${errorMessage(error)}`,
      path,
    );
  }
}

async function resolveRealDirectory(path: string, label: string): Promise<string> {
  const stats = await pathStats(path);
  if (stats.isSymbolicLink()) {
    throw new PluginInstallationIntegrityError(
      `${label} at ${path} is a symlink or junction.`,
      path,
    );
  }
  if (!stats.isDirectory()) {
    throw new PluginInstallationIntegrityError(
      `${label} at ${path} is not a directory.`,
      path,
    );
  }
  try {
    return await realpath(path);
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `${label} at ${path} could not be resolved: ${errorMessage(error)}`,
      path,
    );
  }
}

/**
 * Same as resolveRealDirectory, except a missing path returns null instead
 * of failing closed. Only for node_modules itself: a zero-dependency frozen
 * install legitimately creates none. Every other check in this scan (the
 * plugin root, the virtual store once node_modules exists, each physical
 * package) still fails closed on ENOENT via resolveRealDirectory.
 */
async function resolveOptionalRealDirectory(
  path: string,
  label: string,
): Promise<string | null> {
  try {
    return await resolveRealDirectory(path, label);
  } catch (error) {
    if (
      error instanceof PluginInstallationIntegrityError &&
      isEnoentAt(error, path)
    ) {
      return null;
    }
    throw error;
  }
}

function isEnoentAt(
  error: PluginInstallationIntegrityError,
  path: string,
): boolean {
  // Branches on the wrapped Node error's actual errno code, not a substring
  // match against the composed message (CodeRabbit #779 R22) — the message
  // happens to start with "ENOENT: ..." by Node convention, not by
  // contract, so any future rewording of pathStats's own message would
  // silently break the zero-dependency-install fast path below without
  // this.
  return (
    error.path === path &&
    (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
  );
}

async function readContainedManifest(
  manifestPath: string,
  realContainmentRoot: string,
): Promise<Record<string, unknown>> {
  let realManifestPath: string;
  try {
    realManifestPath = await realpath(manifestPath);
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `Package manifest at ${manifestPath} could not be resolved: ${errorMessage(error)}`,
      manifestPath,
    );
  }
  if (!isInside(realContainmentRoot, realManifestPath)) {
    throw new PluginInstallationIntegrityError(
      `Package manifest at ${manifestPath} resolves outside ${realContainmentRoot}.`,
      manifestPath,
    );
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(realManifestPath, READ_NO_FOLLOW);
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `Package manifest at ${manifestPath} could not be opened: ${errorMessage(error)}`,
      manifestPath,
    );
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new PluginInstallationIntegrityError(
        `Package manifest at ${manifestPath} is not a regular file.`,
        manifestPath,
      );
    }
    if (stats.size > PLUGIN_PACKAGE_MANIFEST_MAX_BYTES) {
      throw new PluginInstallationIntegrityError(
        `Package manifest at ${manifestPath} is ${stats.size} bytes. ` +
          `The lifecycle scan limit is ${PLUGIN_PACKAGE_MANIFEST_MAX_BYTES} bytes.`,
        manifestPath,
      );
    }
    const body = await handle.readFile("utf8");
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch (error) {
      throw new PluginInstallationIntegrityError(
        `Package manifest at ${manifestPath} is not valid JSON: ${errorMessage(error)}`,
        manifestPath,
      );
    }
    if (!isRecord(value)) {
      throw new PluginInstallationIntegrityError(
        `Package manifest at ${manifestPath} must contain a JSON object.`,
        manifestPath,
      );
    }
    return value;
  } finally {
    await handle.close();
  }
}

function packageManifestRecord(
  value: Record<string, unknown>,
  manifestPath: string,
  fallback?: { name: string; version: string },
): PackageManifestRecord {
  const name = typeof value.name === "string" && value.name.trim() !== ""
    ? value.name
    : fallback?.name;
  const version = typeof value.version === "string" && value.version.trim() !== ""
    ? value.version
    : fallback?.version;
  if (!name || !version) {
    throw new PluginInstallationIntegrityError(
      `Package manifest at ${manifestPath} must name a package and version.`,
      manifestPath,
    );
  }
  return {
    name,
    version,
    scripts: isRecord(value.scripts) ? value.scripts : null,
  };
}

function collectHooks(
  target: PluginLifecycleDiagnostic[],
  manifest: PackageManifestRecord,
  manifestPath: string,
  hooks: readonly PluginLifecycleHook[],
): void {
  if (!manifest.scripts) return;
  for (const hook of hooks) {
    const command = manifest.scripts[hook];
    if (typeof command !== "string" || command.trim() === "") continue;
    target.push({
      name: manifest.name,
      version: manifest.version,
      hook,
      command,
      manifestPath,
    });
  }
}

async function locateVirtualStore(
  nodeModulesRoot: string,
  realNodeModulesRoot: string,
): Promise<string | null> {
  const modulesPath = join(nodeModulesRoot, ".modules.yaml");
  let realModulesPath: string;
  try {
    realModulesPath = await realpath(modulesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Measured with pnpm@11.20.0: a healthy zero-dependency frozen install
      // creates node_modules but omits .modules.yaml. Accept only that empty
      // physical-store shape. Package entries without metadata remain an
      // installation-integrity failure.
      const topLevelEntries = await directoryEntries(realNodeModulesRoot);
      const unexpectedTopLevel = topLevelEntries.filter((entry) =>
        entry.name !== ".pnpm" &&
        entry.name !== ".package-map.json" &&
        entry.name !== ".pnpm-workspace-state-v1.json"
      );
      let physicalPackageDirectories = 0;
      const virtualStorePath = join(realNodeModulesRoot, ".pnpm");
      try {
        const virtualEntries = await readdir(virtualStorePath, { withFileTypes: true });
        physicalPackageDirectories = virtualEntries.filter((entry) =>
          entry.isDirectory() && entry.name !== "node_modules"
        ).length;
      } catch (virtualError) {
        if ((virtualError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw virtualError;
        }
      }
      if (unexpectedTopLevel.length === 0 && physicalPackageDirectories === 0) {
        return null;
      }
      throw new PluginInstallationIntegrityError(
        `pnpm metadata at ${modulesPath} is missing while node_modules contains ` +
          `${unexpectedTopLevel.map((entry) => entry.name).join(", ") || "no top-level package entries"} ` +
          `and ${physicalPackageDirectories} physical package directories.`,
        modulesPath,
      );
    }
    throw new PluginInstallationIntegrityError(
      `pnpm metadata at ${modulesPath} could not be resolved: ${errorMessage(error)}`,
      modulesPath,
    );
  }
  if (!isInside(realNodeModulesRoot, realModulesPath)) {
    throw new PluginInstallationIntegrityError(
      `pnpm metadata at ${modulesPath} resolves outside ${realNodeModulesRoot}.`,
      modulesPath,
    );
  }

  let body: string;
  try {
    body = await readFile(realModulesPath, "utf8");
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `pnpm metadata at ${modulesPath} could not be read: ${errorMessage(error)}`,
      modulesPath,
    );
  }
  let value: unknown;
  try {
    value = load(body, { filename: modulesPath });
  } catch (error) {
    throw new PluginInstallationIntegrityError(
      `pnpm metadata at ${modulesPath} is not valid YAML: ${errorMessage(error)}`,
      modulesPath,
    );
  }
  if (!isRecord(value) || typeof value.virtualStoreDir !== "string") {
    throw new PluginInstallationIntegrityError(
      `pnpm metadata at ${modulesPath} must define virtualStoreDir.`,
      modulesPath,
    );
  }

  const configuredPath = isAbsolute(value.virtualStoreDir)
    ? resolve(value.virtualStoreDir)
    : resolve(nodeModulesRoot, value.virtualStoreDir);
  const realVirtualStore = await resolveRealDirectory(
    configuredPath,
    "pnpm virtual store",
  );
  if (!isInside(realNodeModulesRoot, realVirtualStore)) {
    throw new PluginInstallationIntegrityError(
      `pnpm virtual store at ${configuredPath} resolves outside ${realNodeModulesRoot}.`,
      configuredPath,
    );
  }
  return realVirtualStore;
}

async function listPhysicalPackageDirectories(
  realVirtualStore: string,
): Promise<string[]> {
  const packageDirectories: string[] = [];
  const entries = await directoryEntries(realVirtualStore);
  entries.sort((left, right) => lexicalCompare(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const entryPath = join(realVirtualStore, entry.name);
    const entryStats = await pathStats(entryPath);
    if (entryStats.isSymbolicLink() || !entryStats.isDirectory()) continue;

    const entryModules = join(entryPath, "node_modules");
    let entryModulesStats: Awaited<ReturnType<typeof lstat>>;
    try {
      entryModulesStats = await lstat(entryModules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new PluginInstallationIntegrityError(
        `Virtual-store package directory at ${entryModules} could not be inspected: ` +
          errorMessage(error),
        entryModules,
      );
    }
    if (entryModulesStats.isSymbolicLink()) {
      throw new PluginInstallationIntegrityError(
        `Virtual-store package directory at ${entryModules} is a symlink or junction.`,
        entryModules,
      );
    }
    if (!entryModulesStats.isDirectory()) continue;

    const packageEntries = await directoryEntries(entryModules);
    packageEntries.sort((left, right) => lexicalCompare(left.name, right.name));
    for (const packageEntry of packageEntries) {
      const packagePath = join(entryModules, packageEntry.name);
      const packageStats = await pathStats(packagePath);
      if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) continue;

      if (packageEntry.name.startsWith("@")) {
        const scopedEntries = await directoryEntries(packagePath);
        scopedEntries.sort((left, right) => lexicalCompare(left.name, right.name));
        for (const scopedEntry of scopedEntries) {
          const scopedName = `${packageEntry.name}/${scopedEntry.name}`;
          if (!NPM_PACKAGE_NAME.test(scopedName)) continue;
          const scopedPath = join(packagePath, scopedEntry.name);
          const scopedStats = await pathStats(scopedPath);
          if (scopedStats.isSymbolicLink() || !scopedStats.isDirectory()) continue;
          packageDirectories.push(scopedPath);
        }
        continue;
      }

      if (NPM_PACKAGE_NAME.test(packageEntry.name)) {
        packageDirectories.push(packagePath);
      }
    }
  }
  return packageDirectories;
}

function isAllowed(
  allowSkippedScripts: DohcPluginManifest["allowSkippedScripts"],
  packageName: string,
): boolean {
  return (
    allowSkippedScripts === true ||
    (Array.isArray(allowSkippedScripts) && allowSkippedScripts.includes(packageName))
  );
}

function userFacingLine(finding: PluginLifecycleDiagnostic): string {
  return `Package "${finding.name}" ${finding.version} defines skipped ${finding.hook} hook.`;
}

function warningLine(finding: PluginLifecycleDiagnostic): string {
  return `Package "${finding.name}" ${finding.version} allows skipped ${finding.hook} hook.`;
}

function uniqueLines(
  findings: PluginLifecycleDiagnostic[],
  render: (finding: PluginLifecycleDiagnostic) => string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const line = render(finding);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

export async function scanPluginLifecycleScripts(
  input: ScanPluginLifecycleInput,
): Promise<PluginLifecycleScanResult> {
  try {
    const realSnapshotRoot = await resolveRealDirectory(
      resolve(input.snapshotRoot),
      "Plugin snapshot root",
    );
    const diagnostics: PluginLifecycleDiagnostic[] = [];

    const rootManifestPath = join(realSnapshotRoot, "package.json");
    const rootValue = await readContainedManifest(rootManifestPath, realSnapshotRoot);
    const rootManifest = packageManifestRecord(rootValue, rootManifestPath, {
      name: input.manifest.name,
      version: "unknown",
    });
    collectHooks(diagnostics, rootManifest, rootManifestPath, ROOT_HOOKS);

    // A frozen install with zero dependencies is a real, healthy pnpm
    // outcome (measured directly against this machine's pinned pnpm@11.20.0:
    // an install with no dependencies creates no node_modules directory at
    // all, not merely an empty one) — there is nothing to scan, not a
    // corrupted install.
    const nodeModulesRoot = join(realSnapshotRoot, "node_modules");
    const realNodeModulesRoot = await resolveOptionalRealDirectory(
      nodeModulesRoot,
      "Plugin node_modules directory",
    );
    const realVirtualStore = realNodeModulesRoot
      ? await locateVirtualStore(nodeModulesRoot, realNodeModulesRoot)
      : null;
    if (realVirtualStore) {
      const packageDirectories = await listPhysicalPackageDirectories(
        realVirtualStore,
      );
      for (const packageDirectory of packageDirectories) {
        const manifestPath = join(packageDirectory, "package.json");
        const value = await readContainedManifest(manifestPath, realVirtualStore);
        const manifest = packageManifestRecord(value, manifestPath);
        collectHooks(diagnostics, manifest, manifestPath, DEPENDENCY_HOOKS);
      }
    }

    diagnostics.sort(compareDiagnostics);
    const warnings = diagnostics.filter((finding) =>
      isAllowed(input.manifest.allowSkippedScripts, finding.name));
    const blocking = diagnostics.filter((finding) =>
      !isAllowed(input.manifest.allowSkippedScripts, finding.name));
    const warningLines = uniqueLines(warnings, warningLine);
    if (blocking.length === 0) {
      return { ok: true, warnings, warningLines };
    }
    return {
      ok: false,
      error: new PluginLifecycleUnsupportedHooksError(
        blocking,
        uniqueLines(blocking, userFacingLine),
      ),
      warnings,
      warningLines,
    };
  } catch (error) {
    const integrityError = error instanceof PluginInstallationIntegrityError
      ? error
      : new PluginInstallationIntegrityError(
        `Plugin lifecycle scan could not inspect the installation: ${errorMessage(error)}`,
      );
    return {
      ok: false,
      error: integrityError,
      warnings: [],
      warningLines: [],
    };
  }
}
