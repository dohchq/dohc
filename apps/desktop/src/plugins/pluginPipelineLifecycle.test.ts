import { describe, expect, it } from "vitest";
import {
  disposeWorkspacePipeline,
  ensureWorkspacePipeline,
} from "./pluginPipelineLifecycle";

interface FakePipeline {
  id: number;
  started: boolean;
  disposed: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

describe("workspace plugin pipeline lifecycle", () => {
  it("creates one pipeline per workspace and starts an existing one again", async () => {
    const live = new Map<string, FakePipeline>();
    const disposals = new Map<string, Promise<void>>();
    let created = 0;
    const starts: number[] = [];
    const ensure = () =>
      ensureWorkspacePipeline<FakePipeline>({
        live,
        disposals,
        workspaceId: "workspace-1",
        create: () => ({ id: ++created, started: false, disposed: false }),
        start: async (pipeline) => {
          pipeline.started = true;
          starts.push(pipeline.id);
        },
        dispose: async (pipeline) => {
          pipeline.disposed = true;
        },
      });

    const first = await ensure();
    const second = await ensure();

    expect(second).toBe(first);
    expect(created).toBe(1);
    // start() memoizes its own promise, so a second caller must still await it
    // rather than observe a pipeline that has not finished starting.
    expect(starts).toEqual([1, 1]);
  });

  it("creates the next pipeline only after the previous one finished disposing (#779 round 11 A3)", async () => {
    const live = new Map<string, FakePipeline>();
    const disposals = new Map<string, Promise<void>>();
    const events: string[] = [];
    let created = 0;
    const teardown = deferred();
    const ensure = () =>
      ensureWorkspacePipeline<FakePipeline>({
        live,
        disposals,
        workspaceId: "workspace-1",
        create: () => {
          const pipeline = { id: ++created, started: false, disposed: false };
          events.push(`create ${pipeline.id}`);
          return pipeline;
        },
        start: async (pipeline) => {
          pipeline.started = true;
        },
        dispose: async (pipeline) => {
          pipeline.disposed = true;
        },
      });

    const first = await ensure();
    // A workspace switch A -> B -> A: the reopen lands while A's teardown is
    // still stopping the host and draining its queues. Both pipelines write
    // the same snapshot and bundle roots, so the second must wait.
    const stopping = disposeWorkspacePipeline<FakePipeline>({
      live,
      disposals,
      workspaceId: "workspace-1",
      dispose: async (pipeline) => {
        events.push(`dispose start ${pipeline.id}`);
        await teardown.promise;
        pipeline.disposed = true;
        events.push(`dispose end ${pipeline.id}`);
      },
    });
    const reopening = ensure();

    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["create 1", "dispose start 1"]);

    teardown.resolve();
    await stopping;
    const second = await reopening;

    expect(events).toEqual([
      "create 1",
      "dispose start 1",
      "dispose end 1",
      "create 2",
    ]);
    expect(first.disposed).toBe(true);
    expect(second).not.toBe(first);
    expect(live.get("workspace-1")).toBe(second);
    expect(disposals.size).toBe(0);
  });

  it("leaves no pipeline behind when its start fails", async () => {
    const live = new Map<string, FakePipeline>();
    const disposals = new Map<string, Promise<void>>();
    const created: FakePipeline[] = [];

    await expect(
      ensureWorkspacePipeline<FakePipeline>({
        live,
        disposals,
        workspaceId: "workspace-1",
        create: () => {
          const pipeline = {
            id: created.length + 1,
            started: false,
            disposed: false,
          };
          created.push(pipeline);
          return pipeline;
        },
        start: async () => {
          throw new Error("discovery failed");
        },
        dispose: async (pipeline) => {
          pipeline.disposed = true;
        },
      }),
    ).rejects.toThrow("discovery failed");

    expect(live.size).toBe(0);
    expect(created[0]?.disposed).toBe(true);
  });

  it("makes a retry wait for a failed create's own disposal (#779 round 15 A3)", async () => {
    const live = new Map<string, FakePipeline>();
    const disposals = new Map<string, Promise<void>>();
    const events: string[] = [];
    let created = 0;
    let failNextStart = true;
    const teardown = deferred();
    const ensure = () =>
      ensureWorkspacePipeline<FakePipeline>({
        live,
        disposals,
        workspaceId: "workspace-1",
        create: () => {
          const pipeline = { id: ++created, started: false, disposed: false };
          events.push(`create ${pipeline.id}`);
          return pipeline;
        },
        start: async (pipeline) => {
          if (failNextStart) {
            failNextStart = false;
            throw new Error("discovery failed");
          }
          pipeline.started = true;
        },
        dispose: async (pipeline) => {
          events.push(`dispose start ${pipeline.id}`);
          await teardown.promise;
          pipeline.disposed = true;
          events.push(`dispose end ${pipeline.id}`);
        },
      });

    // The failed create's own teardown drains the same userData snapshot and
    // bundle roots a second pipeline would write, so an immediate retry must
    // wait for it exactly as a workspace switch does.
    const failing = ensure();
    failing.catch(() => undefined);
    while (!events.includes("dispose start 1")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const retry = ensure();

    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["create 1", "dispose start 1"]);

    teardown.resolve();
    await expect(failing).rejects.toThrow("discovery failed");
    const second = await retry;

    expect(events).toEqual([
      "create 1",
      "dispose start 1",
      "dispose end 1",
      "create 2",
    ]);
    expect(second.started).toBe(true);
    expect(live.get("workspace-1")).toBe(second);
    expect(disposals.size).toBe(0);
  });

  it("disposes nothing for a workspace with no pipeline", async () => {
    const live = new Map<string, FakePipeline>();
    const disposals = new Map<string, Promise<void>>();
    let disposeCalls = 0;

    await disposeWorkspacePipeline<FakePipeline>({
      live,
      disposals,
      workspaceId: "workspace-1",
      dispose: async () => {
        disposeCalls += 1;
      },
    });

    expect(disposeCalls).toBe(0);
    expect(disposals.size).toBe(0);
  });
});
