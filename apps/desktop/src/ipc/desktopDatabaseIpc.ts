import { randomUUID } from "node:crypto";
import type { ChangeAuthor } from "@dohc/workspace-core";
import type { DatabaseEdit } from "../workspaces/workspaceDatabase";
import { createOwnedWorkspaceFileReader, type OwnedWorkspaceDatabaseReader } from "../workspaces/ownedWorkspaceFileReader";
import { importOwnedWorkspaceDatabase } from "../workspaces/ownedWorkspaceDatabaseImport";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import type { ShareViewFilesWorkspaceRecord } from "../workspaces/shareViewFilesTarget";
import { registerWorkspaceDatabaseIpcHandlers } from "./workspaceDatabaseIpc";
import { CHANNELS } from "./channels";
import { ImportToDatabasePayload, ImportToDatabaseResult } from "./bridgeContract";

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
    edit: (operation, input) =>
      editWorkspaceDatabaseInWorker({
        rootPath: operation.workspace.rootPath,
        relativePath: input.relativePath,
        edit: input.edit,
        author: { kind: "user", userId: "local" },
        nowMs: input.nowMs,
        operationId: input.operationId,
        signal: operation.signal,
      }),
    now: () => Date.now(),
    createId: randomUUID,
  });

  registerHandler(CHANNELS.importToDatabase, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportToDatabasePayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Database import stopped because this window changed workspaces.",
      async (operation) => {
        assertWritableWorkspace(operation.workspace);
        return ImportToDatabaseResult.parse(
          await importOwnedWorkspaceDatabase({
            workspace: operation.workspace,
            files: shareViewFiles,
            sourcePath: input.sourceRelativePath,
            databasePath: input.databaseRelativePath,
            tableName: input.tableName,
          }),
        );
      },
    );
  });
}
