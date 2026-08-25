import { validateUserWritePath } from "@dohc/workspace-core";
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
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
  writeWorkspaceAsset,
  writeWorkspaceText,
} from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  createFile,
  createFolder,
  deletePath,
  movePath,
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
  ownsDocument(workspaceId: string, path: string): boolean;
  forEachSessionUnderPath(
    workspaceId: string,
    pathOrPrefix: string,
    visit: (session: { markDeleted(): void }) => void,
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

          const capture = dependencies.engineCaptureFor(workspace.workspaceId);
          const fromKind = liveDocumentKindForPath(input.fromPath);
          const toKind = liveDocumentKindForPath(input.toPath);
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
            ? await capture.beginFileRename(input.fromPath, input.toPath)
            : null;
          try {
            const path = receivedShare
              ? committedShareViewChangeValue(
                  workspace.workspaceId,
                  await dependencies.shareViewFiles.change(
                    lease,
                    shareTarget(workspace),
                    {
                      kind: "move",
                      fromPath: input.fromPath,
                      toPath: input.toPath,
                    },
                  ),
                )
              : await movePath(
                  workspace.rootPath,
                  input.fromPath,
                  input.toPath,
                );
            if (typeof path !== "string") {
              throw new Error("Shared file move returned an invalid result.");
            }
            // The path move has landed. Bump the generation before the engine
            // finisher so its failure cannot release queued stale writes.
            markWorkspaceChanged();
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
          const validatedPath = validateUserWritePath(input.relativePath);
          // The Y.Doc is canonical while its session is live. Settle and
          // release it before moving the artifact out from under the engine.
          const finishDebts = receivedShare || !validatedPath.ok
            ? undefined
            : await dependencies
                .engineCaptureFor(workspace.workspaceId)
                ?.settleAndCloseLiveSessionsForPath(validatedPath.normalized);
          try {
            // Local deletion stays recoverable: deletePath tries the OS trash,
            // then moves the entry into .dohc/trash when the OS refuses it.
            const result = receivedShare
              ? committedShareViewChangeValue(
                  workspace.workspaceId,
                  await dependencies.shareViewFiles.change(
                    lease,
                    shareTarget(workspace),
                    { kind: "delete", path: input.relativePath },
                  ),
                )
              : await deletePath(
                  workspace.rootPath,
                  input.relativePath,
                  dependencies.trashItem,
                );
            if (
              typeof result !== "object" ||
              result === null ||
              !("trashed" in result)
            ) {
              throw new Error("Shared file delete returned an invalid result.");
            }
            markWorkspaceChanged();
            if (validatedPath.ok) {
              dependencies.yDocSessions.forEachSessionUnderPath(
                workspace.workspaceId,
                validatedPath.normalized,
                (session) => session.markDeleted(),
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
      const validatedPath = validateUserWritePath(input.relativePath);
      if (
        validatedPath.ok &&
        dependencies.yDocSessions.ownsDocument(
          workspace.workspaceId,
          validatedPath.normalized,
        )
      ) {
        throw new Error(
          "The engine owns this live document. Close its editor before writing the file directly.",
        );
      }
      const result = await withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async (lease) =>
          receivedShare
            ? committedShareViewChangeValue(
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
              )
            : writeWorkspaceText(
                workspace.rootPath,
                input.relativePath,
                input.text,
                input.expectedContentHash,
              ),
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
      await writeWorkspaceAsset(
        workspace.rootPath,
        input.relativePath,
        input.bytes,
      );
    },
  };
}
