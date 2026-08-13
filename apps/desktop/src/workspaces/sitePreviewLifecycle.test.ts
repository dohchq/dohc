import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/dohc-test-user-data",
  },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
    }),
  },
}));

import {
  allowLoopbackFrameOrigin,
  isAllowedLoopbackFrameUrl,
} from "../window/createMainWindow";
import {
  createSitePreviewLifecycle,
  stopSitePreviewForActiveWorkspace,
} from "./sitePreviewLifecycle";
import { createSitePreviewSdkAuthorityRegistry } from "./sitePreviewSdkAuthority";
import type { SiteProcessHandle } from "./siteRunner";

function fakeProcessHandle(url: string) {
  let exited = false;
  const exitListeners = new Set<() => void>();
  const handle: SiteProcessHandle = {
    url,
    command: "test-server",
    args: [],
    cwd: "/workspace/site",
    logs: () => [],
    onExit(listener) {
      if (exited) queueMicrotask(listener);
      else exitListeners.add(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    handle,
    exit() {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener();
      exitListeners.clear();
    },
  };
}

function grantInput(senderId: number) {
  return {
    senderId,
    generation: 1,
    workspaceId: "workspace-1",
    siteRoot: "site",
    workspaceRoot: "/workspace",
    scopeRoot: null,
    writable: true,
  };
}

describe("site preview lifecycle", () => {
  it("revokes an SDK grant even when no preview handle remains", async () => {
    const authorities = createSitePreviewSdkAuthorityRegistry();
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
      revokePreview: authorities.revokePreview,
    });
    const grant = authorities.register(grantInput(7));

    await previews.stop("workspace-1", "site");

    expect(grant.signal.aborted).toBe(true);
  });

  it("revokes the handle, origin, and SDK grant when a ready server exits", () => {
    const authorities = createSitePreviewSdkAuthorityRegistry();
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
      revokePreview: authorities.revokePreview,
    });
    const server = fakeProcessHandle("http://127.0.0.1:4173/");
    previews.remember("workspace-1", "site", server.handle);
    const grant = authorities.register(grantInput(11));

    expect(previews.isRunning("workspace-1", "site")).toBe(true);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      true,
    );

    server.exit();

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      false,
    );
    expect(grant.signal.aborted).toBe(true);
    expect(() =>
      authorities.authorize({
        senderId: 11,
        generation: 1,
        activeWorkspaceId: "workspace-1",
        workspaceId: "workspace-1",
        siteRoot: "site",
        previewRunning: previews.isRunning("workspace-1", "site"),
      }),
    ).toThrow(/does not belong to an active preview/);
  });

  it("revokes the handle, origin, and SDK grant even when stop fails", async () => {
    const authorities = createSitePreviewSdkAuthorityRegistry();
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
      revokePreview: authorities.revokePreview,
    });
    const server = fakeProcessHandle("http://127.0.0.1:4174/");
    server.handle.stop = vi.fn(async () => {
      throw new Error("stop failed");
    });
    previews.remember("workspace-1", "site", server.handle);
    const grant = authorities.register(grantInput(12));

    await expect(previews.stop("workspace-1", "site")).rejects.toThrow(
      /stop failed/,
    );

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4174/frame")).toBe(
      false,
    );
    expect(grant.signal.aborted).toBe(true);
  });

  it("ignores an old exit after a replacement reuses the same origin", () => {
    const authorities = createSitePreviewSdkAuthorityRegistry();
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
      revokePreview: authorities.revokePreview,
    });
    const oldServer = fakeProcessHandle("http://127.0.0.1:5173/");
    const newServer = fakeProcessHandle("http://127.0.0.1:5173/");

    previews.remember("workspace-1", "site", oldServer.handle);
    const oldGrant = authorities.register(grantInput(21));
    previews.remember("workspace-1", "site", newServer.handle);
    const newGrant = authorities.register(grantInput(22));

    expect(oldGrant.signal.aborted).toBe(true);
    oldServer.exit();

    expect(previews.isCurrent("workspace-1", "site", newServer.handle)).toBe(true);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:5173/frame")).toBe(
      true,
    );
    expect(
      authorities.authorize({
        senderId: 22,
        generation: 1,
        activeWorkspaceId: "workspace-1",
        workspaceId: "workspace-1",
        siteRoot: "site",
        previewRunning: previews.isRunning("workspace-1", "site"),
      }).senderId,
    ).toBe(22);

    newServer.exit();

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:5173/frame")).toBe(
      false,
    );
    expect(newGrant.signal.aborted).toBe(true);
  });

  it("does not stop a replacement after workspace cleanup snapshots the old handle", async () => {
    const authorities = createSitePreviewSdkAuthorityRegistry();
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
      revokePreview: authorities.revokePreview,
    });
    const oldServer = fakeProcessHandle("http://127.0.0.1:4173/");
    const replacement = fakeProcessHandle("http://127.0.0.1:5173/");

    previews.remember("workspace-1", "site", oldServer.handle);
    const snapshot = previews.previewsForWorkspace("workspace-1").at(0);
    if (!snapshot) throw new Error("Expected the old preview snapshot.");
    previews.remember("workspace-1", "site", replacement.handle);

    try {
      await previews.stop("workspace-1", snapshot.siteRoot, snapshot.handle);

      expect(
        previews.isCurrent("workspace-1", "site", replacement.handle),
      ).toBe(true);
      expect(replacement.handle.stop).not.toHaveBeenCalled();
    } finally {
      replacement.exit();
    }
  });

  it("rechecks the active workspace after a queued stop obtains the lock", async () => {
    let activeWorkspaceId: string | undefined = "workspace-1";
    let releaseLock: () => void = () => undefined;
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const stop = vi.fn(async () => undefined);
    const queuedStop = lock.then(() =>
      stopSitePreviewForActiveWorkspace({
        activeWorkspaceId: () => activeWorkspaceId,
        workspaceId: "workspace-1",
        stop,
      }),
    );

    activeWorkspaceId = "workspace-2";
    releaseLock();

    await expect(queuedStop).rejects.toThrow(/active workspace/i);
    expect(stop).not.toHaveBeenCalled();
  });
});
