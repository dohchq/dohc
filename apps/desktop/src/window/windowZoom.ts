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
 * The one zoom mutation. Menu accelerators, the command palette, and the
 * Settings stepper all step through here, so two quick steps can never read
 * the same snapshot, and the setting is persisted BEFORE any window changes —
 * a failed write leaves the window exactly where the settings file says it is.
 */
export function createZoomMutation(deps: {
  read: () => Promise<DesktopUserSettingsResult>;
  write: (settings: DesktopUserSettings) => Promise<void>;
  apply: (zoomLevel: number) => void;
}): (step: ZoomStep) => Promise<DesktopUserSettingsResult> {
  let tail: Promise<unknown> = Promise.resolve();
  return (step) => {
    const run = tail.then(async () => {
      const current = await deps.read();
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
    tail = run.catch(() => undefined);
    return run;
  };
}
