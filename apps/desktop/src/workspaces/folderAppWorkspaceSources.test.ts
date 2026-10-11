import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { readFolderAppWorkspaceSources } from "./folderAppWorkspaceSources";
import { sourceForFile } from "./sitePackage";
import type { ShareViewFilesTarget } from "./shareViewFiles";

let root: string;
beforeEach(async () => { root = await createTestScratch("folder-app-sources-"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const text = (value: string) => ({ text: value, truncated: false as const, contentHash: "hash" });

describe("folder app source authority", () => {
  it("filters shared-with-me paths from the owned listing before discovery", async () => {
    const listOwned = vi.fn(async () => ["shared-with-me/team/index.html", "shared-with-me/team/dohc.json"]);
    const readText = vi.fn(async () => text('{"type":"app"}'));
    const listShare = vi.fn();
    // Even when the disk listing returns a projection, owned recognition must not use it.
    const sources = await readFolderAppWorkspaceSources(root, "shared-with-me/team", {
      reader: { resolveShare: async () => null, readText },
      listOwned, listShare,
    });
    expect(sources).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
    expect(listShare).not.toHaveBeenCalled();
  });
  it.each(["mount", "standalone"] as const)("routes %s files and metadata to the received-share owner", async kind => {
    const folder = kind === "mount" ? "shared-with-me/team/app" : "app";
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, "dohc.json"), "disk projection must not win");
    const target: ShareViewFilesTarget = kind === "mount" ? { kind, workspaceId: "one", shareId: "share" } : { kind, workspaceId: "one" };
    const resolveShare = vi.fn(async () => ({ target, path: "app" }));
    const readText = vi.fn(async () => text('{"type":"app"}'));
    const listOwned = vi.fn(async () => ["wrong/index.html"]);
    const listShare = vi.fn(async () => ({ files: ["app/index.html", "app/dohc.json", "other/dohc.json"].map(path => ({ path, kind: "file" as const })) }));
    const sources = await readFolderAppWorkspaceSources(root, folder, { reader: { resolveShare, readText }, listOwned, listShare });
    expect(resolveShare).toHaveBeenCalledExactlyOnceWith(folder);
    expect(listShare).toHaveBeenCalledExactlyOnceWith(target, { includeContentIdentity: false });
    expect(listOwned).not.toHaveBeenCalled();
    expect(readText).toHaveBeenCalledExactlyOnceWith(folder + "/dohc.json");
    expect(sources).toEqual([folder + "/index.html", { path: folder + "/dohc.json", body: '{"type":"app"}' }]);
  });
  it("uses bounded sourceForFile reads for an owned folder", async () => {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app/package.json"), '{"scripts":{"dev":"vite"}}');
    const sources = await readFolderAppWorkspaceSources(root, "app", {
      reader: { resolveShare: async () => null, readText: vi.fn() },
      listOwned: async () => ["app/package.json", "app/index.html"], listShare: vi.fn(),
    });
    expect(sources).toContainEqual({ path: "app/package.json", body: '{"scripts":{"dev":"vite"}}' });
  });
});

describe("sourceForFile metadata rule", () => {
  it("reads package.json and dohc.json, but does not read ordinary files or unavailable metadata", async () => {
    await writeFile(join(root, "package.json"), "package body");
    await writeFile(join(root, "dohc.json"), "app body");
    expect(await sourceForFile(root, "package.json")).toEqual({ path: "package.json", body: "package body" });
    expect(await sourceForFile(root, "dohc.json")).toEqual({ path: "dohc.json", body: "app body" });
    const metadata = vi.fn();
    expect(await sourceForFile(root, "index.html", metadata)).toBe("index.html");
    expect(metadata).not.toHaveBeenCalled();
    expect(await sourceForFile(root, "missing/package.json")).toEqual({ path: "missing/package.json", body: null });
  });
  it("refuses oversized local and canonical metadata before reading its body", async () => {
    await writeFile(join(root, "dohc.json"), "a".repeat(1024 * 1024 + 1));
    expect(await sourceForFile(root, "dohc.json")).toMatchObject({ body: null, diagnostics: [{ code: "metadata-too-large" }] });
    const read = vi.fn(async () => "oversized");
    expect(await sourceForFile(root, "package.json", async () => ({ size: 1024 * 1024 + 1, read }))).toMatchObject({ body: null, diagnostics: [{ code: "metadata-too-large" }] });
    expect(read).not.toHaveBeenCalled();
  });
});
