import {
  MAX_FILE_RESOLVE_TARGETS,
  MAX_FILE_RESOLVE_BYTES,
  type FileResolveTarget,
  type FileResolution,
} from "@dohc/workspace-engine-client/daemon";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

export type EngineFileResolver<Workspace> = (
  workspace: Workspace,
  targets: readonly FileResolveTarget[],
) => Promise<readonly FileResolution[]>;

/** Pin the first version across bounded batches, including oversized legacy hints. */
export async function resolveEngineFileTargets(
  adapter: Pick<VersionedLiveAdapter, "resolveFiles">,
  workspaceId: string,
  targets: readonly FileResolveTarget[],
): Promise<FileResolution[]> {
  const results: FileResolution[] = [];
  let versionId: string | undefined;
  let batch: FileResolveTarget[] = [];
  const requestBytes = (targets: readonly FileResolveTarget[]) =>
    Buffer.byteLength(JSON.stringify({ versionId, targets }));
  const flush = async () => {
    if (!batch.length) return;
    const resolved = await adapter.resolveFiles({
      workspaceId,
      ...(versionId !== undefined ? { versionId } : {}),
      targets: batch,
    });
    versionId = resolved.versionId;
    results.push(...resolved.results);
    batch = [];
  };
  for (const target of targets) {
    if (batch.length === MAX_FILE_RESOLVE_TARGETS ||
        requestBytes([...batch, target]) > MAX_FILE_RESOLVE_BYTES) await flush();
    // Hints are display metadata. An oversized hint cannot break other targets.
    if (requestBytes([target]) > MAX_FILE_RESOLVE_BYTES) {
      results.push({ status: "invalid" });
      continue;
    }
    batch.push(target);
  }
  await flush();
  return results;
}
