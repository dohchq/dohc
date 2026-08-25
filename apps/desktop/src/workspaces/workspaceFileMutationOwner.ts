import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";

import {
  CreateWorkspaceFilePayload,
  CreateWorkspaceFileResult,
  CreateWorkspaceFolderPayload,
  DeleteWorkspacePathPayload,
  DeleteWorkspacePathResult,
  MoveWorkspacePathPayload,
  WriteWorkspaceAssetPayload,
  WriteWorkspaceTextPayload,
  WriteWorkspaceTextResult,
} from "../ipc/bridgeContract";
import { refuseMoveAcrossShareMount } from "./shareMounts";
import {
  type ShareViewFileChangeOutcome,
  type ShareViewFileChangeValue,
  type ShareViewFiles,
} from "./shareViewFiles";
import {
  shareMountRegistryIsPresent,
  storedShareMounts,
} from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import {
  SHARE_VIEW_EMPTY_FOLDER_REFUSAL,
  workspaceWriteRefusal,
} from "./shareWriteGate";
import {
  normalizeWorkspaceImageAssetPath,
  resolveWorkspaceFile,
  resolveWorkspaceMaterializePath,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
  writeWorkspaceAssetInLease,
  writeWorkspaceTextInLease,
} from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  createFile,
  createFolder,
  deletePath,
  movePath,
  normalizeWorkspaceMovePaths,
  prepareWorkspaceDelete,
  prepareWorkspaceMove,
} from "./workspaceFiles";

type WorkspaceFileMutationIpcHandler<Event, Result = void> = (
  event: Event,
  payload: unknown,
) => Promise<Result>;

export interface WorkspaceFileMutationOwner<Event> {
  createFile: WorkspaceFileMutationIpcHandler<
    Event,
    CreateWorkspaceFileResult
  >;
  createFolder: WorkspaceFileMutationIpcHandler<
    Event,
    CreateWorkspaceFileResult
  >;
  movePath: WorkspaceFileMutationIpcHandler<Event, CreateWorkspaceFileResult>;
  deletePath: WorkspaceFileMutationIpcHandler<
    Event,
    DeleteWorkspacePathResult
  >;
  writeText: WorkspaceFileMutationIpcHandler<Event, WriteWorkspaceTextResult>;
  writeAsset: WorkspaceFileMutationIpcHandler<Event>;
}

export interface WorkspaceFileMutationWorkspace {
  workspaceId: string;
  rootPath: string;
  shareView?: unknown;
  shareMounts?: unknown;
}

export interface WorkspaceFileMutationYDocPort {
  withDocumentUnowned<T>(
    workspaceId: string,
    path: string,
    mutation: () => Promise<T>,
  ): Promise<T>;
  markDeletedUnderPath(
    workspaceId: string,
    pathOrPrefix: string,
  ): void;
}

type MutationCapture = Pick<
  WorkspaceEngineCapture,
  "beginFileRename" | "settleAndCloseLiveSessionsForPath"
>;

function assertWritableWorkspace(
  workspace: WorkspaceFileMutationWorkspace,
): void {
  const refusal = workspaceWriteRefusal(workspace.shareView);
  if (refusal) throw new Error(refusal);
}

/**
 * Owns renderer-requested workspace file changes from IPC admission through
 * result validation. Callers choose a method; the owner chooses the storage
 * route, scheduler, engine coordination, and recovery path.
 */
export function createWorkspaceFileMutationOwner<
  IpcEvent,
  Workspace extends WorkspaceFileMutationWorkspace,
