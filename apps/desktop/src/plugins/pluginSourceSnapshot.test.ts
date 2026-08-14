import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DohcPluginManifest,
  NPM_PACKAGE_NAME,
  type DohcPluginManifest as DohcPluginManifestShape,
} from "./pluginManifestSchema";
import {
  MAX_PLUGIN_LOCKFILE_BYTES,
  PINNED_PLUGIN_PACKAGE_MANAGER,
  assertSafeSnapshotEntryName,
  hashPluginSourceFiles,
  pluginIdToSafePath,
  snapshotPluginSource,
  type PluginSourceSnapshotResult,
} from "./pluginSourceSnapshot";
import { workspaceStateKey } from "./pluginLocalState";

interface PluginFixture {
  root: string;
  stateDir: string;
  dohcDir: string;
  pluginRoot: string;
  manifest: DohcPluginManifestShape;
}

// Matches PluginPipeline's own computation exactly: derived plugin
// artifacts live under <stateDir>/plugin-data/<workspaceStateKey>, never
// inside the workspace folder (CERT779).
function dohcDirFor(stateDir: string, workspaceRoot: string): string {
  return join(stateDir, "plugin-data", workspaceStateKey(workspaceRoot));
}

type DependencyField =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";

const roots: string[] = [];

function minimalLockfile(): string {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
  ].join("\n");
}

async function createWorkspaceRoot(prefix = "dohc-plugin-snapshot-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await mkdir(join(root, "plugins"));
  return root;
}

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-plugin-snapshot-state-"));
  roots.push(dir);
  return dir;
}

