import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureForFlaggedWorkspace,
  dispatchScanEligible,
  engineOffRefusal,
  releaseAndRefuseWithoutCapture,
} from "./engineCaptureGate";
import type { WorkspaceCaptureHooks } from "./workspaceActivity";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { DEFAULT_WORKSPACE_SETTINGS } from "./workspaceSettings";
import {
  WORKSPACE_SETTINGS_FILE,
  writeWorkspaceSettingsFile,
} from "./workspaceSettingsFile";

// The gate now REQUIRES daemon sessions, matching production, where main.ts
// quits the app if the daemon does not start. These tests only assert null vs
// non-null and never invoke an engine operation, so the sessions throw on any
// use: if that ever changes, the test says so loudly instead of quietly
// exercising a stub.
const unusedSessions = new Proxy({} as EngineWorkspaceSessions, {
  get(_target, property) {
    throw new Error(
      `engineCaptureGate.test: sessions.${String(property)} was used, but these tests must not reach the engine`,
    );
  },
});

const roots: string[] = [];
const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tempBase, "dohc-engine-gate-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const hooks: WorkspaceCaptureHooks = {
  activeAgentRun: () => null,
  onCaptureOutcome: () => undefined,
};

function activityWith(
  capture: WorkspaceEngineCapture | null,
  openIds: string[],
) {
  return {
    listOpenWorkspaceIds: () => openIds,
    engineCaptureFor: () => capture,
  };
}

async function writeOptOut(root: string): Promise<void> {
  await writeWorkspaceSettingsFile(root, {
    ...DEFAULT_WORKSPACE_SETTINGS,
    experimental: { workspaceEngineAlpha: false },
  });
}

// #483: the capture decision and the notice's cause must come from ONE read.
// The gate is that read, so it must hand back WHY it recorded nothing.
describe("captureForFlaggedWorkspace decision", () => {
  it("returns the unreadable-file reason with the null capture", async () => {
    const root = await tempRoot();
    const workspace = { workspaceId: "ws-gate", rootPath: root, shareView: false };
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(join(root, ".dohc", WORKSPACE_SETTINGS_FILE), "{not json");

    const decision = await captureForFlaggedWorkspace(
      workspace,
      hooks,
      unusedSessions,
    );
    expect(decision.capture).toBeNull();
    expect(decision.warning).toContain(
      join(root, ".dohc", WORKSPACE_SETTINGS_FILE),
    );
  });

  // #540: the gate owns the shared-view rule. The decision carries the
  // cause, and the settings file — which a shared view does not even
  // materialize — is never read (a read would produce a warning or a
  // capture; the assertions refuse both).
  it("gives a shared view a null capture with the share cause, before any read", async () => {
    const decision = await captureForFlaggedWorkspace(
      {
        workspaceId: "ws-gate-share",
        rootPath: join(tempBase, "does-not-exist-share-view"),
        shareView: true,
      },
      hooks,
      unusedSessions,
    );
    expect(decision).toEqual({ capture: null, shareView: true });
  });

  it("carries no reason for a deliberate opt-out or a readable file", async () => {
    const root = await tempRoot();
    const workspace = { workspaceId: "ws-gate", rootPath: root, shareView: false };
    await writeOptOut(root);
    const optedOut = await captureForFlaggedWorkspace(
      workspace,
      hooks,
      unusedSessions,
    );
    expect(optedOut.capture).toBeNull();
    // The generic "turned off in Settings" notice is the honest one here.
    expect(optedOut.warning).toBeUndefined();

    const on = await tempRoot();
    const recording = await captureForFlaggedWorkspace(
      { workspaceId: "ws-gate-on", rootPath: on, shareView: false },
      hooks,
      unusedSessions,
    );
    expect(recording.capture).not.toBeNull();
    expect(recording.warning).toBeUndefined();
  });
});

// #541: "not enabled" asserts the user's opt-out. After a failed capture
// build — or an unreadable settings file — that assertion is false, so the
// refusal must name the established cause instead.
describe("engineOffRefusal", () => {
  const NOT_ENABLED = "Versions are not enabled for this workspace.";

  it("keeps the caller's opt-out copy only for the real opt-out", () => {
    expect(
      engineOffRefusal(
        { historyRecordingUnavailable: false },
        NOT_ENABLED,
        "restart",
      ),
    ).toBe(NOT_ENABLED);
  });

  it("names the failure when the capture build failed, never a setting", () => {
    const refusal = engineOffRefusal(
      { historyRecordingUnavailable: true },
      NOT_ENABLED,
      "restart",
    );
    expect(refusal).toBe(
      "dohc could not start the workspace engine for this workspace. Restart dohc to try again.",
    );
    // The false cause this guards against: asserting a decision nobody made.
    expect(refusal).not.toContain("not enabled");
  });

  // Codex P2 on #583 (round 2): the instruction must be the one that works
  // on the caller's path. A retained session keeps the failed decision until
  // restart; a transient dispatch open is rebuilt on the next attempt, so
  // telling that caller to restart the whole app is false. Both messages are
  // pinned exactly — swapping the recoveries fails both tests.
  it("tells a transient open to try again, not to restart", () => {
    expect(
      engineOffRefusal({ historyRecordingUnavailable: true }, NOT_ENABLED, "retry"),
    ).toBe(
      "dohc could not start the workspace engine for this workspace. Try again.",
    );
  });

  it("names the unreadable settings file when that read is the cause (#483)", () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";
    const refusal = engineOffRefusal(
      { settingsWarning: warning, historyRecordingUnavailable: false },
      NOT_ENABLED,
      "restart",
    );
    expect(refusal).toBe(warning);
    expect(refusal).toContain("/ws/.dohc/settings.local.json");
  });

  // Codex P2 on #583 (round 3): on a retry path the entry is gone, so fixing
  // the named file and trying again rebuilds the capture — the warning's
  // restart instruction is the retained path's, not this one's. The file
  // stays named either way.
  it("keeps the file and adapts the unreadable-settings instruction on retry", () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";
    const refusal = engineOffRefusal(
      { settingsWarning: warning, historyRecordingUnavailable: false },
      NOT_ENABLED,
      "retry",
    );
    expect(refusal).toBe(
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then try again.",
    );
  });
});

