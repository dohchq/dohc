import type { ReadProblem } from "../server/workspaceData";

// When a toast and Notices row report a failure, and when they're taken back. A store counts its own failures, so
// what was reported counts for one store only: a new store, as after Try again on one that has gone, starts from none,
// and the last store's report is taken back with it.

export interface Reported {
  /** The store the count is for. */
  readonly instance: number;
  /** Its failures already reported. */
  readonly failures: number;
}

export interface FailureStep {
  readonly reported: Reported;
  /** Report this failure, replacing any earlier report. */
  readonly show: boolean;
  /** Take back what's reported: the failure is over, or its store is. */
  readonly takeBack: boolean;
}

export function failureStep(reported: Reported, instance: number, state: { readonly problem: ReadProblem | null; readonly failures: number }): FailureStep {
  const replaced = reported.instance !== instance;
  const counted = replaced ? 0 : reported.failures;
  if (state.problem !== null && state.failures > counted) {
    return { reported: { instance, failures: state.failures }, show: true, takeBack: replaced && reported.failures > 0 };
  }
  return { reported: { instance, failures: counted }, show: false, takeBack: (replaced && reported.failures > 0) || (state.problem === null && counted > 0) };
}
