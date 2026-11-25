import { describe, expect, it, vi } from "vitest";
import { createWorkspaceReplicationRoutes } from "./workspaceReplicationRoutes";

describe("sync-relay analytics hooks", () => {
  it("fires onWorkspaceCreated only when a workspace is first created", async () => {
    const onWorkspaceCreated = vi.fn();
    let claimResult: "created" | "owned" | "not-owner" = "created";
    const routes = createWorkspaceReplicationRoutes(
      {
        claimWorkspace: vi.fn(() => claimResult),
      } as unknown as Parameters<typeof createWorkspaceReplicationRoutes>[0],
      () => 1_000,
      { wakeLog: vi.fn(), wait: vi.fn() },
      { watched: vi.fn(() => false) },
      undefined,
      undefined,
      onWorkspaceCreated,
    );

    const request = () =>
      new Request("http://relay.invalid/sync/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      });

    const first = await routes.respondToWorkspaceRegistration(request(), { userId: "user-1" });
    expect(first.status).toBe(200);
    expect(onWorkspaceCreated).toHaveBeenCalledTimes(1);

    claimResult = "owned";
    const second = await routes.respondToWorkspaceRegistration(request(), { userId: "user-1" });
    expect(second.status).toBe(200);
    expect(onWorkspaceCreated).toHaveBeenCalledTimes(1);
  });
});
