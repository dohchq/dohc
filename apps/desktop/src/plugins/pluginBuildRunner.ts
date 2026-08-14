import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  build as esbuildBuild,
  stop as esbuildStop,
  BuildOptions,
  BuildResult,
  Message,
  Metafile,
} from "esbuild";
import {
  DohcPluginManifest as DohcPluginManifestSchema,
  type DohcPluginManifest,
} from "./pluginManifestSchema";
import {
  delay,
  errorMessage,
  isInside,
  removeStaging,
  renameWithWindowsRetry,
  WINDOWS_RENAME_RETRY_DELAYS_MS,
} from "./pluginShared";
import {
  BUILD_PREVIOUS_SUFFIX,
  BUILD_STAGING_SUFFIX,
  isPluginSourceRoot,
  PLUGIN_BUNDLE_TIMEOUT_MS,
  PLUGIN_SNAPSHOT_DIR_NAME,
  pluginIdToSafePath,
} from "./pluginSourceSnapshot";

const BUILD_STOP_SETTLE_MS = 250;

export type PluginBuildFailureCode =
  | "invalid-manifest"
  | "invalid-plugin-id"
  | "invalid-snapshot"
  | "invalid-entry"
  | "missing-esbuild-binary"
  | "esbuild"
  | "timeout"
  | "aborted"
  | "output-locked"
  | "output-io";

export interface PluginBuildDiagnostics {
  errors: Message[];
  warnings: Message[];
}

export interface PluginBuildFailure {
  code: PluginBuildFailureCode;
  message: string;
  path: string | null;
  timeoutMs: number;
  diagnostics: PluginBuildDiagnostics;
}

export type PluginBuildResult =
  | {
    ok: true;
    liveRoot: string;
    bundlePath: string;
    /** SHA-256 of the built bundle.mjs — the executing artifact's own hash
     * (CERT779: source hash alone verified a tree that never runs; this is
     * what PluginPipeline records as approvedBundleHash and re-checks before
     * every start). `publish` only renames the staged tree into place, so
     * this stays the hash of the file that runs. */
    bundleHash: string;
    manifestPath: string;
    metafilePath: string;
    metafile: Metafile;
    diagnostics: PluginBuildDiagnostics;
    /** Swaps the built tree into the live root. A build is deliberately not
     * published by building: the caller persists the approval state for
     * `bundleHash` first, so nothing can serve bytes whose approval was
     * never durably recorded (#779 round 6 F5). */
    publish: () => Promise<{ cleanupWarning: string | null }>;
    /** Drops the built tree. The live root was never touched, so there is
     * nothing to restore. */
    discard: () => Promise<void>;
  }
  | {
    ok: false;
    error: PluginBuildFailure;
  };

export type PluginBundleBuild = (
  options: BuildOptions,
) => Promise<BuildResult>;

export interface BuildPluginBundleInput {
  /** The app's userData-resident plugin-data root for this workspace
   * (PluginPipeline's dohcDir) — never a workspace-relative path. The live
   * build root resolves to <dohcDir>/plugins/<safeId>, matching
   * pluginSourceSnapshot.ts's own output containment. */
  dohcDir: string;
  pluginId: string;
  snapshotRoot: string;
  manifest: DohcPluginManifest;
  resourcesBasePath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  buildFunction?: PluginBundleBuild;
  stopBuild?: () => Promise<void>;
}

interface BuildPaths {
  liveRoot: string;
  snapshotRoot: string;
  /** The manifest entry, already resolved and proven to be a regular file
   * inside the installed snapshot. esbuild reads it straight out of that
   * snapshot — live or staged — and the build never moves the live root's
   * own contents (#779 round 7 A1). */
  entryPath: string;
}

