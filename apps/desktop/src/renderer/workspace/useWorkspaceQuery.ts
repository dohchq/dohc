import { useLayoutEffect, useReducer, useState } from "react";
import type { WorkspaceSession } from "./workspaceSession";

// What an older answer is worth once a newer read was asked.
// - "latest-issued": nothing. A newer read aborts the older ones, and only the
//   newest read sets the value, the error, or the end of pending.
// - "latest-success": an older success still sets the value when no newer
//   success has, because the newer read may fail (#502). It is the commit rule
//   of snapshotLane.ts. Only the newest read sets the error, and pending lasts
//   while any read is in flight.
export type QueryOrdering = "latest-issued" | "latest-success";

export type WorkspaceQueryOptions<T, A> = {
  // What is read in this session. A new key retires the old key's reads and
  // starts from no value.
  key: string;
  // The signal aborts when the read is superseded or retired. An answer that
  // ignores it is still dropped.
  load: (signal: AbortSignal, argument: A | undefined) => Promise<T>;
  ordering?: QueryOrdering;
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
};

type Owner<T, A> = {
  session: WorkspaceSession;
  key: string;
  options: WorkspaceQueryOptions<T, A>;
  state: Omit<WorkspaceQuery<T, A>, "retry">;
  start: () => void;
  retire: () => void;
  retry: (argument?: A) => Promise<void>;
};

function createOwner<T, A>(
  session: WorkspaceSession,
  options: WorkspaceQueryOptions<T, A>,
  repaint: () => void,
): Owner<T, A> {
  let live = false;
  let issued = 0;
  let committed = 0;
  const reads = new Set<AbortController>();
  const abortAll = () => {
    for (const read of reads) read.abort();
    reads.clear();
  };
  const publish = (next: Partial<Owner<T, A>["state"]>) => {
    owner.state = { ...owner.state, ...next };
    repaint();
  };
  const owner: Owner<T, A> = {
    session,
    key: options.key,
    options,
    state: { value: undefined, pending: false, error: null },
    start: () => {
      live = true;
      if (!owner.options.manual) void owner.retry();
    },
    retire: () => {
      live = false;
      abortAll();
    },
    retry: async (argument) => {
      if (!live) return;
      const { load, ordering = "latest-issued" } = owner.options;
      const request = ++issued;
      if (ordering === "latest-issued") abortAll();
      const read = new AbortController();
      reads.add(read);
      publish({ pending: true, error: null });
      let answer: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        answer = { ok: true, value: await load(read.signal, argument) };
      } catch (error) {
        answer = { ok: false, error };
      }
      reads.delete(read);
      if (!live || read.signal.aborted) return;
      const pending = reads.size > 0;
      if (answer.ok && request > committed) {
        committed = request;
        publish({ value: answer.value, pending });
      } else if (!answer.ok && request === issued) {
        publish({ error: answer.error, pending });
        owner.options.report?.(answer.error);
      } else {
        publish({ pending });
      }
    },
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
  return { ...owner.state, retry: owner.retry };
}
