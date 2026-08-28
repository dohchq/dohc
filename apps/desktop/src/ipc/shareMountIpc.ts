import {
  MountSharePayload,
  MountShareResult,
  RefreshShareMountsPayload,
  RefreshShareMountsResult,
  UnmountSharePayload,
  UnmountShareResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import type {
  ShareMountCommandWorkspace,
  ShareMountCommands,
} from "../workspaces/shareMountCommands";

type ShareMountIpcHandler<Event> = (
  event: Event,
  payload: unknown,
) => Promise<unknown>;

export function registerShareMountIpcHandlers<
  Event,
  Workspace extends ShareMountCommandWorkspace,
  WorkspaceSummary,
>(dependencies: {
  registerHandler(channel: string, handler: ShareMountIpcHandler<Event>): void;
  assertTrustedSender(event: Event): void;
  withWorkspaceOperation(
    event: Event,
    workspaceId: string,
    work: (operation: {
      readonly workspace: Workspace;
      assertCurrent(): void;
    }) => Promise<unknown>,
  ): Promise<unknown>;
  assertWritableWorkspace(workspace: Workspace): void;
  commands: Pick<
    ShareMountCommands<WorkspaceSummary>,
    "mount" | "refresh" | "unmount"
  >;
}): void {
  dependencies.registerHandler(CHANNELS.mountShare, async (event, payload) => {
    dependencies.assertTrustedSender(event);
    const input = MountSharePayload.parse(payload);
    return dependencies.withWorkspaceOperation(
      event,
      input.workspaceId,
      async (operation) => {
        dependencies.assertWritableWorkspace(operation.workspace);
        return MountShareResult.parse(
          await dependencies.commands.mount({
            workspace: operation.workspace,
            shareCode: input.shareCode,
            assertCurrent: operation.assertCurrent,
          }),
        );
      },
    );
  });

  dependencies.registerHandler(
    CHANNELS.refreshShareMounts,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = RefreshShareMountsPayload.parse(payload);
      return dependencies.withWorkspaceOperation(
        event,
        input.workspaceId,
        async (operation) => {
          dependencies.assertWritableWorkspace(operation.workspace);
          return RefreshShareMountsResult.parse(
            await dependencies.commands.refresh({
              workspace: operation.workspace,
              assertCurrent: operation.assertCurrent,
            }),
          );
        },
      );
    },
  );

  dependencies.registerHandler(CHANNELS.unmountShare, async (event, payload) => {
    dependencies.assertTrustedSender(event);
    const input = UnmountSharePayload.parse(payload);
    return dependencies.withWorkspaceOperation(
      event,
      input.workspaceId,
      async (operation) => {
        dependencies.assertWritableWorkspace(operation.workspace);
        return UnmountShareResult.parse(
          await dependencies.commands.unmount({
            workspace: operation.workspace,
            shareId: input.shareId,
            assertCurrent: operation.assertCurrent,
          }),
        );
      },
    );
  });
}
