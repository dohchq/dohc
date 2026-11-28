// @vitest-environment jsdom
import { cleanup, render as renderUi, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IncomingWebhookCreatedResult,
  IncomingWebhooksState,
} from "@dohc/workspace-contracts/incoming-webhooks";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { WorkspaceWebhooksSettings } from "./WorkspaceWebhooksSettings";

const bridgeMock = {
  listIncomingWebhooks:
    vi.fn<(payload: { workspaceId: string }) => Promise<IncomingWebhooksState>>(),
  createIncomingWebhook:
    vi.fn<
      (payload: { workspaceId: string; input: unknown }) => Promise<IncomingWebhookCreatedResult>
    >(),
  updateIncomingWebhook:
    vi.fn<(payload: { workspaceId: string; input: unknown }) => Promise<IncomingWebhooksState>>(),
  rotateIncomingWebhook:
    vi.fn<
      (payload: { workspaceId: string; webhookId: string }) => Promise<IncomingWebhookCreatedResult>
    >(),
  deleteIncomingWebhook:
    vi.fn<
      (payload: { workspaceId: string; webhookId: string }) => Promise<IncomingWebhooksState>
    >(),
  onCloudSessionChanged: vi.fn<
    (
      listener: (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void,
    ) => () => void
  >(() => () => undefined),
};

const render = (ui: ReactElement) =>
  renderUi(ui, {
    wrapper: ({ children }) => (
      <WorkspaceSessionProvider workspaceId="ws-1">{children}</WorkspaceSessionProvider>
    ),
  });

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { dohcDesktop: typeof bridgeMock }).dohcDesktop = bridgeMock;
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceWebhooksSettings", () => {
  it("creates a webhook, shows one-time URL and curl, pauses, rotates, and deletes", async () => {
    const user = userEvent.setup();
    const webhookId = "whk_aaaaaaaaaaaaaaaaaaaaaaaa";
    const activeHook = {
      webhookId,
      name: "iPhone Shortcut",
      collectionPath: "Inbox",
      collectionId: null,
      paused: false,
      pauseReason: null,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      lastDeliveryAtMs: null,
      pendingCount: 0,
      recentDeliveries: [],
    };
    const pausedHook = { ...activeHook, paused: true, pauseReason: "Paused by owner" };
    const firstToken = "a".repeat(43);
    const secondToken = "b".repeat(43);

    bridgeMock.listIncomingWebhooks.mockResolvedValue({
      kind: "ready",
      serverOrigin: "https://sync.example.com",
      webhooks: [],
      limit: 20,
    });
    bridgeMock.createIncomingWebhook.mockResolvedValueOnce({
      webhook: activeHook,
      token: firstToken,
      endpointUrl: `https://sync.example.com/sync/hooks/${firstToken}`,
      webhooks: [activeHook],
      limit: 20,
    });
    bridgeMock.updateIncomingWebhook.mockResolvedValueOnce({
      kind: "ready",
      serverOrigin: "https://sync.example.com",
      webhooks: [pausedHook],
      limit: 20,
    });
    bridgeMock.rotateIncomingWebhook.mockResolvedValueOnce({
      webhook: pausedHook,
      token: secondToken,
      endpointUrl: `https://sync.example.com/sync/hooks/${secondToken}`,
      webhooks: [pausedHook],
      limit: 20,
    });
    bridgeMock.deleteIncomingWebhook.mockResolvedValueOnce({
      kind: "ready",
      serverOrigin: "https://sync.example.com",
      webhooks: [],
      limit: 20,
    });

    render(<WorkspaceWebhooksSettings workspaceId="ws-1" />);
    expect(await screen.findByTestId("incoming-webhooks-empty")).toBeTruthy();

    await user.click(screen.getByTestId("incoming-webhooks-add"));
    await user.click(screen.getByTestId("incoming-webhook-create-submit"));
    expect(screen.getByTestId("incoming-webhook-name-error")).toBeTruthy();
    expect(bridgeMock.createIncomingWebhook).not.toHaveBeenCalled();

    await user.type(screen.getByTestId("incoming-webhook-name-input"), "iPhone Shortcut");
    await user.click(screen.getByTestId("incoming-webhook-create-submit"));

    expect(await screen.findByTestId("incoming-webhook-reveal-dialog")).toBeTruthy();
    expect(screen.getByTestId("incoming-webhook-reveal-url").textContent).toBe(
      `https://sync.example.com/sync/hooks/${firstToken}`,
    );
    expect(screen.getByTestId("incoming-webhook-reveal-curl").textContent).toContain(firstToken);
    await user.click(screen.getByTestId("incoming-webhook-reveal-done"));
    await waitFor(() => expect(screen.queryByTestId("incoming-webhook-reveal-dialog")).toBeNull());
    // Token is gone from DOM once dismissed.
    expect(document.body.textContent).not.toContain(firstToken);
    expect(screen.getByTestId(`incoming-webhook-row-${webhookId}`)).toBeTruthy();

    // Pause
    await user.click(screen.getByTestId(`incoming-webhook-toggle-${webhookId}`));
    await waitFor(() =>
      expect(screen.getByTestId(`incoming-webhook-toggle-${webhookId}`).textContent).toContain(
        "Resume",
      ),
    );

    // Rotate -> confirm -> one-time reveal of rotated URL
    await user.click(screen.getByTestId(`incoming-webhook-rotate-${webhookId}`));
    expect(screen.getByTestId("incoming-webhook-confirm-rotate")).toBeTruthy();
    await user.click(screen.getByTestId("incoming-webhook-confirm-rotate-action"));
    expect(await screen.findByTestId("incoming-webhook-reveal-dialog")).toBeTruthy();
    expect(screen.getByTestId("incoming-webhook-reveal-url").textContent).toBe(
      `https://sync.example.com/sync/hooks/${secondToken}`,
    );
    await user.click(screen.getByTestId("incoming-webhook-reveal-done"));

    // Delete
    await user.click(screen.getByTestId(`incoming-webhook-delete-${webhookId}`));
    expect(screen.getByTestId("incoming-webhook-confirm-delete")).toBeTruthy();
    await user.click(screen.getByTestId("incoming-webhook-confirm-delete-action"));
    expect(await screen.findByTestId("incoming-webhooks-empty")).toBeTruthy();
  });

  it("creates a website form that keeps only the named fields and shows a form to paste", async () => {
    const user = userEvent.setup();
    const token = "c".repeat(43);
    const formHook = {
      webhookId: "whk_bbbbbbbbbbbbbbbbbbbbbbbb",
      name: "Waitlist",
      collectionPath: "Inbox",
      collectionId: null,
      paused: false,
      pauseReason: null,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      lastDeliveryAtMs: null,
      form: { fields: ["email", "source"] },
      pendingCount: 0,
      recentDeliveries: [],
    };
    bridgeMock.listIncomingWebhooks.mockResolvedValue({
      kind: "ready",
      serverOrigin: "https://sync.example.com",
      webhooks: [],
      limit: 20,
    });
    bridgeMock.createIncomingWebhook.mockResolvedValueOnce({
      webhook: formHook,
      token,
      endpointUrl: `https://sync.example.com/sync/hooks/${token}`,
      webhooks: [formHook],
      limit: 20,
    });

    render(<WorkspaceWebhooksSettings workspaceId="ws-1" />);
    await user.click(await screen.findByTestId("incoming-webhooks-add"));
    await user.type(screen.getByTestId("incoming-webhook-name-input"), "Waitlist");
    await user.click(screen.getByRole("switch", { name: "Website form" }));
    const fields = screen.getByTestId("incoming-webhook-form-fields-input");
    await user.clear(fields);
    await user.type(fields, "email, email");
    await user.click(screen.getByTestId("incoming-webhook-create-submit"));
    expect(screen.getByTestId("incoming-webhook-form-fields-error")).toBeTruthy();
    expect(bridgeMock.createIncomingWebhook).not.toHaveBeenCalled();

    await user.clear(fields);
    await user.type(fields, "email, source");
    await user.click(screen.getByTestId("incoming-webhook-create-submit"));
    expect(bridgeMock.createIncomingWebhook).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      input: { name: "Waitlist", collectionPath: "Inbox", form: { fields: ["email", "source"] } },
    });
    const example = (await screen.findByTestId("incoming-webhook-reveal-curl")).textContent;
    expect(example).toContain(
      `<form method="post" action="https://sync.example.com/sync/hooks/${token}">`,
    );
    expect(example).toContain(`<label>email <input name="email" type="email" required></label>`);
    expect(example).toContain(`<label>source <input name="source"></label>`);
    await user.click(screen.getByTestId("incoming-webhook-reveal-done"));
    expect(screen.getByTestId(`incoming-webhook-row-${formHook.webhookId}`).textContent).toContain(
      "Website form",
    );
  });

  it("shows unavailable state for local-only workspaces and ignores slow workspace A responses after switching to B", async () => {
    bridgeMock.listIncomingWebhooks.mockImplementation(async ({ workspaceId }) =>
      workspaceId === "ws-a"
        ? {
            kind: "unavailable",
            message: "Incoming webhooks require a synced workspace.",
          }
        : {
            kind: "ready",
            serverOrigin: "https://sync.example.com",
            webhooks: [],
            limit: 20,
          },
    );

    const view = renderUi(
      <WorkspaceSessionProvider workspaceId="ws-a">
        <WorkspaceWebhooksSettings workspaceId="ws-a" />
      </WorkspaceSessionProvider>,
    );
    expect(await screen.findByTestId("incoming-webhooks-unavailable")).toBeTruthy();

    view.rerender(
      <WorkspaceSessionProvider workspaceId="ws-b">
        <WorkspaceWebhooksSettings workspaceId="ws-b" />
      </WorkspaceSessionProvider>,
    );
    expect(await screen.findByTestId("incoming-webhooks-empty")).toBeTruthy();
  });
});
