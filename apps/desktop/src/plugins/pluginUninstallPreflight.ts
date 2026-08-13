import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_VERSIONED_BINARY_FILE_BYTES } from "@dohc/workspace-contracts/engine";
import { isTextMediaType, mediaTypeForPath } from "@dohc/workspace-fs";
import { z } from "zod";
import { MAX_HISTORY_TEXT_SNAPSHOT_BYTES } from "../workspaces/workspaceWatcher";
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

export type PluginHistoryRecovery =
  | "captured-recoverable"
  | "not-recoverable-from-history";

export interface PluginUninstallFileInventory {
  relPath: string;
  status: PluginUninstallFileStatus;
  byteLength: number | null;
  contentKind: "text" | "binary" | null;
  historyRecovery: PluginHistoryRecovery | null;
}

export interface PluginUninstallPreflightCounts {
  unchanged: number;
  modified: number;
  addedSinceBaseline: number;
  removedSinceBaseline: number;
  unknownWithoutBaseline: number;
  capturedRecoverable: number;
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
   * Whether this workspace's engine capture is running right now. A file
   * under the history capture size cap is only actually "captured-
   * recoverable" if capture was there to record it — this preflight has no
   * way to confirm any specific past write actually settled, but it can at
   * least refuse to promise recovery for anything when capture is known to
   * be unavailable, rather than a size-only guess (recovery honesty).
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
    capturedRecoverable: 0,
    notRecoverableFromHistory: 0,
  };
}

