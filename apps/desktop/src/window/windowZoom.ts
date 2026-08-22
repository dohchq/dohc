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
        // unsupported shape, unreadable) — repeat its reason, never a guess.
        throw new Error(
          `${
            current.warning ?? "dohc could not read its settings file."
          } Open Settings to repair or reset it.`,
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
