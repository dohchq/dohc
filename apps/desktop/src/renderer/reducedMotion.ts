// Same convention theme.ts uses to install the CSS reduced-motion resets:
// the OS-level media query OR the app's own reduce-motion setting (mirrored
// onto <html data-reduce-motion>). scrollIntoView's `behavior` is JS, not
// CSS, so it isn't covered by the `scroll-behavior: auto !important` reset
// those install — an explicit "smooth" must be downgraded by hand.
export function prefersReducedMotion(): boolean {
  const appSetting =
    typeof document !== "undefined" &&
    document.documentElement.dataset.reduceMotion === "true";
  if (appSetting) return true;
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}