async function writeSourceFiles(
  pluginRoot: string,
  pluginId: string,
): Promise<DohcPluginManifestShape> {
  const manifest = DohcPluginManifest.parse({
    version: 1,
    name: pluginId,
    entry: "src/index.ts",
  });
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  await writeFile(
    join(pluginRoot, "dohc-plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(pluginRoot, "src", "index.ts"), "export default {};\n");
  await writeFile(
    join(pluginRoot, "package.json"),
    `${JSON.stringify({
      name: pluginId,
      private: true,
      packageManager: PINNED_PLUGIN_PACKAGE_MANAGER,
    }, null, 2)}\n`,
  );
  await writeFile(join(pluginRoot, "pnpm-lock.yaml"), minimalLockfile());
  return manifest;
}

async function createPluginFixture(
  pluginId = "example-plugin",
): Promise<PluginFixture> {
  const root = await createWorkspaceRoot();
  const stateDir = await createStateDir();
  const pluginRoot = join(root, "plugins", "source-directory");
  await mkdir(pluginRoot);
  const manifest = await writeSourceFiles(pluginRoot, pluginId);
  return {
    root,
    stateDir,
    dohcDir: dohcDirFor(stateDir, root),
    pluginRoot,
    manifest,
  };
}

function stageSnapshot(
  fixture: PluginFixture,
): Promise<PluginSourceSnapshotResult> {
  return snapshotPluginSource({
    workspaceRoot: fixture.root,
    stateDir: fixture.stateDir,
    dohcDir: fixture.dohcDir,
    pluginId: fixture.manifest.name,
    pluginRoot: fixture.pluginRoot,
    manifest: fixture.manifest,
  });
}

/** Stages and publishes, the way an approved install does. */
async function runSnapshot(
  fixture: PluginFixture,
): Promise<PluginSourceSnapshotResult> {
  const result = await stageSnapshot(fixture);
  if (result.ok) await result.publish();
  return result;
}

function pluginDataRootFor(fixture: PluginFixture): string {
  return join(
    fixture.dohcDir,
    "plugins",
    pluginIdToSafePath(fixture.manifest.name),
  );
}

/** Where a published snapshot lives, whatever path staging used. */
function liveSnapshotRoot(fixture: PluginFixture): string {
  return join(pluginDataRootFor(fixture), "snapshot");
}

/** Staged trees are siblings of the live root, so this is where they land. */
async function stagingLeftovers(fixture: PluginFixture): Promise<string[]> {
  const parent = join(fixture.dohcDir, "plugins");
  const prefix = `${pluginIdToSafePath(fixture.manifest.name)}.snap-staging-`;
  return (await readdir(parent)).filter((name) => name.startsWith(prefix));
}

function requireSuccess(
  result: PluginSourceSnapshotResult,
): Extract<PluginSourceSnapshotResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function requireFailure(
  result: PluginSourceSnapshotResult,
): Extract<PluginSourceSnapshotResult, { ok: false }> {
  if (result.ok) throw new Error("Expected the source snapshot to fail.");
  return result;
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("pluginIdToSafePath", () => {
  it("maps a scoped manifest name to one safe path segment", () => {
    const pluginId = "@scope/name";

    expect(NPM_PACKAGE_NAME.test(pluginId)).toBe(true);
    expect(pluginIdToSafePath(pluginId)).toBe("@scope%2Fname");
    expect(pluginIdToSafePath(pluginId)).not.toMatch(/[\\/\0]/);
    expect(isAbsolute(pluginIdToSafePath(pluginId))).toBe(false);
  });

  it.each(["../escape", "C:drive", "bad\\name", "scope/name", "UPPERCASE"])(
    "uses the manifest name regex to reject unsafe id %s",
    (pluginId) => {
      expect(NPM_PACKAGE_NAME.test(pluginId)).toBe(false);
      expect(() => pluginIdToSafePath(pluginId)).toThrow(
        `Plugin id "${pluginId}" does not match the manifest name pattern.`,
      );
    },
  );

  it("maps two distinct ids that only differ in where the scope separator falls to distinct paths (#779 round 3 finding 4)", () => {
    const first = "@a/b__c";
    const second = "@a__b/c";

    expect(NPM_PACKAGE_NAME.test(first)).toBe(true);
    expect(NPM_PACKAGE_NAME.test(second)).toBe(true);
    expect(pluginIdToSafePath(first)).not.toBe(pluginIdToSafePath(second));
  });
});

describe("snapshotPluginSource containment", () => {
  it("rejects a symlinked or junction plugin root", async () => {
    const root = await createWorkspaceRoot();
    const stateDir = await createStateDir();
    const targetRoot = join(root, "outside-plugin");
    await mkdir(targetRoot);
    const manifest = await writeSourceFiles(targetRoot, "linked-plugin");
    const linkedRoot = join(root, "plugins", "linked-plugin");
    await symlink(targetRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    const failure = requireFailure(await snapshotPluginSource({
      workspaceRoot: root,
      stateDir,
      dohcDir: dohcDirFor(stateDir, root),
      pluginId: manifest.name,
      pluginRoot: linkedRoot,
      manifest,
    }));

    expect(failure.error).toMatchObject({
      code: "invalid-plugin-root",
      path: linkedRoot,
    });
    expect(failure.error.message).toContain("is a symlink or junction");
  });

  it("rejects a nested symlink or junction and names its exact path", async () => {
    const fixture = await createPluginFixture();
    const targetRoot = join(fixture.root, "outside-nested");
    const linkedRoot = join(fixture.pluginRoot, "linked-directory");
    await mkdir(targetRoot);
    await writeFile(join(targetRoot, "outside.txt"), "outside\n");
    await symlink(targetRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    const failure = requireFailure(await runSnapshot(fixture));

    expect(failure.error).toMatchObject({
      code: "unsafe-source-entry",
      path: linkedRoot,
    });
    expect(failure.error.message).toContain(linkedRoot);
  });

  it("rejects a plugin root outside the workspace plugins tree", async () => {
    const root = await createWorkspaceRoot();
    const stateDir = await createStateDir();
    const outsideRoot = join(root, "outside-plugin");
    await mkdir(outsideRoot);
    const manifest = await writeSourceFiles(outsideRoot, "outside-plugin");

    const failure = requireFailure(await snapshotPluginSource({
      workspaceRoot: root,
      stateDir,
      dohcDir: dohcDirFor(stateDir, root),
      pluginId: manifest.name,
      pluginRoot: outsideRoot,
      manifest,
    }));

    expect(failure.error).toMatchObject({
      code: "invalid-plugin-root",
      path: outsideRoot,
    });
    expect(failure.error.message).toContain("outside the workspace plugins tree");
  });

  it("excludes node_modules and .dohc entries and prepares shared pnpm paths", async () => {
    const fixture = await createPluginFixture("@scope/example-plugin");
    await mkdir(join(fixture.pluginRoot, "node_modules", "dependency"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.pluginRoot, "node_modules", "dependency", "index.js"),
      "excluded\n",
    );
    await mkdir(join(fixture.pluginRoot, ".dohc"));
    await writeFile(join(fixture.pluginRoot, ".dohc", "state.json"), "{}\n");
    await mkdir(join(fixture.pluginRoot, "nested", ".dohc"), { recursive: true });
    await writeFile(
      join(fixture.pluginRoot, "nested", ".dohc", "state.json"),
      "{}\n",
    );
    await writeFile(join(fixture.pluginRoot, "nested", "included.txt"), "included\n");

    const result = requireSuccess(await runSnapshot(fixture));

    const snapshotRoot = liveSnapshotRoot(fixture);
    expect(snapshotRoot).toBe(
      join(fixture.dohcDir, "plugins", "@scope%2Fexample-plugin", "snapshot"),
    );
    await expectMissing(join(snapshotRoot, "node_modules"));
    await expectMissing(join(snapshotRoot, ".dohc"));
    await expectMissing(join(snapshotRoot, "nested", ".dohc"));
    await expect(readFile(
      join(snapshotRoot, "nested", "included.txt"),
      "utf8",
    )).resolves.toBe("included\n");
    expect(result.pnpmPaths).toEqual({
      storeDir: join(fixture.dohcDir, "pnpm", "store"),
      cacheDir: join(fixture.dohcDir, "pnpm", "cache"),
      stateDir: join(fixture.dohcDir, "pnpm", "state"),
      homeDir: join(fixture.dohcDir, "pnpm", "home"),
    });
    await Promise.all(Object.values(result.pnpmPaths).map(async (path) => {
      expect((await lstat(path)).isDirectory()).toBe(true);
    }));
  });
});

describe("snapshotPluginSource package-manager configuration", () => {
  it.each([
    [".npmrc", "@evil:registry=http://127.0.0.1:9/\n"],
    [".pnpmfile.cjs", "module.exports = { hooks: {} };\n"],
    [".pnpmfile.mjs", "export const hooks = {};\n"],
    ["pnpm-workspace.yaml", "trust-lockfile: true\n"],
  ])("rejects a plugin-authored %s", async (name, body) => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, name), body);

    const failure = requireFailure(await stageSnapshot(fixture));

    expect(failure.error.code).toBe("unsupported-package-manager-config");
    expect(failure.error.message).toContain(name);
    expect(failure.error.message).toContain("dohc's own pnpm configuration");
    expect(failure.error.path).toBe(join(fixture.pluginRoot, name));
    await expectMissing(liveSnapshotRoot(fixture));
    expect(await stagingLeftovers(fixture)).toEqual([]);
  });

  it("rejects the scoped-registry attack before pnpm can read it (CERT779H)", async () => {
    const fixture = await createPluginFixture();
    // PNPM_CONFIG_REGISTRY pins only the default registry, so this file chose
    // where every @evil-scoped dependency's bytes came from — and the install
    // that fetched them ran before any approval gate.
    await writeFile(
      join(fixture.pluginRoot, ".npmrc"),
      "@evil:registry=http://127.0.0.1:9/\nstrict-ssl=false\n",
    );
    await writeFile(
      join(fixture.pluginRoot, "package.json"),
      `${JSON.stringify({
        name: fixture.manifest.name,
        dependencies: { "@evil/pkg": "1.0.0" },
      }, null, 2)}\n`,
    );

    const failure = requireFailure(await stageSnapshot(fixture));

    expect(failure.error.code).toBe("unsupported-package-manager-config");
    await expectMissing(liveSnapshotRoot(fixture));
  });

  it("still snapshots a plugin that ships no package-manager configuration", async () => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, "npmrc.md"), "docs about npmrc\n");
    await writeFile(join(fixture.pluginRoot, "src", "pnpmfile.ts"), "export {};\n");

    requireSuccess(await runSnapshot(fixture));

    await expect(readFile(join(liveSnapshotRoot(fixture), "npmrc.md"), "utf8"))
      .resolves.toBe("docs about npmrc\n");
  });
});

