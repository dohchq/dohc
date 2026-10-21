import { scheduleHostOperations, type ScheduleHostResult } from "./bridgeContract";
import type { OperationHandlers } from "./operationTable";

export function scheduleHostHandlers<Sender, Event extends { sender: Sender }>(dependencies: {
  currentRendererSession(sender: Sender): { readonly workspaceId: string } | undefined;
  scheduleHostState(workspaceId: string, change?: {
    action: "choose" | "take-over"; body: Record<string, string | number>;
  }, localOnly?: boolean): Promise<ScheduleHostResult>;
}): OperationHandlers<typeof scheduleHostOperations, Event> {
  const { scheduleHostState } = dependencies;
  const admit = (event: Event, workspaceId: string) => {
    if (dependencies.currentRendererSession(event.sender)?.workspaceId !== workspaceId) {
      throw new Error("This workspace is no longer active.");
    }
  };
  return {
    readScheduleHost: (input, { event }) => {
      admit(event, input.workspaceId);
      return input.localOnly ? scheduleHostState(input.workspaceId, undefined, true) : scheduleHostState(input.workspaceId);
    },
    chooseScheduleHost: (input, { event }) => {
      admit(event, input.workspaceId);
      return scheduleHostState(input.workspaceId, {
        action: "choose", body: { installId: input.installId, generation: input.generation },
      });
    },
    takeOverScheduleHost: (input, { event }) => {
      admit(event, input.workspaceId);
      return scheduleHostState(input.workspaceId, {
        action: "take-over", body: { generation: input.generation },
      });
    },
  };
}
