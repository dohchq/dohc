// Who holds a workspace's activity, and the close under way.
export interface ActivityUse {
  // A window or the CLI opened the workspace.
  retainedActivity: boolean;
  // Background work (a dispatch run, a schedule run) using it now.
  backgroundHolds: number;
  activityClosing: Promise<void> | null;
}

/**
 * Starts closing a workspace's activity, or joins the close under way.
 * With `unlessInUse`, a workspace a window, the CLI, or background work
 * holds stays open, and the result is null. The check and the published
 * close happen with nothing awaited between, so an opener that arrives
 * later waits for this close and then opens afresh.
 */
export function closeActivity(
  use: ActivityUse,
  close: () => Promise<void>,
  options: { unlessInUse?: boolean } = {},
): Promise<void> | null {
  if (use.activityClosing) return use.activityClosing;
  if (options.unlessInUse && (use.retainedActivity || use.backgroundHolds > 0)) return null;
  const closing: Promise<void> = close().finally(() => {
    if (use.activityClosing === closing) use.activityClosing = null;
  });
  use.activityClosing = closing;
  return closing;
}

/** Background work starts using the workspace. */
export function holdBackground(use: ActivityUse): void {
  use.backgroundHolds += 1;
}

/** Background work stopped using the workspace. Close it next if nothing else owns it. */
export function releaseBackground(use: ActivityUse): void {
  use.backgroundHolds = Math.max(0, use.backgroundHolds - 1);
}

/** The windows and CLI calls that opened the workspace left. Background holds stay. */
export function leaveForeground(use: ActivityUse): void {
  use.retainedActivity = false;
}