describe("snapshotPluginSource dependency validation", () => {
  it.each([
    ["dependencies", "file:../local-package"],
    ["devDependencies", "link:../local-package"],
    ["optionalDependencies", "workspace:*"],
    ["peerDependencies", "file:../peer-package"],
  ] satisfies Array<[DependencyField, string]>) (
    "rejects package.json field %s spec %s",
    async (field, spec) => {
      const fixture = await createPluginFixture();
      await writeFile(
        join(fixture.pluginRoot, "package.json"),
        `${JSON.stringify({
          name: fixture.manifest.name,
          packageManager: PINNED_PLUGIN_PACKAGE_MANAGER,
          [field]: { "local-package": spec },
        }, null, 2)}\n`,
      );

      const failure = requireFailure(await runSnapshot(fixture));

      expect(failure.error.code).toBe("unsupported-local-dependency");
      expect(failure.error.message).toContain(field);
      expect(failure.error.message).toContain('package "local-package"');
      expect(failure.error.message).toContain(`spec "${spec}"`);
      if (spec.startsWith("workspace:")) {
        expect(failure.error.message).toContain(
          "workspace: protocol cannot resolve under --ignore-workspace",
        );
      }
    },
  );

  it.each(["file:../local-package", "link:../local-package", "workspace:*"])(
    "rejects pnpm-lock.yaml importer spec %s",
    async (spec) => {
      const fixture = await createPluginFixture();
      await writeFile(join(fixture.pluginRoot, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      local-package:",
        `        specifier: '${spec}'`,
        `        version: '${spec}'`,
        "",
      ].join("\n"));

      const failure = requireFailure(await runSnapshot(fixture));

      expect(failure.error.code).toBe("unsupported-local-dependency");
      expect(failure.error.message).toContain("pnpm-lock.yaml");
      expect(failure.error.message).toContain('package "local-package"');
      expect(failure.error.message).toContain(`spec "${spec}"`);
      if (spec.startsWith("workspace:")) {
        expect(failure.error.message).toContain(
          "workspace: protocol cannot resolve under --ignore-workspace",
        );
      }
    },
  );

  it("rejects a local pnpm-lock.yaml package resolution", async () => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "packages:",
      "",
      "  local-package@1.0.0:",
      "    resolution:",
      "      tarball: 'file:../local-package.tgz'",
      "",
    ].join("\n"));

    const failure = requireFailure(await runSnapshot(fixture));

    expect(failure.error.code).toBe("unsupported-local-dependency");
    expect(failure.error.message).toContain('package "local-package"');
    expect(failure.error.message).toContain('spec "file:../local-package.tgz"');
  });

  // pnpm 11 reads devEngines.packageManager in preference to packageManager
  // and downloads that version. Measured against the staged pnpm@11.20.0: a
  // package.json passing the pin above while declaring
  // devEngines.packageManager pnpm 10.15.0 ran pnpm 10.15.0 — a release that,
  // unlike 11.x, still honors path settings such as modules-dir from a
  // plugin-authored .npmrc. Pinning one field and ignoring the field that
  // outranks it pins nothing (#779 round 8 D1).
  it("rejects a devEngines package manager, which outranks the pinned field", async () => {
    const fixture = await createPluginFixture();
    await writeFile(
      join(fixture.pluginRoot, "package.json"),
      `${JSON.stringify({
        name: fixture.manifest.name,
        packageManager: PINNED_PLUGIN_PACKAGE_MANAGER,
        devEngines: { packageManager: { name: "pnpm", version: "10.15.0" } },
      }, null, 2)}\n`,
    );

    const failure = requireFailure(await runSnapshot(fixture));

    expect(failure.error).toMatchObject({ code: "unsupported-package-manager" });
    expect(failure.error.message).toContain('field "devEngines.packageManager"');
    expect(failure.error.message).toContain(`"${PINNED_PLUGIN_PACKAGE_MANAGER}"`);
  });

  it("rejects a packageManager field that does not match the pnpm pin", async () => {
    const fixture = await createPluginFixture();
    await writeFile(
      join(fixture.pluginRoot, "package.json"),
      `${JSON.stringify({
        name: fixture.manifest.name,
        packageManager: "pnpm@10.0.0",
      }, null, 2)}\n`,
    );

    const failure = requireFailure(await runSnapshot(fixture));

    expect(failure.error).toMatchObject({ code: "unsupported-package-manager" });
    expect(failure.error.message).toContain('field "packageManager"');
    expect(failure.error.message).toContain('"pnpm@10.0.0"');
    expect(failure.error.message).toContain(`"${PINNED_PLUGIN_PACKAGE_MANAGER}"`);
  });

  it("rejects a pnpm-lock.yaml over its configured byte limit before parsing it (CodeRabbit #779 R25)", async () => {
    const fixture = await createPluginFixture();
    const oversizedLockfile =
      `${minimalLockfile()}# ${"x".repeat(MAX_PLUGIN_LOCKFILE_BYTES)}\n`;
    await writeFile(join(fixture.pluginRoot, "pnpm-lock.yaml"), oversizedLockfile);

    const failure = requireFailure(await runSnapshot(fixture));

    expect(failure.error.code).toBe("invalid-lockfile");
    expect(failure.error.message).toContain(
      `the configured limit is ${MAX_PLUGIN_LOCKFILE_BYTES} bytes`,
    );
  });

  it("resolves a deeply diamond-aliased pnpm-lock.yaml without exponential blowup (CodeRabbit #779 R25)", async () => {
    const fixture = await createPluginFixture();
    // Each level's two keys alias the SAME next-level anchor — a real,
    // legitimate YAML shape (pnpm lockfiles share specs via &anchor/*alias)
    // that revisits one shared subtree exponentially many times under a
    // stack-only cycle guard. 24 levels is 2^24 (16.7M) redundant visits
    // under the old code; a persistent visited set makes this linear.
    const depth = 24;
    const lines = ["lockfileVersion: '9.0'", "", "importers:", "  .: {}", "", "snapshots:"];
    lines.push(`  leaf: &l0`);
    lines.push(`    resolution: {}`);
    for (let level = 1; level <= depth; level += 1) {
      lines.push(`  level${level}: &l${level}`);
      lines.push(`    a: *l${level - 1}`);
      lines.push(`    b: *l${level - 1}`);
    }
    await writeFile(join(fixture.pluginRoot, "pnpm-lock.yaml"), `${lines.join("\n")}\n`);

    const started = Date.now();
    const result = await runSnapshot(fixture);
    const elapsedMs = Date.now() - started;

    requireSuccess(result);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});

