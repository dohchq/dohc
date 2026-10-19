import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

/** Settle disk observations before reading immutable Collection source. */
export async function flushDatasetSourceCapture(
  adapter: Pick<VersionedLiveAdapter, "reconcileCapture" | "flushCapture">,
  signal: AbortSignal,
  paths?: readonly string[],
): Promise<Awaited<ReturnType<VersionedLiveAdapter["flushCapture"]>>["heldFiles"]> {
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
  return capture.heldFiles;
}

export function assertSourcePathsNotHeld(files: readonly { path: string }[], paths: readonly string[]): void {
  const held = files.find(file => paths.includes(file.path));
  if (held) {
    throw new Error(`dohc cannot use "${held.path}" for this change. dohc cannot represent part of the file, such as a very deeply nested quote. The file is unchanged on this computer. Change that part in another editor.`);
  }
}
