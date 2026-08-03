import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureForFlaggedWorkspace,
  createDispatchRunRelease,
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
    // The retry-path refusal rewrites this exact SUFFIX (#541): a template
    // that stops ending with it would silently hand retry callers the
    // restart instruction again. Pinned against the real producer.
    expect(decision.warning).toMatch(/ Then restart dohc\.$/);
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
  const FEATURE = "Versions" as const;
  const NOT_ENABLED = "Versions are not enabled for this workspace.";

  it("keeps the caller's opt-out copy only for the real opt-out", () => {
    expect(
      engineOffRefusal(
        { historyRecordingUnavailable: false },
        FEATURE,
        "restart",
      ),
    ).toBe(NOT_ENABLED);
  });

  it("names the failure when the capture build failed, never a setting", () => {
    const refusal = engineOffRefusal(
      { historyRecordingUnavailable: true },
      FEATURE,
      "restart",
    );
    expect(refusal).toBe(
      "dohc could not start Versions for this workspace. Restart dohc to try again.",
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
      engineOffRefusal({ historyRecordingUnavailable: true }, FEATURE, "retry"),
    ).toBe(
      "dohc could not start Versions for this workspace. Try again.",
    );
  });

  // Codex P2 on #583 (round 6): the noun is the FEATURE the user invoked —
  // the word their surface shows — never an internal implementation noun.
  // Pinned per caller, so swapping or hard-wiring a noun fails.
  it("names each caller's own feature, with its own opt-out grammar", () => {
    const failed = { historyRecordingUnavailable: true };
    expect(engineOffRefusal(failed, "Versions", "restart")).toBe(
      "dohc could not start Versions for this workspace. Restart dohc to try again.",
    );
    expect(engineOffRefusal(failed, "Chats", "restart")).toBe(
      "dohc could not start Chats for this workspace. Restart dohc to try again.",
    );
    expect(engineOffRefusal(failed, "Engine history", "restart")).toBe(
      "dohc could not start Engine history for this workspace. Restart dohc to try again.",
    );
    expect(engineOffRefusal(failed, "Chat mentions", "restart")).toBe(
      "dohc could not start Chat mentions for this workspace. Restart dohc to try again.",
    );
    const optedOut = { historyRecordingUnavailable: false };
    expect(engineOffRefusal(optedOut, "Chats", "restart")).toBe(
      "Chats are not enabled for this workspace.",
    );
    expect(engineOffRefusal(optedOut, "Engine history", "restart")).toBe(
      "Engine history is not enabled for this workspace.",
    );
  });

  it("names the unreadable settings file when that read is the cause (#483)", () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";
    const refusal = engineOffRefusal(
      { settingsWarning: warning, historyRecordingUnavailable: false },
      FEATURE,
      "restart",
    );
    // Round 7: what happened to the caller's feature leads, then the
    // warning's why, file, and recovery — nothing of the warning is lost.
    expect(refusal).toBe(`Versions are unavailable. ${warning}`);
    expect(refusal).toContain("/ws/.dohc/settings.local.json");
  });

  // Round 7's per-caller pin for the unreadable-settings branch: the same
  // noun rule as the build-failure branch — swapping or hard-wiring fails.
  it("leads the unreadable-settings refusal with each caller's own feature", () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";
    const status = { settingsWarning: warning, historyRecordingUnavailable: false };
    expect(engineOffRefusal(status, "Chats", "restart")).toBe(
      `Chats are unavailable. ${warning}`,
    );
    expect(engineOffRefusal(status, "Engine history", "restart")).toBe(
      `Engine history is unavailable. ${warning}`,
    );
    expect(engineOffRefusal(status, "Chat mentions", "restart")).toBe(
      `Chat mentions are unavailable. ${warning}`,
    );
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
      FEATURE,
      "retry",
    );
    expect(refusal).toBe(
      "Versions are unavailable. Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then try again.",
    );
  });
});

