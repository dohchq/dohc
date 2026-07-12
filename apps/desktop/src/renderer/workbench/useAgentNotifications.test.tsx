// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentNotifications } from "./useAgentNotifications";

// Shell-level poller for Agent -> user notifications. These tests pin the
// PRODUCT INVARIANT: a slow/stale response for workspace A must never repaint
// workspace B, and switching away/back must not re-raise a dismissed run.

const WS_A_PERMISSION = {
  requestId: "perm-1",
  title: "Write notes/plan.md",
  options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
};

function panelFor(workspaceId: string) {
  if (workspaceId === "ws-a") {
    return {
      drivers: [],
      session: {
        driverId: "d",
        driverName: "D",
        status: "completed",
        startedAt: 1,
        runId: "run-a",
        messages: [{ id: "m1", role: "assistant", text: "Reorganized /notes." }],
        items: [],
        pendingPermissions: [WS_A_PERMISSION],
        authNotices: [],
      },
    };
  }
  // ws-b has no active run — nothing to notify about.
  return { drivers: [], session: null };
}

const getAgentSessionState = vi.fn(async ({ workspaceId }: { workspaceId: string }) =>
  panelFor(workspaceId),
);

beforeEach(() => {
  getAgentSessionState.mockClear();
  vi.stubGlobal("dohcDesktop", { getAgentSessionState });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const baseProps = {
  workspaceName: "Workspace",
  agentName: "You's agent",
  userCandidates: [],
  // Large interval so only the immediate poll runs in the test window.
  pollIntervalMs: 1_000_000,
};

describe("useAgentNotifications workspace isolation", () => {
  it("never renders another workspace's notice after a switch (synchronous filter)", async () => {
    const { result, rerender } = renderHook(
      ({ ws }) => useAgentNotifications({ workspaceId: ws, ...baseProps }),
      { initialProps: { ws: "ws-a" } },
    );

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0]!.workspaceId).toBe("ws-a");

    // Switch to B. Even before B's first poll resolves, A's notice must be gone
    // synchronously — the render filters to the current workspace.
    rerender({ ws: "ws-b" });
    expect(result.current.notifications).toEqual([]);
  });

  it("exposes the session's pending permissions and drops them on switch", async () => {
    const { result, rerender } = renderHook(
      ({ ws }) => useAgentNotifications({ workspaceId: ws, ...baseProps }),
      { initialProps: { ws: "ws-a" } },
    );

    await waitFor(() =>
      expect(result.current.pendingPermissions).toEqual([WS_A_PERMISSION]),
    );

    // Switch to B: A's asks vanish synchronously — a stale card must never
    // invite an answer against the wrong workspace.
    rerender({ ws: "ws-b" });
    expect(result.current.pendingPermissions).toEqual([]);
  });

  it("does not re-raise a dismissed run after switching away and back", async () => {
    const { result, rerender } = renderHook(
      ({ ws }) => useAgentNotifications({ workspaceId: ws, ...baseProps }),
      { initialProps: { ws: "ws-a" } },
    );

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    const id = result.current.notifications[0]!.id;
    act(() => result.current.dismiss(id));
    expect(result.current.notifications).toEqual([]);

    // Away to B, then back to A. A polls again (still completed) but the
    // per-workspace dismissal persisted, so the notice is NOT re-raised.
    rerender({ ws: "ws-b" });
    rerender({ ws: "ws-a" });

    await waitFor(() =>
      expect(getAgentSessionState).toHaveBeenCalledWith({ workspaceId: "ws-a" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.notifications).toEqual([]);
  });
});
