import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceStateKey } from "./pluginLocalState";
import { DohcPluginManifest } from "./pluginManifestSchema";
import {
  PINNED_PLUGIN_PACKAGE_MANAGER,
  SNAPSHOT_STAGING_SUFFIX,
  snapshotPluginSource,
} from "./pluginSourceSnapshot";

// The staged tree is removed with fs.rm, and only a real removal failure
// proves the discard is retryable: an open file handle does not, because Node
// opens with FILE_SHARE_DELETE on Windows and rm succeeds anyway (CERT779J
// B3.4). One rejection, on the staged path only, is the whole probe.
const state = vi.hoisted(() => ({ failNextStagingRemoval: false }));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (
        state.failNextStagingRemoval &&
        typeof path === "string" &&
        path.includes(".snap-staging-")
      ) {
        state.failNextStagingRemoval = false;
        return Promise.reject(
          Object.assign(new Error("EBUSY: simulated busy staged tree"), {
            code: "EBUSY",
          }),
        );
      }
      return actual.rm(path, options);
    },
  };
});

const roots: string[] = [];

async function createFixture(): Promise<{
  workspaceRoot: string;
  stateDir: string;
  dohcDir: string;
  pluginRoot: string;
  manifest: ReturnType<typeof DohcPluginManifest.parse>;
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-discard-"));
  const stateDir = await mkdtemp(join(tmpdir(), "dohc-plugin-discard-state-"));
  roots.push(workspaceRoot, stateDir);
  const pluginRoot = join(workspaceRoot, "plugins", "example-plugin");
  const manifest = DohcPluginManifest.parse({
    version: 1,
    name: "example-plugin",
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
      name: manifest.name,
      private: true,
      packageManager: PINNED_PLUGIN_PACKAGE_MANAGER,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(pluginRoot, "pnpm-lock.yaml"),
    ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", ""].join("\n"),
  );
  return {
    workspaceRoot,
    stateDir,
    dohcDir: join(stateDir, "plugin-data", workspaceStateKey(workspaceRoot)),
    pluginRoot,
    manifest,
  };
}

afterEach(async () => {
  state.failNextStagingRemoval = false;
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("staged source snapshot discard", () => {
  it("stays retryable when the removal fails, and settles once (#779 round 10 A5)", async () => {
    const fixture = await createFixture();
    const staged = await snapshotPluginSource({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      dohcDir: fixture.dohcDir,
      pluginId: fixture.manifest.name,
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
    });
    if (!staged.ok) throw new Error(staged.error.message);
    expect(staged.snapshotRoot).toContain(SNAPSHOT_STAGING_SUFFIX);

    state.failNextStagingRemoval = true;
    await expect(staged.discard()).rejects.toThrow(/simulated busy staged tree/);
    // The tree is exactly where it was, so it is still this snapshot's to
    // remove — claiming it on a failed removal leaves the bytes beside the
    // live root with nothing left that can delete them.
    expect((await lstat(staged.snapshotRoot)).isDirectory()).toBe(true);

    await staged.discard();
    await expect(lstat(staged.snapshotRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(staged.discard()).rejects.toThrow(
      /already published or discarded/,
    );
  });
});
