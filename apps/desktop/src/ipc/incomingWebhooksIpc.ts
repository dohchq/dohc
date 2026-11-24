import type {
  IncomingWebhookCreateInput,
  IncomingWebhookCreatedResult,
  IncomingWebhooksState,
  IncomingWebhookUpdateInput,
} from "@dohc/workspace-contracts/incoming-webhooks";
import type { OperationHandlers } from "./operationTable";
import { incomingWebhooksOperations } from "./incomingWebhooksOperations";

export function incomingWebhooksHandlers<Sender, Event extends { sender: Sender }>(dependencies: {
  currentRendererSession(sender: Sender): { readonly workspaceId: string } | undefined;
  listIncomingWebhooks(workspaceId: string): Promise<IncomingWebhooksState>;
  createIncomingWebhook(
    workspaceId: string,
    input: IncomingWebhookCreateInput,
  ): Promise<IncomingWebhookCreatedResult>;
  updateIncomingWebhook(
    workspaceId: string,
    input: IncomingWebhookUpdateInput,
  ): Promise<IncomingWebhooksState>;
  rotateIncomingWebhook(
    workspaceId: string,
    webhookId: string,
  ): Promise<IncomingWebhookCreatedResult>;
  deleteIncomingWebhook(workspaceId: string, webhookId: string): Promise<IncomingWebhooksState>;
}): OperationHandlers<typeof incomingWebhooksOperations, Event> {
  const admit = (event: Event, workspaceId: string) => {
    if (dependencies.currentRendererSession(event.sender)?.workspaceId !== workspaceId) {
      throw new Error("This workspace is no longer active.");
    }
  };
  return {
    listIncomingWebhooks: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.listIncomingWebhooks(input.workspaceId);
    },
    createIncomingWebhook: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.createIncomingWebhook(input.workspaceId, input.input);
    },
    updateIncomingWebhook: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.updateIncomingWebhook(input.workspaceId, input.input);
    },
    rotateIncomingWebhook: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.rotateIncomingWebhook(input.workspaceId, input.webhookId);
    },
    deleteIncomingWebhook: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.deleteIncomingWebhook(input.workspaceId, input.webhookId);
    },
  };
}
