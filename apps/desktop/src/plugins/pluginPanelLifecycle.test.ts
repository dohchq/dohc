import { describe, expect, it, vi } from "vitest";
import { stopPluginPanelPreview } from "./pluginPanelLifecycle";

describe("plugin panel lifecycle", () => {
  it("clears the panel origin before its server releases the reusable port", async () => {
    const order: string[] = [];
    const clearStorageData = vi.fn(async (options: { origin: string }) => {
      order.push(`clear:${options.origin}`);
    });

    await stopPluginPanelPreview(
      {
        url: "http://127.0.0.1:49160/panel/index.html",
        stop: vi.fn(async () => {
          order.push("stop");
        }),
        releaseOrigin: vi.fn(() => {
          order.push("release");
        }),
      },
      clearStorageData,
      vi.fn(),
    );

    expect(clearStorageData).toHaveBeenCalledWith({
      origin: "http://127.0.0.1:49160",
    });
    expect(order).toEqual([
      "clear:http://127.0.0.1:49160",
      "stop",
      "release",
    ]);
  });

  it("still stops the server and releases the allowlist when storage cleanup fails", async () => {
    const stop = vi.fn(async () => undefined);
    const releaseOrigin = vi.fn();
    const clearError = new Error("storage cleanup failed");
    const onClearError = vi.fn();

    await stopPluginPanelPreview(
      { url: "http://127.0.0.1:49160/", stop, releaseOrigin },
      vi.fn(async () => {
        throw clearError;
      }),
      onClearError,
    );

    expect(onClearError).toHaveBeenCalledWith(clearError);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseOrigin).toHaveBeenCalledOnce();
  });
});
