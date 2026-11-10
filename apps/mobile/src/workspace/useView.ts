import { accountWords } from "@dohc/interface-words/account";
import { documentWords } from "@dohc/interface-words/documents";
import { noticesWords } from "@dohc/interface-words/notices";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useNotices } from "../notices/NoticesState";
import { useHideToast, useShowToast } from "../notices/Toast";
import { serverName } from "../server/origin";
import type { ReadProblem, View, ViewState } from "../server/workspaceData";

const NOTHING: ViewState<never> = { value: null, loading: false, problem: null, failures: 0 };

/**
 * A view of the open workspace, read while the screen shows it. `view` must keep its identity between renders: a
 * constant from `views`, or one made in a memo.
 */
export function useView<T>(view: View<T>): { readonly state: ViewState<T>; retry(): void } {
  const { data } = useAccount();
  const subscribe = useCallback((listener: () => void) => data ? data.subscribe(view, listener) : () => {}, [data, view]);
  const state = useSyncExternalStore(subscribe, useCallback((): ViewState<T> => data ? data.state(view) : NOTHING, [data, view]));
  const retry = useCallback(() => data?.retry(view), [data, view]);
  return { state, retry };
}

/** Why a read failed, in words: what the server did, then what to do. */
export function useProblemText(): (problem: ReadProblem) => string {
  const server = serverName(useSignIn().origin);
  return useCallback((problem: ReadProblem) => problem === "restoring" ? documentWords.restoring : accountWords.problem(problem, server), [server]);
}

/**
 * Reports each failed read of a view on a tab as a toast, and as a row in Notices, both with Try again. A repeat
 * replaces the row; a later success takes back both.
 */
export function useFailureNotice(id: string, title: string, state: ViewState<unknown>, retry: () => void) {
  const showToast = useShowToast();
  const hideToast = useHideToast();
  const { add, dismiss } = useNotices();
  const problemText = useProblemText();
  const reported = useRef(state.failures);
  const latest = useRef({ title, retry });
  latest.current = { title, retry };
  useEffect(() => {
    if (state.failures === reported.current || state.problem === null) return;
    reported.current = state.failures;
    const body = problemText(state.problem);
    const again = () => latest.current.retry();
    showToast({ id, tone: "failure", title: latest.current.title, body, action: { label: noticesWords.tryAgain, onPress: again } });
    add({ id, senderKind: null, senderLabel: "", title: latest.current.title, body, minutesAgo: 0, atMs: Date.now(), read: false,
      retry: true, onRetry: again, dismissible: true, failed: true });
  }, [id, state.failures, state.problem, problemText, showToast, add]);
  const recovered = state.problem === null && state.value !== null && reported.current > 0;
  useEffect(() => {
    if (!recovered) return;
    hideToast(id);
    dismiss(id);
  }, [id, recovered, hideToast, dismiss]);
}
