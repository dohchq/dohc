import type { ShareMountRecord } from "./registryStore";
import {
  mountRootFor,
  mountStoreWorkspaceIdFor,
  shareMountRecordsForId,
  usableShareMountRecord,
} from "./shareMounts";
import type {
  ResolvedShareViewFilesTarget,
  ShareViewFilesTarget,
} from "./shareViewFiles";
import { shareViewIsPresent } from "./shareViewMarker";

export interface ShareViewFilesWorkspaceRecord {
  workspaceId: string;
  rootPath: string;
  shareView?: unknown;
  shareMounts?: unknown;
}

export function storedShareMounts(
  workspace: Pick<ShareViewFilesWorkspaceRecord, "shareMounts">,
): readonly ShareMountRecord[] {
  if (workspace.shareMounts === undefined) return [];
  if (!Array.isArray(workspace.shareMounts)) {
    throw new Error(
      "dohc cannot verify mounted shares because their saved registry is invalid.",
    );
  }
  return workspace.shareMounts as ShareMountRecord[];
}

export function workspaceHasReceivedShareState(
  workspace: Pick<
    ShareViewFilesWorkspaceRecord,
    "shareView" | "shareMounts"
  >,
): boolean {
  return (
    shareViewIsPresent(workspace.shareView) ||
    workspace.shareMounts !== undefined
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function resolveRegisteredShareViewFilesTarget(
  workspace: ShareViewFilesWorkspaceRecord | null | undefined,
  target: ShareViewFilesTarget,
): ResolvedShareViewFilesTarget | null {
  if (!workspace || workspace.workspaceId !== target.workspaceId) return null;
  if (target.kind === "standalone") {
    if (!shareViewIsPresent(workspace.shareView)) return null;
    const shareView = record(workspace.shareView);
    return {
      kind: "standalone",
      workspaceId: workspace.workspaceId,
      storeWorkspaceId: workspace.workspaceId,
      schedulingRootPath: workspace.rootPath,
      rootPath: workspace.rootPath,
      shareId:
        typeof shareView.shareId === "string" && shareView.shareId.length > 0
          ? shareView.shareId
          : null,
      granterEmail:
        typeof shareView.granterEmail === "string"
          ? shareView.granterEmail
          : null,
      grantedSelector: shareView.grantedSelector,
      ended: shareView.ended === true,
      relayUrl:
        typeof shareView.relayUrl === "string" ? shareView.relayUrl : null,
    };
  }

  const mounts = storedShareMounts(workspace);
  const matches = shareMountRecordsForId(mounts, target.shareId);
  if (matches.length !== 1) return null;
  const mount = matches[0]!;
  if (!usableShareMountRecord(mounts, mount)) {
    return null;
  }
  return {
    kind: "mount",
    workspaceId: workspace.workspaceId,
    storeWorkspaceId: mountStoreWorkspaceIdFor(
      workspace.workspaceId,
      mount.shareId,
    ),
    schedulingRootPath: workspace.rootPath,
    rootPath: mountRootFor(workspace.rootPath, mount.label),
    shareId: mount.shareId,
    granterEmail: mount.granterEmail,
    grantedSelector: mount.grantedSelector,
    ended: mount.ended === true,
    relayUrl: mount.relayUrl,
    recipientEmail: mount.recipientEmail ?? null,
    mountLabel: mount.label,
  };
}
