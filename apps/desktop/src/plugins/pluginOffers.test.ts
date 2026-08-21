import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import { discoverInstalledPlugins } from "./pluginDiscovery";
import {
  OfferedPluginAddError,
  addOfferedPlugin,
  listOfferedPlugins,
} from "./pluginOffers";

const roots: string[] = [];
const NO_EXISTING_PLUGIN_IDS = new Set<string>();

async function createFixture(): Promise<{
  root: string;
  builtinPluginsRoot: string;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-"));
  roots.push(root);
  const builtinPluginsRoot = join(root, "builtin-plugins");
  // A real workspace root always exists before any plugin operation runs —
  // dohc only opens an already-materialized folder — so the fixture matches
  // that rather than leaving addOfferedPlugin's realpath() call to hit an
  // ENOENT this function was never meant to paper over.
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
    const pluginRoot = join(builtinPluginsRoot, directoryName);
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: directoryName,
        displayName: `${directoryName} driver`,
        description: `Runs ${directoryName}`,
        publisher: "dohc",
        entry: "src/main.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");
  }

  return { root, builtinPluginsRoot, workspaceRoot };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

describe("listOfferedPlugins", () => {
  it("offers both built-in drivers when neither exists in the workspace", async () => {
    const fixture = await createFixture();

    const offers = await listOfferedPlugins(
      fixture.builtinPluginsRoot,
      fixture.workspaceRoot,
      NO_EXISTING_PLUGIN_IDS,
    );

    expect(offers.map((offer) => offer.directoryName)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(offers[0]).toMatchObject({
      displayName: "codex driver",
      description: "Runs codex",
      publisher: "dohc",
    });
  });

  it("does not offer a driver whose workspace directory exists in any state", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workspaceRoot, "plugins", "codex"), {
      recursive: true,
    });

    await expect(
      listOfferedPlugins(
        fixture.builtinPluginsRoot,
        fixture.workspaceRoot,
        NO_EXISTING_PLUGIN_IDS,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ directoryName: "claude-code" }),
    ]);
  });

  it("returns no offers when both workspace directories exist", async () => {
    const fixture = await createFixture();
    await Promise.all(
      BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES.map((directoryName) =>
        mkdir(join(fixture.workspaceRoot, "plugins", directoryName), {
          recursive: true,
        }),
      ),
    );

    await expect(
      listOfferedPlugins(
        fixture.builtinPluginsRoot,
        fixture.workspaceRoot,
        NO_EXISTING_PLUGIN_IDS,
      ),
    ).resolves.toEqual([]);
  });

  // Identity is the manifest id, not the directory: a driver copied and then
  // renamed by hand (or an agent) still claims the id "codex", and offering
  // "codex" again would only degrade to discovery's existing duplicate-id
  // handling on install, never a clean one.
  it("suppresses an offer whose manifest id already exists under a different directory", async () => {
    const fixture = await createFixture();
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "my-codex");
    await mkdir(join(renamedRoot, "src"), { recursive: true });
    await writeFile(
      join(renamedRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(renamedRoot, "src", "main.ts"), "export default {};\n");

    const discovered = await discoverInstalledPlugins(fixture.workspaceRoot, new Map());
    const existingPluginIds = new Set(discovered.map((plugin) => plugin.id));

    await expect(
      listOfferedPlugins(fixture.builtinPluginsRoot, fixture.workspaceRoot, existingPluginIds),
    ).resolves.toEqual([
      expect.objectContaining({ directoryName: "claude-code" }),
    ]);
  });
});

describe("addOfferedPlugin", () => {
  it("copies source files and excludes generated or private directories", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.builtinPluginsRoot, "codex");
    await Promise.all([
      mkdir(join(sourceRoot, "node_modules", "dependency"), { recursive: true }),
      mkdir(join(sourceRoot, ".dohc"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sourceRoot, "node_modules", "dependency", "marker"), "no"),
      writeFile(join(sourceRoot, ".dohc", "marker"), "no"),
    ]);

    const result = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
    });

    expect(result.rootPath).toBe(join(fixture.workspaceRoot, "plugins", "codex"));
    await expect(readFile(join(result.rootPath, "src", "main.ts"), "utf8"))
      .resolves.toBe("export default {};\n");
    await expect(readFile(join(result.rootPath, "dohc-plugin.json"), "utf8"))
      .resolves.toContain('"name": "codex"');
    for (const excluded of ["node_modules", ".dohc"]) {
      await expect(lstat(join(result.rootPath, excluded))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("stages under .dohc, never inside plugins/, invisible to discovery", async () => {
    const fixture = await createFixture();
    // A real, already-installed plugin, so discovery is genuinely scanning
    // plugins/ in this test rather than short-circuiting on an absent
    // directory.
    const otherPluginRoot = join(fixture.workspaceRoot, "plugins", "claude-code");
    await mkdir(join(otherPluginRoot, "src"), { recursive: true });
    await writeFile(
      join(otherPluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "claude-code", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(otherPluginRoot, "src", "main.ts"), "export default {};\n");

    // Simulates a file sitting in the staging path mid-copy: since the
    // staging root lives under workspaceRoot/.dohc rather than
    // workspaceRoot/plugins, discovery — which only ever reads
    // workspaceRoot/plugins/* — structurally cannot see it, at any point in
    // time, not just the moment this snapshot happens to sample.
    const stagingDir = join(
      fixture.workspaceRoot,
      ".dohc",
      "plugin-offer-staging",
      `codex-${randomUUID()}`,
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "dohc-plugin.json"), "{}");

    const discovered = await discoverInstalledPlugins(fixture.workspaceRoot, new Map());

    expect(discovered.map((plugin) => plugin.directoryName)).toEqual(["claude-code"]);
  });

  it("refuses an existing target without changing its contents", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep");

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OfferedPluginAddError &&
        error.message.includes("plugins/codex"),
    );
    await expect(readFile(join(target, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(lstat(join(target, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses directory names outside the built-in driver set", async () => {
    const fixture = await createFixture();

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "sites",
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);
  });

  // A hostile or corrupted sync could plant plugins/ as a junction pointing
  // outside the workspace before this ever runs. mkdir({recursive:true})
  // would follow that transparently, so the fix has to refuse before any
  // write, not merely detect the escape after one already landed.
  it("refuses when plugins/ is a junction pointing outside the workspace", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-outside-"));
    roots.push(outside);
    await symlink(
      outside,
      join(fixture.workspaceRoot, "plugins"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // Nothing landed outside the workspace through the link.
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
