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
  focused = false;
  webContents = Object.assign(new EventEmitter(), {
    destroyed: false,
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDestroyed() { return this.destroyed; },
  });
  isFullScreen() { return this.fullScreen; }
  isFocused() { return this.focused; }
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

// What a window told its renderer on one channel.
const sentOn = (window: TestWindow, channel: string) =>
  window.webContents.send.mock.calls.filter(([sent]) => sent === channel);

describe("main-window full-screen state", () => {
  it("tells only its own renderer on each load and each change", () => {
    const window = createMainWindow() as unknown as TestWindow;
    const other = createMainWindow() as unknown as TestWindow;
    const sent = () => sentOn(window, CHANNELS.windowFullScreen);

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
    expect(sentOn(window, CHANNELS.windowFullScreen)).toEqual([[CHANNELS.windowFullScreen, { fullScreen: true }]]);
  });

  it("sends nothing once its renderer is gone", () => {
    const window = createMainWindow() as unknown as TestWindow;
    window.webContents.destroyed = true;
    window.emit("leave-full-screen");
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});

describe("main-window focus", () => {
  it("tells only its own renderer on each load and each change", () => {
    const window = createMainWindow() as unknown as TestWindow;
    const other = createMainWindow() as unknown as TestWindow;
    const sent = () => sentOn(window, CHANNELS.windowFocused);

    window.webContents.emit("dom-ready");
    window.focused = true;
    window.emit("focus");
    // A reload while focused starts from the current state.
    window.webContents.emit("dom-ready");
    window.focused = false;
    window.emit("blur");

    expect(sent()).toEqual([
      [CHANNELS.windowFocused, { focused: false }],
      [CHANNELS.windowFocused, { focused: true }],
      [CHANNELS.windowFocused, { focused: true }],
      [CHANNELS.windowFocused, { focused: false }],
    ]);
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it("starts a window that opens focused as focused", () => {
    const window = createMainWindow() as unknown as TestWindow;
    window.focused = true;
    window.webContents.emit("dom-ready");
    expect(sentOn(window, CHANNELS.windowFocused)).toEqual([[CHANNELS.windowFocused, { focused: true }]]);
  });

  it("sends nothing once its renderer is gone", () => {
    const window = createMainWindow() as unknown as TestWindow;
    window.webContents.destroyed = true;
    window.emit("blur");
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
