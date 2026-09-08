import { describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { PluginJobQueues } from "./pluginJobQueue";

describe("PluginJobQueues", () => {
  it("orders one plugin's actions while another progresses outside the current drain snapshot", async () => {
    const firstGate = deferred();
    const otherGate = deferred();
    const steps: string[] = [];
    const failed = vi.fn();
    const queues = new PluginJobQueues(failed);
    const pending: Promise<unknown>[] = [];

    try {
      const first = queues.enqueueActionValue("first-plugin", async () => {
        steps.push("first:start");
        await firstGate.promise;
        steps.push("first:end");
        return "first result";
      });
      pending.push(first);
      const currentJobs = queues.waitForCurrentJobs();
      pending.push(currentJobs);
      const second = queues.enqueueActionValue("first-plugin", async () => {
        steps.push("second");
        return "second result";
      });
      pending.push(second);
      const other = queues.enqueueActionValue("other-plugin", async () => {
        steps.push("other:start");
        await otherGate.promise;
        steps.push("other:end");
        return "other result";
      });
      pending.push(other);

      expect(steps).toEqual(["first:start", "other:start"]);
      firstGate.resolve();
      expect(await Promise.all([first, second])).toEqual([
        "first result",
        "second result",
      ]);
      await currentJobs;
      expect(steps).toEqual(["first:start", "other:start", "first:end", "second"]);

      otherGate.resolve();
      expect(await other).toBe("other result");
      await queues.waitForCurrentJobs();
      expect(steps).toEqual([
        "first:start", "other:start", "first:end", "second", "other:end",
      ]);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      firstGate.resolve();
      otherGate.resolve();
      await Promise.allSettled(pending);
      await queues.waitForCurrentJobs();
    }
  });

  it("prepares a refresh synchronously and coalesces one follow-up while it runs", async () => {
    const blockerGate = deferred();
    const firstGate = deferred();
    const followupGate = deferred();
    const firstEntered = deferred();
    const followupEntered = deferred();
    const steps: string[] = [];
    const failed = vi.fn();
    const queues = new PluginJobQueues(failed);
    const pending: Promise<unknown>[] = [];
    const droppedPrepare = vi.fn(() => async () => {
      steps.push("unexpected refresh");
    });

    try {
      pending.push(queues.enqueueActionValue("plugin", async () => {
        await blockerGate.promise;
      }));
      queues.enqueueSourceRefresh("plugin", () => {
        steps.push("prepare:first");
        return async () => {
          steps.push("run:first");
          firstEntered.resolve();
          await firstGate.promise;
          steps.push("finish:first");
        };
      });
      expect(steps).toEqual(["prepare:first"]);
      queues.enqueueSourceRefresh("plugin", droppedPrepare);
      queues.enqueueSourceRefresh("plugin", droppedPrepare);
      expect(droppedPrepare).not.toHaveBeenCalled();
      let currentJobsSettled = false;
      const currentJobs = queues.waitForCurrentJobs().then(() => {
        currentJobsSettled = true;
      });
      pending.push(currentJobs);

      blockerGate.resolve();
      await firstEntered.promise;
      expect(currentJobsSettled).toBe(false);
      queues.enqueueSourceRefresh("plugin", () => {
        steps.push("prepare:follow-up");
        return async () => {
          steps.push("run:follow-up");
          followupEntered.resolve();
          await followupGate.promise;
          steps.push("finish:follow-up");
        };
      });
      expect(steps).toEqual(["prepare:first", "run:first", "prepare:follow-up"]);
      queues.enqueueSourceRefresh("plugin", droppedPrepare);
      queues.enqueueSourceRefresh("plugin", droppedPrepare);
      expect(droppedPrepare).not.toHaveBeenCalled();

      firstGate.resolve();
      await followupEntered.promise;
      expect(currentJobsSettled).toBe(false);
      expect(steps).toEqual([
        "prepare:first", "run:first", "prepare:follow-up", "finish:first", "run:follow-up",
      ]);
      followupGate.resolve();
      await currentJobs;
      expect(currentJobsSettled).toBe(true);
      expect(steps).toEqual([
        "prepare:first", "run:first", "prepare:follow-up", "finish:first",
        "run:follow-up", "finish:follow-up",
      ]);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      blockerGate.resolve();
      firstGate.resolve();
      followupGate.resolve();
      firstEntered.resolve();
      followupEntered.resolve();
      await Promise.allSettled(pending);
      await queues.waitForCurrentJobs();
    }
  });

  it("rejects an action and reports a refresh failure while later work still drains", async () => {
    const actionGate = deferred();
    const refreshGate = deferred();
    const refreshEntered = deferred();
    const actionFailure = new Error("action failed");
    const refreshFailure = new Error("refresh failed");
    const steps: string[] = [];
    const failed = vi.fn((pluginId: string, _error: unknown) => {
      steps.push(`reported:${pluginId}`);
    });
    const queues = new PluginJobQueues(failed);
    const pending: Promise<unknown>[] = [];

    try {
      const rejected = queues.enqueueActionValue("plugin", async () => {
        await actionGate.promise;
        throw actionFailure;
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      pending.push(rejected);
      pending.push(queues.enqueueActionValue("plugin", async () => {
        steps.push("after action");
      }));
      queues.enqueueSourceRefresh("plugin", () => async () => {
        refreshEntered.resolve();
        await refreshGate.promise;
        throw refreshFailure;
      });
      const last = queues.enqueueActionValue("plugin", async () => {
        steps.push("after refresh");
        return "last result";
      });
      pending.push(last);
      const currentJobs = queues.waitForCurrentJobs();
      pending.push(currentJobs);

      actionGate.resolve();
      expect(await rejected).toEqual({ error: actionFailure });
      await refreshEntered.promise;
      expect(steps).toEqual(["after action"]);
      expect(failed).not.toHaveBeenCalled();

      refreshGate.resolve();
      expect(await last).toBe("last result");
      await currentJobs;
      expect(failed.mock.calls).toEqual([["plugin", refreshFailure]]);
      expect(steps).toEqual(["after action", "reported:plugin", "after refresh"]);
      const next = queues.enqueueActionValue("plugin", async () => "after drain");
      pending.push(next);
      expect(await next).toBe("after drain");
    } finally {
      actionGate.resolve();
      refreshGate.resolve();
      refreshEntered.resolve();
      await Promise.allSettled(pending);
      await queues.waitForCurrentJobs();
    }
  });
});
