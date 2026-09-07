import { useCallback, useEffect, useState } from "react";
import { MAX_OPEN_TABS } from "../workbench/workbenchState";

export function useShellError(workspaceId: string) {
  // The banner carries its own way out. An error that names a value the user
  // can see and gives no way to ask again leaves them with a stale reading and
  // nothing to do about it — the reverse path every reversible state change
  // owes (AGENTS.md). Errors that are already over when they are shown carry
  // no retry.
  const [shellError, setShellError] = useState<{
    message: string;
    retry: (() => void) | null;
    kind?: "singleton-tab-split" | "tab-limit" | "workspace-search";
  } | null>(null);
  const showTabLimitError = useCallback(
    (
      openTabCount: number,
      nextAction: "open this file" | "open another tab" | "create an editor group",
    ) => {
      setShellError({
        message: `This workspace has ${openTabCount} open tabs; the limit is ${MAX_OPEN_TABS}. Close a tab to ${nextAction}.`,
        retry: null,
        kind: "tab-limit",
      });
    },
    [],
  );
  const clearTabLimitError = useCallback(() => {
    setShellError((currentError) =>
      currentError?.kind === "tab-limit" ? null : currentError,
    );
  }, []);
  const showSingletonTabSplitError = useCallback(() => {
    setShellError({
      message:
        "This tab owns its process and cannot be split. Open another tab before you create an editor group.",
      retry: null,
      kind: "singleton-tab-split",
    });
  }, []);
  const clearEditorGroupRefusalError = useCallback(() => {
    setShellError((currentError) =>
      currentError?.kind === "singleton-tab-split" ||
      currentError?.kind === "tab-limit"
        ? null
        : currentError,
    );
  }, []);

  useEffect(() => {
    setShellError(null);
  }, [workspaceId]);

  const reportShellError = useCallback(
    (
      fallback: string,
      error: unknown,
      retry: (() => void) | null = null,
      kind?: "workspace-search",
    ) => {
      const detail = error instanceof Error ? error.message.trim() : "";
      setShellError({
        message:
          detail && detail !== fallback && !detail.startsWith(`${fallback} `)
            ? `${fallback} ${detail}`
            : detail || fallback,
        retry,
        ...(kind ? { kind } : {}),
      });
    },
    [],
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
  const clearSearchError = useCallback(() => {
    setShellError((current) =>
      current?.kind === "workspace-search" ? null : current,
    );
  }, []);
  // Snapshot lanes share one banner. Keep the lane in the message so the user
  // can tell which value went stale, then show the cause and a retry control.
  //
  // The retry matters most on the first load. A sibling that fails while the
  // page succeeds renders the timeline, which hides History's own Try again —
  // so without this the lane had no way back at all, and its value could sit
  // stale until unrelated workspace activity happened to refresh it.
  const reportLaneFailure = useCallback(
    (lane: string, error: unknown, retry: () => void) => {
      const cause = error instanceof Error ? error.message : null;
      setShellError({ message: cause ? `${lane} ${cause}` : lane, retry });
    },
    [],
  );

  const showShellError = useCallback((message: string) => {
    setShellError({ message, retry: null });
  }, []);
  const dismissShellError = useCallback(() => {
    setShellError(null);
  }, []);
  const retryShellError = useCallback(() => {
    const retry = shellError?.retry;
    // Clearing first is what shows the control took: the read is
    // on its way, and a failure that is being retried is no longer
    // the newest thing this surface knows.
    setShellError(null);
    retry?.();
  }, [shellError]);

  return {
    shellError,
    reportShellError,
    reportLaneFailure,
    reportSearchError,
    clearSearchError,
    showTabLimitError,
    clearTabLimitError,
    showSingletonTabSplitError,
    clearEditorGroupRefusalError,
    showShellError,
    dismissShellError,
    retryShellError,
  };
}
