import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { load } from "js-yaml";
import {
  NPM_PACKAGE_NAME,
  type DohcPluginManifest,
} from "./pluginManifestSchema";
import { workspaceStateKey } from "./pluginLocalState";
import {
  errorMessage,
  isInside,
  lexicalCompare,
  removeStaging,
  renameWithWindowsRetry,
  WINDOWS_RENAME_RETRY_DELAYS_MS,
} from "./pluginShared";

// CodeRabbit #779 R25: a byte bound before JSON.parse/js-yaml load, so an
// oversized plugin-authored package.json/pnpm-lock.yaml fails with a named
// limit instead of forcing a full parse of arbitrary-size, attacker-
// controlled text. Measured 2026-08-13 (see
// the measurement suite in pluginSourceSnapshot.test.ts): the
// real "large" reference fixture's package.json was 490 bytes and its
// pnpm-lock.yaml (209 entries) was 71,329 bytes. Both bounds round upward
// to a clean value with comfortable headroom over that measured maximum.
export const MAX_PLUGIN_PACKAGE_JSON_BYTES = 262_144;
export const MAX_PLUGIN_LOCKFILE_BYTES = 1_048_576;

/** The published source tree's directory name inside a plugin's live root. */
export const PLUGIN_SNAPSHOT_DIR_NAME = "snapshot";
/**
 * A staged source tree is a sibling of the live root, never a directory
 * inside it — the same placement the build's own staging uses, and for the
 * same reason: the child-process broker's containment is rooted at the live
 * root, so unpublished bytes parked inside it are reachable (#779 round 7 A1,
 * round 9 B1).
 */
export const SNAPSHOT_STAGING_SUFFIX = ".snap-staging-";
/** Where a build writes its output before it replaces the live root. */
export const BUILD_STAGING_SUFFIX = ".staging-";
/** Where the build parks the old live root while it swaps the new one in. */
export const BUILD_PREVIOUS_SUFFIX = ".previous-";
/** Every family of sibling directory this pipeline creates beside a live
 * plugin root. Each one is `<liveRoot><suffix><randomUUID()>`. */
export const PLUGIN_ROOT_ARTIFACT_SUFFIXES = [
  SNAPSHOT_STAGING_SUFFIX,
  BUILD_STAGING_SUFFIX,
  BUILD_PREVIOUS_SUFFIX,
] as const;
const ARTIFACT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PINNED_PLUGIN_PNPM_VERSION = "11.20.0";
export const PINNED_PLUGIN_PACKAGE_MANAGER =
  `pnpm@${PINNED_PLUGIN_PNPM_VERSION}`;

// Measured on 2026-08-13. See
// the measurement suite in pluginSourceSnapshot.test.ts and its
// 2026-08-13 correction: the original bundle measurement embedded a JSON string
// constant rather than bundling real dependency code, so it under-measured
// real work. A real bundle of react + react-dom + lucide-react + zod (98
// input files, 4,601,978 input bytes) took 550.465 ms on first build after
// a fresh install (cold OS file cache) and 278.561-302.402 ms on warm
// re-bundles. The install measurement's methodology was already
// representative and is unchanged.
export const PLUGIN_INSTALL_TIMEOUT_MS = 30_000;
export const PLUGIN_BUNDLE_TIMEOUT_MS = 3_000;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
// Shared with pluginDiscovery.ts's nested-manifest walk (CodeRabbit #779
// R11/R12): one excluded-name list, so the two can never drift apart.
export const EXCLUDED_SOURCE_NAMES = new Set(["node_modules", ".dohc"]);

/**
 * Package-manager configuration a plugin author must not supply. The install
 * runs pnpm with dohc's own registry, store, and output settings; every file
 * here is a second place pnpm would read those settings from, inside a tree
 * the plugin author writes (CERT779H).
 *
 * Verified against pnpm/pnpm at ebc48abdc5510fa9bf9c0d3bc3be93ae2580d13c,
 * subtree `pnpm11/`.
 *
 * `.npmrc` was the live hole: `PNPM_CONFIG_REGISTRY` writes only
 * `registries.default` (config/reader/src/index.ts:564-570), and no env var
 * can express `@scope:registry` at all (config/reader/src/env.ts:42-55), so a
 * snapshot `.npmrc` still chose the registry every scoped dependency came
 * from (config/pick-registry-for-package/src/index.ts:3-6) and still chose
 * `proxy`, `https-proxy`, and `strict-ssl` for all of them
 * (config/reader/src/localConfig.ts:17-24).
 *
 * `.pnpmfile.mjs` and `.pnpmfile.cjs` execute on require, before any hook
 * runs (hooks/pnpmfile/src/requirePnpmfile.ts:52-55). Only
 * `--ignore-pnpmfile` stops the load; `--ignore-scripts` does not, and
 * `--ignore-workspace` moves the lookup to the install directory itself
 * (pnpm/src/getConfig.ts:86-93, cli/parse-cli-args/src/index.ts:307). The
 * install passes `--ignore-pnpmfile`, which stays as depth.
 *
 * `pnpm-workspace.yaml` is inert under `--ignore-workspace`
 * (config/reader/src/index.ts:474-489), but it is where pnpm 11 reads
 * `trust-lockfile`, which switches the lockfile tarball-URL verifier off
 * entirely (installing/deps-installer/src/install/index.ts:437), and
 * `patchedDependencies`, which applies whatever `--ignore-scripts` says
 * (building/during-install/src/index.ts:241-250).
 *
 * `npmrc` and `pnpmfile.cjs` are absent because pnpm 11 does not read them
 * from this directory: rejecting them would be policy about nothing.
 */
