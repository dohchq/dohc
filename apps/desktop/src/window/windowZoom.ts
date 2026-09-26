import {
  DEFAULT_ZOOM_LEVEL,
  clampZoomLevel,
  type ZoomStep,
} from "../settings/userSettings";

export function nextZoomLevel(current: number, step: ZoomStep): number {
  if (step === "reset") return DEFAULT_ZOOM_LEVEL;
  return clampZoomLevel(current + (step === "in" ? 1 : -1));
}

/**
 * What a window's launch read should do when it resolves. The first level of
 * a launch applies to every window through the one window-wide apply. A user
 * zoom that landed first set the known level and outranks the read: only this
 * window still needs it.
 */
export function resolvePersistedZoomApplication(
  persisted: number | null,
  known: number | null,
): { applyEverywhere: number } | { applyToWindow: number } | null {
  if (known !== null) return { applyToWindow: known };
  if (persisted !== null) return { applyEverywhere: persisted };
  return null;
}
