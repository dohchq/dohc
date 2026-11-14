import { useLayoutEffect, useReducer, useState } from "react";
import type { WorkspaceSession } from "./workspaceSession";

export type WorkspaceQueryOptions<T> = {
  // What is read in this session. A new key retires the old key's reads and
  // starts from no value.
  key: string;
  // A newer read aborts this signal, and only the newest read sets the value,
  // the error, or the end of pending. An answer that ignores the signal is
  // still dropped.
  load: (signal: AbortSignal) => Promise<T>;
  // Read only when retry is called, not when the query starts.
  manual?: boolean;
};

export type WorkspaceQuery<T> = {
  value: T | undefined;
  pending: boolean;
  // The newest read's failure, or null.
  error: unknown;
  // Reads again. Resolves when that read settles or is dropped; never rejects.
  retry: () => Promise<void>;
};

type Owner<T> = {
  session: WorkspaceSession;
  key: string;
  options: WorkspaceQueryOptions<T>;
  state: Omit<WorkspaceQuery<T>, "retry">;
  start: () => void;
  retire: () => void;
  retry: () => Promise<void>;
};

function createOwner<T>(
  session: WorkspaceSession,
  options: WorkspaceQueryOptions<T>,
  repaint: () => void,
): Owner<T> {
  let live = false;
  let newest: AbortController | null = null;
  const publish = (next: Partial<Owner<T>["state"]>) => {
    owner.state = { ...owner.state, ...next };
    repaint();
  };
  const owner: Owner<T> = {
    session,
    key: options.key,
    options,
    state: { value: undefined, pending: false, error: null },
    // React retires and starts an owner again when it hides and shows its
    // subtree. The retired read was dropped, so a query that reads on start
    // asks again, and a manual one stops pending.
    start: () => {
      live = true;
      if (!owner.options.manual) void owner.retry();
      else if (owner.state.pending) publish({ pending: false });
    },
    retire: () => {
      live = false;
      newest?.abort();
      newest = null;
    },
    retry: async () => {
      if (!live) return;
      newest?.abort();
      const read = new AbortController();
      newest = read;
      publish({ pending: true, error: null });
      let answer: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        answer = { ok: true, value: await owner.options.load(read.signal) };
      } catch (error) {
        answer = { ok: false, error };
      }
      if (read.signal.aborted) return;
      newest = null;
      if (answer.ok) {
        publish({ value: answer.value, pending: false });
      } else {
        publish({ error: answer.error, pending: false });
      }
    },
  };
  return owner;
}

// A workspace read that owns its value, its ordering, and its retirement. The
// caller gets no setter and no request token, so a late answer cannot reach
// state the query does not own. A loader that writes other state itself can
// still write it late: keep loaders to reading and returning.
export function useWorkspaceQuery<T>(
  session: WorkspaceSession,
  options: WorkspaceQueryOptions<T>,
): WorkspaceQuery<T> {
  const [, repaint] = useReducer((count: number) => count + 1, 0);
  const [held, hold] = useState(() => createOwner(session, options, repaint));
  let owner = held;
  if (owner.session !== session || owner.key !== options.key) {
    owner = createOwner(session, options, repaint);
    hold(owner);
  }
  useLayoutEffect(() => {
    owner.options = options;
  });
  // Layout cleanup retires the owner before the browser paints the next one.
  useLayoutEffect(() => {
    owner.start();
    return owner.retire;
  }, [owner]);
  return { ...owner.state, retry: owner.retry };
}
