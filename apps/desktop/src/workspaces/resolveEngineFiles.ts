import {
  MAX_FILE_RESOLVE_TARGETS,
  MAX_FILE_RESOLVE_BYTES,
  type FileResolveTarget,
  type FileResolution,
} from "@dohc/workspace-engine-client/daemon";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

import type { WorkspaceFileRef } from "@dohc/workspace-contracts/workspace-ref";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { posix } from "node:path";

export function workspaceFileRef(workspaceId: string, objectId: string, path?: string): WorkspaceFileRef {
  return {
    workspaceId, target: { kind: "file", objectId },
    labels: { ...(path !== undefined ? { path } : {}), name: path ? posix.basename(path) : "", displayKind: fileKindForPath(path ?? "").displayKind },
  };
}

export type EngineFileReferenceTarget = { path: string } | WorkspaceFileRef;
export type WorkspaceFileResolution = Exclude<FileResolution, { status: "found" }> |
  (Extract<FileResolution, { status: "found" }> & { ref: WorkspaceFileRef });

export type EngineFileResolver<Workspace> = (
  workspace: Workspace,
  targets: readonly EngineFileReferenceTarget[],
) => Promise<readonly WorkspaceFileResolution[]>;

/** Pin the first version across bounded batches, including oversized legacy hints. */
export async function resolveEngineFileTargets(
  adapter: Pick<VersionedLiveAdapter, "resolveFiles">,
  workspaceId: string,
  targets: readonly FileResolveTarget[],
  assertCurrent?: () => void,
): Promise<FileResolution[]> {
  const results: FileResolution[] = [];
  let versionId: string | undefined;
  let batch: FileResolveTarget[] = [];
  const emptyRequestBytes = () => Buffer.byteLength(JSON.stringify({ versionId, targets: [] }));
  let batchBytes = emptyRequestBytes();
  const flush = async () => {
    if (!batch.length) return;
    assertCurrent?.();
    const resolved = await adapter.resolveFiles({
      workspaceId,
      ...(versionId !== undefined ? { versionId } : {}),
      targets: batch,
    });
    assertCurrent?.();
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
    work: (adapter: VersionedLiveAdapter, assertCurrent?: () => void) => Promise<T>,
  ) => Promise<T | null>,
): EngineFileResolver<Workspace> {
  return async (workspace, targets) => {
    const selected = targets.flatMap((target, index) => {
      if ("target" in target) {
        return target.workspaceId === workspace.workspaceId
          ? [{ index, target: { objectId: target.target.objectId } as FileResolveTarget }] : [];
      }
      return [{ index, target }];
    });
    const files = await withEngineAdapter(workspace, (adapter, assertCurrent) =>
      resolveEngineFileTargets(adapter, workspace.workspaceId, selected.map(row => row.target), assertCurrent));
    if (files === null) throw new Error("Workspace engine is unavailable.");
    const results: WorkspaceFileResolution[] = targets.map(() => ({ status: "absent" }));
    files.forEach((file, index) => {
      results[selected[index]!.index] = file.status === "found"
        ? { ...file, ref: workspaceFileRef(workspace.workspaceId, file.objectId, file.path) } : file;
    });
    return results;
  };
}
