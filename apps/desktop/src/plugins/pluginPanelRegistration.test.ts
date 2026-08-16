import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  forgetRemovedPlugin,
  forgetUninstalledPlugin,
  forgetWorkspaceRegistrations,
  loadPluginPanelRegistration,
  loadPluginWebAppRegistration,
  pluginLifecycleKey,
  rememberPluginRegistration,
  startPluginForPanel,
  type RegisteredPlugin,
} from "./pluginPanelRegistration";

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
      webApps: [{ id: "app", title: "Hello App" }],
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

  it("loads a declared web app under the same root and manifest checks", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot);

    await expect(
      loadPluginWebAppRegistration({
        workspaceRoot: workspace,
        pluginRoot: "plugins/hello-plugin",
        pluginId: "hello-plugin",
        webAppId: "app",
      }),
    ).resolves.toMatchObject({
      pluginRoot,
      webApp: { id: "app", title: "Hello App" },
    });
    await expect(
      loadPluginWebAppRegistration({
        workspaceRoot: workspace,
        pluginRoot: "plugins/hello-plugin",
        pluginId: "hello-plugin",
        webAppId: "missing",
      }),
    ).rejects.toThrow('does not declare web app "missing"');
    await expect(
      loadPluginWebAppRegistration({
        workspaceRoot: workspace,
        pluginRoot: "../outside",
        pluginId: "hello-plugin",
        webAppId: "app",
      }),
    ).rejects.toThrow();
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

  it("serves the panels of the manifest as it is now, not as first registered (#779 round 10 B7)", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot);
    const registrations = new Map<string, Map<string, RegisteredPlugin>>();
    const load = (panelId: string) =>
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "hello-plugin",
        panelId,
      });

    rememberPluginRegistration(registrations, "workspace-1", await load("main"));

    // The plugin author adds a panel and the user approves it. Serving the
    // first registration's manifest forever left the new panel unstartable.
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      JSON.stringify({
        version: 1,
        name: "hello-plugin",
        entry: "plugin.mjs",
        panels: [
          { id: "main", title: "Hello again", entry: "panel/index.html" },
          { id: "second", title: "Second", entry: "panel/second.html" },
        ],
      }),
    );
    await writeFile(join(pluginRoot, "panel", "second.html"), "<h1>Two</h1>\n");

    const remembered = rememberPluginRegistration(
      registrations,
      "workspace-1",
      await load("second"),
    );

    expect(remembered.manifest.panels?.map((panel) => panel.id))
      .toEqual(["main", "second"]);
    expect(registrations.get("workspace-1")?.get("hello-plugin")?.manifest)
      .toBe(remembered.manifest);
    expect(remembered.manifest.panels?.[0]?.title).toBe("Hello again");
  });

  it("claims a plugin host only when the panel's own start ran it (#779 round 10 B3)", async () => {
    const panelStartedHosts = new Set<string>();
    const claim = (result: {
      running: boolean;
      startedHost: boolean;
    }) => {
      const calls: string[] = [];
      return {
        calls,
        run: () =>
          startPluginForPanel({
            panelStartedHosts,
            workspaceId: "workspace-1",
            pluginId: "hello-plugin",
            isHostRunning: () => result.running,
            ensureStarted: async () => {
              calls.push("ensureStarted");
              return { ok: true, startedHost: result.startedHost };
            },
          }),
      };
    };

    // Already running: the panel rides along and starts nothing.
    const riding = claim({ running: true, startedHost: false });
    await riding.run();
    expect(riding.calls).toEqual([]);
    expect(panelStartedHosts.size).toBe(0);

    // Started by something else between the check and the start — a queued
    // workspace reconciliation. The pipeline says this call did not perform
    // the transition, so the panel must not own the host.
    const overtaken = claim({ running: false, startedHost: false });
    await overtaken.run();
    expect(overtaken.calls).toEqual(["ensureStarted"]);
    expect(panelStartedHosts.size).toBe(0);

    // This start ran the host: the panel owns stopping it.
    await claim({ running: false, startedHost: true }).run();
    expect([...panelStartedHosts]).toEqual([
      pluginLifecycleKey("workspace-1", "hello-plugin"),
    ]);
  });

  it("reports a refused start instead of claiming the host", async () => {
    const panelStartedHosts = new Set<string>();

    await expect(
      startPluginForPanel({
        panelStartedHosts,
        workspaceId: "workspace-1",
        pluginId: "hello-plugin",
        isHostRunning: () => false,
        ensureStarted: async () => ({
          ok: false,
          error: { message: "Plugin source changed. Review it again." },
        }),
      }),
    ).rejects.toThrow("Plugin source changed. Review it again.");
    expect(panelStartedHosts.size).toBe(0);
  });

  it("forgets an uninstalled plugin, and only when uninstall succeeded (#779 round 10 B7)", () => {
    const registration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      manifest: { version: 1, name: "hello-plugin", entry: "plugin.mjs" },
    };
    const registrations = new Map([
      ["workspace-1", new Map([["hello-plugin", registration]])],
    ]);
    const panelStartedHosts = new Set([
      pluginLifecycleKey("workspace-1", "hello-plugin"),
    ]);

    // A refused uninstall deleted nothing, so the plugin keeps serving.
    forgetUninstalledPlugin({
      registrations,
      panelStartedHosts,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      uninstalled: false,
    });
    expect(registrations.get("workspace-1")?.get("hello-plugin"))
      .toBe(registration);
    expect(panelStartedHosts.size).toBe(1);

    forgetUninstalledPlugin({
      registrations,
      panelStartedHosts,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      uninstalled: true,
    });
    expect(registrations.get("workspace-1")?.get("hello-plugin"))
      .toBeUndefined();
    expect(panelStartedHosts.size).toBe(0);
  });

  it("forgets the registrations of a closing workspace and no others", () => {
    const registration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      manifest: { version: 1, name: "hello-plugin", entry: "plugin.mjs" },
    };
    const registrations = new Map([
      ["workspace-1", new Map([["hello-plugin", registration]])],
      ["workspace-2", new Map([["hello-plugin", registration]])],
    ]);

    forgetWorkspaceRegistrations(registrations, "workspace-1");

    expect(registrations.get("workspace-1")).toBeUndefined();
    expect(registrations.get("workspace-2")?.get("hello-plugin"))
      .toBe(registration);
  });

  it("refuses a second registration from another root", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot);
    const registration = await loadPluginPanelRegistration({
      workspaceRoot: workspace,
      pluginRoot,
      pluginId: "hello-plugin",
      panelId: "main",
    });
    const registrations = new Map<string, Map<string, RegisteredPlugin>>();
    rememberPluginRegistration(registrations, "workspace-1", registration);

    expect(() =>
      rememberPluginRegistration(registrations, "workspace-1", {
        ...registration,
        pluginRoot: join(workspace, "plugins", "elsewhere"),
      })
    ).toThrow(/already running from another root/);
  });

  it("releases a departed identity's registration on its removed event, so a rename plus reinstall can open panels again (#779 round 14 A5)", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const oldRoot = join(workspace, "plugins", "foo");
    await writePlugin(oldRoot);
    const registration = await loadPluginPanelRegistration({
      workspaceRoot: workspace,
      pluginRoot: oldRoot,
      pluginId: "hello-plugin",
      panelId: "main",
    });
    const registrations = new Map<string, Map<string, RegisteredPlugin>>();
    const panelStartedHosts = new Set([
      pluginLifecycleKey("workspace-1", "hello-plugin"),
    ]);
    const remembered = rememberPluginRegistration(
      registrations,
      "workspace-1",
      registration,
    );

    // Ordinary status traffic changes nothing.
    forgetRemovedPlugin({
      registrations,
      panelStartedHosts,
      workspaceId: "workspace-1",
      event: {
        kind: "changed",
        plugin: {
          id: "hello-plugin",
          directoryName: "foo",
          rootPath: oldRoot,
          valid: true,
          status: "ready",
          disabledReason: null,
          runtimeStatus: "ready",
          displayName: null,
          description: null,
          publisher: null,
          icon: null,
          settings: [],
          webApps: [],
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
          diagnostics: [],
          warnings: [],
          error: null,
        },
      },
    });
    expect(registrations.get("workspace-1")?.get("hello-plugin"))
      .toBe(remembered);

    // The rename departs the old identity through the watcher path — not
    // uninstall — and its removed event must release the registration, or
    // every panel of the reinstalled plugin throws "already running from
    // another root" until the workspace reopens.
    forgetRemovedPlugin({
      registrations,
      panelStartedHosts,
      workspaceId: "workspace-1",
      event: { kind: "removed", pluginId: "hello-plugin" },
    });
    expect(panelStartedHosts.size).toBe(0);

    const newRoot = join(workspace, "plugins", "bar");
    await writePlugin(newRoot);
    const reinstalled = await loadPluginPanelRegistration({
      workspaceRoot: workspace,
      pluginRoot: newRoot,
      pluginId: "hello-plugin",
      panelId: "main",
    });
    expect(
      rememberPluginRegistration(registrations, "workspace-1", reinstalled),
    ).toMatchObject({ pluginRoot: newRoot });
  });
});
