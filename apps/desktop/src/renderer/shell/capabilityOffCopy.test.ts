import { describe, expect, it } from "vitest";
import { chatsOffCopy, versionCompareOffCopy } from "./capabilityOffCopy";

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
