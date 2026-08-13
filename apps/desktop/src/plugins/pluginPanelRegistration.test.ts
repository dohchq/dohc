import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { loadPluginPanelRegistration } from "./pluginPanelRegistration";

const roots: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const root = await createTestScratch(prefix);
  roots.push(root);
  return root;
}

async function writePlugin(root: string): Promise<void> {
  await mkdir(join(root, "panel"), { recursive: true });
  await writeFile(
    join(root, "dohc-plugin.json"),
    JSON.stringify({
      version: 1,
      name: "hello-plugin",
      entry: "plugin.mjs",
      panels: [{ id: "main", title: "Hello", entry: "panel/index.html" }],
    }),
  );
  await writeFile(join(root, "plugin.mjs"), "export default { activate() {} };\n");
  await writeFile(join(root, "panel", "index.html"), "<h1>Hello</h1>\n");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("plugin panel registration", () => {
  it("loads a workspace-contained plugin from relative or explicit roots", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot: "plugins/hello-plugin",
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).resolves.toMatchObject({
      pluginRoot,
      panel: { id: "main", title: "Hello", entry: "panel/index.html" },
    });
    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).resolves.toMatchObject({ pluginRoot });
  });

  it("refuses a plugin root outside the workspace", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const outside = await scratch("dohc-plugin-panel-outside-");
    await writePlugin(outside);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot: outside,
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).rejects.toThrow(`Plugin root escapes the workspace: ${outside}.`);
  });

  it("requires the canonical plugin root to be under the workspace plugins tree", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const sourcePlugin = join(workspace, "src", "hello-plugin");
    await writePlugin(sourcePlugin);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot: "src/hello-plugin",
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).rejects.toThrow(/must be under the workspace plugins\/ tree/i);

    const installedPlugin = join(workspace, "plugins", "hello-plugin");
    await writePlugin(installedPlugin);
    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot: "plugins/hello-plugin",
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).resolves.toMatchObject({ pluginRoot: installedPlugin });
  });

  it("refuses executable plugins from shared-with-me", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "shared-with-me", "hello-plugin");
    await writePlugin(pluginRoot);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot: "shared-with-me/hello-plugin",
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).rejects.toThrow(/Invalid asset path \(reserved\)/);
  });

  it("requires the requested plugin and panel identities", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "other-plugin",
        panelId: "main",
      }),
    ).rejects.toThrow(/does not match manifest name/);
    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "hello-plugin",
        panelId: "missing",
      }),
    ).rejects.toThrow(/does not declare panel/);
  });
});
