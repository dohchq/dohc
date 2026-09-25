import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_OPEN_TABS } from "../workbench/workbenchState";
import type { DirectWriteNotice, DirectWriteNoticeKind } from "./useShareDirectWrites";

export type SettingsFileKind = "user-settings-file" | "workspace-settings-file";
type ShellErrorKind =
  | "singleton-tab-split"
  | "tab-limit"
  | "workspace-search"
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
  retry: (() => void) | null;
  // A step that fixes the cause, offered beside Try again.
  action?: { label: string; run: () => void };
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
  const push = useCallback(
    (error: Omit<ShellError, "id" | "atMs" | "seen">) => {
      nextId.current += 1;
      const next: ShellError = {
        ...error,
        message:
          error.message.length > SHELL_ERROR_MAX_CHARS
            ? `${error.message.slice(0, SHELL_ERROR_MAX_CHARS - 1)}…`
            : error.message,
        id: `shell-error-${nextId.current}`,
        atMs: Date.now(),
        seen: false,
      };
      setShellErrors((current) => [
        ...current.filter(
          (existing) =>
            existing.message !== next.message &&
            (next.kind === undefined || existing.kind !== next.kind),
        ),
        next,
      ]);
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
      kind?: "workspace-search",
    ) => {
      const detail = error instanceof Error ? error.message.trim() : "";
      push({
        message:
          detail && detail !== fallback && !detail.startsWith(`${fallback} `)
            ? `${fallback} ${detail}`
            : detail || fallback,
        retry,
        ...(kind ? { kind } : {}),
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
  // Snapshot lanes share one surface. Keep the lane in the message so the
  // user can tell which value went stale, then show the cause and a retry.
  //
  // The retry matters most on the first load. A sibling that fails while the
  // page succeeds renders the timeline, which hides History's own Try again —
  // so without this the lane had no way back at all, and its value could sit
  // stale until unrelated workspace activity happened to refresh it.
  const reportLaneFailure = useCallback(
    (lane: string, error: unknown, retry: () => void) => {
      const cause = error instanceof Error ? error.message : null;
      push({ message: cause ? `${lane} ${cause}` : lane, retry });
    },
    [push],
  );

  const showShellError = useCallback(
    (message: string) => push({ message, retry: null }),
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
  // One row per kind of direct-write answer. Send as proposal sends every
  // waiting change and then clears the rows it answers.
  const showDirectWriteNotice = useCallback(
    (notice: DirectWriteNotice) => {
      const { sendAsProposal } = notice;
      push({
        message: notice.message,
        retry: notice.retry,
        ...(sendAsProposal
          ? {
              action: {
                label: "Send as proposal",
                run: () => {
                  clearKind("direct-write-stale", "direct-write-refused");
                  sendAsProposal();
                },
              },
            }
          : {}),
        kind: notice.kind,
      });
    },
    [clearKind, push],
  );
  // The row stays: the file is still wrong until the person saves it.
  const runShellErrorAction = useCallback((id: string) => {
    shellErrorsRef.current.find((error) => error.id === id)?.action?.run();
  }, []);
  const showSuccessNotice = useCallback(
    (message: string) => push({ message, retry: null, tone: "success" }),
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
    reportLaneFailure,
    reportSearchError,
    clearSearchError,
    showTabLimitError,
    clearTabLimitError,
    showSingletonTabSplitError,
    clearEditorGroupRefusalError,
    showShellError,
    showSettingsFileNotice,
    showDirectWriteNotice,
    showSuccessNotice,
    hideShellError,
    dismissShellError,
    retryShellError,
    runShellErrorAction,
  };
}
