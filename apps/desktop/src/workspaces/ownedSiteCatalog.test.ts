import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePathListing } from "../ipc/bridgeContract";
import { createOwnedWorkspaceReadPort } from "./ownedWorkspaceReadPort";
import { matchesFileListingScope } from "./workspaceFileListingScope";
import { createOwnedSiteCatalog } from "./ownedSiteCatalog";
import { createTestScratch } from "./testTemp";

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-owned-site-catalog-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function catalogWith(listing: WorkspacePathListing) {
  const reads = createOwnedWorkspaceReadPort({
    hasShareState: false, searchSources: [], repairProjection: async () => undefined,
    listFiles: vi.fn(async scope => ({ ...listing, files: listing.files.filter(file => matchesFileListingScope(file.path, scope)) })),
    lookupFiles: vi.fn(async paths => ({ ...listing, files: listing.files.filter(file => paths.includes(file.path)) })),
  });
  const prepare = vi.spyOn(reads, "prepareSearch");
  return { ...createOwnedSiteCatalog({ reads: () => reads }), prepare, reads };
}

async function writeUnownedSite(): Promise<void> {
  await mkdir(join(root, "unowned-site"), { recursive: true });
  await writeFile(
    join(root, "unowned-site", "package.json"),
    JSON.stringify({ scripts: { dev: "vite" } }),
  );
}

