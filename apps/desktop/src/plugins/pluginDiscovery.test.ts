import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverInstalledPlugins } from "./pluginDiscovery";
import { PLUGIN_MANIFEST_FILE_NAME } from "./pluginManifest";

const roots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-discovery-"));
  roots.push(root);
  await mkdir(join(root, "plugins"));
  return root;
}

async function writeManifest(
  root: string,
  directoryName: string,
  name = directoryName,
): Promise<string> {
  const pluginRoot = join(root, "plugins", directoryName);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, PLUGIN_MANIFEST_FILE_NAME),
    JSON.stringify({ version: 1, name, entry: "src/index.ts" }),
  );
  return pluginRoot;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("discoverInstalledPlugins", () => {
  it("discovers direct roots and reports nested manifests on their direct-child candidate", async () => {
    const root = await createWorkspace();
    const pluginRoot = await writeManifest(root, "directory-name", "manifest-name");
    const nestedManifest = join(pluginRoot, "panel", PLUGIN_MANIFEST_FILE_NAME);
    await mkdir(join(pluginRoot, "panel"));
    await writeFile(
      nestedManifest,
      JSON.stringify({ version: 1, name: "ignored-panel", entry: "index.ts" }),
    );

    expect(await discoverInstalledPlugins(root)).toEqual([
      {
        id: "manifest-name",
        directoryName: "directory-name",
        rootPath: pluginRoot,
        manifest: {
          version: 1,
          name: "manifest-name",
          entry: "src/index.ts",
        },
        diagnostics: [
          "nested manifest ignored at plugins/directory-name/panel/dohc-plugin.json",
        ],
        valid: true,
      },
    ]);
  });

  it("keeps the lexically-first duplicate id valid and invalidates later roots", async () => {
    const root = await createWorkspace();
    const zetaRoot = await writeManifest(root, "zeta", "shared-id");
    const alphaRoot = await writeManifest(root, "alpha", "shared-id");

    const records = await discoverInstalledPlugins(root);

    expect(records.map((record) => record.directoryName)).toEqual(["alpha", "zeta"]);
    expect(records[0]).toMatchObject({ id: "shared-id", rootPath: alphaRoot, valid: true });
    expect(records[1]).toMatchObject({ id: "shared-id", rootPath: zetaRoot, valid: false });
    expect(records[1]?.diagnostics).toContain(
      `duplicate plugin id "shared-id": also declared at ${alphaRoot}`,
    );
  });

  it("retains invalid and missing manifests as invalid candidates", async () => {
    const root = await createWorkspace();
    const invalidRoot = join(root, "plugins", "invalid-json");
    const missingRoot = join(root, "plugins", "missing-manifest");
    await mkdir(invalidRoot);
    await mkdir(missingRoot);
    await writeFile(join(invalidRoot, PLUGIN_MANIFEST_FILE_NAME), "{not json");

    const records = await discoverInstalledPlugins(root);

    expect(records.map((record) => record.directoryName)).toEqual([
      "invalid-json",
      "missing-manifest",
    ]);
    expect(records[0]).toMatchObject({ id: "invalid-json", manifest: null, valid: false });
    expect(records[0]?.diagnostics[0]).toMatch(/^dohc-plugin\.json is not valid JSON:/);
    expect(records[1]).toMatchObject({ id: "missing-manifest", manifest: null, valid: false });
    expect(records[1]?.diagnostics[0]).toContain("dohc-plugin.json was not found at");
  });

  it("rejects a symlinked plugin root without reading through it", async () => {
    const root = await createWorkspace();
    const targetRoot = join(root, "outside-plugin");
    await mkdir(targetRoot);
    await writeFile(
      join(targetRoot, PLUGIN_MANIFEST_FILE_NAME),
      JSON.stringify({ version: 1, name: "escaped-plugin", entry: "index.ts" }),
    );
    const linkedRoot = join(root, "plugins", "linked-plugin");
    await symlink(targetRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    expect(await discoverInstalledPlugins(root)).toEqual([
      {
        id: "linked-plugin",
        directoryName: "linked-plugin",
        rootPath: linkedRoot,
        manifest: null,
        diagnostics: [
          `plugin root at ${linkedRoot} is a symlink; plugin roots must be real directories`,
        ],
        valid: false,
      },
    ]);
  });

  it("returns records in stable lexical directory order and ignores direct files", async () => {
    const root = await createWorkspace();
    await writeManifest(root, "charlie");
    await writeManifest(root, "alpha");
    await writeManifest(root, "bravo");
    await writeFile(join(root, "plugins", "not-a-plugin.json"), "{}\n");

    const records = await discoverInstalledPlugins(root);
    expect(records.map((record) => record.directoryName)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ directoryName: "alpha", valid: true }),
        expect.objectContaining({ directoryName: "bravo", valid: true }),
        expect.objectContaining({ directoryName: "charlie", valid: true }),
      ]),
    );
  });

  it("returns no candidates when the workspace has no plugins directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-plugin-discovery-empty-"));
    roots.push(root);

    await expect(discoverInstalledPlugins(root)).resolves.toEqual([]);
  });
});
