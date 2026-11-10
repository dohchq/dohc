import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { isProtectedCopyFinal, readError } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { useShellError } from "./useShellError";

type ProtectedCopyRow = readonly [path: string, id: string, keptAtMs: number];

const identityOf = (id: string) => `protected-copy:${id}`;
const READ_ERROR_IDENTITY = "protected-copy-list";

// The title names what failed and the error says why. An error with no words
// gets one untitled sentence, so the row doesn't say it twice.
function failure(failed: string, error: unknown): { title?: string; message: string } {
  const { words } = readError(error);
  return words === null ? { message: `${failed}.` } : { title: failed, message: words };
}

/**
 * One Notices row for each change to a protected file that a sync replaced or
 * deleted, which dohc kept on this computer. Restore writes it back as a new
 * change in History; Discard removes it for good after a warning. Rows name
 * paths only, never the kept text. A row has no Dismiss while its copy is
 * listed, because it is the only way back to the copy.
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

  // One Restore or Discard at a time for each copy: a second would fail on the
  // copy the first just removed.
  const running = useRef(new Set<string>());
  const begin = (asked: string, id: string): (() => void) | null => {
    const key = `${asked}/${id}`;
    if (running.current.has(key)) return null;
    running.current.add(key);
    return () => running.current.delete(key);
  };

  // An answer that arrives after the workspace changed paints nothing.
  const restore = (asked: string, path: string, id: string): void => {
    const done = begin(asked, id);
    if (!done) return;
    void bridge().restoreProtectedCopy({ workspaceId: asked, id }).finally(done).then((restored) => {
      if (currentWorkspace.current !== asked) return;
      latest.current.clearIdentity(identityOf(id));
      latest.current.showSuccessNotice(`Restored your change to ${restored.path}`);
    }, (error: unknown) => {
      if (currentWorkspace.current !== asked) return;
      latest.current.reportShellFailure({
        ...failure(`dohc could not restore your change to ${path}`, error),
        cause: error,
        retry: isProtectedCopyFinal(error) ? null : () => restore(asked, path, id),
      });
    });
  };
  const discard = (asked: string, path: string, id: string): void => {
    const done = begin(asked, id);
    if (!done) return;
    void bridge().discardProtectedCopy({ workspaceId: asked, id }).finally(done).then(() => {
      if (currentWorkspace.current !== asked) return;
      latest.current.clearIdentity(identityOf(id));
      latest.current.showSuccessNotice(`Discarded your change to ${path}`);
    }, (error: unknown) => {
      if (currentWorkspace.current !== asked) return;
      latest.current.reportShellFailure({
        ...failure(`dohc could not discard your change to ${path}`, error),
        cause: error,
        retry: isProtectedCopyFinal(error) ? null : () => setDiscarding({ workspaceId: asked, path, id }),
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
    for (const [path, id] of copies) {
      if (shown.current.has(id)) continue;
      shown.current.add(id);
      reportShellFailure({
        identity: identityOf(id),
        tone: "warning",
        title: `Kept your change to ${path}`,
        message: "A sync replaced or deleted this file before dohc saved your change to History. Until you restore it, your change is only on this computer.",
        retry: null,
        noDismiss: true,
        target: { to: "file", path },
        action: {
          label: "Restore",
          run: () => restoreRef.current(workspaceId, path, id),
          additional: [{ label: "Discard", run: () => setDiscarding({ workspaceId, path, id }) }],
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
      message: "dohc could not read a kept change to a protected file. It stays in .dohc/local/protected-copies on this computer.",
      details: [["Cause", readError]],
      retry: retryRead,
    });
  }, [readError, retryRead, reportShellFailure, clearIdentity]);

  return discarding && discarding.workspaceId === workspaceId ? (
    <ConfirmDialog intent="danger" icon={Trash2} title={`Discard your change to ${discarding.path}?`} confirmLabel="Discard change"
      testId="protected-discard-dialog" cancelTestId="protected-discard-cancel" confirmTestId="protected-discard-confirm"
      onCancel={() => setDiscarding(null)}
      onConfirm={() => { setDiscarding(null); discard(discarding.workspaceId, discarding.path, discarding.id); }}>
      <p>Your change is only on this computer, and History never held it. This cannot be undone.</p>
    </ConfirmDialog>
  ) : null;
}