type BuildOutcome =
  | { kind: "success"; result: BuildResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

class PluginBuildRunnerError extends Error {
  readonly code: PluginBuildFailureCode;
  readonly path: string | null;
  readonly diagnostics: PluginBuildDiagnostics;

  constructor(
    code: PluginBuildFailureCode,
    message: string,
    path: string | null = null,
    diagnostics: PluginBuildDiagnostics = { errors: [], warnings: [] },
  ) {
    super(message);
    this.name = "PluginBuildRunnerError";
    this.code = code;
    this.path = path;
    this.diagnostics = diagnostics;
  }
}

let buildQueue: Promise<void> = Promise.resolve();

// esbuild reads ESBUILD_BINARY_PATH from process.env exactly once, into a
// module-scope const frozen the moment its own module first evaluates
// (node_modules/esbuild/lib/main.js) — a static top-level `import "esbuild"`
// in this file would evaluate that module before any of our code runs,
// making a later `process.env.ESBUILD_BINARY_PATH = ...` assignment a no-op
// against the real binary esbuild actually spawns (CodeRabbit R18/#779: the
// staged/pinned binary was never the one that ran). Deferring esbuild's own
// import until after the env var is set, and only ever importing it once,
// makes the pin real for this process's one, unchanging staged binary.
let esbuildModule: Promise<{
  build: typeof esbuildBuild;
  stop: typeof esbuildStop;
}> | null = null;

function loadEsbuild(esbuildBinary: string): Promise<{
  build: typeof esbuildBuild;
  stop: typeof esbuildStop;
}> {
  if (!esbuildModule) {
    process.env.ESBUILD_BINARY_PATH = esbuildBinary;
    esbuildModule = import("esbuild");
  }
  return esbuildModule;
}

function isEsbuildFailure(
  error: unknown,
): error is Error & { errors: Message[]; warnings: Message[] } {
  return (
    error instanceof Error &&
    "errors" in error &&
    Array.isArray(error.errors) &&
    "warnings" in error &&
    Array.isArray(error.warnings)
  );
}

function renameBuildPath(source: string, destination: string): Promise<void> {
  return renameWithWindowsRetry(source, destination, (error, lockedAfterRetries) =>
    lockedAfterRetries
      ? new PluginBuildRunnerError(
        "output-locked",
        `Plugin build target at ${destination} stayed locked after ` +
          `${WINDOWS_RENAME_RETRY_DELAYS_MS.length} retries over 1,000 ms. ` +
          "Stop processes that use this plugin and retry.",
        destination,
      )
      : new PluginBuildRunnerError(
        "output-io",
        `Plugin build path could not be renamed from ${source} to ` +
          `${destination}: ${errorMessage(error)}`,
        destination,
      ));
}

async function inspectBuildPaths(
  input: BuildPluginBundleInput,
  manifest: DohcPluginManifest,
): Promise<BuildPaths> {
  if (input.pluginId !== manifest.name) {
    throw new PluginBuildRunnerError(
      "invalid-plugin-id",
      `Plugin id "${input.pluginId}" does not match manifest name ` +
        `"${manifest.name}".`,
    );
  }

  let safeId: string;
  try {
    safeId = pluginIdToSafePath(input.pluginId);
  } catch (error) {
    throw new PluginBuildRunnerError(
      "invalid-plugin-id",
      errorMessage(error),
    );
  }

  const dohcDir = resolve(input.dohcDir);
  const liveRoot = join(dohcDir, "plugins", safeId);
  const snapshotRoot = resolve(input.snapshotRoot);
  // The source this build reads is the published snapshot for a rebuild, or
  // the staged snapshot beside the live root when the tree it builds is not
  // approved yet (#779 round 9 B1). isPluginSourceRoot names that family.
  if (!isPluginSourceRoot(liveRoot, snapshotRoot)) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Installed snapshot root must be ${join(liveRoot, PLUGIN_SNAPSHOT_DIR_NAME)} ` +
        `or a staged snapshot beside ${liveRoot}; received ${snapshotRoot}.`,
      snapshotRoot,
    );
  }

  let liveStats: Awaited<ReturnType<typeof lstat>>;
  let snapshotStats: Awaited<ReturnType<typeof lstat>>;
  try {
    [liveStats, snapshotStats] = await Promise.all([
      lstat(liveRoot),
      lstat(snapshotRoot),
    ]);
  } catch (error) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Installed snapshot at ${snapshotRoot} could not be inspected: ` +
        errorMessage(error),
      snapshotRoot,
    );
  }
  if (liveStats.isSymbolicLink() || !liveStats.isDirectory()) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Plugin build root at ${liveRoot} must be a real directory.`,
      liveRoot,
    );
  }
  if (snapshotStats.isSymbolicLink() || !snapshotStats.isDirectory()) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Installed snapshot at ${snapshotRoot} must be a real directory.`,
      snapshotRoot,
    );
  }

  let realDohcDir: string;
  let realLiveRoot: string;
  let realSnapshotRoot: string;
  try {
    [realDohcDir, realLiveRoot, realSnapshotRoot] = await Promise.all([
      realpath(dohcDir),
      realpath(liveRoot),
      realpath(snapshotRoot),
    ]);
  } catch (error) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Installed snapshot at ${snapshotRoot} could not be resolved: ` +
        errorMessage(error),
      snapshotRoot,
    );
  }
  if (!isInside(realDohcDir, realLiveRoot)) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Plugin build root at ${liveRoot} resolves outside the real plugin-data ` +
        `directory at ${realDohcDir}.`,
      liveRoot,
    );
  }
  if (!isInside(realDohcDir, realSnapshotRoot)) {
    throw new PluginBuildRunnerError(
      "invalid-snapshot",
      `Installed snapshot at ${snapshotRoot} resolves outside the real ` +
        `plugin-data directory at ${realDohcDir}.`,
      snapshotRoot,
    );
  }

  const entryPath = resolve(
    snapshotRoot,
    ...manifest.entry.split("/"),
  );
  if (!isInside(snapshotRoot, entryPath)) {
    throw new PluginBuildRunnerError(
      "invalid-entry",
      `Plugin entry at ${entryPath} is outside the installed snapshot root ` +
        `at ${snapshotRoot}.`,
      entryPath,
    );
  }

  let containedEntry: string;
  try {
    containedEntry = await realpath(entryPath);
  } catch (error) {
    throw new PluginBuildRunnerError(
      "invalid-entry",
      `Plugin entry at ${entryPath} could not be resolved: ${errorMessage(error)}`,
      entryPath,
    );
  }
  if (!isInside(realSnapshotRoot, containedEntry)) {
    throw new PluginBuildRunnerError(
      "invalid-entry",
      `Plugin entry at ${entryPath} resolves to ${containedEntry}, outside ` +
        `the installed snapshot root at ${realSnapshotRoot}.`,
      entryPath,
    );
  }
  const entryStats = await stat(containedEntry);
  if (!entryStats.isFile()) {
    throw new PluginBuildRunnerError(
      "invalid-entry",
      `Plugin entry at ${entryPath} resolves to ${containedEntry}, which is ` +
        "not a regular file.",
      entryPath,
    );
  }

  return { liveRoot, snapshotRoot, entryPath: containedEntry };
}

