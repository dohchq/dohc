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
  requireWorkspace(workspaceId: string): Workspace;
  assertWritableWorkspace(workspace: Workspace): void;
  commands: Pick<
    ShareMountCommands<WorkspaceSummary>,
    "mount" | "refresh" | "unmount"
  >;
}): void {
  dependencies.registerHandler(CHANNELS.mountShare, async (event, payload) => {
    dependencies.assertTrustedSender(event);
    const input = MountSharePayload.parse(payload);
    const workspace = dependencies.requireWorkspace(input.workspaceId);
    dependencies.assertWritableWorkspace(workspace);
    return MountShareResult.parse(
      await dependencies.commands.mount({
        workspace,
        shareCode: input.shareCode,
      }),
    );
  });

  dependencies.registerHandler(
    CHANNELS.refreshShareMounts,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = RefreshShareMountsPayload.parse(payload);
      const workspace = dependencies.requireWorkspace(input.workspaceId);
      dependencies.assertWritableWorkspace(workspace);
      return RefreshShareMountsResult.parse(
        await dependencies.commands.refresh({ workspace }),
      );
    },
  );

  dependencies.registerHandler(CHANNELS.unmountShare, async (event, payload) => {
    dependencies.assertTrustedSender(event);
    const input = UnmountSharePayload.parse(payload);
    const workspace = dependencies.requireWorkspace(input.workspaceId);
    dependencies.assertWritableWorkspace(workspace);
    return UnmountShareResult.parse(
      await dependencies.commands.unmount({
        workspace,
        shareId: input.shareId,
      }),
    );
  });
}