>(dependencies: {
  assertTrustedSender(event: IpcEvent): void;
  requireWorkspace(workspaceId: string): Workspace;
  engineCaptureFor(workspaceId: string): MutationCapture | null;
  yDocSessions: WorkspaceFileMutationYDocPort;
  shareViewFiles: Pick<ShareViewFiles, "change">;
  trashItem(path: string): Promise<void>;
  notifyRenderer(workspaceId: string): void;
  logError(message: string, error: unknown): void;
}): WorkspaceFileMutationOwner<IpcEvent> {
  const shareTarget = (workspace: Workspace) => ({
    kind: "standalone" as const,
    workspaceId: workspace.workspaceId,
  });

  const committedShareViewChangeValue = (
    workspaceId: string,
    outcome: ShareViewFileChangeOutcome,
  ): ShareViewFileChangeValue => {
    if (outcome.status === "committed") {
      if (outcome.projection === "pending") {
        dependencies.notifyRenderer(workspaceId);
      }
      return outcome.value;
    }
    dependencies.notifyRenderer(workspaceId);
    dependencies.logError(
      "[desktop] shared file change did not finish cleanly",
      outcome,
    );
    if (outcome.status === "partial") {
      throw new Error(
        "Part of the shared file change completed before the operation stopped. Refresh the shared view before you continue.",
      );
    }
    throw new Error(
      "dohc could not confirm whether the shared file changed. Refresh the shared view before you continue.",
    );
  };

  const structuralShareViewChangeValue = (
    workspaceId: string,
    outcome: ShareViewFileChangeOutcome,
    markWorkspaceChanged: () => void,
  ): ShareViewFileChangeValue => {
    // ShareViewFiles throws when it proves that a refusal had no canonical
    // effect. Every returned structural outcome either changed state or cannot
    // rule that out, so record it before outcome or value validation can throw.
    markWorkspaceChanged();
    return committedShareViewChangeValue(workspaceId, outcome);
  };

  const requireMutation = <Payload extends { workspaceId: string }>(
    event: IpcEvent,
    payload: unknown,
    parse: (value: unknown) => Payload,
  ): { input: Payload; workspace: Workspace; receivedShare: boolean } => {
    dependencies.assertTrustedSender(event);
    const input = parse(payload);
    const workspace = dependencies.requireWorkspace(input.workspaceId);
    return {
      input,
      workspace,
      receivedShare: shareViewIsPresent(workspace.shareView),
    };
  };

  return {
    createFile: async (event, payload) => {
      const { input, workspace, receivedShare } = requireMutation(
        event,
        payload,
        CreateWorkspaceFilePayload.parse,
      );
      if (!receivedShare) assertWritableWorkspace(workspace);
      return withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async (lease) => {
          const path = receivedShare
            ? committedShareViewChangeValue(
                workspace.workspaceId,
                await dependencies.shareViewFiles.change(
                  lease,
                  shareTarget(workspace),
                  {
                    kind: "create",
                    path: input.relativePath,
                    initialText: input.initialText,
                  },
                ),
              )
            : await createFile(
                workspace.rootPath,
                input.relativePath,
                input.initialText,
              );
          if (typeof path !== "string") {
            throw new Error("Shared file create returned an invalid result.");
          }
          return CreateWorkspaceFileResult.parse({ path });
        },
      );
    },

    createFolder: async (event, payload) => {
      const { input, workspace, receivedShare } = requireMutation(
        event,
        payload,
        CreateWorkspaceFolderPayload.parse,
      );
      if (receivedShare) throw new Error(SHARE_VIEW_EMPTY_FOLDER_REFUSAL);
      assertWritableWorkspace(workspace);
      return withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async () =>
          CreateWorkspaceFileResult.parse({
            path: await createFolder(workspace.rootPath, input.relativePath),
          }),
      );
    },

    movePath: async (event, payload) => {
      const { input, workspace, receivedShare } = requireMutation(
        event,
        payload,
        MoveWorkspacePathPayload.parse,
      );
      if (!receivedShare) assertWritableWorkspace(workspace);
      return withExclusiveWorkspaceOperation(
        workspace.rootPath,
        async (markWorkspaceChanged, lease) => {
          if (!receivedShare) {
            await refuseMoveAcrossShareMount(
              workspace.rootPath,
              input.fromPath,
              input.toPath,
              storedShareMounts(workspace),
              shareMountRegistryIsPresent(workspace),
            );
          }
          const requestedPaths = normalizeWorkspaceMovePaths(
            input.fromPath,
            input.toPath,
          );
          const preparedMove = receivedShare
            ? null
            : await prepareWorkspaceMove(
                workspace.rootPath,
                input.fromPath,
                input.toPath,
              );
          const fromPath =
            preparedMove?.physicalFromPath ?? requestedPaths.fromPath;
          const toPath = preparedMove?.physicalToPath ?? requestedPaths.toPath;
          const visibleResultPath =
            preparedMove?.visibleResultPath ?? requestedPaths.toPath;

          const capture = dependencies.engineCaptureFor(workspace.workspaceId);
          const fromKind = liveDocumentKindForPath(fromPath);
          const toKind = liveDocumentKindForPath(toPath);
          if (
            (capture !== null || receivedShare) &&
            fromKind !== null &&
            fromKind !== toKind
          ) {
            // Starting the engine rename before this refusal can strand its
            // stable object at a path whose live-document kind cannot open it.
            throw new Error(
              `A rename cannot change a live document's kind from ${fromKind} to ${toKind ?? "a plain file"}. Create a new file and copy the content instead.`,
            );
          }

          const finishRename = capture
            ? await capture.beginFileRename(fromPath, toPath)
            : null;
          try {
            let path: ShareViewFileChangeValue;
            if (receivedShare) {
              const outcome = await dependencies.shareViewFiles.change(
                lease,
                shareTarget(workspace),
                {
                  kind: "move",
                  fromPath,
                  toPath,
                },
              );
              path = structuralShareViewChangeValue(
                workspace.workspaceId,
                outcome,
                markWorkspaceChanged,
              );
            } else {
              await movePath(
                workspace.rootPath,
                fromPath,
                toPath,
              );
              path = visibleResultPath;
            }
            if (typeof path !== "string") {
              throw new Error("Shared file move returned an invalid result.");
            }
            // The path move has landed. Bump the generation before the engine
            // finisher so its failure cannot release queued stale writes.
            if (!receivedShare) markWorkspaceChanged();
            await finishRename?.(true);
            return CreateWorkspaceFileResult.parse({ path });
          } catch (error) {
            await finishRename?.(false);
            throw error;
          }
        },
      );
    },

    deletePath: async (event, payload) => {
      const { input, workspace, receivedShare } = requireMutation(
        event,
        payload,
        DeleteWorkspacePathPayload.parse,
      );
      if (!receivedShare) assertWritableWorkspace(workspace);
      return withExclusiveWorkspaceOperation(
        workspace.rootPath,
        async (markWorkspaceChanged, lease) => {
          const localPath = receivedShare
            ? null
            : await prepareWorkspaceDelete(
                workspace.rootPath,
                input.relativePath,
              );
          // The Y.Doc is canonical while its session is live. Settle and
          // release it before moving the artifact out from under the engine.
          const finishDebts = localPath === null
            ? undefined
            : await dependencies
                .engineCaptureFor(workspace.workspaceId)
                ?.settleAndCloseLiveSessionsForPath(localPath);
          try {
            // Local deletion stays recoverable: deletePath tries the OS trash,
            // then moves the entry into .dohc/trash when the OS refuses it.
            let result: ShareViewFileChangeValue;
            if (receivedShare) {
              const outcome = await dependencies.shareViewFiles.change(
                lease,
                shareTarget(workspace),
                { kind: "delete", path: input.relativePath },
              );
              result = structuralShareViewChangeValue(
                workspace.workspaceId,
                outcome,
                markWorkspaceChanged,
              );
            } else {
              result = await deletePath(
                workspace.rootPath,
                localPath!,
                dependencies.trashItem,
              );
            }
            if (
              typeof result !== "object" ||
              result === null ||
              !("trashed" in result)
            ) {
              throw new Error("Shared file delete returned an invalid result.");
            }
            if (!receivedShare) markWorkspaceChanged();
            if (localPath !== null) {
              dependencies.yDocSessions.markDeletedUnderPath(
                workspace.workspaceId,
                localPath,
              );
            }
            // The finisher cancels write debts only after removal succeeds.
            // On failure it restores the debts against the file still on disk.
            finishDebts?.(true);
            return DeleteWorkspacePathResult.parse(result);
          } catch (error) {
            finishDebts?.(false);
            throw error;
          }
        },
      );
    },

    writeText: async (event, payload) => {
      const { input, workspace, receivedShare } = requireMutation(
        event,
        payload,
        WriteWorkspaceTextPayload.parse,
      );
      if (!receivedShare) assertWritableWorkspace(workspace);
      if (receivedShare) {
        const result = await withStaleSensitiveWorkspaceOperation(
          workspace.rootPath,
          async (lease) =>
            committedShareViewChangeValue(
              workspace.workspaceId,
              await dependencies.shareViewFiles.change(
                lease,
                shareTarget(workspace),
                {
                  kind: "save",
                  path: input.relativePath,
                  text: input.text,
                  expectedContentHash: input.expectedContentHash,
                },
              ),
            ),
        );
        return WriteWorkspaceTextResult.parse(result);
      }
      const result = await withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async (lease) => {
          let path: string;
          try {
            path = (
              await resolveWorkspaceFile(
                workspace.rootPath,
                input.relativePath,
                "write",
              )
            ).resolvedPath;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT" || code === "ENOTDIR") {
              return {
                status: "conflict" as const,
                currentContentHash: null,
              };
            }
            throw error;
          }
          return dependencies.yDocSessions.withDocumentUnowned(
            workspace.workspaceId,
            path,
            () =>
              writeWorkspaceTextInLease(
                workspace.rootPath,
                lease,
                path,
                input.text,
                input.expectedContentHash,
              ),
          );
        },
      );
      return WriteWorkspaceTextResult.parse(result);
    },

    writeAsset: async (event, payload) => {
      const { input, workspace } = requireMutation(
        event,
        payload,
        WriteWorkspaceAssetPayload.parse,
      );
      assertWritableWorkspace(workspace);
      await withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async (lease) => {
          const requestedPath = normalizeWorkspaceImageAssetPath(
            input.relativePath,
          );
          const path = await resolveWorkspaceMaterializePath(
            workspace.rootPath,
            requestedPath,
          );
          if (liveDocumentKindForPath(path.resolvedPath) !== null) {
            throw new Error(
              "A live document cannot be replaced by an image attachment.",
            );
          }
          await dependencies.yDocSessions.withDocumentUnowned(
            workspace.workspaceId,
            path.resolvedPath,
            () =>
              writeWorkspaceAssetInLease(
                workspace.rootPath,
                lease,
                path,
                input.bytes,
              ),
          );
        },
      );
    },
  };
}
