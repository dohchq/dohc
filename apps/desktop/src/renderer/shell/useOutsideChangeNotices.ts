import { useEffect, useRef } from "react";
import type { OutsideChange } from "@dohc/workspace-contracts/outside-changes";
import { withErrorWords } from "../../ipc/errorWords";
import { fileManagerName } from "../../workspaces/explorerMenu";
import { bridge } from "../bridge";
import type { useShellError } from "./useShellError";

const identityOf = (path: string) => `outside-change:${path}`;

function showInLabel(platform: string | undefined): string {
  const name = fileManagerName(platform);
  return name === "the file manager" ? "Show in folder" : `Show in ${name}`;
}

/**
 * One Notices row for each live note whose file changed outside dohc. Neither
 * the note nor History has that change, so the row has no Dismiss: it stays
 * until the file matches the note again or the person keeps the change as a
 * copy. Keep a copy saves the file's bytes beside it, as a kept copy with its
 * own row, and puts the note's text back in the file.
 */
export function useOutsideChangeNotices(
  input: {
    workspaceId: string;
    changes: readonly OutsideChange[] | undefined;
  } & Pick<ReturnType<typeof useShellError>, "reportShellFailure" | "clearIdentity">,
) {
  const { workspaceId, changes, reportShellFailure, clearIdentity } = input;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const shown = useRef(new Set<string>());
  useEffect(() => {
    shown.current = new Set();
  }, [workspaceId]);
  const latest = useRef({ reportShellFailure, clearIdentity });
  latest.current = { reportShellFailure, clearIdentity };

  // An answer that arrives after the workspace changed paints nothing.
  const keep = (asked: string, path: string): void => {
    void bridge()
      .keepOutsideChange({ workspaceId: asked, path })
      .then(
        () => {
          if (currentWorkspace.current === asked) latest.current.clearIdentity(identityOf(path));
        },
        (error: unknown) => {
          if (currentWorkspace.current !== asked) return;
          latest.current.reportShellFailure({
            message: withErrorWords(`dohc could not keep the outside change to ${path}.`, error),
            cause: error,
            retry: () => keep(asked, path),
          });
        },
      );
  };
  const reveal = (asked: string, path: string): void => {
    void bridge()
      .revealExplorerPath({ workspaceId: asked, path })
      .catch((error: unknown) => {
        if (currentWorkspace.current !== asked) return;
        const fileManager = fileManagerName(window.dohcDesktop?.platform);
        latest.current.reportShellFailure({
          message: withErrorWords(`dohc could not show ${path} in ${fileManager}.`, error),
          cause: error,
          retry: () => reveal(asked, path),
        });
      });
  };
  const steps = useRef({ keep, reveal });
  steps.current = { keep, reveal };

  useEffect(() => {
    if (changes === undefined) return;
    const listed = new Set(changes.map((change) => change.path));
    for (const path of shown.current) {
      if (listed.has(path)) continue;
      shown.current.delete(path);
      clearIdentity(identityOf(path));
    }
    for (const { path } of changes) {
      if (shown.current.has(path)) continue;
      shown.current.add(path);
      reportShellFailure({
        identity: identityOf(path),
        tone: "warning",
        title: `Not in the live note: ${path}`,
        message:
          "This file changed outside dohc while its note was live. The note and History don't have the change. Keep a copy saves it beside the note.",
        retry: null,
        noDismiss: true,
        target: { to: "file", path },
        action: {
          label: "Keep a copy",
          run: () => steps.current.keep(workspaceId, path),
          additional: [
            {
              label: showInLabel(window.dohcDesktop?.platform),
              run: () => steps.current.reveal(workspaceId, path),
            },
          ],
        },
      });
    }
  }, [changes, workspaceId, reportShellFailure, clearIdentity]);
}
