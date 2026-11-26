// @vitest-environment jsdom
import { cleanup, render as renderUi, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSecretsState } from "@dohc/workspace-contracts/workspace-secrets";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { WorkspaceSecretsSettings } from "./WorkspaceSecretsSettings";

const bridgeMock = {
  listWorkspaceSecrets:
    vi.fn<(payload: { workspaceId: string }) => Promise<WorkspaceSecretsState>>(),
  setWorkspaceSecret:
    vi.fn<(payload: { workspaceId: string; secret: unknown }) => Promise<WorkspaceSecretsState>>(),
  deleteWorkspaceSecret:
    vi.fn<(payload: { workspaceId: string; name: string }) => Promise<WorkspaceSecretsState>>(),
  clearLocalWorkspaceSecrets:
    vi.fn<(payload: { workspaceId: string }) => Promise<WorkspaceSecretsState>>(),
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

describe("WorkspaceSecretsSettings", () => {
  it("lists empty state, validates fields on submit, adds, replaces, and deletes a secret", async () => {
    const user = userEvent.setup();
    bridgeMock.listWorkspaceSecrets.mockResolvedValue({
      kind: "ready",
      storage: "local",
      secrets: [],
      limit: 50,
    });
    bridgeMock.setWorkspaceSecret.mockResolvedValueOnce({
      kind: "ready",
      storage: "local",
      secrets: [
        {
          name: "RESEND_API_KEY",
          usage: "http-header",
          allowedHosts: ["api.resend.com"],
          generation: 1,
          createdAtMs: 1700000000000,
          updatedAtMs: 1700000000000,
        },
      ],
      limit: 50,
    });
    bridgeMock.deleteWorkspaceSecret.mockResolvedValueOnce({
      kind: "ready",
      storage: "local",
      secrets: [],
      limit: 50,
    });

    render(<WorkspaceSecretsSettings workspaceId="ws-1" />);
    expect(await screen.findByTestId("workspace-secrets-empty")).toBeTruthy();
    expect(screen.getByTestId("workspace-secrets-storage").textContent).toBe(
      "Sealed on this computer",
    );

    await user.click(screen.getByTestId("workspace-secrets-add"));
    await user.type(screen.getByTestId("workspace-secret-name-input"), "bad-name");
    await user.type(screen.getByTestId("workspace-secret-hosts-input"), "localhost");
    await user.click(screen.getByTestId("workspace-secret-save"));
    expect(screen.getByTestId("workspace-secret-name-error")).toBeTruthy();
    expect(screen.getByTestId("workspace-secret-hosts-error")).toBeTruthy();
    expect(screen.getByTestId("workspace-secret-value-error")).toBeTruthy();
    expect(bridgeMock.setWorkspaceSecret).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId("workspace-secret-name-input"));
    await user.type(screen.getByTestId("workspace-secret-name-input"), "RESEND_API_KEY");
    await user.clear(screen.getByTestId("workspace-secret-hosts-input"));
    await user.type(screen.getByTestId("workspace-secret-hosts-input"), "API.Resend.com");
    await user.type(screen.getByTestId("workspace-secret-value-input"), "re_secret_123");
    await user.click(screen.getByTestId("workspace-secret-save"));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-secret-row-RESEND_API_KEY")).toBeTruthy(),
    );
    expect(bridgeMock.setWorkspaceSecret).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      secret: {
        name: "RESEND_API_KEY",
        mode: "create",
        usage: "http-header",
        allowedHosts: ["api.resend.com"],
        value: "re_secret_123",
      },
    });
    expect(document.body.textContent).not.toContain("re_secret_123");

    await user.click(screen.getByTestId("workspace-secrets-add"));
    await user.type(screen.getByTestId("workspace-secret-name-input"), "RESEND_API_KEY");
    await user.type(screen.getByTestId("workspace-secret-hosts-input"), "evil.example.com");
    await user.type(screen.getByTestId("workspace-secret-value-input"), "re_secret_overwrite");
    await user.click(screen.getByTestId("workspace-secret-save"));
    expect(screen.getByTestId("workspace-secret-name-error").textContent).toContain(
      "already exists",
    );
    expect(bridgeMock.setWorkspaceSecret).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("workspace-secret-cancel"));

    bridgeMock.setWorkspaceSecret.mockResolvedValueOnce({
      kind: "ready",
      storage: "local",
      secrets: [
        {
          name: "RESEND_API_KEY",
          usage: "http-header",
          allowedHosts: ["api.resend.com", "mail.resend.com"],
          generation: 2,
          createdAtMs: 1700000000000,
          updatedAtMs: 1700000001000,
        },
      ],
      limit: 50,
    });
    await user.click(screen.getByTestId("workspace-secret-replace-RESEND_API_KEY"));
    await user.clear(screen.getByTestId("workspace-secret-hosts-input"));
    await user.type(
      screen.getByTestId("workspace-secret-hosts-input"),
      "api.resend.com, mail.resend.com",
    );
    expect(screen.queryByTestId("workspace-secret-value-error")).toBeNull();
    await user.type(screen.getByTestId("workspace-secret-value-input"), "re_secret_456");
    await user.click(screen.getByTestId("workspace-secret-save"));
    await waitFor(() => expect(screen.queryByTestId("workspace-secret-editor-dialog")).toBeNull());
    expect(bridgeMock.setWorkspaceSecret).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      secret: {
        name: "RESEND_API_KEY",
        mode: "replace",
        usage: "http-header",
        allowedHosts: ["api.resend.com", "mail.resend.com"],
        value: "re_secret_456",
      },
    });

    await user.click(screen.getByTestId("workspace-secret-delete-RESEND_API_KEY"));
    expect(screen.getByTestId("workspace-secret-confirm-delete")).toBeTruthy();
    await user.click(screen.getByTestId("workspace-secret-confirm-delete-action"));

    await waitFor(() => expect(screen.getByTestId("workspace-secrets-empty")).toBeTruthy());
    expect(bridgeMock.deleteWorkspaceSecret).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      name: "RESEND_API_KEY",
    });
  });

  it("shows unavailable state when system keychain or server is unavailable", async () => {
    bridgeMock.listWorkspaceSecrets.mockResolvedValue({
      kind: "unavailable",
      storage: "local",
      message:
        "This computer's system keychain is unavailable, so dohc cannot save workspace secrets here.",
    });

    render(<WorkspaceSecretsSettings workspaceId="ws-1" />);
    expect(await screen.findByTestId("workspace-secrets-unavailable")).toBeTruthy();
    expect(screen.getByText(/system keychain is unavailable/u)).toBeTruthy();
    expect(screen.queryByTestId("workspace-secrets-clear-local")).toBeNull();
  });

  it("deletes a damaged local vault only after the person confirms", async () => {
    const user = userEvent.setup();
    bridgeMock.listWorkspaceSecrets.mockResolvedValue({
      kind: "unavailable",
      storage: "local",
      message: "This workspace's secrets on this computer are damaged.",
      canDelete: true,
    });
    bridgeMock.clearLocalWorkspaceSecrets.mockResolvedValueOnce({
      kind: "ready",
      storage: "local",
      secrets: [],
      limit: 50,
    });

    render(<WorkspaceSecretsSettings workspaceId="ws-1" />);
    await user.click(await screen.findByTestId("workspace-secrets-clear-local"));
    await user.click(screen.getByTestId("workspace-secrets-cancel-clear-local"));
    expect(bridgeMock.clearLocalWorkspaceSecrets).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("workspace-secrets-clear-local"));
    await user.click(screen.getByTestId("workspace-secrets-confirm-clear-local-action"));
    expect(await screen.findByTestId("workspace-secrets-empty")).toBeTruthy();
    expect(bridgeMock.clearLocalWorkspaceSecrets).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("names the automations that use a secret before it is replaced or deleted", async () => {
    const user = userEvent.setup();
    const secret = {
      usage: "http-header" as const,
      allowedHosts: ["api.resend.com"],
      generation: 1,
      createdAtMs: 1700000000000,
      updatedAtMs: 1700000000000,
    };
    bridgeMock.listWorkspaceSecrets.mockResolvedValue({
      kind: "ready",
      storage: "local",
      secrets: [
        { name: "RESEND_API_KEY", ...secret },
        { name: "UNUSED_KEY", ...secret },
      ],
      limit: 50,
      uses: {
        RESEND_API_KEY: [{ collectionPath: "Signups", automationName: "Email new signups" }],
      },
    });

    render(<WorkspaceSecretsSettings workspaceId="ws-1" />);
    await user.click(await screen.findByTestId("workspace-secret-replace-RESEND_API_KEY"));
    expect(screen.getByTestId("workspace-secret-uses").textContent).toBe(
      "Used byEmail new signups in Signups",
    );
    await user.click(screen.getByTestId("workspace-secret-cancel"));

    await user.click(screen.getByTestId("workspace-secret-delete-RESEND_API_KEY"));
    expect(screen.getByTestId("workspace-secret-uses").textContent).toContain("Email new signups");
    await user.click(screen.getByTestId("workspace-secret-cancel-delete"));

    await user.click(screen.getByTestId("workspace-secret-delete-UNUSED_KEY"));
    expect(screen.getByTestId("workspace-secret-confirm-delete").textContent).toContain(
      "No automations use this secret.",
    );
  });

  it("deletes secrets left on this computer from before the workspace synced", async () => {
    const user = userEvent.setup();
    bridgeMock.listWorkspaceSecrets.mockResolvedValue({
      kind: "ready",
      storage: "server",
      secrets: [],
      limit: 50,
      localCopies: true,
    });
    bridgeMock.clearLocalWorkspaceSecrets.mockResolvedValueOnce({
      kind: "ready",
      storage: "server",
      secrets: [],
      limit: 50,
    });

    render(<WorkspaceSecretsSettings workspaceId="ws-1" />);
    expect(await screen.findByTestId("workspace-secrets-local-copies")).toBeTruthy();
    await user.click(screen.getByTestId("workspace-secrets-clear-local"));
    expect(screen.getByTestId("workspace-secrets-confirm-clear-local").textContent).toContain(
      "The secrets on your server stay.",
    );
    await user.click(screen.getByTestId("workspace-secrets-confirm-clear-local-action"));
    await waitFor(() => expect(screen.queryByTestId("workspace-secrets-local-copies")).toBeNull());
    expect(bridgeMock.clearLocalWorkspaceSecrets).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("ignores a slow workspace A mutation after switching to workspace B and refreshes on sign-out", async () => {
    const user = userEvent.setup();
    let sessionListener:
      | ((event: { sessionKey: string | null; phase: "changing" | "ready" }) => void)
      | undefined;
    bridgeMock.onCloudSessionChanged.mockImplementation((listener) => {
      sessionListener = listener;
      return () => {
        sessionListener = undefined;
      };
    });

    bridgeMock.listWorkspaceSecrets.mockImplementation(async ({ workspaceId }) => ({
      kind: "ready",
      storage: "server",
      secrets:
        workspaceId === "ws-a"
          ? [
              {
                name: "SECRET_A",
                usage: "http-url",
                allowedHosts: [],
                generation: 1,
                createdAtMs: 1,
                updatedAtMs: 1,
              },
            ]
          : [
              {
                name: "SECRET_B",
                usage: "http-url",
                allowedHosts: [],
                generation: 1,
                createdAtMs: 2,
                updatedAtMs: 2,
              },
            ],
      limit: 50,
    }));

    let resolveLateSave!: (value: WorkspaceSecretsState) => void;
    bridgeMock.setWorkspaceSecret.mockImplementationOnce(
      () =>
        new Promise<WorkspaceSecretsState>((resolve) => {
          resolveLateSave = resolve;
        }),
    );

    const view = renderUi(
      <WorkspaceSessionProvider workspaceId="ws-a">
        <WorkspaceSecretsSettings workspaceId="ws-a" />
      </WorkspaceSessionProvider>,
    );
    expect(await screen.findByTestId("workspace-secret-row-SECRET_A")).toBeTruthy();

    await user.click(screen.getByTestId("workspace-secrets-add"));
    await user.type(screen.getByTestId("workspace-secret-name-input"), "NEW_A");
    await user.click(screen.getByRole("radio", { name: "Webhook link" }));
    await user.type(
      screen.getByTestId("workspace-secret-value-input"),
      "https://hooks.example.com/a",
    );
    await user.click(screen.getByTestId("workspace-secret-save"));

    view.rerender(
      <WorkspaceSessionProvider workspaceId="ws-b">
        <WorkspaceSecretsSettings workspaceId="ws-b" />
      </WorkspaceSessionProvider>,
    );
    expect(await screen.findByTestId("workspace-secret-row-SECRET_B")).toBeTruthy();

    resolveLateSave({
      kind: "ready",
      storage: "server",
      secrets: [
        {
          name: "NEW_A",
          usage: "http-url",
          allowedHosts: [],
          generation: 1,
          createdAtMs: 3,
          updatedAtMs: 3,
        },
      ],
      limit: 50,
    });
    await Promise.resolve();
    expect(screen.getByTestId("workspace-secret-row-SECRET_B")).toBeTruthy();
    expect(screen.queryByTestId("workspace-secret-row-NEW_A")).toBeNull();

    bridgeMock.listWorkspaceSecrets.mockResolvedValueOnce({
      kind: "unavailable",
      storage: "server",
      message: "Sign in to your server to manage this workspace's secrets.",
    });
    sessionListener?.({ sessionKey: null, phase: "ready" });
    expect(await screen.findByTestId("workspace-secrets-unavailable")).toBeTruthy();
  });
});
