// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import type { DohcDesktopBridge } from "./ipc/bridgeContract";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn<(name: string, api: unknown) => void>() },
  ipcRenderer: {
    on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
    removeListener: vi.fn(),
    invoke: vi.fn(async () => undefined),
  },
  webUtils: {},
}));
vi.mock("electron", () => electron);

it("holds menu commands that arrive before anything listens, as when the command opened the window", async () => {
  await import("./preload");
  const bridge = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === "dohcDesktop")![1] as DohcDesktopBridge;
  const send = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === CHANNELS.menuCommand)![1];

  send({}, "settings");
  send({}, "not-a-command");
  const first = vi.fn();
  const stop = bridge.onMenuCommand(first);
  expect(first.mock.calls).toEqual([["settings"]]);

  // A listener present takes each command as it arrives; nothing is held.
  send({}, "new-file");
  const second = vi.fn();
  bridge.onMenuCommand(second);
  expect(first.mock.calls).toEqual([["settings"], ["new-file"]]);
  expect(second).not.toHaveBeenCalled();

  stop();
  send({}, "close-tab");
  expect(first).toHaveBeenCalledTimes(2);
  expect(second.mock.calls).toEqual([["close-tab"]]);
});
