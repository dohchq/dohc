import { WorkspaceIdPayload } from "./bridgeContract";

export function createWorkspaceHandler<Sender, Event extends { sender: Sender }, Operation>(
  boundary: {
    assertTrustedSender(event: Event): void;
    withRendererWorkspaceOperation<Result>(
      sender: Sender, workspaceId: string, inactiveMessage: string,
      work: (operation: Operation) => Promise<Result>,
    ): Promise<Result>;
  },
) {
  return (handler: (event: Event, payload: unknown, operation: Operation) => unknown) =>
    async (event: Event, payload: unknown) => {
      boundary.assertTrustedSender(event);
      const { workspaceId } = WorkspaceIdPayload.parse(payload);
      return boundary.withRendererWorkspaceOperation(event.sender, workspaceId,
        "This workspace is no longer active.", async operation => handler(event, payload, operation));
    };
}
