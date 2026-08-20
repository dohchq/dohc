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

/**
 * Whether a panel's SDK authority grant still names the exact panel running
 * right now: the grant's own signal isn't aborted, and the running panel
 * still matches the sender, generation, and process spawn the grant was
 * issued for.
 */
export function isPluginPanelIdentityLive(input: {
  signal: AbortSignal;
  currentPanel: { senderId: number; generation: number } | undefined;
  currentSpawnId: string | undefined;
  grant: { senderId: number; generation: number; spawnId: string };
}): boolean {
  return Boolean(
    !input.signal.aborted &&
      input.currentPanel &&
      input.currentPanel.senderId === input.grant.senderId &&
      input.currentPanel.generation === input.grant.generation &&
      input.currentSpawnId === input.grant.spawnId,
  );
}
