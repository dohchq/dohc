import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  DEFAULT_PLUGIN_LOCAL_STATE,
  PLUGIN_LOCAL_STATE_FILE,
  readPluginLocalState,
  setPluginDisabled,
} from "./pluginLocalState";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTestScratch("dohc-plugin-local-state-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("plugin local state", () => {
  it("returns defaults when the file is missing", async () => {
    const result = await readPluginLocalState(await tempRoot());

    expect(result).toEqual({ state: DEFAULT_PLUGIN_LOCAL_STATE });
  });

  it("round-trips a disabled plugin", async () => {
    const root = await tempRoot();

    await setPluginDisabled(root, "hello-plugin", true);

    expect(await readPluginLocalState(root)).toEqual({
      state: {
        version: 1,
        plugins: { "hello-plugin": { disabled: true } },
      },
    });
  });

  it("returns defaults and warns when the file is malformed", async () => {
    const root = await tempRoot();
    const path = join(root, ".dohc", PLUGIN_LOCAL_STATE_FILE);
    await mkdir(join(root, ".dohc"));
    await writeFile(path, "{not json");

    const result = await readPluginLocalState(root);

    expect(result.state).toEqual(DEFAULT_PLUGIN_LOCAL_STATE);
    expect(result.warning).toContain(path);
    expect(result.warning).toContain("is not valid JSON");
  });

  it("keeps both updates when two writes overlap", async () => {
    const root = await tempRoot();

    await Promise.all([
      setPluginDisabled(root, "first-plugin", true),
      setPluginDisabled(root, "second-plugin", true),
    ]);

    expect((await readPluginLocalState(root)).state.plugins).toEqual({
      "first-plugin": { disabled: true },
      "second-plugin": { disabled: true },
    });
  });
});