// Codex P2 on #583: releasing a dispatch's transient open deletes the
// workspace's activity entry, so a status read AFTER the release sees
// cause-less defaults — and the refusal falls back to "not enabled", the
// false cause the refusal exists to remove. The helper owns the order.
describe("releaseAndRefuseWithoutCapture", () => {
  const NOT_ENABLED = "Chats are not enabled for this workspace.";

  it("reads the cause before releasing, and derives retry from the actual close", async () => {
    let released = false;
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        // The live entry knows the build failed; the closed entry's
        // defaults would claim nobody-chose-this never happened.
        status: () =>
          released
            ? { historyRecordingUnavailable: false }
            : { historyRecordingUnavailable: true },
        release: async () => {
          released = true;
          return true;
        },
        notEnabled: NOT_ENABLED,
      }),
    ).rejects.toThrow(
      // The release CLOSED the entry, so the next attempt rebuilds the
      // capture — no restart needed.
      "dohc could not start the workspace engine for this workspace. Try again.",
    );
    // The hold is still released — the refusal never leaks the open.
    expect(released).toBe(true);
  });

  // Codex P2 on #583 (round 3): the recovery derives from what the release
  // ACTUALLY did. A workspace retained between open and release keeps its
  // failed decision — the release closes nothing, and "Try again" would
  // retry into the same kept failure forever.
  it("says restart when the release kept the entry (retained race)", async () => {
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        status: () => ({ historyRecordingUnavailable: true }),
        release: async () => false,
        notEnabled: NOT_ENABLED,
      }),
    ).rejects.toThrow(
      "dohc could not start the workspace engine for this workspace. Restart dohc to try again.",
    );
  });

  it("names the file and says try again for an unreadable-settings transient open", async () => {
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        status: () => ({
          settingsWarning:
            "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.",
          historyRecordingUnavailable: false,
        }),
        release: async () => true,
        notEnabled: NOT_ENABLED,
      }),
    ).rejects.toThrow(
      "Fix /ws/.dohc/settings.local.json. Then try again.",
    );
  });

  it("keeps the hold and refuses nothing when the capture is attached", async () => {
    let released = false;
    await releaseAndRefuseWithoutCapture({
      capture: {},
      status: () => ({ historyRecordingUnavailable: false }),
      release: async () => {
        released = true;
        return true;
      },
      notEnabled: NOT_ENABLED,
    });
    expect(released).toBe(false);
  });
});

describe("dispatchScanEligible", () => {
  it("an open session keeps scanning after a mid-session opt-out, and stops after reopen", async () => {
    // The flag applies at the NEXT open (SettingsDialog + captureFor both
    // retain the open-session value). A chat sent after opting out while the
    // workspace is still open must still dispatch, or it stays pending
    // forever; only the reopen — where captureFor reads the flag — opts out.
    const root = await tempRoot();
    const workspace = { workspaceId: "ws-gate", rootPath: root, shareView: false };
    const { capture: openCapture } = await captureForFlaggedWorkspace(
      workspace,
      hooks,
      unusedSessions,
    );
    expect(openCapture).not.toBeNull();

    await writeOptOut(root);
    await expect(
      dispatchScanEligible(workspace, activityWith(openCapture, ["ws-gate"])),
    ).resolves.toBe(true);

    const { capture: reopenCapture } = await captureForFlaggedWorkspace(
      workspace,
      hooks,
      unusedSessions,
    );
    expect(reopenCapture).toBeNull();
    await expect(
      dispatchScanEligible(workspace, activityWith(reopenCapture, ["ws-gate"])),
    ).resolves.toBe(false);
  });

  it("an unopened workspace answers from the settings file (its open-time read)", async () => {
    const root = await tempRoot();
    const workspace = { workspaceId: "ws-gate", rootPath: root, shareView: false };
    const closed = activityWith(null, []);
    await expect(dispatchScanEligible(workspace, closed)).resolves.toBe(true);

    await writeOptOut(root);
    await expect(dispatchScanEligible(workspace, closed)).resolves.toBe(false);
  });
});
