import { describe, expect, it, vi } from "vitest";
import { invokeRegisteredPluginCommand } from "./pluginCommandInvocation";

const input = {
  workspaceId: "ws-plugins",
  pluginId: "hello-plugin",
  commandId: "hello.write",
};

describe("invokeRegisteredPluginCommand", () => {
  it("invokes a declared, registered plugin command", async () => {
    const invokeCommand = vi.fn(async () => ({ written: "hello.txt" }));
    const host = {
      getSpawnId: vi.fn(() => "spawn-1"),
      invokeCommand,
    };
    const ensureStarted = vi.fn(async () => host);

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        ensureStarted,
      }),
    ).resolves.toEqual({ status: "ok" });
    expect(ensureStarted).toHaveBeenCalledWith();
    expect(invokeCommand).toHaveBeenCalledWith("hello-plugin", "hello.write");
  });

  it("returns command-not-declared without starting or invoking the plugin", async () => {
    const invokeCommand = vi.fn(async () => null);
    const ensureStarted = vi.fn(async () => ({
      getSpawnId: vi.fn(() => "spawn-1"),
      invokeCommand,
    }));

    await expect(
      invokeRegisteredPluginCommand({
        input: { ...input, commandId: "hello.missing" },
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        ensureStarted,
      }),
    ).resolves.toEqual({
      status: "command-not-declared",
      message: 'Plugin "hello-plugin" does not declare command "hello.missing".',
    });
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("reports a start failure without invoking the plugin", async () => {
    const invokeCommand = vi.fn(async () => null);
    const ensureStarted = vi.fn(async () => {
      throw new Error("Plugin build failed.");
    });

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        ensureStarted,
      }),
    ).resolves.toEqual({
      status: "command-failed",
      message: "Plugin build failed.",
    });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("cancels after a successful start when the renderer changed", async () => {
    const invokeCommand = vi.fn(async () => null);
    const host = {
      getSpawnId: vi.fn(() => "spawn-1"),
      invokeCommand,
    };
    const ensureCurrent = vi.fn(() => {
      throw new Error(
        "The plugin command request was cancelled because the renderer changed.",
      );
    });

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        ensureStarted: async () => host,
        ensureCurrent,
      }),
    ).resolves.toEqual({
      status: "command-failed",
      message:
        "The plugin command request was cancelled because the renderer changed.",
    });
    expect(ensureCurrent).toHaveBeenCalledWith();
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("reports a started plugin with no live process", async () => {
    const invokeCommand = vi.fn(async () => null);
    const ensureStarted = vi.fn(async () => ({
      getSpawnId: vi.fn(() => undefined),
      invokeCommand,
    }));

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        ensureStarted,
      }),
    ).resolves.toEqual({
      status: "plugin-not-running",
      message: 'Plugin "hello-plugin" has no active process.',
    });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("reports a command invocation failure", async () => {
    const invokeCommand = vi.fn(async () => {
      throw new Error("Command handler failed.");
    });
    const ensureStarted = vi.fn(async () => ({
      getSpawnId: vi.fn(() => "spawn-1"),
      invokeCommand,
    }));

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        ensureStarted,
      }),
    ).resolves.toEqual({
      status: "command-failed",
      message: "Command handler failed.",
    });
    expect(invokeCommand).toHaveBeenCalledWith("hello-plugin", "hello.write");
  });
});
