import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginUninstallPreflightRecord } from "../ipc/bridgeContract";
import { PLUGIN_UNINSTALL_PATH_SAMPLE_LIMIT } from "../ipc/channels";
import { createTestScratch } from "../workspaces/testTemp";
import { hashPluginSourceFiles } from "./pluginSourceSnapshot";
import {
  pluginBaselineManifestPath,
  pluginUninstallPreflight,
  summarizeUninstallPreflight,
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
  engineCaptureAvailable = true,
) {
  return pluginUninstallPreflight({
    dohcDir: fixture.dohcDir,
    pluginId,
    pluginRoot: fixture.pluginRoot,
    installedBaselineHash,
    engineCaptureAvailable,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("plugin uninstall preflight", () => {
  it("warns instead of reporting a clean tree when a symlink was dropped into the source", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export const value = 1;\n");
    const installedBaselineHash = await saveBaseline(fixture);
    // A symlink is invisible to a hash that records only regular files, so
    // before this it reported "no local modifications" while recursive
    // removal still deleted the link.
    await symlink(
      join(fixture.pluginRoot, "index.ts"),
      join(fixture.pluginRoot, "linked.ts"),
      process.platform === "win32" ? "junction" : "file",
    );

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.verification).toBe("cannot-verify");
    expect(result.warning).not.toBeNull();
    expect(result.warning?.kind).toBe("cannot-verify-baseline");
    expect(result.summary).not.toContain("No local source modifications found");
    expect(result.summary).toContain("symlink or junction");
  });

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

  it("never promises recovery it cannot verify, even with capture running (#779 round 7 B2)", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    // A tiny edit made a moment ago, with capture running: the old size-plus-
    // flag classification called this "recoverable" and let the dialog promise
    // it back, even though nothing here can tell whether a capture batch ever
    // settled for it.
    await writeSourceFile(fixture, "index.txt", "modified text\n");

    const result = await runPreflight(fixture, installedBaselineHash, true);

    expect(result.counts).toMatchObject({
      modified: 1,
      notRecoverableFromHistory: 1,
    });
    expect(result.notRecoverablePaths).toEqual(["index.txt"]);
    expect(result.warning?.notRecoverablePaths).toEqual(["index.txt"]);
    const details = result.warning?.details.join(" ") ?? "";
    expect(details).toContain("dohc cannot confirm history holds a copy");
    expect(details).toContain("Copy what you need before you uninstall.");
    expect(details).not.toContain("can be recovered from history");
  });

  it("states the stronger fact when engine capture is not running", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(fixture, "index.txt", "modified text\n");

    const result = await runPreflight(fixture, installedBaselineHash, false);

    expect(result.counts).toMatchObject({
      modified: 1,
      notRecoverableFromHistory: 1,
    });
    expect(result.warning?.details.join(" ")).toContain(
      "History capture is not running, so history holds no copy of these files.",
    );
  });

  it("classifies a live-only file as added since the baseline", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export {};\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(fixture, "notes.txt", "local notes\n");

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.counts.addedSinceBaseline).toBe(1);
    expect(result.files).toContainEqual({
      relPath: "notes.txt",
      status: "added-since-baseline",
    });
    // Uninstall deletes it and dohc cannot confirm history holds it.
    expect(result.notRecoverablePaths).toEqual(["notes.txt"]);
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
      notRecoverableFromHistory: 0,
    });
    expect(result.files).toContainEqual({
      relPath: "removed.txt",
      status: "removed-since-baseline",
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
      "node_modules/dependency/installed.bin",
      Uint8Array.from([0, 1, 2]),
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

  it("sends the renderer a bounded summary, not the whole file inventory", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 25; index += 1) {
      await writeSourceFile(fixture, `asset-${index}.bin`, `bytes ${index}\n`);
    }
    const installedBaselineHash = await saveBaseline(fixture);
    for (let index = 0; index < 25; index += 1) {
      await writeSourceFile(fixture, `asset-${index}.bin`, `changed ${index}\n`);
    }

    const result = await runPreflight(fixture, installedBaselineHash, false);
    const summary = summarizeUninstallPreflight(result);

    expect(result.warning?.notRecoverablePaths).toHaveLength(25);
    expect(summary.warning?.notRecoverablePathSample).toHaveLength(
      PLUGIN_UNINSTALL_PATH_SAMPLE_LIMIT,
    );
    expect(summary.counts.notRecoverableFromHistory).toBe(25);
    // The bridge contract is the enforcing edge: an uncapped producer fails
    // here instead of shipping an unbounded array to the renderer.
    expect(() => PluginUninstallPreflightRecord.parse(summary)).not.toThrow();
    expect(Object.keys(summary)).not.toContain("files");
  });

  it("reports an already-deleted source folder as nothing left to warn about (#779 round 12 A2)", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.ts", "export const value = 1;\n");
    const installedBaselineHash = await saveBaseline(fixture);
    // What an uninstall that deleted the source and then failed on the
    // plugin data or the record leaves behind.
    await rm(fixture.pluginRoot, { recursive: true, force: true });

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.verification).toBe("verified");
    expect(result.liveHash).toBeNull();
    expect(result.warning).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.counts.notRecoverableFromHistory).toBe(0);
    expect(result.summary).toContain("already deleted");
    expect(result.summary).not.toContain("cannot verify");
  });
});
