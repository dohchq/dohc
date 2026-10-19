import { randomUUID } from "node:crypto";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { DatabaseEdit } from "../workspaces/workspaceDatabase";
import { createOwnedWorkspaceFileReader, type OwnedWorkspaceDatabaseReader } from "../workspaces/ownedWorkspaceFileReader";
import { importOwnedWorkspaceDatabase } from "../workspaces/ownedWorkspaceDatabaseImport";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import type { ShareViewFilesWorkspaceRecord } from "../workspaces/shareViewFilesTarget";
import { registerWorkspaceDatabaseIpcHandlers } from "./workspaceDatabaseIpc";
import { databaseImportOperations } from "./bridgeContract";
import { registerOperations } from "./operationTable";
import { withExclusiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import { assertDatabaseImportUnchanged, type DatabaseImportRecord } from "../workspaces/databaseImportUndo";
import type { deleteWorkspacePathByHand } from "../workspaces/workspaceFileMoves";

export function registerDesktopDatabaseIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Workspace extends ShareViewFilesWorkspaceRecord,
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => Promise<unknown>): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: { readonly workspace: Workspace; readonly signal: AbortSignal }) => Promise<Result>,
  ): Promise<Result>;
  assertWritableWorkspace(workspace: Workspace): void;
  shareViewFiles: Pick<ShareViewFiles, "read">;
  workerDatabaseReader(signal?: AbortSignal): OwnedWorkspaceDatabaseReader;
  editWorkspaceDatabaseInWorker(input: {
    rootPath: string;
    relativePath: string;
    edit: DatabaseEdit;
    author: ChangeAuthor;
    nowMs: number;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  deleteDatabaseImport(
    operation: { readonly workspace: Workspace; readonly signal: AbortSignal },
    path: string, markChanged: () => void, admit: () => Promise<void>,
  ): ReturnType<typeof deleteWorkspacePathByHand>;
}): void {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    assertWritableWorkspace, shareViewFiles, workerDatabaseReader,
    editWorkspaceDatabaseInWorker,
  } = dependencies;

  registerWorkspaceDatabaseIpcHandlers<
    Event,
    Workspace
  >({
    registerHandler,
    assertTrustedSender,
    withWorkspaceOperation: (
      event,
      workspaceId,
      inactiveMessage,
      work,
    ) =>
      withRendererWorkspaceOperation(
        event.sender,
        workspaceId,
        inactiveMessage,
        work,
      ),
    assertWritableWorkspace,
    read: (operation, relativePath) =>
      createOwnedWorkspaceFileReader({
        workspace: operation.workspace,
        files: shareViewFiles,
        databaseReader: workerDatabaseReader(operation.signal),
      }).readDatabase(relativePath),
    readPage: (operation, input) =>
      createOwnedWorkspaceFileReader({
        workspace: operation.workspace,
        files: shareViewFiles,
        databaseReader: workerDatabaseReader(operation.signal),
      }).readDatabasePage(input.relativePath, input.table, input.offset),
    edit: (operation, input) => withExclusiveWorkspaceOperation(operation.workspace.rootPath, () =>
      editWorkspaceDatabaseInWorker({
        rootPath: operation.workspace.rootPath,
        relativePath: input.relativePath,
        edit: input.edit,
        author: { kind: "user", userId: "local" },
        nowMs: input.nowMs,
        operationId: input.operationId,
        signal: operation.signal,
      })),
    now: () => Date.now(),
    createId: randomUUID,
  });

  // This registration lives for the main process run, across renderer reloads.
  const imports = new Map<string, DatabaseImportRecord>();
  const inactiveMessage = "Database import Undo stopped because this window changed workspaces.";
  registerOperations({
    handle: registerHandler, assertTrustedSender,
    withActiveWorkspace: (event: Event, workspaceId, message, work) =>
      withRendererWorkspaceOperation(event.sender, workspaceId, message, work),
  }, databaseImportOperations, {
    importToDatabase: (input, { event }) => withRendererWorkspaceOperation(
      event.sender, input.workspaceId, "Database import stopped because this window changed workspaces.",
      async (operation) => {
        assertWritableWorkspace(operation.workspace);
        const result = await importOwnedWorkspaceDatabase({
          workspace: operation.workspace, files: shareViewFiles,
          sourcePath: input.sourceRelativePath, databasePath: input.databaseRelativePath,
          tableName: input.tableName, signal: operation.signal,
        });
        const operationId = `dohc-operation:${randomUUID()}`;
        imports.set(operationId, { operationId, workspaceId: operation.workspace.workspaceId,
          path: result.path, sha256: result.sha256, size: result.size });
        return { ...result, operationId };
      },
    ),
    undoDatabaseImport: (input, { event }) => withRendererWorkspaceOperation(
      event.sender, input.workspaceId, inactiveMessage,
      operation => withExclusiveWorkspaceOperation(operation.workspace.rootPath, async markChanged => {
        operation.signal.throwIfAborted();
        assertWritableWorkspace(operation.workspace);
        const record = imports.get(input.operationId);
        if (!record) throw new Error("Cannot undo this import. Undo is no longer available.");
        if (record.workspaceId !== operation.workspace.workspaceId) {
          throw new Error("Cannot undo this import in another workspace. Open the workspace where you imported it.");
        }
        const admit = async () => {
          operation.signal.throwIfAborted();
          assertWritableWorkspace(operation.workspace);
          await assertDatabaseImportUnchanged(operation.workspace.rootPath, record);
          operation.signal.throwIfAborted();
        };
        await admit();
        // Consume before deletion: a failure after trashing must never delete a replacement on retry.
        imports.delete(input.operationId);
        return dependencies.deleteDatabaseImport(operation, record.path, markChanged, admit);
      }, { markOnSuccess: false }),
    ),
  });
}
