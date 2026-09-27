import { useCallback, useEffect, useRef, useState } from "react";
import { readError, UNKNOWN_ERROR_WORDS, withErrorWords } from "../../ipc/errorWords";
import { MAX_OPEN_TABS } from "../workbench/workbenchState";
import type { ErrorDetailField } from "./copyDetails";
import type { DirectWriteNotice, DirectWriteNoticeKind } from "./useShareDirectWrites";

export type SettingsFileKind = "user-settings-file" | "workspace-settings-file";
export type ShellErrorKind =
  | "singleton-tab-split"
  | "tab-limit"
  | "workspace-search"
  | "cloud-sync"
  | "import-files"
  | "share-refresh"
  | "drive-no-atomic-placement"
  | "kept-files"
  | DirectWriteNoticeKind
  | SettingsFileKind;

// A message the toast and the Notices row can hold. A protocol response or a
// validation reason can run long; the report Copy makes keeps the rest.
export const SHELL_ERROR_MAX_CHARS = 500;

// One workspace error the notice center shows: a toast when it arrives, a
// row in Notices until it is retried or dismissed. An error that names a
// value the user can see owes them a way to ask again (AGENTS.md), so a
// retry rides with it; errors that are already over carry none.
export interface ShellError {
  tone?: "success";
  id: string;
  message: string;
  // Facts for a report, one "label: value" line each, such as the error as
  // it arrived. They go into Copy details, not the text a person reads.
  details?: ReadonlyArray<ErrorDetailField>;
  retry: (() => void) | null;
  // A step offered beside Try again: one that fixes the cause, such as
  // opening the file it names, or a success notice's Undo. A step that
  // `ends` the notice removes its row when it runs.
  action?: { label: string; run: () => void; ends?: boolean };
  kind?: ShellErrorKind;
  atMs: number;
  // The toast was closed; the row in Notices stays until dismissed there.
  seen: boolean;
}

