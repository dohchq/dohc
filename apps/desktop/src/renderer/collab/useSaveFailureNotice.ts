import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { useEffect, useRef } from "react";
import type { ErrorDetailField } from "../shell/copyDetails";

// The shell's toast and Notices row for one document. A report replaces the
// row with the same identity; clear removes it.
export interface DocumentSaveNotices {
  report(failure: {
    message: string;
    details: ReadonlyArray<ErrorDetailField>;
    retry: () => void;
    identity: string;
  }): void;
  clear(identity: string): void;
}

// True of every failed save: a read-only file, a full disk, and a file
// changed outside dohc all reach the editor as the same "error". The edits
// are journaled in the engine before any settle, so they survive a restart.
export function saveFailureMessage(path: string): string {
  return `dohc couldn't save your edits to ${path}. They are kept in dohc.`;
}

// One toast and one Notices row per document while its save fails. A later
// failure keeps that row; a save, or a state that replaces this failure,
// removes it, whichever editor of the document reports it. An edit refusal
// carries its own notice, so it is not one of these.
export function useSaveFailureNotice(input: {
  workspaceId: string;
  path: string;
  saveState: SaveState;
  notices?: DocumentSaveNotices;
  retry: () => Promise<void>;
  // Try again after the editor closed: opening the document settles what
  // the engine kept.
  open?: (path: string) => void;
}): void {
  const current = useRef(input);
  current.current = input;
  const reported = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const { workspaceId, path, saveState, notices } = input;
  const failed = saveState.kind === "error" && saveState.issueId === null;
  const settled = saveState.kind !== "error" && saveState.kind !== "saving" && saveState.kind !== "unknown";
  useEffect(() => {
    if (!notices) return;
    const identity = `document-save:${workspaceId}:${path}`;
    if (settled) {
      reported.current = false;
      notices.clear(identity);
      return;
    }
    if (!failed || reported.current) return;
    const file = (): void => {
      reported.current = true;
      notices.report({
        message: saveFailureMessage(path),
        details: [["File", path, path.length]],
        identity,
        retry: () => {
          // Try again removes the row, so the next failure files a new one.
          // A retry main could not start leaves the failure as it was.
          reported.current = false;
          if (!mounted.current) current.current.open?.(path);
          else current.current.retry().catch(() => { if (!reported.current) file(); });
        },
      });
    };
    file();
  }, [workspaceId, path, failed, settled, notices]);
}
