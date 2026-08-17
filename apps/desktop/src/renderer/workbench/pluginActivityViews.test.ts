import { describe, expect, it } from "vitest";
import type { PluginStatusRecord } from "../../ipc/bridgeContract";
import {
  pluginActivityViews,
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
    panels: [],
    webApps: [],
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
