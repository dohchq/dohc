import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { bridge } from "../bridge";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { useShellError } from "./useShellError";

type ProtectedCopyRow = readonly [path: string, id: string, keptAtMs: number];

const identityOf = (id: string) => `protected-copy:${id}`;
const READ_ERROR_IDENTITY = "protected-copy-list";

// Rows the person dismissed stay dismissed after a restart. The copy itself
// stays until Restore or Discard.
function dismissedKey(workspaceId: string): string {
  return `dohc:protected-copies-dismissed:${workspaceId}`;
}

function readDismissed(workspaceId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(dismissedKey(workspaceId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(workspaceId: string, ids: ReadonlySet<string>): void {
  try { localStorage.setItem(dismissedKey(workspaceId), JSON.stringify([...ids])); } catch { /* Keep this run's rows. */ }
}

/**
 * One Notices row for each change to a protected file that a sync replaced,
 * which dohc kept on this computer. Restore writes it back as a new change in
 * History; Discard removes it for good after a warning. Rows name paths only,
 * never the kept text.
 */
export function useProtectedCopyNotices(input: {
  workspaceId: string;
  copies: readonly ProtectedCopyRow[] | undefined;
  readError: string | null | undefined;
  retryRead: () => void;
} & Pick<ReturnType<typeof useShellError>, "reportShellFailure" | "showSuccessNotice" | "clearIdentity">) {
  const { workspaceId, copies, readError, retryRead, reportShellFailure, showSuccessNotice, clearIdentity } = input;
  const [discarding, setDiscarding] = useState<{ workspaceId: string; path: string; id: string } | null>(null);
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const shown = useRef(new Set<string>());
  const shownReadError = useRef<string | null>(null);
  useEffect(() => {
    shown.current = new Set();
    shownReadError.current = null;
    setDiscarding(null);
  }, [workspaceId]);

  const latest = useRef({ reportShellFailure, showSuccessNotice, clearIdentity });
  latest.current = { reportShellFailure, showSuccessNotice, clearIdentity };

  // An answer that arrives after the workspace changed paints nothing.
  const restore = (asked: string, path: string, id: string): void => {
    void bridge().restoreProtectedCopy({ workspaceId: asked, id }).then((restored) => {
      if (currentWorkspace.current !== asked) return;
      latest.current.clearIdentity(identityOf(id));
      latest.current.showSuccessNotice(`Restored your change to ${restored.path}`);
    }, (error: unknown) => {
      if (currentWorkspace.current !== asked) return;
      latest.current.reportShellFailure({
        message: `dohc could not restore your change to ${path}.`,
        cause: error,
        retry: () => restore(asked, path, id),
      });
    });
  };
  const discard = (asked: string, path: string, id: string): void => {
    void bridge().discardProtectedCopy({ workspaceId: asked, id }).then(() => {
      if (currentWorkspace.current !== asked) return;
      latest.current.clearIdentity(identityOf(id));
      latest.current.showSuccessNotice(`Discarded your change to ${path}`);
    }, (error: unknown) => {
      if (currentWorkspace.current !== asked) return;
      latest.current.reportShellFailure({
        message: `dohc could not discard your change to ${path}.`,
        cause: error,
        retry: () => setDiscarding({ workspaceId: asked, path, id }),
      });
    });
  };
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    if (copies === undefined) return;
    const listed = new Set(copies.map(([, id]) => id));
    for (const id of shown.current) {
      if (listed.has(id)) continue;
      shown.current.delete(id);
      clearIdentity(identityOf(id));
    }
    const dismissed = readDismissed(workspaceId);
    const stillDismissed = new Set([...dismissed].filter((id) => listed.has(id)));
    if (stillDismissed.size !== dismissed.size) writeDismissed(workspaceId, stillDismissed);
    for (const [path, id] of copies) {
      if (shown.current.has(id) || stillDismissed.has(id)) continue;
      shown.current.add(id);
      reportShellFailure({
        identity: identityOf(id),
        tone: "warning",
        title: `Kept your change to ${path}`,
        message: `A sync replaced ${path}. Your version is kept on this computer only.`,
        retry: null,
        target: { to: "file", path },
        action: {
          label: "Restore",
          run: () => restoreRef.current(workspaceId, path, id),
          additional: [{ label: "Discard", run: () => setDiscarding({ workspaceId, path, id }) }],
        },
        onDismiss: () => {
          const now = readDismissed(workspaceId);
          now.add(id);
          writeDismissed(workspaceId, now);
        },
      });
    }
  }, [copies, workspaceId, reportShellFailure, clearIdentity]);

  useEffect(() => {
    if (readError === undefined || readError === shownReadError.current) return;
    shownReadError.current = readError;
    if (readError === null) { clearIdentity(READ_ERROR_IDENTITY); return; }
    reportShellFailure({
      identity: READ_ERROR_IDENTITY,
      kind: "protected-copy-read",
      title: "dohc could not list every kept change",
      message: "A kept change to a protected file could not be read. It stays on this computer, in the file Copy details names.",
      details: [["Cause", readError]],
      retry: retryRead,
    });
  }, [readError, retryRead, reportShellFailure, clearIdentity]);

  return discarding && discarding.workspaceId === workspaceId ? (
    <ConfirmDialog intent="danger" icon={Trash2} title="Discard your change?" confirmLabel="Discard your change"
      testId="protected-discard-dialog" cancelTestId="protected-discard-cancel" confirmTestId="protected-discard-confirm"
      onCancel={() => setDiscarding(null)}
      onConfirm={() => { setDiscarding(null); discard(discarding.workspaceId, discarding.path, discarding.id); }}>
      <p>This removes your kept change to "{discarding.path}" from this computer. It was never in History, so it cannot be brought back.</p>
    </ConfirmDialog>
  ) : null;
}
