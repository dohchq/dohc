import { describe, expect, it } from "vitest";
import { createSitePreviewSdkAuthorityRegistry } from "./sitePreviewSdkAuthority";

const owned = {
  senderId: 1,
  generation: 2,
  workspaceId: "workspace-a",
  siteRoot: "sites/app",
  workspaceRoot: "/workspace-a",
  scopeRoot: null,
  writable: true,
};

describe("site preview SDK authority", () => {
  it("only authorizes the renderer's active workspace and exact site", () => {
    const registry = createSitePreviewSdkAuthorityRegistry();
    registry.register(owned);

    expect(() =>
      registry.authorize({
        senderId: 1,
        generation: 2,
        activeWorkspaceId: "workspace-b",
        workspaceId: "workspace-a",
        siteRoot: "sites/app",
        previewRunning: true,
      }),
    ).toThrow(/active workspace/i);
    expect(() =>
      registry.authorize({
        senderId: 1,
        generation: 2,
        activeWorkspaceId: "workspace-a",
        workspaceId: "workspace-a",
        siteRoot: "sites/other",
        previewRunning: true,
      }),
    ).toThrow(/active preview/i);
    expect(() =>
      registry.authorize({
        senderId: 99,
        generation: 2,
        activeWorkspaceId: "workspace-a",
        workspaceId: "workspace-a",
        siteRoot: "sites/app",
        previewRunning: true,
      }),
    ).toThrow(/active preview/i);
  });

  it("revokes stale generations and aborts preview-owned work", () => {
    const registry = createSitePreviewSdkAuthorityRegistry();
    const grant = registry.register(owned);

    expect(() =>
      registry.authorize({
        senderId: 1,
        generation: 3,
        activeWorkspaceId: "workspace-a",
        workspaceId: "workspace-a",
        siteRoot: "sites/app",
        previewRunning: true,
      }),
    ).toThrow(/stale/i);
    expect(grant.signal.aborted).toBe(true);
  });

  it("preserves host-derived shared-view restrictions", () => {
    const registry = createSitePreviewSdkAuthorityRegistry();
    registry.register({ ...owned, scopeRoot: "shared-with-me/alice", writable: false });

    expect(
      registry.authorize({
        senderId: 1,
        generation: 2,
        activeWorkspaceId: "workspace-a",
        workspaceId: "workspace-a",
        siteRoot: "sites/app",
        previewRunning: true,
      }),
    ).toMatchObject({ scopeRoot: "shared-with-me/alice", writable: false });
  });
});
