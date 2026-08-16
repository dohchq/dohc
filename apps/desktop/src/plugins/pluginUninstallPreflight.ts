import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { PLUGIN_UNINSTALL_PATH_SAMPLE_LIMIT } from "../ipc/channels";
import {
  canonicalPluginSourceHash,
  hashPluginSourceFiles,
  pluginIdToSafePath,
  type PluginSourceDigest,
  type PluginSourceFileDigest,
} from "./pluginSourceSnapshot";
import { formatSize, plural } from "./pluginFormat";
import { errorMessage, lexicalCompare } from "./pluginShared";

const BASELINE_MANIFEST_FILE_NAME = "baseline-manifest.json";
const Sha256Digest = z.string().regex(/^[0-9a-f]{64}$/);
const PosixRelativePath = z.string().min(1).refine((relPath) => {
  if (relPath.includes("\\") || relPath.includes("\0")) return false;
  if (relPath.startsWith("/") || relPath.endsWith("/")) return false;
  return relPath.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}, "must be a safe POSIX-relative file path");

const PluginBaselineManifestSchema = z.object({
  sourceHash: Sha256Digest,
  files: z.array(z.object({
    relPath: PosixRelativePath,
    sha256: Sha256Digest,
  }).strict()),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (seen.has(file.relPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files", index, "relPath"],
        message: `duplicate path "${file.relPath}"`,
      });
    }
    seen.add(file.relPath);
  }
});

export type PluginBaselineManifest = z.infer<
  typeof PluginBaselineManifestSchema
>;

export type PluginUninstallFileStatus =
  | "unchanged"
  | "modified"
  | "added-since-baseline"
  | "removed-since-baseline"
  | "unknown-without-baseline";

/**
 * The statuses uninstall actually deletes and dohc cannot promise back. dohc
 * has no per-file capture query — the engine exposes only workspace-wide
 * moment listing — so it cannot confirm that any specific file reached a
 * settled capture batch. An edit made seconds ago may never have been
 * recorded. Rather than promise recovery from a size check and a
 * capture-is-running flag, every file uninstall deletes and cannot verify
 * counts as unverified (#779 round 7 B2).
 */
const UNVERIFIED_DELETE_STATUSES = new Set<PluginUninstallFileStatus>([
  "modified",
  "added-since-baseline",
  "unknown-without-baseline",
]);

export interface PluginUninstallFileInventory {
  relPath: string;
  status: PluginUninstallFileStatus;
}

export interface PluginUninstallPreflightCounts {
  unchanged: number;
  modified: number;
  addedSinceBaseline: number;
  removedSinceBaseline: number;
  unknownWithoutBaseline: number;
  notRecoverableFromHistory: number;
}

export interface PluginUninstallWarning {
  kind: "local-modifications" | "cannot-verify-baseline" | "plugin-state";
  summary: string;
  details: string[];
  counts: PluginUninstallPreflightCounts;
  notRecoverablePaths: string[];
}

/**
 * What one of a plugin's directories holds. Two surfaces ask: the uninstall
 * warning, about the state root a wrapper filled with sessions, logs, and
 * secrets — it lives beside the app's userData, not in the workspace, and the
 * engine never captures it, so uninstall deleting it is genuinely
 * irreversible and the warning must say so (decision 7 of the t3 brief) — and
 * the details rail, about that same state root and the installed tree.
 */
export interface PluginDirectorySize {
  path: string;
  fileCount: number;
  totalBytes: number;
}

export interface PluginUninstallPreflightResult {
  verification: "verified" | "cannot-verify";
  installedBaselineHash: string | null;
  liveHash: string | null;
  baselineManifestPath: string;
  summary: string;
  counts: PluginUninstallPreflightCounts;
  files: PluginUninstallFileInventory[];
  notRecoverablePaths: string[];
  stateData: PluginDirectorySize | null;
  warning: PluginUninstallWarning | null;
}

