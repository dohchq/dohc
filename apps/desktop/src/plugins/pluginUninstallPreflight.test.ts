import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_VERSIONED_BINARY_FILE_BYTES } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { MAX_HISTORY_TEXT_SNAPSHOT_BYTES } from "../workspaces/workspaceWatcher";
import { hashPluginSourceFiles } from "./pluginSourceSnapshot";
import {
  pluginBaselineManifestPath,
  pluginUninstallPreflight,
  writePluginBaselineManifest,
} from "./pluginUninstallPreflight";

const roots: string[] = [];
const pluginId = "hello-plugin";

interface PreflightFixture {
  workspaceRoot: string;
  // Stands in for PluginPipeline's userData-resident dohcDir — never a
  // workspace-relative path (CERT779).
  dohcDir: string;
  pluginRoot: string;
}

async function createFixture(): Promise<PreflightFixture> {
  const workspaceRoot = await createTestScratch("dohc-plugin-uninstall-");
  roots.push(workspaceRoot);
  const dohcDir = join(workspaceRoot, "userdata-plugin-data");
  const pluginRoot = join(workspaceRoot, "plugins", "hello-source");
  await mkdir(pluginRoot, { recursive: true });
  return { workspaceRoot, dohcDir, pluginRoot };
}

async function writeSourceFile(
  fixture: PreflightFixture,
  relPath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const path = join(fixture.pluginRoot, ...relPath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function saveBaseline(fixture: PreflightFixture): Promise<string> {
  const digest = await hashPluginSourceFiles(fixture.pluginRoot);
  await writePluginBaselineManifest({
    dohcDir: fixture.dohcDir,
    pluginId,
    baselineDigest: digest,
    installedBaselineHash: digest.sourceHash,
  });
  return digest.sourceHash;
}

async function runPreflight(
  fixture: PreflightFixture,
  installedBaselineHash: string,
) {
  return pluginUninstallPreflight({
    dohcDir: fixture.dohcDir,
    pluginId,
    pluginRoot: fixture.pluginRoot,
    installedBaselineHash,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("plugin uninstall preflight", () => {
  it("reports no local modifications when the live hash matches the baseline", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export const value = 1;\n");
    const installedBaselineHash = await saveBaseline(fixture);

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.verification).toBe("verified");
    expect(result.liveHash).toBe(installedBaselineHash);
    expect(result.warning).toBeNull();
    expect(result.summary).toContain("No local source modifications found");
    expect(result.counts).toMatchObject({
      unchanged: 1,
      modified: 0,
      addedSinceBaseline: 0,
      removedSinceBaseline: 0,
    });
    expect(result.files).toEqual([
      expect.objectContaining({ relPath: "index.ts", status: "unchanged" }),
    ]);
    expect(
      JSON.parse(
        await readFile(
          pluginBaselineManifestPath(fixture.dohcDir, pluginId),
          "utf8",
        ),
      ),
    ).toMatchObject({ sourceHash: installedBaselineHash });
  });

  it("classifies modified text under the capture cap as recoverable", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(fixture, "index.txt", "modified text\n");

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.counts).toMatchObject({
      modified: 1,
      capturedRecoverable: 1,
      notRecoverableFromHistory: 0,
    });
    expect(result.files).toEqual([
      expect.objectContaining({
        relPath: "index.txt",
        status: "modified",
        contentKind: "text",
        historyRecovery: "captured-recoverable",
      }),
    ]);
    expect(result.warning?.notRecoverablePaths).toEqual([]);
  });

  it("classifies modified text exactly at the 128 KiB cap as recoverable", async () => {
    // materialize.rs captures with `metadata.len() > cap` — a file whose
    // length equals the cap exactly is still captured, so this must not be
    // named unrecoverable.
    const fixture = await createFixture();
    await writeSourceFile(fixture, "large.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(
      fixture,
      "large.txt",
      "x".repeat(MAX_HISTORY_TEXT_SNAPSHOT_BYTES),
    );

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.counts.notRecoverableFromHistory).toBe(0);
    expect(result.notRecoverablePaths).toEqual([]);
    expect(result.files).toContainEqual(expect.objectContaining({
      relPath: "large.txt",
      historyRecovery: "captured-recoverable",
    }));
  });

  it("names modified text one byte over the 128 KiB cap as not recoverable", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "large.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(
      fixture,
      "large.txt",
      "x".repeat(MAX_HISTORY_TEXT_SNAPSHOT_BYTES + 1),
    );

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.counts.notRecoverableFromHistory).toBe(1);
    expect(result.notRecoverablePaths).toEqual(["large.txt"]);
    expect(result.warning?.notRecoverablePaths).toEqual(["large.txt"]);
    expect(result.warning?.details.join(" ")).toContain("131,072 bytes");
  });

  it("names a binary file over 5 MiB as not recoverable", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "asset.bin", Uint8Array.from([0, 1, 2]));
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(
      fixture,
      "asset.bin",
      new Uint8Array(MAX_VERSIONED_BINARY_FILE_BYTES + 1).fill(0xff),
    );

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.files).toEqual([
      expect.objectContaining({
        relPath: "asset.bin",
        status: "modified",
        contentKind: "binary",
        historyRecovery: "not-recoverable-from-history",
      }),
    ]);
    expect(result.notRecoverablePaths).toEqual(["asset.bin"]);
    expect(result.warning?.details.join(" ")).toContain("5,242,880 bytes");
  });

  it("classifies a live-only file as added since the baseline", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export {};\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(fixture, "notes.txt", "local notes\n");

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.counts.addedSinceBaseline).toBe(1);
    expect(result.files).toContainEqual(expect.objectContaining({
      relPath: "notes.txt",
      status: "added-since-baseline",
      historyRecovery: "captured-recoverable",
    }));
  });

  it("counts a missing live file as removed without making it a delete target", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export {};\n");
    await writeSourceFile(fixture, "removed.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await rm(join(fixture.pluginRoot, "removed.txt"));

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.counts).toMatchObject({
      modified: 0,
      addedSinceBaseline: 0,
      removedSinceBaseline: 1,
      capturedRecoverable: 0,
      notRecoverableFromHistory: 0,
    });
    expect(result.files).toContainEqual({
      relPath: "removed.txt",
      status: "removed-since-baseline",
      byteLength: null,
      contentKind: null,
      historyRecovery: null,
    });
    expect(result.summary).toBe(
      "1 installation baseline file is already missing. Uninstall will not delete it.",
    );
  });

  it("warns broadly when the baseline manifest is missing", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export {};\n");
    const { sourceHash } = await hashPluginSourceFiles(fixture.pluginRoot);

    const result = await runPreflight(fixture, sourceHash);

    expect(result.verification).toBe("cannot-verify");
    expect(result.counts.unknownWithoutBaseline).toBe(1);
    expect(result.warning).toMatchObject({
      kind: "cannot-verify-baseline",
      summary:
        "dohc cannot verify which plugin source files changed because the installation baseline manifest is missing. Uninstall may delete source that history cannot restore.",
    });
  });

  it("excludes node_modules and .dohc from the inventory and warning", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export {};\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(
      fixture,
      "node_modules/dependency/large.bin",
      new Uint8Array(MAX_VERSIONED_BINARY_FILE_BYTES + 1).fill(0xff),
    );
    await writeSourceFile(fixture, ".dohc/generated.txt", "generated\n");
    await writeSourceFile(fixture, "nested/.dohc/generated.txt", "generated\n");

    const result = await runPreflight(fixture, installedBaselineHash);
    const renderedResult = JSON.stringify(result);

    expect(result.warning).toBeNull();
    expect(result.files.map((file) => file.relPath)).toEqual(["index.ts"]);
    expect(renderedResult).not.toContain("node_modules");
    expect(renderedResult).not.toContain("generated.txt");
  });
});