describe("snapshotPluginSource canonical hash and replacement", () => {
  it("is deterministic and binds both file bytes and relative paths", async () => {
    const fixture = await createPluginFixture();
    const payloadPath = join(fixture.pluginRoot, "payload.txt");
    await writeFile(payloadPath, "a");

    const first = requireSuccess(await runSnapshot(fixture));
    const unchanged = requireSuccess(await runSnapshot(fixture));
    expect(unchanged.sourceHash).toBe(first.sourceHash);

    await writeFile(payloadPath, "b");
    const changedByte = requireSuccess(await runSnapshot(fixture));
    expect(changedByte.sourceHash).not.toBe(first.sourceHash);

    await writeFile(payloadPath, "a");
    const restored = requireSuccess(await runSnapshot(fixture));
    expect(restored.sourceHash).toBe(first.sourceHash);

    await rename(payloadPath, join(fixture.pluginRoot, "renamed-payload.txt"));
    const renamed = requireSuccess(await runSnapshot(fixture));
    expect(renamed.sourceHash).not.toBe(first.sourceHash);
  });

  it("keeps the previous snapshot and removes staging after validation fails", async () => {
    const fixture = await createPluginFixture();
    requireSuccess(await runSnapshot(fixture));
    const originalPackageJson = await readFile(
      join(liveSnapshotRoot(fixture), "package.json"),
      "utf8",
    );
    await writeFile(
      join(fixture.pluginRoot, "package.json"),
      `${JSON.stringify({
        name: fixture.manifest.name,
        packageManager: "npm@11.0.0",
      }, null, 2)}\n`,
    );

    const failure = requireFailure(await runSnapshot(fixture));

    expect(failure.error.code).toBe("unsupported-package-manager");
    await expect(readFile(join(liveSnapshotRoot(fixture), "package.json"), "utf8"))
      .resolves.toBe(originalPackageJson);
    expect(await stagingLeftovers(fixture)).toEqual([]);
  });

  it("leaves no staged tree behind after a discard", async () => {
    const fixture = await createPluginFixture();
    const staged = requireSuccess(await stageSnapshot(fixture));
    expect(await stagingLeftovers(fixture)).toHaveLength(1);

    await staged.discard();

    expect(await stagingLeftovers(fixture)).toEqual([]);
    await expectMissing(liveSnapshotRoot(fixture));
  });

  it("refuses to publish or discard a staged tree twice", async () => {
    const fixture = await createPluginFixture();
    const staged = requireSuccess(await stageSnapshot(fixture));

    await staged.publish();

    await expect(staged.publish()).rejects.toThrow(/already published or discarded/);
    await expect(staged.discard()).rejects.toThrow(/already published or discarded/);
    await expect(readFile(join(liveSnapshotRoot(fixture), "package.json"), "utf8"))
      .resolves.toContain(fixture.manifest.name);
  });

  it("keeps the live snapshot untouched until publish", async () => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, "payload.txt"), "approved");
    requireSuccess(await runSnapshot(fixture));
    const livePayload = join(liveSnapshotRoot(fixture), "payload.txt");

    await writeFile(join(fixture.pluginRoot, "payload.txt"), "unapproved");
    const staged = requireSuccess(await stageSnapshot(fixture));

    // The changed bytes are staged and hashed, and the live snapshot — the
    // tree a panel and a brokered child both read — still serves the
    // approved payload (#779 round 9 B1).
    await expect(readFile(livePayload, "utf8")).resolves.toBe("approved");
    await expect(readFile(join(staged.snapshotRoot, "payload.txt"), "utf8"))
      .resolves.toBe("unapproved");

    await staged.publish();

    await expect(readFile(livePayload, "utf8")).resolves.toBe("unapproved");
    expect(await stagingLeftovers(fixture)).toEqual([]);
  });

  it("stages beside the live root, never inside it", async () => {
    const fixture = await createPluginFixture();
    const staged = requireSuccess(await stageSnapshot(fixture));

    // The child-process broker's containment is rooted at the live root, so
    // unpublished bytes parked inside it would be reachable (#779 round 7
    // A1, round 9 B1).
    expect(staged.snapshotRoot.startsWith(pluginDataRootFor(fixture) + sep))
      .toBe(false);
    expect(await stagingLeftovers(fixture)).toHaveLength(1);
    await staged.discard();
  });

  it("preserves an installed node_modules across a hash-check reconcile that finds no change (fixround Section B item 11)", async () => {
    const fixture = await createPluginFixture();
    const first = requireSuccess(await runSnapshot(fixture));
    // Stands in for a real pnpm install's node_modules living inside the
    // snapshot — excluded from the source copy itself, so only a
    // destructive replace (not a source change) can remove it.
    const installedMarker = join(liveSnapshotRoot(fixture), "node_modules", ".marker");
    await mkdir(join(liveSnapshotRoot(fixture), "node_modules"));
    await writeFile(installedMarker, "installed\n");

    const reconciled = requireSuccess(await snapshotPluginSource({
      workspaceRoot: fixture.root,
      stateDir: fixture.stateDir,
      dohcDir: fixture.dohcDir,
      pluginId: fixture.manifest.name,
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      preserveIfHashMatches: first.sourceHash,
    }));

    expect(reconciled.sourceHash).toBe(first.sourceHash);
    expect(reconciled.snapshotRoot).toBe(liveSnapshotRoot(fixture));
    expect(await stagingLeftovers(fixture)).toEqual([]);
    await expect(readFile(installedMarker, "utf8")).resolves.toBe("installed\n");
  });

  it("rebuilds a preserved snapshot that was deleted out of band", async () => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, "payload.txt"), "a");
    const first = requireSuccess(await runSnapshot(fixture));
    await rm(liveSnapshotRoot(fixture), { recursive: true, force: true });

    const reconciled = requireSuccess(await snapshotPluginSource({
      workspaceRoot: fixture.root,
      stateDir: fixture.stateDir,
      dohcDir: fixture.dohcDir,
      pluginId: fixture.manifest.name,
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      preserveIfHashMatches: first.sourceHash,
    }));

    expect(reconciled.sourceHash).toBe(first.sourceHash);
    await reconciled.publish();
    await expect(readFile(join(liveSnapshotRoot(fixture), "payload.txt"), "utf8"))
      .resolves.toBe("a");
  });

  it("rebuilds a preserved snapshot whose contents no longer match its hash", async () => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, "payload.txt"), "a");
    const first = requireSuccess(await runSnapshot(fixture));
    await writeFile(join(liveSnapshotRoot(fixture), "payload.txt"), "corrupted");

    const reconciled = requireSuccess(await snapshotPluginSource({
      workspaceRoot: fixture.root,
      stateDir: fixture.stateDir,
      dohcDir: fixture.dohcDir,
      pluginId: fixture.manifest.name,
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      preserveIfHashMatches: first.sourceHash,
    }));

    expect(reconciled.sourceHash).toBe(first.sourceHash);
    await reconciled.publish();
    await expect(readFile(join(liveSnapshotRoot(fixture), "payload.txt"), "utf8"))
      .resolves.toBe("a");
  });
});

