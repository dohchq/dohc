import { useEffect, useRef } from "react";
import type { EngineYDocSaveStateEvent } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { ErrorDetailField } from "./copyDetails";
import type { ShellErrorKind } from "./useShellError";

export interface DocumentSaveFailure {
  title?: string;
  message: string;
  cause?: unknown;
  details?: ReadonlyArray<ErrorDetailField>;
  retry?: (() => void) | null;
  kind?: ShellErrorKind;
  identity?: string;
}

// States that replace a failed save: it saved, or another state with its own
// words now describes the file.
const REPLACES_FAILURE = new Set<EngineYDocSaveStateEvent["state"]["kind"]>([
  "saved-here", "saved-to-host", "pending-share", "file-locked", "changed-on-disk",
]);

export function saveFailureNotice(path: string, readOnly: boolean): Pick<DocumentSaveFailure, "title" | "message" | "details"> {
  return {
    title: `Couldn't save ${path}`,
    message: readOnly
      ? "The file is read-only. Make it writable, then try again."
      : "dohc couldn't write the file.",
    details: [["File", path, path.length], ...(readOnly ? [["Cause", "The file is read-only."] as const] : [])],
  };
}

// The workspace's live documents report their saves here, whether or not
// an editor still shows them: a closing settle can fail after its tab has
// gone. A settle that fails files one toast and one Notices row per
// document; later failures keep that row, and a save removes it. An edit
// refusal gets its own notice.
export function useDocumentSaveNotices(input: {
  workspaceId: string;
  report: (failure: DocumentSaveFailure) => void;
  clear: (identity: string) => void;
  // Try again on a document whose session closed: opening it settles the
  // edits the engine kept.
  open: (path: string) => void;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const { workspaceId } = input;
  useEffect(() => {
    const owner = workspaceId;
    const current = () => latest.current.workspaceId === owner;
    const documents = new Map<string, { reported: boolean }>();
    // The newest session for each path. A session that closes after a newer
    // one opened has been replaced: its late states describe nothing open.
    const sessions = new Map<string, { sessionId: string; closing: boolean }>();
    const file = (
      identity: string,
      path: string,
      readOnly: boolean,
      document: { reported: boolean },
      cause?: unknown,
    ): void => {
      document.reported = true;
      latest.current.report({
        ...saveFailureNotice(path, readOnly),
        ...(cause === undefined ? {} : { cause }),
        identity,
        retry: () => {
          // Try again removes the row. Main settles whichever session is open
          // for the document when it is clicked. The settle's failure files
          // the row again, and so does a settle that could not start.
          document.reported = false;
          void bridge().retryEngineYDocSave({ workspaceId: owner, path }).then(
            (outcome) => {
              if (outcome !== "closed" || !current() || documents.get(identity) !== document) return;
              documents.delete(identity);
              latest.current.open(path);
            },
            (error: unknown) => {
              if (current() && documents.get(identity) === document && !document.reported) {
                file(identity, path, readOnly, document, error);
              }
            },
          );
        },
      });
    };
    return bridge().onEngineYDocSaveState((event) => {
      if (!current()) return;
      const refusal = event.editRefusal;
      if (refusal) {
        if (refusal.workspaceId !== owner) return;
        latest.current.report({ message: refusal.message, cause: new Error(refusal.message), kind: "live-edit-refused" });
        return;
      }
      if (event.workspaceId !== owner) return;
      const newest = sessions.get(event.path);
      if (event.closing && newest && newest.sessionId !== event.sessionId && !newest.closing) return;
      sessions.set(event.path, { sessionId: event.sessionId, closing: event.closing === true });
      const identity = `document-save:${owner}:${event.path}`;
      const known = documents.get(identity);
      // An author-capacity refusal has its own notice, including one a Try
      // again ran into, so this document's save notice gives way to it.
      if (event.authorCapacity) {
        if (known) {
          documents.delete(identity);
          latest.current.clear(identity);
        }
        return;
      }
      if (event.saveFailure) {
        const document = known ?? { reported: false };
        documents.set(identity, document);
        if (!document.reported) file(identity, event.path, event.saveFailure.readOnly, document);
        return;
      }
      if (!known) return;
      if (event.access || REPLACES_FAILURE.has(event.state.kind)) {
        documents.delete(identity);
        latest.current.clear(identity);
      }
    });
  }, [workspaceId]);
}
