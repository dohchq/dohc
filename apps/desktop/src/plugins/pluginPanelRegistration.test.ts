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
  rememberPluginRegistration,
  resolveRegisteredPlugin,
  type RegisteredPlugin,
} from "./pluginPanelRegistration";

const roots: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const root = await createTestScratch(prefix);
  roots.push(root);
  return root;
}

async function writePlugin(
  root: string,
  panels: Record<string, unknown>[] = [
    { id: "main", title: "Hello", entry: "panel/index.html" },
  ],
): Promise<void> {
  await mkdir(join(root, "panel"), { recursive: true });
  await writeFile(
    join(root, "dohc-plugin.json"),
    JSON.stringify({
      version: 1,
      name: "hello-plugin",
      entry: "plugin.mjs",
      panels,
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

  it("loads a plugin whose directory NAME starts with '..' from its absolute root", async () => {
    // A ".."-prefixed plugin directory is a real contained name, not traversal.
    // (The ..-segment mutation is unreachable here: every root this module
    // resolves is under plugins/, so relative() starts with that segment.)
    const workspace = await scratch("dohc-plugin-panel-dotdot-");
    const pluginRoot = join(workspace, "plugins", "..cache");
    await writePlugin(pluginRoot);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).resolves.toMatchObject({ pluginRoot });
  });

  it("refuses to open a view-placed panel as a tab", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot, [
      { id: "main", title: "Hello", entry: "panel/index.html" },
      {
        id: "sites",
        title: "Sites",
        entry: "panel/index.html",
        placement: "view",
      },
    ]);

    // One running panel per (workspace, plugin, panel): a tab and a rail view
    // of the same panel would stop each other, so placement decides which of
    // the two a panel can be.
    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "hello-plugin",
        panelId: "sites",
      }),
    ).rejects.toThrow(/placement "view"/);

    await expect(
      loadPluginPanelRegistration({
        workspaceRoot: workspace,
        pluginRoot,
        pluginId: "hello-plugin",
        panelId: "main",
      }),
    ).resolves.toMatchObject({ panel: { id: "main" } });
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

  it("prefers a recovered manifest while preserving plugin-root validation", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    await writePlugin(pluginRoot);
    const recovered: RegisteredPlugin = {
      pluginRoot,
      directoryName: "hello-plugin",
      manifest: {
        version: 1,
        name: "hello-plugin",
        entry: "plugin.mjs",
        panels: [{
          id: "old-panel",
          title: "Old panel",
          entry: "panel/index.html",
          placement: "editor",
        }],
        webApps: [{ id: "old-app", title: "Old app", instanced: false }],
      },
    };
    const pluginRegistration = {
      pluginRegistration: () => recovered,
      hasUnrecoverableFailedReplacement: () => false,
    };

    await expect(loadPluginPanelRegistration({
      workspaceRoot: workspace,
      pluginRoot,
      pluginId: "hello-plugin",
      panelId: "old-panel",
      pluginRegistration,
    })).resolves.toMatchObject({
      manifest: recovered.manifest,
      panel: { id: "old-panel" },
    });
    await expect(loadPluginWebAppRegistration({
      workspaceRoot: workspace,
      pluginRoot,
      pluginId: "hello-plugin",
      webAppId: "old-app",
      pluginRegistration,
    })).resolves.toMatchObject({
      manifest: recovered.manifest,
      webApp: { id: "old-app" },
    });
    await expect(loadPluginWebAppRegistration({
      workspaceRoot: workspace,
      pluginRoot: "../outside",
      pluginId: "hello-plugin",
      webAppId: "old-app",
      pluginRegistration,
    })).rejects.toThrow(/Invalid asset path|escapes the workspace/);
  });

  it("refuses to open a panel or web app from the failed candidate's own manifest when nothing could be recovered (#779 round 23 finding 1)", async () => {
    const workspace = await scratch("dohc-plugin-panel-workspace-");
    const pluginRoot = join(workspace, "plugins", "hello-plugin");
    // The on-disk manifest here is the failed, never-approved candidate's
    // own — reachable only because loadValidatedPluginManifest's raw-read
    // fallback would otherwise happily read it once pluginRegistration()
    // itself refuses with null.
    await writePlugin(pluginRoot);
    const pluginRegistration = {
      pluginRegistration: () => null,
      hasUnrecoverableFailedReplacement: () => true,
    };

    await expect(loadPluginPanelRegistration({
      workspaceRoot: workspace,
      pluginRoot,
      pluginId: "hello-plugin",
      panelId: "main",
      pluginRegistration,
    })).rejects.toThrow(
      /could not recover plugin "hello-plugin"'s last working build/,
    );
    await expect(loadPluginWebAppRegistration({
      workspaceRoot: workspace,
      pluginRoot,
      pluginId: "hello-plugin",
      webAppId: "app",
      pluginRegistration,
    })).rejects.toThrow(
      /could not recover plugin "hello-plugin"'s last working build/,
    );
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

    rememberPluginRegistration(
      registrations,
      "workspace-1",
      { ...await load("main"), directoryName: "hello-plugin" },
    );

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
      { ...await load("second"), directoryName: "hello-plugin" },
    );

    expect(remembered.manifest.panels?.map((panel) => panel.id))
      .toEqual(["main", "second"]);
    expect(registrations.get("workspace-1")?.get("hello-plugin")?.manifest)
      .toBe(remembered.manifest);
    expect(remembered.manifest.panels?.[0]?.title).toBe("Hello again");
  });

  it("prefers the pipeline's current manifest over a remembered registration", () => {
    const oldRegistration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      directoryName: "hello-plugin",
      manifest: {
        version: 1,
        name: "hello-plugin",
        entry: "plugin.mjs",
      },
    };
    const currentRegistration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      directoryName: "hello-plugin",
      manifest: {
        version: 1,
        name: "hello-plugin",
        entry: "plugin.mjs",
        commands: [{ id: "hello.write", title: "Write hello note" }],
      },
    };
    const pipeline = {
      pluginRegistration: () => currentRegistration,
      hasUnrecoverableFailedReplacement: () => false,
    };
    const remembered = new Map([["hello-plugin", oldRegistration]]);

    const resolved = resolveRegisteredPlugin(
      "hello-plugin",
      pipeline,
      remembered,
    );

    expect(resolved).toBe(currentRegistration);
    expect(
      resolved?.manifest.commands?.find(
        (command) => command.id === "hello.write",
      ),
    ).toEqual({ id: "hello.write", title: "Write hello note" });
  });

  it("forgets an uninstalled plugin, and only when uninstall succeeded (#779 round 10 B7)", () => {
    const registration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      manifest: { version: 1, name: "hello-plugin", entry: "plugin.mjs" },
      directoryName: "hello-plugin",
    };
    const registrations = new Map([
      ["workspace-1", new Map([["hello-plugin", registration]])],
    ]);
    // A refused uninstall deleted nothing, so the plugin keeps serving.
    forgetUninstalledPlugin({
      registrations,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      directoryName: "hello-plugin",
      uninstalled: false,
    });
    expect(registrations.get("workspace-1")?.get("hello-plugin"))
      .toBe(registration);
    forgetUninstalledPlugin({
      registrations,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      directoryName: "hello-plugin",
      uninstalled: true,
    });
    expect(registrations.get("workspace-1")?.get("hello-plugin"))
      .toBeUndefined();
  });

  // #779-offers round 24 finding 4: an id-losing collision loser's own
  // removal must never forget a still-installed winner's own registration
  // under the same shared id — this id's registration is only ever the
  // event's own directory's to forget.
  it("never forgets a registration whose own directory differs from the removed event's", () => {
    const registration: RegisteredPlugin = {
      pluginRoot: "plugins/winner-dir",
      manifest: { version: 1, name: "shared-id", entry: "plugin.mjs" },
      directoryName: "winner-dir",
    };
    const registrations = new Map([
      ["workspace-1", new Map([["shared-id", registration]])],
    ]);
    // The loser at a DIFFERENT directory left — not the winner this id's
    // registration actually traces to.
    forgetUninstalledPlugin({
      registrations,
      workspaceId: "workspace-1",
      pluginId: "shared-id",
      directoryName: "loser-dir",
      uninstalled: true,
    });
    expect(registrations.get("workspace-1")?.get("shared-id"))
      .toBe(registration);
    // The winner's OWN directory leaving is still forgotten normally.
    forgetUninstalledPlugin({
      registrations,
      workspaceId: "workspace-1",
      pluginId: "shared-id",
      directoryName: "winner-dir",
      uninstalled: true,
    });
    expect(registrations.get("workspace-1")?.get("shared-id"))
      .toBeUndefined();
  });

  // CodeRabbit on #779-offers round 24: directoryName used to be derived
  // via basename(pluginRoot) — but pluginRoot passes through
  // resolveWorkspaceFile, which follows an in-workspace symlink to its
  // real target. A symlinked plugin root's basename can then differ from
  // the pipeline's own discovered directoryName, silently breaking every
  // trace-to-directory check this field exists for. Registration must
  // carry the pipeline's discovered name explicitly, never re-derive it.
  it("carries the discovered directoryName through registration, even when it differs from pluginRoot's own basename", () => {
    const registrations = new Map<string, Map<string, RegisteredPlugin>>();
    // A symlinked plugin root's REAL target has a different final path
    // segment than the directory the pipeline actually discovered this
    // plugin under.
    const remembered = rememberPluginRegistration(registrations, "workspace-1", {
      pluginRoot: "plugins/symlink-target-name",
      manifest: { version: 1, name: "hello-plugin", entry: "plugin.mjs" },
      directoryName: "real-discovered-name",
    });
    expect(remembered.directoryName).toBe("real-discovered-name");
    expect(registrations.get("workspace-1")?.get("hello-plugin")?.directoryName)
      .toBe("real-discovered-name");

    // The pipeline's own removed event names its own discovered
    // directory — the one that must match for this to forget correctly.
    forgetUninstalledPlugin({
      registrations,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      directoryName: "real-discovered-name",
      uninstalled: true,
    });
    expect(registrations.get("workspace-1")?.get("hello-plugin")).toBeUndefined();
  });

  it("forgets the registrations of a closing workspace and no others", () => {
    const registration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      manifest: { version: 1, name: "hello-plugin", entry: "plugin.mjs" },
      directoryName: "hello-plugin",
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
    rememberPluginRegistration(
      registrations,
      "workspace-1",
      { ...registration, directoryName: "hello-plugin" },
    );

    expect(() =>
      rememberPluginRegistration(registrations, "workspace-1", {
        ...registration,
        pluginRoot: join(workspace, "plugins", "elsewhere"),
        directoryName: "elsewhere",
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
    const remembered = rememberPluginRegistration(
      registrations,
      "workspace-1",
      { ...registration, directoryName: "foo" },
    );

    // Ordinary status traffic changes nothing.
    forgetRemovedPlugin({
      registrations,
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
          pluginVersion: null,
          repository: null,
          issues: null,
          license: null,
          icon: null,
          settings: [],
          commands: [],
          panels: [],
          webApps: [],
          hasFailedReplacement: false,
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
      workspaceId: "workspace-1",
      event: { kind: "removed", pluginId: "hello-plugin", directoryName: "foo" },
    });

    const newRoot = join(workspace, "plugins", "bar");
    await writePlugin(newRoot);
    const reinstalled = await loadPluginPanelRegistration({
      workspaceRoot: workspace,
      pluginRoot: newRoot,
      pluginId: "hello-plugin",
      panelId: "main",
    });
    expect(
      rememberPluginRegistration(
        registrations,
        "workspace-1",
        { ...reinstalled, directoryName: "bar" },
      ),
    ).toMatchObject({ pluginRoot: newRoot });
  });
});
