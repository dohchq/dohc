import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

/** Settle disk observations before reading immutable Collection source. */
export async function flushDatasetSourceCapture(
  adapter: Pick<VersionedLiveAdapter, "reconcileCapture" | "flushCapture">,
  signal: AbortSignal,
  paths?: readonly string[],
): Promise<void> {
  signal.throwIfAborted();
  let capture = await adapter.reconcileCapture();
  for (let attempt = 0; !capture.settled && !capture.degraded && attempt < 8; attempt++) {
    signal.throwIfAborted();
    capture = await adapter.flushCapture();
  }
  signal.throwIfAborted();
  if (!capture.settled || !capture.running || capture.degraded) {
    throw new Error("dohc could not capture these Collection files. Reopen the workspace and try again.");
  }
  const held = capture.heldFiles.find(file => !paths || paths.includes(file.path));
  if (held) {
    throw new Error(`dohc cannot use the content in ${held.path}. The file is still on disk. Edit it in another editor. Try again.`);
  }
}
