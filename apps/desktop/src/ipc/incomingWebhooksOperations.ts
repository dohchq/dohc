import { z } from "zod";
import {
  IncomingWebhookCreateInput,
  IncomingWebhookCreatedResult,
  IncomingWebhookId,
  IncomingWebhooksState,
  IncomingWebhookUpdateInput,
} from "@dohc/workspace-contracts/incoming-webhooks";
import type { OperationTable } from "./operationTable";

const WebhookWorkspace = z.object({ workspaceId: z.string().min(1).max(256) }).strict();

export const incomingWebhooksOperations = {
  listIncomingWebhooks: {
    capabilityId: "workspace.webhooks.list",
    scope: "workspace",
    handlerCheck: {
      check: "incomingWebhooksHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:list-incoming-webhooks",
    payload: WebhookWorkspace,
    result: IncomingWebhooksState,
    guard: "trusted-sender",
  },
  createIncomingWebhook: {
    capabilityId: "workspace.webhooks.create",
    scope: "workspace",
    handlerCheck: {
      check: "incomingWebhooksHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:create-incoming-webhook",
    payload: WebhookWorkspace.extend({ input: IncomingWebhookCreateInput }),
    result: IncomingWebhookCreatedResult,
    guard: "trusted-sender",
  },
  updateIncomingWebhook: {
    capabilityId: "workspace.webhooks.update",
    scope: "workspace",
    handlerCheck: {
      check: "incomingWebhooksHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:update-incoming-webhook",
    payload: WebhookWorkspace.extend({ input: IncomingWebhookUpdateInput }),
    result: IncomingWebhooksState,
    guard: "trusted-sender",
  },
  rotateIncomingWebhook: {
    capabilityId: "workspace.webhooks.rotate",
    scope: "workspace",
    handlerCheck: {
      check: "incomingWebhooksHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:rotate-incoming-webhook",
    payload: WebhookWorkspace.extend({ webhookId: IncomingWebhookId }),
    result: IncomingWebhookCreatedResult,
    guard: "trusted-sender",
  },
  deleteIncomingWebhook: {
    capabilityId: "workspace.webhooks.delete",
    scope: "workspace",
    handlerCheck: {
      check: "incomingWebhooksHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:delete-incoming-webhook",
    payload: WebhookWorkspace.extend({ webhookId: IncomingWebhookId }),
    result: IncomingWebhooksState,
    guard: "trusted-sender",
  },
} as const satisfies OperationTable;
