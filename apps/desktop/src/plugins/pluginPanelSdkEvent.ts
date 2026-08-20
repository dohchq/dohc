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

/** Whether the authority grant still names the panel receiving a push. */
export function isPluginPanelPushLive(input: {
  signal: AbortSignal;
  currentPanel: { senderId: number; generation: number } | undefined;
  grant: { senderId: number; generation: number };
}): boolean {
  return Boolean(
    !input.signal.aborted &&
      input.currentPanel &&
      input.currentPanel.senderId === input.grant.senderId &&
      input.currentPanel.generation === input.grant.generation,
  );
}

/** Whether a panel can make a new SDK request through a live plugin process. */
export function isPluginPanelRequestLive(input: {
  currentPanel: { senderId: number; generation: number } | undefined;
  senderId: number;
  generation: number;
  liveSpawnId: string | undefined;
}): boolean {
  return Boolean(
    input.currentPanel &&
      input.currentPanel.senderId === input.senderId &&
      input.currentPanel.generation === input.generation &&
      input.liveSpawnId,
  );
}
