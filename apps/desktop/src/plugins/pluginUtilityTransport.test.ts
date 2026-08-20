import type { UtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
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

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("createPluginUtilityTransport", () => {
  it.skipIf(process.platform === "win32")(
    "stops a detached heartbeat descendant on POSIX",
    async () => {
      const scratch = await createTestScratch("plugin-utility-tree-");
      const heartbeatPath = join(scratch, "heartbeat.txt");
      const grandchildPidPath = join(scratch, "grandchild.pid");
      const parentScript = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const [heartbeatPath, grandchildPidPath] = process.argv.slice(1);
        const heartbeatScript = \`
          const { appendFileSync } = require("node:fs");
          const heartbeatPath = process.argv[1];
          setInterval(() => appendFileSync(heartbeatPath, "x"), 50);
        \`;
        const grandchild = spawn(
          process.execPath,
          ["-e", heartbeatScript, "--", heartbeatPath],
          { detached: true, stdio: "ignore" },
        );
        writeFileSync(grandchildPidPath, String(grandchild.pid));
        grandchild.unref();
        setInterval(() => {}, 1_000);
      `;
      const parent = spawn(
        process.execPath,
        ["-e", parentScript, "--", heartbeatPath, grandchildPidPath],
        { stdio: "ignore" },
      );
      const transport = createPluginUtilityTransport(
        parent as unknown as UtilityProcess,
        {
          onExit: vi.fn(),
          onNotification: vi.fn(),
          onRequest: vi.fn(async () => undefined),
          onStderr: vi.fn(),
        },
      );
      let grandchildPid: number | undefined;

      try {
        await waitFor(
          async () =>
            ((await stat(heartbeatPath).catch(() => null))?.size ?? 0) >= 2,
          "Detached descendant did not write its heartbeat.",
        );
        grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));

        await transport.dispose();

        await delay(400);
        const settledSize = (await stat(heartbeatPath)).size;
        await delay(400);
        expect((await stat(heartbeatPath)).size).toBe(settledSize);
        expect(() => process.kill(grandchildPid as number, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The transport already stopped it.
          }
        }
        if (parent.pid !== undefined) {
          try {
            process.kill(parent.pid, "SIGKILL");
          } catch {
            // The transport already stopped it.
          }
        }
      }
    },
    15_000,
  );

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
