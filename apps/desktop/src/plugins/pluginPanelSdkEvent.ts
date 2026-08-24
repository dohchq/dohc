export function createPluginPanelFileWatchEmitter(input: {
  workspaceId: string;
  pluginId: string;
  panelId: string;
  isPanelRunning: () => boolean;
  send: (event: unknown) => void;
}): (subscriptionId: string, event: string, data: unknown) => void {
  return (subscriptionId, event, data) => {
    if (!input.isPanelRunning()) return;
    input.send({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      panelId: input.panelId,
      subscriptionId,
      event,
      data,
    });
  };
}
