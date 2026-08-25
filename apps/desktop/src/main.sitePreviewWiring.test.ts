import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSitePackage,
  listSitePackages,
  requireExactSiteRoot,
} from "./workspaces/sitePackage";
import { createTestScratch } from "./workspaces/testTemp";
import { listFiles } from "./workspaces/workspaceFiles";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-main-site-preview-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("site preview lookup", () => {
  it("registers the behavior-tested start request handler", () => {
    expect(mainSource).toContain(
      "const startSitePreview = createStartSitePreviewHandler({",
    );
    expect(mainSource).toContain(
      "ipcMain.handle(CHANNELS.startSitePreview, startSitePreview);",
    );
  });

  it("rejects a stale nested root before starting its detected ancestor", async () => {
    await mkdir(join(root, "ancestor", "stale-child"), { recursive: true });
    await writeFile(
      join(root, "ancestor", "package.json"),
      JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" } }),
    );

    const requestedRoot = "ancestor/stale-child";
    const sites = await listSitePackages(root, await listFiles(root));
    const detected = await getSitePackage(root, requestedRoot, sites);
    expect(detected?.root).toBe("ancestor");

    const startPreview = vi.fn();
    expect(() => {
      const site = requireExactSiteRoot(detected, requestedRoot);
      startPreview(site);
    }).toThrow(`Not a detected site: ${requestedRoot}`);
    expect(startPreview).not.toHaveBeenCalled();

    const exact = await getSitePackage(root, "ancestor", sites);
    expect(() => requireExactSiteRoot(exact, "ancestor")).not.toThrow();
  });

  it("uses the requested root in the missing-site error", () => {
    expect(() => requireExactSiteRoot(null, "gone")).toThrow(
      "Not a detected site: gone",
    );
  });
});
