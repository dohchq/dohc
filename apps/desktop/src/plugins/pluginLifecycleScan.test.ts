import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DohcPluginManifest,
  type DohcPluginManifest as DohcPluginManifestShape,
} from "./pluginManifestSchema";
import {
  PluginInstallationIntegrityError,
  PluginLifecycleUnsupportedHooksError,
  scanPluginLifecycleScripts,
  type PluginLifecycleScanResult,
} from "./pluginLifecycleScan";

interface LifecycleFixture {
  root: string;
  snapshotRoot: string;
  virtualStoreRoot: string;
  manifest: DohcPluginManifestShape;
}

interface PhysicalPackageInput {
  entry: string;
  name: string;
  version: string;
  scripts?: Record<string, string>;
}

const roots: string[] = [];

async function createLifecycleFixture(options: {
  rootScripts?: Record<string, string>;
  allowSkippedScripts?: true | string[];
} = {}): Promise<LifecycleFixture> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-lifecycle-"));
  roots.push(root);
  const snapshotRoot = join(root, "snapshot");
  const nodeModulesRoot = join(snapshotRoot, "node_modules");
  const virtualStoreRoot = join(nodeModulesRoot, ".pnpm");
  await mkdir(virtualStoreRoot, { recursive: true });
  await writeFile(
    join(snapshotRoot, "package.json"),
    `${JSON.stringify({
      name: "root-plugin",
      version: "1.0.0",
      scripts: options.rootScripts,
    }, null, 2)}\n`,
  );
  // This is the shape emitted by the fresh pnpm@11.20.0 isolated install:
  // .modules.yaml names an absolute virtualStoreDir, and physical packages
  // live under <entry>/node_modules/<name>/package.json.
  await writeFile(
    join(nodeModulesRoot, ".modules.yaml"),
    `${JSON.stringify({
      layoutVersion: 5,
      nodeLinker: "isolated",
      packageManager: "pnpm@11.20.0",
      virtualStoreDir: virtualStoreRoot,
    }, null, 2)}\n`,
  );
  const manifest = DohcPluginManifest.parse({
    version: 1,
    name: "root-plugin",
    entry: "src/index.ts",
    ...(options.allowSkippedScripts === undefined
      ? {}
      : { allowSkippedScripts: options.allowSkippedScripts }),
  });
  return { root, snapshotRoot, virtualStoreRoot, manifest };
}

