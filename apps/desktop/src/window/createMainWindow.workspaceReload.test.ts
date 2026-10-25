import { EventEmitter } from "node:events";
import { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import {
  RendererWorkspaceOpenSupersededError,
  RendererWorkspaceSessionOwner,
  type RendererWorkspaceSender,
} from "./rendererWorkspaceSessionOwner";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getAllDisplays: () => [] },
}));
vi.mock("../workspaces/WorkspaceRegistry", () => ({ stateDir: () => "/state" }));

import { createMainWindow, resetChromeThemeForTests } from "./createMainWindow";

class TestWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    id: 7,
    setWindowOpenHandler: vi.fn(),
    isDestroyed: () => false,
  });
  show = vi.fn();
  loadFile = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
  resetChromeThemeForTests({ read: () => null, write: () => undefined });
  vi.mocked(BrowserWindow).mockImplementation(function () {
    return new TestWindow() as unknown as BrowserWindow;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetChromeThemeForTests();
});

it("keeps the document admitted when navigation does not replace it", () => {
  const beforeRendererReload = vi.fn();
  const window = createMainWindow({ beforeRendererReload }) as unknown as TestWindow;

  window.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
  });
  window.webContents.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED");
  window.webContents.emit("did-navigate-in-page", {}, "file:///renderer/index.html#section");
  window.webContents.emit("did-frame-navigate", {}, "about:blank", -1, "", false);

  expect(beforeRendererReload).not.toHaveBeenCalled();
});

it("reports navigation cleanup failure without an unhandled rejection", async () => {
  const failure = new Error("cleanup failed");
  const logged = deferred();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => logged.resolve());
  try {
    const window = createMainWindow({
      beforeRendererReload: async () => { throw failure; },
    }) as unknown as TestWindow;

    window.webContents.emit("did-navigate", {}, "file:///renderer/index.html");
    await logged.promise;

    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      "[desktop] renderer navigation cleanup failed:", failure,
    );
  } finally {
    errorLog.mockRestore();
  }
});

it("opens the workspace after a native window reload", async () => {
  const sessions = new RendererWorkspaceSessionOwner<RendererWorkspaceSender>({
    retirement: {
      retireSender: () => ({
        requiredForAdmission: Promise.resolve(),
        detachedFromAdmission: Promise.resolve(),
      }),
      retireWorkspace: async () => undefined,
    },
  });
  const window = createMainWindow({
    beforeRendererReload: (sender) => sessions.retireAfterCrash(sender),
  }) as unknown as TestWindow;
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  await sessions.open(sender, workspace, "document-1");

  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  await expect(sessions.open(sender, workspace, "document-2"))
    .resolves.toMatchObject({ rendererDocumentId: "document-2" });
});

it("drains the old document and lets a retry replace an interrupted open", async () => {
  const senderDrain = deferred();
  const workspaceDrain = deferred();
  const workspaceRetiring = deferred();
  const retireSender = vi.fn(() => ({
    requiredForAdmission: senderDrain.promise,
    detachedFromAdmission: Promise.resolve(),
  }));
  const retireWorkspace = vi.fn(() => {
    workspaceRetiring.resolve();
    return workspaceDrain.promise;
  });
  const sessions = new RendererWorkspaceSessionOwner<RendererWorkspaceSender>({
    retirement: { retireSender, retireWorkspace },
  });
  const window = createMainWindow({
    beforeRendererReload: (sender) => sessions.retireAfterCrash(sender),
  }) as unknown as TestWindow;
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  const first = await sessions.open(sender, workspace, "document-1");

  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  expect(first.isCurrent()).toBe(false);
  expect(first.signal.aborted).toBe(true);
  const interrupted = sessions.open(sender, workspace, "document-2")
    .catch((error: unknown) => error);
  const retry = sessions.open(sender, workspace, "document-2");
  expect(sessions.current(sender)).toBeUndefined();
  senderDrain.resolve();
  await workspaceRetiring.promise;
  expect(sessions.current(sender)).toBeUndefined();
  workspaceDrain.resolve();

  expect(await interrupted).toBeInstanceOf(RendererWorkspaceOpenSupersededError);
  const replacement = await retry;
  expect(replacement.rendererDocumentId).toBe("document-2");
  expect(replacement.generation).toBeGreaterThan(first.generation);
  expect(replacement.isCurrent()).toBe(true);
  expect(await sessions.open(sender, workspace, "document-2")).toBe(replacement);
  await expect(sessions.open(sender, workspace, "document-1"))
    .rejects.toBeInstanceOf(RendererWorkspaceOpenSupersededError);
  expect(retireSender).toHaveBeenCalledOnce();
  expect(retireWorkspace).toHaveBeenCalledOnce();
});
