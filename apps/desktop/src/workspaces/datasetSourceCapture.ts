import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { CAPTURE_HELD_WORDS } from "../ipc/errorWords";

export interface SourceCaptureStatus {
  heldFiles: readonly { path: string }[];
  deferredWrites: readonly string[];
}

/** Settle disk observations before reading immutable Collection source. */
export async function flushDatasetSourceCapture(
  adapter: Pick<VersionedLiveAdapter, "reconcileCapture" | "flushCapture">,
  signal: AbortSignal,
  paths?: readonly string[],
): Promise<SourceCaptureStatus> {
  signal.throwIfAborted();
  let capture = await adapter.reconcileCapture();
  for (let attempt = 0; !capture.settled && !capture.degraded && attempt < 8; attempt++) {
    signal.throwIfAborted();
    capture = await adapter.flushCapture();
  }
  signal.throwIfAborted();
  if (!capture.settled || !capture.running || capture.degraded) {
    throw new Error("dohc could not capture these files. Reopen the workspace.");
  }
  assertSourcePathsNotHeld(capture.heldFiles, paths ?? []);
  assertSourcePathsNotDeferred(capture.deferredWrites, paths ?? []);
  return capture;
}

export function assertSourcePathsNotDeferred(files: readonly string[], paths: readonly string[], under?: string): void {
  const waiting = files.find(path => paths.includes(path) || (under !== undefined && (path === under || path.startsWith(under + "/"))));
  if (waiting) {
    throw new Error(`"${waiting}" has an outside change waiting while it is open. Close the file, then try again.`);
  }
}

export function assertSourcePathsNotHeld(files: readonly { path: string }[], paths: readonly string[]): void {
  const held = files.find(file => paths.includes(file.path));
  if (held) {
    throw new Error(`dohc cannot use "${held.path}" for this change. ${CAPTURE_HELD_WORDS}`);
  }
}
