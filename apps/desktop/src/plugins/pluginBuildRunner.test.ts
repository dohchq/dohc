import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stop, type BuildResult } from "esbuild";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildPluginBundle,
  resolvePluginEsbuildBinary,
  type BuildPluginBundleInput,
  type PluginBuildResult,
  type PluginBundleBuild,
} from "./pluginBuildRunner";
import {
  DohcPluginManifest,
  type DohcPluginManifest as DohcPluginManifestShape,
} from "./pluginManifestSchema";
import {
  PLUGIN_BUNDLE_TIMEOUT_MS,
  pluginIdToSafePath,
} from "./pluginSourceSnapshot";

interface BuildFixture {
  root: string;
  dohcDir: string;
  liveRoot: string;
  snapshotRoot: string;
  entryPath: string;
  manifest: DohcPluginManifestShape;
  input: BuildPluginBundleInput;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const roots: string[] = [];
let stagedResourcesRoot: string;
let stagedResourcesParent: string;

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
}

async function stageCurrentEsbuildBinary(resourcesRoot: string): Promise<void> {
  const platformKey = `${process.platform}-${process.arch}`;
  const requireFromTest = createRequire(import.meta.url);
  const esbuildPackageJson = requireFromTest.resolve("esbuild/package.json");
  const requireFromEsbuild = createRequire(esbuildPackageJson);
  const platformPackageJson = requireFromEsbuild.resolve(
    `@esbuild/${platformKey}/package.json`,
  );
  const sourceBinary = process.platform === "win32"
    ? join(dirname(platformPackageJson), "esbuild.exe")
    : join(dirname(platformPackageJson), "bin", "esbuild");
  const destinationBinary = resolvePluginEsbuildBinary(resourcesRoot);
  await mkdir(dirname(destinationBinary), { recursive: true });
  await copyFile(sourceBinary, destinationBinary);
  if (process.platform !== "win32") await chmod(destinationBinary, 0o755);
}

async function createBuildFixture(
  options: {
    pluginId?: string;
    entry?: string;
    entrySource?: string;
  } = {},
): Promise<BuildFixture> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-build-"));
  roots.push(root);
  // Stands in for PluginPipeline's userData-resident dohcDir — never a
  // workspace-relative path (CERT779).
  const dohcDir = join(root, "userdata-plugin-data");
  const pluginId = options.pluginId ?? "example-plugin";
  const liveRoot = join(
    dohcDir,
    "plugins",
    pluginIdToSafePath(pluginId),
  );
  const snapshotRoot = join(liveRoot, "snapshot");
  const entry = options.entry ?? "src/index.ts";
  const entryPath = join(snapshotRoot, ...entry.split("/"));
  const manifest = DohcPluginManifest.parse({
    version: 1,
    name: pluginId,
    displayName: "Build fixture",
    entry,
    commands: [{ id: "run", title: "Run" }],
  });
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(
    entryPath,
    options.entrySource ?? [
      'import { increment } from "./increment";',
      "export const answer = increment(41);",
      'export const marker = "run-4";',
      "export default { answer, marker };",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dirname(entryPath), "increment.ts"),
    "export const increment = (value: number): number => value + 1;\n",
  );
  return {
    root,
    dohcDir,
    liveRoot,
    snapshotRoot,
    entryPath,
    manifest,
    input: {
      dohcDir,
      pluginId,
      snapshotRoot,
      manifest,
      resourcesBasePath: stagedResourcesRoot,
    },
  };
}