/** What the uninstall dialog reads. The per-file inventory and the whole
 * unrecoverable-path list stay in main: a plugin tree can hold thousands of
 * files, and the dialog shows counts, the warning text, and a sample. */
export interface PluginUninstallPreflightSummary {
  verification: "verified" | "cannot-verify";
  installedBaselineHash: string | null;
  liveHash: string | null;
  baselineManifestPath: string;
  summary: string;
  counts: PluginUninstallPreflightCounts;
  stateData: PluginDirectorySize | null;
  warning:
    | {
      kind: PluginUninstallWarning["kind"];
      summary: string;
      details: string[];
      counts: PluginUninstallPreflightCounts;
      notRecoverablePathSample: string[];
    }
    | null;
}

export function summarizeUninstallPreflight(
  result: PluginUninstallPreflightResult,
): PluginUninstallPreflightSummary {
  return {
    verification: result.verification,
    installedBaselineHash: result.installedBaselineHash,
    liveHash: result.liveHash,
    baselineManifestPath: result.baselineManifestPath,
    summary: result.summary,
    counts: result.counts,
    stateData: result.stateData,
    warning: result.warning
      ? {
        kind: result.warning.kind,
        summary: result.warning.summary,
        details: result.warning.details,
        counts: result.warning.counts,
        notRecoverablePathSample: result.warning.notRecoverablePaths.slice(
          0,
          PLUGIN_UNINSTALL_PATH_SAMPLE_LIMIT,
        ),
      }
      : null,
  };
}

export interface WritePluginBaselineManifestInput {
  /** The app's userData-resident plugin-data root (PluginPipeline's
   * dohcDir), never a workspace-relative path (CERT779). */
  dohcDir: string;
  pluginId: string;
  baselineDigest: PluginSourceDigest;
  installedBaselineHash: string;
}

export interface PluginUninstallPreflightInput {
  /** See WritePluginBaselineManifestInput.dohcDir. */
  dohcDir: string;
  pluginId: string;
  pluginRoot: string;
  /** The plugin's durable data directory (pluginStateRoot) — inventoried so
   * the uninstall warning can name what deleting it destroys. */
  stateRoot: string;
  installedBaselineHash: string | undefined;
  /**
   * Whether this workspace's engine capture is running right now. It does not
   * change which files count as unverified — nothing here can confirm a
   * specific file was captured — but it separates "dohc cannot confirm this"
   * from the stronger, certain "history holds nothing" in the warning.
   */
  engineCaptureAvailable: boolean;
}

type BaselineManifestRead =
  | { kind: "ok"; manifest: PluginBaselineManifest }
  | { kind: "missing" }
  | { kind: "invalid"; problem: string };

function emptyCounts(): PluginUninstallPreflightCounts {
  return {
    unchanged: 0,
    modified: 0,
    addedSinceBaseline: 0,
    removedSinceBaseline: 0,
    unknownWithoutBaseline: 0,
    notRecoverableFromHistory: 0,
  };
}

/** What the dialog says about getting these files back. */
function recoveryDetails(engineCaptureAvailable: boolean): string[] {
  return [
    engineCaptureAvailable
      ? "dohc cannot confirm history holds a copy of the files uninstall will delete."
      : "History capture is not running, so history holds no copy of these files.",
    "Copy what you need before you uninstall.",
  ];
}

export function pluginBaselineManifestPath(
  dohcDir: string,
  pluginId: string,
): string {
  return join(
    resolve(dohcDir),
    "plugins",
    pluginIdToSafePath(pluginId),
    BASELINE_MANIFEST_FILE_NAME,
  );
}

function manifestFromDigest(digest: PluginSourceDigest): PluginBaselineManifest {
  return PluginBaselineManifestSchema.parse({
    sourceHash: digest.sourceHash,
    files: digest.files.map(({ relPath, sha256 }) => ({ relPath, sha256 })),
  });
}

