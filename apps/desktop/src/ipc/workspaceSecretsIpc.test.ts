import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSecretsState } from "@dohc/workspace-contracts/workspace-secrets";
import { workspaceSecretsHandlers } from "./workspaceSecretsIpc";

describe("workspaceSecretsHandlers", () => {
  it("refuses calls for a workspace other than the sender's active workspace", () => {
    const listWorkspaceSecrets = vi.fn(async (): Promise<WorkspaceSecretsState> => ({
      kind: "ready",
      storage: "local",
      secrets: [],
      limit: 50,
    }));
    const setWorkspaceSecret = vi.fn(listWorkspaceSecrets);
    const deleteWorkspaceSecret = vi.fn(listWorkspaceSecrets);
    const clearLocalWorkspaceSecrets = vi.fn(listWorkspaceSecrets);
    const handlers = workspaceSecretsHandlers({
      currentRendererSession: () => ({ workspaceId: "ws-active" }),
      listWorkspaceSecrets,
      setWorkspaceSecret,
      deleteWorkspaceSecret,
      clearLocalWorkspaceSecrets,
    });

    expect(() =>
      handlers.listWorkspaceSecrets({ workspaceId: "ws-other" }, { event: { sender: "win-1" } }),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.setWorkspaceSecret(
        {
          workspaceId: "ws-other",
          secret: {
            name: "HOOK",
            mode: "create",
            usage: "http-url",
            value: "https://hooks.slack.com/services/A/B/C",
          },
        },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.deleteWorkspaceSecret(
        { workspaceId: "ws-other", name: "HOOK" },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");
    expect(() =>
      handlers.clearLocalWorkspaceSecrets(
        { workspaceId: "ws-other" },
        { event: { sender: "win-1" } },
      ),
    ).toThrow("This workspace is no longer active.");
    expect(clearLocalWorkspaceSecrets).not.toHaveBeenCalled();
    expect(listWorkspaceSecrets).not.toHaveBeenCalled();
    expect(setWorkspaceSecret).not.toHaveBeenCalled();
    expect(deleteWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("forwards admitted calls for the active workspace", async () => {
    const ready: WorkspaceSecretsState = {
      kind: "ready",
      storage: "local",
      secrets: [],
      limit: 50,
    };
    const listWorkspaceSecrets = vi.fn(async () => ready);
    const setWorkspaceSecret = vi.fn(async () => ready);
    const deleteWorkspaceSecret = vi.fn(async () => ready);
    const clearLocalWorkspaceSecrets = vi.fn(async () => ready);
    const handlers = workspaceSecretsHandlers({
      currentRendererSession: () => ({ workspaceId: "ws-active" }),
      listWorkspaceSecrets,
      setWorkspaceSecret,
      deleteWorkspaceSecret,
      clearLocalWorkspaceSecrets,
    });

    await expect(
      handlers.listWorkspaceSecrets({ workspaceId: "ws-active" }, { event: { sender: "win-1" } }),
    ).resolves.toEqual(ready);
    await expect(
      handlers.setWorkspaceSecret(
        {
          workspaceId: "ws-active",
          secret: {
            name: "HOOK",
            mode: "create",
            usage: "http-url",
            value: "https://hooks.slack.com/services/A/B/C",
          },
        },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(ready);
    await expect(
      handlers.deleteWorkspaceSecret(
        { workspaceId: "ws-active", name: "HOOK" },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(ready);
    await expect(
      handlers.clearLocalWorkspaceSecrets(
        { workspaceId: "ws-active" },
        { event: { sender: "win-1" } },
      ),
    ).resolves.toEqual(ready);
    expect(clearLocalWorkspaceSecrets).toHaveBeenCalledWith("ws-active");
  });
});
