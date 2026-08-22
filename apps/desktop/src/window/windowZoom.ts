import {
  DEFAULT_ZOOM_LEVEL,
  clampZoomLevel,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
  type ZoomStep,
} from "../settings/userSettings";

export function nextZoomLevel(current: number, step: ZoomStep): number {
  if (step === "reset") return DEFAULT_ZOOM_LEVEL;
  return clampZoomLevel(current + (step === "in" ? 1 : -1));
}

/**
 * What a window's launch read should do when it resolves. The FIRST level of
 * a launch applies everywhere — hosts and guests — through the one window-wide
 * apply, or a guest attached before the read resolved would stay at 100%
 * until the next zoom change. A user zoom that landed first set the known
 * level and outranks the read: only this window still needs it.
 */
export function resolvePersistedZoomApplication(
  persisted: number | null,
  known: number | null,
): { applyEverywhere: number } | { applyToWindow: number } | null {
  if (known !== null) return { applyToWindow: known };
  if (persisted !== null) return { applyEverywhere: persisted };
  return null;
}

export type UserSettingsWriteQueue = <T>(
  task: () => Promise<T>,
) => Promise<T>;

export function createUserSettingsWriteQueue(): UserSettingsWriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The one zoom mutation. Menu accelerators, the command palette, and the
 * Settings stepper all step through here, so two quick steps can never read
 * the same snapshot, and the setting is persisted before any window changes.
 * A failed write leaves the window exactly where the settings file says it is.
 */
export function createZoomMutation(deps: {
  enqueue: UserSettingsWriteQueue;
  read: () => Promise<DesktopUserSettingsResult>;
  write: (settings: DesktopUserSettings) => Promise<void>;
  apply: (zoomLevel: number) => void;
}): (step: ZoomStep) => Promise<DesktopUserSettingsResult> {
  return (step) =>
    deps.enqueue(async () => {
      const current = await deps.read();
      if (current.source === "recovered") {
        // The read names why it recovered (not a regular file, too large,
        // unsupported shape, unreadable) — throw its reason, never a guess.
        // The next step belongs to the caller: the surface showing this
        // error knows which repair action it can actually offer.
        throw new Error(
          current.warning ?? "dohc could not read its settings file.",
        );
      }
      const zoomLevel = nextZoomLevel(
        current.settings.appearance.zoomLevel,
        step,
      );
      if (zoomLevel === current.settings.appearance.zoomLevel) return current;
      const settings = {
        ...current.settings,
        appearance: { ...current.settings.appearance, zoomLevel },
      };
      await deps.write(settings);
      deps.apply(zoomLevel);
      return { settings, source: "stored" as const };
    });
}
