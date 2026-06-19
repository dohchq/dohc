import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const closeMock = vi.fn(async () => undefined);

vi.mock("chokidar", () => ({
  watch: vi.fn(() => {
    const watcher = new EventEmitter() as EventEmitter & {
      close: () => Promise<void>;
    };
    watcher.close = closeMock;
    queueMicrotask(() => watcher.emit("error", new Error("init failed")));
    return watcher;
  }),
}));

import { watchWorkspaceEvents } from "./watchEvents";

describe("watchWorkspaceEvents failure paths", () => {
  afterEach(() => {
    closeMock.mockClear();
    vi.restoreAllMocks();
  });

  it("settles ready when chokidar initialization fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const watcher = watchWorkspaceEvents({ rootDir: "/tmp/dohc-init-failure" }, () => {
      throw new Error("unexpected batch");
    });

    await expect(watcher.ready).rejects.toThrow("init failed");
    watcher.stop();

    expect(closeMock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
