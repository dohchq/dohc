import type { PluginRuntimeStatus } from "./pluginHostProtocol";

export type PluginPanelLifecycleLock = <T>(
  key: string,
  operation: () => Promise<T>,
) => Promise<T>;

const PLUGIN_PANEL_WORKSPACE_ERROR =
  "The plugin panel request does not target the active workspace. Open the workspace and try again.";

export function assertPluginPanelRequestCurrent(
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) throw new Error(PLUGIN_PANEL_WORKSPACE_ERROR);
}

export async function loadPluginPanelRegistrationForCurrentRenderer<T>(
  load: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T> {
  const registration = await load();
  assertPluginPanelRequestCurrent(isCurrent);
  return registration;
}

export function startPluginPanelWithLock<TContext, TResult>(
  panelKey: string,
  pluginKey: string,
  withPanelLock: PluginPanelLifecycleLock,
  withPluginLock: PluginPanelLifecycleLock,
  ensurePluginStarted: () => Promise<TContext>,
  startPanel: (context: TContext) => Promise<TResult>,
): Promise<TResult> {
  return withPanelLock(panelKey, () =>
    withPluginLock(pluginKey, async () =>
      startPanel(await ensurePluginStarted()),
    ),
  );
}

export function stopPluginPanelWithLock(
  panelKey: string,
  pluginKey: string,
  withPanelLock: PluginPanelLifecycleLock,
  withPluginLock: PluginPanelLifecycleLock,
  stopPanelAndUnusedPlugin: () => Promise<void>,
): Promise<void> {
  return withPanelLock(panelKey, () =>
    withPluginLock(pluginKey, stopPanelAndUnusedPlugin),
  );
}

export function revokePluginPanelAuthoritiesForStatus(input: {
  workspaceId: string;
  pluginId: string;
  status: PluginRuntimeStatus;
  panels: Iterable<{ workspaceId: string; pluginId: string; panelId: string }>;
  revokePanel: (workspaceId: string, pluginId: string, panelId: string) => void;
}): void {
  if (
    input.status !== "crashed" &&
    input.status !== "failed" &&
    input.status !== "disabled"
  ) {
    return;
  }
  for (const panel of input.panels) {
    if (
      panel.workspaceId === input.workspaceId &&
      panel.pluginId === input.pluginId
    ) {
      input.revokePanel(panel.workspaceId, panel.pluginId, panel.panelId);
    }
  }
}
