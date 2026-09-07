import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { ConfirmDialog } from "./ui/ConfirmDialog";

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
    <ConfirmDialog
      title="Open this link outside dohc?"
      confirmLabel="Open link"
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
      testId="external-link-confirm"
      cancelTestId="external-link-confirm-cancel"
      confirmTestId="external-link-confirm-open"
    >
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
    </ConfirmDialog>
  );
}