async function inspectEsbuildBinary(binaryPath: string): Promise<void> {
  let binaryStats: Awaited<ReturnType<typeof stat>>;
  try {
    binaryStats = await stat(binaryPath);
  } catch (error) {
    throw new PluginBuildRunnerError(
      "missing-esbuild-binary",
      `The staged esbuild binary for ${process.platform}/${process.arch} ` +
        `was not found at ${binaryPath}: ${errorMessage(error)}`,
      binaryPath,
    );
  }
  if (!binaryStats.isFile()) {
    throw new PluginBuildRunnerError(
      "missing-esbuild-binary",
      `The staged esbuild binary for ${process.platform}/${process.arch} ` +
        `at ${binaryPath} is not a file.`,
      binaryPath,
    );
  }
}

async function buildWithDeadline(
  input: BuildPluginBundleInput,
  options: BuildOptions,
  timeoutMs: number,
  esbuildBinary: string,
): Promise<BuildOutcome> {
  let buildFunction = input.buildFunction;
  let stopBuild = input.stopBuild;
  if (!buildFunction || !stopBuild) {
    const esbuild = await loadEsbuild(esbuildBinary);
    buildFunction ??= esbuild.build;
    stopBuild ??= esbuild.stop;
  }
  let timer: NodeJS.Timeout | undefined;
  let abortBuild: (() => void) | undefined;

  const buildOutcome = Promise.resolve()
    .then(() => buildFunction(options))
    .then<BuildOutcome, BuildOutcome>(
      (result) => ({ kind: "success", result }),
      (error: unknown) => ({ kind: "error", error }),
    );
  const timeoutOutcome = new Promise<BuildOutcome>((resolveOutcome) => {
    timer = setTimeout(() => resolveOutcome({ kind: "timeout" }), timeoutMs);
  });
  const candidates = [buildOutcome, timeoutOutcome];
  if (input.signal) {
    candidates.push(new Promise<BuildOutcome>((resolveOutcome) => {
      abortBuild = () => resolveOutcome({ kind: "aborted" });
      input.signal?.addEventListener("abort", abortBuild, { once: true });
      if (input.signal?.aborted) abortBuild();
    }));
  }

  const outcome = await Promise.race(candidates);
  if (timer) clearTimeout(timer);
  if (abortBuild) input.signal?.removeEventListener("abort", abortBuild);

  if (outcome.kind === "timeout" || outcome.kind === "aborted") {
    await stopBuild().catch(() => undefined);
    await Promise.race([buildOutcome.then(() => undefined), delay(BUILD_STOP_SETTLE_MS)]);
  }
  return outcome;
}

