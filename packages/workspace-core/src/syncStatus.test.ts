import { describe, expect, it } from "vitest";
import { deriveSyncStatus, type SyncStatusInput } from "./syncStatus";

const base: SyncStatusInput = {
  pendingChangeCount: 0,
  inFlight: false,
  hasConflict: false,
  cloudEnabled: false,
  cloudConnected: false,
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
