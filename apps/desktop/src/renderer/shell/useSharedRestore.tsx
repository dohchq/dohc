import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { withErrorWords } from "../../ipc/errorWords";
import type { OwnerRestorePhase, OwnerRestoreStatus } from "../../ipc/ownerRestoreContract";
import { bridge } from "../bridge";
import { DECLINE_REFUSED_MESSAGE, OwnerRestoreDialog, unfinishedRestoreStage, type UnfinishedRestoreStage } from "../OwnerRestoreDialog";
import type { ErrorDetailField } from "./copyDetails";
import type { useShellError } from "./useShellError";

type Shell = ReturnType<typeof useShellError>;
type Restore = { operationId: string; path: string; phase: OwnerRestorePhase };
// A dialog opened from a change names it; one opened from a row names its restore.
type From = { momentId?: string; operationId?: string };
type Target = { workspaceId: string; path: string; from: From; attempt: number };

// One Notices row per file: a refused start, or a restore not yet finished.
export const sharedRestoreIdentity = (path: string) => `shared-restore:${path}`;
// One Notices row for a listing that failed or could not read every restore.
export const sharedRestoreListingIdentity = "shared-restore-listing";
// The pages of unfinished restores one listing reads, 50 each.
const UNFINISHED_PAGES = 20;

const ROW: Record<UnfinishedRestoreStage, { title: string; message: (path: string) => string }> = {
  decide: {
    title: "Restore waiting for you",
    message: (path) => `Access to ${path} stopped for a restore. Review the restore, or decline it to keep the file unchanged. ` +
      "Live editing through that access stays stopped until you share the file again.",
  },
  waiting: {
    title: "Restore waiting",
    message: (path) => `The restore of ${path} has not finished. Live editing of this file stays stopped until it does.`,
  },
  finishing: {
    title: "Finishing restore",
    message: (path) => `The restore of ${path} has not finished. Try again to finish it.`,
  },
};

