import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { isInside } from "../security/pathContainment";
import { foldForCompare, recoverOnDiskSegments } from "./pluginCaseRecovery";
import { canonicalPluginSourceHash, isExcludedSourceName, type PluginSourceFileDigest } from "./pluginSourceSnapshot";
import { readPluginBaselineManifest } from "./pluginUninstallPreflight";

interface DoorWrittenDelta {
  sha256: string;
  seq: number;
  provisional?: boolean;
  /**
   * The write's original, caller-spelled absolute path. Set only when
   * landing attributed this delta through sourceRelPath's case-insensitive
   * fold, not an exact root match — an exact landing already proved
   * ownership, so it has nothing left to re-confirm. retryProvisionalDeltaRecovery
   * walks this path from the workspace root to confirm or disprove that
   * guess; a rekeyed or landing-exact delta carries no origin because it
   * needs none.
   */
  provisionalOrigin?: string;
}

function overlayDoorWrittenSourceDeltas(
  baselineFiles: readonly PluginSourceFileDigest[],
  deltas: Iterable<readonly [string, DoorWrittenDelta]>,
  platform: NodeJS.Platform = process.platform,
): PluginSourceFileDigest[] {
  const files = new Map(
    baselineFiles.map((file) => [file.relPath, file.sha256]),
  );
  const baselineKeys = new Set(files.keys());
  const byLowerCase = platform === "win32" || platform === "darwin"
    ? new Map([...files.keys()].map((relPath) => [foldForCompare(relPath), relPath]))
    : undefined;
  for (
    const [relPath, delta] of [...deltas].sort((a, b) => a[1].seq - b[1].seq)
  ) {
    const target = delta.provisional && byLowerCase && !baselineKeys.has(relPath)
      ? byLowerCase.get(foldForCompare(relPath)) ?? relPath
      : relPath;
    files.set(target, delta.sha256);
  }
  return [...files].map(([relPath, sha256]) => ({ relPath, sha256 }));
}

