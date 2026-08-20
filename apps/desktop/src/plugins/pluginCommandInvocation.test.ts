import { describe, expect, it, vi } from "vitest";
import { invokeRegisteredPluginCommand } from "./pluginCommandInvocation";

const input = {
  workspaceId: "ws-plugins",
  pluginId: "hello-plugin",
  commandId: "hello.write",
};

describe("invokeRegisteredPluginCommand", () => {
  it("returns the result from a declared, registered plugin command", async () => {
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
    ).resolves.toEqual({
      status: "ok",
      result: { written: "hello.txt" },
    });
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
});
