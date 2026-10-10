import { describe, expect, it, vi } from "vitest";
import { broadcastWorkspaceActivity, coalesceWorkspaceActivity } from "./workspaceActivityBroadcast";
import { CHANNELS } from "./channels";

function fakeWindow(id: number) {
  return { webContents: { id, send: vi.fn() } };
}

describe("broadcastWorkspaceActivity", () => {
  it.each([true, false])("preserves a summary change beside file activity (summary first: %s)", async summaryFirst => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const notify = coalesceWorkspaceActivity(send);
      const summary = { workspaceId: "ws-a", summaryChanged: true as const };
      const file = { workspaceId: "ws-a", paths: ["note.md"] };
      notify(summaryFirst ? summary : file);
      notify(summaryFirst ? file : summary);
      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenCalledExactlyOnceWith(summary);
      const win = fakeWindow(1);
      broadcastWorkspaceActivity({ windows: [win], activeWorkspaceIdOf: () => "ws-a", scope: summary });
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith(CHANNELS.workspaceActivity, summary);
    } finally { vi.useRealTimers(); }
  });
  it.each([true, false])("keeps pathless activity broad in either order (broad first: %s)", async captureFirst => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const notify = coalesceWorkspaceActivity(send);
      const capture = { workspaceId: "ws-a", pathSetChanged: false };
      const observation = { ...capture, paths: ["note.md"] };
      notify(captureFirst ? capture : observation);
      notify(captureFirst ? observation : capture);
      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenCalledExactlyOnceWith(capture);
      notify({ ...capture, paths: Array.from({ length: 40 }, (_, n) => `${n}.md`) });
      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenLastCalledWith(capture);
    } finally { vi.useRealTimers(); }
  });
  it.each([true, false])("coalesces capture path hints in either order (capture first: %s)", async captureFirst => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const notify = coalesceWorkspaceActivity(send);
      const capture = { workspaceId: "ws-a", pathSetChanged: false, paths: ["captured.md"] };
      const observation = { ...capture, paths: ["observed.md"] };
      notify(captureFirst ? capture : observation);
      notify(captureFirst ? observation : capture);
      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a", pathSetChanged: false,
        paths: captureFirst ? ["captured.md", "observed.md"] : ["observed.md", "captured.md"] });
    } finally { vi.useRealTimers(); }
  });
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
