import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../ipc/channels";
import { createOldWindows } from "./oldWindows";

function window(id: number) {
  return { id, webContents: { id, isDestroyed: () => false, send: vi.fn() } };
}

// Window 1 was left showing the workspace from before Forget. Window 2 shows
// the workspace as it is open now. Window 3 shows another workspace.
function setup() {
  const before = Symbol("before Forget");
  const now = Symbol("open now");
  const elsewhere = Symbol("another workspace");
  const old = window(1);
  const reopened = window(2);
  const other = window(3);
  const windows = [old, reopened, other];
  const sessions = new Map([
    [old.webContents, { workspaceId: "workspace", attachmentId: before }],
    [reopened.webContents, { workspaceId: "workspace", attachmentId: now }],
    [other.webContents, { workspaceId: "other", attachmentId: elsewhere }],
  ]);
  const focus = vi.fn();
  let quitting = false;
  const oldWindows = createOldWindows<(typeof old)["webContents"], typeof old>({
    windows: () => windows,
    sessionOf: contents => sessions.get(contents),
    authorities: { isCurrentAttachment: (_workspaceId, attachmentId) => attachmentId !== before },
    isQuitting: () => quitting,
    focus,
  });
  return { oldWindows, windows, sessions, old, reopened, other, focus, quit: () => { quitting = true; } };
}

describe("old windows", () => {
  it("tells only a window Forget left behind about its workspace", () => {
    const { oldWindows, old, reopened, other } = setup();
    expect(oldWindows.read(old.webContents)).toEqual({ workspaceId: "workspace", openElsewhere: true });
    expect(oldWindows.read(reopened.webContents)).toBeNull();
    expect(oldWindows.read(other.webContents)).toBeNull();
  });

  it("brings the window that shows the workspace to the front and leaves the old one as it is", () => {
    const { oldWindows, old, reopened, focus } = setup();
    oldWindows.goTo(old.webContents);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith(reopened);
  });

  it("brings no window to the front when the asking window still shows its workspace", () => {
    const { oldWindows, reopened, other, focus } = setup();
    oldWindows.goTo(reopened.webContents);
    oldWindows.goTo(other.webContents);
    expect(focus).not.toHaveBeenCalled();
  });

  it("opens nothing when no other window shows the workspace", () => {
    const { oldWindows, windows, sessions, old, reopened, focus } = setup();
    sessions.delete(reopened.webContents);
    windows.splice(windows.indexOf(reopened), 1);
    expect(oldWindows.read(old.webContents)).toEqual({ workspaceId: "workspace", openElsewhere: false });
    oldWindows.goTo(old.webContents);
    expect(focus).not.toHaveBeenCalled();
  });

  it("asks only old windows to read their state again", () => {
    const { oldWindows, old, reopened, other } = setup();
    oldWindows.notify();
    expect(old.webContents.send).toHaveBeenCalledWith(CHANNELS.oldWindowStateChanged);
    expect(reopened.webContents.send).not.toHaveBeenCalled();
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it("leaves no window old while dohc quits", () => {
    const { oldWindows, old, focus, quit } = setup();
    quit();
    expect(oldWindows.read(old.webContents)).toBeNull();
    oldWindows.goTo(old.webContents);
    oldWindows.notify();
    expect(focus).not.toHaveBeenCalled();
    expect(old.webContents.send).not.toHaveBeenCalled();
  });
});
