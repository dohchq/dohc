import {
  MAX_FILE_RESOLVE_TARGETS,
  MAX_FILE_RESOLVE_BYTES,
  type FileResolveTarget,
  type FileResolution,
} from "@dohc/workspace-engine-client/daemon";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { shareViewIsPresent } from "./shareViewMarker";
import type { ReceivedFileReferenceScope } from "./workspaceFileReferenceScopes";
import { isWorkspaceRefSource, isReceivedObject, type WorkspaceFileRef } from "@dohc/workspace-contracts/workspace-ref";

export function workspaceFileRef(workspaceId: string, objectId: string): WorkspaceFileRef {
  return {
    source: { workspaceId }, target: { kind: "file", objectId },
    labels: { name: "", displayKind: "binary" },
  };
}

export type EngineFileReferenceTarget = { path: string } | WorkspaceFileRef;

export type EngineFileResolver<Workspace> = (
  workspace: Workspace,
  targets: readonly EngineFileReferenceTarget[],
) => Promise<readonly FileResolution[]>;

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

export function createEngineFileResolver<Workspace extends { workspaceId: string; shareView?: unknown }>(
  withEngineAdapter: <T>(
    workspace: Workspace,
    work: (adapter: VersionedLiveAdapter, assertCurrent?: () => void) => Promise<T>,
  ) => Promise<T | null>,
  receivedScopes?: (workspace: Workspace) => Promise<readonly ReceivedFileReferenceScope<Workspace>[]>,
): EngineFileResolver<Workspace> {
  return async (workspace, targets) => {
    const selected = targets.flatMap((target, index) => {
      if ("target" in target) {
        if (!isWorkspaceRefSource(target.source)) return [];
        return target.source.workspaceId === workspace.workspaceId && !shareViewIsPresent(workspace.shareView)
          ? [{ index, target: { objectId: target.target.objectId } as FileResolveTarget }] : [];
      }
      return [{ index, target }];
    });
    const files = await withEngineAdapter(workspace, (adapter, assertCurrent) =>
      resolveEngineFileTargets(adapter, workspace.workspaceId, selected.map(row => row.target), assertCurrent));
    if (files === null) throw new Error("Workspace engine is unavailable.");
    const results: FileResolution[] = targets.map(() => ({ status: "absent" }));
    files.forEach((file, index) => {
      results[selected[index]!.index] = file;
    });
    if (receivedScopes && targets.some(target => "target" in target && isWorkspaceRefSource(target.source) && target.source.receivedSource)) {
      const scopes = await receivedScopes(workspace);
      for (const scope of scopes) {
        scope.assertCurrent();
        const received = targets.flatMap((target, index) => "target" in target && isWorkspaceRefSource(target.source) && target.source.receivedSource === scope.pin.receivedSource && isReceivedObject(target.target.objectId)
          ? [{ index, target: { objectId: target.target.objectId } }] : []);
        if (!received.length) continue;
        const resolved = await withEngineAdapter(scope.workspace, (adapter, assertCurrent) => resolveEngineFileTargets(adapter, scope.workspace.workspaceId, received.map(row => row.target), () => { assertCurrent?.(); scope.assertCurrent(); }));
        scope.assertCurrent();
        resolved?.forEach((file, i) => {
          if (file.status === "found" && visibleSharePath(scope.selector, file.path) !== null) results[received[i]!.index] = { ...file, path: `${scope.pathPrefix ?? ""}${file.path}` };
        });
      }
      for (const scope of scopes) scope.assertCurrent();
    }
    return results;
  };
}