async function addPhysicalPackage(
  fixture: LifecycleFixture,
  input: PhysicalPackageInput,
): Promise<string> {
  const packageSegments = input.name.split("/");
  const packageRoot = join(
    fixture.virtualStoreRoot,
    input.entry,
    "node_modules",
    ...packageSegments,
  );
  await mkdir(packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "package.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      name: input.name,
      version: input.version,
      scripts: input.scripts,
    }, null, 2)}\n`,
  );
  return manifestPath;
}

function requireUnsupported(
  result: PluginLifecycleScanResult,
): PluginLifecycleUnsupportedHooksError {
  if (result.ok || !(result.error instanceof PluginLifecycleUnsupportedHooksError)) {
    throw new Error("Expected an unsupported lifecycle-hook failure.");
  }
  return result.error;
}

function requireIntegrity(
  result: PluginLifecycleScanResult,
): PluginInstallationIntegrityError {
  if (result.ok || !(result.error instanceof PluginInstallationIntegrityError)) {
    throw new Error("Expected an installation-integrity failure.");
  }
  return result.error;
}

function scan(fixture: LifecycleFixture): Promise<PluginLifecycleScanResult> {
  return scanPluginLifecycleScripts({
    snapshotRoot: fixture.snapshotRoot,
    manifest: fixture.manifest,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("scanPluginLifecycleScripts", () => {
  it("accepts a zero-dependency install that creates no node_modules directory at all", async () => {
    // Measured directly against this machine's pinned pnpm@11.20.0: a real
    // frozen install with zero dependencies creates no node_modules
    // directory whatsoever, not merely an empty one (that's the distinct
    // case the .modules.yaml-less fixture above covers). #777's e2e caught
    // this — a real hello-plugin install failed closed here with an
    // installation-integrity error before this fix.
    const root = await mkdtemp(join(tmpdir(), "dohc-plugin-lifecycle-"));
    roots.push(root);
    const snapshotRoot = join(root, "snapshot");
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(
      join(snapshotRoot, "package.json"),
      `${JSON.stringify({ name: "root-plugin", version: "1.0.0" }, null, 2)}\n`,
    );
    const manifest = DohcPluginManifest.parse({
      version: 1,
      name: "root-plugin",
      entry: "src/index.ts",
    });

    const result = await scanPluginLifecycleScripts({ snapshotRoot, manifest });

    expect(result).toMatchObject({ ok: true, warnings: [], warningLines: [] });
  });

  it("reports a dependency postinstall hook without exposing its command in UI text", async () => {
    const fixture = await createLifecycleFixture();
    const manifestPath = await addPhysicalPackage(fixture, {
      entry: "native-helper@1.2.3",
      name: "native-helper",
      version: "1.2.3",
      scripts: { postinstall: "node ./build-native.js --secret-token" },
    });

    const error = requireUnsupported(await scan(fixture));

    expect(error.findings).toEqual([{
      name: "native-helper",
      version: "1.2.3",
      hook: "postinstall",
      command: "node ./build-native.js --secret-token",
      manifestPath,
    }]);
    expect(error.userFacingLines).toEqual([
      'Package "native-helper" 1.2.3 defines skipped postinstall hook.',
    ]);
    expect(error.userFacingLines[0]).not.toContain("build-native");
  });

  it("inspects a physical scoped package one level below its scope", async () => {
    const fixture = await createLifecycleFixture();
    const manifestPath = await addPhysicalPackage(fixture, {
      entry: "@scope+native@2.0.0",
      name: "@scope/native",
      version: "2.0.0",
      scripts: { install: "node install.js" },
    });

    const error = requireUnsupported(await scan(fixture));

    expect(error.findings[0]).toMatchObject({
      name: "@scope/native",
      version: "2.0.0",
      hook: "install",
      manifestPath,
    });
  });

  it("keeps every duplicate physical manifest path and deduplicates UI lines", async () => {
    const fixture = await createLifecycleFixture();
    const firstPath = await addPhysicalPackage(fixture, {
      entry: "duplicate@1.0.0_peer-a@1.0.0",
      name: "duplicate",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    });
    const secondPath = await addPhysicalPackage(fixture, {
      entry: "duplicate@1.0.0_peer-b@1.0.0",
      name: "duplicate",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    });

    const error = requireUnsupported(await scan(fixture));

    expect(error.findings.map((finding) => finding.manifestPath)).toEqual([
      firstPath,
      secondPath,
    ]);
    expect(error.userFacingLines).toEqual([
      'Package "duplicate" 1.0.0 defines skipped postinstall hook.',
    ]);
  });

  it("reports the plugin root prepare hook", async () => {
    const fixture = await createLifecycleFixture({
      rootScripts: { prepare: "node prepare-root.js" },
    });

    const error = requireUnsupported(await scan(fixture));

    expect(error.findings).toEqual([{
      name: "root-plugin",
      version: "1.0.0",
      hook: "prepare",
      command: "node prepare-root.js",
      manifestPath: join(fixture.snapshotRoot, "package.json"),
    }]);
  });

  it("returns a distinct integrity error for malformed third-party JSON", async () => {
    const fixture = await createLifecycleFixture();
    const manifestPath = await addPhysicalPackage(fixture, {
      entry: "broken@1.0.0",
      name: "broken",
      version: "1.0.0",
    });
    await writeFile(manifestPath, "{ not-json\n");

    const error = requireIntegrity(await scan(fixture));

    expect(error).toMatchObject({
      code: "installation-integrity",
      path: manifestPath,
    });
    expect(error.message).toContain("is not valid JSON");
  });

  it("fails closed when a physical manifest resolves outside the virtual store", async () => {
    const fixture = await createLifecycleFixture();
    const manifestPath = await addPhysicalPackage(fixture, {
      entry: "escape@1.0.0",
      name: "escape",
      version: "1.0.0",
    });
    const outsideManifest = join(fixture.snapshotRoot, "outside-package.json");
    await writeFile(
      outsideManifest,
      `${JSON.stringify({ name: "escape", version: "1.0.0" })}\n`,
    );
    await rm(manifestPath);
    await symlink(outsideManifest, manifestPath, "file");

    const error = requireIntegrity(await scan(fixture));

    expect(error).toMatchObject({
      code: "installation-integrity",
      path: manifestPath,
    });
    expect(error.message).toContain("resolves outside");
    expect(error.message).toContain(fixture.virtualStoreRoot);
  });

  it("converts an array-matched package finding to a named warning", async () => {
    const fixture = await createLifecycleFixture({
      allowSkippedScripts: ["prebuilt-helper"],
    });
    const manifestPath = await addPhysicalPackage(fixture, {
      entry: "prebuilt-helper@1.0.0",
      name: "prebuilt-helper",
      version: "1.0.0",
      scripts: { install: "node optional-build.js" },
    });

    const result = await scan(fixture);

    expect(result).toMatchObject({ ok: true });
    expect(result.warnings).toEqual([{
      name: "prebuilt-helper",
      version: "1.0.0",
      hook: "install",
      command: "node optional-build.js",
      manifestPath,
    }]);
    expect(result.warningLines).toEqual([
      'Package "prebuilt-helper" 1.0.0 allows skipped install hook.',
    ]);
  });

  it("converts every package finding to a warning when the override is true", async () => {
    const fixture = await createLifecycleFixture({ allowSkippedScripts: true });
    await addPhysicalPackage(fixture, {
      entry: "first@1.0.0",
      name: "first",
      version: "1.0.0",
      scripts: { preinstall: "node first.js" },
    });
    await addPhysicalPackage(fixture, {
      entry: "@scope+second@2.0.0",
      name: "@scope/second",
      version: "2.0.0",
      scripts: { postinstall: "node second.js" },
    });

    const result = await scan(fixture);

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warningLines).toEqual([
      'Package "@scope/second" 2.0.0 allows skipped postinstall hook.',
      'Package "first" 1.0.0 allows skipped preinstall hook.',
    ]);
  });

  it("orders diagnostics by package, version, hook, and manifest path", async () => {
    const fixture = await createLifecycleFixture();
    const alphaInstall = await addPhysicalPackage(fixture, {
      entry: "alpha@1.0.0_peer-a@1.0.0",
      name: "alpha",
      version: "1.0.0",
      scripts: { install: "node install.js" },
    });
    const alphaInstallDuplicate = await addPhysicalPackage(fixture, {
      entry: "alpha@1.0.0_peer-b@1.0.0",
      name: "alpha",
      version: "1.0.0",
      scripts: { install: "node install.js" },
    });
    const alphaPreinstall = await addPhysicalPackage(fixture, {
      entry: "alpha@1.0.0_peer-c@1.0.0",
      name: "alpha",
      version: "1.0.0",
      scripts: { preinstall: "node preinstall.js" },
    });
    const alphaPrepare = await addPhysicalPackage(fixture, {
      entry: "alpha@2.0.0",
      name: "alpha",
      version: "2.0.0",
      scripts: { prepare: "node prepare.js" },
    });
    const betaPostinstall = await addPhysicalPackage(fixture, {
      entry: "beta@1.0.0",
      name: "beta",
      version: "1.0.0",
      scripts: { postinstall: "node postinstall.js" },
    });

    const error = requireUnsupported(await scan(fixture));
    const diagnosticOrder = error.findings.map((finding) => [
      finding.name,
      finding.version,
      finding.hook,
      relative(fixture.snapshotRoot, finding.manifestPath).replaceAll("\\", "/"),
    ]);

    expect(diagnosticOrder).toEqual([
      ["alpha", "1.0.0", "install", relative(
        fixture.snapshotRoot,
        alphaInstall,
      ).replaceAll("\\", "/")],
      ["alpha", "1.0.0", "install", relative(
        fixture.snapshotRoot,
        alphaInstallDuplicate,
      ).replaceAll("\\", "/")],
      ["alpha", "1.0.0", "preinstall", relative(
        fixture.snapshotRoot,
        alphaPreinstall,
      ).replaceAll("\\", "/")],
      ["alpha", "2.0.0", "prepare", relative(
        fixture.snapshotRoot,
        alphaPrepare,
      ).replaceAll("\\", "/")],
      ["beta", "1.0.0", "postinstall", relative(
        fixture.snapshotRoot,
        betaPostinstall,
      ).replaceAll("\\", "/")],
    ]);
  });
});
