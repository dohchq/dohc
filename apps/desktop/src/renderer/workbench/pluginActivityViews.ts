import type { PluginStatusRecord } from "../../ipc/bridgeContract";
import { pluginViewId, type PluginViewId } from "./workbenchState";

// Which plugin views the activity bar shows, and what the side panel does
// when the selected one is not there. Pure, so both answers are decided in
// one place and tested without a workspace.

export interface PluginActivityView {
  viewId: PluginViewId;
  pluginId: string;
  panelId: string;
  title: string;
  /** The panel's own icon, or null to fall back to the plugin's. */
  icon: string | null;
  plugin: PluginStatusRecord;
}

/**
 * Whether a plugin's views belong in the rail right now. A view is a live
 * panel behind a running plugin, so the test is the one the Open control for
 * web apps already uses: installed, approved, and not on its way out.
 */
export function contributesViews(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    !plugin.status.startsWith("disabled") &&
    plugin.status !== "uninstalling"
  );
}

/** Every view the rail shows, in plugin order, then manifest order. */
export function pluginActivityViews(
  plugins: readonly PluginStatusRecord[],
): PluginActivityView[] {
  const views: PluginActivityView[] = [];
  for (const plugin of plugins) {
    if (!contributesViews(plugin)) continue;
    for (const panel of plugin.panels) {
      if (panel.placement !== "view") continue;
      views.push({
        viewId: pluginViewId(plugin.id, panel.id),
        pluginId: plugin.id,
        panelId: panel.id,
        title: panel.title,
        icon: panel.icon,
        plugin,
      });
    }
  }
  return views;
}

/**
 * What the side panel should show for a selected plugin view.
 *
 * `absent` is the honest end of a plugin: nothing installed declares this
 * view, so the selection points at nothing and the caller drops it. `off`
 * keeps the selection — the plugin is still installed, so turning it back on
 * must bring the view back where the user left it.
 */
export type PluginViewResolution =
  | { status: "ready"; view: PluginActivityView }
  | { status: "off"; title: string; pluginTitle: string }
  | { status: "absent" };

export function resolvePluginView(
  plugins: readonly PluginStatusRecord[],
  target: { pluginId: string; panelId: string },
): PluginViewResolution {
  const plugin = plugins.find((candidate) => candidate.id === target.pluginId);
  const panel = plugin?.panels.find(
    (candidate) => candidate.id === target.panelId && candidate.placement === "view",
  );
  if (!plugin || !panel) return { status: "absent" };
  if (!contributesViews(plugin)) {
    return {
      status: "off",
      title: panel.title,
      pluginTitle: plugin.displayName ?? plugin.id,
    };
  }
  return {
    status: "ready",
    view: {
      viewId: pluginViewId(plugin.id, panel.id),
      pluginId: plugin.id,
      panelId: panel.id,
      title: panel.title,
      icon: panel.icon,
      plugin,
    },
  };
}
