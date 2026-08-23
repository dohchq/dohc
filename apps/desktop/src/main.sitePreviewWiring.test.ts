import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSitePreviewLifecycle,
  createSitePreviewStartRegistry,
  stopSitePreviewForRequest,
} from "./workspaces/sitePreviewLifecycle";
import { getSitePackage, requireExactSiteRoot } from "./workspaces/sitePackage";
import { createTestScratch } from "./workspaces/testTemp";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `ipcMain.handle(CHANNELS.${channel}`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${channel} handler`);
  const end = mainSource.indexOf("\n  });", start);
  if (end < 0) throw new Error(`Unterminated ${channel} handler`);
  return mainSource.slice(start, end);
}

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-main-site-preview-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("site preview main-process wiring", () => {
  it("wires stopSitePreview to call stopSitePreviewForRequest", () => {
    // The ordering this used to pin (abort the pending start, THEN take
    // the lock) is now internal to stopSitePreviewForRequest itself and
    // proven directly, below, by calling the real function — this only
    // pins that main.ts's handler routes through it rather than
    // reimplementing the sequence inline (main.ts cannot be imported
    // directly under Vitest, so routing is checked against its source —
    // the established pattern for this file's IPC handlers, e.g.
    // main.pluginPanelWiring.test.ts).
    const handler = handlerSource("stopSitePreview");
    expect(handler).toContain("await stopSitePreviewForRequest(");
  });

  it("stopSitePreviewForRequest aborts a pending start for the same site before it takes the lock", async () => {
    const starts = createSitePreviewStartRegistry();
    const previews = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
    const pending = starts.begin(7, "workspace-1", "site");
    expect(pending.controller.signal.aborted).toBe(false);

    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // Occupy the lock for "workspace-1"/"site" first, so
    // stopSitePreviewForRequest's own withStartLock call is genuinely
    // queued behind it — an abort that only ran INSIDE the lock callback
    // would still (eventually) leave this true, so an uncontended call
    // can't tell the two apart. Checking before the lock releases can.
    const holding = previews.withStartLock("workspace-1", "site", () => firstHold);

    const stopPromise = stopSitePreviewForRequest({
      getActiveWorkspaceId: () => "workspace-1",
      workspaceId: "workspace-1",
      siteRoot: "site",
      starts,
      previews,
    });

    // The abort must already have happened — it runs synchronously before
    // stopSitePreviewForRequest's first await — even though the lock it's
    // queued behind is still held.
    expect(pending.controller.signal.aborted).toBe(true);

    releaseFirst();
    await holding;
    await stopPromise;
  });

  it("stopSitePreviewForRequest names the concrete action a stale request should retry", async () => {
    // A generic "try again" doesn't say what "again" even means for a stop
    // request — the message must say to STOP the preview again, not just
    // reopen the workspace and hope.
    await expect(
      stopSitePreviewForRequest({
        getActiveWorkspaceId: () => "workspace-2",
        workspaceId: "workspace-1",
        siteRoot: "site",
        starts: createSitePreviewStartRegistry(),
        previews: createSitePreviewLifecycle({ allowOrigin: () => () => undefined }),
      }),
    ).rejects.toThrow(
      "The site preview stop request does not target the active workspace. Open the workspace and stop the preview again.",
    );
  });

  it("stopSitePreviewForRequest rechecks the active workspace after queueing behind another operation for the same site", async () => {
    let activeWorkspaceId: string | undefined = "workspace-1";
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const starts = createSitePreviewStartRegistry();
    const previews = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
    const stop = vi.spyOn(previews, "stop");

    const holding = previews.withStartLock("workspace-1", "site", () => firstHold);
    const queuedStop = stopSitePreviewForRequest({
      getActiveWorkspaceId: () => activeWorkspaceId,
      workspaceId: "workspace-1",
      siteRoot: "site",
      starts,
      previews,
    });

    activeWorkspaceId = "workspace-2";
    releaseFirst();
    await holding;

    await expect(queuedStop).rejects.toThrow(/active workspace/i);
    expect(stop).not.toHaveBeenCalled();
  });

  it("wires startSitePreview to call requireExactSiteRoot before starting", () => {
    // The handler must look up the site, then guard it through
    // requireExactSiteRoot, then start the preview — in that order. The
    // guard's own behavior is proven separately below by importing and
    // calling the real function; this only pins that main.ts's handler
    // actually routes through it rather than reimplementing the check
    // inline (main.ts cannot be imported directly under Vitest, so wiring
    // order is checked against its source — the established pattern for
    // this file's IPC handlers, e.g. main.pluginPanelWiring.test.ts).
    //
    // Not extracted like stopSitePreview and the sites-read handlers below:
    // this handler's own body is threaded through sender/generation/abort-
    // controller state (isCurrent) that only makes sense inside a live IPC
    // request, so pulling it out would drag most of the handler's Electron-
    // specific plumbing along with it for little real gain — the underlying
    // "a stale nested root never starts" invariant already has direct
    // behavioral coverage below, in "rejects a stale nested root before
    // starting its detected ancestor".
    const handler = handlerSource("startSitePreview");
    const lookupAt = handler.indexOf(
      "const site = requireExactSiteRoot(",
    );
    const ownedSiteAt = handler.indexOf(
      "await ownedSiteCatalog.get(",
      lookupAt,
    );
    const startAt = handler.indexOf(
      "const started = await startPreviewForSite({",
      lookupAt,
    );
    expect(lookupAt).toBeGreaterThanOrEqual(0);
    expect(ownedSiteAt).toBeGreaterThan(lookupAt);
    expect(startAt).toBeGreaterThan(ownedSiteAt);
  });

  it("rejects a stale nested root before starting its detected ancestor", async () => {
    await mkdir(join(root, "ancestor", "stale-child"), { recursive: true });
    await writeFile(
      join(root, "ancestor", "package.json"),
      JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" } }),
    );

    const requestedRoot = "ancestor/stale-child";
    const detected = await getSitePackage(root, requestedRoot);
    expect(detected?.root).toBe("ancestor");

    const startPreviewForSite = vi.fn();
    expect(() => {
      const site = requireExactSiteRoot(detected, requestedRoot);
      startPreviewForSite(site);
    }).toThrow(`Not a detected site: ${requestedRoot}`);
    expect(startPreviewForSite).not.toHaveBeenCalled();

    // The exact requested root, once genuinely detected, must still start.
    const exact = await getSitePackage(root, "ancestor");
    expect(() => requireExactSiteRoot(exact, "ancestor")).not.toThrow();
  });

  it("requireExactSiteRoot refuses a null site with the same message", () => {
    expect(() => requireExactSiteRoot(null, "gone")).toThrow(
      "Not a detected site: gone",
    );
  });

});
