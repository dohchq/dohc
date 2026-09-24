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

/** The three things guest zoom needs from a WebContents — no more, so the
 * behavior tests drive the real logic instead of a true-by-construction fake. */
interface GuestZoomTarget {
  isDestroyed(): boolean;
  setZoomLevel(level: number): void;
  on(event: "did-finish-load", handler: () => void): void;
}

/**
 * Binds one embedded guest to the window zoom: the current level applies at
 * attach and re-applies on every load — Chromium scopes zoom per origin, so a
 * level set before the first navigation would not survive it. Reads the level
 * at apply time, so a zoom change while the guest is still loading wins.
 */
export function createGuestZoomApplier(
  getLevel: () => number | null,
): (guest: GuestZoomTarget) => void {
  return (guest) => {
    const apply = () => {
      const level = getLevel();
      if (level !== null && !guest.isDestroyed()) {
        guest.setZoomLevel(level);
      }
    };
    apply();
    guest.on("did-finish-load", apply);
  };
}