export const REJECTED_PACKAGE_MANAGER_CONFIG_NAMES = new Set([
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "pnpm-workspace.yaml",
]);
const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

type LocalDependencyProtocol = "file:" | "link:" | "workspace:";

export type PluginSourceSnapshotFailureCode =
  | "invalid-plugin-id"
  | "invalid-plugin-root"
  | "invalid-output-path"
  | "unsafe-source-entry"
  | "invalid-package-json"
  | "invalid-lockfile"
  | "unsupported-package-manager"
  | "unsupported-package-manager-config"
  | "unsupported-local-dependency"
  | "snapshot-locked"
  | "snapshot-io";

export interface PluginSourceSnapshotError {
  code: PluginSourceSnapshotFailureCode;
  message: string;
  path: string | null;
}

export interface PluginPnpmPaths {
  storeDir: string;
  cacheDir: string;
  stateDir: string;
  /** HOME/USERPROFILE for the install child process (CodeRabbit #779 R18) —
   * plugin-scoped and empty, so pnpm never reads this machine's real
   * ~/.npmrc (which can hold registry auth tokens) for a plugin-authored
   * install. */
  homeDir: string;
}

export interface SnapshotPluginSourceInput {
  workspaceRoot: string;
  /** The app's own userData directory (WorkspaceRegistry.stateDir()), never
   * a workspace-relative path. dohcDir below must resolve inside it. */
  stateDir: string;
  dohcDir: string;
  pluginId: string;
  pluginRoot: string;
  manifest: DohcPluginManifest;
  /**
   * A caller that only needs to verify source still matches an already-
   * approved hash (enable(), ensureStarted(), reconcileApprovedCandidate())
   * passes it here. When the freshly-hashed source matches, the existing
   * snapshot — and its installed node_modules, which live inside it — is
   * left untouched instead of being destructively replaced (CodeRabbit
   * #779 fixround Section B item 11: a hash-check reconcile was rebuilding
   * the snapshot from scratch, discarding a perfectly good install, even
   * when nothing had actually changed).
   */
  preserveIfHashMatches?: string;
}

export interface PluginSourceFileDigest {
  relPath: string;
  sha256: string;
}

export interface PluginSourceDigest {
  sourceHash: string;
  files: PluginSourceFileDigest[];
}

export type PluginSourceSnapshotResult =
  | {
    ok: true;
    /**
     * Where this validated source tree is right now: a staged directory
     * beside the live root until `publish()`, or the live snapshot itself
     * when an already-matching one was preserved. Install, scan, and build
     * all read from here, so a tree held for approval is never the tree a
     * panel or a brokered child can reach (#779 round 9 B1).
     */
    snapshotRoot: string;
    sourceHash: string;
    /** The full digest already computed to produce sourceHash — callers
     * that need per-file hashes (the install baseline manifest) reuse this
     * instead of re-hashing the whole tree a second time (fixround Section
     * C F1). */
    digest: PluginSourceDigest;
    pnpmPaths: PluginPnpmPaths;
    /**
     * Swaps the staged tree into the live snapshot. Call it only once the
     * record approving `sourceHash` is durable: everything the live snapshot
     * serves — panel assets, and the `snapshot/server.mjs` a brokered child
     * runs — executes without any further gate. A preserved snapshot is
     * already live, so this does nothing.
     */
    publish: () => Promise<void>;
    /**
     * Drops the staged tree. The live snapshot was never touched, so there
     * is nothing to restore — and nothing to delete when the existing
     * snapshot was preserved.
     */
    discard: () => Promise<void>;
  }
  | {
    ok: false;
    error: PluginSourceSnapshotError;
    pnpmPaths: PluginPnpmPaths;
  };

interface LocalDependencySpec {
  packageName: string;
  spec: string;
  protocol: LocalDependencyProtocol;
  field: string;
}

class SnapshotError extends Error {
  readonly code: PluginSourceSnapshotFailureCode;
  readonly path: string | null;

