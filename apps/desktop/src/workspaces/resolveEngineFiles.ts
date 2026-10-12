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
  (Extract<FileResolution, { status: "found" }> & { ref: WorkspaceFileRef | null });

export interface FileReferenceScope<Workspace> {
  workspace: Workspace;
  sourceWorkspaceId: string | null;
  /** Prefix in the mounting workspace; absent for local files and standalone shares. */
  prefix?: string;
  versionId?: string;
  allowsPath?(path: string): boolean;
  assertCurrent(): void;
}

export type EngineFileResolver<Workspace> = (
  workspace: Workspace,
  targets: readonly EngineFileReferenceTarget[],
) => Promise<readonly WorkspaceFileResolution[]>;

/** Pin the first version across bounded batches, including oversized legacy hints. */
export async function resolveEngineFileTargets(
  adapter: Pick<VersionedLiveAdapter, "resolveFiles">,
  workspaceId: string,
  targets: readonly FileResolveTarget[],
  scope?: Pick<FileReferenceScope<unknown>, "versionId" | "assertCurrent" | "allowsPath">,
): Promise<FileResolution[]> {
  const results: FileResolution[] = [];
  let versionId = scope?.versionId;
  let batch: FileResolveTarget[] = [];
  const emptyRequestBytes = () => Buffer.byteLength(JSON.stringify({ versionId, targets: [] }));
  let batchBytes = emptyRequestBytes();
  const flush = async () => {
    if (!batch.length) return;
    scope?.assertCurrent();
    const resolved = await adapter.resolveFiles({
      workspaceId,
      ...(versionId !== undefined ? { versionId } : {}),
      targets: batch,
    });
    scope?.assertCurrent();
    versionId = resolved.versionId;
    results.push(...resolved.results.map(file => file.status === "found" && scope?.allowsPath && !scope.allowsPath(file.path)
      ? { status: "absent" as const } : file));
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
  scopesFor: (workspace: Workspace) => readonly FileReferenceScope<Workspace>[] = workspace => [
    { workspace, sourceWorkspaceId: workspace.workspaceId, assertCurrent() {} },
  ],
): EngineFileResolver<Workspace> {
  return async (workspace, targets) => {
    const scopes = scopesFor(workspace);
    const localScope = scopes.find(scope => scope.workspace === workspace && scope.prefix === undefined && scope.sourceWorkspaceId === workspace.workspaceId);
    const results: WorkspaceFileResolution[] = targets.map(() => ({ status: "absent" }));
    const usedScopes: FileReferenceScope<Workspace>[] = [];
    for (const scope of scopes) {
      const selected: { index: number; target: FileResolveTarget }[] = [];
      targets.forEach((target, index) => {
        if ("target" in target) {
          if (target.workspaceId === scope.sourceWorkspaceId && results[index]?.status !== "found" &&
              (!localScope || target.workspaceId !== workspace.workspaceId || scope === localScope)) selected.push({ index, target: { objectId: target.target.objectId } });
        } else {
          const prefix = scope.prefix;
          if (prefix !== undefined) {
            if (target.path.startsWith(prefix + "/")) selected.push({ index, target: { path: target.path.slice(prefix.length + 1) } });
          } else if (!scopes.some(other => other.prefix !== undefined && (target.path === other.prefix || target.path.startsWith(other.prefix + "/")))) {
            selected.push({ index, target });
          }
        }
      });
      if (!selected.length) continue;
      scope.assertCurrent();
      usedScopes.push(scope);
      const files = await withEngineAdapter(scope.workspace, (adapter, assertEngineCurrent) =>
        resolveEngineFileTargets(adapter, scope.workspace.workspaceId, selected.map(row => row.target), {
          ...scope,
          assertCurrent: () => { scope.assertCurrent(); assertEngineCurrent?.(); },
        }));
      scope.assertCurrent();
      if (files === null) throw new Error("Workspace engine is unavailable.");
      files.forEach((file, index) => {
        if (file.status !== "found" || results[selected[index]!.index]?.status === "found") return;
        const path = scope.prefix === undefined ? file.path : scope.prefix + "/" + file.path;
        results[selected[index]!.index] = { ...file, path, ref: scope.sourceWorkspaceId ? workspaceFileRef(scope.sourceWorkspaceId, file.objectId, file.path) : null };
      });
      files.forEach((file, index) => {
        if (file.status === "invalid") results[selected[index]!.index] = file;
      });
    }
    for (const scope of usedScopes) scope.assertCurrent();
    return results;
  };
}
