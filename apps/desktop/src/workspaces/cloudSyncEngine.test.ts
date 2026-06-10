import { describe, expect, it, vi } from "vitest";
import { UnauthorizedSyncError, type MergeSync, type MergeSyncResult } from "@dohc/workspace-sync";
import { createCloudSyncEngine } from "./cloudSyncEngine";

const noResult: MergeSyncResult = {
  pushed: 0,
  pulled: 0,
  deletedLocally: 0,
  conflicts: [],
  skipped: [],
};

function fakeSync(overrides: Partial<MergeSync> = {}): MergeSync {
  return {
    initialize: async () => {},
    pull: async () => noResult,
    push: async () => noResult,
    ...overrides,
  };
}

function engine(sync: MergeSync, onChange = () => {}) {
  return createCloudSyncEngine({
    rootDir: "/tmp/ws",
    remoteWorkspaceId: "ws-1",
    serverUrl: "http://cloud.test",
    token: "tok",
    onChange,
    sync,
  });
}

describe("cloudSyncEngine auth handling", () => {
  it("start() PROPAGATES a first-contact failure instead of swallowing it", async () => {
    const sync = fakeSync({
      pull: async () => {
        throw new UnauthorizedSyncError("401");
      },
    });
    const eng = engine(sync);
    await expect(eng.start()).rejects.toBeInstanceOf(UnauthorizedSyncError);
  });

  it("a confirmed 401 flips authExpired and stops the retry loop", async () => {
    const push = vi.fn(async () => {
      throw new UnauthorizedSyncError("401");
    });
    const sync = fakeSync({ push });
    const eng = engine(sync);

    await expect(eng.start()).rejects.toBeInstanceOf(UnauthorizedSyncError);
    expect(eng.snapshot().authExpired).toBe(true);

    // queueSync must not accumulate pending work or schedule a retry on a
    // known-dead session.
    eng.queueSync();
    expect(eng.snapshot().pendingChangeCount).toBe(0);
  });

  it("a transient (non-401) failure does NOT flip authExpired (retries continue)", async () => {
    const sync = fakeSync({
      pull: async () => {
        throw new Error("network blip");
      },
    });
    const eng = engine(sync);
    await expect(eng.start()).rejects.toThrow(/network blip/);
    expect(eng.snapshot().authExpired).toBe(false);
    // Still accepts queued work for the next retry.
    eng.queueSync();
    expect(eng.snapshot().pendingChangeCount).toBe(1);
    await eng.stop();
  });
});
