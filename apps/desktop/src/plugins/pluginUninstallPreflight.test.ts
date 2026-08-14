import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_VERSIONED_BINARY_FILE_BYTES } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUninstallPreflightRecord } from "../ipc/bridgeContract";
import { PLUGIN_UNINSTALL_PATH_SAMPLE_LIMIT } from "../ipc/channels";
import { createTestScratch } from "../workspaces/testTemp";
import { MAX_HISTORY_TEXT_SNAPSHOT_BYTES } from "../workspaces/workspaceWatcher";
import { hashPluginSourceFiles } from "./pluginSourceSnapshot";

// A pure JS-level interception so one test can make a specific file vanish
// out from under classifyHistoryRecovery right when it tries to stat it —
// reproducing the exact TOCTOU window between hashPluginSourceFiles (which
// already saw the file) and this read (CodeRabbit #779 R27).
let poisonedPath: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (async (path: Parameters<typeof stat>[0], options?: unknown) => {
      if (poisonedPath !== null && String(path) === poisonedPath) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      }
      return actual.stat(path as string, options as never);
    }) as typeof stat,
  };
});

const {
  pluginBaselineManifestPath,
  pluginUninstallPreflight,
  summarizeUninstallPreflight,
  writePluginBaselineManifest,
} = await import("./pluginUninstallPreflight");

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
  poisonedPath = null;
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

  it("refuses to promise recovery for any file when engine capture is unavailable (CodeRabbit #779 fixround Section B item 7)", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(fixture, "index.txt", "modified text\n");

    const result = await runPreflight(fixture, installedBaselineHash, false);

    // Well under the capture size cap — the old, size-only classification
    // would have called this "captured-recoverable" regardless of whether
    // anything was actually there to record it.
    expect(result.counts).toMatchObject({
      modified: 1,
      capturedRecoverable: 0,
      notRecoverableFromHistory: 1,
    });
    expect(result.files).toEqual([
      expect.objectContaining({
        relPath: "index.txt",
        status: "modified",
        historyRecovery: "not-recoverable-from-history",
      }),
    ]);
    expect(result.warning?.notRecoverablePaths).toEqual(["index.txt"]);
    expect(result.warning?.details.join(" ")).toContain(
      "History capture is not currently running",
    );
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

  it("degrades one file to not-recoverable instead of crashing the whole preflight when it vanishes mid-check (CodeRabbit #779 R27)", async () => {
    const fixture = await createFixture();
    await writeSourceFile(fixture, "index.txt", "baseline text\n");
    const installedBaselineHash = await saveBaseline(fixture);
    await writeSourceFile(fixture, "index.txt", "modified text\n");
    poisonedPath = join(fixture.pluginRoot, "index.txt");

    const result = await runPreflight(fixture, installedBaselineHash);

    expect(result.files).toEqual([
      expect.objectContaining({
        relPath: "index.txt",
        status: "modified",
        byteLength: null,
        contentKind: null,
        historyRecovery: "not-recoverable-from-history",
      }),
    ]);
    expect(result.notRecoverablePaths).toEqual(["index.txt"]);
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

    // Capture is not running, so no changed file can be promised back.
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
});
