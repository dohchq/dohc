export type PluginPanelLifecycleLock = <T>(
  key: string,
  operation: () => Promise<T>,
) => Promise<T>;

export function startPluginPanelWithLock<TContext, TResult>(
  key: string,
  withLock: PluginPanelLifecycleLock,
  ensurePluginStarted: () => Promise<TContext>,
  startPanel: (context: TContext) => Promise<TResult>,
): Promise<TResult> {
  return withLock(key, async () =>
    startPanel(await ensurePluginStarted()),
  );
}

export function stopPluginPanelWithLock(
  key: string,
  withLock: PluginPanelLifecycleLock,
  stopPanelAndUnusedPlugin: () => Promise<void>,
): Promise<void> {
  return withLock(key, stopPanelAndUnusedPlugin);
}