describe("hashPluginSourceFiles entry kinds", () => {
  it("fails closed on a symlink so it can never hash as an absent file", async () => {
    const fixture = await createPluginFixture();
    await writeFile(join(fixture.pluginRoot, "payload.txt"), "a");
    const linkPath = join(fixture.pluginRoot, "linked.txt");
    await symlink(
      join(fixture.pluginRoot, "payload.txt"),
      linkPath,
      process.platform === "win32" ? "junction" : "file",
    );

    await expect(hashPluginSourceFiles(fixture.pluginRoot)).rejects.toThrow(
      /is a symlink or junction/,
    );
  });

  it("hashes a tree of plain files and directories", async () => {
    const fixture = await createPluginFixture();
    await mkdir(join(fixture.pluginRoot, "nested"));
    await writeFile(join(fixture.pluginRoot, "nested", "payload.txt"), "a");

    const digest = await hashPluginSourceFiles(fixture.pluginRoot);

    expect(digest.files.map((file) => file.relPath)).toContain(
      "nested/payload.txt",
    );
  });
});

describe("backslash source entry names (#779 round 7 B1)", () => {
  it("names the constraint it rejects", () => {
    expect(() => assertSafeSnapshotEntryName("index.ts", "/plugins/p/index.ts"))
      .not.toThrow();
    let thrown: unknown;
    try {
      assertSafeSnapshotEntryName("a\\b", "/plugins/p/a\\b");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "unsafe-source-entry",
      path: "/plugins/p/a\\b",
    });
    expect((thrown as Error).message).toContain(
      "must not contain a backslash",
    );
  });

  // Only POSIX can create a file whose own name holds a backslash; on
  // Windows the same bytes are a path separator, so the collision cannot
  // exist there.
  it.skipIf(process.platform === "win32")(
    "refuses a source tree where a backslash name collides with a nested path",
    async () => {
      const fixture = await createPluginFixture();
      await mkdir(join(fixture.pluginRoot, "a"));
      await writeFile(join(fixture.pluginRoot, "a", "b"), "nested\n");
      await writeFile(join(fixture.pluginRoot, "a\\b"), "backslash\n");

      const result = await runSnapshot(fixture);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatchObject({ code: "unsafe-source-entry" });
      expect(result.error.message).toContain("must not contain a backslash");
      // The hash pass refuses it too, so an already-installed tree that grows
      // one cannot report a clean hash either.
      await expect(hashPluginSourceFiles(fixture.pluginRoot)).rejects.toThrow(
        /must not contain a backslash/,
      );
    },
  );
});