export async function writePluginBaselineManifest(
  input: WritePluginBaselineManifestInput,
): Promise<{ path: string; manifest: PluginBaselineManifest }> {
  const digest = input.baselineDigest;
  const canonicalHash = canonicalPluginSourceHash(digest.files);
  if (canonicalHash !== digest.sourceHash) {
    throw new Error(
      `Plugin baseline file digest ${canonicalHash} does not match sourceHash ${digest.sourceHash}.`,
    );
  }
  if (digest.sourceHash !== input.installedBaselineHash) {
    throw new Error(
      `Plugin baseline source hash ${digest.sourceHash} does not match installedBaselineHash ${input.installedBaselineHash}.`,
    );
  }
  const manifest = manifestFromDigest(digest);
  const path = pluginBaselineManifestPath(input.dohcDir, input.pluginId);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { path, manifest };
}

/**
 * The persisted per-file baseline of the installed, approved source — or
 * null when it is missing or does not verify. PluginPipeline's door-write
 * predicate overlays door deltas on it, and a baseline it cannot prove
 * simply never auto-approves (#779 round 14 A1).
 */
export async function readPluginBaselineManifest(
  dohcDir: string,
  pluginId: string,
): Promise<PluginBaselineManifest | null> {
  try {
    const read = await readBaselineManifest(
      pluginBaselineManifestPath(dohcDir, pluginId),
    );
    return read.kind === "ok" ? read.manifest : null;
  } catch {
    return null;
  }
}

async function readBaselineManifest(path: string): Promise<BaselineManifestRead> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid", problem: errorMessage(error) };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return {
      kind: "invalid",
      problem: "the installation baseline manifest is not a regular file",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    return { kind: "invalid", problem: errorMessage(error) };
  }
  const parsed = PluginBaselineManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: "invalid",
      problem: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  if (canonicalPluginSourceHash(parsed.data.files) !== parsed.data.sourceHash) {
    return {
      kind: "invalid",
      problem: "the installation baseline manifest hash does not match its file list",
    };
  }
  return { kind: "ok", manifest: parsed.data };
}

function countInventory(
  files: readonly PluginUninstallFileInventory[],
): PluginUninstallPreflightCounts {
  const counts = emptyCounts();
  for (const file of files) {
    if (file.status === "unchanged") counts.unchanged += 1;
    if (file.status === "modified") counts.modified += 1;
    if (file.status === "added-since-baseline") counts.addedSinceBaseline += 1;
    if (file.status === "removed-since-baseline") counts.removedSinceBaseline += 1;
    if (file.status === "unknown-without-baseline") {
      counts.unknownWithoutBaseline += 1;
    }
    if (UNVERIFIED_DELETE_STATUSES.has(file.status)) {
      counts.notRecoverableFromHistory += 1;
    }
  }
  return counts;
}

function notRecoverablePaths(
  files: readonly PluginUninstallFileInventory[],
): string[] {
  return files
    .filter((file) => UNVERIFIED_DELETE_STATUSES.has(file.status))
    .map((file) => file.relPath)
    .sort(lexicalCompare);
}

function cannotVerifyResult(
  input: PluginUninstallPreflightInput,
  manifestPath: string,
  liveDigest: PluginSourceDigest | null,
  reason: string,
): PluginUninstallPreflightResult {
  const files: PluginUninstallFileInventory[] = (liveDigest?.files ?? []).map(
    (file) => ({ relPath: file.relPath, status: "unknown-without-baseline" }),
  );
  const counts = countInventory(files);
  const unrecoverable = notRecoverablePaths(files);
  const summary =
    `dohc cannot verify which plugin source files changed because ${reason}. ` +
    "Uninstall may delete source that history cannot restore.";
  const details = [
    `${counts.unknownWithoutBaseline} ${plural(counts.unknownWithoutBaseline, "source file")} cannot be compared with the installation baseline.`,
    ...recoveryDetails(input.engineCaptureAvailable),
  ];
  const warning: PluginUninstallWarning = {
    kind: "cannot-verify-baseline",
    summary,
    details,
    counts,
    notRecoverablePaths: unrecoverable,
  };
  return {
    verification: "cannot-verify",
    installedBaselineHash: input.installedBaselineHash ?? null,
    liveHash: liveDigest?.sourceHash ?? null,
    baselineManifestPath: manifestPath,
    summary,
    counts,
    files,
    notRecoverablePaths: unrecoverable,
    stateData: null,
    warning,
  };
}

