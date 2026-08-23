import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { createOwnedSiteCatalog } from "./ownedSiteCatalog";
import { createTestScratch } from "./testTemp";

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-owned-site-catalog-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function catalogWith(listing: ListWorkspaceFilesResult) {
  return createOwnedSiteCatalog({
    listOwnedFiles: vi.fn(async () => listing),
  });
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

  it("propagates owner-list failures instead of falling back to disk", async () => {
    await writeUnownedSite();
    const catalog = createOwnedSiteCatalog({
      listOwnedFiles: vi.fn(async () => {
        throw new Error("Canonical owner unavailable.");
      }),
    });

    await expect(catalog.list({ rootPath: root })).rejects.toThrow(
      "Canonical owner unavailable.",
    );
    await expect(
      catalog.get({ rootPath: root }, "unowned-site", undefined),
    ).rejects.toThrow("Canonical owner unavailable.");
  });
});
