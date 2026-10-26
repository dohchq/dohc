import { duplicateWorkspaceFile } from "./workspaceDuplicate";
import { DuplicateWorkspaceFilePayload, DuplicateWorkspaceFileResult } from "../ipc/bridgeContract";
import { randomUUID } from "node:crypto";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";

import {
  CreateWorkspaceFilePayload,
  CreateWorkspaceFileResult,
  CreateWorkspaceFolderPayload,
  DeleteWorkspacePathPayload,
  DeleteWorkspacePathResult,
  UndoHistoryOperationPayload,
  MoveWorkspacePathPayload,
  MoveWorkspacePathResult,
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
import type { LocalPersonAuthor } from "./desktopRecordEdits";
import { undoWorkspaceHistoryOperation, type OperationHistory } from "./workspaceHistoryOperations";
import { beginPendingRecovery, type DeleteUndoResult } from "./workspaceDeleteRecovery";
import { assertMoveDocumentKind, deleteWorkspacePathByHand, moveWorkspacePathByHand } from "./workspaceFileMoves";
import {
  createFile,
  createFolder,
  normalizeWorkspaceMovePaths,
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
  duplicateFile: WorkspaceFileMutationIpcHandler<Event, import("zod").infer<typeof DuplicateWorkspaceFileResult>>;
  movePath: WorkspaceFileMutationIpcHandler<Event, MoveWorkspacePathResult>;
  deletePath: WorkspaceFileMutationIpcHandler<
    Event,
    DeleteWorkspacePathResult
  >;
  undoHistoryOperation: WorkspaceFileMutationIpcHandler<Event, DeleteUndoResult>;
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
    authorityId: symbol,
    path: string,
    mutation: () => Promise<T>,
  ): Promise<T>;
  markDeletedUnderPath(
    authorityId: symbol,
    pathOrPrefix: string,
  ): void;
}

export interface WorkspaceFileMutationAuthority<
  Workspace extends WorkspaceFileMutationWorkspace,
> {
  readonly authorityId: symbol;
  readonly workspace: Readonly<Workspace>;
  readonly signal: AbortSignal;
  readonly capture: MutationCapture | null;
  readonly yDocSessions: WorkspaceFileMutationYDocPort;
  assertCurrent(): void;
}

