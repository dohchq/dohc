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
    reload: vi.fn(),
  });
  show = vi.fn();
  loadFile = vi.fn();
}

function sessionOwner() {
  return new RendererWorkspaceSessionOwner<RendererWorkspaceSender>({
    retirement: {
      retireSender: () => ({
        requiredForAdmission: Promise.resolve(),
        detachedFromAdmission: Promise.resolve(),
      }),
      retireWorkspace: async () => undefined,
    },
  });
}

function sessionWindow(sessions: RendererWorkspaceSessionOwner<RendererWorkspaceSender>) {
  return createMainWindow({
    beforeRendererReload: (sender) => sessions.retireAfterCrash(sender),
    currentRendererDocumentId: (sender) => sessions.currentDocumentId(sender),
    prepareForRendererReload: (sender, documentId) => sessions.retireForReload(sender, documentId),
  }) as unknown as TestWindow;
}

function startNavigation(window: TestWindow, isMainFrame = true, isSameDocument = false) {
  window.webContents.emit("did-start-navigation", { isMainFrame, isSameDocument });
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
      currentRendererDocumentId: () => "document-1",
      prepareForRendererReload: async () => { throw failure; },
    }) as unknown as TestWindow;

    startNavigation(window);
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
  const sessions = sessionOwner();
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  await sessions.open(sender, workspace, "document-1");

  startNavigation(window);
  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  await expect(sessions.open(sender, workspace, "document-2"))
    .resolves.toMatchObject({ rendererDocumentId: "document-2" });
});

it.each(["reload", "crash"] as const)("keeps the new document open when %s recovery admits it before navigation commits", async (path) => {
  const sessions = sessionOwner();
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  await sessions.open(sender, workspace, "document-1");

  if (path === "reload") await sessions.retireForReload(sender, "document-1");
  else await sessions.retireAfterCrash(sender);
  sender.reload();
  startNavigation(window);
  const replacement = await sessions.open(sender, workspace, "document-2");
  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  expect(replacement.isCurrent()).toBe(true);
  expect(replacement.signal.aborted).toBe(false);
  expect(sessions.isWorkspaceOpen(workspace.workspaceId)).toBe(true);
  await expect(sessions.open(sender, workspace, "document-2"))
    .resolves.toBe(replacement);
});

it("admits a retried native reload open that arrived before navigation committed", async () => {
  const sessions = sessionOwner();
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  const first = await sessions.open(sender, workspace, "document-1");

  startNavigation(window);
  await expect(sessions.open(sender, workspace, "document-2"))
    .rejects.toBeInstanceOf(RendererWorkspaceOpenSupersededError);
  expect(first.isCurrent()).toBe(true);
  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  expect(first.isCurrent()).toBe(false);
  await expect(sessions.open(sender, workspace, "document-2"))
    .resolves.toMatchObject({ rendererDocumentId: "document-2" });
});

it("opens the workspace when dohc reload retires before navigation and open", async () => {
  const sessions = sessionOwner();
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  await sessions.open(sender, workspace, "document-1");

  await sessions.retireForReload(sender, "document-1");
  sender.reload();
  startNavigation(window);
  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  await expect(sessions.open(sender, workspace, "document-2"))
    .resolves.toMatchObject({ rendererDocumentId: "document-2" });
});

it.each([
  [false, false],
  [true, true],
])("does not record navigation with isMainFrame=%s and isSameDocument=%s", (isMainFrame, isSameDocument) => {
  const currentRendererDocumentId = vi.fn(() => "document-1");
  const prepareForRendererReload = vi.fn();
  const beforeRendererReload = vi.fn();
  const window = createMainWindow({
    currentRendererDocumentId, prepareForRendererReload, beforeRendererReload,
  }) as unknown as TestWindow;

  startNavigation(window, isMainFrame, isSameDocument);
  window.webContents.emit("did-navigate", {}, "file:///renderer/index.html");

  expect(currentRendererDocumentId).not.toHaveBeenCalled();
  expect(prepareForRendererReload).not.toHaveBeenCalled();
  expect(beforeRendererReload).not.toHaveBeenCalled();
});

it.each([
  [false, false],
  [true, true],
])("keeps the main-frame reload document across a start with isMainFrame=%s and isSameDocument=%s", async (isMainFrame, isSameDocument) => {
  const sessions = sessionOwner();
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  await sessions.open(sender, workspace, "document-1");

  startNavigation(window);
  startNavigation(window, isMainFrame, isSameDocument);
  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  await expect(sessions.open(sender, workspace, "document-2"))
    .resolves.toMatchObject({ rendererDocumentId: "document-2" });
});

it("replaces an uncommitted navigation record and clears it after commit", () => {
  const currentRendererDocumentId = vi.fn()
    .mockReturnValueOnce("document-1")
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce("document-2");
  const prepareForRendererReload = vi.fn(async () => true);
  const window = createMainWindow({ currentRendererDocumentId, prepareForRendererReload }) as unknown as TestWindow;

  startNavigation(window);
  window.webContents.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED");
  startNavigation(window);
  window.webContents.emit("did-navigate", {}, "file:///renderer/index.html");
  expect(prepareForRendererReload).not.toHaveBeenCalled();

  startNavigation(window);
  window.webContents.emit("did-navigate", {}, "file:///renderer/index.html");
  expect(prepareForRendererReload).toHaveBeenCalledExactlyOnceWith(window.webContents, "document-2");
  window.webContents.emit("did-navigate", {}, "file:///renderer/index.html");
  expect(prepareForRendererReload).toHaveBeenCalledOnce();
});

it("does not retire the replacement if the captured document retired before commit", async () => {
  const sessions = sessionOwner();
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  await sessions.open(sender, workspace, "document-1");
  startNavigation(window);
  await sessions.retireForReload(sender, "document-1");
  const replacement = await sessions.open(sender, workspace, "document-2");

  sender.emit("did-navigate", {}, "file:///renderer/index.html");

  expect(replacement.isCurrent()).toBe(true);
  expect(sessions.isWorkspaceOpen(workspace.workspaceId)).toBe(true);
});

it("captures the document while its workspace switch has no live session", async () => {
  const senderDrain = deferred();
  const sessions = new RendererWorkspaceSessionOwner<RendererWorkspaceSender>({
    retirement: {
      retireSender: () => ({
        requiredForAdmission: senderDrain.promise,
        detachedFromAdmission: Promise.resolve(),
      }),
      retireWorkspace: async () => undefined,
    },
  });
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  await sessions.open(sender, { workspaceId: "workspace-a", attachmentId: Symbol("a") }, "document-1");
  const workspace = { workspaceId: "workspace-b", attachmentId: Symbol("b") };
  const interrupted = sessions.open(sender, workspace, "document-1")
    .catch((error: unknown) => error);
  expect(sessions.current(sender)).toBeUndefined();

  startNavigation(window);
  sender.emit("did-navigate", {}, "file:///renderer/index.html");
  senderDrain.resolve();

  expect(await interrupted).toBeInstanceOf(RendererWorkspaceOpenSupersededError);
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
  const window = sessionWindow(sessions);
  const sender = window.webContents;
  const workspace = { workspaceId: "workspace-a", attachmentId: Symbol("a") };
  const first = await sessions.open(sender, workspace, "document-1");

  startNavigation(window);
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
