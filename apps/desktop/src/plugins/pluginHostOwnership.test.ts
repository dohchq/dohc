import { describe, expect, it, vi } from "vitest";
import {
  PluginHostOwnership,
  type OwnedPluginHost,
  type PluginHostCommandLease,
  type PluginHostStopOpportunity,
} from "./pluginHostOwnership";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakePluginHost implements OwnedPluginHost {
  readonly running = new Set<string>();
  readonly calls: string[] = [];
  stopImpl: (pluginId: string) => Promise<void> = async (pluginId) => {
    this.running.delete(pluginId);
  };
  stopAllImpl: () => Promise<void> = async () => {
    this.running.clear();
  };

  isRunning(pluginId: string): boolean {
    return this.running.has(pluginId);
  }

  async stop(pluginId: string): Promise<void> {
    this.calls.push(`stop:${pluginId}`);
    await this.stopImpl(pluginId);
  }

  bumpGeneration(): void {
    this.calls.push("bump-generation");
  }

  async stopAll(): Promise<void> {
    this.calls.push("stop-all");
    await this.stopAllImpl();
  }
}

function commandLease(
  owner: PluginHostOwnership,
  pluginId = "example-plugin",
): PluginHostCommandLease {
  const result = owner.claimCommand(pluginId);
  if ("kind" in result) {
    throw new Error(`Expected a command lease, received ${result.reason}`);
  }
  return result;
}

async function coldStart(lease: PluginHostCommandLease): Promise<void> {
  await expect(
    lease.start(async () => ({ value: undefined, startedHost: true })),
  ).resolves.toEqual({ kind: "admitted", value: undefined });
}

function stopOpportunity(
  opportunity: PluginHostStopOpportunity | null,
): PluginHostStopOpportunity {
  if (!opportunity) throw new Error("Expected a stop opportunity");
  return opportunity;
}

