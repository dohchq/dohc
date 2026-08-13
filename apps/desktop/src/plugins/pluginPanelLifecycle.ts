export interface PluginPanelPreview {
  url: string;
  stop(): Promise<void>;
  releaseOrigin(): void;
}

export type ClearPluginPanelStorage = (options: {
  origin: string;
}) => Promise<void>;

export async function stopPluginPanelPreview(
  panel: PluginPanelPreview,
  clearStorageData: ClearPluginPanelStorage,
  onClearError: (error: unknown) => void,
): Promise<void> {
  try {
    await clearStorageData({ origin: new URL(panel.url).origin });
  } catch (error) {
    onClearError(error);
  }
  try {
    await panel.stop();
  } finally {
    panel.releaseOrigin();
  }
}
