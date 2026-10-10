// scrollIntoView's `behavior` is JS, not CSS, so the stylesheet's
// prefers-reduced-motion reset does not reach it: an explicit "smooth" must
// be downgraded by hand when the OS asks for less motion.
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined") {
    const native = document.documentElement.dataset.systemReducedMotion;
    if (native !== undefined) return native === "true";
  }
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

// GTK updates Electron's native preference without notifying existing media
// queries. Read that preference only on visible Linux windows.
export function initReducedMotion(): () => void {
  const api = window.dohcDesktop;
  if (api?.platform !== "linux") return () => undefined;
  let stopped = false;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => document.visibilityState !== "hidden";
  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || reading || !visible()) return;
    reading = true;
    try {
      const reduced = await api.getSystemReducedMotion({});
      if (!stopped) document.documentElement.dataset.systemReducedMotion = String(reduced);
    } catch {
      // Keep the last native value, or the media query before the first read.
    } finally {
      reading = false;
      if (!stopped && visible()) {
        timer = setTimeout(() => { void refresh(); }, 1000);
      }
    }
  };
  document.addEventListener("visibilitychange", refresh);
  void refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", refresh);
    delete document.documentElement.dataset.systemReducedMotion;
  };
}
