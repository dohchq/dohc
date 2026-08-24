import {
  CancelWorkspaceSearchPayload,
  WorkspaceSearchPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import type {
  WorkspaceSearchOwner,
  WorkspaceSearchSender,
  WorkspaceSearchWorkspace,
} from "../workspaces/workspaceSearchOwner";

interface WorkspaceSearchIpcEvent {
  sender: WorkspaceSearchSender;
}

type WorkspaceSearchIpcHandler<Event> = (
  event: Event,
  payload: unknown,
) => Promise<unknown> | unknown;

export function registerWorkspaceSearchIpcHandlers<
  Event extends WorkspaceSearchIpcEvent,
  Workspace extends WorkspaceSearchWorkspace,
>(dependencies: {
  registerHandler(
    channel: string,
    handler: WorkspaceSearchIpcHandler<Event>,
  ): void;
  assertTrustedSender(event: Event): void;
  requireWorkspace(event: Event, workspaceId: string): Workspace;
  owner: Pick<WorkspaceSearchOwner<Workspace>, "start" | "cancel">;
}): void {
  dependencies.registerHandler(
    CHANNELS.searchWorkspace,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = WorkspaceSearchPayload.parse(payload);
      const workspace = dependencies.requireWorkspace(event, input.workspaceId);
      await dependencies.owner.start(event.sender, workspace, input);
    },
  );

  dependencies.registerHandler(
    CHANNELS.cancelWorkspaceSearch,
    (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = CancelWorkspaceSearchPayload.parse(payload);
      dependencies.owner.cancel(event.sender.id, input.searchId);
    },
  );
}
