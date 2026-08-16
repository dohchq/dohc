import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";

type Ask = (url: string) => Promise<boolean>;

// One gate for the whole renderer, because every external open already funnels
// through openLinkExternally. Mounting ExternalLinkConfirm installs it; nothing
// else may open a URL outside dohc.
let ask: Ask | null = null;

/** Answers whether an external open may proceed. True when no workspace shell
 *  is mounted — those surfaces have no workspace, so no per-workspace setting
 *  applies to them. */
export function confirmExternalOpen(url: string): Promise<boolean> {
  return ask ? ask(url) : Promise.resolve(true);
}

/** Asks the user before a link opens outside dohc, when the workspace's
 *  `privacy.confirmExternalLinks` setting is on. The setting is read at click
 *  time so a toggle in Settings takes effect on the very next link. */
export function ExternalLinkConfirm(props: { workspaceId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const resolveRef = useRef<((open: boolean) => void) | null>(null);

  function settle(open: boolean): void {
    resolveRef.current?.(open);
    resolveRef.current = null;
    setUrl(null);
  }

  useEffect(() => {
    const workspaceId = props.workspaceId;
    ask = (next) =>
      bridge()
        .getWorkspaceSettings({ workspaceId })
        .then((result) => result.settings.privacy.confirmExternalLinks)
        // The setting defaults to on, so an unreadable settings file asks.
        // Opening silently is the one outcome a privacy toggle must never
        // produce from its own failure.
        .catch(() => true)
        .then((confirm) => {
          if (!confirm) return true;
          return new Promise<boolean>((resolve) => {
            // A second link while one waits: the older question loses.
            resolveRef.current?.(false);
            resolveRef.current = resolve;
            setUrl(next);
          });
        });
    return () => {
      ask = null;
      resolveRef.current?.(false);
      resolveRef.current = null;
      setUrl(null);
    };
  }, [props.workspaceId]);

  if (url === null) return null;
  return (
    <Overlay onClose={() => settle(false)}>
      <div
        data-testid="external-link-confirm"
        className="w-[min(420px,calc(100vw-32px))] rounded border border-line bg-panel p-4 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-link-confirm-title"
      >
        <h3
          id="external-link-confirm-title"
          className="m-0 text-sm font-semibold text-ink"
        >
          Open this link outside dohc?
        </h3>
        <p
          data-testid="external-link-confirm-url"
          className="mb-0 mt-2 break-all font-mono text-xs leading-5 text-ink"
        >
          {url}
        </p>
        <p className="mb-0 mt-2 text-xs leading-5 text-muted">
          dohc opens this link in another app. Turn off Confirm external links
          in Settings to open links without asking.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="external-link-confirm-cancel"
            onClick={() => settle(false)}
            className="h-8 cursor-pointer rounded border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="external-link-confirm-open"
            onClick={() => settle(true)}
            className="h-8 cursor-pointer rounded bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
          >
            Open link
          </button>
        </div>
      </div>
    </Overlay>
  );
}
