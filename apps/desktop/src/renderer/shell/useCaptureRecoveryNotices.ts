import { useEffect, useMemo, useRef } from "react";
import type { CaptureRecoveryStatusResult } from "../../ipc/bridgeContract";
import { isSharedLiveFileRefusal } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { CaptureRecoveryNotice } from "./useShellError";

type CaptureRecovery = CaptureRecoveryStatusResult["captureRecoveries"][number];

export const CAPTURE_RECOVERY_TITLE = "Typing kept in History";

// History Restore refuses a shared live file, so its notice names Restore
// shared file instead.
export function captureRecoveryMessage(path: string, shared: boolean): string {
  return shared
    ? `The file "${path}" changed outside dohc. Your typing is in History. The file is shared live, so open the recovery change and choose Restore shared file.`
    : `The file "${path}" changed outside dohc. Your typing is in History. Open the recovery change and choose Restore.`;
}

/**
 * Tells the person about typing capture kept in History when its file
 * changed outside dohc: one Notices row each, until a restore or a dismissal
 * clears it in the engine. The engine's list is read when the workspace
 * opens, and again from the returned refresh, which the shell runs after
 * workspace activity and after a restore. Only a History Restore the engine
 * refused shows that a file is shared live; its row then names Restore
 * shared file, and that restore clears the row.
 */
export function useCaptureRecoveryNotices(input: {
  workspaceId: string;
  workspaceIsReady: boolean;
  show: (recoveries: readonly CaptureRecoveryNotice[]) => void;
  reportShellError: (fallback: string, error: unknown, retry: (() => void) | null) => void;
  openRecovery: (momentId: string, path: string) => void;
}) {
  const { workspaceId, workspaceIsReady } = input;
  const reads = useRequestSequence([workspaceId]);
  const latest = useRef(input);
  latest.current = input;

  // One workspace's notices. A switch starts over, and an answer for the
  // workspace the window left changes nothing.
  const notices = useMemo(() => {
    const here = () => latest.current.workspaceId === workspaceId;
    let listed: readonly CaptureRecovery[] = [];
    // How often History Restore refused each file as shared live.
    const refusals = new Map<string, number>();

    const publish = () => latest.current.show(listed.map((recovery) => {
      const refused = refusals.get(recovery.path) ?? 0;
      return {
        momentId: recovery.momentId,
        path: recovery.path,
        title: CAPTURE_RECOVERY_TITLE,
        message: captureRecoveryMessage(recovery.path, refused > 0),
        key: `refused:${refused}`,
        open: () => latest.current.openRecovery(recovery.momentId, recovery.path),
        dismiss: () => clear(recovery),
      };
    }));

    const refresh = async (): Promise<void> => {
      const request = reads.next();
      try {
        const status = await bridge().getCaptureRecoveryStatus({ workspaceId });
        if (!reads.isCurrent(request) || !here()) return;
        listed = status.captureRecoveries;
        publish();
      } catch (error) {
        if (!reads.isCurrent(request) || !here()) return;
        latest.current.reportShellError(
          "dohc could not check for typing it kept in History.",
          error,
          () => void refresh(),
        );
      }
    };

    // Persists that the person is done with this kept typing, so its notice
    // never returns on a later launch.
    const clear = (recovery: CaptureRecovery): void => {
      // A read already on its way may still list it.
      reads.next();
      void bridge()
        .clearCaptureRecovery({ workspaceId, momentId: recovery.momentId })
        .then(() => {
          if (here()) void refresh();
        })
        .catch((error: unknown) => {
          if (!here()) return;
          latest.current.reportShellError(
            `dohc could not remove the notice about "${recovery.path}".`,
            error,
            () => clear(recovery),
          );
        });
    };

    return {
      refresh,
      // A History Restore the engine refused because the file is shared live.
      // The kept typing's row takes the refusal: it names Restore shared file
      // and raises its toast again. True when a row took it.
      restoreRefused(path: string, error: unknown): boolean {
        if (!isSharedLiveFileRefusal(error) || !listed.some((recovery) => recovery.path === path)) return false;
        refusals.set(path, (refusals.get(path) ?? 0) + 1);
        publish();
        return true;
      },
      // Restore shared file finished for this file. The engine clears only
      // what History Restore restored, so this clears the rest.
      sharedRestored(path: string): void {
        for (const recovery of listed) {
          if (recovery.path === path) clear(recovery);
        }
      },
    };
  }, [reads, workspaceId]);

  useEffect(() => {
    if (workspaceIsReady) void notices.refresh();
  }, [notices, workspaceIsReady]);

  return notices;
}
