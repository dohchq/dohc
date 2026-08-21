import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
