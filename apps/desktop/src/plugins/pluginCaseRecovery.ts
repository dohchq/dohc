import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Folds a path segment for case-insensitive comparison: NFC-normalize first,
 * then lowercase. Recovery already compares this way; every other
 * case-insensitive ownership or path fold must match it exactly, or a
 * caller-spelled path that normalizes differently than a discovery root can
 * silently miss ownership recovery would otherwise confirm.
 */
export function foldForCompare(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Walks `relativePath`'s segments under `root`, folding each one to its true
 * on-disk spelling via a real readdir at every level (never realpathSync,
 * which resolves symlinks and junctions instead of just recovering case).
 * Stops folding — but still returns every remaining segment as given — the
 * moment a directory can't be read or a segment has no on-disk match, so a
 * transient failure or a not-yet-created leaf never blocks the caller with a
 * thrown error. `fullyRecovered` tells the caller whether every segment came
 * from a real directory entry; `false` means folding stopped early (an
 * unreadable directory or a segment with no on-disk match) and every remaining
 * segment is the caller's own spelling, not a confirmed one.
 */
export async function recoverOnDiskSegments(
  root: string,
  relativePath: string,
  signal: AbortSignal | undefined,
): Promise<{ segments: string[]; fullyRecovered: boolean }> {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  const recovered: string[] = [];
  let currentDir = root;
  let folding = true;
  let fullyRecovered = true;

  for (const segment of segments) {
    if (signal?.aborted) {
      throw new Error("Plugin panel is no longer active.");
    }
    if (folding) {
      let entries: string[] = [];
      let readable = true;
      try {
        entries = await readdir(currentDir);
      } catch {
        readable = false;
      }
      if (!readable) {
        fullyRecovered = false;
        folding = false;
      } else {
        const normalizedSegment = segment.normalize("NFC");
        const match = entries.find((entry) => entry === segment) ??
          entries.find(
            (entry) => entry.normalize("NFC") === normalizedSegment,
          ) ??
          entries.find(
            (entry) => foldForCompare(entry) === foldForCompare(segment),
          );
        if (match !== undefined) {
          recovered.push(match);
          currentDir = join(currentDir, match);
          continue;
        }
        fullyRecovered = false;
        folding = false;
      }
    }
    recovered.push(segment);
  }

  if (signal?.aborted) {
    throw new Error("Plugin panel is no longer active.");
  }

  return { segments: recovered, fullyRecovered };
}
