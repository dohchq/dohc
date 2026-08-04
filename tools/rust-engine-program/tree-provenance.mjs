// The commit a gate run examined, and whether that claim is trustworthy.
//
// A verdict that cannot name the tree it read is not evidence. Two runs
// sharing one worktree once reported PASS and FAIL for the same commit, and
// neither log could say which tree it had actually examined — the checks had
// straddled a `git checkout` performed by the other run.
//
// The classifier is pure so it can be tested without a repository: the gate
// reads the tree state, this decides what that state proves.

const UNATTRIBUTABLE = "UNATTRIBUTABLE";

const short = (head) => head.slice(0, 8);

function unattributable(reason) {
  // A run that cannot name its tree must not print a stamp that names one.
  // The stamp and the judgement come from the same call for that reason: a
  // reader who trusts `<sha> clean` beside a FAIL row is reading the defect
  // this module exists to catch.
  return { status: "FAIL", reason, stamp: UNATTRIBUTABLE };
}

/** The `git status` entries that appeared or vanished between two readings. */
function changedEntries(before, after) {
  const wasThere = new Set(before);
  const stillThere = new Set(after);
  return [
    ...after
      .filter((entry) => !wasThere.has(entry))
      .map((entry) => `appeared ${entry.trim()}`),
    ...before
      .filter((entry) => !stillThere.has(entry))
      .map((entry) => `vanished ${entry.trim()}`),
  ];
}

function nameSome(entries) {
  const named = entries.slice(0, 3).join(", ");
  const rest = entries.length - 3;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/**
 * Judge a run's provenance from the tree state read before and after it.
 *
 * HEAD moving mid-run FAILS: the rows above it straddle two commits and
 * describe neither. The worktree changing mid-run FAILS for the same reason —
 * the checks read two different trees at one commit, which is the corruption
 * this row exists to name, and a stamp of `<sha> clean` over it would be worse
 * than no stamp at all.
 *
 * A tree that is ALREADY dirty when the run starts does NOT fail — running the
 * gate over uncommitted work is the normal local loop, and a check that
 * forbids it just gets removed. It is recorded instead, so the reader knows
 * the commit does not describe everything that ran.
 *
 * The comparison reads `git status --porcelain` entries, so it sees a path
 * appear, vanish, or change its status code. It does not see a second edit to
 * a path that was already dirty before the run — and there it is the stamp
 * that keeps the claim honest: such a run is stamped `dirty(N)`, which already
 * says the commit does not describe what ran. The gate never stamps `clean`
 * over a tree it watched change.
 *
 * The gate's own steps can write tracked files — `cargo build` rewrites a
 * stale `Cargo.lock` — and that FAILS this row, correctly: those checks did
 * straddle the rewrite. The next run passes, with the lock recorded as dirt.
 */
export function classifyTreeProvenance(before, after) {
  if (!before?.head || !after?.head) {
    return unattributable(
      "git could not resolve HEAD; this run cannot name the tree it examined",
    );
  }
  if (before.head !== after.head) {
    return unattributable(
      `HEAD moved during the run: ${short(before.head)} then ` +
        `${short(after.head)}; every row above straddles two commits`,
    );
  }
  if (!before.dirty || !after.dirty) {
    return unattributable(
      "git could not read the worktree status; this run cannot say whether " +
        "the tree changed under it",
    );
  }
  const changed = changedEntries(before.dirty, after.dirty);
  if (changed.length > 0) {
    return unattributable(
      `the worktree changed during the run at ${short(before.head)}: ` +
        `${nameSome(changed)}; the checks straddle two trees`,
    );
  }
  return { status: "PASS", stamp: formatTreeStamp(before) };
}

/**
 * The short, human-readable stamp for the summary block and evidence line:
 * the commit plus whether the tree carried uncommitted work. A state git could
 * not read fully is UNATTRIBUTABLE, never `clean` — an unread worktree and an
 * empty one are not the same claim.
 */
export function formatTreeStamp(state) {
  if (!state?.head || !state.dirty) return UNATTRIBUTABLE;
  const dirt = state.dirty.length ? `dirty(${state.dirty.length})` : "clean";
  return `${short(state.head)} ${dirt}`;
}

/**
 * Read `git rev-parse HEAD` and the porcelain status through `capture`, which
 * takes a command and returns its stdout, or null when it could not run. A
 * repo that cannot answer leaves `head` or `dirty` null, which fails the
 * provenance row: unattributable evidence is the condition this exists to
 * name.
 */
export function readTreeState(capture) {
  const head = capture("git rev-parse HEAD");
  if (head === null) return { head: null, dirty: null };
  const status = capture("git status --porcelain");
  return {
    head: head.trim(),
    dirty:
      status === null
        ? null
        : status.split(/\r?\n/).filter((line) => line.trim() !== ""),
  };
}
