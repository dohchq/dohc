// The commit a gate run examined, and whether that claim is trustworthy.
//
// A verdict that cannot name the tree it read is not evidence. Two runs
// sharing one worktree once reported PASS and FAIL for the same commit, and
// neither log could say which tree it had actually examined — the checks had
// straddled a `git checkout` performed by the other run.
//
// The gate reads the tree at every step boundary and this decides what that
// series proves. Reading it twice — once before the run and once after — does
// not: a tree that changes and changes back reads identical at both ends
// while the steps between them ran against something else. Sampling per step
// narrows the unobserved window to one step and names the step that straddled
// a change, which is what a reader needs in order to know what to re-run.
//
// It does NOT make the tree watched. Nothing observes the interval between
// two readings, so the stamp reports how many readings agreed rather than
// claiming the run was clean throughout. A weaker true claim beats a stronger
// unverifiable one. That residual — a change made and undone inside one step,
// which no sample rate removes — is tracked in #644, with what closing it
// would cost.
//
// The classifier is pure so it can be tested without a repository: the gate
// reads the tree state, this decides what those states prove.

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
 * Judge a run's provenance from the tree readings taken across it.
 *
 * `readings` is `[{ step, state }, ...]` in order: the state read before the
 * first step, then the state read after each step, labelled with the step it
 * followed.
 *
 * A tree that MOVED between two readings FAILS — the step between them
 * straddles two trees and its row describes neither. That covers HEAD moving
 * and the worktree being edited, which are one corruption reached two ways.
 * The reason names the step, so a reader knows what to re-run.
 *
 * A tree that is ALREADY dirty at the first reading does NOT fail — running
 * the gate over uncommitted work is the normal local loop, and a check that
 * forbids it just gets removed. It is recorded instead, so the reader knows
 * the commit does not describe everything that ran.
 *
 * Three limits, and none is assumed away.
 *
 * Nothing observes the tree BETWEEN two readings, so a change made and undone
 * inside one step is invisible (#644); that is why the stamp reports how many
 * readings agreed rather than saying the run was clean throughout.
 *
 * A reading is a list of paths and their status codes, not their contents, so
 * a second edit to a path that was already dirty leaves the reading
 * identical. This is why a PASS means two different things: from a clean
 * start it is a claim about paths, and from a dirty start it is that claim
 * about every path except the ones already listed. The stamp carries
 * `dirty(N)` so the difference is on the face of the artifact.
 *
 * The named step can be off by one. A reading is taken when the step's own
 * process exits, so work outliving it lands in the next step's interval and
 * is attributed there, and a skipped optional step takes no reading, so its
 * probe folds into the following one. The verdict is unaffected — the run is
 * refused either way — but the step in the reason is where the change was
 * SEEN, not always where it was caused.
 *
 * The gate's own steps can write tracked files — `cargo build` rewrites a
 * stale `Cargo.lock` — and that FAILS this row, correctly: that step did
 * straddle the rewrite. The next run passes, with the lock recorded as dirt.
 */
export function classifyTreeProvenance(readings) {
  if (!Array.isArray(readings) || readings.length < 2) {
    return unattributable(
      `the run took ${Array.isArray(readings) ? readings.length : 0} tree ` +
        "readings; two is the fewest that observes an interval at all",
    );
  }
  if (readings.some((reading) => !reading?.state?.head)) {
    return unattributable(
      "git could not resolve HEAD; this run cannot name the tree it examined",
    );
  }
  if (readings.some((reading) => !reading.state.dirty)) {
    return unattributable(
      "git could not read the worktree status; this run cannot say whether " +
        "the tree changed under it",
    );
  }

  for (let at = 1; at < readings.length; at += 1) {
    const before = readings[at - 1].state;
    const after = readings[at].state;
    const during = readings[at].step;
    if (before.head !== after.head) {
      return unattributable(
        `HEAD moved during \`${during}\`: ${short(before.head)} then ` +
          `${short(after.head)}; that step and the rows after it straddle ` +
          "two commits",
      );
    }
    const changed = changedEntries(before.dirty, after.dirty);
    if (changed.length > 0) {
      return unattributable(
        `the worktree changed during \`${during}\` at ` +
          `${short(before.head)}: ${nameSome(changed)}; that step straddles ` +
          "two trees",
      );
    }
  }

  return {
    status: "PASS",
    stamp: formatTreeStamp(readings[0].state, readings.length),
  };
}

/**
 * What one reading found: `<sha> clean` or `<sha> dirty(N)`. A state git could
 * not read fully is UNATTRIBUTABLE, never `clean` — an unread worktree and an
 * empty one are not the same claim.
 */
export function formatTreeState(state) {
  if (!state?.head || !state.dirty) return UNATTRIBUTABLE;
  const dirt = state.dirty.length ? `dirty(${state.dirty.length})` : "clean";
  return `${short(state.head)} ${dirt}`;
}

/**
 * The stamp for the summary block and the evidence line. It carries the read
 * count because that is the claim the gate can support: this many readings,
 * spread across the run, agreed. It is not a claim that the tree was watched
 * between them.
 */
export function formatTreeStamp(state, reads) {
  const found = formatTreeState(state);
  return found === UNATTRIBUTABLE ? UNATTRIBUTABLE : `${found}, ${reads} reads`;
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
  // `--untracked-files=all`, because the default collapses an untracked
  // directory into one entry: `?? crates/newthing/` stays that one string
  // while any number of files inside it are written, edited, or deleted under
  // the run. It also makes the recorded count a count of paths rather than of
  // entries, so `dirty(1)` cannot stand for five hundred files.
  const status = capture("git status --porcelain --untracked-files=all");
  return {
    head: head.trim(),
    dirty:
      status === null
        ? null
        : status.split(/\r?\n/).filter((line) => line.trim() !== ""),
  };
}
