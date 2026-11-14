import { describe, expect, it } from "vitest";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import {
  chatsOffCopy,
  fileObservationFailureCopy,
  historyOffPlaceholderCopy,
  versionCompareOffCopy,
} from "./capabilityOffCopy";

describe("file observation failure copy", () => {
  it("names a failed read and its recovery without claiming history stopped", () => {
    expect(fileObservationFailureCopy("read-failed")).toBe(
      "dohc could not read file changes for this workspace.",
    );
    expect(fileObservationFailureCopy("unavailable")).toBe(
      "dohc could not watch file changes for this workspace.",
    );
  });
});

describe("refused data store copy", () => {
  it.each([
    ["foreign-database", "dohc cannot read this workspace's data store."],
    [
      "unsupported-fingerprint",
      "This workspace's data store is not in the format this version of dohc uses.",
    ],
  ] as const)("directs every unavailable surface to recovery for %s", (cause, sentence) => {
    const status: SyncStatusResult = {
      state: "synced",
      pendingChangeCount: 0,
      lastSyncedAtMs: null,
      liveSessionsGeneration: 0,
      historyRecordingUnavailable: false,
      historyShareView: false,
      historyCaptureFailed: true,
      engineStoreRefused: cause,
    };
    for (const copy of [
      historyOffPlaceholderCopy(status),
      historyOffPlaceholderCopy({ ...status, historyShareView: true }),
      versionCompareOffCopy(status),
      chatsOffCopy(status),
    ]) {
      expect(copy).toBe(`${sentence} Open Notices and choose Rebuild to review recovery options.`);
    }
  });
});

describe("migration failure copy", () => {
  it("directs every unavailable surface to an update, not a rebuild", () => {
    const status: SyncStatusResult = {
      state: "synced",
      pendingChangeCount: 0,
      lastSyncedAtMs: null,
      liveSessionsGeneration: 0,
      historyRecordingUnavailable: false,
      historyShareView: false,
      historyCaptureFailed: true,
      engineStoreRefused: "migration-failed",
    };
    for (const copy of [
      historyOffPlaceholderCopy(status),
      versionCompareOffCopy(status),
      chatsOffCopy(status),
    ]) {
      expect(copy).toBe(
        "dohc could not update this workspace's data store to this version. Update dohc to continue. Your files are unchanged.",
      );
      expect(copy).not.toContain("Rebuild");
    }
  });
});

describe("version-compare off copy", () => {
  const base = {
    state: "synced" as const,
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    liveSessionsGeneration: 0,
    historyRecordingUnavailable: false,
    historyShareView: false,
  };

  it("calls a failed capture build unavailable, never empty", () => {
    const copy = versionCompareOffCopy({
      ...base,
      historyRecordingUnavailable: true,
    });
    expect(copy).toBe(
      "dohc could not open versions for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(copy).not.toContain("no versions");
  });

  it("claims nothing when main established nothing", () => {
    const copy = versionCompareOffCopy(base);
    expect(copy).toContain("dohc could not confirm whether this workspace has versions.");
    expect(copy).not.toContain("no versions");
  });
});

describe("chats off copy", () => {
  const base = {
    state: "synced" as const,
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    liveSessionsGeneration: 0,
    historyRecordingUnavailable: false,
    historyShareView: false,
  };

  it("calls a failed capture build unavailable, never empty", () => {
    const copy = chatsOffCopy({
      ...base,
      historyRecordingUnavailable: true,
    });
    expect(copy).toBe(
      "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(copy).not.toContain("no chats");
  });

  it("claims nothing when main established nothing", () => {
    const copy = chatsOffCopy(base);
    expect(copy).toContain("dohc could not confirm whether this workspace has chats.");
    expect(copy).not.toContain("no chats");
  });
});