function requireSuccess(
  result: PluginBuildResult,
): Extract<PluginBuildResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function requireFailure(
  result: PluginBuildResult,
): Extract<PluginBuildResult, { ok: false }> {
  if (result.ok) throw new Error("Expected the plugin bundle to fail.");
  return result;
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectNoStaging(liveRoot: string): Promise<void> {
  const entries = await readdir(liveRoot);
  expect(entries.filter((entry) => entry.startsWith(".staging-"))).toEqual([]);
}

beforeAll(async () => {
  stagedResourcesParent = await mkdtemp(join(tmpdir(), "dohc-esbuild-resources-"));
  stagedResourcesRoot = join(stagedResourcesParent, "resources");
  await stageCurrentEsbuildBinary(stagedResourcesRoot);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

afterAll(async () => {
  // The R7 fix means real builds above now genuinely spawn esbuild's shared
  // service process from the staged binary under stagedResourcesParent —
  // that process holds the executable open until stopped, which blocks
  // deleting it on Windows. Node's ESM cache resolves this import to the
  // same module esbuild.ts loaded internally, so this stops that same
  // service.
  await stop();
  await rm(stagedResourcesParent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("buildPluginBundle", () => {
  it("runs a real self-contained bundle that can be imported", async () => {
    const fixture = await createBuildFixture();

    const success = requireSuccess(await buildPluginBundle(fixture.input));
    const published = await success.publish();
    const imported: unknown = await import(
      `${pathToFileURL(success.bundlePath).href}?test=${randomUUID()}`
    );

    expect(imported).toMatchObject({ answer: 42, marker: "run-4" });
    expect(await readFile(success.bundlePath, "utf8")).not.toContain(
      'from "./increment"',
    );
    expect(success.diagnostics).toEqual({ errors: [], warnings: [] });
    expect(published.cleanupWarning).toBeNull();
  });

  it("leaves the live root untouched until publish is called (#779 round 6 F5)", async () => {
    const fixture = await createBuildFixture();
    const oldBundlePath = join(fixture.liveRoot, "bundle.mjs");
    await writeFile(oldBundlePath, "old bundle bytes\n");

    const success = requireSuccess(await buildPluginBundle(fixture.input));

    // The caller records approval for success.bundleHash before anything can
    // execute those bytes.
    expect(await readFile(oldBundlePath, "utf8")).toBe("old bundle bytes\n");
    await success.publish();
    const liveBundle = await readFile(oldBundlePath);
    expect(liveBundle.toString("utf8")).not.toContain("old bundle bytes");
    expect(createHash("sha256").update(liveBundle).digest("hex")).toBe(
      success.bundleHash,
    );
    await expectNoStaging(fixture.liveRoot);
  });

  it("discard restores the installed snapshot and keeps the old bundle live", async () => {
    const fixture = await createBuildFixture();
    const oldBundlePath = join(fixture.liveRoot, "bundle.mjs");
    await writeFile(oldBundlePath, "old bundle bytes\n");

    const success = requireSuccess(await buildPluginBundle(fixture.input));
    await success.discard();

    expect(await readFile(oldBundlePath, "utf8")).toBe("old bundle bytes\n");
    await expect(
      readFile(join(fixture.snapshotRoot, "src", "index.ts"), "utf8"),
    ).resolves.toContain("increment(41)");
    await expectNoStaging(fixture.liveRoot);
    await expect(success.publish()).rejects.toThrow(
      /was already published or discarded/,
    );
  });

  it("writes the returned metafile and a generated manifest for bundle.mjs", async () => {
    const fixture = await createBuildFixture({ pluginId: "@scope/build-fixture" });

    const success = requireSuccess(await buildPluginBundle(fixture.input));
    await success.publish();
    const metafileOnDisk: unknown = JSON.parse(
      await readFile(success.metafilePath, "utf8"),
    );
    const generatedManifest: unknown = JSON.parse(
      await readFile(success.manifestPath, "utf8"),
    );
    const sourceMapOnDisk: unknown = JSON.parse(
      await readFile(join(success.liveRoot, "bundle.mjs.map"), "utf8"),
    );

    expect(metafileOnDisk).toEqual(success.metafile);
    expect(Object.keys(success.metafile.inputs).some((path) =>
      path.replaceAll("\\", "/").endsWith("/src/index.ts"))).toBe(true);
    expect(Object.keys(success.metafile.outputs).some((path) =>
      path.replaceAll("\\", "/").endsWith("/bundle.mjs"))).toBe(true);
    expect(generatedManifest).toEqual({
      ...fixture.manifest,
      entry: "bundle.mjs",
    });
    expect(sourceMapOnDisk).toMatchObject({
      version: 3,
      sources: expect.arrayContaining([
        "snapshot/src/increment.ts",
        "snapshot/src/index.ts",
      ]),
    });
  });

  it("refuses an entry whose real path escapes the installed snapshot", async () => {
    const fixture = await createBuildFixture();
    const outsideRoot = join(fixture.root, "outside-entry");
    const linkedRoot = join(fixture.snapshotRoot, "escaped");
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "index.ts"), "export const escaped = true;\n");
    await symlink(
      outsideRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifest = DohcPluginManifest.parse({
      ...fixture.manifest,
      entry: "escaped/index.ts",
    });

    const failure = requireFailure(await buildPluginBundle({
      ...fixture.input,
      manifest,
    }));

    expect(failure.error).toMatchObject({
      code: "invalid-entry",
      path: join(fixture.snapshotRoot, "escaped", "index.ts"),
    });
    expect(failure.error.message).toContain(outsideRoot);
    expect(failure.error.message).toContain("outside the installed snapshot root");
    await expectNoStaging(fixture.liveRoot);
  });

  it("returns esbuild's named unresolved-import diagnostic verbatim", async () => {
    const fixture = await createBuildFixture({
      entrySource: [
        'import missing from "pr2-run4-missing-package";',
        "export default missing;",
        "",
      ].join("\n"),
    });

    const failure = requireFailure(await buildPluginBundle(fixture.input));

    expect(failure.error.code).toBe("esbuild");
    expect(failure.error.message).toContain(
      'Could not resolve "pr2-run4-missing-package"',
    );
    expect(failure.error.diagnostics.errors).toHaveLength(1);
    expect(failure.error.diagnostics.errors[0]?.text).toBe(
      'Could not resolve "pr2-run4-missing-package"',
    );
    expect(failure.error.diagnostics.errors[0]?.location?.file).toContain(
      "src/index.ts",
    );
    await expectNoStaging(fixture.liveRoot);
  });

  it("atomically replaces old output instead of merging it", async () => {
    const fixture = await createBuildFixture();
    const oldBundlePath = join(fixture.liveRoot, "bundle.mjs");
    const oldOnlyPath = join(fixture.liveRoot, "old-only.txt");
    await writeFile(oldBundlePath, "old bundle bytes\n");
    await writeFile(oldOnlyPath, "must disappear\n");

    const success = requireSuccess(await buildPluginBundle(fixture.input));
    await success.publish();

    expect(await readFile(success.bundlePath, "utf8")).not.toContain(
      "old bundle bytes",
    );
    await expectMissing(oldOnlyPath);
    await expect(readFile(join(success.liveRoot, "snapshot", "src", "index.ts"), "utf8"))
      .resolves.toContain("increment(41)");
    await expectNoStaging(success.liveRoot);
  });

  it("preserves the old bundle byte-for-byte when a new build fails", async () => {
    const fixture = await createBuildFixture({
      entrySource: 'import "pr2-run4-never-resolves";\n',
    });
    const oldBundlePath = join(fixture.liveRoot, "bundle.mjs");
    const oldBytes = Buffer.from([0, 1, 2, 3, 255, 10]);
    await writeFile(oldBundlePath, oldBytes);

    const failure = requireFailure(await buildPluginBundle(fixture.input));

    expect(failure.error.code).toBe("esbuild");
    await expect(readFile(oldBundlePath)).resolves.toEqual(oldBytes);
    await expectNoStaging(fixture.liveRoot);
  });

  it("stops an in-flight build when the caller aborts", async () => {
    const fixture = await createBuildFixture();
    const oldBundlePath = join(fixture.liveRoot, "bundle.mjs");
    const oldBytes = Buffer.from("old bundle before abort\n");
    await writeFile(oldBundlePath, oldBytes);
    const started = deferred<void>();
    const controller = new AbortController();
    let rejectBuild: ((error: unknown) => void) | undefined;
    const buildFunction = vi.fn<PluginBundleBuild>(() => {
      started.resolve();
      return new Promise<BuildResult>((_resolveBuild, reject) => {
        rejectBuild = reject;
      });
    });
    const stopBuild = vi.fn(async () => {
      rejectBuild?.(new Error("test build stopped"));
    });

    const buildJob = buildPluginBundle({
      ...fixture.input,
      signal: controller.signal,
      buildFunction,
      stopBuild,
    });
    await started.promise;
    controller.abort();
    const failure = requireFailure(await buildJob);

    expect(failure.error).toMatchObject({
      code: "aborted",
      timeoutMs: PLUGIN_BUNDLE_TIMEOUT_MS,
    });
    expect(stopBuild).toHaveBeenCalledTimes(1);
    await expect(readFile(oldBundlePath)).resolves.toEqual(oldBytes);
    await expectNoStaging(fixture.liveRoot);
  });

  it("stops a build at its configured timeout", async () => {
    vi.useFakeTimers();
    const fixture = await createBuildFixture();
    const oldBundlePath = join(fixture.liveRoot, "bundle.mjs");
    const oldBytes = Buffer.from("old bundle before timeout\n");
    await writeFile(oldBundlePath, oldBytes);
    const started = deferred<void>();
    let rejectBuild: ((error: unknown) => void) | undefined;
    const buildFunction = vi.fn<PluginBundleBuild>(() => {
      started.resolve();
      return new Promise<BuildResult>((_resolveBuild, reject) => {
        rejectBuild = reject;
      });
    });
    const stopBuild = vi.fn(async () => {
      rejectBuild?.(new Error("test build stopped"));
    });

    const buildJob = buildPluginBundle({
      ...fixture.input,
      timeoutMs: 25,
      buildFunction,
      stopBuild,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(25);
    const failure = requireFailure(await buildJob);

    expect(failure.error).toMatchObject({
      code: "timeout",
      timeoutMs: 25,
    });
    expect(failure.error.message).toContain("25 ms timeout");
    expect(stopBuild).toHaveBeenCalledTimes(1);
    await expect(readFile(oldBundlePath)).resolves.toEqual(oldBytes);
    await expectNoStaging(fixture.liveRoot);
  });
});