  constructor(
    code: PluginSourceSnapshotFailureCode,
    message: string,
    path: string | null = null,
  ) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDependencyProtocol(spec: string): LocalDependencyProtocol | null {
  if (spec.startsWith("file:")) return "file:";
  if (spec.startsWith("link:")) return "link:";
  if (spec.startsWith("workspace:")) return "workspace:";
  return null;
}

function embeddedLocalDependencySpec(value: string): {
  protocol: LocalDependencyProtocol;
  spec: string;
  index: number;
} | null {
  const matches = (["file:", "link:", "workspace:"] as const)
    .map((protocol) => ({ protocol, index: value.indexOf(protocol) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index);
  const match = matches[0];
  if (!match) return null;
  const closingParenthesis = value.indexOf(")", match.index);
  const end = closingParenthesis >= 0 ? closingParenthesis : value.length;
  return {
    protocol: match.protocol,
    spec: value.slice(match.index, end),
    index: match.index,
  };
}

function dependencyFailure(
  path: string,
  sourceName: string,
  match: LocalDependencySpec,
): SnapshotError {
  const prefix =
    `${sourceName} ${match.field} contains package ` +
    `"${match.packageName}" with spec "${match.spec}".`;
  if (match.protocol === "workspace:") {
    return new SnapshotError(
      "unsupported-local-dependency",
      `${prefix} The workspace: protocol cannot resolve under --ignore-workspace.`,
      path,
    );
  }
  return new SnapshotError(
    "unsupported-local-dependency",
    `${prefix} The ${match.protocol} protocol can resolve outside the source snapshot.`,
    path,
  );
}

function scanDependencyMap(
  value: unknown,
  field: string,
  visited: WeakSet<object>,
): LocalDependencySpec | null {
  if (!isRecord(value)) return null;
  for (const [packageName, specValue] of Object.entries(value)) {
    const match = findLocalDependencySpec(
      specValue,
      packageName,
      field,
      new WeakSet(),
      visited,
    );
    if (match) return match;
  }
  return null;
}

function findLocalDependencySpec(
  value: unknown,
  packageName: string,
  field: string,
  stack: WeakSet<object>,
  // Persists across this whole validatePackageJson/validatePnpmLockfile call
  // (never cleared, unlike stack) so a node already found to have no match
  // is never re-walked. YAML's &anchor/*alias syntax — legitimate and
  // common in pnpm lockfiles for shared dependency specs — parses repeated
  // aliases to the SAME object reference, so without this a diamond-shaped
  // alias structure can revisit one shared subtree once per path reaching
  // it, compounding multiplicatively across levels (CodeRabbit #779 R25).
  // stack alone only catches true cycles (a node its own ancestor), not
  // this DAG re-visitation.
  visited: WeakSet<object>,
): LocalDependencySpec | null {
  if (typeof value === "string") {
    const protocol = localDependencyProtocol(value);
    return protocol ? { packageName, spec: value, protocol, field } : null;
  }
  if (typeof value !== "object" || value === null) return null;
  if (stack.has(value) || visited.has(value)) return null;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        const match = findLocalDependencySpec(item, packageName, field, stack, visited);
        if (match) return match;
      }
      visited.add(value);
      return null;
    }
    for (const [key, nested] of Object.entries(value)) {
      if ((DEPENDENCY_FIELDS as readonly string[]).includes(key)) {
        const match = scanDependencyMap(nested, `${field}.${key}`, visited);
        if (match) return match;
        continue;
      }
      const match = findLocalDependencySpec(nested, packageName, field, stack, visited);
      if (match) return match;
    }
    visited.add(value);
    return null;
  } finally {
    stack.delete(value);
  }
}

function packageNameFromLockfileKey(
  key: string,
  localSpecIndex: number,
): string {
  const prefix = key
    .slice(0, localSpecIndex)
    .replace(/^\//, "")
    .replace(/[@(/]+$/, "");
  if (prefix === "") return key;
  if (prefix.startsWith("@")) {
    const scopeSeparator = prefix.indexOf("/");
    const versionSeparator = prefix.indexOf("@", scopeSeparator + 1);
    return versionSeparator < 0 ? prefix : prefix.slice(0, versionSeparator);
  }
  const versionSeparator = prefix.indexOf("@");
  return versionSeparator < 0 ? prefix : prefix.slice(0, versionSeparator);
}

function scanLockfileSection(
  value: unknown,
  sectionName: string,
  visited: WeakSet<object>,
): LocalDependencySpec | null {
  if (!isRecord(value)) return null;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const embedded = embeddedLocalDependencySpec(entryKey);
    const entryRecord = isRecord(entryValue) ? entryValue : null;
    const declaredName = entryRecord?.name;
    const packageName = typeof declaredName === "string"
      ? declaredName
      : embedded
        ? packageNameFromLockfileKey(entryKey, embedded.index)
        : packageNameFromLockfileKey(entryKey, entryKey.length);
    if (embedded) {
      return {
        packageName,
        spec: embedded.spec,
        protocol: embedded.protocol,
        field: `${sectionName}.${entryKey}`,
      };
    }
    const nested = findLocalDependencySpec(
      entryValue,
      packageName,
      `${sectionName}.${entryKey}`,
      new WeakSet(),
      visited,
    );
    if (nested) return nested;
  }
  return null;
}

function validatePackageJson(packagePath: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new SnapshotError(
      "invalid-package-json",
      `package.json at ${packagePath} must contain a JSON object.`,
      packagePath,
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "packageManager") &&
    value.packageManager !== PINNED_PLUGIN_PACKAGE_MANAGER
  ) {
    const declared = JSON.stringify(value.packageManager) ?? String(value.packageManager);
    throw new SnapshotError(
      "unsupported-package-manager",
      `package.json field "packageManager" declares ${declared}; ` +
        `the pinned value is "${PINNED_PLUGIN_PACKAGE_MANAGER}".`,
      packagePath,
    );
  }

  // pnpm reads devEngines.packageManager in preference to packageManager and
  // downloads whatever it names, so the pin above is only a pin while this
  // field is absent. Measured against the staged pnpm@11.20.0: a package.json
  // declaring the pinned value alongside devEngines pnpm 10.15.0 ran 10.15.0,
  // a release that still honors path settings from a plugin-authored .npmrc
  // (#779 round 8 D1).
  const devEngines = value.devEngines;
  if (isRecord(devEngines) && devEngines.packageManager !== undefined) {
    throw new SnapshotError(
      "unsupported-package-manager",
      `package.json field "devEngines.packageManager" overrides the pinned ` +
        `package manager "${PINNED_PLUGIN_PACKAGE_MANAGER}". Remove it.`,
      packagePath,
    );
  }

  const visited = new WeakSet<object>();
  for (const field of DEPENDENCY_FIELDS) {
    const match = scanDependencyMap(value[field], field, visited);
    if (match) throw dependencyFailure(packagePath, "package.json field", match);
  }
}

