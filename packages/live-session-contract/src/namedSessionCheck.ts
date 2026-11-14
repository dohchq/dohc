/**
 * share-web's gateway checks an open named editor's session on a fixed interval and tells the relay
 * that interval in this header. The relay keeps the session for NAMED_SESSION_CHECK_WINDOW checks past
 * its last use, so a session whose page closed is released, and a check never arrives after its window.
 */
export const NAMED_SESSION_CHECK_HEADER = "x-dohc-session-check-interval-ms";
export const NAMED_SESSION_CHECK_MIN_INTERVAL_MS = 60_000;
export const NAMED_SESSION_CHECK_MAX_INTERVAL_MS = 300_000;
export const NAMED_SESSION_CHECK_WINDOW = 3;
/** A session no check has reached yet keeps the longest window any accepted interval gives. */
export const NAMED_SESSION_FIRST_WINDOW_MS =
  NAMED_SESSION_CHECK_WINDOW * NAMED_SESSION_CHECK_MAX_INTERVAL_MS;

/**
 * The idle window for a check that announced `value`. A value outside the accepted range is
 * clamped, never refused, so a disagreement between the two services cannot cut a live editor.
 */
export function namedSessionCheckWindowMs(value: string): number {
  const interval = /^\d{1,10}$/u.test(value) ? Number(value) : NAMED_SESSION_CHECK_MAX_INTERVAL_MS;
  return (
    NAMED_SESSION_CHECK_WINDOW *
    Math.min(
      NAMED_SESSION_CHECK_MAX_INTERVAL_MS,
      Math.max(NAMED_SESSION_CHECK_MIN_INTERVAL_MS, interval),
    )
  );
}
