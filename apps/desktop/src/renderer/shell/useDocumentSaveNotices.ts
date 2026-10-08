import { useEffect, useRef, useState } from "react";
import type { EngineYDocSaveStateEvent } from "../../ipc/bridgeContract";
import { isShareReadOnlyRefusal } from "../../ipc/errorWords";
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

// A plain-text file's save, as its editor saw it. Main reports a live
// document's saves itself, but writes a plain-text file only when its editor
// asks, so only the editor sees that write fail. `failure` is null when the
// write did not fail: it wrote the file, had nothing to write, met a change
// on disk, or met a file that is read-only only inside dohc, such as a share
// with View access. Each of those has its own words. `retry` saves the file
// again from its editor, and answers false when the editor has closed or can
// no longer write the file.
interface TextSave {
  workspaceId: string;
  path: string;
  failure: { cause?: unknown; retry: () => boolean } | null;
}

const textSaveListeners = new Set<(save: TextSave) => void>();

export function reportTextSave(workspaceId: string, path: string, failure: TextSave["failure"]): void {
  const failed = failure && !isShareReadOnlyRefusal(failure.cause) ? failure : null;
  for (const listener of [...textSaveListeners]) listener({ workspaceId, path, failure: failed });
}

// A file whose save failed. `reported` says a toast and a row stand for it,
// and `retry` is the newest way to save it again.
interface FailedSave {
  reported: boolean;
  readOnly: boolean;
  retry: (failure: FailedSave) => void;
}

// Every save in the workspace reports here, whether or not an editor still
// shows its file: a closing settle or an unmount write can fail after its
// tab has gone. A failed save files one toast and one Notices row per file;
// later failures keep that row, and a save removes it. An edit refusal gets
// its own notice. Returns how many files have a failed save, from the same
// records, for the title bar.
export function useDocumentSaveNotices(input: {
  workspaceId: string;
  report: (failure: DocumentSaveFailure) => void;
  clear: (identity: string) => void;
  // Try again on a file no editor can save now, such as one whose tab has
  // closed: opening a live document settles the edits the engine kept, and
  // opening a plain-text file shows any edit dohc set aside.
  open: (path: string) => void;
}): number {
  const latest = useRef(input);
  latest.current = input;
  const { workspaceId } = input;
  const [failedSaves, setFailedSaves] = useState({ workspaceId, count: 0 });
  useEffect(() => {
    const owner = workspaceId;
    const current = () => latest.current.workspaceId === owner;
    const failures = new Map<string, FailedSave>();
    const counted = () => setFailedSaves({ workspaceId: owner, count: failures.size });
    // The newest session for each path. A session that closes after a newer
    // one opened has been replaced: its late states describe nothing open.
    const sessions = new Map<string, { sessionId: string; closing: boolean }>();
    const file = (identity: string, path: string, failure: FailedSave, cause?: unknown): void => {
      failure.reported = true;
      latest.current.report({
        ...saveFailureNotice(path, failure.readOnly),
        ...(cause === undefined ? {} : { cause }),
        identity,
        retry: () => {
          // Try again removes the row. The failure of the save it starts
          // files the row again.
          failure.reported = false;
          failure.retry(failure);
        },
      });
    };
    const fail = (identity: string, path: string, readOnly: boolean, retry: FailedSave["retry"], cause?: unknown): void => {
      const known = failures.get(identity);
      const failure = known ?? { reported: false, readOnly, retry };
      failure.readOnly = readOnly;
      failure.retry = retry;
      if (!known) {
        failures.set(identity, failure);
        counted();
      }
      if (!failure.reported) file(identity, path, failure, cause);
    };
    const forget = (identity: string): void => {
      if (!failures.delete(identity)) return;
      latest.current.clear(identity);
      counted();
    };
    const reopen = (identity: string, path: string, failure: FailedSave): void => {
      if (!current() || failures.get(identity) !== failure) return;
      forget(identity);
      latest.current.open(path);
    };
    // Main settles whichever session is open for the document when Try
    // again is clicked. A settle that could not start files the row again.
    const retryDocument = (identity: string, path: string) => (failure: FailedSave) => {
      void bridge().retryEngineYDocSave({ workspaceId: owner, path }).then(
        (outcome) => {
          if (outcome === "closed") reopen(identity, path, failure);
        },
        (error: unknown) => {
          if (current() && failures.get(identity) === failure && !failure.reported) {
            file(identity, path, failure, error);
          }
        },
      );
    };
    const stopDocuments = bridge().onEngineYDocSaveState((event) => {
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
      // An author-capacity refusal has its own notice, including one a Try
      // again ran into, so this document's save notice gives way to it.
      if (event.authorCapacity) forget(identity);
      else if (event.saveFailure) fail(identity, event.path, event.saveFailure.readOnly, retryDocument(identity, event.path));
      else if (event.access || REPLACES_FAILURE.has(event.state.kind)) forget(identity);
    });
    const textSave = (save: TextSave): void => {
      if (!current() || save.workspaceId !== owner) return;
      const identity = `document-save:${owner}:${save.path}`;
      const failed = save.failure;
      if (!failed) {
        forget(identity);
        return;
      }
      fail(identity, save.path, false, (failure) => {
        if (!failed.retry()) reopen(identity, save.path, failure);
      }, failed.cause);
    };
    textSaveListeners.add(textSave);
    return () => {
      stopDocuments();
      textSaveListeners.delete(textSave);
    };
  }, [workspaceId]);
  return failedSaves.workspaceId === workspaceId ? failedSaves.count : 0;
}