function validatePnpmLockfile(lockfilePath: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new SnapshotError(
      "invalid-lockfile",
      `pnpm-lock.yaml at ${lockfilePath} must contain a YAML mapping.`,
      lockfilePath,
    );
  }
  const visited = new WeakSet<object>();
  for (const sectionName of ["importers", "packages", "snapshots"] as const) {
    const match = scanLockfileSection(value[sectionName], sectionName, visited);
    if (match) throw dependencyFailure(lockfilePath, "pnpm-lock.yaml", match);
  }
}

async function readAndValidatePackageJson(stagingRoot: string): Promise<void> {
  const packagePath = join(stagingRoot, "package.json");
  let body: string;
  try {
    const packageJsonBytes = (await lstat(packagePath)).size;
    if (packageJsonBytes > MAX_PLUGIN_PACKAGE_JSON_BYTES) {
      throw new SnapshotError(
        "invalid-package-json",
        `package.json at ${packagePath} is ${packageJsonBytes} bytes; the ` +
          `configured limit is ${MAX_PLUGIN_PACKAGE_JSON_BYTES} bytes.`,
        packagePath,
      );
    }
    body = await readFile(packagePath, "utf8");
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      "invalid-package-json",
      `package.json at ${packagePath} could not be read: ${errorMessage(error)}`,
      packagePath,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new SnapshotError(
      "invalid-package-json",
      `package.json at ${packagePath} is not valid JSON: ${errorMessage(error)}`,
      packagePath,
    );
  }
  validatePackageJson(packagePath, value);
}

async function readAndValidatePnpmLockfile(stagingRoot: string): Promise<void> {
  const lockfilePath = join(stagingRoot, "pnpm-lock.yaml");
  let body: string;
  try {
    const lockfileBytes = (await lstat(lockfilePath)).size;
    if (lockfileBytes > MAX_PLUGIN_LOCKFILE_BYTES) {
      throw new SnapshotError(
        "invalid-lockfile",
        `pnpm-lock.yaml at ${lockfilePath} is ${lockfileBytes} bytes; the ` +
          `configured limit is ${MAX_PLUGIN_LOCKFILE_BYTES} bytes.`,
        lockfilePath,
      );
    }
    body = await readFile(lockfilePath, "utf8");
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      "invalid-lockfile",
      `pnpm-lock.yaml at ${lockfilePath} could not be read: ${errorMessage(error)}`,
      lockfilePath,
    );
  }
  let value: unknown;
  try {
    value = load(body, { filename: lockfilePath });
  } catch (error) {
    throw new SnapshotError(
      "invalid-lockfile",
      `pnpm-lock.yaml at ${lockfilePath} is not valid YAML: ${errorMessage(error)}`,
      lockfilePath,
    );
  }
  validatePnpmLockfile(lockfilePath, value);
}

async function inspectRealDirectory(
  path: string,
  label: string,
  code: PluginSourceSnapshotFailureCode,
): Promise<string> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new SnapshotError(
      code,
      `${label} at ${path} could not be inspected: ${errorMessage(error)}`,
      path,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new SnapshotError(
      code,
      `${label} at ${path} is a symlink or junction; use a real directory.`,
      path,
    );
  }
  if (!stats.isDirectory()) {
    throw new SnapshotError(code, `${label} at ${path} is not a directory.`, path);
  }
  return realpath(path);
}

async function validatePluginRoot(
  workspaceRoot: string,
  pluginRoot: string,
): Promise<string> {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const realWorkspaceRoot = await realpath(resolvedWorkspaceRoot).catch((error) => {
    throw new SnapshotError(
      "invalid-plugin-root",
      `Workspace root at ${resolvedWorkspaceRoot} could not be resolved: ${errorMessage(error)}`,
      resolvedWorkspaceRoot,
    );
  });
  const pluginsRoot = join(resolvedWorkspaceRoot, "plugins");
  const realPluginsRoot = await inspectRealDirectory(
    pluginsRoot,
    "Workspace plugins tree",
    "invalid-plugin-root",
  );
  if (!isInside(realWorkspaceRoot, realPluginsRoot)) {
    throw new SnapshotError(
      "invalid-plugin-root",
      `Workspace plugins tree at ${pluginsRoot} resolves outside the workspace root.`,
      pluginsRoot,
    );
  }

  const resolvedPluginRoot = resolve(pluginRoot);
  if (!isInside(pluginsRoot, resolvedPluginRoot)) {
    throw new SnapshotError(
      "invalid-plugin-root",
      `Plugin root at ${resolvedPluginRoot} is outside the workspace plugins tree at ${pluginsRoot}.`,
      resolvedPluginRoot,
    );
  }
  const realPluginRoot = await inspectRealDirectory(
    resolvedPluginRoot,
    "Plugin root",
    "invalid-plugin-root",
  );
  if (!isInside(realPluginsRoot, realPluginRoot)) {
    throw new SnapshotError(
      "invalid-plugin-root",
      `Plugin root at ${resolvedPluginRoot} resolves outside the real source tree at ${realPluginsRoot}.`,
      resolvedPluginRoot,
    );
  }
  return realPluginRoot;
}

