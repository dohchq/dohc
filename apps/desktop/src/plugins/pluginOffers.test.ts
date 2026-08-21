import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import {
  OfferedPluginAddError,
  addOfferedPlugin,
  listOfferedPlugins,
} from "./pluginOffers";

const roots: string[] = [];

async function createFixture(): Promise<{
  root: string;
  builtinPluginsRoot: string;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-"));
  roots.push(root);
  const builtinPluginsRoot = join(root, "builtin-plugins");
  const workspaceRoot = join(root, "workspace");

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
      listOfferedPlugins(fixture.builtinPluginsRoot, fixture.workspaceRoot),
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
      listOfferedPlugins(fixture.builtinPluginsRoot, fixture.workspaceRoot),
    ).resolves.toEqual([]);
  });
});

describe("addOfferedPlugin", () => {
  it("copies source files and excludes generated or private directories", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.builtinPluginsRoot, "codex");
    await Promise.all([
      mkdir(join(sourceRoot, "node_modules", "dependency"), { recursive: true }),
      mkdir(join(sourceRoot, ".dohc"), { recursive: true }),
      mkdir(join(sourceRoot, "dist"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sourceRoot, "node_modules", "dependency", "marker"), "no"),
      writeFile(join(sourceRoot, ".dohc", "marker"), "no"),
      writeFile(join(sourceRoot, "dist", "marker"), "no"),
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
    for (const excluded of ["node_modules", ".dohc", "dist"]) {
      await expect(lstat(join(result.rootPath, excluded))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
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
});
