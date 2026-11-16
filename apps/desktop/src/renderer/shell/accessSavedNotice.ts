import { useEffect, useRef } from "react";
import { bridge } from "../bridge";

export type AccessSavedReport = (notice: {
  message: string;
  identity: string;
  retry?: () => void;
  cause?: unknown;
  action: { label: string; run: () => void; reads: true };
}) => void;

/**
 * After an access change moved items of the member's into a recovery folder,
 * or undid changes that weren't sent: a toast and a Notices row that open the
 * folder. Opening it tells main to stop filing the notice at each start.
 */
export function useAccessSavedNotice(
  workspaceId: string,
  saved: { folder: string; count: number } | undefined,
  report: AccessSavedReport,
): void {
  const filed = useRef<string | null>(null);
  useEffect(() => {
    if (!saved || filed.current === saved.folder) return;
    filed.current = saved.folder;
    const identity = `access-saved:${workspaceId}`;
    const open = (): void => {
      void bridge()
        .revealWorkspaceFolder({ workspaceId, accessSaved: true })
        .catch((error: unknown) =>
          report({
            message: "dohc could not open the recovery folder.",
            cause: error,
            retry: open,
            identity,
            action: { label: "Open folder", run: open, reads: true },
          }),
        );
    };
    const items = saved.count === 1 ? "1 item" : `${saved.count} items`;
    report({
      message:
        saved.count > 0
          ? `Your access changed. dohc moved ${items} into a recovery folder.`
          : "Your access changed. dohc undid changes that weren't sent. The recovery folder lists them.",
      identity,
      action: { label: "Open folder", run: open, reads: true },
    });
  }, [workspaceId, saved, report]);
}