async function ensureContainedDirectory(
  path: string,
  realParent: string,
  label: string,
): Promise<string> {
  await mkdir(path, { recursive: true });
  const realDirectory = await inspectRealDirectory(path, label, "invalid-output-path");
  if (!isInside(realParent, realDirectory)) {
    throw new SnapshotError(
      "invalid-output-path",
      `${label} at ${path} resolves outside ${realParent}.`,
      path,
    );
  }
  return realDirectory;
}

async function prepareOutputDirectories(
  stateDir: string,
  workspaceRoot: string,
  dohcDir: string,
  safeId: string,
): Promise<{
  pluginDataRoot: string;
  pnpmPaths: PluginPnpmPaths;
}> {
  // Every derived plugin artifact (snapshot, installed node_modules, pnpm
  // store/cache/state, and — via pluginBuildRunner.ts, which shares this
  // same dohcDir — the built bundle) lives under the app's own userData,
  // never inside the workspace folder: "anything inside the workspace can
  // be replaced by a git/Dropbox mirror, and a mirror-writable bundle would
  // bypass source hashing entirely" (design doc). workspaceRoot is used
  // only to derive the workspace's own key below and to contain the
  // *source* plugin root elsewhere in this module — never to place output.
  const resolvedStateDir = resolve(stateDir);
  const expectedDohcDir = join(
    resolvedStateDir,
    "plugin-data",
    workspaceStateKey(workspaceRoot),
  );
  const resolvedDohcDir = resolve(dohcDir);
  if (relative(expectedDohcDir, resolvedDohcDir) !== "") {
    throw new SnapshotError(
      "invalid-output-path",
      `Plugin data directory must be ${expectedDohcDir}; received ${resolvedDohcDir}.`,
      resolvedDohcDir,
    );
  }
  const realStateDir = await realpath(resolvedStateDir);
  const realDohcDir = await ensureContainedDirectory(
    resolvedDohcDir,
    realStateDir,
    "App plugin-data directory",
  );
  const pluginDataParent = join(resolvedDohcDir, "plugins");
  const realPluginDataParent = await ensureContainedDirectory(
    pluginDataParent,
    realDohcDir,
    "Plugin data directory",
  );
  const pluginDataRoot = join(pluginDataParent, safeId);
  await ensureContainedDirectory(
    pluginDataRoot,
    realPluginDataParent,
    "Plugin snapshot directory",
  );

  const pnpmRoot = join(resolvedDohcDir, "pnpm");
  const realPnpmRoot = await ensureContainedDirectory(
    pnpmRoot,
    realDohcDir,
    "Shared pnpm directory",
  );
  const pnpmPaths = {
    storeDir: join(pnpmRoot, "store"),
    cacheDir: join(pnpmRoot, "cache"),
    stateDir: join(pnpmRoot, "state"),
    homeDir: join(pnpmRoot, "home"),
  } satisfies PluginPnpmPaths;
  await Promise.all([
    ensureContainedDirectory(pnpmPaths.storeDir, realPnpmRoot, "Shared pnpm store"),
    ensureContainedDirectory(pnpmPaths.cacheDir, realPnpmRoot, "Shared pnpm cache"),
    ensureContainedDirectory(pnpmPaths.stateDir, realPnpmRoot, "Shared pnpm state"),
    ensureContainedDirectory(pnpmPaths.homeDir, realPnpmRoot, "Shared pnpm home"),
  ]);
  return { pluginDataRoot, pnpmPaths };
}

async function copyRegularFile(sourcePath: string, destinationPath: string): Promise<void> {
  if (process.platform === "win32") {
    await copyFile(sourcePath, destinationPath);
    return;
  }
  // Streamed, not read whole: a plugin can hold a large binary asset, and
  // reading it into one buffer put that whole asset in main-process memory
  // for every snapshot. The O_NOFOLLOW open is what keeps this from
  // following a symlink, so the copy reads from that handle and nothing else.
  const sourceHandle = await open(sourcePath, READ_NO_FOLLOW);
  try {
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(destinationPath),
    );
  } finally {
    await sourceHandle.close();
  }
}

/**
 * Rejects a source entry whose own name contains a backslash. Snapshot paths
 * are recorded with backslashes normalized to "/", so on POSIX a file
 * literally named `a\b` and a nested file `a/b` produce the same recorded
 * path: the nested one is hashed twice and the backslash one is copied into
 * the approved snapshot without ever being hashed — executable bytes outside
 * the approved hash. Windows cannot create such a name.
 */
export function assertSafeSnapshotEntryName(name: string, path: string): void {
  if (!name.includes("\\")) return;
  throw new SnapshotError(
    "unsafe-source-entry",
    `Plugin source entry at ${path} has a backslash in its name. Plugin ` +
      "source file and directory names must not contain a backslash.",
    path,
  );
}

/**
 * Rejects package-manager configuration anywhere in the plugin source tree.
 * See REJECTED_PACKAGE_MANAGER_CONFIG_NAMES. pnpm reads these files from the
 * tree root only, but one rule for the whole tree needs no depth bookkeeping
 * and leaves no dead config for a later pnpm to start reading.
 */
