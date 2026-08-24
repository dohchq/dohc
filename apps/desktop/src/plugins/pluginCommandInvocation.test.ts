import { describe, expect, it, vi } from "vitest";
import {
  invokeRegisteredPluginCommand,
  PluginClaimsDrainingError,
} from "./pluginCommandInvocation";
import type {
  PluginHostCommandAuthority,
  PluginHostCommandRunOutcome,
} from "./pluginHostOwnership";

const input = {
  workspaceId: "ws-plugins",
  pluginId: "hello-plugin",
  commandId: "hello.write",
};

const commandAuthority = {} as PluginHostCommandAuthority;
const runCommand = async <T>(
  operation: (command: PluginHostCommandAuthority) => Promise<T>,
): Promise<PluginHostCommandRunOutcome<T>> => ({
  kind: "completed",
  value: await operation(commandAuthority),
});

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
        runCommand,
        ensureStarted,
        ensureCurrent: () => {},
      }),
    ).resolves.toEqual({ status: "ok" });
    expect(ensureStarted).toHaveBeenCalledWith(commandAuthority);
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
        runCommand,
        ensureStarted,
        ensureCurrent: () => {},
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
        runCommand,
        ensureStarted,
        ensureCurrent: () => {},
      }),
    ).resolves.toEqual({
      status: "command-failed",
      message: "Plugin build failed.",
    });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("reports a command refused by an active host change as plugin-rebuilding", async () => {
    const ensureStarted = vi.fn();

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        runCommand: async () => ({
          kind: "refused",
          reason: "change-in-progress",
        }),
        ensureStarted,
        ensureCurrent: () => {},
      }),
    ).resolves.toEqual({
      status: "plugin-rebuilding",
      message:
        'dohc is still working on plugin "hello-plugin". Try the command again in a moment.',
    });
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  it("reports a command refused by closed ownership as command-failed", async () => {
    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        runCommand: async () => ({ kind: "refused", reason: "closed" }),
        ensureStarted: vi.fn(),
        ensureCurrent: () => {},
      }),
    ).resolves.toEqual({
      status: "command-failed",
      message:
        'dohc stopped plugin "hello-plugin" before it could run the command. Try again.',
    });
  });

  it("reports the retryable plugin-rebuilding status, not a generic failure, when ensureStarted rechecks the barrier and finds it raised (round-17 finding 2)", async () => {
    const ensureStarted = vi.fn(async () => {
      // Pipeline ensureStarted maps a command's self-drain refusal to this
      // typed retryable error.
      throw new PluginClaimsDrainingError("hello-plugin");
    });

    await expect(
      invokeRegisteredPluginCommand({
        input,
        plugin: {
          manifest: {
            commands: [{ id: "hello.write", title: "Write hello note" }],
          },
        },
        runCommand,
        ensureStarted,
        ensureCurrent: () => {},
      }),
    ).resolves.toEqual({
      status: "plugin-rebuilding",
      message: 'dohc is still working on plugin "hello-plugin". Try the command again in a moment.',
    });
    // ensureStarted's own throw means invokeRegisteredPluginCommand never
    // has a host to call — nothing to spy on that this test's outcome
    // does not already prove (#779 round 22 finding 10).
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
        runCommand,
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
        runCommand,
        ensureStarted,
        ensureCurrent: () => {},
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
        runCommand,
        ensureStarted,
        ensureCurrent: () => {},
      }),
    ).resolves.toEqual({
      status: "command-failed",
      message: "Command handler failed.",
    });
    expect(invokeCommand).toHaveBeenCalledWith("hello-plugin", "hello.write");
  });
});
