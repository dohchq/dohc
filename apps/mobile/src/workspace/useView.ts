import { accountWords } from "@dohc/interface-words/account";
import { documentWords } from "@dohc/interface-words/documents";
import { noticesWords } from "@dohc/interface-words/notices";
import { workspaceWords } from "@dohc/interface-words/workspace";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useShownWorkspaces } from "../chats/Workspaces";
import { useNotices } from "../notices/NoticesState";
import { useHideToast, useShowToast } from "../notices/Toast";
import { serverName } from "../server/origin";
import type { FeedState, ReadProblem, View, ViewState } from "../server/workspaceData";
import { failureStep, type Reported } from "./failureReports";

const NOTHING: ViewState<never> = { value: null, loading: false, problem: null, failures: 0 };
const NO_FEED: FeedState = { problem: null, failures: 0 };

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

/** Whether the open workspace's change feed is failing, and Try again for it, which starts it again at once. */
export function useFeed(): { readonly state: FeedState; retry(): void } {
  const { data } = useAccount();
  const subscribe = useCallback((listener: () => void) => data ? data.subscribeFeed(listener) : () => {}, [data]);
  const state = useSyncExternalStore(subscribe, useCallback(() => data ? data.feed() : NO_FEED, [data]));
  const retry = useCallback(() => data?.retryFeed(), [data]);
  return { state, retry };
}

/**
 * What a chat or page, outside the tabs, shows above the content it keeps: its own refresh that failed, or else a
 * feed that keeps failing, each with its Try again. Null while neither has.
 */
export function useKeptContentProblem(problem: ReadProblem | null, retry: () => void): { readonly text: string; retry(): void } | null {
  const feed = useFeed();
  const problemText = useProblemText();
  const { current } = useShownWorkspaces();
  if (problem) return { text: problemText(problem), retry };
  if (feed.state.problem && current) {
    return { text: `${workspaceWords.changesFailed(current.name)} ${problemText(feed.state.problem)}`, retry: feed.retry };
  }
  return null;
}

/** Why a read failed, in words: what the server did, then what to do. */
export function useProblemText(): (problem: ReadProblem) => string {
  const server = serverName(useSignIn().origin);
  return useCallback((problem: ReadProblem) => problem === "restoring" ? documentWords.restoring : accountWords.problem(problem, server), [server]);
}

/**
 * Reports each failure, of a view's read or of the feed, on a tab as a toast and as a row in Notices, both with Try
 * again. A repeat replaces the row; a later success takes back both. The count is the open store's, so a new store's
 * first failure is reported, and the last store's report goes with it (failureReports.ts). Both go when the screen
 * does, with the workspace they're about: Try again would have nothing left to start.
 */
export function useFailureNotice(id: string, title: string, state: { readonly problem: ReadProblem | null; readonly failures: number },
  retry: () => void) {
  const showToast = useShowToast();
  const hideToast = useHideToast();
  const { add, dismiss } = useNotices();
  const problemText = useProblemText();
  const instance = useAccount().data?.instance ?? 0;
  const reported = useRef<Reported>({ instance, failures: 0 });
  const latest = useRef({ title, retry });
  latest.current = { title, retry };
  useEffect(() => {
    const step = failureStep(reported.current, instance, state);
    reported.current = step.reported;
    if (step.takeBack) {
      hideToast(id);
      dismiss(id);
    }
    if (!step.show || state.problem === null) return;
    const body = problemText(state.problem);
    const again = () => latest.current.retry();
    showToast({ id, tone: "failure", title: latest.current.title, body, action: { label: noticesWords.tryAgain, onPress: again } });
    add({ id, senderKind: null, senderLabel: "", title: latest.current.title, body, minutesAgo: 0, atMs: Date.now(), read: false,
      retry: true, onRetry: again, dismissible: true, failed: true });
  }, [id, instance, state, problemText, showToast, hideToast, add, dismiss]);
  useEffect(() => () => {
    hideToast(id);
    dismiss(id);
  }, [id, hideToast, dismiss]);
}
