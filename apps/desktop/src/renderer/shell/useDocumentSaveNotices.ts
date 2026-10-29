import { useEffect, useRef, useState } from "react";
import type { EngineYDocSaveStateEvent, SaveFailureReason } from "../../ipc/bridgeContract";
import {
  isPrivacyDenied,
  isShareReadOnlyRefusal,
  isVolumeSharesNewFiles,
  PRIVACY_DENIED_WORDS,
  VOLUME_SHARES_NEW_FILES_WORDS,
} from "../../ipc/errorWords";
import { bridge } from "../bridge";
import type { ErrorDetailField } from "./copyDetails";
import type { ShellError, ShellErrorKind } from "./useShellError";

export interface DocumentSaveFailure {
  tone?: "success";
  title?: string;
  message: string;
  cause?: unknown;
  details?: ReadonlyArray<ErrorDetailField>;
  retry?: (() => void) | null;
  action?: ShellError["action"];
  onDismiss?: () => void;
  kind?: ShellErrorKind;
  identity?: string;
}

// States that replace a failed save: it saved, or another state with its own
// words now describes the file.
const REPLACES_FAILURE = new Set<EngineYDocSaveStateEvent["state"]["kind"]>([
  "saved-here", "saved-to-host", "pending-share", "file-locked", "changed-on-disk",
]);

// The reason that tells a person the most, when writers give different ones.
const REASON_ORDER: readonly SaveFailureReason[] = ["deleted", "privacy-denied", "volume-shares-new-files", "read-only"];

// What a person reads for each reason, and the cause Copy details carries.
function reasonWords(reason: SaveFailureReason): { message: string; cause: string | null } {
  switch (reason) {
    case "deleted":
      return { message: "The file was moved or deleted outside dohc.", cause: null };
    case "privacy-denied":
      return { message: PRIVACY_DENIED_WORDS, cause: "macOS blocked dohc from this folder." };
    case "volume-shares-new-files":
      return { message: VOLUME_SHARES_NEW_FILES_WORDS, cause: "The disk adds sharing permissions to new files." };
    case "read-only":
      return { message: "The file is read-only. Make it writable, then try again.", cause: "The file is read-only." };
    case null:
      return { message: "dohc couldn't write the file.", cause: null };
  }
}

