import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureForWorkspace } from "./engineCaptureGate";
import type { WorkspaceCaptureHooks } from "./workspaceActivity";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";

// The gate requires daemon sessions, matching production, where main.ts quits
// the app if the daemon does not start. These tests only assert null vs
// non-null and never invoke an engine operation, so the sessions throw on any
// use.
const unusedSessions = new Proxy({} as EngineWorkspaceSessions, {
  get(_target, property) {
    throw new Error(
      `engineCaptureGate.test: sessions.${String(property)} was used, but these tests must not reach the engine`,
    );
  },
});

const hooks: WorkspaceCaptureHooks = {
  onCaptureOutcome: () => undefined,
  onAtomicPlacementUnavailable: () => undefined,
  onRecoveryUnavailable: () => undefined, onKeptFiles: () => undefined,
};
const ATTACHMENT_ID = Symbol("engine-capture-gate-test");

describe("captureForWorkspace", () => {
  // The gate owns the shared-view rule. The decision carries the cause,
  // and the workspace folder is never touched.
  it("gives a shared view a null capture with the share cause", () => {
    const decision = captureForWorkspace(
      {
        workspaceId: "ws-gate-share",
        rootPath: join(tmpdir(), "does-not-exist-share-view"),
        attachmentId: ATTACHMENT_ID,
        shareView: true,
      },
      hooks,
      unusedSessions,
    );
    expect(decision).toEqual({ capture: null, shareView: true });
  });

  it("builds a capture for an ordinary workspace", async () => {
    const decision = captureForWorkspace(
      {
        workspaceId: "ws-gate",
        rootPath: join(tmpdir(), "does-not-exist-gate"),
        attachmentId: ATTACHMENT_ID,
        shareView: false,
      },
      hooks,
      unusedSessions,
    );
    expect(decision.shareView).toBe(false);
    expect(decision.capture).not.toBeNull();
  });
});
