import { useLayoutEffect, useReducer, useState } from "react";
import type { WorkspaceSession } from "./workspaceSession";

export type WorkspaceQueryOptions<T, A> = {
  // What is read in this session. A new key retires the old key's reads and
  // starts from no value.
  key: string;
  // A newer read aborts this signal, and only the newest read sets the value,
  // the error, or the end of pending. An answer that ignores the signal is
  // still dropped.
  load: (signal: AbortSignal, argument: A | undefined) => Promise<T>;
  // Read only when retry is called, not when the query starts.
  manual?: boolean;
  // Hears each failure that sets the error, in the same update.
  report?: (error: unknown) => void;
};

export type WorkspaceQuery<T, A> = {
  value: T | undefined;
  pending: boolean;
  // The newest read's failure, or null.
  error: unknown;
  // Reads again. Resolves when that read settles or is dropped; never rejects.
  retry: (argument?: A) => Promise<void>;
  // Reads again unless a read is in flight. It checks when called, not at the
  // last render, so two calls before React renders again send one read.
  retryIfIdle: (argument?: A) => Promise<void>;
};

type Owner<T, A> = {
  session: WorkspaceSession;
  key: string;
  options: WorkspaceQueryOptions<T, A>;
  state: Omit<WorkspaceQuery<T, A>, "retry" | "retryIfIdle">;
  start: () => void;
  retire: () => void;
  retry: (argument?: A) => Promise<void>;
  retryIfIdle: (argument?: A) => Promise<void>;
};

function createOwner<T, A>(
  session: WorkspaceSession,
  options: WorkspaceQueryOptions<T, A>,
  repaint: () => void,
): Owner<T, A> {
  let live = false;
  let newest: AbortController | null = null;
  const publish = (next: Partial<Owner<T, A>["state"]>) => {
    owner.state = { ...owner.state, ...next };
    repaint();
  };
  const owner: Owner<T, A> = {
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
    retry: async (argument) => {
      if (!live) return;
      newest?.abort();
      const read = new AbortController();
      newest = read;
      publish({ pending: true, error: null });
      let answer: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        answer = { ok: true, value: await owner.options.load(read.signal, argument) };
      } catch (error) {
        answer = { ok: false, error };
      }
      if (read.signal.aborted) return;
      newest = null;
      if (answer.ok) {
        publish({ value: answer.value, pending: false });
      } else {
        publish({ error: answer.error, pending: false });
        owner.options.report?.(answer.error);
      }
    },
    retryIfIdle: (argument) => newest ? Promise.resolve() : owner.retry(argument),
  };
  return owner;
}

// A workspace read that owns its value, its ordering, and its retirement. The
// caller gets no setter and no request token, so a late answer cannot reach
// state the query does not own. A loader that writes other state itself can
// still write it late: keep loaders to reading and returning.
export function useWorkspaceQuery<T, A = never>(
  session: WorkspaceSession,
  options: WorkspaceQueryOptions<T, A>,
): WorkspaceQuery<T, A> {
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
  return { ...owner.state, retry: owner.retry, retryIfIdle: owner.retryIfIdle };
}