type MutationCapture = Pick<WorkspaceEngineCapture, "changePathsAs" | "beginFileRename">;

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
  historyFor(workspace: Readonly<Workspace>): OperationHistory;
  assertTrustedSender(event: IpcEvent): void;
  withRendererWorkspaceOperation<Result>(
    event: IpcEvent,
    workspaceId: string,
    work: (
      authority: WorkspaceFileMutationAuthority<Workspace>,
    ) => Promise<Result>,
  ): Promise<Result>;
  shareViewFiles: Pick<ShareViewFiles, "change">;
  trashItem(path: string): Promise<void>;
  /** This computer's person, read when a request arrives. */
  localPerson(): Promise<LocalPersonAuthor>;
  notifyRenderer(workspaceId: string): void;
  // A file in a share view was created or saved, and its change is in the
  // share view's journal. The shell answers with a direct push.
  shareViewEdited(workspaceId: string): void;
  logError(message: string, error: unknown): void;
}): WorkspaceFileMutationOwner<IpcEvent> {
  const shareTarget = (workspace: Readonly<Workspace>) => ({
    kind: "standalone" as const,
    workspaceId: workspace.workspaceId,
  });

  // A committed create or save: the change is journaled, so a direct push can
  // carry it.
  const editedShareViewValue = (
    workspaceId: string,
    outcome: ShareViewFileChangeOutcome,
  ): ShareViewFileChangeValue => {
    const value = committedShareViewChangeValue(workspaceId, outcome);
    dependencies.shareViewEdited(workspaceId);
    return value;
  };

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

  const admitMutation = <Payload>(
    event: IpcEvent,
    payload: unknown,
    parse: (value: unknown) => Payload,
  ): Payload => {
    dependencies.assertTrustedSender(event);
    return parse(payload);
  };

  type MutationWork<Payload, Result> = (input: {
    input: Payload;
    workspace: Readonly<Workspace>;
    signal: AbortSignal;
    receivedShare: boolean;
    authorityId: symbol;
    capture: MutationCapture | null;
    yDocSessions: WorkspaceFileMutationYDocPort;
    assertCurrent(): void;
  }) => Promise<Result>;

  const runAdmittedMutation = <Payload extends { workspaceId: string }, Result>(
    event: IpcEvent,
    input: Payload,
    work: MutationWork<Payload, Result>,
  ): Promise<Result> =>
    dependencies.withRendererWorkspaceOperation(
      event,
      input.workspaceId,
      async (authority) =>
        await work({
          input,
          workspace: authority.workspace,
          signal: authority.signal,
          receivedShare: shareViewIsPresent(authority.workspace.shareView),
          authorityId: authority.authorityId,
          capture: authority.capture,
          yDocSessions: authority.yDocSessions,
          assertCurrent: () => authority.assertCurrent(),
        }),
    );

  const runMutation = <Payload extends { workspaceId: string }, Result>(
    event: IpcEvent,
    payload: unknown,
    parse: (value: unknown) => Payload,
    work: MutationWork<Payload, Result>,
  ): Promise<Result> => runAdmittedMutation(event, admitMutation(event, payload, parse), work);

  return {
    createFile: async (event, payload) => {
      return await runMutation(
        event,
        payload,
        CreateWorkspaceFilePayload.parse,
        async ({ input, workspace, receivedShare }) => {
          if (!receivedShare) assertWritableWorkspace(workspace);
      return withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async (lease) => {
          const path = receivedShare
            ? editedShareViewValue(
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
                { exclusive: input.exclusive },
              );
          if (typeof path !== "string") {
            throw new Error("Shared file create returned an invalid result.");
          }
          return CreateWorkspaceFileResult.parse({ path });
        },
      );
    },
      );
    },

    createFolder: async (event, payload) => {
      return await runMutation(
        event,
        payload,
        CreateWorkspaceFolderPayload.parse,
        async ({ input, workspace, receivedShare }) => {
          if (receivedShare) throw new Error(SHARE_VIEW_EMPTY_FOLDER_REFUSAL);
      assertWritableWorkspace(workspace);
      return withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async () =>
          CreateWorkspaceFileResult.parse({
            path: await createFolder(workspace.rootPath, input.relativePath, { exclusive: input.exclusive }),
          }),
      );
    },
      );
    },

    duplicateFile: async (event, payload) => {
      const request = admitMutation(event, payload, DuplicateWorkspaceFilePayload.parse);
      const person = await dependencies.localPerson();
      return runAdmittedMutation(event, request, async ({input, workspace, assertCurrent, capture}) => {
        if (!capture) throw new Error("Restart dohc before duplicating this file.");
        return DuplicateWorkspaceFileResult.parse(await duplicateWorkspaceFile({workspace, assertCurrent}, input.relativePath, person, capture));
      });
    },
    movePath: async (event, payload) => {
      const request = admitMutation(event, payload, MoveWorkspacePathPayload.parse);
      const person = await dependencies.localPerson();
      let published = false;
      let resolve!: (value: MoveWorkspacePathResult) => void, reject!: (error: unknown) => void;
      const result = new Promise<MoveWorkspacePathResult>((done, failed) => { resolve = done; reject = failed; });
      const recording = runAdmittedMutation(event, request, async ({ input, workspace, signal, receivedShare, capture, authorityId, yDocSessions, assertCurrent }) => {
        if (!receivedShare) {
          assertWritableWorkspace(workspace);
          return MoveWorkspacePathResult.parse(await moveWorkspacePathByHand({ workspace, assertCurrent }, input, person, {
            capture, requestId: randomUUID(), trashItem: dependencies.trashItem,
            onRecorded: (path, operationId) => {
              const value = MoveWorkspacePathResult.parse({ path, operationId, undo: { available: true } });
              const release = beginPendingRecovery(operationId, { signal, waitForReads: true });
              published = true;
              resolve(value);
              return release;
            },
            markDeleted: path => yDocSessions.markDeletedUnderPath(authorityId, path),
            admit: () => refuseMoveAcrossShareMount(workspace.rootPath, input.fromPath, input.toPath,
              storedShareMounts(workspace), shareMountRegistryIsPresent(workspace)),
          }));
        }
        return withExclusiveWorkspaceOperation(workspace.rootPath, async (markChanged, lease) => {
          const { fromPath, toPath } = normalizeWorkspaceMovePaths(input.fromPath, input.toPath);
          assertMoveDocumentKind(fromPath, toPath, "rename");
          const path = structuralShareViewChangeValue(workspace.workspaceId,
            await dependencies.shareViewFiles.change(lease, shareTarget(workspace), { kind: "move", fromPath, toPath }), markChanged);
          if (typeof path !== "string") throw new Error("Shared file move returned an invalid result.");
          return MoveWorkspacePathResult.parse({ path });
        });
      });
      void recording.then(resolve, error => {
        if (published) dependencies.logError("Could not finish recording the file move", error);
        reject(error);
      });
      return result;
    },

    undoHistoryOperation: async (event, payload) => {
      const request = admitMutation(event, payload, UndoHistoryOperationPayload.parse);
      const person = await dependencies.localPerson();
      return runAdmittedMutation(event, request, ({ input, workspace, signal, assertCurrent }) =>
        undoWorkspaceHistoryOperation({ workspace, signal, assertCurrent }, input, person, { history: dependencies.historyFor(workspace), agent: false }));
    },

    deletePath: async (event, payload) => {
      const request = admitMutation(event, payload, DeleteWorkspacePathPayload.parse);
      // History credits whoever asked, read before the delete waits for its workspace.
      const person = await dependencies.localPerson();
      return await runAdmittedMutation(event, request,
        async ({ input, workspace, receivedShare, authorityId, capture, yDocSessions, assertCurrent }) => {
          if (receivedShare && input.emptyFolderOnly) throw new Error(SHARE_VIEW_EMPTY_FOLDER_REFUSAL);
          if (!receivedShare) {
            assertWritableWorkspace(workspace);
            return DeleteWorkspacePathResult.parse(await deleteWorkspacePathByHand({ workspace, assertCurrent },
              input.relativePath, person, { capture, emptyFolderOnly: input.emptyFolderOnly, requestId: randomUUID(), trashItem: dependencies.trashItem,
                markDeleted: path => yDocSessions.markDeletedUnderPath(authorityId, path) }));
          }
          return await withExclusiveWorkspaceOperation(workspace.rootPath, async (markWorkspaceChanged, lease) => {
            const result = structuralShareViewChangeValue(workspace.workspaceId,
              await dependencies.shareViewFiles.change(lease, shareTarget(workspace),
                { kind: "delete", path: input.relativePath }), markWorkspaceChanged);
            if (typeof result !== "object" || result === null || !("trashed" in result)) {
              throw new Error("Shared file delete returned an invalid result.");
            }
            return DeleteWorkspacePathResult.parse(result);
          });
        });
    },

    writeText: async (event, payload) => {
      return await runMutation(
        event,
        payload,
        WriteWorkspaceTextPayload.parse,
        async ({
          input,
          workspace,
          receivedShare,
          authorityId,
          yDocSessions,
        }) => {
          if (!receivedShare) assertWritableWorkspace(workspace);
      if (receivedShare) {
        const result = await withStaleSensitiveWorkspaceOperation(
          workspace.rootPath,
          async (lease) =>
            editedShareViewValue(
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
          return yDocSessions.withDocumentUnowned(authorityId,
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
      );
    },

    writeAsset: async (event, payload) => {
      return await runMutation(
        event,
        payload,
        WriteWorkspaceAssetPayload.parse,
        async ({ input, workspace, authorityId, yDocSessions }) => {
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
          await yDocSessions.withDocumentUnowned(
                authorityId,
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
      );
    },
  };
}
