import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureForFlaggedWorkspace,
  dispatchScanEligible,
  engineOffRefusal,
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
      engineOffRefusal({ historyRecordingUnavailable: false }, NOT_ENABLED),
    ).toBe(NOT_ENABLED);
  });

  it("names the failure when the capture build failed, never a setting", () => {
    const refusal = engineOffRefusal(
      { historyRecordingUnavailable: true },
      NOT_ENABLED,
    );
    expect(refusal).toBe(
      "dohc could not start the workspace engine for this workspace. Restart dohc to try again.",
    );
    // The false cause this guards against: asserting a decision nobody made.
    expect(refusal).not.toContain("not enabled");
  });

  it("names the unreadable settings file when that read is the cause (#483)", () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";
    const refusal = engineOffRefusal(
      { settingsWarning: warning, historyRecordingUnavailable: false },
      NOT_ENABLED,
    );
    expect(refusal).toBe(warning);
    expect(refusal).toContain("/ws/.dohc/settings.local.json");
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
