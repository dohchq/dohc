import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
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
  kind: "local-modifications" | "cannot-verify-baseline";
  summary: string;
  details: string[];
  counts: PluginUninstallPreflightCounts;
  notRecoverablePaths: string[];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

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
    warning,
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

export async function pluginUninstallPreflight(
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
    warning,
  };
}
