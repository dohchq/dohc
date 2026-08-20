import { PLUGIN_PANEL_FILE_WATCH_EVENT } from "../ipc/bridgeContract";

export function createPluginPanelFileWatchEmitter(input: {
  workspaceId: string;
  pluginId: string;
  panelId: string;
  isPanelRunning: () => boolean;
  send: (event: unknown) => void;
}): (subscriptionId: string, event: string, data: unknown) => void {
  return (subscriptionId, _event, data) => {
    if (!input.isPanelRunning()) return;
    input.send({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      panelId: input.panelId,
      subscriptionId,
      event: PLUGIN_PANEL_FILE_WATCH_EVENT,
      data,
    });
  };
}
