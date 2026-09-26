import { useCallback, useEffect, useRef } from "react";
import type { KeptCopy } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { KeptCopyNotice } from "./useShellError";

export function keptCopyMessage(path: string): string {
  return `Another program changed ${path} while dohc was saving it. dohc kept both copies.`;
}

/**
 * Tells the person about every file dohc kept while it saved: one Notices row
 * each, whose Save copy moves the kept file to a visible copy beside its
 * file. The engine's list is read when the workspace opens, and again
 * from the returned refresh, which the shell runs after workspace activity:
 * a kept copy arrives with the outside change that caused it.
 */
export function useKeptCopyNotices(input: {
  workspaceId: string;
  workspaceIsReady: boolean;
  show: (copies: readonly KeptCopyNotice[], more: boolean) => void;
  showSaved: (message: string, open: (() => void) | null) => void;
  reportShellError: (fallback: string, error: unknown, retry: (() => void) | null) => void;
  openFile: (path: string) => void;
}): () => Promise<void> {
  const { workspaceId, workspaceIsReady } = input;
  const reads = useRequestSequence([workspaceId]);
  // Rises when the workspace changes: a save that answers after that shows
  // nothing in the next workspace.
  const workspace = useRequestSequence([workspaceId]);
  const latest = useRef(input);
  latest.current = input;

  const refresh = useCallback(async (): Promise<void> => {
    const request = reads.next();
    try {
      const { keptCopies, more } = await bridge().listKeptCopies({ workspaceId });
      if (!reads.isCurrent(request)) return;
      latest.current.show(keptCopies.map((copy) => ({
        id: copy.id,
        message: keptCopyMessage(copy.path),
        save: () => save(copy),
      })), more);
    } catch (error) {
      if (!reads.isCurrent(request)) return;
      latest.current.reportShellError(
        "dohc could not check for files it kept while saving.",
        error,
        () => void refresh(),
      );
    }

    function save(copy: KeptCopy): void {
      const epoch = workspace.current();
      void bridge()
        .saveKeptCopy({ workspaceId, id: copy.id })
        .then(async ({ path }) => {
          if (!workspace.isCurrent(epoch)) return;
          // Null: a crash, an agent or another window got there first.
          latest.current.showSaved(
            path === null
              ? `The other copy of ${copy.path} was already saved or removed.`
              : `Saved the other copy of ${copy.path} as ${path}`,
            path === null ? null : () => latest.current.openFile(path),
          );
          await refresh();
        })
        .catch((error: unknown) => {
          if (!workspace.isCurrent(epoch)) return;
          latest.current.reportShellError(
            `dohc could not save the other copy of ${copy.path}.`,
            error,
            () => save(copy),
          );
        });
    }
  }, [reads, workspace, workspaceId]);

  useEffect(() => {
    if (workspaceIsReady) void refresh();
  }, [refresh, workspaceIsReady]);

  return refresh;
}