// The shell owns Restore shared file, so its dialog and its Notices rows
// outlive the History page that opened it. Each unfinished restore of an
// owner's synced workspace keeps a row that opens it, read from the relay
// when the workspace opens, each time the dialog closes, and after a Decline
// from a row. A restore that begins, is declined, or finishes drops the
// listings already on their way, and lists again if its dialog has closed.
// Every Try again opens the dialog for the workspace and file it named, or
// does nothing in another workspace.
export function useSharedRestore(input: {
  workspaceId: string;
  enabled: boolean;
  onBeforeRestore(): Promise<() => void>;
  onRestored(): void;
  openChange(momentId: string, path: string): void;
  reportRestoreError(fallback: string, error: unknown, retry: () => void, identity: string, path: string): void;
  reportShellFailure: Shell["reportShellFailure"];
  showSuccessNotice: Shell["showSuccessNotice"];
  clearIdentity: Shell["clearIdentity"];
}): { open(path: string, momentId?: string): void; dialog: ReactNode } {
  const latest = useRef(input);
  latest.current = input;
  const [target, setTarget] = useState<Target | null>(null);
  // The dialog on screen, so a change it reports after closing lists again.
  const showing = useRef<Target | null>(null);
  // Files whose unfinished restore has a row from this shell.
  const filed = useRef(new Set<string>());
  const listing = useRef(0);
  // Files whose Decline failed, by the listing count then. A listing begun
  // earlier leaves their row alone.
  const unanswered = useRef(new Map<string, number>());
  // Restores whose Decline the relay refused to end. Their row offers no retry.
  const refused = useRef(new Set<string>());

  const restores = useMemo(() => {
    let attempts = 0;
    const show = (next: Target | null) => {
      showing.current = next;
      setTarget(next);
    };
    const open = (path: string, from: From = {}) => {
      attempts += 1;
      show({ workspaceId: latest.current.workspaceId, path, from, attempt: attempts });
    };
    // A row's step for the workspace it was filed in. In another one it
    // answers false, so the row stays.
    const inWorkspace = (run: () => void) => {
      const workspaceId = latest.current.workspaceId;
      return () => {
        if (latest.current.workspaceId !== workspaceId) return false;
        run();
      };
    };
    const settle = (path: string) => {
      filed.current.delete(path);
      latest.current.clearIdentity(sharedRestoreIdentity(path));
    };
    const file = (restore: Restore) => {
      const stage = unfinishedRestoreStage(restore.phase);
      if (!stage) {
        if (filed.current.has(restore.path)) settle(restore.path);
        return;
      }
      filed.current.add(restore.path);
      const details: ErrorDetailField[] = [["File", restore.path, restore.path.length], ["Restore", restore.operationId]];
      if (refused.current.has(restore.operationId)) {
        latest.current.reportShellFailure({ repeat: true, identity: sharedRestoreIdentity(restore.path), title: "Restore not declined",
          message: `dohc could not decline the restore of ${restore.path}. ${DECLINE_REFUSED_MESSAGE}`, details });
        return;
      }
      const review = inWorkspace(() => open(restore.path, { operationId: restore.operationId }));
      latest.current.reportShellFailure({
        tone: "warning",
        repeat: true,
        identity: sharedRestoreIdentity(restore.path),
        title: ROW[stage].title,
        message: ROW[stage].message(restore.path),
        details,
        ...(stage === "decide"
          ? { action: { label: "Review restore", run: review, additional: [{ label: "Decline restore", run: inWorkspace(() => void decline(restore)) }] } }
          : { retry: review }),
      });
    };
    const refuse = (restore: Restore) => {
      refused.current.add(restore.operationId);
      file(restore);
    };
    const decline = async (restore: Restore) => {
      const workspaceId = latest.current.workspaceId;
      try {
        const { status, result } = await bridge().ownerRestore({ workspaceId, action: "decline", operationId: restore.operationId });
        if (latest.current.workspaceId !== workspaceId) return;
        if (result.kind === "refused") refuse({ ...restore, phase: status.phase });
        else file({ ...restore, phase: status.phase });
        if (status.phase === "declined") {
          latest.current.showSuccessNotice(`Declined the restore of ${restore.path}. The file is unchanged. ` +
            "Live editing through that access stays stopped until you share the file again.");
        }
        void refresh();
      } catch (error) {
        if (latest.current.workspaceId !== workspaceId) return;
        // The Decline may have gone through, so no listing read before it can
        // file this restore as it was.
        unanswered.current.set(restore.path, listing.current);
        // The dialog shows where the restore stands and what is left to do.
        latest.current.reportRestoreError(`dohc could not decline the restore of ${restore.path}.`, error,
          inWorkspace(() => open(restore.path, { operationId: restore.operationId })), sharedRestoreIdentity(restore.path), restore.path);
      }
    };
    // Drops every listing on its way, so a reply read before a restore
    // changed cannot file that restore as it was.
    const invalidate = () => {
      listing.current += 1;
    };
    const listingFailed = (message: string, cause?: unknown) => latest.current.reportShellFailure({
      repeat: true,
      identity: sharedRestoreListingIdentity,
      message,
      ...(cause === undefined ? {} : { cause }),
      retry: inWorkspace(() => void refresh()),
    });
    const refresh = async () => {
      invalidate();
      const token = listing.current;
      const { workspaceId, enabled } = latest.current;
      if (!enabled) return;
      const live = () => token === listing.current && latest.current.workspaceId === workspaceId;
      const held = (path: string) => (unanswered.current.get(path) ?? 0) >= token;
      const listed = new Set<string>();
      let after: string | undefined, complete = false, unreadable = 0;
      try {
        for (let page = 0; page < UNFINISHED_PAGES && !complete; page++) {
          const result = await bridge().ownerRestore({ workspaceId, action: "unfinished", ...(after === undefined ? {} : { after }) });
          if (!live()) return;
          for (const restore of result.restores) {
            listed.add(restore.path);
            if (!held(restore.path)) file(restore);
          }
          unreadable += result.unreadable;
          if (result.nextCursor === null) complete = true;
          else after = result.nextCursor;
        }
      } catch (error) {
        // The rows already filed stay.
        if (live()) listingFailed(withErrorWords("dohc could not read this workspace's unfinished restores.", error), error);
        return;
      }
      if (!complete || !live()) return;
      // A restore the relay could not read may be one a row names, so every
      // row stays until a listing reads them all.
      if (unreadable > 0) {
        listingFailed(`dohc could not read ${unreadable} of this workspace's unfinished restores.`);
        return;
      }
      latest.current.clearIdentity(sharedRestoreListingIdentity);
      for (const path of [...filed.current]) if (!listed.has(path) && !held(path)) settle(path);
    };
    // While its dialog is open, closing it lists again. A change it reports
    // after closing lists now, in the workspace it was made in.
    const changed = (from: Target) => {
      if (showing.current === from) invalidate();
      else if (latest.current.workspaceId === from.workspaceId) void refresh();
    };
    return { show, open, inWorkspace, settle, file, refuse, refresh, changed };
  }, []);

  useEffect(() => {
    filed.current = new Set();
    unanswered.current = new Map();
    refused.current = new Set();
    restores.show(null);
  }, [input.workspaceId, restores]);
  useEffect(() => {
    if (input.enabled) void restores.refresh();
  }, [input.enabled, input.workspaceId, restores]);

  const shown = target !== null && target.workspaceId === input.workspaceId ? target : null;
  const dialog = shown ? (
    <OwnerRestoreDialog
      key={`${shown.workspaceId}:${shown.path}:${shown.attempt}`}
      workspaceId={shown.workspaceId}
      path={shown.path}
      {...(shown.from.operationId === undefined ? {} : { operationId: shown.from.operationId })}
      onClose={(operation: OwnerRestoreStatus | null) => {
        restores.show(null);
        if (operation) restores.file({ operationId: operation.operationId, path: shown.path, phase: operation.phase });
        void restores.refresh();
      }}
      onBeforeRestore={input.onBeforeRestore}
      onRestored={() => {
        restores.settle(shown.path);
        latest.current.onRestored();
      }}
      onDeclineRefused={(operation) => restores.refuse({ operationId: operation.operationId, path: shown.path, phase: operation.phase })}
      onSettled={() => restores.settle(shown.path)}
      onChanged={() => restores.changed(shown)}
      onError={(fallback, error) => {
        // Try again opens the change and its dialog again, wherever the
        // person has gone since.
        const { path, from } = shown;
        latest.current.reportRestoreError(fallback, error, restores.inWorkspace(() => {
          if (from.momentId !== undefined) latest.current.openChange(from.momentId, path);
          restores.open(path, from);
        }), sharedRestoreIdentity(path), path);
      }}
    />
  ) : null;
  return { open: (path, momentId) => restores.open(path, momentId === undefined ? {} : { momentId }), dialog };
}
