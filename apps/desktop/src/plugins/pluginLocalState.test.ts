import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  DEFAULT_PLUGIN_LOCAL_STATE,
  MAX_PLUGIN_LOCAL_STATE_FILE_BYTES,
  pluginStateFileName,
  readPluginLocalState,
  setPluginDisabled,
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

      await setPluginDisabled(localStateDir, root, "hello-plugin", true);

      expect(await readPluginLocalState(localStateDir, differentlySpelledRoot)).toEqual({
        ok: true,
        state: {
          version: 1,
          plugins: { "hello-plugin": { disabled: true } },
        },
      });
    },
  );

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

    await setPluginDisabled(localStateDir, root, "hello-plugin", true);

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: { "hello-plugin": { disabled: true } },
      },
    });
  });

  it("keeps different workspaces isolated under one state directory", async () => {
    const firstRoot = await workspaceRoot();
    const secondRoot = await workspaceRoot();
    const localStateDir = await stateDir();

    await setPluginDisabled(localStateDir, firstRoot, "first-plugin", true);

    expect(await readPluginLocalState(localStateDir, secondRoot)).toEqual({
      ok: true,
      state: DEFAULT_PLUGIN_LOCAL_STATE,
    });

    await setPluginDisabled(localStateDir, secondRoot, "second-plugin", true);

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
    await setPluginDisabled(localStateDir, root, "hello-plugin", true);

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
      await setPluginDisabled(localStateDir, root, "hello-plugin", true);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected an Error");
    expect(thrown.message).toBe(readResult.warning);
    expect(await readFile(path)).toEqual(before);
  });

  it("keeps both updates when two writes overlap", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();

    await Promise.all([
      setPluginDisabled(localStateDir, root, "first-plugin", true),
      setPluginDisabled(localStateDir, root, "second-plugin", true),
    ]);

    expect(await readPluginLocalState(localStateDir, root)).toEqual({
      ok: true,
      state: {
        version: 1,
        plugins: {
          "first-plugin": { disabled: true },
          "second-plugin": { disabled: true },
        },
      },
    });
  });
});
