import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import {
  assertRealMountRoot,
  mountRootFor,
  mountStoreWorkspaceIdFor,
  shareViewFilesMountProjection,
} from "../workspaces/shareMounts";
import type { ShareMountRecord } from "../workspaces/registryStore";
import {
  createShareViewFiles,
  shareViewFilesStore,
  type PreparedShareViewFilesMount,
  type ResolvedShareViewFilesTarget,
} from "../workspaces/shareViewFiles";
import {
  createShareViewLifecycle,
  type RefreshSharedViewOutcome,
} from "../workspaces/sharedView";
import {
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
} from "../workspaces/workspaceAssets";
import type { CaptureVersionedTextStore } from "../workspaces/workspaceEngineCaptureLiveStore";

export async function refreshStandaloneShareThroughOwnerForTest(input: {
  rootDir: string;
  workspaceId: string;
  relay: SyncRelayConnection;
  shareId: string;
  store: CaptureVersionedTextStore;
  pinnedSelector: unknown;
  pull: Parameters<
    ReturnType<typeof createShareViewLifecycle>["refreshOnce"]
  >[0]["pull"];
  recordRefusals: Parameters<
    ReturnType<typeof createShareViewLifecycle>["refreshOnce"]
  >[0]["recordRefusals"];
}): Promise<RefreshSharedViewOutcome> {
  const target: ResolvedShareViewFilesTarget = {
    kind: "standalone",
    workspaceId: input.workspaceId,
    storeWorkspaceId: input.workspaceId,
    schedulingRootPath: input.rootDir,
    rootPath: input.rootDir,
    shareId: input.shareId,
    granterEmail: null,
    grantedSelector: input.pinnedSelector,
    ended: false,
  };
  const requested = {
    kind: "standalone" as const,
    workspaceId: input.workspaceId,
  };
  const files = createShareViewFiles({
    resolveTarget: (candidate) =>
      candidate.kind === "standalone" &&
      candidate.workspaceId === requested.workspaceId
        ? target
        : null,
    openStore: () => shareViewFilesStore(input.store),
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
    assertProjectionRoot: async () => undefined,
    createMount: async () => undefined,
    removeMount: async () => {
      throw new Error("A standalone share cannot be unmounted.");
    },
  });
  const result = await withStaleSensitiveWorkspaceOperation(
    input.rootDir,
    (lease) => files.reconcile(lease, requested, "refresh"),
  );
  if (result.kind !== "refresh" || !("ok" in result.outcome)) {
    throw new Error("Standalone reconciliation returned a mount outcome.");
  }
  if (!result.outcome.ok) throw new Error(result.outcome.errorMessage);
  const { ok: _ok, ...outcome } = result.outcome;
  return outcome;
}

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
  pull: Parameters<
    ReturnType<typeof createShareViewLifecycle>["refreshOnce"]
  >[0]["pull"];
  pinnedSelector: unknown;
  recordRefusals: Parameters<
    ReturnType<typeof createShareViewLifecycle>["refreshOnce"]
  >[0]["recordRefusals"];
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
      shareViewFilesStore(
        input.openStore({
          workspaceId: current.storeWorkspaceId,
          rootPath: current.rootPath,
          shareMount: true,
        }),
      ),
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
      if (!current.mountLabel)
        throw new Error("Share mount record has no label.");
      await assertRealMountRoot(current.schedulingRootPath, current.mountLabel);
    },
    createMount: async () => undefined,
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

function emptyMountStore(): CaptureVersionedTextStore {
  return {
    ensureMainVersion: async () => ({ id: "main" }),
    listTextFiles: async () => [],
    listTextFileMetadata: async () => [],
    readTextFile: async () => null,
    readBinaryFile: async () => null,
    getMoment: async () => ({ payload: { before: null } }),
  } as unknown as CaptureVersionedTextStore;
}

function preparedMount(hostRoot: string, label: string): PreparedShareViewFilesMount {
  const shareId = `test-${label}`;
  return {
    kind: "mount",
    workspaceId: "test-host",
    storeWorkspaceId: mountStoreWorkspaceIdFor("test-host", shareId),
    schedulingRootPath: hostRoot,
    rootPath: mountRootFor(hostRoot, label),
    shareId,
    mountLabel: label,
    granterEmail: null,
    grantedSelector: { paths: [], versionId: "main", access: "view" },
    ended: false,
    relayUrl: "https://relay.invalid",
    recipientEmail: null,
  };
}

function mountMutationOwner(input: {
  target: PreparedShareViewFilesMount;
  initiallyRegistered: boolean;
}) {
  let registered = input.initiallyRegistered;
  const requested = {
    kind: "mount" as const,
    workspaceId: input.target.workspaceId,
    shareId: input.target.shareId,
  };
  const files = createShareViewFiles({
    resolveTarget: (candidate) =>
      registered &&
      candidate.kind === "mount" &&
      candidate.workspaceId === requested.workspaceId &&
      candidate.shareId === requested.shareId
        ? input.target
        : null,
    openStore: () => shareViewFilesStore(emptyMountStore()),
    resolveRelay: async () => null,
    pull: async () => {
      throw new Error("Unexpected pull");
    },
    recordRefusals: async () => undefined,
    markEnded: async () => undefined,
    retireTarget: async () => undefined,
    assertProjectionRoot: async (current) => {
      await assertRealMountRoot(
        current.schedulingRootPath,
        current.mountLabel ?? "",
      );
    },
    createMount: async (owner) => {
      await shareViewFilesMountProjection(owner).create();
      registered = true;
    },
    removeMount: async (owner) => {
      const removed = await shareViewFilesMountProjection(owner).remove();
      registered = false;
      return removed;
    },
  });
  return { files, requested };
}

export async function createShareMountDirectoryThroughOwnerForTest(
  hostRoot: string,
  label: string,
): Promise<void> {
  const target = preparedMount(hostRoot, label);
  const { files } = mountMutationOwner({
    target,
    initiallyRegistered: false,
  });
  await withExclusiveWorkspaceOperation(hostRoot, (_changed, lease) =>
    files.mount(lease, target),
  );
}

export async function removeShareMountFolderThroughOwnerForTest(
  hostRoot: string,
  label: string,
): Promise<{ folderLeft: boolean; error?: unknown }> {
  const target = preparedMount(hostRoot, label);
  const { files, requested } = mountMutationOwner({
    target,
    initiallyRegistered: true,
  });
  return withExclusiveWorkspaceOperation(hostRoot, (_changed, lease) =>
    files.unmount(lease, requested),
  );
}
