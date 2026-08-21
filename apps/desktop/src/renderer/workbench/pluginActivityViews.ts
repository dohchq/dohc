import type { PluginStatusRecord } from "../../ipc/bridgeContract";
import { canServeSurfaces, pluginTitle } from "./pluginCatalog";
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

export interface PluginCommandEntry {
  pluginId: string;
  commandId: string;
  title: string;
  pluginTitle: string;
}

export function pluginCommandPaletteId(
  pluginId: string,
  commandId: string,
): string {
  return `plugin-command-${pluginId}\0${commandId}`;
}

/** Every view the rail shows, in plugin order, then manifest order. */
export function pluginActivityViews(
  plugins: readonly PluginStatusRecord[],
): PluginActivityView[] {
  const views: PluginActivityView[] = [];
  for (const plugin of plugins) {
    if (!canServeSurfaces(plugin)) continue;
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

export function pluginCommandEntries(
  plugins: readonly PluginStatusRecord[],
): PluginCommandEntry[] {
  const entries: PluginCommandEntry[] = [];
  for (const plugin of plugins) {
    // canServeSurfaces only excludes a status that currently starts with
    // "disabled" — a plugin the user disabled but that is mid-approve or
    // mid-rebuild (still durably disabled) cycles through
    // "installing"/"scanning"/"building"/"failed" without ever losing
    // disabledReason "user", and every one of those statuses passes.
    // Every command invocation against a durably disabled plugin fails
    // with "plugin-disabled" regardless of that transient status, so the
    // palette must never offer one while that reason still holds
    // (round-10 finding 3).
    if (!canServeSurfaces(plugin) || plugin.disabledReason === "user") continue;
    for (const command of plugin.commands) {
      entries.push({
        pluginId: plugin.id,
        commandId: command.id,
        title: command.title,
        pluginTitle: pluginTitle(plugin),
      });
    }
  }
  return entries;
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
  | { status: "ready"; pluginId: string; panelId: string; title: string }
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
  return canServeSurfaces(plugin)
    ? {
      status: "ready",
      pluginId: plugin.id,
      panelId: panel.id,
      title: panel.title,
    }
    : {
      status: "off",
      title: panel.title,
      pluginTitle: plugin.displayName ?? plugin.id,
    };
}
