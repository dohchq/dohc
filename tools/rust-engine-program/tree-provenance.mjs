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
// Sampling alone cannot see a change made and undone INSIDE one step, and no
// sample rate removes that — between any two readings there is an interval
// nothing observes. For the founding case, git removes it instead: every HEAD
// move is written to the HEAD reflog, so a run that checks out another commit
// and restores it leaves two entries behind while `git rev-parse HEAD` reads
// identical at both ends. A reading carries that log, and a step whose
// bracketing readings agree on the commit but disagree on the reflog is
// refused. The observation is exact and needs no watcher: the record is
// already there when the step returns.
//
// What is left is a worktree edit made and undone inside one step, with no
// HEAD move. Git keeps no record of that, and removing it needs isolation —
// a checkout nothing else can reach — not a faster sample rate. The stamp
// reports how many readings agreed for that reason, rather than claiming the
// run was clean throughout. A weaker true claim beats a stronger unverifiable
// one.
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

/**
 * Why the HEAD reflog is not the same in two readings, or null when it is.
 *
 * The log is newest first, so a run that only moved HEAD forward leaves the
 * earlier reading as the tail of the later one. Anything else — a shorter log,
 * or one whose tail no longer matches — is a rewritten record, and a rewritten
 * record cannot say what HEAD did.
 */
function reflogDrift(before, after, during) {
  const gained = after.reflog.length - before.reflog.length;
  const appended =
    gained >= 0 &&
    after.reflog
      .slice(gained)
      .every((entry, at) => entry === before.reflog[at]);
  if (appended && gained === 0) return null;
  const head = short(before.head);
  if (!appended) {
    return (
      `the HEAD reflog was rewritten during \`${during}\` at ${head}: ` +
      `${before.reflog.length} entries then ${after.reflog.length}, and the ` +
      "later reading does not extend the earlier one; this run cannot say " +
      "what HEAD did inside that step"
    );
  }
  const visited = [...new Set(after.reflog.slice(0, gained).map(short))];
  return (
    `HEAD was updated ${gained} ${gained === 1 ? "time" : "times"} during ` +
    `\`${during}\` and read ${head} at both ends (${nameSome(visited)}); the ` +
    "readings around that step agree about a commit the step did not hold " +
    "throughout"
  );
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
 * A HEAD that moved and RETURNED inside one step is refused too. The two
 * readings around that step name the same commit, so only git's own record
 * shows it: the HEAD reflog gained entries while the commit stayed put.
 *
 * Three limits, and none is assumed away.
 *
 * Nothing observes the tree BETWEEN two readings, so a worktree edit made and
 * undone inside one step, with no HEAD move, is invisible; that is why the
 * stamp reports how many readings agreed rather than saying the run was clean
 * throughout. Removing it needs a checkout nothing else can reach.
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
  if (readings.some((reading) => !reading.state.reflog)) {
    return unattributable(
      "git could not read the HEAD reflog; this run cannot say whether HEAD " +
        "moved and returned inside a step",
    );
  }
  // An empty reflog beside a HEAD that resolves means this repository keeps no
  // record of HEAD moves — `core.logAllRefUpdates` is off, or `.git/logs/HEAD`
  // was removed. The check below would then read the same on every run, which
  // is the shape of a check that is switched off rather than passing.
  if (readings.some((reading) => reading.state.reflog.length === 0)) {
    return unattributable(
      "this repository keeps no HEAD reflog, so a HEAD that moved and " +
        "returned inside one step would leave no trace; turn the record on " +
        "with `git config core.logAllRefUpdates true`",
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
    const returned = reflogDrift(before, after, during);
    if (returned) return unattributable(returned);
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
  if (!state?.head || !state.dirty || !state.reflog) return UNATTRIBUTABLE;
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
 * Read `git rev-parse HEAD`, the porcelain status, and the HEAD reflog through
 * `capture`, which takes a command and returns its stdout, or null when it
 * could not run. A repo that cannot answer leaves a field null, which fails
 * the provenance row: unattributable evidence is the condition this exists to
 * name.
 */
export function readTreeState(capture) {
  const head = capture("git rev-parse HEAD");
  if (head === null) return { head: null, dirty: null, reflog: null };
  // `--untracked-files=all`, because the default collapses an untracked
  // directory into one entry: `?? crates/newthing/` stays that one string
  // while any number of files inside it are written, edited, or deleted under
  // the run. It also makes the recorded count a count of paths rather than of
  // entries, so `dirty(1)` cannot stand for five hundred files.
  const status = capture("git status --porcelain --untracked-files=all");
  // One line per HEAD reflog entry, newest first, each the commit HEAD pointed
  // at after that move. A checkout away and back reads identical through
  // `rev-parse` and adds two lines here, which is the only trace it leaves.
  const reflog = capture("git reflog show --format=%H HEAD");
  return {
    head: head.trim(),
    dirty: lines(status),
    reflog: lines(reflog),
  };
}

/** A command's stdout as non-blank lines, or null when it did not answer. */
function lines(stdout) {
  return stdout === null
    ? null
    : stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
}
