import {
  engineDocRequestKey,
  retainEngineDocLease,
  type EngineDocInput,
} from "./engineDocLease";

export function retainObservedEngineDocLease(input: EngineDocInput) {
  const lease = retainEngineDocLease(input, engineDocRequestKey(input), false);
  let snapshot = lease.getSnapshot();
  const unsubscribe = lease.subscribe(() => {
    snapshot = lease.getSnapshot();
  });
  let released = false;

  return {
    lease,
    get snapshot() {
      return snapshot;
    },
    boundDoc() {
      const outcome = snapshot.outcome;
      if (outcome?.kind !== "bound") throw new Error("Expected a bound lease");
      return outcome.doc;
    },
    release() {
      if (released) return;
      released = true;
      unsubscribe();
      lease.release();
    },
  };
}
