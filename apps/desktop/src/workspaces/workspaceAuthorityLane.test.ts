import { describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { runInWorkspaceAuthorityLane } from "./workspaceAuthorityLane";

describe("workspace authority lanes", () => {
  it("rejects queued work after its workspace authority retires", async () => {
    let current = true;
    const authority = {
      state: { operationLanes: new Map<string, Promise<void>>() },
      assertCurrent() {
        if (!current) throw new Error("retired");
      },
    };
    const started = deferred();
    const finish = deferred();
    const first = runInWorkspaceAuthorityLane(authority, "shared-channels", async () => {
      started.resolve();
      await finish.promise;
      return "stale result";
    });
    await started.promise;
    const queuedWork = vi.fn(async () => "queued result");
    const second = runInWorkspaceAuthorityLane(authority, "shared-channels", queuedWork);

    current = false;
    finish.resolve();
    await expect(first).rejects.toThrow("retired");
    await expect(second).rejects.toThrow("retired");
    expect(queuedWork).not.toHaveBeenCalled();
    expect(authority.state.operationLanes.size).toBe(0);
  });

  it("keeps a replacement attachment's work independent of the retired attachment", async () => {
    const oldAttachment = {
      state: { operationLanes: new Map<string, Promise<void>>() },
      assertCurrent: () => undefined,
    };
    const replacement = {
      state: { operationLanes: new Map<string, Promise<void>>() },
      assertCurrent: () => undefined,
    };
    const finishOld = deferred();
    const oldRun = runInWorkspaceAuthorityLane(oldAttachment, "engine-store", () => finishOld.promise);

    await expect(runInWorkspaceAuthorityLane(replacement, "engine-store", async () => "new result"))
      .resolves.toBe("new result");
    finishOld.resolve();
    await oldRun;
  });
});
