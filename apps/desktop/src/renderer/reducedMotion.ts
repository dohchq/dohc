// scrollIntoView's `behavior` is JS, not CSS, so the stylesheet's
// prefers-reduced-motion reset does not reach it: an explicit "smooth" must
// be downgraded by hand when the OS asks for less motion.
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}
