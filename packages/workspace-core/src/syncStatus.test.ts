import { describe, expect, it } from "vitest";
import { deriveSyncStatus } from "./syncStatus";

const base: Parameters<typeof deriveSyncStatus>[0] = {
  pendingChangeCount: 0,
  inFlight: false,
  hasConflict: false,
  cloudEnabled: false,
  cloudConnected: false,
  syncFailed: false,
  lastSyncedAtMs: null,
};

describe("deriveSyncStatus", () => {
  it("is synced when settled with no pending changes", () => {
    expect(deriveSyncStatus(base).state).toBe("synced");
  });

  it("shows local-changes when edits are pending", () => {
    expect(deriveSyncStatus({ ...base, pendingChangeCount: 3 }).state).toBe(
      "local-changes",
    );
  });

  it("shows syncing while a batch is in flight", () => {
    expect(
      deriveSyncStatus({ ...base, pendingChangeCount: 3, inFlight: true }).state,
    ).toBe("syncing");
  });

  // A retry in flight does not undo a failure: the pass that is running is
  // the one that has not worked yet.
  it("shows a failed sync over a pass in flight, and a conflict over both", () => {
    const failing = { ...base, cloudEnabled: true, cloudConnected: true, inFlight: true, syncFailed: true };
    expect(deriveSyncStatus(failing).state).toBe("sync-failed");
    expect(deriveSyncStatus({ ...failing, hasConflict: true }).state).toBe("conflict");
  });

  it("prioritizes conflict over everything", () => {
    expect(
      deriveSyncStatus({
        ...base,
        pendingChangeCount: 3,
        inFlight: true,
        hasConflict: true,
      }).state,
    ).toBe("conflict");
  });

  it("never reports disconnected for a local-only workspace", () => {
    expect(
      deriveSyncStatus({ ...base, cloudEnabled: false, cloudConnected: false })
        .state,
    ).toBe("synced");
  });

  it("reports cloud-disconnected only when cloud is enabled but offline", () => {
    expect(
      deriveSyncStatus({ ...base, cloudEnabled: true, cloudConnected: false })
        .state,
    ).toBe("cloud-disconnected");
  });

  it("keeps cloud-disconnected ahead of local-changes when offline edits are pending", () => {
    const status = deriveSyncStatus({
      ...base,
      cloudEnabled: true,
      cloudConnected: false,
      pendingChangeCount: 2,
    });
    expect(status.state).toBe("cloud-disconnected");
    expect(status.pendingChangeCount).toBe(2);
  });

  it("carries pending count and last-synced through unchanged", () => {
    const status = deriveSyncStatus({
      ...base,
      pendingChangeCount: 5,
      lastSyncedAtMs: 1000,
    });
    expect(status.pendingChangeCount).toBe(5);
    expect(status.lastSyncedAtMs).toBe(1000);
  });
});
