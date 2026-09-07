import type { DatabaseEdit } from "../workspaces/workspaceDatabase";
import { CHANNELS } from "./channels";
import {
  ApplyDatabaseEditPayload,
  DatabaseEditResult,
  DatabasePageResult,
  DatabaseSnapshotResult,
  ReadWorkspaceDatabasePagePayload,
  ReadWorkspaceDatabasePayload,
} from "./bridgeContract";

type WorkspaceDatabaseIpcHandler<Event> = (
  event: Event,
  payload: unknown,
) => Promise<unknown>;

interface WorkspaceDatabaseOperation<Workspace> {
  readonly workspace: Workspace;
  readonly signal: AbortSignal;
}

export interface WorkspaceDatabaseIpcDependencies<Event, Workspace> {
  registerHandler(
    channel: string,
    handler: WorkspaceDatabaseIpcHandler<Event>,
  ): void;
  assertTrustedSender(event: Event): void;
  withWorkspaceOperation<Result>(
    event: Event,
    workspaceId: string,
    inactiveMessage: string,
    work: (
      operation: WorkspaceDatabaseOperation<Workspace>,
    ) => Promise<Result>,
  ): Promise<Result>;
  assertWritableWorkspace(workspace: Workspace): void;
  read(
    operation: WorkspaceDatabaseOperation<Workspace>,
    relativePath: string,
  ): Promise<unknown>;
  readPage(
    operation: WorkspaceDatabaseOperation<Workspace>,
    input: { relativePath: string; table: string; offset: number },
  ): Promise<unknown>;
  edit(
    operation: WorkspaceDatabaseOperation<Workspace>,
    input: {
      relativePath: string;
      edit: DatabaseEdit;
      nowMs: number;
      operationId: string;
    },
  ): Promise<unknown>;
  now(): number;
  createId(): string;
}

export function registerWorkspaceDatabaseIpcHandlers<Event, Workspace>(
  dependencies: WorkspaceDatabaseIpcDependencies<Event, Workspace>,
): void {
  dependencies.registerHandler(
    CHANNELS.readWorkspaceDatabase,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = ReadWorkspaceDatabasePayload.parse(payload);
      return dependencies.withWorkspaceOperation(
        event,
        input.workspaceId,
        "Database read stopped because this window changed workspaces.",
        async (operation) =>
          DatabaseSnapshotResult.parse(
            await dependencies.read(operation, input.relativePath),
          ),
      );
    },
  );

  dependencies.registerHandler(
    CHANNELS.readWorkspaceDatabasePage,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = ReadWorkspaceDatabasePagePayload.parse(payload);
      return dependencies.withWorkspaceOperation(
        event,
        input.workspaceId,
        "Database read stopped because this window changed workspaces.",
        async (operation) =>
          DatabasePageResult.parse(
            await dependencies.readPage(operation, {
              relativePath: input.relativePath,
              table: input.table,
              offset: input.offset,
            }),
          ),
      );
    },
  );

  dependencies.registerHandler(
    CHANNELS.applyDatabaseEdit,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = ApplyDatabaseEditPayload.parse(payload);
      return dependencies.withWorkspaceOperation(
        event,
        input.workspaceId,
        "Database edit stopped because this window changed workspaces.",
        async (operation) => {
          dependencies.assertWritableWorkspace(operation.workspace);
          return DatabaseEditResult.parse(
            await dependencies.edit(operation, {
              relativePath: input.relativePath,
              edit: input.edit,
              nowMs: dependencies.now(),
              operationId: dependencies.createId(),
            }),
          );
        },
      );
    },
  );
}
