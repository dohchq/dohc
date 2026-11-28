import { describe, expect, it, vi } from "vitest";
import type {
  IncomingWebhookCreatedResult,
  IncomingWebhooksState,
} from "@dohc/workspace-contracts/incoming-webhooks";
import { incomingWebhooksHandlers } from "./incomingWebhooksIpc";

const sampleWebhook = {
  webhookId: "whk_aaaaaaaaaaaaaaaaaaaaaaaa",
  name: "iPhone Shortcut",
  collectionPath: "Inbox",
  collectionId: null,
  paused: false,
  pauseReason: null,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
  lastDeliveryAtMs: null,
  form: null,
  pendingCount: 0,
  recentDeliveries: [],
};

const readyState: IncomingWebhooksState = {
  kind: "ready",
  serverOrigin: "https://sync.example.com",
  webhooks: [sampleWebhook],
  limit: 20,
};

const createdResult: IncomingWebhookCreatedResult = {
  webhook: sampleWebhook,
  token: "a".repeat(43),
  endpointUrl: `https://sync.example.com/sync/hooks/${"a".repeat(43)}`,
  webhooks: [sampleWebhook],
  limit: 20,
};

describe("incomingWebhooksHandlers", () => {
  it("refuses calls for a workspace other than the sender's active workspace", () => {
    const listIncomingWebhooks = vi.fn(async () => readyState);
    const createIncomingWebhook = vi.fn(async () => createdResult);
    const updateIncomingWebhook = vi.fn(async () => readyState);
    const rotateIncomingWebhook = vi.fn(async () => createdResult);
    const deleteIncomingWebhook = vi.fn(async () => readyState);

    const handlers = incomingWebhooksHandlers({
      currentRendererSession: () => ({ workspaceId: "ws-active" }),
      listIncomingWebhooks,
      createIncomingWebhook,
      updateIncomingWebhook,
      rotateIncomingWebhook,
      deleteIncomingWebhook,
    });

    expect(() =>
      handlers.listIncomingWebhooks({ workspaceId: "ws-other" }, { event: { sender: "win-1" } }),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.createIncomingWebhook(
        {
          workspaceId: "ws-other",
          input: { name: "Hook", collectionPath: "Inbox" },
        },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.updateIncomingWebhook(
        {
          workspaceId: "ws-other",
          input: { webhookId: sampleWebhook.webhookId, paused: true },
        },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.rotateIncomingWebhook(
        { workspaceId: "ws-other", webhookId: sampleWebhook.webhookId },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.deleteIncomingWebhook(
        { workspaceId: "ws-other", webhookId: sampleWebhook.webhookId },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");

    expect(listIncomingWebhooks).not.toHaveBeenCalled();
    expect(createIncomingWebhook).not.toHaveBeenCalled();
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
    expect(rotateIncomingWebhook).not.toHaveBeenCalled();
    expect(deleteIncomingWebhook).not.toHaveBeenCalled();
  });

  it("forwards admitted calls for the active workspace", async () => {
    const listIncomingWebhooks = vi.fn(async () => readyState);
    const createIncomingWebhook = vi.fn(async () => createdResult);
    const updateIncomingWebhook = vi.fn(async () => readyState);
    const rotateIncomingWebhook = vi.fn(async () => createdResult);
    const deleteIncomingWebhook = vi.fn(async () => readyState);

    const handlers = incomingWebhooksHandlers({
      currentRendererSession: () => ({ workspaceId: "ws-active" }),
      listIncomingWebhooks,
      createIncomingWebhook,
      updateIncomingWebhook,
      rotateIncomingWebhook,
      deleteIncomingWebhook,
    });

    await expect(
      handlers.listIncomingWebhooks({ workspaceId: "ws-active" }, { event: { sender: "win-1" } }),
    ).resolves.toEqual(readyState);
    await expect(
      handlers.createIncomingWebhook(
        { workspaceId: "ws-active", input: { name: "iPhone Shortcut", collectionPath: "Inbox" } },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(createdResult);
    await expect(
      handlers.updateIncomingWebhook(
        {
          workspaceId: "ws-active",
          input: { webhookId: sampleWebhook.webhookId, paused: true },
        },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(readyState);
    await expect(
      handlers.rotateIncomingWebhook(
        { workspaceId: "ws-active", webhookId: sampleWebhook.webhookId },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(createdResult);
    await expect(
      handlers.deleteIncomingWebhook(
        { workspaceId: "ws-active", webhookId: sampleWebhook.webhookId },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(readyState);
  });
});
