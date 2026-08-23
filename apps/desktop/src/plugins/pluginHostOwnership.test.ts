import { describe, expect, it, vi } from "vitest";
import type {
  PluginHostRecordToken,
  PluginHostStartEvidence,
} from "./PluginHost";
import {
  PluginHostOwnership,
  type OwnedPluginHost,
  type PluginHostCommandAuthority,
  type PluginHostChangeReservation,
  type PluginHostSurfaceLease,
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
  readonly records = new Map<string, PluginHostRecordToken>();
  readonly calls: string[] = [];
  stopImpl: (pluginId: string) => Promise<void> = async (pluginId) => {
    this.records.delete(pluginId);
  };
  stopAllImpl: () => Promise<void> = async () => {
    this.records.clear();
  };

  currentRecord(pluginId: string): PluginHostRecordToken | undefined {
    return this.records.get(pluginId);
  }

  start(pluginId: string): PluginHostStartEvidence {
    const record = {} as PluginHostRecordToken;
    this.records.set(pluginId, record);
    return { pluginId, record } as PluginHostStartEvidence;
  }

  replace(pluginId: string): PluginHostRecordToken {
    const record = {} as PluginHostRecordToken;
    this.records.set(pluginId, record);
    return record;
  }

  async stop(pluginId: string): Promise<void> {
    this.calls.push(`stop:${pluginId}`);
    await this.stopImpl(pluginId);
  }

  async stopRecord(
    pluginId: string,
    record: PluginHostRecordToken,
  ): Promise<void> {
    this.calls.push(`stop-record:${pluginId}`);
    if (this.records.get(pluginId) !== record) return;
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

function surfaceLease(
  owner: PluginHostOwnership,
  pluginId = "example-plugin",
): PluginHostSurfaceLease {
  const result = owner.acquireSurface(pluginId);
  if ("kind" in result) {
    throw new Error(`Expected a surface lease, received ${result.reason}`);
  }
  return result;
}

function coldStart<T>(host: FakePluginHost, pluginId: string, value: T) {
  return Promise.resolve({ value, evidence: host.start(pluginId) });
}

describe("PluginHostOwnership", () => {
  it("binds a reserved change to the epoch when its queued work begins", async () => {
    const host = new FakePluginHost();
    host.start("example-plugin");
    const owner = new PluginHostOwnership(host);
    const first = owner.reserveChange("example-plugin");
    const second = owner.reserveChange("example-plugin");

    await first.run(async (change) => {
      expect(await change.stop()).toEqual({ kind: "stopped", drained: true });
      host.start("example-plugin");
      return change.preserve(undefined);
    });
    await expect(
      second.run(async (change) => change.preserve(await change.stop())),
    ).resolves.toEqual({ kind: "stopped", drained: true });

    expect(host.calls).toEqual([
      "stop:example-plugin",
      "stop:example-plugin",
    ]);
  });

  it("blocks command admission for a pending reservation and cancels once", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const reservation: PluginHostChangeReservation =
      owner.reserveChange("example-plugin");

    await expect(
      owner.runCommand("example-plugin", async () => undefined),
    ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });
    const firstCancel = reservation.cancel();
    const secondCancel = reservation.cancel();
    expect(firstCancel).toBe(secondCancel);
    await firstCancel;
    await expect(
      reservation.run(async (change) => change.preserve(undefined)),
    ).rejects.toThrow(/reservation is no longer active/i);
    await expect(
      owner.runCommand("example-plugin", async () => "ready"),
    ).resolves.toEqual({ kind: "completed", value: "ready" });
  });

  it("runs a change reservation only once", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const reservation = owner.reserveChange("example-plugin");

    await reservation.run(async (change) => change.preserve(undefined));
    await expect(
      reservation.run(async (change) => change.preserve(undefined)),
    ).rejects.toThrow(/reservation is no longer active/i);
  });

  it("parks a surface start behind a pending change reservation", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const reservation = owner.reserveChange("example-plugin");
    const surface = surfaceLease(owner);
    let began = false;
    const start = surface.start(async () => {
      began = true;
      return { value: "ready" };
    });

    await Promise.resolve();
    expect(began).toBe(false);
    await reservation.cancel();
    await expect(start).resolves.toEqual({ kind: "admitted", value: "ready" });
    await surface.release();
  });

  it("cancels a queued reservation synchronously when ownership closes", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const reservation = owner.reserveChange("example-plugin");
    const close = owner.close();
    let began = false;

    await expect(
      reservation.run(async (change) => {
        began = true;
        return change.preserve(undefined);
      }),
    ).rejects.toThrow(/reservation is no longer active/i);
    expect(began).toBe(false);
    await close;
    expect(host.calls).toEqual(["bump-generation", "stop-all"]);
  });

  it("raises change admission synchronously and composes nested holds", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const outerDone = deferred<void>();
    const innerDone = deferred<void>();
    const outer = owner.runChange("example-plugin", async (change) => {
      const inner = owner.runChange("example-plugin", async (nested) => {
        await innerDone.promise;
        return nested.preserve(undefined);
      });
      await outerDone.promise;
      await inner;
      return change.preserve(undefined);
    });

    await expect(
      owner.runCommand("example-plugin", async () => undefined),
    ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });
    outerDone.resolve();
    await Promise.resolve();
    await expect(
      owner.runCommand("example-plugin", async () => undefined),
    ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });
    innerDone.resolve();
    await outer;
    await expect(
      owner.runCommand("example-plugin", async () => "ok"),
    ).resolves.toEqual({ kind: "completed", value: "ok" });
  });

  it("drains the command snapshot before a change stops the host", async () => {
    const host = new FakePluginHost();
    host.start("example-plugin");
    const owner = new PluginHostOwnership(host);
    const commandDone = deferred<void>();
    const command = owner.runCommand("example-plugin", async () => {
      await commandDone.promise;
      return "done";
    });
    const change = owner.runChange("example-plugin", async (authority) =>
      authority.preserve(await authority.stop()),
    );

    await Promise.resolve();
    expect(host.calls).toEqual([]);
    commandDone.resolve();
    await command;
    await expect(change).resolves.toEqual({ kind: "stopped", drained: true });
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("runs a command in one scope and releases it on rejection", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const commandError = new Error("command failed");

    await expect(
      owner.runCommand("example-plugin", async () => {
        throw commandError;
      }),
    ).rejects.toBe(commandError);
    await expect(
      owner.runCommand("example-plugin", async () => "next"),
    ).resolves.toEqual({ kind: "completed", value: "next" });
  });

  it("checks admission and enqueues a command start in one synchronous step", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    let enqueued = false;

    await owner.runCommand("example-plugin", async (command) => {
      const start = command.start(async () => {
        enqueued = true;
        return { value: "started" };
      });
      expect(enqueued).toBe(true);
      await expect(start).resolves.toEqual({
        kind: "admitted",
        value: "started",
      });
    });
  });

  it("allows only one admitted start call per command authority", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const firstStart = deferred<{ value: string }>();

    await owner.runCommand("example-plugin", async (command) => {
      const first = command.start(() => firstStart.promise);
      await expect(
        command.start(async () => ({ value: "second" })),
      ).rejects.toThrow(/already been used/i);
      firstStart.resolve({ value: "first" });
      await expect(first).resolves.toEqual({
        kind: "admitted",
        value: "first",
      });
    });
  });

  it("makes command-origin authority unavoidable for a self-change", async () => {
    const host = new FakePluginHost();
    host.start("example-plugin");
    const owner = new PluginHostOwnership(host);

    const command = await owner.runCommand(
      "example-plugin",
      (authority: PluginHostCommandAuthority) =>
        authority.runChange(async (change) =>
          change.preserve(await change.stop()),
        ),
    );

    expect(command).toEqual({
      kind: "completed",
      value: { kind: "refused", reason: "self-drain" },
    });
    expect(host.calls).toEqual([]);
  });

  it("keeps command-origin authority until an unawaited nested change settles", async () => {
    const host = new FakePluginHost();
    host.start("example-plugin");
    const owner = new PluginHostOwnership(host);
    const changeGate = deferred<void>();
    let stopOutcome: unknown;
    let nested!: Promise<void>;

    const command = owner.runCommand("example-plugin", async (authority) => {
      nested = authority.runChange(async (change) => {
        await changeGate.promise;
        stopOutcome = await change.stop();
        return change.preserve(undefined);
      });
    });
    let commandSettled = false;
    void command.then(() => {
      commandSettled = true;
    });
    await Promise.resolve();
    expect(commandSettled).toBe(false);

    changeGate.resolve();
    await nested;
    await command;
    expect(stopOutcome).toEqual({ kind: "refused", reason: "self-drain" });
    expect(host.calls).toEqual([]);
  });

  it("stops at the drain deadline but refuses commands until the late scope exits", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      host.start("example-plugin");
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      const commandDone = deferred<void>();
      const command = owner.runCommand("example-plugin", async () => {
        await commandDone.promise;
      });
      const change = owner.runChange("example-plugin", async (authority) =>
        authority.preserve(await authority.stop()),
      );

      await vi.advanceTimersByTimeAsync(25);
      await expect(change).resolves.toEqual({ kind: "stopped", drained: false });
      await expect(
        owner.runCommand("example-plugin", async () => undefined),
      ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });
      commandDone.resolve();
      await command;
      await expect(
        owner.runCommand("example-plugin", async () => "late-release"),
      ).resolves.toEqual({ kind: "completed", value: "late-release" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a live surface from letting a command-started host stop", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);

    await owner.runCommand("example-plugin", async (command) =>
      command.start(() => coldStart(host, "example-plugin", "ready")),
    );
    expect(host.calls).toEqual([]);

    await surface.release();
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("parks a new command behind automatic teardown", async () => {
    const host = new FakePluginHost();
    const stopped = deferred<void>();
    host.stopImpl = async (pluginId) => {
      await stopped.promise;
      host.records.delete(pluginId);
    };
    const owner = new PluginHostOwnership(host);
    const first = owner.runCommand("example-plugin", async (command) =>
      command.start(() => coldStart(host, "example-plugin", "first")),
    );
    await vi.waitFor(() => {
      expect(host.calls).toEqual(["stop:example-plugin"]);
    });

    let secondBegan = false;
    const second = owner.runCommand("example-plugin", async () => {
      secondBegan = true;
      return "second";
    });
    expect(secondBegan).toBe(false);

    stopped.resolve();
    await first;
    await expect(second).resolves.toEqual({
      kind: "completed",
      value: "second",
    });
    expect(secondBegan).toBe(true);
  });

  it("publishes automatic teardown before the host can re-enter", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    let reentrantBegan = false;
    let reentrant!: ReturnType<PluginHostOwnership["runCommand"]>;
    host.stopImpl = async (pluginId) => {
      reentrant = owner.runCommand(pluginId, async () => {
        reentrantBegan = true;
      });
      expect(reentrantBegan).toBe(false);
      host.records.delete(pluginId);
    };

    await owner.runCommand("example-plugin", async (command) =>
      command.start(() => coldStart(host, "example-plugin", undefined)),
    );
    await reentrant;

    expect(reentrantBegan).toBe(true);
  });

  it("keeps the host until the last overlapping surface releases", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const first = surfaceLease(owner);
    const second = surfaceLease(owner);
    await first.start(() => coldStart(host, "example-plugin", undefined));

    await first.release();
    expect(host.calls).toEqual([]);
    await second.release();
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("defers an idempotent surface release until its admitted start settles", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);
    const startDone = deferred<{
      value: string;
      evidence: PluginHostStartEvidence;
    }>();
    const start = surface.start(() => startDone.promise);

    const firstRelease = surface.release();
    const secondRelease = surface.release();
    expect(firstRelease).toBe(secondRelease);
    await Promise.resolve();
    expect(host.calls).toEqual([]);

    startDone.resolve({
      value: "started",
      evidence: host.start("example-plugin"),
    });
    await expect(start).resolves.toEqual({ kind: "admitted", value: "started" });
    await firstRelease;
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("defers a surface release requested re-entrantly by its start", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);
    let release!: Promise<void>;

    const start = surface.start(async () => {
      release = surface.release();
      return {
        value: "started",
        evidence: host.start("example-plugin"),
      };
    });

    await expect(start).resolves.toEqual({ kind: "admitted", value: "started" });
    await release;
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("lets a surface start change the old runtime without draining itself", async () => {
    const host = new FakePluginHost();
    host.start("example-plugin");
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);

    await expect(
      surface.start(async (start) => {
        const stopped = await start.runChange(async (change) =>
          change.preserve(await change.stop()),
        );
        return {
          value: stopped,
          evidence: host.start("example-plugin"),
        };
      }),
    ).resolves.toEqual({
      kind: "admitted",
      value: { kind: "stopped", drained: true },
    });

    await surface.release();
    expect(host.calls).toEqual([
      "stop:example-plugin",
      "stop:example-plugin",
    ]);
  });

  it("drains another surface start while excluding the change origin", async () => {
    const host = new FakePluginHost();
    host.start("example-plugin");
    const owner = new PluginHostOwnership(host);
    const first = surfaceLease(owner);
    const second = surfaceLease(owner);
    const firstDone = deferred<{ value: undefined }>();
    const firstStart = first.start(() => firstDone.promise);
    let stopSettled = false;

    const secondStart = second.start(async (start) => {
      const stop = start.runChange(async (change) =>
        change.preserve(await change.stop()),
      );
      void stop.then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      firstDone.resolve({ value: undefined });
      return { value: await stop };
    });

    await firstStart;
    await expect(secondStart).resolves.toEqual({
      kind: "admitted",
      value: { kind: "stopped", drained: true },
    });
    await first.release();
    await second.release();
    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("allows only one start call per surface lease", async () => {
    const owner = new PluginHostOwnership(new FakePluginHost());
    const surface = surfaceLease(owner);

    await surface.start(async () => ({ value: "first" }));
    await expect(
      surface.start(async () => ({ value: "second" })),
    ).rejects.toThrow(/already been used/i);
    await surface.release();
  });

  it("ignores start evidence when the exact host record was replaced", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);
    await surface.start(async () => {
      const evidence = host.start("example-plugin");
      host.replace("example-plugin");
      return { value: undefined, evidence };
    });

    await surface.release();
    expect(host.calls).toEqual([]);
    expect(host.currentRecord("example-plugin")).toBeDefined();
  });

  it("does not stop a replacement record after accepting older start evidence", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);
    await surface.start(() => coldStart(host, "example-plugin", undefined));
    const replacement = host.replace("example-plugin");

    await surface.release();

    expect(host.calls).toEqual([]);
    expect(host.currentRecord("example-plugin")).toBe(replacement);
  });

  it("does not accept the same host start evidence twice", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const evidence = host.start("example-plugin");
    const first = surfaceLease(owner);
    const second = surfaceLease(owner);

    await first.start(async () => ({ value: undefined, evidence }));
    await second.start(async () => ({ value: undefined, evidence }));
    await first.release();
    await second.release();

    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("adopts before lowering the change hold and suppresses late start evidence", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);

    await owner.runCommand("example-plugin", async (command) =>
      command.start(async () => {
        const evidence = host.start("example-plugin");
        await command.runChange(async (change) =>
          change.adopt(undefined),
        );
        return { value: undefined, evidence };
      }),
    );

    expect(host.calls).toEqual([]);
    expect(host.currentRecord("example-plugin")).toBeDefined();
  });

  it("does not let an empty adoption claim a host record started later", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    await owner.runChange("example-plugin", async (change) =>
      change.adopt(undefined),
    );
    const surface = surfaceLease(owner);

    await surface.start(() => coldStart(host, "example-plugin", undefined));
    await surface.release();

    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("preserves on-demand ownership across a no-op change", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);
    await surface.start(() => coldStart(host, "example-plugin", undefined));

    await owner.runChange("example-plugin", async (change) =>
      change.preserve(undefined),
    );
    await surface.release();

    expect(host.calls).toEqual(["stop:example-plugin"]);
  });

  it("preserves on-demand ownership across a stopped and replaced record", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const surface = surfaceLease(owner);
    await surface.start(() => coldStart(host, "example-plugin", undefined));

    await owner.runChange("example-plugin", async (change) => {
      await change.stop();
      host.start("example-plugin");
      return change.preserve(undefined);
    });
    await surface.release();

    expect(host.calls).toEqual([
      "stop:example-plugin",
      "stop:example-plugin",
    ]);
  });

  it("advances the epoch when stop rejects after the exact record disappears", async () => {
    const host = new FakePluginHost();
    const errors: unknown[] = [];
    const owner = new PluginHostOwnership(host, {
      onCleanupError: (_pluginId, error) => errors.push(error),
    });
    const stopError = new Error("dispose failed after record removal");
    const surface = surfaceLease(owner);
    await surface.start(() => coldStart(host, "example-plugin", undefined));
    host.stopImpl = async (pluginId) => {
      host.records.delete(pluginId);
      throw stopError;
    };

    await surface.release();
    expect(errors).toEqual([stopError]);
    expect(host.currentRecord("example-plugin")).toBeUndefined();
  });

  it("does not advance ownership when stop rejects with any live record", async () => {
    const host = new FakePluginHost();
    const errors: unknown[] = [];
    const owner = new PluginHostOwnership(host, {
      onCleanupError: (_pluginId, error) => errors.push(error),
    });
    const stopError = new Error("record stayed live");
    const first = surfaceLease(owner);
    await first.start(() => coldStart(host, "example-plugin", undefined));
    host.stopImpl = async () => {
      throw stopError;
    };
    await first.release();

    expect(errors).toEqual([stopError]);
    const second = surfaceLease(owner);
    host.stopImpl = async (pluginId) => {
      host.records.delete(pluginId);
    };
    await second.release();
    expect(host.calls).toEqual(["stop:example-plugin", "stop:example-plugin"]);
  });

  it("isolates surfaces and records for the same plugin in two workspaces", async () => {
    const firstHost = new FakePluginHost();
    const secondHost = new FakePluginHost();
    const firstOwner = new PluginHostOwnership(firstHost);
    const secondOwner = new PluginHostOwnership(secondHost);
    const first = surfaceLease(firstOwner);
    const second = surfaceLease(secondOwner);
    await first.start(() => coldStart(firstHost, "example-plugin", undefined));
    await second.start(() => coldStart(secondHost, "example-plugin", undefined));

    await first.release();
    expect(firstHost.calls).toEqual(["stop:example-plugin"]);
    expect(secondHost.calls).toEqual([]);
    await second.release();
    expect(secondHost.calls).toEqual(["stop:example-plugin"]);
  });

  it("closes command admission synchronously and resets stale authorities", async () => {
    const host = new FakePluginHost();
    const owner = new PluginHostOwnership(host);
    const commandDone = deferred<void>();
    let authority!: PluginHostCommandAuthority;
    const command = owner.runCommand("example-plugin", async (current) => {
      authority = current;
      await commandDone.promise;
    });
    const close = owner.close();

    await expect(
      owner.runCommand("example-plugin", async () => undefined),
    ).resolves.toEqual({ kind: "refused", reason: "closed" });
    expect(() =>
      owner.runChange("example-plugin", async (change) =>
        change.preserve(undefined),
      )
    ).toThrow(/ownership is closed/i);

    commandDone.resolve();
    await command;
    await close;
    expect(host.calls).toEqual(["bump-generation", "stop-all"]);
    await expect(
      authority.start(async () => ({ value: undefined })),
    ).rejects.toThrow(/no longer active/i);
  });

  it("lets close proceed at its deadline when a command never exits", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      const commandDone = deferred<void>();
      const command = owner.runCommand("example-plugin", async () => {
        await commandDone.promise;
      });

      const close = owner.close();
      await vi.advanceTimersByTimeAsync(25);
      await close;

      expect(host.calls).toEqual(["bump-generation", "stop-all"]);
      commandDone.resolve();
      await command;
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an exact host record started after close reaches its deadline", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePluginHost();
      const owner = new PluginHostOwnership(host, { drainTimeoutMs: 25 });
      const startAllowed = deferred<void>();
      const command = owner.runCommand("example-plugin", async (authority) =>
        authority.start(async () => {
          await startAllowed.promise;
          return {
            value: "late",
            evidence: host.start("example-plugin"),
          };
        }),
      );
      const close = owner.close();

      await vi.advanceTimersByTimeAsync(25);
      await close;
      expect(host.calls).toEqual(["bump-generation", "stop-all"]);

      startAllowed.resolve();
      await expect(command).resolves.toEqual({
        kind: "completed",
        value: { kind: "refused", reason: "closed" },
      });
      expect(host.currentRecord("example-plugin")).toBeUndefined();
      expect(host.calls).toEqual([
        "bump-generation",
        "stop-all",
        "stop-record:example-plugin",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
