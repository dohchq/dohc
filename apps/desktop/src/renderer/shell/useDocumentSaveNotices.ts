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
  onDismiss?: () => void;
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

// The engine settles a live document; the plain editor writes every other
// file, and a live document's path when main cannot open its session.
type Writer = "engine" | "text";

// One writer's failed save: whether the file is read-only, and the newest
// way to try that writer again.
interface WriterFailure {
  readOnly: boolean;
  retry: (failure: WriterFailure) => void;
}

// A file whose save failed, with a failure for each writer that still has
// one. `reported` says a toast and a row stand for it.
interface FailedFile {
  reported: boolean;
  writers: Map<Writer, WriterFailure>;
}

// Every save in the workspace reports here, whether or not an editor still
// shows its file: a closing settle or an unmount write can fail after its
// tab has gone. A failed save files one toast and one Notices row per file;
// later failures keep that row. Each writer's failure is its own record, so
// a plain save never clears what the engine has not settled, nor the
// reverse: the row goes once no writer for the file still fails, and its Try
// again retries every writer that does. Dismissing the row keeps the
// failures, so the next one files a row again. An edit refusal gets its own
// notice. Returns how many files have a failed save, from the same records,
// for the title bar.
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
    // By path.
    const files = new Map<string, FailedFile>();
    const counted = () => setFailedSaves({ workspaceId: owner, count: files.size });
    const identity = (path: string) => `document-save:${owner}:${path}`;
    // The newest session for each path. A session that closes after a newer
    // one opened has been replaced: its late states describe nothing open.
    const sessions = new Map<string, { sessionId: string; closing: boolean }>();
    const fileNotice = (path: string, failed: FailedFile, cause?: unknown): void => {
      failed.reported = true;
      latest.current.report({
        ...saveFailureNotice(path, [...failed.writers.values()].some((failure) => failure.readOnly)),
        ...(cause === undefined ? {} : { cause }),
        identity: identity(path),
        retry: () => {
          // Try again removes the row. The failure of a save it starts
          // files the row again.
          failed.reported = false;
          for (const failure of [...failed.writers.values()]) failure.retry(failure);
        },
        onDismiss: () => {
          failed.reported = false;
        },
      });
    };
    const fail = (path: string, writer: Writer, readOnly: boolean, retry: WriterFailure["retry"], cause?: unknown): void => {
      let failed = files.get(path);
      if (!failed) {
        failed = { reported: false, writers: new Map() };
        files.set(path, failed);
        counted();
      }
      const failure = failed.writers.get(writer) ?? { readOnly, retry };
      failure.readOnly = readOnly;
      failure.retry = retry;
      failed.writers.set(writer, failure);
      if (!failed.reported) fileNotice(path, failed, cause);
    };
    const forget = (path: string, writer: Writer): void => {
      const failed = files.get(path);
      if (!failed?.writers.delete(writer) || failed.writers.size > 0) return;
      files.delete(path);
      latest.current.clear(identity(path));
      counted();
    };
    const reopen = (path: string, writer: Writer, failure: WriterFailure): void => {
      if (!current() || files.get(path)?.writers.get(writer) !== failure) return;
      forget(path, writer);
      latest.current.open(path);
    };
    // Main settles whichever session is open for the document when Try
    // again is clicked. A settle that could not start files the row again.
    const retryDocument = (path: string) => (failure: WriterFailure) => {
      void bridge().retryEngineYDocSave({ workspaceId: owner, path }).then(
        (outcome) => {
          if (outcome === "closed") reopen(path, "engine", failure);
        },
        (error: unknown) => {
          const failed = files.get(path);
          if (current() && failed?.writers.get("engine") === failure && !failed.reported) {
            fileNotice(path, failed, error);
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
      // An author-capacity refusal has its own notice, including one a Try
      // again ran into, so this document's save notice gives way to it.
      if (event.authorCapacity) forget(event.path, "engine");
      else if (event.saveFailure) fail(event.path, "engine", event.saveFailure.readOnly, retryDocument(event.path));
      else if (event.access || REPLACES_FAILURE.has(event.state.kind)) forget(event.path, "engine");
    });
    const textSave = (save: TextSave): void => {
      if (!current() || save.workspaceId !== owner) return;
      const failed = save.failure;
      if (!failed) {
        forget(save.path, "text");
        return;
      }
      fail(save.path, "text", false, (failure) => {
        if (!failed.retry()) reopen(save.path, "text", failure);
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
