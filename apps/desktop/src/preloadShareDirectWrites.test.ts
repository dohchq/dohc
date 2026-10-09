// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import { ShareDirectWritesSubscription, type DohcDesktopBridge } from "./ipc/bridgeContract";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn<(name: string, api: unknown) => void>() },
  ipcRenderer: {
    on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
    removeListener: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
    invoke: vi.fn(async (_channel: string, _payload: unknown) => undefined),
  },
  webUtils: {},
}));
vi.mock("electron", () => electron);

it("registers the listener before announcing its workspace, and removes only that subscription on close", async () => {
  await import("./preload");
  const bridge = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === "dohcDesktop")![1] as DohcDesktopBridge;
  const listener = vi.fn();
  const close = bridge.onShareDirectWritesPushed(listener, "share");
  expect(electron.ipcRenderer.on).toHaveBeenCalledWith(CHANNELS.shareDirectWritesPushed, expect.any(Function));
  expect(electron.ipcRenderer.on.mock.invocationCallOrder[0]!).toBeLessThan(electron.ipcRenderer.invoke.mock.invocationCallOrder[0]!);
  const input = electron.ipcRenderer.invoke.mock.calls[0]!;
  expect(input[0]).toBe(CHANNELS.shareDirectWritesPushed);
  const subscribed = ShareDirectWritesSubscription.parse(input[1]);
  expect(subscribed).toMatchObject({ workspaceId: "share", listening: true });
  const handler = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, payload: unknown) => void;
  handler({}, { workspaceId: "share", result: { status: "pushed", writes: [] } });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ workspaceId: "share", result: { status: "pushed", writes: [] } });
  close();
  expect(electron.ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(CHANNELS.shareDirectWritesPushed, handler);
  expect(electron.ipcRenderer.invoke.mock.calls[1]).toEqual([
    CHANNELS.shareDirectWritesPushed, { ...subscribed, listening: false },
  ]);
});
