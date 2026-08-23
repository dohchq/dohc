import { describe, expect, it, vi } from "vitest";
import {
  createOwnedStaticSiteFileSource,
  prepareOwnedStaticSitePreview,
} from "./ownedStaticSiteFileSource";
import type { SitePackageInfo } from "./sitePackage";

function sharedSite(): SitePackageInfo {
  return {
    root: "shared-with-me/owner/portal",
    title: "Portal",
    kind: "package",
    confidence: "high",
    entryPath: "shared-with-me/owner/portal/index.html",
    configPath: null,
    packagePath: "shared-with-me/owner/portal/package.json",
    packageManager: "pnpm",
    scripts: { build: "vite build" },
    configuredScripts: {},
    configuredPreviewMode: null,
    configuredBuildOutput: null,
    buildOutputs: ["dist"],
    sourceFiles: [
      "shared-with-me/owner/portal/dist/index.html",
      "shared-with-me/owner/portal/dist/assets/app.js",
    ],
    shareManifest: {
      ok: true,
      manifest: {
        entryPath: "shared-with-me/owner/portal/dist/index.html",
        assets: ["shared-with-me/owner/portal/dist/assets/app.js"],
      },
    },
    diagnostics: [],
    authority: { kind: "share", mountRoot: "shared-with-me/owner" },
  };
}

describe("createOwnedStaticSiteFileSource", () => {
  it("binds allowed requests to one explicit owner target and root", async () => {
    const target = {
      kind: "mount" as const,
      workspaceId: "host",
      shareId: "share",
    };
    const read = vi.fn(async () => Buffer.from("owner bytes"));
    const source = createOwnedStaticSiteFileSource({
      servedPaths: ["index.html", "assets/app.js"],
      target,
      ownerRootPath: "site/dist",
      read,
    });

    expect(source.contains("index.html")).toBe(true);
    expect(source.contains("recipient-only.js")).toBe(false);
    await expect(source.read("assets/app.js")).resolves.toEqual(
      Buffer.from("owner bytes"),
    );
    expect(read).toHaveBeenCalledWith(target, "site/dist/assets/app.js");
    await expect(source.read("recipient-only.js")).rejects.toThrow(
      /unavailable/i,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not add a dot segment for a standalone owner root", async () => {
    const read = vi.fn(async () => new Uint8Array());
    const target = { kind: "standalone" as const, workspaceId: "shared" };
    const source = createOwnedStaticSiteFileSource({
      servedPaths: ["index.html"],
      target,
      ownerRootPath: ".",
      read,
    });

    await source.read("index.html");
    expect(read).toHaveBeenCalledWith(target, "index.html");
  });

  it("prepares a shared preview through one owner target for its whole lifetime", async () => {
    const target = {
      kind: "mount" as const,
      workspaceId: "host",
      shareId: "share-owner",
    };
    const resolveOwner = vi.fn(async () => ({
      target,
      path: "portal/dist",
    }));
    const readOwner = vi.fn(async () => Buffer.from("owner bytes"));

    const preview = await prepareOwnedStaticSitePreview({
      site: sharedSite(),
      sharedView: false,
      resolveOwner,
      readOwner,
    });

    expect(preview.root).toBe("shared-with-me/owner/portal/dist");
    expect(preview.entry).toBe("index.html");
    expect(resolveOwner).toHaveBeenCalledOnce();
    expect(resolveOwner).toHaveBeenCalledWith(
      "shared-with-me/owner/portal/dist",
    );
    expect(preview.fileSource?.contains("assets/app.js")).toBe(true);
    expect(preview.fileSource?.contains("recipient-only.js")).toBe(false);
    await expect(
      preview.fileSource?.read("assets/app.js"),
    ).resolves.toEqual(Buffer.from("owner bytes"));
    expect(readOwner).toHaveBeenCalledWith(
      target,
      "portal/dist/assets/app.js",
    );
    expect(resolveOwner).toHaveBeenCalledOnce();
  });

  it("does not create an owner interface for a local preview", async () => {
    const site = {
      ...sharedSite(),
      root: "portal",
      entryPath: "portal/index.html",
      sourceFiles: ["portal/index.html"],
      buildOutputs: [],
      scripts: {},
      packagePath: null,
      packageManager: null,
      authority: { kind: "workspace" as const },
    };
    const resolveOwner = vi.fn();
    const readOwner = vi.fn();

    const preview = await prepareOwnedStaticSitePreview({
      site,
      sharedView: false,
      resolveOwner,
      readOwner,
    });

    expect(preview).toEqual({ root: "portal", entry: "index.html" });
    expect(resolveOwner).not.toHaveBeenCalled();
    expect(readOwner).not.toHaveBeenCalled();
  });
});
