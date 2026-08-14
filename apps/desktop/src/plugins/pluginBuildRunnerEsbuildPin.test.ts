// A dedicated file (not merged into pluginBuildRunner.test.ts) so esbuild's
// own module — imported at most once per process by the fix under test —
// has never been touched by another test's real, working staged binary.
// Vitest isolates each test file in its own worker by default, which is
// exactly the fresh state this pin depends on.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPluginBundle,
  resolvePluginEsbuildBinary,
  type BuildPluginBundleInput,
} from "./pluginBuildRunner";
import { DohcPluginManifest } from "./pluginManifestSchema";
import { pluginIdToSafePath } from "./pluginSourceSnapshot";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    ),
  );
});

describe("buildPluginBundle esbuild binary pin (CodeRabbit #779 R7)", () => {
  it("refuses to fall back to esbuild's own resolved binary when the staged, pinned binary is unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-esbuild-pin-"));
    roots.push(root);
    const resourcesBasePath = join(root, "resources");
    const dohcDir = join(root, "userdata-plugin-data");
    const pluginId = "esbuild-pin-fixture";
    const liveRoot = join(dohcDir, "plugins", pluginIdToSafePath(pluginId));
    const snapshotRoot = join(liveRoot, "snapshot");
    const entryPath = join(snapshotRoot, "src", "index.ts");
    await mkdir(join(snapshotRoot, "src"), { recursive: true });
    await writeFile(entryPath, 'export const marker = "pin";\n');

    // Stage a binary at exactly the path the pipeline pins esbuild to — but
    // make it garbage, not a real esbuild executable. If the pin genuinely
    // takes effect (fixed code), esbuild tries to spawn this exact file and
    // the build fails. If the pin is inert (the R7 defect: the env var is
    // set after esbuild's module already froze its own copy), esbuild
    // silently falls back to its own working @esbuild/<platform> binary
    // from node_modules and the build wrongly succeeds.
    const stagedBinary = resolvePluginEsbuildBinary(resourcesBasePath);
    await mkdir(join(stagedBinary, ".."), { recursive: true });
    await writeFile(stagedBinary, "not a real esbuild binary\n");
    if (process.platform !== "win32") await chmod(stagedBinary, 0o755);

    const manifest = DohcPluginManifest.parse({
      version: 1,
      name: pluginId,
      displayName: "Esbuild pin fixture",
      entry: "src/index.ts",
    });
    const input: BuildPluginBundleInput = {
      dohcDir,
      pluginId,
      snapshotRoot,
      manifest,
      resourcesBasePath,
    };

    const result = await buildPluginBundle(input);

    expect(result.ok).toBe(false);
  }, 30_000);
});
