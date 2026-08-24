// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentNotifications } from "./useAgentNotifications";

// Shell-level poller for Agent -> user notifications. These tests pin the
// PRODUCT INVARIANT: a slow/stale response for workspace A must never repaint
// workspace B, and switching away/back must not re-raise a dismissed run.

const WS_A_PERMISSION = {
  requestId: "perm-1",
  requestType: "file-change",
  title: "Write notes/plan.md",
  locations: ["notes/plan.md"],
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

// The hook subscribes to workspace-activity pings to wake the idle cadence;
// tests fire them through this registry.
let activityListeners: Array<() => void> = [];
const onWorkspaceActivity = vi.fn((listener: () => void) => {
  activityListeners.push(listener);
  return () => {
    activityListeners = activityListeners.filter((entry) => entry !== listener);
  };
});
const fireWorkspaceActivity = () => {
  for (const listener of [...activityListeners]) listener();
};

beforeEach(() => {
  // A test may swap the implementation (e.g. to start a session mid-test);
  // restore the workspace-keyed default so tests stay independent.
  getAgentSessionState.mockImplementation(
    async ({ workspaceId }: { workspaceId: string }) => panelFor(workspaceId),
  );
  activityListeners = [];
  vi.stubGlobal("dohcDesktop", { getAgentSessionState, onWorkspaceActivity });
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

// The poller runs for the app's life in every window. These tests pin the two
// idle-cost guarantees: an unchanged poll never re-renders the host, and a
// sessionless workspace polls at the slow cadence.
describe("useAgentNotifications idle polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps pendingAsks reference-stable across a no-change poll (no re-render)", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAgentNotifications({
        workspaceId: "ws-a",
        ...baseProps,
        pollIntervalMs: 1_500,
      });
    });
    // First poll lands: asks + notice paint once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const asks = result.current.pendingPermissions;
    expect(asks).toEqual([WS_A_PERMISSION]);

    // React renders once more on the first bailed-out set before it trusts
    // the queue is a no-op; let that tick pass, then pin the steady state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    const settledRenders = renders;

    // Further polls of the same snapshot: same references, zero renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(4);
    expect(result.current.pendingPermissions).toBe(asks);
    expect(renders).toBe(settledRenders);
  });

  it("backs off to a slow cadence with no session and speeds up when one appears", async () => {
    renderHook(() =>
      useAgentNotifications({
        workspaceId: "ws-b",
        ...baseProps,
        pollIntervalMs: 1_500,
      }),
    );
    // Immediate poll sees no session (ws-b), so the next one waits 10s, not 1.5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(2);

    // A session starts: the idle tick that sees it restores the 1.5s cadence.
    getAgentSessionState.mockImplementation(async () => panelFor("ws-a"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(4);
  });

  it("polls immediately on a workspace-activity ping during the idle cadence", async () => {
    const { result } = renderHook(() =>
      useAgentNotifications({
        workspaceId: "ws-b",
        ...baseProps,
        pollIntervalMs: 1_500,
      }),
    );
    // Immediate poll sees no session; the next timer is the slow 10s one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(1);

    // A run starts and pings: the hook polls NOW — the first permission ask
    // must not sit invisible for up to 10s.
    getAgentSessionState.mockImplementation(async () => panelFor("ws-a"));
    await act(async () => {
      fireWorkspaceActivity();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(2);
    expect(result.current.pendingPermissions).toHaveLength(1);

    // That poll saw a session, so the fast cadence is restored...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(3);

    // ...and pings on the fast cadence are a no-op (no stacked polls).
    await act(async () => {
      fireWorkspaceActivity();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getAgentSessionState).toHaveBeenCalledTimes(3);
  });

  it("repaints the card when a reused requestId carries changed content", async () => {
    const { result } = renderHook(() =>
      useAgentNotifications({
        workspaceId: "ws-a",
        ...baseProps,
        pollIntervalMs: 1_500,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const asks = result.current.pendingPermissions;
    expect(asks).toEqual([WS_A_PERMISSION]);

    // Same requestId, new content (AgentSessionManager replaces the entry in
    // place on requestId reuse). The single-ask snapshot has the same length
    // and ids, so only content-aware equality repaints the card.
    getAgentSessionState.mockImplementation(async () => {
      const panel = panelFor("ws-a");
      panel.session!.pendingPermissions = [
        { ...WS_A_PERMISSION, title: "Write notes/other.md" },
      ];
      return panel;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(result.current.pendingPermissions).not.toBe(asks);
    expect(result.current.pendingPermissions[0]!.title).toBe("Write notes/other.md");
  });
});
