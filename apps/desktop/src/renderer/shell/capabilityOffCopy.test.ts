import { describe, expect, it } from "vitest";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import { chatsOffCopy, historyOffPlaceholderCopy, versionCompareOffCopy } from "./capabilityOffCopy";

describe("refused data store copy", () => {
  it.each([
    ["foreign-database", "dohc cannot read this workspace's data store."],
    ["unsupported-fingerprint", "This workspace's data store is not in the format this version of dohc uses."],
  ] as const)("directs every unavailable surface to recovery for %s", (cause, sentence) => {
    const status: SyncStatusResult = {
      state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null,
      liveSessionsGeneration: 0, historyRecordingUnavailable: false, historyShareView: false,
      historyCaptureFailed: true, engineStoreRefused: cause,
    };
    for (const copy of [historyOffPlaceholderCopy(status, null), versionCompareOffCopy(status), chatsOffCopy(status)]) {
      expect(copy).toBe(`${sentence} Open Notices and choose Rebuild to review recovery options.`);
    }
    expect(historyOffPlaceholderCopy(status, { ended: false, granterEmail: null })).toBe(
      "A shared view records no history. Refresh the shared view to get the latest shared changes.",
    );
    expect(historyOffPlaceholderCopy(status, { ended: true, granterEmail: "alex@example.com" })).toBe(
      "A shared view records no history. alex@example.com ended this share. You can still open the files it shared.",
    );
  });
});

// A capability flag is not a count. Whatever main established about the
// RECORDER, none of it establishes that no version exists: versions live on
// disk and outlive a session whose capture failed to build, an engine the
// user switched off, and a settings file dohc could not read. The compare tab
// has no count to read, so it may never claim absence.
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
    // the cause.
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
    // The renderer's own read failed. It proves nothing either way.
    const copy = versionCompareOffCopy(base);
    expect(copy).toContain("dohc could not confirm whether this workspace has versions.");
    expect(copy).not.toContain("no versions");
  });
});

// The same rule on the Chats surfaces. Whatever main established about
// the RECORDER, none of it establishes that no chat exists: chats live on disk
// and outlive a session whose capture failed to build, an engine the user
// switched off, and a settings file dohc could not read.
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
    // the cause.
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
    // The renderer's own read failed. It proves nothing either way.
    const copy = chatsOffCopy(base);
    expect(copy).toContain("dohc could not confirm whether this workspace has chats.");
    expect(copy).not.toContain("no chats");
  });
});
