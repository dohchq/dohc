import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceSearchPayload } from "../../ipc/bridgeContract";
import { rendererMarks } from "../../performance/rendererMarks";
import { bridge } from "../bridge";
import {
  applyBatch,
  beginSearch,
  idleSearchModel,
  type SearchModel,
} from "./search-model";

const WORKSPACE_UPDATING_MESSAGE = "Workspace is still updating. Try again.";
const UPDATING_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

interface ActiveSearch {
  readonly workspaceId: string;
  readonly payload: WorkspaceSearchPayload;
  retryCount: number;
}

// Electron serializes a rejected invoke into an ordinary renderer Error, so
// the daemon refusal's typed prototype and wire code are no longer available
// here. Match only the exact daemon message, optionally after Electron's
// fixed channel prefix; every other rejection keeps the terminal behavior.
function isWorkspaceUpdatingInvokeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return false;
  }
  const message = error.message;
  return (
    typeof message === "string" &&
    (message === WORKSPACE_UPDATING_MESSAGE ||
      message.endsWith(`: ${WORKSPACE_UPDATING_MESSAGE}`))
  );
}

export interface SearchRunOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeGlob?: string;
  excludeGlob?: string;
}

// What the search form holds, as the inputs show it: a run's options with the
// glob boxes always present (an empty box is "", never absent).
export interface SearchCriteria extends SearchRunOptions {
  includeGlob: string;
  excludeGlob: string;
}

function blankSearchCriteria(): SearchCriteria {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    includeGlob: "",
    excludeGlob: "",
  };
}

export interface WorkspaceSearchApi {
  model: SearchModel;
  criteria: SearchCriteria;
  setCriteria: (next: SearchCriteria) => void;
  run: (options: SearchRunOptions) => void;
  clear: () => void;
}

export type WorkspaceSearchErrorReporter = (
  error: unknown,
  retry: () => void,
) => void;

