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
  const emptyRequestBytes = () => Buffer.byteLength(JSON.stringify({ versionId, targets: [] }));
  let batchBytes = emptyRequestBytes();
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
    batchBytes = emptyRequestBytes();
  };
  for (const target of targets) {
    const targetBytes = Buffer.byteLength(JSON.stringify(target));
    if (batch.length === MAX_FILE_RESOLVE_TARGETS ||
        batchBytes + targetBytes + (batch.length ? 1 : 0) > MAX_FILE_RESOLVE_BYTES) await flush();
    // Hints are display metadata. An oversized hint cannot break other targets.
    if (batchBytes + targetBytes + (batch.length ? 1 : 0) > MAX_FILE_RESOLVE_BYTES) {
      results.push({ status: "invalid" });
      continue;
    }
    batchBytes += targetBytes + (batch.length ? 1 : 0);
    batch.push(target);
  }
  await flush();
  return results;
}

export function createEngineFileResolver<Workspace extends { workspaceId: string }>(
  withEngineAdapter: <T>(
    workspace: Workspace,
    work: (adapter: VersionedLiveAdapter) => Promise<T>,
  ) => Promise<T | null>,
): EngineFileResolver<Workspace> {
  return async (workspace, targets) => {
    const results = await withEngineAdapter(workspace, adapter =>
      resolveEngineFileTargets(adapter, workspace.workspaceId, targets));
    if (results === null) throw new Error("Workspace engine is unavailable.");
    return results;
  };
}