export function saveFailureNotice(path: string, reason: SaveFailureReason): Pick<DocumentSaveFailure, "title" | "message" | "details"> {
  const { message, cause } = reasonWords(reason);
  return {
    title: `Couldn't save ${path}`,
    message,
    details: [["File", path, path.length], ...(cause ? [["Cause", cause] as const] : [])],
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

// A live document's history was replaced while its editor was open.
// `setAside` says a draft in Notices holds the editor's earlier edits.
// `failure` is null once the new history shows; until then `retry` sets the
// edits aside again and installs the same new history.
interface DocumentReplacement {
  workspaceId: string;
  path: string;
  setAside: boolean;
  failure: { setAsideFailed: boolean; cause: unknown; retry: () => void } | null;
}

export const REPLACED_DOCUMENT_SAVED = "This document changed while you were editing. Find your earlier edits in Notices.";
export const REPLACED_DOCUMENT_UNSAVED = "dohc could not save your earlier edits. Keep this document open and try again.";
const REPLACED_DOCUMENT_NOT_SHOWN = "dohc could not finish replacing this document.";

const replacementListeners = new Set<(replacement: DocumentReplacement) => void>();

export function reportDocumentReplacement(
  workspaceId: string,
  path: string,
  setAside: boolean,
  failure: DocumentReplacement["failure"],
): void {
  for (const listener of [...replacementListeners]) listener({ workspaceId, path, setAside, failure });
}

// The engine settles a live document; the plain editor writes every other
// file, and a live document's path when main cannot open its session.
type Writer = "engine" | "text";

// One writer's failed save: why, when a check could tell, and the newest
// way to try that writer again. `recreateFile` is true only for Save it again.
interface WriterFailure {
  reason: SaveFailureReason;
  retry: (failure: WriterFailure, recreateFile: boolean) => void;
}

// A file whose save failed, with a failure for each writer that still has
// one. `reported` says a toast and a row stand for it, and `shown` is the
// reason that row gives.
interface FailedFile {
  reported: boolean;
  shown?: SaveFailureReason;
  writers: Map<Writer, WriterFailure>;
}

// The reason a file's row gives.
const shownReason = (failed: FailedFile): SaveFailureReason =>
  REASON_ORDER.find((reason) => [...failed.writers.values()].some((failure) => failure.reason === reason)) ?? null;

// Every save in the workspace reports here, whether or not an editor still
// shows its file: a closing settle or an unmount write can fail after its
// tab has gone. A failed save files one toast and one Notices row per file;
// later failures keep that row. Each writer's failure is its own record, so
// a plain save never clears what the engine has not settled, nor the
// reverse: the row goes once no writer for the file still fails, and its Try
// again retries every writer that does. A new reason replaces the row's
// words, and for a file deleted outside dohc, Save it again takes the place
// of Try again. Dismissing the row keeps the failures, so the next one files
// a row again. An edit refusal gets its own notice. Returns how many files have a failed save, from the same records,
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
      const reason = failed.shown = shownReason(failed);
      // Try again, or Save it again, removes the row. The failure of a save
      // it starts files the row again.
      const retry = (recreateFile: boolean) => () => {
        failed.reported = false;
        for (const failure of [...failed.writers.values()]) failure.retry(failure, recreateFile);
      };
      latest.current.report({
        ...saveFailureNotice(path, reason),
        ...(cause === undefined ? {} : { cause }),
        identity: identity(path),
        // The engine refuses every save over a deleted file until the file is
        // back, and only the person chooses to bring it back.
        ...(reason === "deleted"
          ? { retry: null, action: { label: "Save it again", run: retry(true), ends: true } }
          : { retry: retry(false) }),
        onDismiss: () => {
          failed.reported = false;
        },
      });
    };
    const fail = (path: string, writer: Writer, reason: SaveFailureReason, retry: WriterFailure["retry"], cause?: unknown): void => {
      let failed = files.get(path);
      if (!failed) {
        failed = { reported: false, writers: new Map() };
        files.set(path, failed);
        counted();
      }
      const failure = failed.writers.get(writer) ?? { reason, retry };
      failure.reason = reason;
      failure.retry = retry;
      failed.writers.set(writer, failure);
      // A new reason replaces the row's words and its action.
      if (!failed.reported || failed.shown !== shownReason(failed)) fileNotice(path, failed, cause);
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
    // again is clicked, and puts a deleted file back first for Save it
    // again. A settle that could not start files the row again.
    const retryDocument = (path: string) => (failure: WriterFailure, recreateFile: boolean) => {
      void bridge().retryEngineYDocSave({ workspaceId: owner, path, ...(recreateFile ? { recreateFile } : {}) }).then(
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
      else if (event.saveFailure) fail(event.path, "engine", event.saveFailure.reason, retryDocument(event.path));
      else if (event.access || REPLACES_FAILURE.has(event.state.kind)) forget(event.path, "engine");
    });
    const textSave = (save: TextSave): void => {
      if (!current() || save.workspaceId !== owner) return;
      const failed = save.failure;
      if (!failed) {
        forget(save.path, "text");
        return;
      }
      const reason = isPrivacyDenied(failed.cause) ? "privacy-denied"
        : isVolumeSharesNewFiles(failed.cause) ? "volume-shares-new-files" : null;
      fail(save.path, "text", reason, (failure) => {
        if (!failed.retry()) reopen(save.path, "text", failure);
      }, failed.cause);
    };
    // One row per document: setting the edits aside replaces the failure.
    const replacement = ({ workspaceId: replaced, path, setAside, failure }: DocumentReplacement): void => {
      if (!current() || replaced !== owner) return;
      const notice = { title: path, details: [["File", path, path.length]] as const, identity: `document-replacement:${owner}:${path}` };
      if (failure) {
        const message = failure.setAsideFailed ? REPLACED_DOCUMENT_UNSAVED
          : setAside ? `${REPLACED_DOCUMENT_NOT_SHOWN} Find your earlier edits in Notices.` : REPLACED_DOCUMENT_NOT_SHOWN;
        latest.current.report({ ...notice, message, cause: failure.cause, retry: failure.retry });
      } else if (setAside) {
        latest.current.report({ ...notice, tone: "success", message: REPLACED_DOCUMENT_SAVED });
      } else {
        latest.current.clear(notice.identity);
      }
    };
    textSaveListeners.add(textSave);
    replacementListeners.add(replacement);
    return () => {
      stopDocuments();
      textSaveListeners.delete(textSave);
      replacementListeners.delete(replacement);
    };
  }, [workspaceId]);
  return failedSaves.workspaceId === workspaceId ? failedSaves.count : 0;
}
