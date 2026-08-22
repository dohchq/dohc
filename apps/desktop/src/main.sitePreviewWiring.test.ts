import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertActiveWorkspaceForSiteRead } from "./workspaces/sitePreviewLifecycle";
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
  it("aborts the matching pending start before stop waits for its site lock", () => {
    const handler = handlerSource("stopSitePreview");
    const abortAt = handler.indexOf("abortSitePreviewStartsForSite(");
    const lockAt = handler.indexOf("await withSitePreviewStartLock(");

    expect(abortAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(abortAt);
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
    const handler = handlerSource("startSitePreview");
    const lookupAt = handler.indexOf(
      "const site = requireExactSiteRoot(",
    );
    const getSitePackageAt = handler.indexOf(
      "await getSitePackage(workspace.rootPath, input.siteRoot),",
      lookupAt,
    );
    const startAt = handler.indexOf("const started = await startPreviewForSite({", lookupAt);
    expect(lookupAt).toBeGreaterThanOrEqual(0);
    expect(getSitePackageAt).toBeGreaterThan(lookupAt);
    expect(startAt).toBeGreaterThan(getSitePackageAt);
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

  it("wires listSites and getSitePackage to call assertActiveWorkspaceForSiteRead before reading", () => {
    // requireWorkspace alone only proves workspaceId names a workspace
    // REGISTERED somewhere in this app instance — not that it's the one
    // THIS sender's own window is currently showing. Without the active-
    // workspace check, a stale or compromised renderer could read another
    // workspace's site paths, titles, diagnostics, and full package-script
    // bodies just by naming its id. main.ts cannot be imported directly
    // under Vitest, so wiring ORDER is checked against its source text —
    // the established pattern this file already uses above — but the
    // guard's own authorized/unauthorized behavior is proven directly
    // below by importing and calling the real, shared function instead of
    // reimplementing it inline here (a rename, reformat, or extraction
    // that keeps calling the same helper leaves this test correct; only
    // main.ts routing around the call would break it).
    for (const channel of ["listSites", "getSitePackage"]) {
      const handler = handlerSource(channel);
      const workspaceAt = handler.indexOf("const workspace = requireWorkspace(");
      const guardAt = handler.indexOf("assertActiveWorkspaceForSiteRead(", workspaceAt);
      const readAt = handler.indexOf(
        channel === "listSites" ? "await listSitePackages(" : "await getSitePackage(",
        workspaceAt,
      );
      expect(workspaceAt).toBeGreaterThanOrEqual(0);
      expect(guardAt).toBeGreaterThan(workspaceAt);
      expect(readAt).toBeGreaterThan(guardAt);
    }
  });

  it("assertActiveWorkspaceForSiteRead permits a matching sender and rejects a mismatched one", () => {
    expect(() => assertActiveWorkspaceForSiteRead("workspace-1", "workspace-1")).not.toThrow();
    expect(() => assertActiveWorkspaceForSiteRead("workspace-2", "workspace-1")).toThrow(
      /active workspace/i,
    );
    expect(() => assertActiveWorkspaceForSiteRead(undefined, "workspace-1")).toThrow(
      /active workspace/i,
    );
  });
});
