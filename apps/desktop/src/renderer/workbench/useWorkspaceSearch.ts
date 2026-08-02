import { useCallback, useEffect, useRef, useState } from "react";
import { rendererMarks } from "../../performance/rendererMarks";
import { bridge } from "../bridge";
import {
  applyBatch,
  beginSearch,
  idleSearchModel,
  type SearchModel,
} from "./search-model";

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

// Monotonic across remounts (workspace switches remount the shell): a stale
// batch from the previous mount's search can never collide with a new id.
let searchSequence = 0;

// Owns the streamed-search lifecycle for ONE workspace: mints search ids,
// folds validated batches into the pure model, and drops stale batches by
// identity (applyBatch returns the same reference for a superseded search).
// Lives in the SHELL (not the Search view) so results — and the activity-bar
// count badge — survive switching views; the panel unmounts, the model stays.
// The criteria live here too, beside the results they describe: a reopened
// input that had forgotten its query sat above results it no longer named.
export function useWorkspaceSearch(workspaceId: string): WorkspaceSearchApi {
  const [model, setModel] = useState<SearchModel>(idleSearchModel);
  const [criteria, setCriteria] = useState<SearchCriteria>(blankSearchCriteria);
  // Event-driven transitions read/write through the ref so a burst of IPC
  // batches between renders folds correctly (never against a stale snapshot).
  const modelRef = useRef(model);
  const commit = useCallback((next: SearchModel) => {
    modelRef.current = next;
    setModel(next);
  }, []);

  useEffect(() => {
    return bridge().onSearchResults((batch) => {
      const next = applyBatch(modelRef.current, batch);
      if (next === modelRef.current) return; // stale batch — dropped
      commit(next);
    });
  }, [commit]);

  const run = useCallback(
    (options: SearchRunOptions) => {
      const searchId = `s${++searchSequence}`;
      // Perf bracket start (budgets contentSearchFirstResultMs/-CompleteMs):
      // issue → rg spawn → first streamed batch / final batch COMMITTED.
      // The SearchView's post-commit effects record the measures.
      rendererMarks.mark("content-search-start");
      commit(beginSearch(searchId));
      void bridge()
        .searchWorkspace({
          workspaceId,
          searchId,
          query: options.query,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          regex: options.regex,
          ...(options.includeGlob ? { includeGlob: options.includeGlob } : {}),
          ...(options.excludeGlob ? { excludeGlob: options.excludeGlob } : {}),
        })
        .catch(() => {
          // The search never started (unknown workspace, vanished root): no
          // done-batch will ever arrive, so settle the spinner here — but
          // only if this search is still the current one.
          if (modelRef.current.searchId === searchId) {
            commit({ ...modelRef.current, status: "complete" });
          }
        });
    },
    [workspaceId, commit],
  );

  const clear = useCallback(() => {
    const current = modelRef.current;
    if (current.searchId !== null && current.status === "searching") {
      // Explicit cancel kills the rg child by its tracked handle in main.
      void bridge()
        .cancelWorkspaceSearch({ searchId: current.searchId })
        .catch(() => undefined);
    }
    commit(idleSearchModel());
  }, [commit]);

  return { model, criteria, setCriteria, run, clear };
}