/**
 * The plugin's source folder is already deleted, so uninstall has nothing
 * irreversible left to warn about. This is what an uninstall that deleted the
 * source and then failed on the plugin data or the record leaves behind
 * (#779 round 12 A2).
 */
function sourceAlreadyDeletedResult(
  input: PluginUninstallPreflightInput,
  manifestPath: string,
): PluginUninstallPreflightResult {
  return {
    verification: "verified",
    installedBaselineHash: input.installedBaselineHash ?? null,
    liveHash: null,
    baselineManifestPath: manifestPath,
    summary:
      "This plugin's source folder is already deleted. Uninstall removes what is left: the files dohc built and dohc's record of the installation.",
    counts: emptyCounts(),
    files: [],
    notRecoverablePaths: [],
    stateData: null,
    warning: null,
  };
}

function verifiedInventory(
  liveDigest: PluginSourceDigest,
  baselineFiles: readonly PluginSourceFileDigest[],
): PluginUninstallFileInventory[] {
  const files: PluginUninstallFileInventory[] = [];
  const baselineByPath = new Map(
    baselineFiles.map((file) => [file.relPath, file.sha256]),
  );
  for (const liveFile of liveDigest.files) {
    const baselineHash = baselineByPath.get(liveFile.relPath);
    files.push({
      relPath: liveFile.relPath,
      status: baselineHash === liveFile.sha256
        ? "unchanged"
        : baselineHash === undefined
          ? "added-since-baseline"
          : "modified",
    });
    baselineByPath.delete(liveFile.relPath);
  }
  for (const relPath of baselineByPath.keys()) {
    files.push({ relPath, status: "removed-since-baseline" });
  }
  files.sort((left, right) => lexicalCompare(left.relPath, right.relPath));
  return files;
}

/** Counts the files and bytes under one of a plugin's directories, or null
 * when it holds no files. Unreadable entries are skipped rather than failing
 * the caller: this inventory informs a warning and a rail row, it does not
 * gate. Symlinks are counted as neither file nor directory, so the walk never
 * follows one out of the tree it was given. */
export async function measurePluginDirectory(
  directoryRoot: string,
): Promise<PluginDirectorySize | null> {
  const root = resolve(directoryRoot);
  let fileCount = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) pending.push(path);
      else if (stats.isFile()) {
        fileCount += 1;
        totalBytes += stats.size;
      }
    }
  }
  return fileCount === 0 ? null : { path: root, fileCount, totalBytes };
}

/**
 * Folds the state-root inventory into the result. Plugin state is deleted by
 * every successful uninstall, is not part of the workspace, and is never
 * captured by the engine — so when it exists, the warning must name it as
 * permanently deleted (the irreversible-change invariant), whether or not
 * the source tree had its own warning.
 */
function withStateData(
  result: PluginUninstallPreflightResult,
  stateData: PluginDirectorySize | null,
): PluginUninstallPreflightResult {
  if (!stateData) return result;
  const details = [
    `Uninstall also deletes this plugin's stored data: ${stateData.fileCount} ${plural(stateData.fileCount, "file")} (${formatSize(stateData.totalBytes)}) at ${stateData.path}.`,
    "That data is not in the workspace and history holds no copy. It cannot be restored.",
  ];
  const warning: PluginUninstallWarning = result.warning
    ? { ...result.warning, details: [...result.warning.details, ...details] }
    : {
      kind: "plugin-state",
      summary:
        `Uninstall deletes this plugin's stored data: ${stateData.fileCount} ${plural(stateData.fileCount, "file")} (${formatSize(stateData.totalBytes)}). It cannot be restored.`,
      details: [...details, "Copy what you need before you uninstall."],
      counts: result.counts,
      notRecoverablePaths: result.notRecoverablePaths,
    };
  return { ...result, stateData, warning };
}

