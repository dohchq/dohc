const STORAGE_KEY = "dohc-theme";

function apply(media: MediaQueryList): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  const dark = stored ? stored === "dark" : media.matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
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
  document.documentElement.dataset.theme = next;
}
