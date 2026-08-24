import { join } from "node:path";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { ShareMountStatusRow } from "../ipc/bridgeContract";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import type { ShareMountRecord } from "./registryStore";
import {
  allocateShareMountLabel,
  assertMountableSelector,
  classifyShareMountRefreshError,
  mountRootFor,
  mountStoreWorkspaceIdFor,
  planShareMountRemoval,
  shareMountRecordsForId,
  shareMountResultRow,
  usableShareMountRecord,
} from "./shareMounts";
import type { ShareViewInfo } from "./shareViewInfo";
import {
  assertActiveShareViewFilesOwner,
  ShareViewMountRollbackError,
  type PreparedShareViewFilesMount,
  type ShareViewFiles,
  type ShareViewFilesDependencies,
} from "./shareViewFiles";
import type { WorkspaceOperationLease } from "./workspaceAssets";
import { parseShareCode, relayUrlsMatch } from "./syncCode";

export interface ShareMountCommandWorkspace {
  workspaceId: string;
  rootPath: string;
}

export interface ShareMountCommandCredentials {
  relayUrl?: string | null;
  token: string;
  email?: string | null;
}

type ShareMountFilesLifecycle = Pick<
  ShareViewFilesDependencies,
  "createMount" | "removeMount"
>;

export interface ShareMountCommandDependencies<WorkspaceSummary> {
  readMounts(workspaceId: string): readonly ShareMountRecord[];
  writeMounts(workspaceId: string, mounts: ShareMountRecord[]): void;
  loadCredentials(): Promise<ShareMountCommandCredentials | null>;
  fetchInfo(
    relay: SyncRelayConnection,
    shareId: string,
  ): Promise<Pick<ShareViewInfo, "granterEmail" | "selector">>;
  listDirectory(absolutePath: string): Promise<string[]>;
  withWorkspaceOperation<T>(
    workspaceRoot: string,
    run: (lease: WorkspaceOperationLease) => Promise<T>,
  ): Promise<T>;
  files(): ShareViewFiles;
  projectionFor: ShareMountFilesLifecycleProjectionFactory;
  closeRelayWorkspace(workspaceId: string): Promise<void>;
  workspaceSummary(workspaceId: string): WorkspaceSummary;
  refreshNativeWorkspaceSurfaces(): void;
  notifyRenderer(): void;
  logError(message: string, error: unknown): void;
}

type ShareMountFilesLifecycleProjectionFactory = (
  owner: Parameters<ShareMountFilesLifecycle["createMount"]>[0],
) => {
  create(): Promise<void>;
  remove(): Promise<{ folderLeft: boolean; error?: unknown }>;
};

