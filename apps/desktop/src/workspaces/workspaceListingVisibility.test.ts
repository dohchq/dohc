import { prepareVisibilityPolicy } from "@dohc/security-contract/visibility-policy";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy, resolveEngineSearchPolicy } from "./workspaceEnginePolicyFile";
import * as metadata from "./workspaceMetadata";
import * as policyFile from "./workspaceEnginePolicyFile";
import { readWorkspaceListingVisibility } from "./workspaceListingVisibility";

const listing = {
  files: ["visible.md", "private/hidden.md", "private/nested/hidden.md", "private/nested/public.md", "app/index.html", "data/records.md"].map(path => ({ path, kind: "file" as const })),
  folders: ["private", "private/nested", "app", "data"],
};
const rules = [
  '[[rule]]', 'path = "private"', 'visibility = "hidden"',
  '[[rule]]', 'path = "private/**"', 'visibility = "hidden"',
  '[[rule]]', 'path = "private/nested/public.md"', 'visibility = "visible"',
  '[[rule]]', 'path = "app"', 'visibility = "hidden"',
  '[[rule]]', 'path = "data"', 'visibility = "hidden"',
].join("\n");
async function workspace(policy?: string) {
  const rootPath = await createTestScratch("listing-visibility-");
  await mkdir(join(rootPath, ".dohc"));
  if (policy !== undefined) await writeFile(join(rootPath, ".dohc/visibility.toml"), policy);
  return { rootPath };
}
describe("workspace listing visibility", () => {
  it("reports hidden files, nested descendants and app and Collection roots with search's verdicts", async () => {
    const owner = await workspace(rules);
    const visibility = await readWorkspaceListingVisibility(owner);
    expect(visibility.status).toBe("ready");
    const visibilityForPath = prepareVisibilityPolicy(visibility.rules);
    expect([...listing.files.map(file => file.path), ...listing.folders].filter(path => visibilityForPath(path).visibility === "hidden")).toEqual([
      "private/hidden.md", "private/nested/hidden.md", "private", "private/nested", "app", "data",
    ]);
    const search = resolveEngineSearchPolicy(await readWorkspaceEnginePolicy(owner.rootPath));
    expect(search.kind).toBe("search");
    if (search.kind !== "search") throw new Error("Policy unexpectedly blocked search");
    for (const path of [...listing.files.map(file => file.path), ...listing.folders]) {
      const searchable = search.fileVisibility({ path } as Parameters<typeof search.fileVisibility>[0]).searchable;
      expect(visibilityForPath(path).visibility !== "hidden", path).toBe(searchable);
    }
    expect(ListWorkspaceFilesResult.parse({ ...listing, visibility }).visibility).toEqual(visibility);
  });
  it("reports missing policy as ready with nothing hidden", async () => {
    expect(await readWorkspaceListingVisibility(await workspace())).toEqual({ status: "ready", rules: [] });
  });
  it("does not turn the search path floor or files.toml into visibility rules", async () => {
    const owner = await workspace();
    await writeFile(join(owner.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "**"\ntracked = false');
    expect(await readWorkspaceListingVisibility(owner)).toEqual({ status: "ready", rules: [] });
  });
  it.each(['[[rule]]\npath = "private/**"\nvisibility = "oops"', 'rule = "oops"'])("fails closed like search on malformed policy %s", async policy => {
    const owner = await workspace(policy);
    expect(await readWorkspaceListingVisibility(owner)).toEqual({ status: "degraded", rules: [] });
    expect(resolveEngineSearchPolicy(await readWorkspaceEnginePolicy(owner.rootPath)).kind).toBe("blocked");
  });
  it("degrades when the visibility policy is not a regular file", async () => {
    const owner = await workspace();
    await mkdir(join(owner.rootPath, ".dohc/visibility.toml"));
    expect((await readWorkspaceListingVisibility(owner)).status).toBe("degraded");
  });
  it("withholds verdicts if evaluation cannot complete", async () => {
    const spy = vi.spyOn(policyFile, "readWorkspaceVisibilityPolicy").mockRejectedValueOnce(new Error("unavailable"));
    try { expect(await readWorkspaceListingVisibility({ rootPath: "unused" })).toEqual({ status: "unavailable", rules: [] }); }
    finally { spy.mockRestore(); }
  });
});

 it("does not turn an unresolved existing policy directory into a missing policy", async () => {
  const owner = await workspace(rules);
  const spy = vi.spyOn(metadata, "resolveWorkspaceMetadataDir").mockResolvedValueOnce(null);
  try { expect((await readWorkspaceListingVisibility(owner)).status).toBe("degraded"); }
  finally { spy.mockRestore(); }
 });
 it("reports ready without creating a missing metadata directory", async () => {
  const rootPath = await createTestScratch("listing-missing-metadata-");
  expect(await readWorkspaceListingVisibility({ rootPath })).toEqual({ status: "ready", rules: [] });
  const { lstat } = await import("node:fs/promises");
  await expect(lstat(join(rootPath, ".dohc"))).rejects.toMatchObject({ code: "ENOENT" });
 });
 it("degrades rather than widening names when the workspace root is unavailable", async () => {
  const rootPath = await createTestScratch("listing-missing-root-");
  expect((await readWorkspaceListingVisibility({ rootPath: join(rootPath, "missing") })).status).toBe("degraded");
 });

 it("leaves received-share paths under their canonical selector instead of the host policy", async () => {
  const owner = await workspace('[[rule]]\npath = "**"\nvisibility = "hidden"');
  const mount = { shareId: "share-a", label: "team", granterEmail: "alice@example.com", relayUrl: "https://relay.example", grantedSelector: { paths: [], versionId: "main", access: "view" as const } };
  expect(await readWorkspaceListingVisibility(owner)).toEqual({ status: "ready", rules: [{ path: "**", visibility: "hidden" }] });
  expect(await readWorkspaceListingVisibility({ ...owner, shareView: { shareId: mount.shareId, granterEmail: mount.granterEmail, genericChatWritable: false, grantedSelector: mount.grantedSelector } })).toEqual({ status: "ready", rules: [] });
 });

 it("round2 never shows a hidden Collection or app arriving before listing refresh", async () => {
  const owner = await workspace('[[rule]]\npath = "private/**"\nvisibility = "hidden"');
  const snapshot = { files: [], folders: [] };
  const visibility = await readWorkspaceListingVisibility(owner);
  const { GoToIndex } = await import("../renderer/workbench/quick-open-rank");
  const index = new GoToIndex("workspace");
  index.update({ listing: { ...snapshot, visibility, receivedRoots: [] } });
  index.update({ collections: [{ path: "private/crm", objectId: "crm" }], apps: [{ root: "private/app", title: "Private app" }] });
  expect(index.query("crm")).toEqual([]);
  expect(index.query("Private app")).toEqual([]);
 });

 it("leaves Go to ready on malformed files.toml while search blocks", async () => {
  const owner = await workspace();
  await writeFile(join(owner.rootPath, ".dohc/files.toml"), 'rule = "broken"');
  expect(await readWorkspaceListingVisibility(owner)).toEqual({ status: "ready", rules: [] });
  expect(resolveEngineSearchPolicy(await readWorkspaceEnginePolicy(owner.rootPath)).kind).toBe("blocked");
 });
