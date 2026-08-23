import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import {
  assertRealMountRoot,
  mountRootFor,
  mountStoreWorkspaceIdFor,
} from "../workspaces/shareMounts";
import type { ShareMountRecord } from "../workspaces/registryStore";
import {
  createShareViewFiles,
  type ResolvedShareViewFilesTarget,
} from "../workspaces/shareViewFiles";
import {
  refreshSharedViewOnce,
  type RefreshSharedViewOutcome,
} from "../workspaces/sharedView";
import {
  withStaleSensitiveWorkspaceOperation,
} from "../workspaces/workspaceAssets";
import type { CaptureVersionedTextStore } from "../workspaces/workspaceEngineCaptureLiveStore";

/**
 * Thin mount adapter for tests that need the real ShareViewFiles owner.
 * Production behavior stays in that owner; this supplies only registry,
 * relay, and store ports that focused tests do not have a main process for.
 */
export async function refreshShareMountThroughOwnerForTest(input: {
  hostWorkspaceId: string;
  hostRoot: string;
  mount: Pick<ShareMountRecord, "shareId" | "label">;
  relay: SyncRelayConnection;
  pull: Parameters<typeof refreshSharedViewOnce>[0]["pull"];
  pinnedSelector: unknown;
  recordRefusals: Parameters<typeof refreshSharedViewOnce>[0]["recordRefusals"];
  openStore: (workspace: {
    workspaceId: string;
    rootPath: string;
    shareMount: true;
  }) => CaptureVersionedTextStore;
}): Promise<RefreshSharedViewOutcome> {
  const target: ResolvedShareViewFilesTarget = {
    kind: "mount",
    workspaceId: input.hostWorkspaceId,
    storeWorkspaceId: mountStoreWorkspaceIdFor(
      input.hostWorkspaceId,
      input.mount.shareId,
    ),
    schedulingRootPath: input.hostRoot,
    rootPath: mountRootFor(input.hostRoot, input.mount.label),
    shareId: input.mount.shareId,
    granterEmail: null,
    grantedSelector: input.pinnedSelector,
    ended: false,
    mountLabel: input.mount.label,
  };
  const requested = {
    kind: "mount" as const,
    workspaceId: input.hostWorkspaceId,
    shareId: input.mount.shareId,
  };
  const files = createShareViewFiles({
    resolveTarget: (candidate) =>
      candidate.kind === "mount" &&
      candidate.workspaceId === requested.workspaceId &&
      candidate.shareId === requested.shareId
        ? target
        : null,
    openStore: (current) =>
      input.openStore({
        workspaceId: current.storeWorkspaceId,
        rootPath: current.rootPath,
        shareMount: true,
      }),
    resolveRelay: async () => input.relay,
    pull: async (current, relay, pullInput) =>
      input.pull({
        rootDir: current.rootPath,
        workspaceId: current.storeWorkspaceId,
        relay,
        shareId: current.shareId,
        ...pullInput,
      }),
    recordRefusals: async (_current, refusals) =>
      input.recordRefusals([...refusals]),
    markEnded: async () => undefined,
    retireTarget: async () => undefined,
    assertProjectionRoot: async (current) => {
      if (!current.mountLabel) throw new Error("Share mount record has no label.");
      await assertRealMountRoot(current.schedulingRootPath, current.mountLabel);
    },
    removeMount: async () => {
      throw new Error("The refresh harness does not remove mounts.");
    },
  });
  const result = await withStaleSensitiveWorkspaceOperation(
    input.hostRoot,
    (lease) => files.reconcile(lease, requested, "refresh"),
  );
  if (result.kind !== "refresh" || "ok" in result.outcome) {
    throw new Error("Mount reconciliation returned a standalone outcome.");
  }
  return result.outcome;
}
