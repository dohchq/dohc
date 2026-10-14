import { WorkspaceIdPayload } from "./bridgeContract";

export function registerWorkspaceHandler<Sender, Event extends { sender: Sender }, Operation>(
  registerHandler: (channel: string, handler: (event: Event, payload: unknown) => unknown) => void,
  boundary: {
    assertTrustedSender(event: Event): void;
    withRendererWorkspaceOperation<Result>(
      sender: Sender, workspaceId: string, inactiveMessage: string,
      work: (operation: Operation) => Promise<Result>,
    ): Promise<Result>;
  },
) {
  return (channel: string, handler: (event: Event, payload: unknown, operation: Operation) => unknown) =>
    registerHandler(channel, async (event, payload) => {
      boundary.assertTrustedSender(event);
      const { workspaceId } = WorkspaceIdPayload.parse(payload);
      return boundary.withRendererWorkspaceOperation(event.sender, workspaceId,
        "This workspace is no longer active.", async operation => handler(event, payload, operation));
    });
}
