import { describe, expect, it } from "vitest";
import type { PluginStatusRecord } from "../../ipc/bridgeContract";
import {
  pluginActivityViews,
  pluginCommandEntries,
  pluginCommandPaletteId,
  resolvePluginView,
} from "./pluginActivityViews";
import { pluginViewId } from "./workbenchState";

const HASH = "ab".repeat(32);

function plugin(
  id: string,
  overrides: Partial<PluginStatusRecord> = {},
): PluginStatusRecord {
  return {
    id,
    directoryName: id,
    rootPath: `/workspace/plugins/${id}`,
    valid: true,
    status: "ready",
    disabledReason: null,
    runtimeStatus: "ready",
    sourceHash: HASH,
    approvedHash: HASH,
    installedBaselineHash: HASH,
    displayName: null,
    description: null,
    publisher: null,
    icon: null,
    pluginVersion: null,
    repository: null,
    issues: null,
    license: null,
    settings: [],
    commands: [],
    panels: [],
    webApps: [],
    hasFailedReplacement: false,
    diagnostics: [],
    warnings: [],
    error: null,
    ...overrides,
  };
}

const sitesPanel = {
  id: "sites",
  title: "Sites",
  placement: "view" as const,
  icon: "icons/sites.svg",
};
const editorPanel = {
  id: "main",
  title: "Main",
  placement: "editor" as const,
  icon: null,
};

describe("pluginActivityViews", () => {
  it("takes only the panels a plugin places in the rail", () => {
    const views = pluginActivityViews([
      plugin("dohc-sites", { panels: [editorPanel, sitesPanel] }),
    ]);

    expect(views).toEqual([
      expect.objectContaining({
        viewId: pluginViewId("dohc-sites", "sites"),
        pluginId: "dohc-sites",
        panelId: "sites",
        title: "Sites",
        icon: "icons/sites.svg",
      }),
    ]);
  });

  it.each([
    ["disabled by the user", { status: "disabled" as const }],
    ["waiting for approval", { status: "disabled-pending-approval" as const }],
    ["being uninstalled", { status: "uninstalling" as const }],
    ["never approved", { approvedHash: null }],
    ["invalid", { valid: false }],
  ])("keeps a %s plugin's views out of the rail", (_case, overrides) => {
    expect(
      pluginActivityViews([
        plugin("dohc-sites", { panels: [sitesPanel], ...overrides }),
      ]),
    ).toEqual([]);
  });

  it("keeps the catalog's own order rather than sorting views itself", () => {
    const views = pluginActivityViews([
      plugin("b-plugin", { panels: [sitesPanel] }),
      plugin("a-plugin", {
        panels: [
          { ...sitesPanel, id: "one", title: "One" },
          { ...sitesPanel, id: "two", title: "Two" },
        ],
      }),
    ]);

    expect(views.map((view) => `${view.pluginId}/${view.panelId}`)).toEqual([
      "b-plugin/sites",
      "a-plugin/one",
      "a-plugin/two",
    ]);
  });
});

describe("pluginCommandEntries", () => {
  const writeCommand = { id: "write", title: "Write note" };

  it("lists a ready plugin's declared commands", () => {
    expect(
      pluginCommandEntries([
        plugin("hello-plugin", {
          displayName: "Hello Plugin",
          commands: [writeCommand],
        }),
      ]),
    ).toEqual([
      {
        pluginId: "hello-plugin",
        commandId: "write",
        title: "Write note",
        pluginTitle: "Hello Plugin",
      },
    ]);
  });

  // canServeSurfaces only excludes a status that starts with "disabled" —
  // a user-disabled plugin mid-approve or mid-rebuild cycles through
  // "installing"/"scanning"/"building"/"failed" while still durably
  // disabled, and every one of those statuses would otherwise pass. Every
  // invocation against it fails with "plugin-disabled" regardless
  // (round-10 finding 3).
  it.each([
    "installing",
    "scanning",
    "building",
    "failed",
  ] as const)(
    "excludes a user-disabled plugin's commands even mid-%s",
    (status) => {
      expect(
        pluginCommandEntries([
          plugin("hello-plugin", {
            status,
            disabledReason: "user",
            commands: [writeCommand],
          }),
        ]),
      ).toEqual([]);
    },
  );

  // A crash-loop disable is not the user's own choice — the plugin was
  // running until its host gave up, and canEnable/canRebuild both still
  // offer a real action for it. Only the user-disabled reason is a dead
  // click regardless of status.
  it("keeps a crash-loop-disabled plugin's commands out only while status itself says disabled", () => {
    expect(
      pluginCommandEntries([
        plugin("hello-plugin", {
          status: "building",
          disabledReason: "crash-loop",
          commands: [writeCommand],
        }),
      ]),
    ).toEqual([
      expect.objectContaining({ pluginId: "hello-plugin", commandId: "write" }),
    ]);
  });

  it.each([
    ["disabled", { status: "disabled" as const }],
    ["waiting for approval", { status: "disabled-pending-approval" as const }],
    ["being uninstalled", { status: "uninstalling" as const }],
    ["never approved", { approvedHash: null }],
    ["invalid", { valid: false }],
  ])("keeps a %s plugin's commands out of the palette", (_case, overrides) => {
    expect(
      pluginCommandEntries([
        plugin("hello-plugin", { commands: [writeCommand], ...overrides }),
      ]),
    ).toEqual([]);
  });
});

describe("pluginCommandPaletteId", () => {
  it("keeps hyphenated plugin and command ids distinct", () => {
    expect(pluginCommandPaletteId("a-b", "c")).not.toBe(
      pluginCommandPaletteId("a", "b-c"),
    );
  });

  it("accepts a command id containing an unpaired surrogate", () => {
    expect(() => pluginCommandPaletteId("some-plugin", "\ud800")).not.toThrow();
  });
});

describe("resolvePluginView", () => {
  const target = { pluginId: "dohc-sites", panelId: "sites" };

  it("resolves a live view to the panel behind it", () => {
    const resolution = resolvePluginView(
      [plugin("dohc-sites", { panels: [sitesPanel] })],
      target,
    );

    expect(resolution).toEqual({
      status: "ready",
      pluginId: "dohc-sites",
      panelId: "sites",
      title: "Sites",
    });
  });

  it("keeps a turned-off plugin's view, naming what to turn back on", () => {
    const resolution = resolvePluginView(
      [
        plugin("dohc-sites", {
          panels: [sitesPanel],
          status: "disabled",
          disabledReason: "user",
          displayName: "Sites",
        }),
      ],
      target,
    );

    expect(resolution).toEqual({
      status: "off",
      title: "Sites",
      pluginTitle: "Sites",
    });
  });

  it.each([
    ["nothing is installed", []],
    ["another plugin is installed", [plugin("other", { panels: [sitesPanel] })]],
    [
      "the plugin dropped the view from its manifest",
      [plugin("dohc-sites", { panels: [editorPanel] })],
    ],
    [
      "the panel is no longer placed in the rail",
      [plugin("dohc-sites", { panels: [{ ...sitesPanel, placement: "editor" }] })],
    ],
  ])("reports the view absent when %s", (_case, plugins) => {
    expect(resolvePluginView(plugins, target)).toEqual({ status: "absent" });
  });
});
