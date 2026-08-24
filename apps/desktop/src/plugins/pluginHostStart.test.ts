import { describe, expect, it, vi } from "vitest";
import {
  acquirePluginSurfaceLease,
  ensurePluginStarted,
} from "./pluginHostStart";
import { PluginHostOwnership } from "./pluginHostOwnership";
import { PluginClaimsDrainingError } from "./pluginCommandInvocation";
import type { PluginHostRecordToken } from "./PluginHost";

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownedHost() {
  return {
    currentRecord: (_pluginId: string): PluginHostRecordToken | undefined =>
      undefined,
    stop: vi.fn(async () => {}),
    stopRecord: vi.fn(async () => {}),
    bumpGeneration: vi.fn(),
    stopAll: vi.fn(async () => {}),
  };
}

describe("plugin host start", () => {
  it("returns the exact host only after activation finishes", async () => {
    const activation = deferredVoid();
    const host = {
      activationOf: vi.fn(() => activation.promise),
      marker: "exact-host",
    };
    let settled = false;
    const started = ensurePluginStarted(
      host,
      "hello-plugin",
      async () => ({ kind: "admitted", value: { ok: true } }),
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(host.activationOf).toHaveBeenCalledWith("hello-plugin");

    activation.resolve();
    await expect(started).resolves.toBe(host);
  });

  it("propagates an activation failure", async () => {
    const host = {
      activationOf: vi.fn(async () => {
        throw new Error("activation failed");
      }),
    };

    await expect(
      ensurePluginStarted(
        host,
        "hello-plugin",
        async () => ({ kind: "admitted", value: { ok: true } }),
      ),
    ).rejects.toThrow("activation failed");
  });

  it("maps an active change and a pipeline self-drain to one retryable error", async () => {
    const host = { activationOf: vi.fn() };

    await expect(
      ensurePluginStarted(
        host,
        "hello-plugin",
        async () => ({ kind: "refused", reason: "change-in-progress" }),
      ),
    ).rejects.toBeInstanceOf(PluginClaimsDrainingError);

    await expect(
      ensurePluginStarted(
        host,
        "hello-plugin",
        async () => ({
          kind: "admitted",
          value: {
            ok: false,
            error: { code: "claims-draining", message: "retry" },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PluginClaimsDrainingError);
    expect(host.activationOf).not.toHaveBeenCalled();
  });

  it("reports an action failure without activating the host", async () => {
    const host = { activationOf: vi.fn() };

    await expect(
      ensurePluginStarted(
        host,
        "hello-plugin",
        async () => ({
          kind: "admitted",
          value: { ok: false, error: { message: "approval changed" } },
        }),
      ),
    ).rejects.toThrow("approval changed");
    expect(host.activationOf).not.toHaveBeenCalled();
  });

  it("rejects a new surface after ownership closes", async () => {
    const owner = new PluginHostOwnership(ownedHost());
    await owner.close();

    expect(() => acquirePluginSurfaceLease(owner, "hello-plugin")).toThrow(
      'dohc stopped plugin "hello-plugin" before it could start. Try again.',
    );
  });
});
