// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./ActivityBar";
import type { PluginActivityView } from "./pluginActivityViews";
import { appViewId, pluginViewId, VIEW_IDS } from "./workbenchState";

afterEach(cleanup);

describe("ActivityBar views", () => {
  it("offers Plugins as a rail item that selects the plugins view", () => {
    const onSelectView = vi.fn();
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={onSelectView}
      />,
    );

    const plugins = screen.getByRole("button", { name: "Plugins" });
    expect(plugins.getAttribute("aria-current")).toBeNull();
    fireEvent.click(plugins);
    expect(onSelectView).toHaveBeenCalledWith("plugins");
  });

  it("marks the Plugins rail item current while its panel shows", () => {
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[]}
        activeView="plugins"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    expect(
      screen.getByTestId("activity-plugins").getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("ActivityBar plugin views", () => {
  const sitesView: PluginActivityView = {
    viewId: pluginViewId("dohc-sites", "sites"),
    pluginId: "dohc-sites",
    panelId: "sites",
    title: "Sites list",
    icon: "icons/sites.svg",
    plugin: {
      id: "dohc-sites",
      directoryName: "dohc-sites",
      rootPath: "/workspace/plugins/dohc-sites",
      valid: true,
      status: "ready",
      disabledReason: null,
      runtimeStatus: "ready",
      sourceHash: null,
      approvedHash: null,
      installedBaselineHash: null,
      displayName: "Sites",
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
    },
  };

  it("gives a contributed view its own rail button that selects it", () => {
    const onSelectView = vi.fn();
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[sitesView]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={onSelectView}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sites list" }));
    expect(onSelectView).toHaveBeenCalledWith(sitesView.viewId);
  });

  it("marks a selected plugin view current and draws the panel's own icon", () => {
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[sitesView]}
        activeView={sitesView.viewId}
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    expect(
      screen.getByTestId(`activity-${sitesView.viewId}`).getAttribute("aria-current"),
    ).toBe("page");
    // The panel's icon, served like any other workspace file — a plugin's
    // rail button reuses the icon pipeline the plugin list already uses.
    expect(screen.getByTestId("plugin-icon").getAttribute("src")).toContain(
      "icons/sites.svg",
    );
  });

  it("keeps dohc's own views when a plugin contributes none", () => {
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Explorer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sites list" })).toBeNull();
  });
});

describe("ActivityBar optional utility actions", () => {
  it("renders Cloud and Settings as inert icons when the host omits actions", () => {
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );

    expect(screen.getByTestId("activity-cloud").tagName).toBe("SPAN");
    expect(screen.getByTestId("activity-settings").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Sync and sharing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("keeps the desktop Cloud and Settings actions clickable when supplied", () => {
    const onOpenCloud = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
        onOpenCloud={onOpenCloud}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync and sharing" }));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenCloud).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe("ActivityBar order and pinned apps", () => {
  it("shows only the views it is given, in their order", () => {
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={["sites", "explorer"]}
        pluginViews={[]}
        activeView="explorer"
        sidebarVisible
        hasConflict={false}
        onSelectView={() => undefined}
      />,
    );
    const rail = screen.getByTestId("activity-bar");
    expect(
      [...rail.querySelectorAll("[data-testid^='activity-']")]
        .map((button) => button.getAttribute("data-testid"))
        .filter((id) => id !== "activity-bar" && id !== "activity-cloud" && id !== "activity-settings"),
    ).toEqual(["activity-sites", "activity-explorer"]);
    expect(screen.queryByTestId("activity-search")).toBeNull();
  });

  it("opens a pinned app as its own view and offers its menu", () => {
    const onSelectView = vi.fn();
    const onPinnedAppMenu = vi.fn();
    render(
      <ActivityBar
        workspaceId="workspace-a"
        views={VIEW_IDS}
        pluginViews={[]}
        pinnedApps={["apps/trip"]}
        onPinnedAppMenu={onPinnedAppMenu}
        activeView={appViewId("apps/trip")}
        sidebarVisible
        hasConflict={false}
        onSelectView={onSelectView}
      />,
    );
    const pinned = screen.getByRole("button", { name: "trip" });
    expect(pinned.getAttribute("aria-current")).toBe("page");
    fireEvent.click(pinned);
    expect(onSelectView).toHaveBeenCalledWith(appViewId("apps/trip"));
    fireEvent.contextMenu(pinned);
    expect(onPinnedAppMenu).toHaveBeenCalledWith("apps/trip");
  });
});