describe("owned site catalog", () => {
  it("does not list a raw disk site that its owner listing excludes", async () => {
    await writeUnownedSite();
    const catalog = catalogWith({ files: [], folders: [] });

    await expect(catalog.list({ rootPath: root })).resolves.toEqual([]);
  });

  it("does not rediscover an excluded raw disk site during get", async () => {
    await writeUnownedSite();
    const catalog = catalogWith({ files: [], folders: [] });

    await expect(
      catalog.get({ rootPath: root }, "unowned-site", undefined),
    ).resolves.toBeNull();
  });

  it("forwards the effective preview mode to the selected owned site", async () => {
    await mkdir(join(root, "stale-dist", "dist"), { recursive: true });
    await writeFile(join(root, "stale-dist", "index.html"), "<h1>Source</h1>");
    await writeFile(
      join(root, "stale-dist", "dist", "index.html"),
      "<h1>Stale build</h1>",
    );
    const catalog = catalogWith({
      files: [
        { path: "stale-dist/index.html", kind: "file" },
        { path: "stale-dist/dist/index.html", kind: "file" },
      ],
      folders: ["stale-dist", "stale-dist/dist"],
    });

    const defaultSite = await catalog.get(
      { rootPath: root },
      "stale-dist",
      undefined,
    );
    const staticSite = await catalog.get(
      { rootPath: root },
      "stale-dist",
      "static",
    );

    expect(defaultSite?.shareManifest).toMatchObject({
      ok: true,
      manifest: { entryPath: "stale-dist/dist/index.html" },
    });
    expect(staticSite?.shareManifest).toMatchObject({
      ok: true,
      manifest: { entryPath: "stale-dist/index.html" },
    });
  });

  it("propagates owner preparation failures without falling back to disk", async () => {
    await writeUnownedSite();
    const listFiles = vi.fn(async () => ({ files: [], folders: [] }));
    const catalog = createOwnedSiteCatalog({
      reads: vi.fn(() => ({
        prepareLookup: async () => { throw Error("Canonical owner unavailable."); },
        prepareSearch: vi.fn(async () => {
          throw new Error("Canonical owner unavailable.");
        }),
        listFiles,
      })),
    });

    await expect(catalog.list({ rootPath: root })).rejects.toThrow(
      "Canonical owner unavailable.",
    );
    await expect(
      catalog.get({ rootPath: root }, "unowned-site", undefined),
    ).rejects.toThrow("Canonical owner unavailable.");
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("uses the local file listing when search preparation needs no owner filter", async () => {
    await writeUnownedSite();
    const listing = { files: [], folders: [] };
    const listFiles = vi.fn(async () => listing);
    const catalog = createOwnedSiteCatalog({
      reads: vi.fn(() => ({
        prepareLookup: async () => { throw Error("Canonical owner unavailable."); },
        prepareSearch: vi.fn(async () => ({
          listing: null,
          allowPath: () => true,
        })),
        listFiles,
      })),
    });

    await expect(catalog.list({ rootPath: root })).resolves.toEqual([]);
    expect(listFiles).toHaveBeenCalledOnce();
  });

  it("uses the prepared owner listing without reading raw workspace files", async () => {
    await writeUnownedSite();
    const listFiles = vi.fn(async () => ({
      files: [{ path: "unowned-site/package.json", kind: "file" as const }],
      folders: ["unowned-site"],
    }));
    const catalog = createOwnedSiteCatalog({
      reads: vi.fn(() => ({
        prepareLookup: async () => { throw Error("Canonical owner unavailable."); },
        prepareSearch: vi.fn(async () => ({
          listing: { files: [], folders: [] },
          allowPath: () => false,
        })),
        listFiles,
      })),
    });

    await expect(catalog.list({ rootPath: root })).resolves.toEqual([]);
    expect(listFiles).not.toHaveBeenCalled();
  });
});

it("matches the old catalog for files, folders, missing paths, nested apps, and configured output", async () => {
  const bodies: Record<string, string> = {
    "portal/dohc.json": JSON.stringify({ type: "app", build: { output: "public/dist" } }),
    "portal/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "portal/public/dist/index.html": "<h1>built</h1>",
    "portal/src/readme.txt": "source",
    "portal/child/index.html": "<h1>child</h1>",
    "other/index.html": "<h1>unrelated</h1>",
  };
  for (const [path, body] of Object.entries(bodies)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  const listing = { files: Object.keys(bodies).map(path => ({ path, kind: "file" as const })), folders: [] };
  const catalog = catalogWith(listing);
  const { selectListedSitePackage } = await import("../testing/sitePackageTestOracle");
  const old = await catalog.list({ rootPath: root });
  for (const path of ["portal", "portal/src/readme.txt", "portal/src", "portal/missing.txt", "portal/child/missing", "portal/public", "missing"]) {
    catalog.prepare.mockClear();
    vi.mocked(catalog.reads.listFiles).mockClear();
    expect(await catalog.get({ rootPath: root }, path, undefined)).toEqual(await selectListedSitePackage(path, old));
    expect(catalog.prepare).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reads.listFiles).mock.calls.every(([scope]) => scope?.path !== ".")).toBe(true);
  }
});
it("keeps a root app's complete inventory after bounded discovery and rejects excluded metadata", async () => {
  await writeFile(join(root, "index.html"), "<h1>root</h1>");
  await writeFile(join(root, "note.txt"), "note");
  await writeUnownedSite();
  const listing = { files: ["index.html", "note.txt"].map(path => ({ path, kind: "file" as const })), folders: [] };
  const catalog = catalogWith(listing);
  const old = await catalog.list({ rootPath: root });
  const { selectListedSitePackage } = await import("../testing/sitePackageTestOracle");
  for (const path of [".", "note.txt", "missing", "unowned-site", ".dohc/private", "./note.txt"]) {
    expect(await catalog.get({ rootPath: root }, path, undefined)).toEqual(await selectListedSitePackage(path, old));
  }
});

it.each(["app/", "app//x", "app/./x", "app/../x"])("matches listing selection for non-normalized input %s", async path => {
  await writeFile(join(root, "index.html"), "<h1>root</h1>");
  await mkdir(join(root, "app"));
  await writeFile(join(root, "app/index.html"), "<h1>app</h1>");
  const catalog = catalogWith({ files: ["index.html", "app/index.html"].map(path => ({ path, kind: "file" as const })), folders: [] });
  const { selectListedSitePackage } = await import("../testing/sitePackageTestOracle");
  const listed = await catalog.list({ rootPath: root });
  const selected = await catalog.get({ rootPath: root }, path, undefined);
  expect(selected?.root).toBe("app");
  expect(selected).toEqual(selectListedSitePackage(path, listed));
});

it("selects a one-character nested app ahead of the workspace-root app", async () => {
  await writeFile(join(root, "index.html"), "<h1>root</h1>");
  await mkdir(join(root, "a"));
  await writeFile(join(root, "a/index.html"), "<h1>nested</h1>");
  const catalog = catalogWith({ files: ["index.html", "a/index.html"].map(path => ({ path, kind: "file" as const })), folders: [] });
  expect((await catalog.get({ rootPath: root }, "a/x", undefined))?.root).toBe("a");
});
