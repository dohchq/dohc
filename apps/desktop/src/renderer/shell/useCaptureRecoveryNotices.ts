import { useEffect, useMemo, useRef } from "react";
import type { CaptureRecoveryStatusResult } from "../../ipc/bridgeContract";
import { isSharedLiveFileRefusal } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { CaptureRecoveryNotice } from "./useShellError";

type CaptureRecovery = CaptureRecoveryStatusResult["captureRecoveries"][number];

export const CAPTURE_RECOVERY_TITLE = "Text kept in History";

// History Restore refuses a shared live file. Restore shared file returns
// only changes the host accepted, and kept typing is in none of them, so the
// way back for a shared file is to put the kept version in by hand, as
// History Restore would. The outside change stays in History either way.
export function captureRecoveryMessage(path: string, shared: boolean, deleted = false): string {
  if (deleted) return `The file "${path}" was deleted. Your text is in History. Open the recovery change and choose Restore to recreate the file.`;
  return shared
    ? `The file "${path}" changed outside dohc. Your text is in History. The file is shared live, so replace its text with your version from the recovery change.`
    : `The file "${path}" changed outside dohc. Your text is in History. Open the recovery change and choose Restore.`;
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
  const momentReads = useRequestSequence([workspaceId]);
  const latest = useRef(input);
  latest.current = input;

  // One workspace's notices. A switch starts over, and an answer for the
  // workspace the window left changes nothing.
  const notices = useMemo(() => {
    const here = () => latest.current.workspaceId === workspaceId;
    let listed: readonly CaptureRecovery[] = [];
    const committed = new Map<string, Pick<CaptureRecovery, "momentId" | "path" | "deleted">>();
    const pendingMoments = new Map<string, symbol>();
    // The files with listed kept typing that History Restore refused as
    // shared live. It chooses the words only.
    const shared = new Set<string>();

    // Only the changes answering this action raise their toasts.
    const publish = (raised: ReadonlySet<string> = new Set()) => latest.current.show([...listed,
      ...[...committed.values()].filter(recovery => !listed.some(row => row.momentId === recovery.momentId)),
    ].map((recovery) => ({
      momentId: recovery.momentId,
      path: recovery.path,
      title: CAPTURE_RECOVERY_TITLE,
      message: captureRecoveryMessage(recovery.path, shared.has(recovery.path), recovery.deleted),
      raise: raised.has(recovery.momentId),
      open: () => {
        if (committed.has(recovery.momentId)) retireFallback(recovery.momentId);
        latest.current.openRecovery(recovery.momentId, recovery.path);
      },
      dismiss: () => clear(recovery),
    })));

    const retireFallback = (momentId: string): void => {
      pendingMoments.delete(momentId);
      committed.delete(momentId);
      publish();
    };

    const refresh = async (): Promise<void> => {
      const request = reads.next();
      try {
        const status = await bridge().getCaptureRecoveryStatus({ workspaceId });
        if (!reads.isCurrent(request) || !here()) return;
        listed = status.captureRecoveries;
        // A listed change belongs to the engine's notice lifecycle. It must
        // not also survive in the fallback list after an external restore.
        for (const recovery of listed) committed.delete(recovery.momentId);
        // A refusal says nothing about kept typing recorded after its own
        // was dismissed or restored: that file may no longer be shared.
        for (const path of shared) {
          if (!listed.some((recovery) => recovery.path === path)) shared.delete(path);
        }
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
    const clear = (recovery: Pick<CaptureRecovery, "momentId" | "path">): void => {
      // A read already on its way may still list it.
      reads.next();
      retireFallback(recovery.momentId);
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
      restored(momentId: string): void {
        reads.next();
        listed = listed.filter(recovery => recovery.momentId !== momentId);
        retireFallback(momentId);
      },
      async imported(momentId: string, path: string): Promise<void> {
        const request = Symbol(momentId);
        const workspaceRequest = momentReads.current();
        pendingMoments.set(momentId, request);
        const current = () => pendingMoments.get(momentId) === request && momentReads.isCurrent(workspaceRequest) && here();
        try {
          await refresh();
          if (!current()) return;
          const recovery = listed.find(recovery => recovery.momentId === momentId);
          if (recovery) { publish(new Set([momentId])); return; }
          const {moment} = await bridge().readEngineMoment({workspaceId, momentId});
          if (!current()) return;
          if (!moment?.correlationId) { latest.current.openRecovery(momentId, path); return; }
          const captured = await bridge().readEngineMoment({workspaceId, momentId: moment.correlationId});
          if (!current()) return;
          if (!captured.moment) { latest.current.openRecovery(momentId, path); return; }
          if (!listed.some(recovery => recovery.momentId === momentId)) {
            committed.set(momentId, {momentId, path: moment.path, deleted: captured.moment.operation === "delete"});
          }
          publish(new Set([momentId]));
        } catch (error) {
          if (!current()) return;
          latest.current.reportShellError("dohc could not check for typing it kept in History.", error,
            () => void notices.imported(momentId, path));
        } finally {
          if (pendingMoments.get(momentId) === request) pendingMoments.delete(momentId);
        }
      },
      // A History Restore the engine refused because the file is shared live.
      // The kept typing's row takes the refusal: every refusal raises its
      // toast again, in the shared words, through the same row. True when a
      // row took it.
      restoreRefused(path: string, error: unknown): boolean {
        if (!isSharedLiveFileRefusal(error) || !listed.some((recovery) => recovery.path === path)) return false;
        shared.add(path);
        publish(new Set(listed.filter(recovery => recovery.path === path).map(recovery => recovery.momentId)));
        return true;
      },
    };
  }, [reads, momentReads, workspaceId]);

  useEffect(() => {
    if (workspaceIsReady) void notices.refresh();
  }, [notices, workspaceIsReady]);

  return notices;
}
