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
  assertActiveWorkspaceForSitePreviewStop,
  createSitePreviewLifecycle,
  createSitePreviewStartRegistry,
} from "./sitePreviewLifecycle";
import type { SiteLogEntry, SiteProcessHandle } from "./siteRunner";

function fakeProcessHandle(url: string) {
  let exited = false;
  const logs: SiteLogEntry[] = [];
  const exitListeners = new Set<() => void>();
  const handle: SiteProcessHandle = {
    url,
    command: "test-server",
    args: [],
    cwd: "/workspace/site",
    logs: () => [...logs],
    onExit(listener) {
      if (exited) queueMicrotask(listener);
      else exitListeners.add(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    handle,
    appendLog(log: SiteLogEntry) {
      logs.push(log);
    },
    exit() {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener();
      exitListeners.clear();
    },
  };
}

describe("site preview lifecycle", () => {
  it("aborts only the matching pending site start immediately", async () => {
    const starts = createSitePreviewStartRegistry();
    const matching = starts.begin(7, "workspace-1", "site");
    const otherSite = starts.begin(7, "workspace-1", "other-site");
    const otherWorkspace = starts.begin(8, "workspace-2", "site");
    const matchingAbort = new Promise<boolean>((resolve) => {
      matching.controller.signal.addEventListener(
        "abort",
        () => resolve(true),
        { once: true },
      );
    });

    starts.abortForSite("workspace-1", "site");

    await expect(matchingAbort).resolves.toBe(true);
    expect(matching.controller.signal.aborted).toBe(true);
    expect(otherSite.controller.signal.aborted).toBe(false);
    expect(otherWorkspace.controller.signal.aborted).toBe(false);
    otherSite.finish();
    otherWorkspace.finish();
  });

  it("removes the handle and origin when a ready server exits", () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const server = fakeProcessHandle("http://127.0.0.1:4173/");
    previews.remember("workspace-1", "site", server.handle);

    expect(previews.isRunning("workspace-1", "site")).toBe(true);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      true,
    );

    server.exit();

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      false,
    );
  });

  it("reads process logs added after the initial preview response", () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const server = fakeProcessHandle("http://127.0.0.1:4173/");
    previews.remember("workspace-1", "site", server.handle);
    const initialResponseLogs = server.handle.logs();

    server.appendLog({
      stream: "stderr",
      text: "compiler warning after readiness",
      at: 2,
    });

    expect(initialResponseLogs).toEqual([]);
    expect(previews.logs("workspace-1", "site")).toEqual([
      {
        stream: "stderr",
        text: "compiler warning after readiness",
        at: 2,
      },
    ]);
    server.exit();
  });

  it("retains the final process logs after a ready server exits", () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const server = fakeProcessHandle("http://127.0.0.1:4173/");
    previews.remember("workspace-1", "site", server.handle);
    server.appendLog({
      stream: "stderr",
      text: "fatal: address became unavailable",
      at: 3,
    });

    server.exit();

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(previews.logs("workspace-1", "site")).toEqual([
      {
        stream: "stderr",
        text: "fatal: address became unavailable",
        at: 3,
      },
      expect.objectContaining({
        stream: "system",
        text: "Dev server exited unexpectedly.",
      }),
    ]);
  });

  it("matches an exited record to the handle that actually exited", () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const oldServer = fakeProcessHandle("http://127.0.0.1:4173/");
    const replacement = fakeProcessHandle("http://127.0.0.1:5173/");
    previews.remember("workspace-1", "site", oldServer.handle);
    previews.remember("workspace-1", "site", replacement.handle);

    replacement.exit();

    expect(
      previews.exited("workspace-1", "site", oldServer.handle),
    ).toBe(false);
    expect(
      previews.exited("workspace-1", "site", replacement.handle),
    ).toBe(true);
  });

  it("removes the handle and origin even when stop fails", async () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const server = fakeProcessHandle("http://127.0.0.1:4174/");
    server.handle.stop = vi.fn(async () => {
      throw new Error("stop failed");
    });
    previews.remember("workspace-1", "site", server.handle);

    await expect(previews.stop("workspace-1", "site")).rejects.toThrow(
      /stop failed/,
    );

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4174/frame")).toBe(
      false,
    );
  });

  it("ignores an old exit after a replacement reuses the same origin", () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const oldServer = fakeProcessHandle("http://127.0.0.1:5173/");
    const newServer = fakeProcessHandle("http://127.0.0.1:5173/");

    previews.remember("workspace-1", "site", oldServer.handle);
    previews.remember("workspace-1", "site", newServer.handle);
    oldServer.exit();

    expect(previews.isCurrent("workspace-1", "site", newServer.handle)).toBe(true);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:5173/frame")).toBe(
      true,
    );

    newServer.exit();

    expect(previews.isRunning("workspace-1", "site")).toBe(false);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:5173/frame")).toBe(
      false,
    );
  });

  it("does not stop a replacement after workspace cleanup snapshots the old handle", async () => {
    const previews = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
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
    const queuedStop = lock.then(async () => {
      assertActiveWorkspaceForSitePreviewStop(activeWorkspaceId, "workspace-1");
      await stop();
    });

    activeWorkspaceId = "workspace-2";
    releaseLock();

    await expect(queuedStop).rejects.toThrow(/active workspace/i);
    expect(stop).not.toHaveBeenCalled();
  });
});
