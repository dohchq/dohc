// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import { shareDirectWriteDeliveryOperations, ShareDirectWriteDeliveryPayload, type DohcDesktopBridge, type ShareDirectWriteAnswerDelivery } from "./ipc/bridgeContract";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn<(name: string, api: unknown) => void>() },
  ipcRenderer: {
    on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
    removeListener: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
    invoke: vi.fn(async (_channel: string, _payload: unknown) => true),
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
  expect(input[0]).toBe(shareDirectWriteDeliveryOperations.updateShareDirectWriteDelivery.channel);
  const subscribed = ShareDirectWriteDeliveryPayload.parse(input[1]);
  expect(subscribed).toMatchObject({ workspaceId: "share", listening: true });
  const handler = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, payload: unknown) => void;
  const answerId = crypto.randomUUID();
  handler({}, { answerId, workspaceId: "share", result: { status: "pushed", writes: [] } });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ answerId, workspaceId: "share", result: { status: "pushed", writes: [] } }, expect.any(Object));
  const delivery = listener.mock.calls[0]![1] as ShareDirectWriteAnswerDelivery;
  await delivery.claim();
  await delivery.acknowledge();
  expect(electron.ipcRenderer.invoke.mock.calls.slice(1).map(call => ShareDirectWriteDeliveryPayload.parse(call[1]).action)).toEqual(["claim", "acknowledge"]);
  close();
  expect(electron.ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(CHANNELS.shareDirectWritesPushed, handler);
  expect(electron.ipcRenderer.invoke.mock.calls[3]).toEqual([
    shareDirectWriteDeliveryOperations.updateShareDirectWriteDelivery.channel, { ...subscribed, listening: false },
  ]);
  handler({}, { answerId, workspaceId: "other", result: { status: "unavailable" } });
  expect(listener).toHaveBeenCalledOnce();
});