/**
 * Swaps the staged tree in, the same way pluginSourceSnapshot's
 * replaceSnapshot swaps a snapshot in: move the old directory aside, move the
 * new one into place, remove the old. The installed snapshot is the one part
 * of the live root the build did not rebuild — the source publish put it
 * there already — so it rides across here. Three renames, not the whole
 * build, is the entire window in which the live root is anything other than
 * its complete previous or complete next contents (#779 round 7 A1).
 */
async function publishStaging(
  liveRoot: string,
  stagingRoot: string,
): Promise<string | null> {
  const previousRoot = `${liveRoot}${BUILD_PREVIOUS_SUFFIX}${randomUUID()}`;
  const previousSnapshot = join(previousRoot, "snapshot");
  const stagedSnapshot = join(stagingRoot, "snapshot");
  try {
    await renameBuildPath(liveRoot, previousRoot);
  } catch (error) {
    // Nothing moved, so the live root is still whole and the dead staged tree
    // is safe to drop.
    await removeStaging(stagingRoot).catch(() => undefined);
    throw error;
  }
  let snapshotMoved = false;
  try {
    await renameBuildPath(previousSnapshot, stagedSnapshot);
    snapshotMoved = true;
    await renameBuildPath(stagingRoot, liveRoot);
  } catch (error) {
    try {
      if (snapshotMoved) {
        await renameBuildPath(stagedSnapshot, previousSnapshot);
      }
      await renameBuildPath(previousRoot, liveRoot);
    } catch (rollbackError) {
      // The live root is not whole. Everything stays on disk for recovery.
      throw new PluginBuildRunnerError(
        "output-io",
        `Plugin bundle publish failed: ${errorMessage(error)} The previous ` +
          `live directory at ${previousRoot} could not be restored to ` +
          `${liveRoot}: ${errorMessage(rollbackError)}`,
        liveRoot,
      );
    }
    await removeStaging(stagingRoot).catch(() => undefined);
    throw error;
  }

  try {
    await removeStaging(previousRoot);
    return null;
  } catch (error) {
    return `The new plugin bundle is live, but the previous directory at ` +
      `${previousRoot} could not be deleted: ${errorMessage(error)}`;
  }
}

function parseManifest(input: BuildPluginBundleInput): DohcPluginManifest {
  const parsed = DohcPluginManifestSchema.safeParse(input.manifest);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
    .join("; ");
  throw new PluginBuildRunnerError(
    "invalid-manifest",
    `Plugin manifest is invalid: ${details}`,
  );
}

function failureResult(
  error: unknown,
  timeoutMs: number,
): Extract<PluginBuildResult, { ok: false }> {
  if (error instanceof PluginBuildRunnerError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        path: error.path,
        timeoutMs,
        diagnostics: error.diagnostics,
      },
    };
  }
  if (isEsbuildFailure(error)) {
    return {
      ok: false,
      error: {
        code: "esbuild",
        message: error.message,
        path: error.errors[0]?.location?.file ?? null,
        timeoutMs,
        diagnostics: {
          errors: error.errors,
          warnings: error.warnings,
        },
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "output-io",
      message: `Plugin bundle failed: ${errorMessage(error)}`,
      path: null,
      timeoutMs,
      diagnostics: { errors: [], warnings: [] },
    },
  };
}

