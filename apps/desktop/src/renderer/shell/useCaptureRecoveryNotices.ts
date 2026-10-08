import { useEffect, useMemo, useRef } from "react";
import type { CaptureRecoveryStatusResult } from "../../ipc/bridgeContract";
import { isSharedLiveFileRefusal } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { CaptureRecoveryNotice } from "./useShellError";

type CaptureRecovery = CaptureRecoveryStatusResult["captureRecoveries"][number];

export const CAPTURE_RECOVERY_TITLE = "Typing kept in History";

// History Restore refuses a shared live file. Restore shared file returns
// only changes the host accepted, and kept typing is in none of them, so the
// way back for a shared file is to copy the typing in.
export function captureRecoveryMessage(path: string, shared: boolean): string {
  return shared
    ? `The file "${path}" changed outside dohc. Your typing is in History. The file is shared live, so open the recovery change and copy your typing back into the file.`
    : `The file "${path}" changed outside dohc. Your typing is in History. Open the recovery change and choose Restore.`;
}

/**
 * Tells the person about typing capture kept in History when its file
 * changed outside dohc: one Notices row each, until a dismissal or a History
 * Restore of that change clears it in the engine. The engine's list is read
 * when the workspace opens, and again from the returned refresh, which the
 * shell runs after workspace activity and after a restore. Only a History
 * Restore the engine refused shows that a file is shared live; its row then
 * says to copy the typing back in.
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
    // The files History Restore refused as shared live.
    const shared = new Set<string>();

    const publish = () => latest.current.show(listed.map((recovery) => {
      const isShared = shared.has(recovery.path);
      return {
        momentId: recovery.momentId,
        path: recovery.path,
        title: CAPTURE_RECOVERY_TITLE,
        message: captureRecoveryMessage(recovery.path, isShared),
        key: isShared ? "shared" : "history",
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
      // The kept typing's row takes the refusal. The first one changes its
      // words and raises its toast again; a later one changes nothing. True
      // when a row took it.
      restoreRefused(path: string, error: unknown): boolean {
        if (!isSharedLiveFileRefusal(error) || !listed.some((recovery) => recovery.path === path)) return false;
        if (!shared.has(path)) {
          shared.add(path);
          publish();
        }
        return true;
      },
    };
  }, [reads, workspaceId]);

  useEffect(() => {
    if (workspaceIsReady) void notices.refresh();
  }, [notices, workspaceIsReady]);

  return notices;
}
