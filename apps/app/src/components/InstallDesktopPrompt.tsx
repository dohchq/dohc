// Phase 12 — web repositioning. dohc on the web is the CLOUD client: your
// workspace in any browser, on any device. Local folders and on-device AI
// agents are the desktop app's job (local-first storage on your own disk).
// This prompt keeps that division honest wherever it is shown — the web makes
// no on-disk storage claim; it points you to the desktop app for that power.

export const DESKTOP_DOWNLOAD_URL = "https://dohc.app/desktop";

export function InstallDesktopPrompt({ className = "" }: { className?: string }) {
  return (
    <div
      data-testid="install-desktop-prompt"
      className={`rounded-lg border border-rule bg-page/60 px-4 py-3 text-center ${className}`}
    >
      <p className="text-[12px] leading-relaxed text-ink-dim">
        You&rsquo;re on <span className="font-medium text-ink-strong">dohc Cloud</span> — your
        workspace in the browser, on any device.
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
        Working with local folders or AI agents on your own files? The desktop app keeps your
        files local-first on your disk and runs agents on-device.
      </p>
      <a
        href={DESKTOP_DOWNLOAD_URL}
        data-testid="install-desktop-link"
        className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
      >
        Get the desktop app
        <span aria-hidden>→</span>
      </a>
    </div>
  );
}