function captureLimitDetail(): string {
  // These values mirror MAX_CAPTURE_TEXT_BYTES and MAX_CAPTURE_BINARY_BYTES
  // in crates/dohc-engine-files/src/bounds.rs.
  const textBytes = MAX_HISTORY_TEXT_SNAPSHOT_BYTES.toLocaleString("en-US");
  const binaryBytes = MAX_VERSIONED_BINARY_FILE_BYTES.toLocaleString("en-US");
  return `History does not store text files larger than ${textBytes} bytes, or binary files larger than ${binaryBytes} bytes.`;
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

function unreadableClassification(): Pick<
  PluginUninstallFileInventory,
  "byteLength" | "contentKind" | "historyRecovery"
> {
  return { byteLength: null, contentKind: null, historyRecovery: "not-recoverable-from-history" };
}

async function classifyHistoryRecovery(
  pluginRoot: string,
  file: PluginSourceFileDigest,
  engineCaptureAvailable: boolean,
): Promise<Pick<
  PluginUninstallFileInventory,
  "byteLength" | "contentKind" | "historyRecovery"
>> {
  const path = join(pluginRoot, ...file.relPath.split("/"));
  // A file the earlier hash pass saw can still disappear or change before
  // this runs — this must degrade to "can't confirm, so not recoverable"
  // rather than crash the whole preflight over one file (CodeRabbit #779
  // R27).
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch {
    return unreadableClassification();
  }
  const textMedia = isTextMediaType(mediaTypeForPath(file.relPath), file.relPath);
  const limit = textMedia
    ? MAX_HISTORY_TEXT_SNAPSHOT_BYTES
    : MAX_VERSIONED_BINARY_FILE_BYTES;
  // A file already over the larger of the two possible caps is not
  // recoverable regardless of its exact content kind — skip reading it at
  // all rather than loading a large, possibly multi-hundred-MB binary into
  // memory just to confirm a foregone conclusion (CodeRabbit #779 R27).
  if (stats.size > Math.max(MAX_HISTORY_TEXT_SNAPSHOT_BYTES, MAX_VERSIONED_BINARY_FILE_BYTES)) {
    return {
      byteLength: stats.size,
      contentKind: textMedia ? "text" : "binary",
      historyRecovery: "not-recoverable-from-history",
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return unreadableClassification();
  }
  const text = bytes.toString("utf8");
  const contentKind = textMedia && Buffer.from(text, "utf8").equals(bytes)
    ? "text"
    : "binary";
  const contentLimit = contentKind === "text"
    ? MAX_HISTORY_TEXT_SNAPSHOT_BYTES
    : MAX_VERSIONED_BINARY_FILE_BYTES;
  // Under the cap is necessary but not sufficient: capture also has to have
  // actually been running to record this file. When it wasn't, this can't
  // honestly promise recovery no matter how small the file is (CodeRabbit
  // #779 fixround Section B item 7).
  const underCap = bytes.byteLength <= contentLimit;
  return {
    byteLength: bytes.byteLength,
    contentKind,
    // The Rust capture floor keeps a file whose length equals the cap
    // exactly (materialize.rs compares with `>`, not `>=`): only a file
    // strictly larger than the cap goes untracked. Match that boundary
    // here so this warning never calls a captured file unrecoverable.
    historyRecovery: underCap && engineCaptureAvailable
      ? "captured-recoverable"
      : "not-recoverable-from-history",
  };
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
    if (file.historyRecovery === "captured-recoverable") {
      counts.capturedRecoverable += 1;
    }
    if (file.historyRecovery === "not-recoverable-from-history") {
      counts.notRecoverableFromHistory += 1;
    }
  }
  return counts;
}

function notRecoverablePaths(
  files: readonly PluginUninstallFileInventory[],
): string[] {
  return files
    .filter((file) =>
      file.historyRecovery === "not-recoverable-from-history"
    )
    .map((file) => file.relPath)
    .sort(lexicalCompare);
}

async function cannotVerifyResult(
  input: PluginUninstallPreflightInput,
  manifestPath: string,
  liveDigest: PluginSourceDigest | null,
  reason: string,
): Promise<PluginUninstallPreflightResult> {
  const files: PluginUninstallFileInventory[] = [];
  if (liveDigest) {
    for (const file of liveDigest.files) {
      const recovery = await classifyHistoryRecovery(
        input.pluginRoot,
        file,
        input.engineCaptureAvailable,
      );
      files.push({
        relPath: file.relPath,
        status: "unknown-without-baseline",
        ...recovery,
      });
    }
  }
  const counts = countInventory(files);
  const unrecoverable = notRecoverablePaths(files);
  const summary =
    `dohc cannot verify which plugin source files changed because ${reason}. ` +
    "Uninstall may delete source that history cannot restore.";
  const details = [
    `${counts.unknownWithoutBaseline} ${plural(counts.unknownWithoutBaseline, "source file")} cannot be compared with the installation baseline.`,
    captureLimitDetail(),
    ...(input.engineCaptureAvailable
      ? []
      : ["History capture is not currently running, so no file's recovery can be confirmed."]),
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

async function verifiedInventory(
  pluginRoot: string,
  liveDigest: PluginSourceDigest,
  baselineFiles: readonly PluginSourceFileDigest[],
  engineCaptureAvailable: boolean,
): Promise<PluginUninstallFileInventory[]> {
  const files: PluginUninstallFileInventory[] = [];
  const baselineByPath = new Map(
    baselineFiles.map((file) => [file.relPath, file.sha256]),
  );
  for (const liveFile of liveDigest.files) {
    const baselineHash = baselineByPath.get(liveFile.relPath);
    if (baselineHash === liveFile.sha256) {
      files.push({
        relPath: liveFile.relPath,
        status: "unchanged",
        byteLength: null,
        contentKind: null,
        historyRecovery: null,
      });
    } else {
      const recovery = await classifyHistoryRecovery(
        pluginRoot,
        liveFile,
        engineCaptureAvailable,
      );
      files.push({
        relPath: liveFile.relPath,
        status: baselineHash === undefined
          ? "added-since-baseline"
          : "modified",
        ...recovery,
      });
    }
    baselineByPath.delete(liveFile.relPath);
  }
  for (const relPath of baselineByPath.keys()) {
    files.push({
      relPath,
      status: "removed-since-baseline",
      byteLength: null,
      contentKind: null,
      historyRecovery: null,
    });
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

  const files = await verifiedInventory(
    resolve(input.pluginRoot),
    liveDigest,
    baselineRead.manifest.files,
    input.engineCaptureAvailable,
  );
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
    `${counts.capturedRecoverable} changed ${plural(counts.capturedRecoverable, "file")} can be recovered from history.`,
    `${counts.notRecoverableFromHistory} changed ${plural(counts.notRecoverableFromHistory, "file")} cannot be recovered from history.`,
    captureLimitDetail(),
  ];
  if (counts.removedSinceBaseline > 0) {
    details.push(
      `${counts.removedSinceBaseline} removed baseline ${plural(counts.removedSinceBaseline, "file")} will not be an uninstall delete target.`,
    );
  }
  if (!input.engineCaptureAvailable) {
    details.push(
      "History capture is not currently running, so no file's recovery can be confirmed.",
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
