import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListPluginsResult } from "../ipc/bridgeContract";
import { PLUGIN_MANIFEST_FILE_NAME } from "./pluginManifest";

// A pure JS-level interception (never real filesystem permissions, which
// Windows can't simulate the same way POSIX chmod can) — lets a single test
// make one specific nested directory's readdir fail, without touching how
// every other test in this file reads real fixture directories.
let poisonedPath: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (path: Parameters<typeof readdir>[0], options?: unknown) => {
      if (poisonedPath !== null && String(path) === poisonedPath) {
        throw Object.assign(
          new Error("EACCES: permission denied, scandir"),
          { code: "EACCES" },
        );
      }
      return actual.readdir(path as string, options as never);
    }) as typeof readdir,
  };
});

const { discoverInstalledPlugins } = await import("./pluginDiscovery");

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
  poisonedPath = null;
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

    expect(await discoverInstalledPlugins(root, new Map())).toEqual([
      {
        id: "manifest-name",
        directoryName: "directory-name",
        rootPath: pluginRoot,
        manifest: {
          version: 1,
          name: "manifest-name",
          entry: "src/index.ts",
        },
        iconPath: null,
        diagnostics: [
          "nested manifest ignored at plugins/directory-name/panel/dohc-plugin.json",
        ],
        valid: true,
        supersededPluginId: null,
      },
    ]);
  });

  it("keeps the lexically-first duplicate id valid and invalidates later roots", async () => {
    const root = await createWorkspace();
    const zetaRoot = await writeManifest(root, "zeta", "shared-id");
    const alphaRoot = await writeManifest(root, "alpha", "shared-id");

    const records = await discoverInstalledPlugins(root, new Map());

    expect(records.map((record) => record.directoryName)).toEqual(["alpha", "zeta"]);
    expect(records[0]).toMatchObject({
      id: "shared-id",
      rootPath: alphaRoot,
      valid: true,
      supersededPluginId: null,
    });
    // The loser keeps no claim on the shared id: its directory names it, so
    // no two records ever report one id (#779 round 14 A4). It carries the
    // lost id structurally too, not only in its diagnostics text — a
    // caller that needs to detect this collision reads that field, never
    // scans diagnostic prose (#779-offers round 8 finding 5).
    expect(records[1]).toMatchObject({
      id: "zeta",
      rootPath: zetaRoot,
      valid: false,
      supersededPluginId: "shared-id",
    });
    expect(records[1]?.diagnostics).toContain(
      `duplicate plugin id "shared-id": also declared at ${alphaRoot}`,
    );
  });

  it("keeps a duplicate id with the directory it was installed from (#779 round 11 A4)", async () => {
    const root = await createWorkspace();
    const zetaRoot = await writeManifest(root, "zeta", "shared-id");
    const alphaRoot = await writeManifest(root, "alpha", "shared-id");

    // "shared-id" was installed from zeta/. alpha/ sorts first, but sorting
    // first is not ownership: alpha/ must not take zeta/'s id.
    const records = await discoverInstalledPlugins(
      root,
      new Map([["shared-id", "zeta"]]),
    );

    expect(records[0]).toMatchObject({
      id: "alpha",
      directoryName: "alpha",
      rootPath: alphaRoot,
      valid: false,
    });
    expect(records[0]?.diagnostics).toContain(
      `duplicate plugin id "shared-id": also declared at ${zetaRoot}`,
    );
    expect(records[1]).toMatchObject({
      directoryName: "zeta",
      rootPath: zetaRoot,
      valid: true,
    });
    expect(records[1]?.diagnostics).toEqual([]);
  });

  it("retains invalid and missing manifests as invalid candidates", async () => {
    const root = await createWorkspace();
    const invalidRoot = join(root, "plugins", "invalid-json");
    const missingRoot = join(root, "plugins", "missing-manifest");
    await mkdir(invalidRoot);
    await mkdir(missingRoot);
    await writeFile(join(invalidRoot, PLUGIN_MANIFEST_FILE_NAME), "{not json");

    const records = await discoverInstalledPlugins(root, new Map());

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

    expect(await discoverInstalledPlugins(root, new Map())).toEqual([
      {
        id: "linked-plugin",
        directoryName: "linked-plugin",
        rootPath: linkedRoot,
        manifest: null,
        iconPath: null,
        diagnostics: [
          `plugin root at ${linkedRoot} is a symlink; plugin roots must be real directories`,
        ],
        valid: false,
        supersededPluginId: null,
      },
    ]);
  });

  it("returns records in stable lexical directory order and ignores direct files", async () => {
    const root = await createWorkspace();
    await writeManifest(root, "charlie");
    await writeManifest(root, "alpha");
    await writeManifest(root, "bravo");
    await writeFile(join(root, "plugins", "not-a-plugin.json"), "{}\n");

    const records = await discoverInstalledPlugins(root, new Map());
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

    await expect(discoverInstalledPlugins(root, new Map())).resolves.toEqual([]);
  });

  it("does not walk into node_modules or .dohc for nested manifests (CodeRabbit #779 R11)", async () => {
    const root = await createWorkspace();
    const pluginRoot = await writeManifest(root, "with-deps");
    await mkdir(join(pluginRoot, "node_modules", "dep"), { recursive: true });
    await writeFile(
      join(pluginRoot, "node_modules", "dep", PLUGIN_MANIFEST_FILE_NAME),
      JSON.stringify({ version: 1, name: "dep-manifest", entry: "index.ts" }),
    );
    await mkdir(join(pluginRoot, ".dohc"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".dohc", PLUGIN_MANIFEST_FILE_NAME),
      JSON.stringify({ version: 1, name: "generated-manifest", entry: "index.ts" }),
    );

    const records = await discoverInstalledPlugins(root, new Map());

    expect(records).toEqual([
      expect.objectContaining({ directoryName: "with-deps", diagnostics: [], valid: true }),
    ]);
  });

  it("keeps a candidate isolated when one of its nested directories cannot be read (CodeRabbit #779 R12)", async () => {
    const root = await createWorkspace();
    await writeManifest(root, "alpha");
    const brokenRoot = await writeManifest(root, "broken");
    const lockedDir = join(brokenRoot, "locked");
    await mkdir(lockedDir);
    poisonedPath = lockedDir;

    const records = await discoverInstalledPlugins(root, new Map());

    expect(records.map((record) => record.directoryName)).toEqual(["alpha", "broken"]);
    expect(records[0]).toMatchObject({ directoryName: "alpha", valid: true });
    expect(records[1]).toMatchObject({ directoryName: "broken", manifest: null, valid: false });
    expect(records[1]?.diagnostics[0]).toContain("could not be fully inspected");
    expect(records[1]?.diagnostics[0]).toContain(brokenRoot);
  });

  it("bounds the fallback id so one over-long directory cannot reject the whole list", async () => {
    const root = await createWorkspace();
    await writeManifest(root, "alpha");
    // A directory name may be 255 characters; a plugin id may be 214. With no
    // manifest to name the plugin, the unbounded fallback made
    // ListPluginsResult.parse reject every record, including this one's own
    // diagnostics.
    const overLongName = "b".repeat(255);
    await mkdir(join(root, "plugins", overLongName));

    const records = await discoverInstalledPlugins(root, new Map());

    expect(records.map((record) => record.directoryName)).toEqual([
      "alpha",
      overLongName,
    ]);
    const invalid = records[1];
    expect(invalid).toMatchObject({ manifest: null, valid: false });
    expect(invalid?.id).toBe("b".repeat(214));
    expect(invalid?.directoryName).toBe(overLongName);
    expect(invalid?.diagnostics.join(" ")).toContain("at most 214 characters");

    const parsed = ListPluginsResult.safeParse({
      ok: true,
      plugins: records.map((record) => ({
        id: record.id,
        directoryName: record.directoryName,
        rootPath: record.rootPath,
        valid: record.valid,
        status: "discovered",
        disabledReason: null,
        runtimeStatus: null,
        sourceHash: null,
        approvedHash: null,
        installedBaselineHash: null,
        displayName: record.manifest?.displayName ?? null,
        description: record.manifest?.description ?? null,
        publisher: record.manifest?.publisher ?? null,
        pluginVersion: record.manifest?.pluginVersion ?? null,
        repository: record.manifest?.repository ?? null,
        issues: record.manifest?.issues ?? null,
        license: record.manifest?.license ?? null,
        icon: record.iconPath,
        settings: record.manifest?.settings ?? [],
        panels: [],
        webApps: [],
        diagnostics: record.diagnostics,
        warnings: [],
        error: null,
      })),
    });

    expect(parsed.success).toBe(true);
  });

  describe("manifest icon", () => {
    async function writeIconManifest(
      root: string,
      directoryName: string,
      icon: string,
    ): Promise<string> {
      const pluginRoot = join(root, "plugins", directoryName);
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, PLUGIN_MANIFEST_FILE_NAME),
        JSON.stringify({
          version: 1,
          name: directoryName,
          displayName: "Iconic",
          description: "Shows an icon.",
          publisher: "dohc",
          icon,
          entry: "src/index.ts",
        }),
      );
      return pluginRoot;
    }

    it("advertises an icon whose file checks out", async () => {
      const root = await createWorkspace();
      const pluginRoot = await writeIconManifest(root, "iconic", "icon.svg");
      await writeFile(join(pluginRoot, "icon.svg"), "<svg/>");

      const [record] = await discoverInstalledPlugins(root, new Map());

      expect(record.iconPath).toBe("icon.svg");
      expect(record.diagnostics).toEqual([]);
      expect(record.valid).toBe(true);
    });

    it("reports a missing icon as a diagnostic and still keeps the plugin valid", async () => {
      const root = await createWorkspace();
      await writeIconManifest(root, "iconic", "icon.svg");

      const [record] = await discoverInstalledPlugins(root, new Map());

      expect(record.iconPath).toBeNull();
      expect(record.diagnostics).toHaveLength(1);
      expect(record.diagnostics[0]).toContain("could not be read");
      // An icon is decoration. A plugin that ships a broken one still runs.
      expect(record.valid).toBe(true);
      expect(record.manifest?.description).toBe("Shows an icon.");
    });

    it("carries no icon when the manifest declares none", async () => {
      const root = await createWorkspace();
      await writeManifest(root, "plain");

      const [record] = await discoverInstalledPlugins(root, new Map());

      expect(record.iconPath).toBeNull();
      expect(record.diagnostics).toEqual([]);
    });
  });
});
