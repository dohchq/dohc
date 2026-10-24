import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OwnerRestorePhase, OwnerRestoreStatus } from "../../ipc/ownerRestoreContract";
import { bridge } from "../bridge";
import { OwnerRestoreDialog, unfinishedRestoreStage, type UnfinishedRestoreStage } from "../OwnerRestoreDialog";
import type { useShellError } from "./useShellError";

type Shell = ReturnType<typeof useShellError>;
type Restore = { operationId: string; path: string; phase: OwnerRestorePhase };
type Target = { workspaceId: string; path: string; momentId?: string; attempt: number };

// One Notices row per file: a refused start, or a restore not yet finished.
export const sharedRestoreIdentity = (path: string) => `shared-restore:${path}`;
// The pages of unfinished restores one listing reads, 50 each.
const UNFINISHED_PAGES = 20;

const ROW: Record<UnfinishedRestoreStage, { title: string; message: (path: string) => string }> = {
  decide: {
    title: "Restore waiting for you",
    message: (path) => `Access to ${path} stopped for a restore. Review the restore, or decline it to keep the file unchanged and access stopped.`,
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
// when the workspace opens and each time the dialog closes. Every Try again
// opens the dialog for the workspace and file it named, or does nothing in
// another workspace.
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
  // Files whose unfinished restore has a row from this shell.
  const filed = useRef(new Set<string>());
  const listing = useRef(0);

  const restores = useMemo(() => {
    let attempts = 0;
    const open = (path: string, momentId?: string) => {
      attempts += 1;
      setTarget({ workspaceId: latest.current.workspaceId, path, ...(momentId === undefined ? {} : { momentId }), attempt: attempts });
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
      const review = inWorkspace(() => open(restore.path));
      latest.current.reportShellFailure({
        tone: "warning",
        repeat: true,
        identity: sharedRestoreIdentity(restore.path),
        title: ROW[stage].title,
        message: ROW[stage].message(restore.path),
        details: [["File", restore.path, restore.path.length], ["Restore", restore.operationId]],
        ...(stage === "decide"
          ? { action: { label: "Review restore", run: review, additional: [{ label: "Decline restore", run: inWorkspace(() => void decline(restore)) }] } }
          : { retry: review }),
      });
    };
    const decline = async (restore: Restore) => {
      const workspaceId = latest.current.workspaceId;
      try {
        const status = await bridge().ownerRestore({ workspaceId, action: "decline", operationId: restore.operationId });
        if (latest.current.workspaceId !== workspaceId) return;
        file({ ...restore, phase: status.phase });
        if (status.phase === "declined") {
          latest.current.showSuccessNotice(`Declined the restore of ${restore.path}. The file is unchanged, and access stays stopped.`);
        }
      } catch (error) {
        if (latest.current.workspaceId !== workspaceId) return;
        // The dialog shows where the restore stands and what is left to do.
        latest.current.reportRestoreError(`dohc could not decline the restore of ${restore.path}.`, error,
          inWorkspace(() => open(restore.path)), sharedRestoreIdentity(restore.path), restore.path);
      }
    };
    const refresh = async () => {
      const { workspaceId, enabled } = latest.current;
      if (!enabled) return;
      const token = ++listing.current;
      const live = () => token === listing.current && latest.current.workspaceId === workspaceId;
      const listed = new Set<string>();
      let after: string | undefined, complete = false;
      try {
        for (let page = 0; page < UNFINISHED_PAGES && !complete; page++) {
          const result = await bridge().ownerRestore({ workspaceId, action: "unfinished", ...(after === undefined ? {} : { after }) });
          if (!live()) return;
          for (const restore of result.restores) {
            listed.add(restore.path);
            file(restore);
          }
          if (result.nextCursor === null) complete = true;
          else after = result.nextCursor;
        }
      } catch (error) {
        // The relay may be out of reach. The rows already filed stay, and
        // the next listing files the rest.
        console.warn("[desktop] unfinished restore listing failed:", error);
        return;
      }
      if (!complete || !live()) return;
      for (const path of [...filed.current]) if (!listed.has(path)) settle(path);
    };
    return { open, inWorkspace, settle, file, refresh };
  }, []);

  useEffect(() => {
    filed.current = new Set();
    setTarget(null);
  }, [input.workspaceId]);
  useEffect(() => {
    if (input.enabled) void restores.refresh();
  }, [input.enabled, input.workspaceId, restores]);

  const shown = target !== null && target.workspaceId === input.workspaceId ? target : null;
  const dialog = shown ? (
    <OwnerRestoreDialog
      key={`${shown.workspaceId}:${shown.path}:${shown.attempt}`}
      workspaceId={shown.workspaceId}
      path={shown.path}
      onClose={(operation: OwnerRestoreStatus | null) => {
        setTarget(null);
        if (operation) restores.file({ operationId: operation.operationId, path: shown.path, phase: operation.phase });
        void restores.refresh();
      }}
      onBeforeRestore={input.onBeforeRestore}
      onRestored={() => {
        restores.settle(shown.path);
        latest.current.onRestored();
      }}
      onSettled={() => restores.settle(shown.path)}
      onError={(fallback, error) => {
        // Try again opens the change and its dialog again, wherever the
        // person has gone since.
        const { path, momentId } = shown;
        latest.current.reportRestoreError(fallback, error, restores.inWorkspace(() => {
          if (momentId !== undefined) latest.current.openChange(momentId, path);
          restores.open(path, momentId);
        }), sharedRestoreIdentity(path), path);
      }}
    />
  ) : null;
  return { open: restores.open, dialog };
}
