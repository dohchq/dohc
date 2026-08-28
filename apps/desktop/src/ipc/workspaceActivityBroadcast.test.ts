import { describe, expect, it, vi } from "vitest";
import { broadcastWorkspaceActivity } from "./workspaceActivityBroadcast";
import { CHANNELS } from "./channels";

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
      scope: { workspaceId: "ws-a", paths: ["notes/a.md"] },
    });

    expect(onA.webContents.send).toHaveBeenCalledExactlyOnceWith(
      CHANNELS.workspaceActivity,
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
    });

    expect(onA.webContents.send).toHaveBeenCalledExactlyOnceWith(
      CHANNELS.workspaceActivity,
      {},
    );
    expect(onNone.webContents.send).toHaveBeenCalledExactlyOnceWith(
      CHANNELS.workspaceActivity,
      {},
    );
  });

  it("omits the paths hint when it is empty or exceeds the daemon's cap", () => {
    const win = fakeWindow(1);
    const activeWorkspaceIdOf = () => "ws";
    broadcastWorkspaceActivity({
      windows: [win],
      activeWorkspaceIdOf,
      scope: { workspaceId: "ws", paths: [] },
    });
    const oversized = Array.from({ length: 33 }, (_, index) => `file-${index}`);
    broadcastWorkspaceActivity({
      windows: [win],
      activeWorkspaceIdOf,
      scope: { workspaceId: "ws", paths: oversized },
    });

    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    expect(win.webContents.send).toHaveBeenNthCalledWith(
      1,
      CHANNELS.workspaceActivity,
      { workspaceId: "ws" },
    );
    expect(win.webContents.send).toHaveBeenNthCalledWith(
      2,
      CHANNELS.workspaceActivity,
      { workspaceId: "ws" },
    );
  });
});