describe("PluginHostOwnership", () => {
  it("raises change admission in the same turn", () => {
    const owner = new PluginHostOwnership(new FakePluginHost());

    owner.beginChange("example-plugin");

    expect(owner.claimCommand("example-plugin")).toEqual({
      kind: "refused",
      reason: "change-in-progress",
    });
  });

  it("keeps nested change holds closed until the final release", () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const outer = owner.beginChange("example-plugin");
    const inner = owner.beginChange("example-plugin");

    inner.release();
    expect(owner.claimCommand("example-plugin")).toEqual({
      kind: "refused",
      reason: "change-in-progress",
    });

    outer.release();
    expect("kind" in owner.claimCommand("example-plugin")).toBe(false);
  });

  it("drains the command snapshot before stopping and admits no joiner", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const first = commandLease(owner);
    const second = commandLease(owner);
    const change = owner.beginChange("example-plugin");

    const stopped = change.stop();
    expect(owner.claimCommand("example-plugin")).toEqual({
      kind: "refused",
      reason: "change-in-progress",
    });
    first.release();
    await Promise.resolve();
    expect(host.calls).not.toContain("stop:example-plugin");

    second.release();
    await expect(stopped).resolves.toEqual({
      kind: "stopped",
      drained: true,
    });
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("does the final start check and enqueue in one synchronous step", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const lease = commandLease(owner);
    const change = owner.beginChange("example-plugin");
    let enqueued = false;

    const refused = lease.start(async () => {
      enqueued = true;
      return { value: "started", startedHost: false };
    });

    expect(enqueued).toBe(false);
    await expect(refused).resolves.toEqual({
      kind: "refused",
      reason: "change-in-progress",
    });
    change.release();

    const admitted = lease.start(async () => {
      enqueued = true;
      return { value: "started", startedHost: false };
    });
    expect(enqueued).toBe(true);
    await expect(admitted).resolves.toEqual({
      kind: "admitted",
      value: "started",
    });
  });

  it("refuses a command-originated change from draining its own live lease", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const command = commandLease(owner);
    const change = owner.beginChange("example-plugin", command);

    await expect(change.stop()).resolves.toEqual({
      kind: "refused",
      reason: "self-drain",
    });
    expect(host.calls).toEqual([]);
    expect(owner.claimCommand("example-plugin")).toEqual({
      kind: "refused",
      reason: "change-in-progress",
    });

    change.release();
    command.release();
  });

  it("stops at the drain deadline but refuses admission until the late lease releases", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      host.running.add("example-plugin");
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      const command = commandLease(owner);
      const change = owner.beginChange("example-plugin");
      const stopped = change.stop();

      await vi.advanceTimersByTimeAsync(25);
      await expect(stopped).resolves.toEqual({
        kind: "stopped",
        drained: false,
      });
      change.release();

      expect(owner.claimCommand("example-plugin")).toEqual({
        kind: "refused",
        reason: "change-in-progress",
      });
      command.release();
      expect("kind" in owner.claimCommand("example-plugin")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not make a timed-out lease pay the drain deadline twice", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      host.running.add("example-plugin");
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      const command = commandLease(owner);
      const firstChange = owner.beginChange("example-plugin");
      const firstStop = firstChange.stop();
      await vi.advanceTimersByTimeAsync(25);
      await firstStop;
      firstChange.release();

      host.running.add("example-plugin");
      const secondChange = owner.beginChange("example-plugin");
      await expect(secondChange.stop()).resolves.toEqual({
        kind: "stopped",
        drained: true,
      });
      command.release();
      secondChange.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes command and change release idempotent", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const command = commandLease(owner);
    await coldStart(command);

    const firstOpportunity = command.release();
    expect(firstOpportunity).not.toBeNull();
    expect(command.release()).toBeNull();

    const change = owner.beginChange("example-plugin");
    change.adopt();
    expect(change.release()).toBeNull();
    expect(change.release()).toBeNull();
  });

  it("offers an on-demand stop only after the last overlapping command releases", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const first = commandLease(owner);
    const second = commandLease(owner);
    await coldStart(first);

    expect(first.release()).toBeNull();
    const opportunity = stopOpportunity(second.release());

    await expect(owner.stopUnclaimed(opportunity)).resolves.toEqual({
      kind: "stopped",
    });
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("does not let a late epoch opportunity stop a replacement host", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const first = commandLease(owner);
    await coldStart(first);
    const oldOpportunity = stopOpportunity(first.release());

    const replacement = owner.beginChange("example-plugin");
    await replacement.stop();
    replacement.release();
    host.running.add("example-plugin");
    const second = commandLease(owner);
    await coldStart(second);
    const currentOpportunity = stopOpportunity(second.release());
    host.calls.length = 0;

    await expect(owner.stopUnclaimed(oldOpportunity)).resolves.toEqual({
      kind: "superseded",
    });
    await expect(owner.stopUnclaimed(currentOpportunity)).resolves.toEqual({
      kind: "stopped",
    });
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("does not let a command lease released after a timed-out stop claim the replacement epoch", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      host.running.add("example-plugin");
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      const oldCommand = commandLease(owner);
      await coldStart(oldCommand);
      const change = owner.beginChange("example-plugin");
      const stopped = change.stop();

      await vi.advanceTimersByTimeAsync(25);
      await stopped;
      change.release();
      expect(oldCommand.release()).toBeNull();

      host.running.add("example-plugin");
      const replacement = commandLease(owner);
      await coldStart(replacement);
      expect(replacement.release()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves on-demand ownership across a no-op change", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const command = commandLease(owner);
    await coldStart(command);
    const change = owner.beginChange("example-plugin");

    expect(command.release()).toBeNull();
    expect(change.release()).not.toBeNull();
  });

  it("clears on-demand ownership when a change adopts the host", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const command = commandLease(owner);
    await coldStart(command);
    const change = owner.beginChange("example-plugin");

    change.adopt();
    expect(command.release()).toBeNull();
    expect(change.release()).toBeNull();
  });

  it("does not let a late start result reclaim an epoch already adopted by its change", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const command = commandLease(owner);

    await expect(
      command.start(async () => {
        const change = owner.beginChange("example-plugin", command);
        change.adopt();
        change.release();
        return { value: undefined, startedHost: true };
      }),
    ).resolves.toEqual({ kind: "admitted", value: undefined });

    expect(command.release()).toBeNull();
  });

  it("advances the epoch when stop rejects after the host record disappears", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const command = commandLease(owner);
    await coldStart(command);
    const oldOpportunity = stopOpportunity(command.release());
    const stopError = new Error("dispose failed after shutdown");
    host.stopImpl = async (pluginId) => {
      host.running.delete(pluginId);
      throw stopError;
    };
    const change = owner.beginChange("example-plugin");

    await expect(change.stop()).resolves.toMatchObject({
      kind: "stopped",
      drained: true,
      stopError,
    });
    change.release();
    await expect(owner.stopUnclaimed(oldOpportunity)).resolves.toEqual({
      kind: "superseded",
    });
  });

  it("keeps the epoch and ownership when stop rejects with a live record", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const command = commandLease(owner);
    await coldStart(command);
    const opportunity = stopOpportunity(command.release());
    const stopError = new Error("stop failed before record removal");
    host.stopImpl = async () => {
      throw stopError;
    };
    const change = owner.beginChange("example-plugin");

    await expect(change.stop()).rejects.toBe(stopError);
    change.release();
    host.stopImpl = async (pluginId) => {
      host.running.delete(pluginId);
    };
    await expect(owner.stopUnclaimed(opportunity)).resolves.toEqual({
      kind: "stopped",
    });
  });

  it("keeps a failed unclaimed-stop opportunity reusable while the record remains live", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const command = commandLease(owner);
    await coldStart(command);
    const opportunity = stopOpportunity(command.release());
    const stopError = new Error("still running");
    host.stopImpl = async () => {
      throw stopError;
    };

    await expect(owner.stopUnclaimed(opportunity)).resolves.toEqual({
      kind: "failed",
      error: stopError,
    });
    host.stopImpl = async (pluginId) => {
      host.running.delete(pluginId);
    };
    await expect(owner.stopUnclaimed(opportunity)).resolves.toEqual({
      kind: "stopped",
    });
  });

  it("isolates the same plugin id in two workspace owners", async () => {
    const firstHost = new FakePluginHost();
    const secondHost = new FakePluginHost();
    firstHost.running.add("example-plugin");
    secondHost.running.add("example-plugin");
    const firstOwner = new PluginHostOwnership(firstHost);
    const secondOwner = new PluginHostOwnership(secondHost);
    const firstCommand = commandLease(firstOwner);
    await coldStart(firstCommand);
    const firstOpportunity = stopOpportunity(firstCommand.release());
    firstOwner.beginChange("example-plugin");

    expect("kind" in secondOwner.claimCommand("example-plugin")).toBe(false);
    await expect(
      secondOwner.stopUnclaimed(firstOpportunity),
    ).resolves.toEqual({ kind: "superseded" });
    expect(secondHost.calls).toEqual([]);
  });

  it("closes admission synchronously, drains leases, stops all, and resets stale leases", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const command = commandLease(owner);
    const close = owner.close();

    expect(owner.claimCommand("example-plugin")).toEqual({
      kind: "refused",
      reason: "closed",
    });
    expect(() => owner.beginChange("example-plugin")).toThrow(
      /ownership is closed/i,
    );
    await Promise.resolve();
    expect(host.calls).toEqual([]);

    command.release();
    await close;
    expect(host.calls).toEqual(["bump-generation", "stop-all"]);
    expect(command.release()).toBeNull();
    await expect(
      command.start(async () => ({ value: undefined, startedHost: false })),
    ).resolves.toEqual({ kind: "refused", reason: "closed" });
  });

  it("lets close proceed at its deadline when a lease never releases", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      commandLease(owner);
      const close = owner.close();

      await vi.advanceTimersByTimeAsync(25);
      await close;
      expect(host.calls).toEqual(["bump-generation", "stop-all"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks a newly claimed command behind an in-flight unclaimed stop", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const stopped = deferred<void>();
    host.stopImpl = () => stopped.promise;
    const owner = new PluginHostOwnership(host);
    const first = commandLease(owner);
    await coldStart(first);
    const opportunity = stopOpportunity(first.release());
    const stop = owner.stopUnclaimed(opportunity);
    const second = commandLease(owner);
    let enqueued = false;

    const start = second.start(async () => {
      enqueued = true;
      host.running.add("example-plugin");
      return { value: "replacement", startedHost: true };
    });
    expect(enqueued).toBe(false);

    host.running.delete("example-plugin");
    stopped.resolve();
    await expect(stop).resolves.toEqual({ kind: "stopped" });
    await expect(start).resolves.toEqual({
      kind: "admitted",
      value: "replacement",
    });
    expect(enqueued).toBe(true);
    expect(second.release()).not.toBeNull();
  });

  it("publishes an unclaimed stop before the host adapter can re-enter", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const owner = new PluginHostOwnership(host);
    const first = commandLease(owner);
    await coldStart(first);
    const opportunity = stopOpportunity(first.release());
    let enqueued = false;
    let reentrantStart!: ReturnType<PluginHostCommandLease["start"]>;
    host.stopImpl = async (pluginId) => {
      const reentrant = commandLease(owner);
      reentrantStart = reentrant.start(async () => {
        enqueued = true;
        return { value: undefined, startedHost: false };
      });
      expect(enqueued).toBe(false);
      host.running.delete(pluginId);
    };

    await expect(owner.stopUnclaimed(opportunity)).resolves.toEqual({
      kind: "stopped",
    });
    await expect(reentrantStart).resolves.toEqual({
      kind: "admitted",
      value: undefined,
    });
    expect(enqueued).toBe(true);
  });

  it("serializes nested stops and supersedes the lease for the stopped epoch", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const stopped = deferred<void>();
    host.stopImpl = async (pluginId) => {
      await stopped.promise;
      host.running.delete(pluginId);
    };
    const owner = new PluginHostOwnership(host);
    const first = owner.beginChange("example-plugin");
    const second = owner.beginChange("example-plugin");

    const firstStop = first.stop();
    const secondStop = second.stop();
    await Promise.resolve();
    expect(host.calls).toEqual(["stop:example-plugin"]);

    stopped.resolve();
    await expect(firstStop).resolves.toEqual({
      kind: "stopped",
      drained: true,
    });
    await expect(secondStop).resolves.toEqual({
      kind: "superseded",
      drained: true,
    });
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("admits only one use of an opportunity while its stop is in flight", async () => {
    const host = new FakePluginHost();
    host.running.add("example-plugin");
    const stopped = deferred<void>();
    host.stopImpl = () => stopped.promise;
    const owner = new PluginHostOwnership(host);
    const command = commandLease(owner);
    await coldStart(command);
    const opportunity = stopOpportunity(command.release());

    const firstStop = owner.stopUnclaimed(opportunity);
    await expect(owner.stopUnclaimed(opportunity)).resolves.toEqual({
      kind: "superseded",
    });
    expect(host.calls).toEqual(["stop:example-plugin"]);

    host.running.delete("example-plugin");
    stopped.resolve();
    await expect(firstStop).resolves.toEqual({ kind: "stopped" });
  });
});
