import { useMemo, useRef, useState } from "react";

// Two facts per lane, because the two questions a lane is asked are different
// ones:
//
// - `committed` — what this lane last WROTE. A response, or a local action by
//   the user, which counts as newer than every request already issued.
// - `issued` — the newest request this lane has ASKED. Not the same fact: a
//   request in flight has written nothing, and "is anything newer coming"
//   cannot be answered from what was last written.
type LaneMark = { committed: number; issued: number };

// A lane of UI state that several reads compete to write, ordered by one issue
// counter the lane shares with its siblings.
//
// The lane OWNS its state: React's setter never leaves this module. So a write
// cannot name a request it did not make, and a request cannot claim a lane it
// says nothing about — the shape that let four responses write a lane they
// never claimed (#636). Every write here takes the claim and the value in one
// call, so neither half can be forgotten:
//
// `select` returns the lane's own value. It is a projection, not a writer: a
// response holds no capability to write anything, a sibling lane least of all.
export type SnapshotLane<T> = {
  // The newest committed value, for the callbacks that must read it without
  // listing it as a dependency.
  latest: () => T;
  // An answer. It writes the lane when it is newer than what the lane last
  // wrote — a request that is merely in flight has answered nothing, and one
  // that FAILS never will, so superseding on ISSUE would throw away the only
  // answer there was.
  commit: (token: number, value: T) => void;
  // The user acted, so this value is newer than every request in flight. The
  // committed mark jumps to the newest token ISSUED and the losing answers
  // lose by construction whenever they land. Dismissing a review is the case
  // that bites: it emits no replacement activity, so a restored card would sit
  // there until something unrelated refreshed.
  //
  // It moves `committed` and not `issued`: the user asked nothing. A failure
  // from the request they superseded is judged by `committed`, and stays quiet.
  set: (value: T) => void;
  // The whole read, so BOTH ways it can settle face the same rule, and the
  // request registers itself, so no caller can issue a read the lane does not
  // know about.
  //
  // A failure is an answer too, and asking it separately is how the rule leaks.
  // It may report, because a lane with no failure surface of its own has only
  // the banner to say a shown value is now old. It may report only when it is
  // still the newest thing this lane asked — which covers BOTH orderings of a
  // stale failure against a fresher request. The newer answer may already have
  // committed (then `committed` outranks it), or it may still be in flight
  // (then `issued` does). Both are the same fact: a failure whose question
  // someone has already asked again has nothing to say, and a banner it raised
  // would claim the value on screen could not be read.
  //
  // A failure never advances either mark. A read that failed proves nothing,
  // and an older read that still succeeds is the only answer anyone has (#507).
  settle: <R>(
    token: number,
    read: Promise<R>,
    select: (value: R) => T,
    report: (error: unknown) => void,
  ) => void;
  // Everything in flight is now stale, on this lane. The committed mark jumps
  // to the newest token issued, so no outstanding read can write.
  invalidate: () => void;
};

export function useSnapshotLane<T>(
  issue: { readonly current: number },
  initial: T,
): [T, SnapshotLane<T>] {
  const [value, setValue] = useState<T>(initial);
  const latest = useRef<T>(initial);
  const mark = useRef<LaneMark>({ committed: 0, issued: 0 });
  const lane = useMemo<SnapshotLane<T>>(() => {
    const write = (next: T) => {
      latest.current = next;
      setValue(next);
    };
    const commit = (token: number, next: T) => {
      if (token <= mark.current.committed) return;
      mark.current.committed = token;
      write(next);
    };
    return {
      latest: () => latest.current,
      commit,
      set: (next) => {
        mark.current.committed = issue.current;
        write(next);
      },
      settle: (token, read, select, report) => {
        if (token > mark.current.issued) mark.current.issued = token;
        void read.then(
          (answer) => commit(token, select(answer)),
          (error: unknown) => {
            if (token <= mark.current.committed || token < mark.current.issued) {
              return;
            }
            report(error);
          },
        );
      },
      invalidate: () => {
        mark.current.committed = issue.current;
      },
    };
  }, [issue]);
  return [value, lane];
}
