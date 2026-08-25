import { describe, expect, it, vi } from "vitest";
import {
  broadcastWorkspaceActivity,
  workspaceActivityPayload,
} from "./workspaceActivityBroadcast";

function fakeWindow(id: number) {
  return { webContents: { id, send: vi.fn() } };
}

describe("broadcastWorkspaceActivity", () => {
  it("delivers a scoped event only to windows with that workspace active", () => {
    const onA = fakeWindow(1);
    const onB = fakeWindow(2);
    const onNone = fakeWindow(3);
    const active = new Map([
      [1, "ws-a"],
      [2, "ws-b"],
    ]);

    broadcastWorkspaceActivity({
      windows: [onA, onB, onNone],
      activeWorkspaceIdOf: (id) => active.get(id),
      channel: "desktop:workspace-activity",
      scope: { workspaceId: "ws-a", paths: ["notes/a.md"] },
    });

    expect(onA.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "desktop:workspace-activity",
      { workspaceId: "ws-a", paths: ["notes/a.md"] },
    );
    // The pin this change exists for: workspace B's window hears nothing
    // about workspace A, and neither does a window with no workspace open.
    expect(onB.webContents.send).not.toHaveBeenCalled();
    expect(onNone.webContents.send).not.toHaveBeenCalled();
  });

  it("delivers a global event to every window, workspace or not", () => {
    const onA = fakeWindow(1);
    const onNone = fakeWindow(2);

    broadcastWorkspaceActivity({
      windows: [onA, onNone],
      activeWorkspaceIdOf: (id) => (id === 1 ? "ws-a" : undefined),
      channel: "desktop:workspace-activity",
    });

    expect(onA.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "desktop:workspace-activity",
      {},
    );
    expect(onNone.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "desktop:workspace-activity",
      {},
    );
  });
});

describe("workspaceActivityPayload", () => {
  it("omits paths when the hint is empty or exceeds the daemon's cap", () => {
    expect(workspaceActivityPayload({ workspaceId: "ws", paths: [] })).toEqual({
      workspaceId: "ws",
    });
    const oversized = Array.from({ length: 33 }, (_, index) => `file-${index}`);
    expect(
      workspaceActivityPayload({ workspaceId: "ws", paths: oversized }),
    ).toEqual({ workspaceId: "ws" });
  });

  it("maps no scope to the empty global payload", () => {
    expect(workspaceActivityPayload()).toEqual({});
  });
});
