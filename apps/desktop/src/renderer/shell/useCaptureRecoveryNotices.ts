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
// way back for a shared file is to put the kept version in by hand, as
// History Restore would. The outside change stays in History either way.
export function captureRecoveryMessage(path: string, shared: boolean, deleted = false): string {
  if (deleted) return `The file "${path}" was deleted. Your typing is in History. Open the recovery change and choose Restore to recreate the file.`;
  return shared
    ? `The file "${path}" changed outside dohc. Your typing is in History. The file is shared live, so replace its text with your version from the recovery change.`
    : `The file "${path}" changed outside dohc. Your typing is in History. Open the recovery change and choose Restore.`;
}

/**
 * Tells the person about typing capture kept in History when its file
 * changed outside dohc: one Notices row each, until a dismissal or a History
 * Restore of that change clears it in the engine. The engine's list is read
 * when the workspace opens, and again from the returned refresh, which the
 * shell runs after workspace activity and after a restore. Only a History
 * Restore the engine refused shows that a file is shared live; its row then
 * says to put the kept version in by hand.
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
    const committed = new Map<string, Pick<CaptureRecovery, "momentId" | "path" | "deleted">>();
    // The files with listed kept typing that History Restore refused as
    // shared live. It chooses the words only.
    const shared = new Set<string>();

    // `raised` is the file whose rows answer what the person just did.
    const publish = (raised?: string) => latest.current.show([...listed,
      ...[...committed.values()].filter(recovery => !listed.some(row => row.momentId === recovery.momentId)),
    ].map((recovery) => ({
      momentId: recovery.momentId,
      path: recovery.path,
      title: CAPTURE_RECOVERY_TITLE,
      message: captureRecoveryMessage(recovery.path, shared.has(recovery.path), recovery.deleted),
      raise: recovery.path === raised,
      open: () => latest.current.openRecovery(recovery.momentId, recovery.path),
      dismiss: () => clear(recovery),
    })));

    const refresh = async (): Promise<boolean> => {
      const request = reads.next();
      try {
        const status = await bridge().getCaptureRecoveryStatus({ workspaceId });
        if (!reads.isCurrent(request) || !here()) return false;
        listed = status.captureRecoveries;
        // An absent moment has been cleared or restored. A Copy response may
        // show it once more, but the next authoritative read retires that row.
        for (const momentId of committed.keys()) {
          if (!listed.some(recovery => recovery.momentId === momentId)) committed.delete(momentId);
        }
        // A refusal says nothing about kept typing recorded after its own
        // was dismissed or restored: that file may no longer be shared.
        for (const path of shared) {
          if (!listed.some((recovery) => recovery.path === path)) shared.delete(path);
        }
        publish();
        return true;
      } catch (error) {
        if (!reads.isCurrent(request) || !here()) return false;
        latest.current.reportShellError(
          "dohc could not check for typing it kept in History.",
          error,
          () => void refresh(),
        );
        return false;
      }
    };

    // Persists that the person is done with this kept typing, so its notice
    // never returns on a later launch.
    const clear = (recovery: Pick<CaptureRecovery, "momentId" | "path">): void => {
      // A read already on its way may still list it.
      reads.next();
      void bridge()
        .clearCaptureRecovery({ workspaceId, momentId: recovery.momentId })
        .then(() => {
          if (here()) {committed.delete(recovery.momentId); void refresh();}
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
      async refresh(): Promise<void> { await refresh(); },
      async imported(momentId: string, path: string): Promise<void> {
        if (!await refresh()) return;
        const recovery = listed.find(recovery => recovery.momentId === momentId);
        if (recovery) { publish(recovery.path); return; }
        const request = reads.next();
        try {
          const {moment} = await bridge().readEngineMoment({workspaceId, momentId});
          if (!reads.isCurrent(request) || !here()) return;
          if (!moment?.correlationId) { latest.current.openRecovery(momentId, path); return; }
          const captured = await bridge().readEngineMoment({workspaceId, momentId: moment.correlationId});
          if (!reads.isCurrent(request) || !here()) return;
          if (!captured.moment) { latest.current.openRecovery(momentId, path); return; }
          committed.set(momentId, {momentId, path: moment.path, deleted: captured.moment.operation === "delete"});
          publish(moment.path);
        } catch (error) {
          if (!reads.isCurrent(request) || !here()) return;
          latest.current.reportShellError("dohc could not check for typing it kept in History.", error,
            () => void notices.imported(momentId, path));
        }
      },
      // A History Restore the engine refused because the file is shared live.
      // The kept typing's row takes the refusal: every refusal raises its
      // toast again, in the shared words, through the same row. True when a
      // row took it.
      restoreRefused(path: string, error: unknown): boolean {
        if (!isSharedLiveFileRefusal(error) || !listed.some((recovery) => recovery.path === path)) return false;
        shared.add(path);
        publish(path);
        return true;
      },
    };
  }, [reads, workspaceId]);

  useEffect(() => {
    if (workspaceIsReady) void notices.refresh();
  }, [notices, workspaceIsReady]);

  return notices;
}