export function assertNoPackageManagerConfig(name: string, path: string): void {
  // Case-folded on every platform: Windows and default macOS serve `.NPMRC`
  // when pnpm opens `.npmrc`, so an exact-case rule rejects nothing there.
  if (!REJECTED_PACKAGE_MANAGER_CONFIG_NAMES.has(name.toLowerCase())) return;
  throw new SnapshotError(
    "unsupported-package-manager-config",
    `Plugin source entry at ${path} is package-manager configuration ` +
      `("${name}"). A plugin install uses dohc's own pnpm configuration — ` +
      "registry, store, and output paths — so a plugin cannot supply its " +
      "own. Remove this file.",
    path,
  );
}

async function copySourceTree(
  sourceDirectory: string,
  destinationDirectory: string,
  realSourceRoot: string,
): Promise<void> {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => lexicalCompare(left.name, right.name));
  for (const entry of entries) {
    const sourcePath = join(sourceDirectory, entry.name);
    assertSafeSnapshotEntryName(entry.name, sourcePath);
    assertNoPackageManagerConfig(entry.name, sourcePath);
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink()) {
      throw new SnapshotError(
        "unsafe-source-entry",
        `Plugin source entry at ${sourcePath} is a symlink or junction.`,
        sourcePath,
      );
    }
    const resolvedEntry = await realpath(sourcePath);
    if (!isInside(realSourceRoot, resolvedEntry)) {
      throw new SnapshotError(
        "unsafe-source-entry",
        `Plugin source entry at ${sourcePath} resolves outside ${realSourceRoot}.`,
        sourcePath,
      );
    }
    if (EXCLUDED_SOURCE_NAMES.has(entry.name)) continue;

    const destinationPath = join(destinationDirectory, entry.name);
    if (stats.isDirectory()) {
      await mkdir(destinationPath);
      await copySourceTree(
        sourcePath,
        destinationPath,
        realSourceRoot,
      );
      continue;
    }
    if (!stats.isFile()) {
      throw new SnapshotError(
        "unsafe-source-entry",
        `Plugin source entry at ${sourcePath} is not a regular file or directory.`,
        sourcePath,
      );
    }
    try {
      await copyRegularFile(sourcePath, destinationPath);
    } catch (error) {
      throw new SnapshotError(
        "snapshot-io",
        `Plugin source file at ${sourcePath} could not be copied: ${errorMessage(error)}`,
        sourcePath,
      );
    }
  }
}

async function listSnapshotFiles(
  root: string,
  current = root,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_SOURCE_NAMES.has(entry.name)) continue;
    const path = join(current, entry.name);
    assertSafeSnapshotEntryName(entry.name, path);
    if (entry.isDirectory()) {
      files.push(...await listSnapshotFiles(root, path));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
      continue;
    }
    // Fails closed on anything else, the same stance copySourceTree takes.
    // Skipping these silently hid them from the hash, so a symlink dropped
    // under an installed plugin left the uninstall preflight reporting no
    // local modifications while recursive removal still deleted the link.
    if (entry.isSymbolicLink()) {
      throw new SnapshotError(
        "unsafe-source-entry",
        `Plugin source entry at ${path} is a symlink or junction.`,
        path,
      );
    }
    throw new SnapshotError(
      "unsafe-source-entry",
      `Plugin source entry at ${path} is not a regular file or directory.`,
      path,
    );
  }
  return files;
}

export function canonicalPluginSourceHash(
  files: readonly PluginSourceFileDigest[],
): string {
  const canonical = createHash("sha256");
  const sortedFiles = [...files].sort((left, right) =>
    lexicalCompare(left.relPath, right.relPath)
  );
  for (const file of sortedFiles) {
    canonical.update(file.relPath, "utf8");
    canonical.update("\0", "utf8");
    canonical.update(file.sha256, "utf8");
    canonical.update("\n", "utf8");
  }
  return canonical.digest("hex");
}

/**
 * Streams the file through the hash. A plugin can hold a large binary asset,
 * and install, reconcile, and uninstall preflight all hash the whole tree —
 * reading each file into one buffer put that whole asset in main-process
 * memory every time.
 */
async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const source = createReadStream(path);
  for await (const chunk of source) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function hashPluginSourceFiles(
  sourceRoot: string,
): Promise<PluginSourceDigest> {
  const paths = await listSnapshotFiles(sourceRoot);
  paths.sort(lexicalCompare);
  const files: PluginSourceFileDigest[] = [];
  for (const relPath of paths) {
    files.push({
      relPath,
      sha256: await hashFileSha256(join(sourceRoot, ...relPath.split("/"))),
    });
  }
  return {
    sourceHash: canonicalPluginSourceHash(files),
    files,
  };
}

function renameSnapshotPath(source: string, destination: string): Promise<void> {
  return renameWithWindowsRetry(source, destination, (error, lockedAfterRetries) =>
    lockedAfterRetries
      ? new SnapshotError(
        "snapshot-locked",
        `Plugin snapshot target at ${destination} stayed locked after ` +
          `${WINDOWS_RENAME_RETRY_DELAYS_MS.length} retries over 1,000 ms. ` +
          "Close processes that use this plugin and retry.",
        destination,
      )
      : error);
}

/**
 * Publishing and discarding are the two ways a staged tree ends, and both
 * consume it. A second call would rename or delete a path that is no longer
 * this snapshot's, so it fails loudly instead — the same guard the build
 * runner puts on its own staged tree.
 */