export interface ShareMountCommands<WorkspaceSummary> {
  mount(input: {
    workspace: ShareMountCommandWorkspace;
    shareCode: string;
  }): Promise<{
    workspace: WorkspaceSummary;
    mount: ShareMountStatusRow;
  }>;
  refresh(input: {
    workspace: ShareMountCommandWorkspace;
  }): Promise<{ results: ShareMountStatusRow[] }>;
  unmount(input: {
    workspace: ShareMountCommandWorkspace;
    shareId: string;
  }): Promise<{ workspace: WorkspaceSummary; folderLeft?: true }>;
  filesLifecycle: ShareMountFilesLifecycle;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ShareMountLifecycleTarget =
  | Parameters<ShareMountFilesLifecycle["createMount"]>[1]
  | Parameters<ShareMountFilesLifecycle["removeMount"]>[1];

function assertShareMountLifecycleOwner(
  owner: Parameters<ShareMountFilesLifecycle["createMount"]>[0],
  target: ShareMountLifecycleTarget,
  invalidTargetMessage: string,
): void {
  if (target.kind !== "mount" || !target.mountLabel) {
    throw new Error(invalidTargetMessage);
  }
  assertActiveShareViewFilesOwner(owner, {
    kind: target.kind,
    workspaceId: target.workspaceId,
    storeWorkspaceId: target.storeWorkspaceId,
    shareId: target.shareId,
    mountLabel: target.mountLabel,
    schedulingRootPath: target.schedulingRootPath,
    rootPath: target.rootPath,
  });
}

export function createShareMountCommands<WorkspaceSummary>(
  dependencies: ShareMountCommandDependencies<WorkspaceSummary>,
): ShareMountCommands<WorkspaceSummary> {
  // Mount, refresh, and unmount replace the whole registry mount set. Keep
  // relay preflight in the same admission so no command can act on a stale
  // snapshot or recreate a projection after unmount removes it.
  const locks = new Map<string, Promise<void>>();

  function withCommandAdmission<T>(
    workspaceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(workspaceId, tail);
    void tail.then(() => {
      if (locks.get(workspaceId) === tail) locks.delete(workspaceId);
    });
    return result;
  }

  // ShareViewFiles supplies the active owner capability. This module owns the
  // registry half of that transaction and records both failures when rollback
  // cannot remove the projection it just created.
  const filesLifecycle: ShareMountFilesLifecycle = {
    async createMount(owner, target) {
      assertShareMountLifecycleOwner(
        owner,
        target,
        "Only a prepared share mount can be created.",
      );
      if (!target.relayUrl) {
        throw new Error("Only a prepared share mount can be created.");
      }
      const projection = dependencies.projectionFor(owner);
      await projection.create();
      try {
        dependencies.writeMounts(target.workspaceId, [
          ...dependencies.readMounts(target.workspaceId),
          {
            shareId: target.shareId,
            label: target.mountLabel,
            granterEmail: target.granterEmail,
            relayUrl: target.relayUrl,
            recipientEmail: target.recipientEmail ?? null,
            grantedSelector: target.grantedSelector,
          },
        ]);
      } catch (error) {
        let rollback: Awaited<ReturnType<typeof projection.remove>>;
        try {
          rollback = await projection.remove();
        } catch (rollbackError) {
          throw new ShareViewMountRollbackError(error, rollbackError);
        }
        if (rollback.error || rollback.folderLeft) {
          throw new ShareViewMountRollbackError(error, rollback.error);
        }
        throw error;
      }
    },

    async removeMount(owner, target) {
      assertShareMountLifecycleOwner(
        owner,
        target,
        "Only a registered share mount can be removed.",
      );
      await dependencies.closeRelayWorkspace(target.storeWorkspaceId).catch(
        (error) => {
          dependencies.logError(
            `could not close share mount relay ${target.storeWorkspaceId}:`,
            error,
          );
        },
      );
      const removed = await dependencies.projectionFor(owner).remove();
      if (removed.error) {
        dependencies.logError(
          `could not remove share mount folder ${target.mountLabel}:`,
          removed.error,
        );
      }
      const mounts = dependencies.readMounts(target.workspaceId);
      const matches = new Set(
        shareMountRecordsForId(mounts, target.shareId),
      );
      dependencies.writeMounts(
        target.workspaceId,
        mounts.filter((mount) => !matches.has(mount)),
      );
      return { folderLeft: removed.folderLeft };
    },
  };

  return {
    filesLifecycle,

    mount({ workspace, shareCode }) {
      return withCommandAdmission(workspace.workspaceId, async () => {
        const parsed = parseShareCode(shareCode);
        if (!parsed) {
          throw new Error(
            "That doesn't look like a share code. Copy it again and retry.",
          );
        }
        const credentials = await dependencies.loadCredentials();
        if (!credentials) throw new Error("Sign in to dohc Cloud first.");
        const relayUrl = credentials.relayUrl;
        if (!relayUrl || !relayUrlsMatch(relayUrl, parsed.relayUrl)) {
          // Never send this machine's session token to the pasted relay URL.
          throw new Error(
            "This share lives on a different server than the one you're signed in to. " +
              `Reconnect dohc Cloud with the sync relay URL ${parsed.relayUrl}, then try again.`,
          );
        }
        const existing = dependencies.readMounts(workspace.workspaceId);
        if (shareMountRecordsForId(existing, parsed.shareId).length > 0) {
          throw new Error("This share is already added to this workspace.");
        }
        const relay = { baseUrl: relayUrl, token: credentials.token };
        let info: Pick<ShareViewInfo, "granterEmail" | "selector">;
        try {
          info = await dependencies.fetchInfo(relay, parsed.shareId);
        } catch (error) {
          if (error instanceof ShareUnavailableError) {
            throw new Error(
              "No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
            );
          }
          if (error instanceof RelayUnauthorizedError) {
            throw new Error(
              "Your dohc Cloud session expired. Sign in again, then retry.",
            );
          }
          throw error;
        }
        const grantedSelector = info.selector;
        assertMountableSelector(grantedSelector);

        // Relay preflight stays under command admission. Local mount state
        // begins only after the process-wide workspace lease is active.
        return dependencies.withWorkspaceOperation(
          workspace.rootPath,
          async (lease) => {
            const onDisk = await dependencies.listDirectory(
              join(workspace.rootPath, SHARED_WITH_ME_FOLDER),
            );
            const mount = {
              shareId: parsed.shareId,
              label: allocateShareMountLabel({
                storedMounts: existing,
                onDiskNames: onDisk,
                granterEmail: info.granterEmail,
              }),
              granterEmail: info.granterEmail,
              relayUrl,
              recipientEmail: credentials.email ?? null,
              grantedSelector,
            };
            const prepared: PreparedShareViewFilesMount = {
              kind: "mount",
              workspaceId: workspace.workspaceId,
              storeWorkspaceId: mountStoreWorkspaceIdFor(
                workspace.workspaceId,
                mount.shareId,
              ),
              schedulingRootPath: workspace.rootPath,
              rootPath: mountRootFor(workspace.rootPath, mount.label),
              shareId: mount.shareId,
              mountLabel: mount.label,
              granterEmail: mount.granterEmail,
              relayUrl: mount.relayUrl,
              recipientEmail: mount.recipientEmail,
              grantedSelector: mount.grantedSelector,
              ended: false,
            };
            try {
              const outcome = await dependencies.files().mount(lease, prepared);
              dependencies.refreshNativeWorkspaceSurfaces();
              dependencies.notifyRenderer();
              return {
                workspace: dependencies.workspaceSummary(workspace.workspaceId),
                mount: {
                  shareId: mount.shareId,
                  label: mount.label,
                  status: outcome.status,
                  changedPaths: outcome.changedPaths,
                },
              };
            } catch (error) {
              dependencies.logError(
                `mount-share rollback for ${mount.label}:`,
                error,
              );
              dependencies.notifyRenderer();
              if (error instanceof ShareUnavailableError) {
                throw new Error(
                  "This share was ended before it could be added. Nothing was added to this workspace.",
                );
              }
              if (error instanceof ShareViewMountRollbackError) {
                throw new Error(
                  "dohc could not add this share, and cleanup did not finish. " +
                    "If the share still appears, remove it from this workspace. " +
                    "Also remove any leftover folder from shared-with-me. Then try again.",
                );
              }
              throw new Error(
                "Couldn't add the share. Nothing was added to this workspace — check your connection and try again.",
              );
            }
          },
        );
      });
    },

    refresh({ workspace }) {
      return withCommandAdmission(workspace.workspaceId, async () => {
        const mounts = dependencies.readMounts(workspace.workspaceId);
        const results: ShareMountStatusRow[] = [];
        const pushResult = (
          mount: unknown,
          status: ShareMountStatusRow["status"],
          changedPaths: number,
        ): void => {
          if (!record(mount)) return;
          const row = shareMountResultRow({
            shareId: mount.shareId,
            label: mount.label,
            status,
            changedPaths,
          });
          if (row) results.push(row);
        };
        try {
          for (const mount of mounts) {
            if (!usableShareMountRecord(mounts, mount)) {
              pushResult(mount, "damaged", 0);
              continue;
            }
            try {
              // A slow relay holds only this mount's workspace transaction,
              // never one lease across the complete refresh pass.
              const reconciled = await dependencies.withWorkspaceOperation(
                workspace.rootPath,
                (lease) =>
                  dependencies.files().reconcile(
                    lease,
                    {
                      kind: "mount",
                      workspaceId: workspace.workspaceId,
                      shareId: mount.shareId,
                    },
                    "refresh",
                  ),
              );
              if (
                reconciled.kind !== "refresh" ||
                "ok" in reconciled.outcome
              ) {
                throw new Error(
                  "Share mount refresh returned an invalid result.",
                );
              }
              pushResult(
                mount,
                reconciled.outcome.status,
                reconciled.outcome.changedPaths,
              );
            } catch (error) {
              const verdict = classifyShareMountRefreshError(error);
              if (verdict.kind === "abort") {
                throw new Error(verdict.message);
              }
              dependencies.logError(
                `share-mount refresh failed for ${mount.label}:`,
                error,
              );
              pushResult(mount, verdict.status, 0);
            }
          }
          return { results };
        } finally {
          dependencies.notifyRenderer();
        }
      });
    },

    unmount({ workspace, shareId }) {
      return withCommandAdmission(workspace.workspaceId, () =>
        dependencies.withWorkspaceOperation(
          workspace.rootPath,
          async (lease) => {
            const registeredMounts = dependencies.readMounts(
              workspace.workspaceId,
            );
            const removal = planShareMountRemoval(
              registeredMounts,
              shareId,
            );
            if (removal.kind === "missing") {
              throw new Error("This share is not added to this workspace.");
            }
            if (removal.kind === "registry-only") {
              await dependencies
                .closeRelayWorkspace(
                  mountStoreWorkspaceIdFor(workspace.workspaceId, shareId),
                )
                .catch((error) => {
                  dependencies.logError(
                    `could not close removed share relay ${shareId}:`,
                    error,
                  );
                });
              // The empty array is a durable ownership tombstone. Removing
              // the registry field could promote leftover projection bytes.
              dependencies.writeMounts(
                workspace.workspaceId,
                removal.remaining,
              );
              dependencies.refreshNativeWorkspaceSurfaces();
              dependencies.notifyRenderer();
              return {
                workspace: dependencies.workspaceSummary(workspace.workspaceId),
                folderLeft: true as const,
              };
            }
            const removed = await dependencies.files().unmount(lease, {
              kind: "mount",
              workspaceId: workspace.workspaceId,
              shareId: removal.mount.shareId,
            });
            dependencies.refreshNativeWorkspaceSurfaces();
            dependencies.notifyRenderer();
            return {
              workspace: dependencies.workspaceSummary(workspace.workspaceId),
              ...(removed.folderLeft ? { folderLeft: true as const } : {}),
            };
          },
        ),
      );
    },
  };
}