export async function pluginUninstallPreflight(
  input: PluginUninstallPreflightInput,
): Promise<PluginUninstallPreflightResult> {
  return withStateData(
    await sourceUninstallPreflight(input),
    await measurePluginDirectory(input.stateRoot),
  );
}

async function sourceUninstallPreflight(
  input: PluginUninstallPreflightInput,
): Promise<PluginUninstallPreflightResult> {
  const manifestPath = pluginBaselineManifestPath(
    input.dohcDir,
    input.pluginId,
  );
  let liveDigest: PluginSourceDigest;
  try {
    liveDigest = await hashPluginSourceFiles(resolve(input.pluginRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return sourceAlreadyDeletedResult(input, manifestPath);
    }
    return cannotVerifyResult(
      input,
      manifestPath,
      null,
      `dohc could not read the live source: ${errorMessage(error)}`,
    );
  }

  if (!input.installedBaselineHash) {
    return cannotVerifyResult(
      input,
      manifestPath,
      liveDigest,
      "the installed baseline hash is missing",
    );
  }

  const baselineRead = await readBaselineManifest(manifestPath);
  if (baselineRead.kind === "missing") {
    return cannotVerifyResult(
      input,
      manifestPath,
      liveDigest,
      "the installation baseline manifest is missing",
    );
  }
  if (baselineRead.kind === "invalid") {
    return cannotVerifyResult(
      input,
      manifestPath,
      liveDigest,
      `the installation baseline manifest is invalid: ${baselineRead.problem}`,
    );
  }
  if (baselineRead.manifest.sourceHash !== input.installedBaselineHash) {
    return cannotVerifyResult(
      input,
      manifestPath,
      liveDigest,
      "the installation baseline manifest does not match the installed baseline hash",
    );
  }

  const files = verifiedInventory(liveDigest, baselineRead.manifest.files);
  const counts = countInventory(files);
  const unrecoverable = notRecoverablePaths(files);
  const changedCount = counts.modified + counts.addedSinceBaseline;
  if (changedCount === 0 && counts.removedSinceBaseline === 0) {
    const summary =
      "No local source modifications found. The installed source and build output are reproducible.";
    return {
      verification: "verified",
      installedBaselineHash: input.installedBaselineHash,
      liveHash: liveDigest.sourceHash,
      baselineManifestPath: manifestPath,
      summary,
      counts,
      files,
      notRecoverablePaths: unrecoverable,
      stateData: null,
      warning: null,
    };
  }

  const summary = changedCount > 0
    ? `Uninstall will delete ${changedCount} modified or added plugin source ${plural(changedCount, "file")}.`
    : counts.removedSinceBaseline === 1
      ? "1 installation baseline file is already missing. Uninstall will not delete it."
      : `${counts.removedSinceBaseline} installation baseline files are already missing. Uninstall will not delete them.`;
  const details = [
    `${counts.modified} modified, ${counts.addedSinceBaseline} added, and ${counts.removedSinceBaseline} removed since the installation baseline.`,
    ...recoveryDetails(input.engineCaptureAvailable),
  ];
  if (counts.removedSinceBaseline > 0) {
    details.push(
      `${counts.removedSinceBaseline} removed baseline ${plural(counts.removedSinceBaseline, "file")} will not be an uninstall delete target.`,
    );
  }
  const warning: PluginUninstallWarning = {
    kind: "local-modifications",
    summary,
    details,
    counts,
    notRecoverablePaths: unrecoverable,
  };
  return {
    verification: "verified",
    installedBaselineHash: input.installedBaselineHash,
    liveHash: liveDigest.sourceHash,
    baselineManifestPath: manifestPath,
    summary,
    counts,
    files,
    notRecoverablePaths: unrecoverable,
    stateData: null,
    warning,
  };
}