function settleOnce(stagingRoot: string): { assertOpen: () => void; claim: () => void } {
  let settled = false;
  const assertOpen = (): void => {
    if (settled) {
      throw new Error(
        `Plugin source snapshot at ${stagingRoot} was already published or discarded.`,
      );
    }
  };
  return {
    assertOpen,
    claim: () => {
      assertOpen();
      settled = true;
    },
  };
}

async function existingPathStats(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function replaceSnapshot(
  stagingRoot: string,
  snapshotRoot: string,
): Promise<void> {
  const snapshotStats = await existingPathStats(snapshotRoot);
  if (snapshotStats?.isSymbolicLink()) {
    throw new SnapshotError(
      "invalid-output-path",
      `Plugin snapshot target at ${snapshotRoot} is a symlink or junction.`,
      snapshotRoot,
    );
  }
  if (snapshotStats && !snapshotStats.isDirectory()) {
    throw new SnapshotError(
      "invalid-output-path",
      `Plugin snapshot target at ${snapshotRoot} is not a directory.`,
      snapshotRoot,
    );
  }

  const previousRoot = `${snapshotRoot}.previous-${randomUUID()}`;
  let movedPrevious = false;
  if (snapshotStats) {
    await renameSnapshotPath(snapshotRoot, previousRoot);
    movedPrevious = true;
  }
  try {
    await renameSnapshotPath(stagingRoot, snapshotRoot);
  } catch (error) {
    if (movedPrevious) {
      await renameSnapshotPath(previousRoot, snapshotRoot).catch((restoreError) => {
        throw new SnapshotError(
          "snapshot-io",
          `Plugin snapshot replacement failed and the previous snapshot at ` +
            `${previousRoot} could not be restored: ${errorMessage(restoreError)}`,
          snapshotRoot,
        );
      });
    }
    throw error;
  }
  if (movedPrevious) {
    await rm(previousRoot, {
      recursive: true,
      force: true,
      maxRetries: WINDOWS_RENAME_RETRY_DELAYS_MS.length,
      retryDelay: 200,
    });
  }
}

function resultError(error: unknown): PluginSourceSnapshotError {
  if (error instanceof SnapshotError) {
    return { code: error.code, message: error.message, path: error.path };
  }
  return {
    code: "snapshot-io",
    message: `Plugin source snapshot failed: ${errorMessage(error)}`,
    path: null,
  };
}

/**
 * The two places a plugin's validated source tree is allowed to be: the
 * published snapshot inside its live root, and a staged snapshot beside that
 * root which no approval has published yet. The build reads from whichever
 * one the pipeline handed it, so it checks membership of this family rather
 * than a single fixed path (#779 round 9 B1).
 */
export function isPluginSourceRoot(liveRoot: string, sourceRoot: string): boolean {
  const resolvedLiveRoot = resolve(liveRoot);
  const resolvedSourceRoot = resolve(sourceRoot);
  if (resolvedSourceRoot === join(resolvedLiveRoot, PLUGIN_SNAPSHOT_DIR_NAME)) {
    return true;
  }
  return (
    dirname(resolvedSourceRoot) === dirname(resolvedLiveRoot) &&
    isPluginRootArtifact(
      basename(resolvedLiveRoot),
      basename(resolvedSourceRoot),
      [SNAPSHOT_STAGING_SUFFIX],
    )
  );
}

/**
 * Whether `name` is one of this pipeline's own staging or swap artifacts for
 * the live root named `liveRootName`. The uuid is part of the match: plugin
 * ids may contain "." and "-", so a bare prefix test also accepts another
 * plugin's live root — `example.snap-staging-1` for `example`, or `foo.bar`
 * for `foo` (#779 round 10 A1/B1).
 */
export function isPluginRootArtifact(
  liveRootName: string,
  name: string,
  suffixes: readonly string[] = PLUGIN_ROOT_ARTIFACT_SUFFIXES,
): boolean {
  return suffixes.some((suffix) => {
    const prefix = `${liveRootName}${suffix}`;
    return name.startsWith(prefix) && ARTIFACT_UUID.test(name.slice(prefix.length));
  });
}

/**
 * Whether a name is shaped like one of this pipeline's own artifacts for some
 * other plugin — `<anything>.previous-<uuid>` and its siblings. A manifest
 * name may contain "." and "-", so `<victim>.previous-<uuid>` is a legal
 * plugin id whose live root is indistinguishable from the victim's swap
 * directory: the victim's uninstall sweep deletes it, and the build's
 * source-root check accepts it as a staged tree (CERT779J B2).
 */
function looksLikePluginRootArtifact(name: string): boolean {
  return PLUGIN_ROOT_ARTIFACT_SUFFIXES.some((suffix) => {
    const at = name.lastIndexOf(suffix);
    return at > 0 && ARTIFACT_UUID.test(name.slice(at + suffix.length));
  });
}

export function pluginIdToSafePath(pluginId: string): string {
  if (!NPM_PACKAGE_NAME.test(pluginId)) {
    throw new SnapshotError(
      "invalid-plugin-id",
      `Plugin id "${pluginId}" does not match the manifest name pattern.`,
    );
  }
  if (looksLikePluginRootArtifact(pluginId)) {
    throw new SnapshotError(
      "invalid-plugin-id",
      `Plugin id "${pluginId}" ends in a name dohc reserves for its own ` +
        "staging and swap directories. A plugin id must not end in " +
        `${PLUGIN_ROOT_ARTIFACT_SUFFIXES.join(", ")} followed by a uuid. ` +
        "Rename the plugin.",
    );
  }
  // "/" percent-encodes to "%2F", never "__": a plain "__" substitution was
  // not injective — "@a/b__c" and "@a__b/c" are both valid ids (NPM_PACKAGE_NAME
  // allows "_" in every segment) that collided on the same directory (#779
  // round 3 finding 4). "%" is outside NPM_PACKAGE_NAME's character class, so
  // "%2F" can never occur any other way and this is a true one-to-one map.
  return pluginId.replaceAll("/", "%2F");
}

/**
 * The plugin's durable per-workspace data directory
 * (PluginActivateContext.stateRoot): under dohcDir beside the built plugin,
 * so it survives rebuilds — a rebuild swaps only `plugins/<safeId>` — and is
 * deleted with the plugin's data on uninstall. One computation, used by both
 * the activate params and the uninstall path, so the directory the plugin
 * writes and the directory uninstall deletes can never drift apart.
 */
export function pluginStateRoot(dohcDir: string, pluginId: string): string {
  return join(resolve(dohcDir), "state", pluginIdToSafePath(pluginId));
}

/**
 * Whether the snapshot already on disk is readable and hashes to the expected
 * source hash. Any failure (missing directory, IO error, mismatch) answers
 * false so the caller rebuilds instead of trusting it.
 *
 * node_modules stays excluded from the hash (EXCLUDED_SOURCE_NAMES): install
 * integrity is the lifecycle scan's job, not this check's.
 */
async function snapshotMatchesHash(
  snapshotRoot: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const existing = await hashPluginSourceFiles(snapshotRoot);
    return existing.sourceHash === expectedHash;
  } catch {
    return false;
  }
}

