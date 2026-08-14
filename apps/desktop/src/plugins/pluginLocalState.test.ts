import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  DEFAULT_PLUGIN_LOCAL_STATE,
  MAX_PLUGIN_LOCAL_STATE_FILE_BYTES,
  mutatePluginRecord,
  pluginStateFileName,
  readPluginLocalState,
} from "./pluginLocalState";

const roots: string[] = [];

async function workspaceRoot(): Promise<string> {
  const root = await createTestScratch("dohc-plugin-workspace-");
  roots.push(root);
  return root;
}

async function stateDir(): Promise<string> {
  const root = await createTestScratch("dohc-plugin-state-");
  roots.push(root);
  return root;
}

function statePath(localStateDir: string, root: string): string {
  return join(localStateDir, "plugin-state", pluginStateFileName(root));
}

function mutateDisabledState(
  localStateDir: string,
  root: string,
  pluginId: string,
  disabled: boolean,
): Promise<void> {
  return mutatePluginRecord(
    localStateDir,
    root,
    pluginId,
    (record) => ({ ...record, disabled }),
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("plugin local state", () => {
  it("derives a deterministic safe filename from the resolved workspace path", async () => {
    const root = await workspaceRoot();
    const equivalentRoot = join(root, "child", "..");
    const fileName = pluginStateFileName(root);

    expect(pluginStateFileName(equivalentRoot)).toBe(fileName);
    expect(fileName).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it.runIf(process.platform === "win32")(
    "uses one state file for Windows path casing",
    async () => {
      const root = await workspaceRoot();
      const differentlySpelledRoot = root.toUpperCase();
      const localStateDir = await stateDir();
      const [rootStats, differentlySpelledStats] = await Promise.all([
        stat(root),
        stat(differentlySpelledRoot),
      ]);

      expect(differentlySpelledRoot).not.toBe(root);
      expect([differentlySpelledStats.dev, differentlySpelledStats.ino]).toEqual([
        rootStats.dev,
        rootStats.ino,
      ]);
      expect(pluginStateFileName(differentlySpelledRoot)).toBe(
        pluginStateFileName(root),
      );

      await mutateDisabledState(localStateDir, root, "hello-plugin", true);

      expect(await readPluginLocalState(localStateDir, differentlySpelledRoot)).toEqual({
        ok: true,
        state: {
          version: 1,
          plugins: { "hello-plugin": { disabled: true } },
        },
      });
    },
  );

  it("uses one state file for a workspace root alias", async () => {
    const root = await workspaceRoot();
    const aliasContainer = await createTestScratch("dohc-plugin-alias-");
    roots.push(aliasContainer);
    const aliasPath = join(aliasContainer, "workspace-alias");
    const markerPath = join(root, "marker.txt");
    const localStateDir = await stateDir();
    await writeFile(markerPath, "workspace content");

    try {
      await symlink(
        root,
        aliasPath,
        process.platform === "win32" ? "junction" : undefined,
      );
      expect(pluginStateFileName(aliasPath)).toBe(pluginStateFileName(root));

      await mutateDisabledState(localStateDir, root, "hello-plugin", true);

      expect(await readPluginLocalState(localStateDir, aliasPath)).toEqual({
        ok: true,
        state: {
          version: 1,
          plugins: { "hello-plugin": { disabled: true } },
        },
      });
    } finally {
      await rm(aliasPath, { force: true });
    }

    expect((await stat(root)).isDirectory()).toBe(true);
    expect(await readFile(markerPath, "utf8")).toBe("workspace content");
  });

  it("returns defaults when the file and state directory are missing", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const pluginStateDir = join(localStateDir, "plugin-state");

    await expect(stat(pluginStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await readPluginLocalState(localStateDir, root);

    expect(result).toEqual({ ok: true, state: DEFAULT_PLUGIN_LOCAL_STATE });
    expect(result).not.toHaveProperty("warning");
    await expect(stat(pluginStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips a disabled plugin", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();

    await mutateDisabledState(localStateDir, root, "hello-plugin", true);

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: { "hello-plugin": { disabled: true } },
      },
    });
  });

  it("round-trips the installed baseline hash without a version bump", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const installedBaselineHash = "a".repeat(64);

    await mutatePluginRecord(
      localStateDir,
      root,
      "hello-plugin",
      (record) => ({ ...record, installedBaselineHash }),
    );

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: { "hello-plugin": { installedBaselineHash } },
      },
    });
  });

  it("removes a plugin record when the updater returns undefined", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();

    await mutateDisabledState(localStateDir, root, "hello-plugin", true);
    await mutatePluginRecord(
      localStateDir,
      root,
      "hello-plugin",
      () => undefined,
    );

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: DEFAULT_PLUGIN_LOCAL_STATE,
    });
  });

  it("keeps different workspaces isolated under one state directory", async () => {
    const firstRoot = await workspaceRoot();
    const secondRoot = await workspaceRoot();
    const localStateDir = await stateDir();

    await mutateDisabledState(localStateDir, firstRoot, "first-plugin", true);

    expect(await readPluginLocalState(localStateDir, secondRoot)).toEqual({
      ok: true,
      state: DEFAULT_PLUGIN_LOCAL_STATE,
    });

    await mutateDisabledState(localStateDir, secondRoot, "second-plugin", true);

    expect(pluginStateFileName(firstRoot)).not.toBe(
      pluginStateFileName(secondRoot),
    );
    expect(await readPluginLocalState(localStateDir, firstRoot)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: { "first-plugin": { disabled: true } },
      },
    });
    expect(await readPluginLocalState(localStateDir, secondRoot)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: { "second-plugin": { disabled: true } },
      },
    });
  });

  it("creates the plugin-state directory and writes only outside the workspace", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const metadataRoot = join(root, ".dohc");
    const pluginStateDir = join(localStateDir, "plugin-state");
    const path = statePath(localStateDir, root);
    await mkdir(metadataRoot);

    await expect(stat(pluginStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await mutateDisabledState(localStateDir, root, "hello-plugin", true);

    expect((await stat(pluginStateDir)).isDirectory()).toBe(true);
    expect((await stat(path)).isFile()).toBe(true);
    expect(await readdir(root)).toEqual([".dohc"]);
    expect(await readdir(metadataRoot)).toEqual([]);
  });

  it("fails closed when the file is malformed", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    await mkdir(dirname(path));
    await writeFile(path, "{not json");

    const result = await readPluginLocalState(localStateDir, root);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected malformed JSON to fail");
    expect(result).not.toHaveProperty("state");
    expect(result.warning).toContain(path);
    expect(result.warning).toContain("is not valid JSON");
  });

  it("fails closed when the file does not match its schema", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({ version: 2, plugins: {} }));

    const result = await readPluginLocalState(localStateDir, root);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected schema validation to fail");
    expect(result).not.toHaveProperty("state");
    expect(result.warning).toContain(path);
    expect(result.warning).toContain("version:");
    expect(result.warning).toContain("expected 1");
  });

  it.each([
    ["non-hex", "g".repeat(64)],
    ["wrong-length", "a".repeat(63)],
  ])("fails closed for a %s approvedHash", async (_case, approvedHash) => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({
      version: 1,
      plugins: { "hello-plugin": { approvedHash } },
    }));

    const result = await readPluginLocalState(localStateDir, root);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an invalid approvedHash to fail");
    expect(result.warning).toContain(
      "approvedHash: must be a 64-character lowercase hex sha256 digest",
    );
  });

  it("reads a 64-character lowercase hex approvedHash", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    const approvedHash = "0123456789abcdef".repeat(4);
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({
      version: 1,
      plugins: { "hello-plugin": { approvedHash } },
    }));

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: { "hello-plugin": { approvedHash } },
      },
    });
  });

  it("fails closed when the file is over 256 KiB", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    const size = MAX_PLUGIN_LOCAL_STATE_FILE_BYTES + 1;
    await mkdir(dirname(path));
    await writeFile(path, " ".repeat(size));

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: false,
      warning: `Plugin local state file at ${path} must be 256 KiB (${MAX_PLUGIN_LOCAL_STATE_FILE_BYTES} bytes) or smaller; found ${size} bytes.`,
    });
  });

  it("does not overwrite a corrupt file when disabling a plugin", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    await mkdir(dirname(path));
    await writeFile(path, "{not json");

    const readResult = await readPluginLocalState(localStateDir, root);
    expect(readResult.ok).toBe(false);
    if (readResult.ok) throw new Error("expected malformed JSON to fail");
    const before = await readFile(path);
    let thrown: unknown;
    try {
      await mutateDisabledState(localStateDir, root, "hello-plugin", true);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected an Error");
    expect(thrown.message).toBe(readResult.warning);
    expect(await readFile(path)).toEqual(before);
  });

  it("writes a 501st plugin entry, which fits the file limit", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    const plugins = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `plugin-${index}`,
        { disabled: false },
      ]),
    );
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({ version: 1, plugins }));

    await mutateDisabledState(localStateDir, root, "one-more-plugin", true);

    const readResult = await readPluginLocalState(localStateDir, root);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error("expected 501 plugin entries to be valid");
    expect(Object.keys(readResult.state.plugins)).toHaveLength(501);
    expect((await readFile(path)).byteLength)
      .toBeLessThan(MAX_PLUGIN_LOCAL_STATE_FILE_BYTES);
  });

  it("refuses to write a state file the read gate could not read back", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const path = statePath(localStateDir, root);
    // Fewer records than the deleted count cap allowed, and already over the
    // byte limit — the count was never what bounded this file (#779 round 9
    // B4).
    const plugins = Object.fromEntries(
      Array.from({ length: 800 }, (_, index) => [
        `plugin-${index}`.padEnd(214, "x"),
        { disabled: false, approvedHash: "a".repeat(64) },
      ]),
    );
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({ version: 1, plugins }));
    const before = await readFile(path);
    // Readable as written, and over the limit once rewritten: the read gate
    // alone cannot stop the write that bricks it.
    expect(before.byteLength).toBeLessThan(MAX_PLUGIN_LOCAL_STATE_FILE_BYTES);

    let thrown: unknown;
    try {
      await mutateDisabledState(localStateDir, root, "one-more-plugin", true);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected an Error");
    expect(thrown.message).toContain("plugin records");
    expect(thrown.message).toContain(`${MAX_PLUGIN_LOCAL_STATE_FILE_BYTES} bytes`);
    expect(await readFile(path)).toEqual(before);
  });

  it("queues overlapping mutations so each updater sees the previous result", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const approvedHash = "a".repeat(64);
    const installedBaselineHash = "b".repeat(64);
    let recordSeenBySecondMutation: unknown;

    await Promise.all([
      mutatePluginRecord(
        localStateDir,
        root,
        "hello-plugin",
        (record) => ({ ...record, approvedHash }),
      ),
      mutatePluginRecord(
        localStateDir,
        root,
        "hello-plugin",
        (record) => {
          recordSeenBySecondMutation = record;
          return { ...record, installedBaselineHash };
        },
      ),
    ]);

    expect(recordSeenBySecondMutation).toEqual({ approvedHash });
    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: {
          "hello-plugin": { approvedHash, installedBaselineHash },
        },
      },
    });
  });
});
