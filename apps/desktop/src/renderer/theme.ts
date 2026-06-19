const STORAGE_KEY = "dohc-theme";

// The OS-drawn window controls (titleBarOverlay) can't read CSS — mirror
// every theme flip to main. Best-effort: a platform without an overlay (or a
// test without the bridge) just ignores it.
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  void window.dohcDesktop?.setTitlebarTheme({ theme }).catch(() => undefined);
}

function apply(media: MediaQueryList): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  const dark = stored ? stored === "dark" : media.matches;
  applyTheme(dark ? "dark" : "light");
}

// Follows the system theme unless the user explicitly toggled; never
// interrupts running work (a data-attribute flip only).
export function initTheme(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => apply(media));
  apply(media);
}

export function toggleTheme(): void {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(next);
}
