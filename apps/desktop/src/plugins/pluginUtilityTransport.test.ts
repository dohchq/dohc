import type { UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPluginUtilityTransport } from "./pluginUtilityTransport";

vi.mock("../process/windowsSpawn", () => ({
  killProcessTreeWin32: vi.fn(async () => false),
}));

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
  pid: number | undefined;
}

function setup() {
  const child = new FakeUtilityProcess();
  const callbacks = {
    onExit: vi.fn(),
    onNotification: vi.fn(),
    onRequest: vi.fn(async () => ({ accepted: true })),
    onStderr: vi.fn(),
  };
  const transport = createPluginUtilityTransport(
    child as unknown as UtilityProcess,
    callbacks,
  );
  return { child, callbacks, transport };
}

describe("createPluginUtilityTransport", () => {
  it("sends requests and settles matching result and error responses", async () => {
    const { child, transport } = setup();
    const success = transport.request("plugin.activate", { pluginId: "hello" });
    expect(child.postMessage).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "plugin.activate",
      params: { pluginId: "hello" },
    });
    child.emit("message", { jsonrpc: "2.0", id: 1, result: { commands: [], drivers: [] } });
    await expect(success).resolves.toEqual({ commands: [], drivers: [] });

    const failure = transport.request("plugin.deactivate");
    child.emit("message", {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "deactivation failed" },
    });
    await expect(failure).rejects.toThrow(
      "Plugin host RPC -32000: deactivation failed",
    );
  });

  it("routes child requests, notifications, stderr, and exit", async () => {
    const { child, callbacks, transport } = setup();
    child.emit("message", {
      jsonrpc: "2.0",
      id: "sdk-1",
      method: "sdk.request",
      params: { method: "files.read" },
    });
    await vi.waitFor(() =>
      expect(callbacks.onRequest).toHaveBeenCalledWith("sdk.request", {
        method: "files.read",
      }),
    );
    expect(child.postMessage).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      id: "sdk-1",
      result: { accepted: true },
    });

    child.emit("message", {
      jsonrpc: "2.0",
      method: "plugin.log",
      params: { level: "info", message: "ready" },
    });
    expect(callbacks.onNotification).toHaveBeenCalledWith("plugin.log", {
      level: "info",
      message: "ready",
    });
    child.stderr.write("first line\nsecond line\n");
    await vi.waitFor(() =>
      expect(callbacks.onStderr).toHaveBeenNthCalledWith(2, "second line"),
    );

    const pending = transport.request("plugin.invokeCommand");
    child.emit("exit", 7);
    expect(callbacks.onExit).toHaveBeenCalledWith({ code: 7, signal: null });
    await expect(pending).rejects.toThrow("Plugin utility process exited (7)");
  });

  it("rejects pending requests when disposed", async () => {
    const { child, transport } = setup();
    const pending = transport.request("plugin.activate");

    await transport.dispose();

    await expect(pending).rejects.toThrow("Plugin utility transport disposed");
    expect(child.kill).not.toHaveBeenCalled();
    await expect(transport.request("plugin.activate")).rejects.toThrow(
      "Plugin utility transport is closed",
    );
  });

  it("logs the live PID when the 5000 ms descendant wait cap wins", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { child, transport } = setup();
      child.pid = 4242;

      const disposing = transport.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await disposing;

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("4242"),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("5000 ms"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
