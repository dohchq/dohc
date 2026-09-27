import type { AutoUpdateController, UpdateWaitBounds } from "./electronUpdater";

// A build that fails can still install the build that fixes it. The feed
// answers within seconds or not at all; an installer can take minutes.
export const FAILURE_UPDATE_BOUNDS: UpdateWaitBounds = {
  verdictMs: 15_000,
  downloadMs: 5 * 60_000,
};

// "startup": dohc could not start and quits unless it restarts into an update.
// "window-crash": a window stopped reloading after repeated crashes.
// "window-load": the first window failed to load.
// "unfinished-launch": launches in a row closed before they finished starting,
// so the entry module checks before it loads main.
export type UpdateFailure = "startup" | "window-crash" | "window-load" | "unfinished-launch";

/**
 * Returns one check shared by every failure that arrives while it runs. It
 * resolves true when the person chose the update and the exit is now the
 * install's: the restart is underway, or a window with unsaved work stopped
 * it. The caller must not quit then.
 */
export function createUpdateAfterFailure(dependencies: {
  controller(): Promise<Pick<AutoUpdateController, "awaitUpdate"> | null>;
  // Shows that a download is running until the signal aborts. Resolves when
  // the notice closes, by the signal or by the person.
  showDownloading(failure: UpdateFailure, version: string, signal: AbortSignal): Promise<void>;
  confirmRestart(failure: UpdateFailure, version: string): Promise<boolean>;
  install(): Promise<{ accepted: boolean; cancelled?: boolean }>;
  bounds?: UpdateWaitBounds;
}): (failure: UpdateFailure) => Promise<boolean> {
  let running: Promise<boolean> | null = null;
  async function run(failure: UpdateFailure): Promise<boolean> {
    const controller = await dependencies.controller();
    if (!controller) return false;
    const notice = new AbortController();
    // The person closing the notice stops the wait; the caller's exit runs.
    const closed = Promise.withResolvers<null>();
    const version = await Promise.race([
      controller.awaitUpdate(dependencies.bounds ?? FAILURE_UPDATE_BOUNDS, (found) => {
        void dependencies.showDownloading(failure, found, notice.signal).then(() => {
          if (!notice.signal.aborted) closed.resolve(null);
        });
      }),
      closed.promise,
    ]).finally(() => notice.abort());
    if (!version) return false;
    if (!(await dependencies.confirmRestart(failure, version))) return false;
    const result = await dependencies.install();
    return result.accepted || result.cancelled === true;
  }
  return (failure) => {
    running ??= run(failure)
      .catch((error: unknown) => {
        console.error("[desktop] update after failure:", error);
        return false;
      })
      .finally(() => { running = null; });
    return running;
  };
}
