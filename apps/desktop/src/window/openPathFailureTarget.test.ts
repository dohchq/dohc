import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { captureOpenPathFailureTarget, whenOpenPathFailureTargetReady } from "./openPathFailureTarget";

function fixture() {
  const window = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false) });
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => true),
    getURL: vi.fn(() => ""),
  });
  return Object.assign(window, { webContents: contents });
}

function expectNoListeners(window: ReturnType<typeof fixture>) {
  expect(window.listenerCount("closed")).toBe(0);
  expect(window.webContents.listenerCount("did-finish-load")).toBe(0);
  expect(window.webContents.listenerCount("did-fail-load")).toBe(0);
  expect(window.webContents.listenerCount("destroyed")).toBe(0);
  expect(window.webContents.listenerCount("render-process-gone")).toBe(0);
}

describe("launch path failure renderer readiness", () => {
  it("accepts an already loaded renderer without waiting for another load", async () => {
    const window = fixture();
    window.webContents.getURL.mockReturnValue("file:///dohc/index.html");
    window.webContents.isLoadingMainFrame.mockReturnValue(false);
    expect(await whenOpenPathFailureTargetReady(window)).toBe(true);
    expectNoListeners(window);
  });

  it.each(["window", "contents", "crashed"])("refuses an unavailable %s", async (reason) => {
    const window = fixture();
    if (reason === "window") window.isDestroyed.mockReturnValue(true);
    if (reason === "contents") window.webContents.isDestroyed.mockReturnValue(true);
    if (reason === "crashed") window.webContents.isCrashed.mockReturnValue(true);
    expect(await whenOpenPathFailureTargetReady(window)).toBe(false);
    expectNoListeners(window);
  });

  it.each(["loaded", "closed", "failed", "destroyed", "render-process-gone"])("settles and removes listeners when %s", async (outcome) => {
    const window = fixture();
    const ready = whenOpenPathFailureTargetReady(window);
    if (outcome === "loaded") window.webContents.emit("did-finish-load");
    if (outcome === "closed") window.emit("closed");
    if (outcome === "destroyed" || outcome === "render-process-gone") window.webContents.emit(outcome);
    if (outcome === "failed") window.webContents.emit("did-fail-load", {}, -2, "failed", "", true);
    expect(await ready).toBe(outcome === "loaded");
    expectNoListeners(window);
  });

  it("waits for the replacement navigation after an aborted load and ignores subframes", async () => {
    const window = fixture();
    const ready = whenOpenPathFailureTargetReady(window);
    window.webContents.emit("did-fail-load", {}, -3, "aborted", "", true);
    window.webContents.emit("did-fail-load", {}, -2, "failed", "", false);
    expect(window.webContents.listenerCount("did-finish-load")).toBe(1);
    window.webContents.emit("did-finish-load");
    expect(await ready).toBe(true);
    expectNoListeners(window);
  });
});

describe("launch path failure target context", () => {
  it("keeps the original context and allows its own successful open", () => {
    const window = fixture();
    window.webContents.getURL.mockReturnValue("file:///dohc/index.html");
    window.webContents.isLoadingMainFrame.mockReturnValue(false);
    let session = { workspaceId: "original" };
    const target = captureOpenPathFailureTarget(window, { isLive: () => true, currentSession: () => session, admittedCount: () => 1 });
    expect(target.isCurrent()).toBe(true);
    session = { workspaceId: "opened" };
    expect(target.isCurrent()).toBe(false);
    expect(target.isCurrent({ workspaceId: "opened" })).toBe(true);
    session = { workspaceId: "unrelated" };
    expect(target.isCurrent({ workspaceId: "opened" })).toBe(false);
  });

  it("keeps a window that had no workspace and then opened its first, but not its second", () => {
    const window = fixture();
    let session: { workspaceId: string } | undefined;
    let admitted = 0;
    const target = captureOpenPathFailureTarget(window, {
      isLive: () => true, currentSession: () => session, admittedCount: () => admitted,
    });
    expect(target.isCurrent(null)).toBe(true);
    // The starting window opens the first workspace it lists while the
    // launch path is still opening, and the launch path then fails.
    session = { workspaceId: "first-listed" };
    admitted = 1;
    expect(target.isCurrent(null)).toBe(true);
    session = { workspaceId: "switched-to" };
    admitted = 2;
    expect(target.isCurrent(null)).toBe(false);
  });

  it.each(["closed", "contents-destroyed", "crashed", "untracked"])("rejects a %s target even after its own successful open", (state) => {
    const window = fixture();
    window.webContents.getURL.mockReturnValue("file:///dohc/index.html");
    window.webContents.isLoadingMainFrame.mockReturnValue(false);
    let live = true;
    const target = captureOpenPathFailureTarget(window, {
      isLive: () => live, currentSession: () => ({ workspaceId: "opened" }), admittedCount: () => 1,
    });
    if (state === "closed") window.isDestroyed.mockReturnValue(true);
    if (state === "contents-destroyed") window.webContents.isDestroyed.mockReturnValue(true);
    if (state === "crashed") window.webContents.isCrashed.mockReturnValue(true);
    if (state === "untracked") live = false;
    expect(target.isCurrent({ workspaceId: "opened" })).toBe(false);
  });
});
