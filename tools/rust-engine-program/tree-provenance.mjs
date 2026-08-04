// The commit a gate run examined, and whether that claim is trustworthy.
//
// A verdict that cannot name the tree it read is not evidence. Two runs
// sharing one worktree once reported PASS and FAIL for the same commit, and
// neither log could say which tree it had actually examined — the checks had
// straddled a `git checkout` performed by the other run.
//
// The classifier is pure so it can be tested without a repository: the gate
// reads the tree state, this decides what that state proves.

/**
 * Judge a run's provenance from the tree state read before and after it.
 *
 * HEAD moving mid-run FAILS: the rows above it straddle two commits and
 * describe neither. A dirty tree does NOT fail — running the gate over
 * uncommitted work is the normal local loop, and a check that forbids it just
 * gets removed. It is recorded instead, so the reader knows the commit does
 * not describe everything that ran.
 */
export function classifyTreeProvenance(before, after) {
  if (!before?.head || !after?.head) {
    return {
      status: "FAIL",
      reason:
        "git could not resolve HEAD; this run cannot name the tree it examined",
    };
  }
  if (before.head !== after.head) {
    return {
      status: "FAIL",
      reason:
        `HEAD moved during the run: ${before.head.slice(0, 8)} then ` +
        `${after.head.slice(0, 8)}; every row above straddles two commits`,
    };
  }
  return { status: "PASS" };
}

/**
 * The short, human-readable stamp for the summary block and evidence line:
 * the commit plus whether the tree carried uncommitted work.
 */
export function formatTreeStamp(state) {
  if (!state?.head) return "UNVERIFIED";
  const dirt = state.dirtyPaths ? `dirty(${state.dirtyPaths})` : "clean";
  return `${state.head.slice(0, 8)} ${dirt}`;
}

/**
 * Read `git rev-parse HEAD` and the porcelain status through `capture`, which
 * takes a command and returns its stdout, or null when it could not run. A
 * repo that cannot answer leaves `head` null, which fails the provenance row:
 * unattributable evidence is the condition this exists to name.
 */
export function readTreeState(capture) {
  const head = capture("git rev-parse HEAD");
  if (head === null) return { head: null, dirtyPaths: null };
  const status = capture("git status --porcelain");
  return {
    head: head.trim(),
    dirtyPaths:
      status === null
        ? null
        : status.split(/\r?\n/).filter((line) => line.trim() !== "").length,
  };
}