export async function snapshotPluginSource(
  input: SnapshotPluginSourceInput,
): Promise<PluginSourceSnapshotResult> {
  const resolvedDohcDir = resolve(input.dohcDir);
  const pnpmPaths: PluginPnpmPaths = {
    storeDir: join(resolvedDohcDir, "pnpm", "store"),
    cacheDir: join(resolvedDohcDir, "pnpm", "cache"),
    stateDir: join(resolvedDohcDir, "pnpm", "state"),
    homeDir: join(resolvedDohcDir, "pnpm", "home"),
  };
  let stagingRoot: string | null = null;
  try {
    if (input.pluginId !== input.manifest.name) {
      throw new SnapshotError(
        "invalid-plugin-id",
        `Plugin id "${input.pluginId}" does not match manifest name ` +
          `"${input.manifest.name}".`,
      );
    }
    const safeId = pluginIdToSafePath(input.pluginId);
    const realPluginRoot = await validatePluginRoot(
      input.workspaceRoot,
      input.pluginRoot,
    );
    const output = await prepareOutputDirectories(
      input.stateDir,
      input.workspaceRoot,
      input.dohcDir,
      safeId,
    );
    Object.assign(pnpmPaths, output.pnpmPaths);
    stagingRoot = `${output.pluginDataRoot}${SNAPSHOT_STAGING_SUFFIX}${randomUUID()}`;
    await mkdir(stagingRoot);

    await copySourceTree(realPluginRoot, stagingRoot, realPluginRoot);
    await readAndValidatePackageJson(stagingRoot);
    await readAndValidatePnpmLockfile(stagingRoot);
    const digest = await hashPluginSourceFiles(stagingRoot);
    const { sourceHash } = digest;
    const liveSnapshotRoot = join(output.pluginDataRoot, PLUGIN_SNAPSHOT_DIR_NAME);
    // Preserving is only safe when the snapshot it preserves is actually
    // there and actually matches. A snapshot deleted or corrupted out of band
    // would otherwise be handed back as a live root that nothing rebuilds.
    // Staging already holds a fresh valid copy, so recovery costs nothing.
    if (
      sourceHash === input.preserveIfHashMatches &&
      await snapshotMatchesHash(liveSnapshotRoot, sourceHash)
    ) {
      await removeStaging(stagingRoot);
      stagingRoot = null;
      return {
        ok: true,
        snapshotRoot: liveSnapshotRoot,
        sourceHash,
        digest,
        pnpmPaths,
        publish: () => Promise.resolve(),
        discard: () => Promise.resolve(),
      };
    }
    const stagedRoot = stagingRoot;
    // Ownership of the staged tree passes to the caller, so the catch below
    // must no longer remove it.
    stagingRoot = null;
    const settle = settleOnce(stagedRoot);
    return {
      ok: true,
      snapshotRoot: stagedRoot,
      sourceHash,
      digest,
      pnpmPaths,
      publish: async () => {
        settle.claim();
        await replaceSnapshot(stagedRoot, liveSnapshotRoot);
      },
      // Claimed only once the tree is actually gone. A removal that failed
      // left it exactly where it was, so it is still this snapshot's and the
      // caller's retry has to reach it (#779 round 10 A5).
      discard: async () => {
        settle.assertOpen();
        await removeStaging(stagedRoot);
        settle.claim();
      },
    };
  } catch (error) {
    let failure = resultError(error);
    if (stagingRoot) {
      try {
        await removeStaging(stagingRoot);
      } catch (cleanupError) {
        failure = {
          code: "snapshot-io",
          path: stagingRoot,
          message:
            `${failure.message} Staging cleanup at ${stagingRoot} also failed: ` +
            `${errorMessage(cleanupError)}`,
        };
      }
    }
    return { ok: false, error: failure, pnpmPaths };
  }
}