// Owns the streamed-search lifecycle for ONE workspace: mints search ids,
// folds validated batches into the pure model, and drops stale batches by
// identity (applyBatch returns the same reference for a superseded search).
// Lives in the SHELL (not the Search view) so results — and the activity-bar
// count badge — survive switching views; the panel unmounts, the model stays.
// The criteria live here too, beside the results they describe: a reopened
// input that had forgotten its query sat above results it no longer named.
export function useWorkspaceSearch(
  workspaceId: string,
  reportError: WorkspaceSearchErrorReporter,
  clearReportedError: () => void,
): WorkspaceSearchApi {
  const [model, setModel] = useState<SearchModel>(idleSearchModel);
  const [criteria, setCriteria] = useState<SearchCriteria>(blankSearchCriteria);
  // Event-driven transitions read/write through the ref so a burst of IPC
  // batches between renders folds correctly (never against a stale snapshot).
  const modelRef = useRef(model);
  // The listener outlives each render. Its authority follows the last commit,
  // never a replacement render that React may abandon.
  const committedWorkspaceIdRef = useRef(workspaceId);
  // Separately tracks which workspace owns the model so replacement resets it.
  const modelWorkspaceIdRef = useRef(workspaceId);
  const activeSearchRef = useRef<ActiveSearch | null>(null);
  const failedSearchRef = useRef<ActiveSearch | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useCallback((next: SearchModel) => {
    modelRef.current = next;
    setModel(next);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  useEffect(() => {
    return bridge().onSearchResults((batch) => {
      const active = activeSearchRef.current;
      if (
        active === null ||
        active.workspaceId !== committedWorkspaceIdRef.current ||
        active.payload.searchId !== batch.searchId
      ) {
        return;
      }
      const next = applyBatch(modelRef.current, batch);
      if (next === modelRef.current) return; // stale batch — dropped
      if (batch.done) {
        activeSearchRef.current = null;
        clearRetryTimer();
      }
      commit(next);
    });
  }, [clearRetryTimer, commit]);

  // An updating retry belongs to the workspace that issued it. Workspace
  // replacement and unmount both invalidate it before the timer can invoke
  // the old authority again.
  useLayoutEffect(() => {
    committedWorkspaceIdRef.current = workspaceId;
    if (modelWorkspaceIdRef.current !== workspaceId) {
      modelWorkspaceIdRef.current = workspaceId;
      activeSearchRef.current = null;
      failedSearchRef.current = null;
      clearRetryTimer();
      commit(idleSearchModel());
      setCriteria(blankSearchCriteria());
    }
    return () => {
      const active = activeSearchRef.current;
      const failed = failedSearchRef.current;
      if (failed?.workspaceId === workspaceId) failedSearchRef.current = null;
      if (active?.workspaceId === workspaceId) {
        activeSearchRef.current = null;
        clearRetryTimer();
        void bridge()
          .cancelWorkspaceSearch({ searchId: active.payload.searchId })
          .catch(() => undefined);
      }
    };
  }, [clearRetryTimer, commit, workspaceId]);

  const issue = useCallback(
    function issue(active: ActiveSearch): void {
      void bridge()
        .searchWorkspace(active.payload)
        .catch((error: unknown) => {
          if (
            activeSearchRef.current !== active ||
            modelRef.current.searchId !== active.payload.searchId
          ) {
            return;
          }
          if (isWorkspaceUpdatingInvokeError(error)) {
            commit({ ...modelRef.current, status: "updating" });
            const delay =
              UPDATING_RETRY_DELAYS_MS[
                Math.min(active.retryCount, UPDATING_RETRY_DELAYS_MS.length - 1)
              ];
            active.retryCount += 1;
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              if (activeSearchRef.current === active) issue(active);
            }, delay);
            return;
          }

          // The search never started (unknown workspace, vanished root): no
          // done-batch will ever arrive. Return to idle instead of presenting
          // a failed invocation as a successful search with zero results.
          activeSearchRef.current = null;
          failedSearchRef.current = active;
          commit(idleSearchModel());
          reportError(error, () => {
            if (
              failedSearchRef.current !== active ||
              committedWorkspaceIdRef.current !== active.workspaceId
            ) {
              return;
            }
            const retry: ActiveSearch = {
              ...active,
              payload: { ...active.payload, searchId: crypto.randomUUID() },
              retryCount: 0,
            };
            failedSearchRef.current = null;
            activeSearchRef.current = retry;
            rendererMarks.mark("content-search-start");
            commit(beginSearch(retry.payload.searchId));
            issue(retry);
          });
        });
    },
    [commit, reportError],
  );

  const run = useCallback(
    (options: SearchRunOptions) => {
      clearRetryTimer();
      failedSearchRef.current = null;
      clearReportedError();
      // A renderer reload preserves its webContents sender id but creates a
      // new JavaScript realm. A realm-local sequence could therefore reuse an
      // old request id; a UUID keeps cancellation and late events exact across
      // that reload seam as well as ordinary remounts.
      const searchId = crypto.randomUUID();
      // Perf bracket start (budgets contentSearchFirstResultMs/-CompleteMs):
      // issue → rg spawn → first streamed batch / final batch COMMITTED.
      // The SearchView's post-commit effects record the measures.
      rendererMarks.mark("content-search-start");
      commit(beginSearch(searchId));
      const active: ActiveSearch = {
        workspaceId,
        payload: {
          workspaceId,
          searchId,
          query: options.query,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          regex: options.regex,
          ...(options.includeGlob ? { includeGlob: options.includeGlob } : {}),
          ...(options.excludeGlob ? { excludeGlob: options.excludeGlob } : {}),
        },
        retryCount: 0,
      };
      activeSearchRef.current = active;
      issue(active);
    },
    [clearReportedError, clearRetryTimer, workspaceId, commit, issue],
  );

  const clear = useCallback(() => {
    activeSearchRef.current = null;
    failedSearchRef.current = null;
    clearReportedError();
    clearRetryTimer();
    const current = modelRef.current;
    if (
      current.searchId !== null &&
      (current.status === "searching" || current.status === "updating")
    ) {
      // Explicit cancel kills the rg child by its tracked handle in main.
      void bridge()
        .cancelWorkspaceSearch({ searchId: current.searchId })
        .catch(() => undefined);
    }
    commit(idleSearchModel());
  }, [clearReportedError, clearRetryTimer, commit]);

  // A workspace replacement renders once before its layout effects run. Gate
  // that render by ownership too, so React never hands the new workspace the
  // previous workspace's query or results—even as an unpainted snapshot.
  const ownsRenderedState = modelWorkspaceIdRef.current === workspaceId;
  return {
    model: ownsRenderedState ? model : idleSearchModel(),
    criteria: ownsRenderedState ? criteria : blankSearchCriteria(),
    setCriteria,
    run,
    clear,
  };
}
