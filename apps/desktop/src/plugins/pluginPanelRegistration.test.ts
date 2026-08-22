import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  CLAIMS_DRAINING_ERROR_CODE,
  PluginClaimsDrainingError,
} from "./pluginCommandInvocation";
import {
  forgetRemovedPlugin,
  forgetUninstalledPlugin,
  forgetWorkspaceRegistrations,
  loadPluginPanelRegistration,
  loadPluginWebAppRegistration,
  pluginLifecycleKey,
  rememberPluginRegistration,
  resolveRegisteredPlugin,
  startPluginForPanel,
  toPluginPanelHostStartResult,
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

  it("prefers the pipeline's current manifest over a remembered registration", () => {
    const oldRegistration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
      manifest: {
        version: 1,
        name: "hello-plugin",
        entry: "plugin.mjs",
      },
    };
    const currentRegistration: RegisteredPlugin = {
      pluginRoot: "plugins/hello-plugin",
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

  it("claims a plugin host only when the panel's own start ran it (#779 round 10 B3)", async () => {
    const panelStartedHosts = new Set<string>();
    const claim = (result: {
      running: boolean;
      startedHost: boolean;
    }) => {
      const calls: string[] = [];
      let running = result.running;
      return {
        calls,
        run: () =>
          startPluginForPanel({
            panelStartedHosts,
            workspaceId: "workspace-1",
            pluginId: "hello-plugin",
            hostActivation: () => (running ? Promise.resolve() : undefined),
            ensureStarted: async () => {
              calls.push("ensureStarted");
              running = true;
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

  it("does not claim a host started for a plugin command, and reports the cold start instead (round-9 finding 1)", async () => {
    const panelStartedHosts = new Set<string>();
    let running = false;
    let coldStarts = 0;

    await startPluginForPanel({
      panelStartedHosts,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      claim: false,
      onColdStartWithoutClaim: () => {
        coldStarts += 1;
      },
      hostActivation: () => (running ? Promise.resolve() : undefined),
      ensureStarted: async () => {
        running = true;
        return { ok: true, startedHost: true };
      },
    });

    expect(running).toBe(true);
    expect(panelStartedHosts.size).toBe(0);
    // Without a panelStartedHosts entry, this is the only record that the
    // host is running only because this command cold-started it — without
    // it, nothing would ever stop it once the command settles.
    expect(coldStarts).toBe(1);
  });

  it("does not report a cold start for a command that only rode an already-running host", async () => {
    const panelStartedHosts = new Set<string>();
    let coldStarts = 0;

    await startPluginForPanel({
      panelStartedHosts,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      claim: false,
      onColdStartWithoutClaim: () => {
        coldStarts += 1;
      },
      hostActivation: () => Promise.resolve(),
      ensureStarted: async () => {
        throw new Error("ensureStarted must not run when a host is already active.");
      },
    });

    expect(coldStarts).toBe(0);
  });

  it("does not report a cold start for a normal panel claim (claim left at its default)", async () => {
    const panelStartedHosts = new Set<string>();
    let coldStarts = 0;

    await startPluginForPanel({
      panelStartedHosts,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      onColdStartWithoutClaim: () => {
        coldStarts += 1;
      },
      hostActivation: () => undefined,
      ensureStarted: async () => ({ ok: true, startedHost: true }),
    });

    expect([...panelStartedHosts]).toEqual([
      pluginLifecycleKey("workspace-1", "hello-plugin"),
    ]);
    expect(coldStarts).toBe(0);
  });

  it("reports a refused start instead of claiming the host", async () => {
    const panelStartedHosts = new Set<string>();

    await expect(
      startPluginForPanel({
        panelStartedHosts,
        workspaceId: "workspace-1",
        pluginId: "hello-plugin",
        hostActivation: () => undefined,
        ensureStarted: async () => ({
          ok: false,
          error: { message: "Plugin source changed. Review it again." },
        }),
      }),
    ).rejects.toThrow("Plugin source changed. Review it again.");
    expect(panelStartedHosts.size).toBe(0);
  });

  it("reports the retryable claims-draining failure as PluginClaimsDrainingError, not a generic refusal (#779 round 25 finding 3)", async () => {
    const panelStartedHosts = new Set<string>();

    const start = startPluginForPanel({
      panelStartedHosts,
      workspaceId: "workspace-1",
      pluginId: "hello-plugin",
      hostActivation: () => undefined,
      // The one shape PluginPipeline.ensureStarted's own refusal takes for
      // this exact case: the code, not the message text, is what this
      // conversion recognizes — the command layer's own catch checks the
      // error class, not the string.
      ensureStarted: async () => ({
        ok: false,
        error: {
          message: 'dohc is still working on plugin "hello-plugin". Try the command again in a moment.',
          code: "claims-draining",
        },
      }),
    });

    await expect(start).rejects.toBeInstanceOf(PluginClaimsDrainingError);
    expect(panelStartedHosts.size).toBe(0);
  });

  describe("toPluginPanelHostStartResult (#779 round 27)", () => {
    // PluginPipelineEnsureStartedResult's own full shape carries fields this
    // function never reads (plugin, stage) — only .ok and .error's own code
    // and message. Cast rather than stub every unrelated required field.
    function ensureStartedResult(input: unknown) {
      return input as Parameters<typeof toPluginPanelHostStartResult>[0];
    }

    it("passes a started result through unchanged", () => {
      expect(
        toPluginPanelHostStartResult(
          ensureStartedResult({ ok: true, startedHost: true }),
        ),
      ).toEqual({ ok: true, startedHost: true });
    });

    it("keeps the one code startPluginForPanel recognizes", () => {
      expect(
        toPluginPanelHostStartResult(
          ensureStartedResult({
            ok: false,
            error: { stage: "runtime", code: CLAIMS_DRAINING_ERROR_CODE, message: "retry" },
          }),
        ),
      ).toEqual({
        ok: false,
        error: { message: "retry", code: CLAIMS_DRAINING_ERROR_CODE },
      });
    });

    it("drops any other pipeline error code to undefined — the same as no code at all, so a producer misspelling degrades honestly instead of matching by accident", () => {
      expect(
        toPluginPanelHostStartResult(
          ensureStartedResult({
            ok: false,
            error: { stage: "runtime", code: "install-failed", message: "install failed" },
          }),
        ),
      ).toEqual({
        ok: false,
        error: { message: "install failed", code: undefined },
      });
    });
  });

  it("waits for a host that is spawned but still activating (#798)", async () => {
    // Both surfaces reach this through main's ensurePluginStarted: a panel
    // open and a web-app open share this one path, so this covers both.
    for (const startedHere of [false, true]) {
      const panelStartedHosts = new Set<string>();
      let activated = false;
      let settleActivation!: () => void;
      const activation = new Promise<void>((resolve) => {
        settleActivation = () => {
          activated = true;
          resolve();
        };
      });
      let spawned = !startedHere;

      let opened = false;
      const open = startPluginForPanel({
        panelStartedHosts,
        workspaceId: "workspace-1",
        pluginId: "hello-plugin",
        hostActivation: () => (spawned ? activation : undefined),
        ensureStarted: async () => {
          // The pipeline reports a started host the moment it spawns one,
          // which is before the plugin can serve anything.
          spawned = true;
          return { ok: true, startedHost: true };
        },
      }).then(() => {
        opened = true;
      });

      // Long enough for every pending job to run: the open must still be
      // waiting, because the plugin cannot answer yet.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opened).toBe(false);

      settleActivation();
      await open;
      expect(opened).toBe(true);
      expect(activated).toBe(true);
      expect([...panelStartedHosts]).toEqual(
        startedHere ? [pluginLifecycleKey("workspace-1", "hello-plugin")] : [],
      );
    }
  });

  it("reports the activation error of a host that never became ready (#798)", async () => {
    for (const startedHere of [false, true]) {
      const panelStartedHosts = new Set<string>();
      let spawned = !startedHere;
      const activation = Promise.reject(
        new Error('Plugin "hello-plugin" activation failed: bad entry.'),
      );
      activation.catch(() => undefined);

      await expect(
        startPluginForPanel({
          panelStartedHosts,
          workspaceId: "workspace-1",
          pluginId: "hello-plugin",
          hostActivation: () => (spawned ? activation : undefined),
          ensureStarted: async () => {
            spawned = true;
            return { ok: true, startedHost: startedHere };
          },
        }),
      ).rejects.toThrow('Plugin "hello-plugin" activation failed: bad entry.');

      // A start that ran the host still owns it — the accounting follows who
      // started the process, not whether the process then activated.
      expect([...panelStartedHosts]).toEqual(
        startedHere ? [pluginLifecycleKey("workspace-1", "hello-plugin")] : [],
      );
    }
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
