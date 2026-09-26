import { UNFINISHED_LAUNCHES_BEFORE_CHECK } from "./launchMarker";

// The relaunch after a check that found nothing carries this with a
// single-use pass from the marker, so it loads main instead of checking
// again. Without a matching pass in the marker, the flag does nothing.
export const LAUNCH_CHECKED_FLAG = "--dohc-launch-checked";

export function checkedPassFrom(argv: readonly string[]): string | null {
  const prefix = `${LAUNCH_CHECKED_FLAG}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) || null : null;
}

/** The arguments for the relaunch: this launch's, with a fresh pass. */
export function checkedRelaunchArguments(argv: readonly string[], pass: string): string[] {
  return [
    ...argv.slice(1).filter((value) => value !== LAUNCH_CHECKED_FLAG && !value.startsWith(`${LAUNCH_CHECKED_FLAG}=`)),
    `${LAUNCH_CHECKED_FLAG}=${pass}`,
  ];
}

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
  // The single-instance lock. Taken before the marker is read, so only the
  // instance that runs ever changes it.
  acquireLock(): boolean;
  // Null when this build has no updater, so there is nothing to check for.
  markerPath: string | null;
  // Counts this launch. Returns the unfinished launches before it, and
  // whether the pass the launch carries matched the marker's.
  beginLaunch(path: string, checkedPass: string | null): { unfinished: number; checked: boolean };
  loadMain(): Promise<unknown>;
  // Awaited before the check, so the report is kept even if the check ends
  // the process.
  reportFailure(error: unknown): Promise<void>;
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

  // A second launch hands its arguments to the running instance, which
  // Electron does as part of the lock request, and leaves.
  if (!dependencies.acquireLock()) {
    dependencies.quit();
    return { recovery: null };
  }
  if (markerPath) {
    const { unfinished, checked } = dependencies.beginLaunch(markerPath, checkedPassFrom(argv));
    if (unfinished >= UNFINISHED_LAUNCHES_BEFORE_CHECK && !checked) {
      return { recovery: recover("unfinished-launch") };
    }
  }
  try {
    await dependencies.loadMain();
    return { recovery: null };
  } catch (error) {
    await dependencies.reportFailure(error);
    return { recovery: recover("startup") };
  }
}
