import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureForFlaggedWorkspace,
  dispatchScanEligible,
} from "./engineCaptureGate";
import type { WorkspaceCaptureHooks } from "./workspaceActivity";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { DEFAULT_WORKSPACE_SETTINGS } from "./workspaceSettings";
import { writeWorkspaceSettingsFile } from "./workspaceSettingsFile";

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

describe("dispatchScanEligible", () => {
  it("an open session keeps scanning after a mid-session opt-out, and stops after reopen", async () => {
    // The flag applies at the NEXT open (SettingsDialog + captureFor both
    // retain the open-session value). A chat sent after opting out while the
    // workspace is still open must still dispatch, or it stays pending
    // forever; only the reopen — where captureFor reads the flag — opts out.
    const root = await tempRoot();
    const workspace = { workspaceId: "ws-gate", rootPath: root };
    const openCapture = await captureForFlaggedWorkspace(workspace, hooks);
    expect(openCapture).not.toBeNull();

    await writeOptOut(root);
    await expect(
      dispatchScanEligible(workspace, activityWith(openCapture, ["ws-gate"])),
    ).resolves.toBe(true);

    const reopenCapture = await captureForFlaggedWorkspace(workspace, hooks);
    expect(reopenCapture).toBeNull();
    await expect(
      dispatchScanEligible(workspace, activityWith(reopenCapture, ["ws-gate"])),
    ).resolves.toBe(false);
  });

  it("an unopened workspace answers from the settings file (its open-time read)", async () => {
    const root = await tempRoot();
    const workspace = { workspaceId: "ws-gate", rootPath: root };
    const closed = activityWith(null, []);
    await expect(dispatchScanEligible(workspace, closed)).resolves.toBe(true);

    await writeOptOut(root);
    await expect(dispatchScanEligible(workspace, closed)).resolves.toBe(false);
  });
});