// Codex P2 round 4 on #583: the release's answer is the POST-close state.
// The close's own await is a window — a renderer/CLI open can retain the
// workspace during it and build a fresh retained activity whose failed
// capture decision persists until restart. "Try again" would be false there.
describe("createDispatchRunRelease", () => {
  it("says retryable after a clean transient close", async () => {
    let closedCalls = 0;
    const release = createDispatchRunRelease({
      alreadyOpen: false,
      isRetained: () => false,
      close: async () => {
        closedCalls += 1;
      },
    });
    await expect(release()).resolves.toBe(true);
    // Idempotent: the second call answers the same without closing again.
    await expect(release()).resolves.toBe(true);
    expect(closedCalls).toBe(1);
  });

  it("says restart when a retention lands during the close", async () => {
    let retained = false;
    const release = createDispatchRunRelease({
      alreadyOpen: false,
      isRetained: () => retained,
      close: async () => {
        // The open that raced us: it waits for this close, then builds a
        // fresh RETAINED activity — whose capture decision persists.
        retained = true;
      },
    });
    await expect(release()).resolves.toBe(false);
  });

  it("closes nothing and says restart for an already-open workspace", async () => {
    const release = createDispatchRunRelease({
      alreadyOpen: true,
      isRetained: () => false,
      close: async () => {
        throw new Error("must not close an entry this open does not own");
      },
    });
    await expect(release()).resolves.toBe(false);
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
        currentCapture: () => null,
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
        feature: "Chats",
        settleKeptOpen: async () => undefined,
      }),
    ).rejects.toThrow(
      // The release CLOSED the entry, so the next attempt rebuilds the
      // capture — no restart needed.
      "dohc could not start Chats for this workspace. Try again.",
    );
    // The hold is still released — the refusal never leaks the open.
    expect(released).toBe(true);
  });

  // Codex P2 rounds 3–5 on #583: when the release KEEPS an entry, the
  // post-state itself answers. A retention that landed during the close may
  // have REOPENED the workspace with a WORKING capture — refusing then would
  // be the last false message standing.
  it("proceeds when the retention's reopen built a working capture", async () => {
    const reopenedCapture = {};
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        currentCapture: () => reopenedCapture,
        status: () => ({ historyRecordingUnavailable: true }),
        release: async () => false,
        feature: "Chats",
        settleKeptOpen: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  // Codex P2 on #583 (round 6): the reopener's capture builds AFTER the
  // release resolves — an immediate read sees a state still forming and
  // refuses a workspace that works moments later. The judgment must settle
  // behind the kept open first.
  it("waits for the kept open to settle before judging its capture", async () => {
    let capture: object | null = null;
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        // The reopen finishes building DURING the settle, not before it —
        // and only after a real async hop, so a fire-and-forget call
        // (mutating the await away) cannot satisfy this pin.
        settleKeptOpen: async () => {
          await Promise.resolve();
          capture = {};
        },
        currentCapture: () => capture,
        status: () => ({ historyRecordingUnavailable: true }),
        release: async () => false,
        feature: "Chats",
      }),
    ).resolves.toBeUndefined();
  });

  it("says restart from the KEPT entry's own cause when its capture is still null", async () => {
    // Our transient entry blamed a build failure; the entry the release kept
    // (the reopened one) has ITS own cause — an unreadable settings file.
    // The refusal must state the live entry's cause, not our stale snapshot.
    let released = false;
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        currentCapture: () => null,
        status: () =>
          released
            ? {
                settingsWarning:
                  "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.",
                historyRecordingUnavailable: false,
              }
            : { historyRecordingUnavailable: true },
        release: async () => {
          released = true;
          return false;
        },
        feature: "Chats",
        settleKeptOpen: async () => undefined,
      }),
    ).rejects.toThrow("Fix /ws/.dohc/settings.local.json. Then restart dohc.");
  });

  it("names the file and says try again for an unreadable-settings transient open", async () => {
    await expect(
      releaseAndRefuseWithoutCapture({
        capture: null,
        currentCapture: () => null,
        status: () => ({
          settingsWarning:
            "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.",
          historyRecordingUnavailable: false,
        }),
        release: async () => true,
        feature: "Chats",
        settleKeptOpen: async () => undefined,
      }),
    ).rejects.toThrow(
      "Fix /ws/.dohc/settings.local.json. Then try again.",
    );
  });

  it("keeps the hold and refuses nothing when the capture is attached", async () => {
    let released = false;
    await releaseAndRefuseWithoutCapture({
      capture: {},
      currentCapture: () => null,
      status: () => ({ historyRecordingUnavailable: false }),
      release: async () => {
        released = true;
        return true;
      },
      feature: "Chats",
      settleKeptOpen: async () => undefined,
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