async function runBuildJob(
  input: BuildPluginBundleInput,
): Promise<PluginBuildResult> {
  const timeoutMs = input.timeoutMs ?? PLUGIN_BUNDLE_TIMEOUT_MS;
  let stagingRoot: string | null = null;

  try {
    if (input.signal?.aborted) {
      throw new PluginBuildRunnerError(
        "aborted",
        `Plugin "${input.pluginId}" bundle was cancelled before esbuild started.`,
      );
    }
    const manifest = parseManifest(input);
    const paths = await inspectBuildPaths(input, manifest);
    if (input.signal?.aborted) {
      throw new PluginBuildRunnerError(
        "aborted",
        `Plugin "${input.pluginId}" bundle was cancelled before esbuild started.`,
      );
    }

    const esbuildBinary = resolvePluginEsbuildBinary(input.resourcesBasePath);
    await inspectEsbuildBinary(esbuildBinary);
    // A sibling of the live root, never a directory inside it. Staging inside
    // the live root made every unpublished byte reachable by the child-process
    // broker, whose containment is rooted at the live root, and made the live
    // root incomplete for the whole build — a panel start during a build then
    // failed outright (#779 round 7 A1).
    stagingRoot = `${paths.liveRoot}${BUILD_STAGING_SUFFIX}${randomUUID()}`;
    await mkdir(stagingRoot);
    const outfile = join(stagingRoot, "bundle.mjs");
    const options = {
      entryPoints: [paths.entryPath],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      metafile: true,
      logLevel: "silent",
    } satisfies BuildOptions;

    const outcome = await buildWithDeadline(input, options, timeoutMs, esbuildBinary);

    if (outcome.kind === "timeout") {
      throw new PluginBuildRunnerError(
        "timeout",
        `Plugin "${input.pluginId}" bundle exceeded the ${timeoutMs} ms timeout.`,
      );
    }
    if (outcome.kind === "aborted") {
      throw new PluginBuildRunnerError(
        "aborted",
        `Plugin "${input.pluginId}" bundle was cancelled.`,
      );
    }
    if (outcome.kind === "error") throw outcome.error;
    if (!outcome.result.metafile) {
      throw new PluginBuildRunnerError(
        "esbuild",
        "esbuild completed without the requested metafile.",
      );
    }
    if (input.signal?.aborted) {
      throw new PluginBuildRunnerError(
        "aborted",
        `Plugin "${input.pluginId}" bundle was cancelled before replacement.`,
      );
    }

    const metafilePath = join(stagingRoot, "meta.json");
    const manifestPath = join(stagingRoot, "dohc-plugin.generated.json");
    await Promise.all([
      writeFile(
        metafilePath,
        `${JSON.stringify(outcome.result.metafile, null, 2)}\n`,
      ),
      writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, entry: "bundle.mjs" }, null, 2)}\n`,
      ),
    ]);
    const bundleHash = createHash("sha256")
      .update(await readFile(outfile))
      .digest("hex");

    const builtStagingRoot = stagingRoot;
    stagingRoot = null;
    let settled = false;
    const settle = (): void => {
      if (settled) {
        throw new Error(
          `Plugin "${input.pluginId}" build at ${builtStagingRoot} was ` +
            "already published or discarded.",
        );
      }
      settled = true;
    };

    return {
      ok: true,
      liveRoot: paths.liveRoot,
      bundlePath: join(paths.liveRoot, "bundle.mjs"),
      bundleHash,
      manifestPath: join(paths.liveRoot, "dohc-plugin.generated.json"),
      metafilePath: join(paths.liveRoot, "meta.json"),
      metafile: outcome.result.metafile,
      diagnostics: {
        errors: outcome.result.errors,
        warnings: outcome.result.warnings,
      },
      publish: async () => {
        settle();
        return {
          cleanupWarning: await publishStaging(paths.liveRoot, builtStagingRoot),
        };
      },
      discard: async () => {
        settle();
        await removeStaging(builtStagingRoot);
      },
    };
  } catch (error) {
    let result = failureResult(error, timeoutMs);
    if (stagingRoot) {
      try {
        await removeStaging(stagingRoot);
      } catch (cleanupError) {
        result = {
          ok: false,
          error: {
            ...result.error,
            code: "output-io",
            path: stagingRoot,
            message: `${result.error.message} Staging cleanup at ` +
              `${stagingRoot} also failed: ${errorMessage(cleanupError)}`,
          },
        };
      }
    }
    return result;
  }
}

export function resolvePluginEsbuildBinary(
  resourcesBasePath = process.resourcesPath,
  platform = process.platform,
  arch = process.arch,
): string {
  const platformKey = `${platform}-${arch}`;
  const executable = platform === "win32"
    ? ["esbuild.exe"]
    : ["bin", "esbuild"];
  return join(
    resolve(resourcesBasePath),
    "plugin-tools",
    "esbuild",
    platformKey,
    "node_modules",
    "@esbuild",
    platformKey,
    ...executable,
  );
}

export function buildPluginBundle(
  input: BuildPluginBundleInput,
): Promise<PluginBuildResult> {
  const job = buildQueue.then(
    () => runBuildJob(input),
    () => runBuildJob(input),
  );
  buildQueue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}
