import { EventEmitter } from "node:events";
import { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../ipc/channels";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getAllDisplays: () => [] },
}));
vi.mock("../workspaces/WorkspaceRegistry", () => ({ stateDir: () => "/state" }));

import { createMainWindow, resetChromeThemeForTests } from "./createMainWindow";

class TestWindow extends EventEmitter {
  fullScreen = false;
  webContents = Object.assign(new EventEmitter(), {
    destroyed: false,
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDestroyed() { return this.destroyed; },
  });
  isFullScreen() { return this.fullScreen; }
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

describe("main-window full-screen state", () => {
  it("tells only its own renderer on each load and each change", () => {
    const window = createMainWindow() as unknown as TestWindow;
    const other = createMainWindow() as unknown as TestWindow;
    const sent = () => window.webContents.send.mock.calls;

    window.webContents.emit("dom-ready");
    window.fullScreen = true;
    window.emit("enter-full-screen");
    // A reload while full screen starts from the current state.
    window.webContents.emit("dom-ready");
    window.fullScreen = false;
    window.emit("leave-full-screen");

    expect(sent()).toEqual([
      [CHANNELS.windowFullScreen, { fullScreen: false }],
      [CHANNELS.windowFullScreen, { fullScreen: true }],
      [CHANNELS.windowFullScreen, { fullScreen: true }],
      [CHANNELS.windowFullScreen, { fullScreen: false }],
    ]);
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it("starts a window that opens full screen in full screen", () => {
    const window = createMainWindow() as unknown as TestWindow;
    window.fullScreen = true;
    window.webContents.emit("dom-ready");
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(CHANNELS.windowFullScreen, { fullScreen: true });
  });

  it("sends nothing once its renderer is gone", () => {
    const window = createMainWindow() as unknown as TestWindow;
    window.webContents.destroyed = true;
    window.emit("leave-full-screen");
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
