import {
  CancelWorkspaceSearchPayload,
  WorkspaceSearchPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import type {
  WorkspaceSearchAuthority,
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
  withWorkspaceOperation<Result>(
    event: Event,
    workspaceId: string,
    work: (authority: WorkspaceSearchAuthority<Workspace>) => Promise<Result>,
  ): Promise<Result>;
  authorizeCancel(event: Event): boolean;
  owner: Pick<WorkspaceSearchOwner<Workspace>, "start" | "cancel">;
  onActivityError(error: unknown): void;
}): void {
  dependencies.registerHandler(
    CHANNELS.searchWorkspace,
    async (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = WorkspaceSearchPayload.parse(payload);
      const accepted = Promise.withResolvers<void>();
      let wasAccepted = false;
      const activity = dependencies.withWorkspaceOperation(
        event,
        input.workspaceId,
        async (authority) => {
          const started = await dependencies.owner.start(
            event.sender,
            authority,
            input,
          );
          wasAccepted = true;
          accepted.resolve();
          await started.settled;
        },
      );
      void activity.catch((error: unknown) => {
        if (!wasAccepted) {
          accepted.reject(error);
          return;
        }
        dependencies.onActivityError(error);
      });
      await accepted.promise;
    },
  );

  dependencies.registerHandler(
    CHANNELS.cancelWorkspaceSearch,
    (event, payload) => {
      dependencies.assertTrustedSender(event);
      const input = CancelWorkspaceSearchPayload.parse(payload);
      if (!dependencies.authorizeCancel(event)) return;
      return dependencies.owner.cancel(event.sender.id, input.searchId);
    },
  );
}
