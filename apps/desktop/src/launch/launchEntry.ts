import { UNFINISHED_LAUNCHES_BEFORE_CHECK } from "./launchMarker";

// The relaunch after a check that found nothing carries this, so it loads
// main instead of checking again.
export const LAUNCH_CHECKED_FLAG = "--dohc-launch-checked";

export type LaunchFailure = "startup" | "unfinished-launch";

/**
 * What Electron's main entry does before, and instead of, loading main. A
 * build that cannot load main, or that closed before it finished starting
 * twice in a row, checks for a newer build first.
 *
 * Main registers privileged schemes and other pre-ready state while it
 * loads, so it must load before Electron is ready, and Electron holds ready
 * until this entry finishes. So the check runs after this returns, and a
 * check that finds nothing relaunches instead of loading main late.
 */
export async function runLaunchEntry(dependencies: {
  argv: readonly string[];
  // Null when this build has no updater, so there is nothing to check for.
  markerPath: string | null;
  // Counts this launch and returns the unfinished launches before it.
  beginLaunch(path: string): number;
  loadMain(): Promise<unknown>;
  reportFailure(error: unknown): void;
  // Resolves true when the check owns the exit: a restart into an update,
  // or a quit it already made.
  checkForUpdate(failure: LaunchFailure): Promise<boolean>;
  quit(): void;
  relaunchChecked(): void;
}): Promise<{ recovery: Promise<void> | null }> {
  const { argv, markerPath } = dependencies;
  const recover = async (failure: LaunchFailure): Promise<void> => {
    const handled = await dependencies.checkForUpdate(failure).catch((error: unknown) => {
      console.error("[desktop] update check before launch:", error);
      return false;
    });
    if (handled) return;
    if (failure === "startup") dependencies.quit();
    else dependencies.relaunchChecked();
  };

  if (markerPath) {
    const unfinished = dependencies.beginLaunch(markerPath);
    if (unfinished >= UNFINISHED_LAUNCHES_BEFORE_CHECK && !argv.includes(LAUNCH_CHECKED_FLAG)) {
      return { recovery: recover("unfinished-launch") };
    }
  }
  try {
    await dependencies.loadMain();
    return { recovery: null };
  } catch (error) {
    dependencies.reportFailure(error);
    return { recovery: recover("startup") };
  }
}
