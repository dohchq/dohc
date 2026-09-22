import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import type {
  WorkspaceSearchStartResult,
  workspaceSearchOperations,
} from "./bridgeContract";
import type { OperationHandlers } from "./operationTable";
import type {
  WorkspaceSearchAuthority,
  WorkspaceSearchOwner,
  WorkspaceSearchSender,
  WorkspaceSearchWorkspace,
} from "../workspaces/workspaceSearchOwner";

interface WorkspaceSearchIpcEvent {
  sender: WorkspaceSearchSender;
}

export function workspaceSearchHandlers<
  Event extends WorkspaceSearchIpcEvent,
  Workspace extends WorkspaceSearchWorkspace,
>(dependencies: {
  withWorkspaceOperation<Result>(
    event: Event,
    workspaceId: string,
    work: (authority: WorkspaceSearchAuthority<Workspace>) => Promise<Result>,
  ): Promise<Result>;
  authorizeCancel(event: Event): boolean;
  owner: Pick<WorkspaceSearchOwner<Workspace>, "start" | "cancel">;
  onActivityError(error: unknown): void;
}): OperationHandlers<typeof workspaceSearchOperations, Event> {
  return {
    async searchWorkspace(input, { event }) {
      const accepted = Promise.withResolvers<WorkspaceSearchStartResult>();
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
          accepted.resolve({ status: "accepted" });
          await started.settled;
        },
      );
      void activity.catch((error: unknown) => {
        if (!wasAccepted) {
          if (isWorkspaceUpdatingRefusal(error)) {
            accepted.resolve({
              status: "refused",
              code: "workspace-updating",
            });
            return;
          }
          accepted.reject(error);
          return;
        }
        dependencies.onActivityError(error);
      });
      return await accepted.promise;
    },

    async cancelWorkspaceSearch(input, { event }) {
      if (!dependencies.authorizeCancel(event)) return;
      await dependencies.owner.cancel(event.sender.id, input.searchId);
    },
  };
}