export function useShellError(workspaceId: string) {
  const [shellErrors, setShellErrors] = useState<readonly ShellError[]>([]);
  const shellErrorsRef = useRef(shellErrors);
  shellErrorsRef.current = shellErrors;
  const nextId = useRef(0);

  // A new error replaces an older one that says the same thing, or one of
  // the same kind, so a read that keeps failing is one row, not a pile.
  // `seen` files the row without a toast; "keep" gives it the seen state of
  // the row of its kind it replaces, so an open toast stays open.
  const push = useCallback(
    (error: Omit<ShellError, "id" | "atMs" | "seen">, seen: boolean | "keep" = false) => {
      nextId.current += 1;
      const id = `shell-error-${nextId.current}`;
      const atMs = Date.now();
      const message =
        error.message.length > SHELL_ERROR_MAX_CHARS
          ? `${error.message.slice(0, SHELL_ERROR_MAX_CHARS - 1)}…`
          : error.message;
      setShellErrors((current) => {
        const replaced =
          error.kind === undefined
            ? undefined
            : current.find((existing) => existing.kind === error.kind);
        const next: ShellError = {
          ...error,
          message,
          id,
          atMs,
          seen: seen === "keep" ? (replaced?.seen ?? true) : seen,
        };
        return [
          ...current.filter(
            (existing) =>
              existing.message !== next.message &&
              (next.kind === undefined || existing.kind !== next.kind),
          ),
          next,
        ];
      });
    },
    [],
  );
  const clearKind = useCallback((...kinds: ShellErrorKind[]) => {
    setShellErrors((current) =>
      current.some((error) => error.kind !== undefined && kinds.includes(error.kind))
        ? current.filter((error) => error.kind === undefined || !kinds.includes(error.kind))
        : current,
    );
  }, []);

  const showTabLimitError = useCallback(
    (
      openTabCount: number,
      nextAction: "open this file" | "open another tab" | "create an editor group",
    ) => {
      push({
        message: `This workspace has ${openTabCount} open tabs; the limit is ${MAX_OPEN_TABS}. Close a tab to ${nextAction}.`,
        retry: null,
        kind: "tab-limit",
      });
    },
    [push],
  );
  const clearTabLimitError = useCallback(() => clearKind("tab-limit"), [clearKind]);
  const showSingletonTabSplitError = useCallback(() => {
    push({
      message:
        "This tab owns its process and cannot be split. Open another tab before you create an editor group.",
      retry: null,
      kind: "singleton-tab-split",
    });
  }, [push]);
  const clearEditorGroupRefusalError = useCallback(
    () => clearKind("singleton-tab-split", "tab-limit"),
    [clearKind],
  );

  useEffect(() => {
    setShellErrors([]);
  }, [workspaceId]);

  const reportShellError = useCallback(
    (
      fallback: string,
      error: unknown,
      retry: (() => void) | null = null,
      kind?: ShellErrorKind,
    ) => {
      const { cause } = readError(error);
      push({
        message: withErrorWords(fallback, error),
        ...(cause ? { details: [["Cause", cause]] } : {}),
        retry,
        ...(kind ? { kind } : {}),
      });
    },
    [push],
  );
  // A failure already worded for the person. Report facts, such as a raw
  // cause, go into Copy details only; so does `cause`, the error that caused
  // the words. Text that arrives raw is read into words the same way. A kind
  // makes a newer message replace the row of an older one, such as one
  // import's result replacing the last.
  const reportShellFailure = useCallback(
    (failure: {
      message: string;
      cause?: unknown;
      details?: ReadonlyArray<ErrorDetailField>;
      retry?: (() => void) | null;
      kind?: ShellErrorKind;
    }) => {
      const shown = readError(failure.message);
      const cause = failure.cause === undefined ? shown.cause : readError(failure.cause).cause;
      const details: ReadonlyArray<ErrorDetailField> = [
        ...(failure.details ?? []),
        ...(cause ? [["Cause", cause] as const] : []),
      ];
      push({
        message: shown.words ?? UNKNOWN_ERROR_WORDS,
        retry: failure.retry ?? null,
        ...(details.length ? { details } : {}),
        ...(failure.kind ? { kind: failure.kind } : {}),
      });
    },
    [push],
  );
  // Content search lives in the shell so its results survive panel switches.
  // Invocation failures use the shell's persistent error and retry contract;
  // they must not look like a successful search with no matches.
  const reportSearchError = useCallback(
    (error: unknown, retry: () => void) =>
      reportShellError(
        "dohc could not search this workspace.",
        error,
        retry,
        "workspace-search",
      ),
    [reportShellError],
  );
  const clearSearchError = useCallback(() => clearKind("workspace-search"), [clearKind]);
  // One sync failure at a time: a new report replaces the last one. A toast
  // interrupts; otherwise the row keeps whatever toast its predecessor had.
  const reportSyncFailure = useCallback(
    (
      notice: { message: string; detail: string; toast: boolean },
      retry: () => void,
    ) =>
      push(
        { message: notice.message, details: [["Detail", notice.detail]], retry, kind: "cloud-sync" },
        notice.toast ? false : "keep",
      ),
    [push],
  );
  const clearSyncFailure = useCallback(() => clearKind("cloud-sync"), [clearKind]);
  // A drive limit: one row that a remount files again without a toast.
  const reportDriveLimit = useCallback(
    (notice: { message: string; toast: boolean }) =>
      push(
        {
          message: notice.message,
          details: [["Detail", "no-atomic-placement"]],
          retry: null,
          kind: "drive-no-atomic-placement",
        },
        !notice.toast,
      ),
    [push],
  );
  const reportKeptFiles = useCallback(
    (notice: { paths: readonly (readonly [string, string])[]; toast: boolean }, openFolder: () => void) => {
      if (!notice.paths.length) {
        clearKind("kept-files");
        return;
      }
      push({
        message: "dohc kept recovery copies of files. Review the copies in .dohc/engine/displaced inside your workspace folder.",
        details: notice.paths.map(([original, copy]) => [original || "Copy", copy] as const),
        retry: null,
        action: { label: "Show recovery folder", run: openFolder },
        kind: "kept-files",
      }, !notice.toast);
    },
    [clearKind, push],
  );
  // Snapshot lanes share one surface. Keep the lane in the message so the
  // user can tell which value went stale, then show the cause and a retry.
  //
  // The retry matters most on the first load. A sibling that fails while the
  // page succeeds renders the timeline, which hides History's own Try again —
  // so without this the lane had no way back at all, and its value could sit
  // stale until unrelated workspace activity happened to refresh it.
  const reportLaneFailure = useCallback(
    (lane: string, error: unknown, retry: () => void) => {
      const { cause } = readError(error);
      push({ message: withErrorWords(lane, error), ...(cause ? { details: [["Cause", cause]] } : {}), retry });
    },
    [push],
  );

  // One row per settings file: a newer read replaces it, and a read with
  // nothing to report clears it. Try again reads the file again; the action
  // opens it.
  const showSettingsFileNotice = useCallback(
    (
      kind: SettingsFileKind,
      message: string | null,
      steps: { retry: () => void; open: () => void },
    ) => {
      if (message === null) clearKind(kind);
      else {
        push({
          message,
          retry: steps.retry,
          action: { label: "Open settings file", run: steps.open },
          kind,
        });
      }
    },
    [clearKind, push],
  );
  // One row per kind of direct-write answer. Sending the waiting changes
  // answers every row that offered it, so it clears them.
  const showDirectWriteNotice = useCallback(
    (notice: DirectWriteNotice) => {
      const { send } = notice;
      push({
        message: notice.message,
        retry: notice.retry,
        ...(send
          ? {
              action: {
                label: send.label,
                run: () => {
                  clearKind("direct-write-stale", "direct-write-refused", "direct-write-unavailable");
                  send.run();
                },
              },
            }
          : {}),
        kind: notice.kind,
      });
    },
    [clearKind, push],
  );
  // A settings file's row stays: the file is still wrong until the person
  // saves it. An Undo's row goes, so it runs once.
  const runShellErrorAction = useCallback((id: string) => {
    const target = shellErrorsRef.current.find((error) => error.id === id);
    if (target?.action?.ends) setShellErrors((current) => current.filter((error) => error.id !== id));
    target?.action?.run();
  }, []);
  // A kind makes a newer message replace the row of an older one, such as
  // one import's result replacing the last import's.
  const showSuccessNotice = useCallback(
    (message: string, undo?: () => void, kind?: ShellErrorKind) => {
      push({
        message,
        retry: null,
        tone: "success",
        ...(kind ? { kind } : {}),
        ...(undo ? { action: { label: "Undo", run: undo, ends: true } } : {}),
      });
    },
    [push],
  );
  // The toast closes; the row in Notices stays.
  const hideShellError = useCallback((id: string) => {
    setShellErrors((current) =>
      current.map((error) => (error.id === id ? { ...error, seen: true } : error)),
    );
  }, []);
  const dismissShellError = useCallback((id: string) => {
    setShellErrors((current) => current.filter((error) => error.id !== id));
  }, []);
  const retryShellError = useCallback((id: string) => {
    const target = shellErrorsRef.current.find((error) => error.id === id);
    // Clearing first is what shows the control took: the read is on its
    // way, and a failure that is being retried is no longer the newest
    // thing this surface knows. The retry runs once, outside the updater.
    setShellErrors((current) => current.filter((error) => error.id !== id));
    target?.retry?.();
  }, []);

  return {
    shellErrors,
    reportShellError,
    reportShellFailure,
    reportLaneFailure,
    reportSearchError,
    clearSearchError,
    reportSyncFailure,
    clearSyncFailure,
    reportDriveLimit,
    reportKeptFiles,
    showTabLimitError,
    clearTabLimitError,
    showSingletonTabSplitError,
    clearEditorGroupRefusalError,
    showSettingsFileNotice,
    showDirectWriteNotice,
    showSuccessNotice,
    hideShellError,
    dismissShellError,
    retryShellError,
    runShellErrorAction,
  };
}