export class PluginDoorWrites {
  /**
   * Every door-written file since the approved baseline, per plugin:
   * relPath (POSIX, root-relative) to the sha256 of the written bytes and
   * the write's order in doorWriteSeq. See record
   * and approvedHash — this overlay, applied to the persisted baseline
   * manifest, is the only tree the door path may auto-approve. Overlay
   * A landing-time key is provisional until pluginAuthoredWrite's async case
   * recovery moves it to the spelling read from disk.
   */
  private readonly doorWrittenDeltas = new Map<
    string,
    Map<string, DoorWrittenDelta>
  >();
  /** Orders door writes against each build's snapshot; see runFullBuild. */
  private doorWriteSeq = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly dohcDir: string,
    private readonly platform: NodeJS.Platform,
    private readonly validRootFor: (pluginId: string) => string | null,
  ) {}

  private sourceRelPathExact(
    rootPath: string,
    absolutePath: string,
  ): string | null {
    const root = resolve(rootPath);
    const target = resolve(absolutePath);
    if (target === root) return null;
    if (!isInside(root, target)) return null;
    return relative(root, target).replaceAll("\\", "/");
  }

  private sourceRelPath(
    rootPath: string,
    absolutePath: string,
  ): string | null {
    const exact = this.sourceRelPathExact(rootPath, absolutePath);
    if (exact !== null) return exact;
    if (this.platform !== "win32" && this.platform !== "darwin") return null;
    const root = resolve(rootPath);
    const target = resolve(absolutePath);
    const foldedRoot = foldForCompare(root);
    const foldedTarget = foldForCompare(target);
    if (foldedTarget === foldedRoot || !isInside(foldedRoot, foldedTarget)) return null;
    const rootSegments = root.split(/[\\/]+/).filter(Boolean);
    const targetSegments = target.split(/[\\/]+/).filter(Boolean);
    if (
      rootSegments.length >= targetSegments.length ||
      rootSegments.some((segment, index) => {
        const targetSegment = targetSegments[index];
        return targetSegment === undefined ||
          foldForCompare(segment) !== foldForCompare(targetSegment);
      })
    ) {
      return null;
    }
    return targetSegments.slice(rootSegments.length).join("/");
  }

  record(
    pluginId: string,
    write: { absolutePath: string; text: string },
  ): boolean {
    const rootPath = this.validRootFor(pluginId);
    if (rootPath === null) return false;
    const exactRelPath = this.sourceRelPathExact(rootPath, write.absolutePath);
    const relPath = exactRelPath ?? this.sourceRelPath(rootPath, write.absolutePath);
    if (relPath === null) return false;
    // node_modules and .dohc are excluded from every source digest, so a
    // write under them cannot change the hash this predicate compares.
    if (this.isExcludedRelPath(relPath)) return false;
    const deltas = this.doorWrittenDeltas.get(pluginId) ??
      new Map<string, DoorWrittenDelta>();
    deltas.set(relPath, {
      sha256: createHash("sha256").update(write.text, "utf8").digest("hex"),
      seq: ++this.doorWriteSeq,
      provisional: true,
      provisionalOrigin: exactRelPath === null ? write.absolutePath : undefined,
    });
    this.doorWrittenDeltas.set(pluginId, deltas);
    return true;
  }

  /**
   * Moves a door-written delta from its landing-time spelling to its recovered
   * on-disk spelling, preserving its sequence. This settles one write; it
   * does not create another. A missing source entry was already superseded.
   */
  rekey(
    pluginId: string,
    from: { absolutePath: string },
    to: { absolutePath: string },
  ): boolean {
    const rootPath = this.validRootFor(pluginId);
    if (rootPath === null) return false;
    const fromRelPath = this.sourceRelPath(rootPath, from.absolutePath);
    if (fromRelPath === null) return false;
    const deltas = this.doorWrittenDeltas.get(pluginId);
    const delta = deltas?.get(fromRelPath);
    if (!deltas || !delta) return false;

    const toRelPath = this.sourceRelPathExact(rootPath, to.absolutePath);
    if (toRelPath === null) {
      // Recovery resolved the write's true on-disk path, and it is not
      // under the plugin's real root: the landing-time fold guessed
      // ownership from spelling alone, and a case-sensitive volume just
      // proved that guess wrong. Drop the provisional attribution — this
      // is an ordinary out-of-band change to a distinct, real directory,
      // not this plugin's own source.
      deltas.delete(fromRelPath);
      return true;
    }

    if (this.isExcludedRelPath(toRelPath)) {
      deltas.delete(fromRelPath);
      return true;
    }

    const destination = deltas.get(toRelPath);
    const pathChanged = fromRelPath !== toRelPath;
    if (pathChanged) deltas.delete(fromRelPath);
    if (!destination || destination.seq <= delta.seq) {
      deltas.set(toRelPath, { sha256: delta.sha256, seq: delta.seq });
    }
    return pathChanged;
  }

  private isExcludedRelPath(relPath: string): boolean {
    return relPath.split("/").some((segment) => isExcludedSourceName(segment));
  }

  /**
   * Retries case recovery for every still-provisional delta before
   * approvedHash hashes them: confirms a landing-time fold's guessed
   * ownership, or recovers a leaf's on-disk spelling.
   */
  private async retryProvisionalDeltaRecovery(pluginId: string): Promise<void> {
    if (this.platform !== "win32" && this.platform !== "darwin") return;
    const deltas = this.doorWrittenDeltas.get(pluginId);
    if (!deltas) return;
    const rootPath = this.validRootFor(pluginId);
    if (rootPath === null) return;
    const root = resolve(rootPath);
    for (const [relPath, delta] of [...deltas]) {
      if (!delta.provisional) continue;
      const origin = delta.provisionalOrigin;
      const { segments, fullyRecovered } = await recoverOnDiskSegments(
        origin !== undefined ? this.workspaceRoot : root,
        origin !== undefined
          ? relative(this.workspaceRoot, origin).replaceAll("\\", "/")
          : relPath,
        undefined,
      );
      const current = deltas.get(relPath);
      if (!current || current.seq !== delta.seq) continue;
      if (!fullyRecovered) continue;
      const recoveredRelPath = origin !== undefined
        ? this.sourceRelPathExact(rootPath, join(this.workspaceRoot, ...segments))
        : segments.join("/");
      if (recoveredRelPath === null) {
        // Recovery resolved the write's true on-disk path, and it is not
        // under this plugin's real root: the landing-time fold guessed
        // ownership from spelling alone, and a case-sensitive volume just
        // proved that guess wrong. Drop it — the same confirmation
        // rekey applies to a delta the writer's own
        // recovery rekeys.
        deltas.delete(relPath);
        continue;
      }
      if (this.isExcludedRelPath(recoveredRelPath)) {
        deltas.delete(relPath);
        continue;
      }
      if (recoveredRelPath === relPath) {
        deltas.set(relPath, { sha256: delta.sha256, seq: delta.seq });
        continue;
      }
      deltas.delete(relPath);
      const destination = deltas.get(recoveredRelPath);
      if (!destination || destination.seq <= delta.seq) {
        deltas.set(recoveredRelPath, { sha256: delta.sha256, seq: delta.seq });
      }
    }
  }

  /**
   * The one tree the door path may auto-approve: the approved per-file
   * baseline overlaid with every door-written delta recorded since. Null
   * when no baseline verifies against the approved hash — a fresh
   * install's first approval is user-driven, and a baseline that cannot be
   * read or does not describe the approved content proves nothing, so
   * nothing auto-approves. Only record writes
   * deltas, so any other byte on disk — an interloper file, a
   * watcher-class edit, an out-of-band delete — makes the live tree miss
   * this hash and hold for approval. The SDK write surface has no delete,
   * so a delta only ever adds or replaces one file. The retry also confirms
   * ownership for a delta attributed through the landing-time path fold.
   */
  async approvedHash(
    pluginId: string,
    approvedHash: string,
  ): Promise<string | null> {
    const baseline = await readPluginBaselineManifest(this.dohcDir, pluginId);
    if (!baseline || baseline.sourceHash !== approvedHash) return null;
    await this.retryProvisionalDeltaRecovery(pluginId);
    return canonicalPluginSourceHash(
      overlayDoorWrittenSourceDeltas(
        baseline.files,
        this.doorWrittenDeltas.get(pluginId) ?? [],
        this.platform,
      ),
    );
  }

  checkpoint(): number {
    return this.doorWriteSeq;
  }

  settle(pluginId: string, checkpoint: number): void {
    const settledDeltas = this.doorWrittenDeltas.get(pluginId);
    if (settledDeltas) {
      for (const [relPath, delta] of settledDeltas) {
        if (delta.seq <= checkpoint) settledDeltas.delete(relPath);
      }
      if (settledDeltas.size === 0) {
        this.doorWrittenDeltas.delete(pluginId);
      }
    }
  }

  forget(pluginId: string): void {
    this.doorWrittenDeltas.delete(pluginId);
  }
}
