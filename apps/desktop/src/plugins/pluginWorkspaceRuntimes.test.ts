import type { WatcherEvent } from "@dohc/workspace-core";
import { describe, expect, it, vi } from "vitest";
import type { PluginAgentDrivers } from "./pluginAgentDrivers";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";
import type { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";
import {
  PluginWorkspaceRuntimes,
  type PluginWorkspaceRuntimeParts,
} from "./pluginWorkspaceRuntimes";

interface TestWorkspace {
  workspaceId: string;
  rootPath: string;
}

interface TestPipeline {
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
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
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function makeParts(overrides: {
  start?: () => Promise<void>;
  dispose?: () => Promise<void>;
} = {}): TestParts {
  return {
    pipeline: {
      start: vi.fn(overrides.start ?? (async () => undefined)),
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
  };
}

function runtimeParts(parts: TestParts): PluginWorkspaceRuntimeParts {
  return {
    pipeline: parts.pipeline as unknown as PluginWorkspaceRuntimeParts["pipeline"],
    agentDrivers: parts.drivers as unknown as PluginAgentDrivers,
    workspaceEvents: parts.events as unknown as PluginWorkspaceEvents,
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

  it("keeps a stopped pending start until it settles before reopening", async () => {
    const opening = deferred();
    const harness = createHarness({
      create: () => harness.created.length === 0
        ? makeParts({ start: () => opening.promise })
        : makeParts(),
    });

    const first = harness.owner.ensure(workspace());
    const second = harness.owner.ensure(workspace());
    first.catch(() => undefined);
    second.catch(() => undefined);
    const retired = harness.owner.current("workspace-1");
    if (!retired) throw new Error("The first runtime was not published.");
    const remembered = retired.rememberPlugin(registration());

    const stopping = harness.owner.stop("workspace-1");
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
    expect(harness.created).toHaveLength(1);
    expect(reopeningSettled).toBe(false);
    expect(harness.created[0]?.pipeline.dispose).toHaveBeenCalledOnce();
    expect(harness.created[0]?.events.dispose).not.toHaveBeenCalled();
    expect(retired.registeredPlugin("example-plugin")).toBe(remembered);

    opening.reject(new Error("start aborted"));

    await expect(first).rejects.toThrow("start aborted");
    await expect(second).rejects.toThrow("start aborted");
    await expect(stopping).resolves.toBeUndefined();
    await expect(reopening).resolves.not.toBe(retired);
    expect(harness.created).toHaveLength(2);
    expect(harness.created[0]?.events.dispose).toHaveBeenCalledOnce();
    expect(retired.registeredPlugin("example-plugin")).toBeUndefined();
    expect(harness.owner.current("workspace-1")).toBeDefined();
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
