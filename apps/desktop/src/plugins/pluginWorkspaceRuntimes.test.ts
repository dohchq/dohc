import type { WatcherEvent } from "@dohc/workspace-core";
import { describe, expect, it, vi } from "vitest";
import type { PluginAgentDrivers } from "./pluginAgentDrivers";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";
import type { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";
import {
  PluginWorkspaceRuntimes,
  type PluginWorkspaceRuntimeParts,
} from "./pluginWorkspaceRuntimes";
import { deferred } from "../testing/deferred";

interface TestWorkspace {
  workspaceId: string;
  rootPath: string;
}

interface TestPipeline {
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  cancelStart: ReturnType<typeof vi.fn<() => void>>;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  handleWatcherEvents: ReturnType<
    typeof vi.fn<(events: readonly WatcherEvent[]) => Promise<void>>
  >;
  pluginRegistration: ReturnType<typeof vi.fn>;
  hasUnrecoverableFailedReplacement: ReturnType<typeof vi.fn>;
}

interface TestParts {
  pipeline: TestPipeline;
  drivers: { list: ReturnType<typeof vi.fn> };
  events: {
    dispose: ReturnType<typeof vi.fn>;
    handleWatcherEvents: ReturnType<typeof vi.fn>;
  };
  automations: { dispose: ReturnType<typeof vi.fn> };
}

function makeParts(overrides: {
  start?: () => Promise<void>;
  dispose?: () => Promise<void>;
} = {}): TestParts {
  return {
    pipeline: {
      start: vi.fn(overrides.start ?? (async () => undefined)),
      cancelStart: vi.fn(() => undefined),
      dispose: vi.fn(overrides.dispose ?? (async () => undefined)),
      handleWatcherEvents: vi.fn(async () => undefined),
      pluginRegistration: vi.fn(() => null),
      hasUnrecoverableFailedReplacement: vi.fn(() => false),
    },
    drivers: { list: vi.fn(() => []) },
    events: {
      dispose: vi.fn(() => undefined),
      handleWatcherEvents: vi.fn(() => undefined),
    },
    automations: { dispose: vi.fn(async () => undefined) },
  };
}

function runtimeParts(parts: TestParts): PluginWorkspaceRuntimeParts {
  return {
    pipeline: parts.pipeline as unknown as PluginWorkspaceRuntimeParts["pipeline"],
    agentDrivers: parts.drivers as unknown as PluginAgentDrivers,
    workspaceEvents: parts.events as unknown as PluginWorkspaceEvents,
    automations:
      parts.automations as unknown as PluginWorkspaceRuntimeParts["automations"],
  };
}

function createHarness(input: {
  create?: (
    workspace: TestWorkspace,
    hooks: { onPipelineStatus(event: PluginPipelineStatusEvent): void },
  ) => TestParts;
  isOpen?: (workspaceId: string) => boolean;
  assertWritable?: (workspace: TestWorkspace) => void;
} = {}) {
  const created: TestParts[] = [];
  const status: PluginPipelineStatusEvent[] = [];
  const registrationsSeenByStatus: Array<unknown> = [];
  const statusHooks: Array<(event: PluginPipelineStatusEvent) => void> = [];
  const cleanupErrors: unknown[] = [];
  let owner!: PluginWorkspaceRuntimes<TestWorkspace>;
  owner = new PluginWorkspaceRuntimes<TestWorkspace>({
    assertWritable: input.assertWritable ?? (() => undefined),
    isOpen: input.isOpen ?? (() => true),
    create: (workspace, hooks) => {
      statusHooks.push(hooks.onPipelineStatus);
      const parts = input.create?.(workspace, hooks) ?? makeParts();
      created.push(parts);
      return runtimeParts(parts);
    },
    onPipelineStatus: (workspaceId, event) => {
      registrationsSeenByStatus.push(
        event.kind === "removed" || event.kind === "renamed"
          ? owner.current(workspaceId)?.registeredPlugin(event.pluginId)
          : undefined,
      );
      status.push(event);
    },
    onCleanupError: (_workspaceId, error) => cleanupErrors.push(error),
  });
  return {
    cleanupErrors,
    created,
    owner,
    registrationsSeenByStatus,
    status,
    statusHooks,
  };
}

const workspace = (rootPath = "C:\\workspaces\\one"): TestWorkspace => ({
  workspaceId: "workspace-1",
  rootPath,
});

const registration = (directoryName = "example-plugin") => ({
  pluginRoot: `C:\\workspaces\\one\\plugins\\${directoryName}`,
  directoryName,
  manifest: {
    version: 1 as const,
    name: "example-plugin",
    entry: "plugin.mjs",
  },
});

describe("plugin workspace runtimes", () => {
  it("coalesces concurrent ensures into one started runtime", async () => {
    const opening = deferred();
    const harness = createHarness({
      create: () => makeParts({ start: () => opening.promise }),
    });

    const first = harness.owner.ensure(workspace());
    const second = harness.owner.ensure(workspace());

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.pipeline.start).toHaveBeenCalledOnce();
    opening.resolve();
    const [firstRuntime, secondRuntime] = await Promise.all([first, second]);
    expect(secondRuntime).toBe(firstRuntime);
  });

  it("creates a successor only after the previous runtime finishes stopping", async () => {
    const teardown = deferred();
    const harness = createHarness({
      create: () => {
        const isFirst = harness.created.length === 0;
        return makeParts({
          dispose: () => isFirst ? teardown.promise : Promise.resolve(),
        });
      },
    });
    const first = await harness.owner.ensure(workspace());

    const stopping = harness.owner.stop("workspace-1");
    const reopening = harness.owner.ensure(workspace());
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.created).toHaveLength(1);

    teardown.resolve();
    await stopping;
    const second = await reopening;
    expect(second).not.toBe(first);
    expect(harness.created).toHaveLength(2);
  });

  it("publishes stopping before surface cleanup and waits for both cleanup stages", async () => {
    const surfaceCleanup = deferred();
    const runtimeCleanup = deferred();
    const harness = createHarness({
      create: () => {
        const isFirst = harness.created.length === 0;
        return makeParts({
          dispose: () =>
            isFirst ? runtimeCleanup.promise : Promise.resolve(),
        });
      },
    });
    const first = await harness.owner.ensure(workspace());

    const stopping = harness.owner.stop(
      "workspace-1",
      () => surfaceCleanup.promise,
    );
    expect(harness.owner.current("workspace-1")).toBeUndefined();
    const reopening = harness.owner.ensure(workspace());
    let reopeningSettled = false;
    void reopening.then(
      () => {
        reopeningSettled = true;
      },
      () => {
        reopeningSettled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.created[0]?.pipeline.dispose).not.toHaveBeenCalled();
    expect(harness.created).toHaveLength(1);
    expect(reopeningSettled).toBe(false);

    surfaceCleanup.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.created).toHaveLength(1);
    expect(reopeningSettled).toBe(false);

    runtimeCleanup.resolve();
    await stopping;
    const successor = await reopening;
    expect(successor).not.toBe(first);
    expect(harness.created).toHaveLength(2);
  });

  it("retains a failed surface cleanup and blocks replacement", async () => {
    const cleanupFailure = new Error("plugin surfaces are still live");
    const harness = createHarness();
    await harness.owner.ensure(workspace());

    const stopping = harness.owner.stop(
      "workspace-1",
      async () => {
        throw cleanupFailure;
      },
    );
    const reopening = harness.owner.ensure(workspace());

    await Promise.all([
      expect(stopping).rejects.toBe(cleanupFailure),
      expect(reopening).rejects.toBe(cleanupFailure),
    ]);
    expect(harness.owner.current("workspace-1")).toBeUndefined();
    expect(harness.created[0]?.pipeline.dispose).not.toHaveBeenCalled();
    expect(harness.created).toHaveLength(1);
    await expect(harness.owner.ensure(workspace())).rejects.toBe(cleanupFailure);
    expect(harness.created).toHaveLength(1);
  });

  it("stops an in-flight warmup without waiting for startup to settle", async () => {
    const opening = deferred();
    const harness = createHarness({
      create: () => makeParts({ start: () => opening.promise }),
    });

    const warming = harness.owner.ensure(workspace());
    warming.catch(() => undefined);
    const stopping = harness.owner.stop("workspace-1");
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.created[0]?.pipeline.cancelStart).toHaveBeenCalledOnce();
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);

    opening.resolve();
    await expect(warming).rejects.toThrow(
      "Plugin pipeline closed while the workspace was opening.",
    );
  });

  it("disposes every resource owned by a cancelled warmup", async () => {
    const opening = deferred();
    const surfaceDispose = vi.fn(() => undefined);
    const harness = createHarness({
      create: () => makeParts({ start: () => opening.promise }),
    });

    const warming = harness.owner.ensure(workspace());
    warming.catch(() => undefined);
    const runtime = harness.owner.current("workspace-1");
    if (!runtime) throw new Error("The warming runtime was not published.");
    const remembered = runtime.rememberPlugin(registration());
    expect(runtime.registeredPlugin("example-plugin")).toBe(remembered);

    await harness.owner.stop("workspace-1", surfaceDispose);

    expect(surfaceDispose).toHaveBeenCalledOnce();
    expect(harness.created[0]?.pipeline.cancelStart).toHaveBeenCalledOnce();
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.created[0]?.events.dispose).toHaveBeenCalledOnce();
    expect(runtime.registeredPlugin("example-plugin")).toBeUndefined();

    opening.resolve();
    await expect(warming).rejects.toThrow(
      "Plugin pipeline closed while the workspace was opening.",
    );
  });

  it("disposes a completed warmup exactly once", async () => {
    const surfaceDispose = vi.fn(() => undefined);
    const harness = createHarness();
    const runtime = await harness.owner.ensure(workspace());
    runtime.rememberPlugin(registration());

    await harness.owner.stop("workspace-1", surfaceDispose);

    expect(surfaceDispose).toHaveBeenCalledOnce();
    expect(harness.created[0]?.pipeline.cancelStart).not.toHaveBeenCalled();
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.created[0]?.events.dispose).toHaveBeenCalledOnce();
    expect(runtime.registeredPlugin("example-plugin")).toBeUndefined();
  });

  it("starts a fresh A runtime after a cancelled A to B to A switch", async () => {
    const firstOpening = deferred();
    let workspaceOneStarts = 0;
    const harness = createHarness({
      create: (openedWorkspace) => {
        if (openedWorkspace.workspaceId !== "workspace-1") return makeParts();
        workspaceOneStarts += 1;
        return workspaceOneStarts === 1
          ? makeParts({ start: () => firstOpening.promise })
          : makeParts();
      },
    });

    const firstWarmup = harness.owner.ensure(workspace());
    firstWarmup.catch(() => undefined);
    const firstRuntime = harness.owner.current("workspace-1");
    if (!firstRuntime) throw new Error("The first A runtime was not published.");

    await harness.owner.stop("workspace-1");
    await harness.owner.ensure({
      workspaceId: "workspace-2",
      rootPath: "C:\\workspaces\\two",
    });
    const secondRuntime = await harness.owner.ensure(workspace());

    expect(secondRuntime).not.toBe(firstRuntime);
    expect(workspaceOneStarts).toBe(2);
    expect(harness.created).toHaveLength(3);
    expect(harness.created[0]?.pipeline.cancelStart).toHaveBeenCalledOnce();
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.created[2]?.pipeline.dispose).not.toHaveBeenCalled();

    firstOpening.resolve();
    await expect(firstWarmup).rejects.toThrow(
      "Plugin pipeline closed while the workspace was opening.",
    );
    expect(harness.owner.current("workspace-1")).toBe(secondRuntime);
  });

  it("publishes the stopping slot and starts disposal before stop returns", async () => {
    let callbackStop: Promise<void> | undefined;
    let currentDuringDispose: unknown;
    const harness = createHarness({
      create: () => makeParts({
        dispose: () => {
          currentDuringDispose = harness.owner.current("workspace-1");
          callbackStop = harness.owner.stop("workspace-1");
          return Promise.resolve();
        },
      }),
    });
    await harness.owner.ensure(workspace());

    const stopping = harness.owner.stop("workspace-1");

    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(currentDuringDispose).toBeUndefined();
    expect(callbackStop).toBe(stopping);
    await stopping;
  });

  it("makes repeated stops await the exact same teardown", async () => {
    const teardown = deferred();
    const harness = createHarness({
      create: () => makeParts({ dispose: () => teardown.promise }),
    });
    await harness.owner.ensure(workspace());

    const first = harness.owner.stop("workspace-1");
    const second = harness.owner.stop("workspace-1");

    expect(second).toBe(first);
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.owner.current("workspace-1")).toBeUndefined();
    teardown.resolve();
    await first;
    expect(harness.created[0]?.events.dispose).toHaveBeenCalledOnce();
  });

  it("disposes automations after the pipeline and before workspace events", async () => {
    const order: string[] = [];
    const harness = createHarness({
      create: () => {
        const parts = makeParts();
        parts.pipeline.dispose.mockImplementation(async () => {
          order.push("pipeline");
        });
        parts.automations.dispose.mockImplementation(async () => {
          order.push("automations");
        });
        parts.events.dispose.mockImplementation(() => {
          order.push("events");
        });
        return parts;
      },
    });
    await harness.owner.ensure(workspace());
    await harness.owner.stop("workspace-1");
    expect(order).toEqual(["pipeline", "automations", "events"]);
  });

  it("throws a failed automations disposal, or reports it behind a pipeline failure", async () => {
    const automationsFailure = new Error("unsubscribe refused");
    const alone = createHarness({
      create: () => {
        const parts = makeParts();
        parts.automations.dispose.mockRejectedValue(automationsFailure);
        return parts;
      },
    });
    await alone.owner.ensure(workspace());
    await expect(alone.owner.stop("workspace-1")).rejects.toBe(automationsFailure);
    expect(alone.cleanupErrors).toEqual([]);

    const pipelineFailure = new Error("plugin descendants are still live");
    const behind = createHarness({
      create: () => {
        const parts = makeParts({
          dispose: async () => {
            throw pipelineFailure;
          },
        });
        parts.automations.dispose.mockRejectedValue(automationsFailure);
        return parts;
      },
    });
    await behind.owner.ensure(workspace());
    await expect(behind.owner.stop("workspace-1")).rejects.toBe(pipelineFailure);
    expect(behind.cleanupErrors).toEqual([automationsFailure]);
  });

  it("retains a failed teardown and refuses a successor runtime", async () => {
    const cleanupFailure = new Error("plugin descendants are still live");
    const harness = createHarness({
      create: () => makeParts({
        dispose: async () => {
          throw cleanupFailure;
        },
      }),
    });
    await harness.owner.ensure(workspace());

    const stopping = harness.owner.stop("workspace-1");
    const reopening = harness.owner.ensure(workspace());
    const repeatedStop = harness.owner.stop("workspace-1");
    const closing = harness.owner.close();

    await Promise.all([
      expect(stopping).rejects.toBe(cleanupFailure),
      expect(reopening).rejects.toBe(cleanupFailure),
      expect(repeatedStop).rejects.toBe(cleanupFailure),
      expect(closing).rejects.toBe(cleanupFailure),
    ]);
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
  });

  it("stops nothing when the workspace has no runtime", async () => {
    const harness = createHarness();

    await expect(harness.owner.stop("workspace-1")).resolves.toBeUndefined();
    expect(harness.created).toHaveLength(0);
  });

  it("closes terminally and drains a teardown that was already running", async () => {
    const teardown = deferred();
    const harness = createHarness({
      create: () => makeParts({ dispose: () => teardown.promise }),
    });
    await harness.owner.ensure(workspace());
    const stopping = harness.owner.stop("workspace-1");

    const firstClose = harness.owner.close();
    const secondClose = harness.owner.close();
    expect(secondClose).toBe(firstClose);
    let closeSettled = false;
    void firstClose.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    await expect(harness.owner.ensure(workspace())).rejects.toThrow(
      "Plugins are closed. Reopen dohc and try again.",
    );

    teardown.resolve();
    await expect(Promise.all([stopping, firstClose])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("closes to new ensures before global surface cleanup settles", async () => {
    const surfaceCleanup = deferred();
    const runtimeCleanup = deferred();
    const harness = createHarness({
      create: () => makeParts({ dispose: () => runtimeCleanup.promise }),
    });
    await harness.owner.ensure(workspace());
    await harness.owner.ensure({
      workspaceId: "workspace-2",
      rootPath: "C:\\workspaces\\two",
    });
    const currentDuringCleanup: unknown[] = [];
    const closeSurfaces = vi.fn(() => {
      currentDuringCleanup.push(
        harness.owner.current("workspace-1"),
        harness.owner.current("workspace-2"),
      );
      return surfaceCleanup.promise;
    });

    const closing = harness.owner.close(closeSurfaces);
    await expect(harness.owner.ensure(workspace())).rejects.toThrow(
      "Plugins are closed. Reopen dohc and try again.",
    );
    expect(closeSurfaces).toHaveBeenCalledOnce();
    expect(currentDuringCleanup).toEqual([undefined, undefined]);
    expect(harness.owner.current("workspace-1")).toBeUndefined();
    expect(harness.created[0]?.pipeline.dispose).not.toHaveBeenCalled();
    expect(harness.created[1]?.pipeline.dispose).not.toHaveBeenCalled();

    surfaceCleanup.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.created[1]?.pipeline.dispose).toHaveBeenCalledOnce();

    runtimeCleanup.resolve();
    await expect(closing).resolves.toBeUndefined();
  });

  it("aggregates global cleanup with a teardown that was already failing", async () => {
    const sharedFailure = new Error("cleanup failed twice");
    const harness = createHarness({
      create: () => makeParts({
        dispose: async () => {
          throw sharedFailure;
        },
      }),
    });
    await harness.owner.ensure(workspace());
    const stopping = harness.owner.stop("workspace-1");
    stopping.catch(() => undefined);
    const closeSurfaces = vi.fn(async () => {
      throw sharedFailure;
    });

    try {
      await harness.owner.close(closeSurfaces);
      expect.unreachable("close should aggregate both failures");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        sharedFailure,
        sharedFailure,
      ]);
    }
    await expect(stopping).rejects.toBe(sharedFailure);
    expect(closeSurfaces).toHaveBeenCalledOnce();
  });

  it("drains every workspace when one teardown fails", async () => {
    const secondTeardown = deferred();
    const harness = createHarness({
      create: (openedWorkspace) => makeParts({
        dispose: openedWorkspace.workspaceId === "workspace-1"
          ? async () => {
              throw new Error("first cleanup failed");
            }
          : () => secondTeardown.promise,
      }),
    });
    await harness.owner.ensure(workspace());
    await harness.owner.ensure({
      workspaceId: "workspace-2",
      rootPath: "C:\\workspaces\\two",
    });

    let settled = false;
    const closing = harness.owner.close().finally(() => {
      settled = true;
    });
    closing.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    secondTeardown.resolve();
    await expect(closing).rejects.toThrow("first cleanup failed");
    expect(harness.created[1]?.events.dispose).toHaveBeenCalledOnce();
  });

  it("drains a failed start before retrying and preserves the start error", async () => {
    const teardown = deferred();
    const first = makeParts({
      start: async () => {
        throw new Error("discovery failed");
      },
      dispose: () => teardown.promise,
    });
    const second = makeParts();
    const harness = createHarness({
      create: () => harness.created.length === 0 ? first : second,
    });

    const failed = harness.owner.ensure(workspace());
    failed.catch(() => undefined);
    while (!first.pipeline.dispose.mock.calls.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const retry = harness.owner.ensure(workspace());
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.created).toHaveLength(1);

    teardown.resolve();
    await expect(failed).rejects.toThrow("discovery failed");
    await expect(retry).resolves.toBe(harness.owner.current("workspace-1"));
    expect(harness.created).toHaveLength(2);
  });

  it("keeps a failed start primary when its cleanup also fails", async () => {
    const harness = createHarness({
      create: () => makeParts({
        start: async () => {
          throw new Error("discovery failed");
        },
        dispose: async () => {
          throw new Error("cleanup failed");
        },
      }),
    });

    await expect(harness.owner.ensure(workspace())).rejects.toThrow(
      "discovery failed",
    );
    expect(harness.cleanupErrors).toEqual([
      expect.objectContaining({ message: "cleanup failed" }),
    ]);
    expect(harness.owner.current("workspace-1")).toBeUndefined();
  });

  it("publishes nothing when the factory throws", async () => {
    let attempts = 0;
    const harness = createHarness({
      create: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("factory failed");
        return makeParts();
      },
    });

    await expect(harness.owner.ensure(workspace())).rejects.toThrow(
      "factory failed",
    );
    expect(harness.owner.current("workspace-1")).toBeUndefined();
    await expect(harness.owner.ensure(workspace())).resolves.toBeDefined();
  });

  it("publishes the runtime before forwarding synchronous factory status", async () => {
    const changed: PluginPipelineStatusEvent = {
      kind: "discovery-changed",
    };
    const harness = createHarness({
      create: (_workspace, hooks) => {
        hooks.onPipelineStatus(changed);
        return makeParts();
      },
    });

    await harness.owner.ensure(workspace());

    expect(harness.registrationsSeenByStatus).toEqual([undefined]);
    expect(harness.status).toEqual([changed]);
  });

  it("isolates stale status callbacks and forgets before notifying", async () => {
    const harness = createHarness();
    const first = await harness.owner.ensure(workspace());
    first.rememberPlugin(registration("old-directory"));
    harness.statusHooks[0]?.({
      kind: "removed",
      pluginId: "example-plugin",
      directoryName: "old-directory",
    });
    expect(first.registeredPlugin("example-plugin")).toBeUndefined();
    expect(harness.registrationsSeenByStatus).toEqual([undefined]);
    expect(harness.status).toHaveLength(1);

    await harness.owner.stop("workspace-1");
    const successor = await harness.owner.ensure(workspace());
    const remembered = successor.rememberPlugin(registration("new-directory"));
    harness.statusHooks[0]?.({
      kind: "removed",
      pluginId: "example-plugin",
      directoryName: "new-directory",
    });

    expect(successor.registeredPlugin("example-plugin")).toBe(remembered);
    expect(harness.status).toHaveLength(1);
  });

  it("releases registrations only for the exact departed identity", async () => {
    const harness = createHarness();
    const runtime = await harness.owner.ensure(workspace());
    const remembered = runtime.rememberPlugin(registration());

    runtime.forgetUninstalledPlugin({
      pluginId: "example-plugin",
      directoryName: "example-plugin",
      released: false,
    });
    runtime.forgetUninstalledPlugin({
      pluginId: "example-plugin",
      directoryName: "another-directory",
      released: true,
    });
    expect(runtime.registeredPlugin("example-plugin")).toBe(remembered);

    runtime.forgetUninstalledPlugin({
      pluginId: "example-plugin",
      directoryName: "example-plugin",
      released: true,
    });
    expect(runtime.registeredPlugin("example-plugin")).toBeUndefined();
  });

  it("clears only the registrations owned by the retired workspace", async () => {
    const harness = createHarness();
    const first = await harness.owner.ensure(workspace());
    const second = await harness.owner.ensure({
      workspaceId: "workspace-2",
      rootPath: "C:\\workspaces\\two",
    });
    first.rememberPlugin(registration("first-directory"));
    const secondRegistration = second.rememberPlugin(
      registration("second-directory"),
    );

    await harness.owner.stop("workspace-1");

    expect(first.registeredPlugin("example-plugin")).toBeUndefined();
    expect(second.registeredPlugin("example-plugin")).toBe(secondRegistration);
  });

  it("rejects a second root for one live or stopping workspace identity", async () => {
    const teardown = deferred();
    const harness = createHarness({
      create: () => makeParts({ dispose: () => teardown.promise }),
    });
    await harness.owner.ensure(workspace());

    await expect(
      harness.owner.ensure(workspace("C:\\workspaces\\other")),
    ).rejects.toThrow(/already open from another folder/);
    const stopping = harness.owner.stop("workspace-1");
    await expect(
      harness.owner.ensure(workspace("C:\\workspaces\\other")),
    ).rejects.toThrow(/already open from another folder/);

    teardown.resolve();
    await stopping;
  });

  it("rechecks openness and writability after waiting for teardown", async () => {
    const teardown = deferred();
    let open = true;
    const harness = createHarness({
      create: () => makeParts({ dispose: () => teardown.promise }),
      isOpen: () => open,
    });
    await harness.owner.ensure(workspace());
    const stopping = harness.owner.stop("workspace-1");
    const stale = harness.owner.ensure(workspace());
    stale.catch(() => undefined);
    open = false;
    teardown.resolve();
    await stopping;
    await expect(stale).rejects.toThrow(/no longer open/);
    expect(harness.created).toHaveLength(1);

    const writableTeardown = deferred();
    let writable = true;
    const writableHarness = createHarness({
      create: () => makeParts({ dispose: () => writableTeardown.promise }),
      assertWritable: () => {
        if (!writable) throw new Error("The workspace is read-only.");
      },
    });
    await writableHarness.owner.ensure(workspace());
    const writableStopping = writableHarness.owner.stop("workspace-1");
    const staleWrite = writableHarness.owner.ensure(workspace());
    staleWrite.catch(() => undefined);
    writable = false;
    writableTeardown.resolve();
    await writableStopping;
    await expect(staleWrite).rejects.toThrow(
      "The workspace is read-only.",
    );
    expect(writableHarness.created).toHaveLength(1);
  });

  it("fans watcher batches to the pipeline and workspace subscriptions", async () => {
    const harness = createHarness();
    const runtime = await harness.owner.ensure(workspace());
    const events: WatcherEvent[] = [{ operation: "update", path: "README.md" }];

    runtime.handleWatcherEvents(events);

    expect(harness.created[0]?.pipeline.handleWatcherEvents)
      .toHaveBeenCalledWith(events);
    expect(harness.created[0]?.events.handleWatcherEvents)
      .toHaveBeenCalledWith(events);
    expect(runtime.agentDrivers).toBe(harness.created[0]?.drivers);
  });
});
