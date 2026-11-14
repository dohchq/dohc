const UNATTRIBUTABLE = "UNATTRIBUTABLE";

/**
 * What gives a checkout a HEAD reflog when it has none, in the order to run it.
 *
 * Enabling the setting writes no entry, so an instruction that stops there
 * sends the reader back into the same refusal. A ref update seeds the log —
 * but only one that CHANGES the value: `git update-ref HEAD <the commit it
 * already names>` writes an entry on a symbolic HEAD and is a no-op on a
 * detached one, which is the state a bisect or a CI checkout leaves. Moving
 * HEAD one commit back and returning writes an entry either way, and
 * `HEAD@{1}` names what HEAD held before the first update, so nothing here
 * needs a shell variable to put it back. Both the refusal and the test that
 * runs these commands read them from here.
 */
export const HEAD_REFLOG_RECOVERY = [
  "git config core.logAllRefUpdates true",
  'git update-ref -m "seed the HEAD reflog" HEAD HEAD~1',
  'git update-ref -m "seed the HEAD reflog" HEAD HEAD@{1}',
];

const short = (head) => head.slice(0, 8);

function unattributable(reason) {
  return { status: "FAIL", reason, stamp: UNATTRIBUTABLE };
}

function changedEntries(before, after) {
  const wasThere = new Set(before);
  const stillThere = new Set(after);
  return [
    ...after.filter((entry) => !wasThere.has(entry)).map((entry) => `appeared ${entry.trim()}`),
    ...before.filter((entry) => !stillThere.has(entry)).map((entry) => `vanished ${entry.trim()}`),
  ];
}

/**
 * Why the HEAD reflog is not the same in two readings, or null when it is.
 *
 * The log only ever grows, so more entries than the reading before means HEAD
 * was updated inside that step. Fewer entries, or the same count with a
 * different newest entry, is a rewritten record — `git gc` expires entries —
 * and a rewritten record cannot say what HEAD did.
 */
function reflogDrift(before, after, during) {
  const gained = after.reflog.count - before.reflog.count;
  if (gained === 0 && after.reflog.top === before.reflog.top) return null;
  const head = short(before.head);
  if (gained <= 0) {
    return (
      `the HEAD reflog was rewritten during \`${during}\` at ${head}: ` +
      `${before.reflog.count} entries then ${after.reflog.count}; this run ` +
      "cannot say what HEAD did inside that step"
    );
  }
  // The entries themselves are not named: reading them back is the unbounded
  // read this deliberately does not do, and the newest one is where HEAD
  // RETURNED to, which the reader already has. The step and the count are what
  // says which rows to re-run.
  return (
    `HEAD was updated ${gained} ${gained === 1 ? "time" : "times"} during ` +
    `\`${during}\` while both readings around it named ${head}, so that step ` +
    "ran against a commit neither reading saw"
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
 * first step, then the state read after each step, labelled with that step.
 *
 * - A tree that moved between two readings fails. The step between them
 *   straddles two trees, so its row describes neither. This covers a HEAD
 *   move and a worktree edit alike. The reason names the step to re-run.
 * - A tree that is already dirty at the first reading does not fail, because
 *   running the gate over uncommitted work is the normal local loop. It is
 *   recorded, so the reader knows the commit does not describe everything
 *   that ran.
 * - A HEAD that moved and returned inside one step fails too. Both readings
 *   name the same commit, so only this checkout's HEAD reflog shows it. A
 *   checkout with no HEAD log of its own is refused, because the fallback
 *   git offers cannot see that switch.
 *
 * Three limits remain.
 * - Nothing observes the tree between two readings. A worktree edit made and
 *   undone inside one step, with no HEAD move, is invisible. The stamp
 *   therefore reports how many readings agreed, not that the run was clean
 *   throughout. Removing this limit needs a checkout nothing else can reach.
 * - A reading lists paths and their status codes, not their contents, so a
 *   second edit to an already dirty path leaves it identical. From a clean
 *   start a pass covers every path. From a dirty start it covers every path
 *   except the ones already listed. The stamp carries `dirty(N)` to show
 *   which.
 * - The named step can be off by one. A reading is taken when the step's own
 *   process exits, so work that outlives it lands in the next interval, and
 *   a skipped optional step takes no reading. The run is refused either way.
 *   The reason names where the change was seen, not always where it was
 *   caused.
 *
 * A gate step can write a tracked file, as `cargo build` does to a stale
 * `Cargo.lock`. That fails this row, correctly, because the step straddled
 * the rewrite. The next run passes, with the lock recorded as dirt.
 */
export function classifyTreeProvenance(readings) {
  if (!Array.isArray(readings) || readings.length < 2) {
    return unattributable(
      `the run took ${Array.isArray(readings) ? readings.length : 0} tree ` +
        "readings; two is the fewest that observes an interval at all",
    );
  }
  if (readings.some((reading) => !reading?.state?.head)) {
    return unattributable("git could not resolve HEAD; this run cannot name the tree it examined");
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
  // This checkout has no HEAD log of its own: `core.logAllRefUpdates` is off,
  // or `logs/HEAD` was removed. `git reflog show HEAD` still answers there —
  // it falls back to the checked-out branch's log, which a checkout away and
  // back leaves untouched — so the check would agree with itself across the
  // switch it exists to catch. Both recovery steps are named: enabling the
  // setting writes no entry, so the log stays absent until a ref update seeds
  // it.
  if (readings.some((reading) => !reading.state.reflog.present)) {
    return unattributable(
      "this checkout keeps no HEAD reflog, so a HEAD that moved and returned " +
        "inside one step would leave no trace; give it one with: " +
        HEAD_REFLOG_RECOVERY.map((command) => `\`${command}\``).join(", then "),
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
  // A reading with no HEAD log of its own is as unread as one git refused: it
  // cannot say whether HEAD moved and came back, so it may not print `clean`.
  if (!state?.head || !state.dirty || !state.reflog?.present) {
    return UNATTRIBUTABLE;
  }
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
 * could not run. `hasHeadLog` answers whether this checkout's HEAD log exists
 * — true, false, or null when its path could not be resolved at all. A repo
 * that cannot answer leaves a field null, which fails the provenance row:
 * unattributable evidence is the condition this exists to name.
 *
 * The reflog is read as a count and a newest entry, never as the whole log.
 * A full read is one command whose output grows without bound — 41 bytes per
 * entry, against the 1 MiB a captured command may return, so a checkout with
 * about 25,000 entries would stop answering and every run in it would be
 * refused. Counting is what the comparison needs. It cannot see a rewrite that
 * preserves both the count and the newest entry, which `git gc` does not do.
 */
export function readTreeState(capture, hasHeadLog) {
  const head = capture("git rev-parse HEAD");
  if (head === null) return { head: null, dirty: null, reflog: null };
  // `--untracked-files=all`, because the default collapses an untracked
  // directory into one entry: `?? crates/newthing/` stays that one string
  // while any number of files inside it are written, edited, or deleted under
  // the run. It also makes the recorded count a count of paths rather than of
  // entries, so `dirty(1)` cannot stand for five hundred files.
  const status = capture("git status --porcelain --untracked-files=all");
  return {
    head: head.trim(),
    dirty: lines(status),
    reflog: readHeadReflog(capture, hasHeadLog),
  };
}

/**
 * How many times HEAD has been updated in THIS checkout, and where it points
 * now — or `{ present: false }` when this checkout keeps no HEAD log.
 *
 * The log's existence is checked first, because `HEAD` is not a reflog name
 * git looks up literally: with `logs/HEAD` absent, `git reflog show HEAD`
 * answers from the checked-out branch's log instead. That log does not move
 * when HEAD is checked out elsewhere and back, so trusting the fallback would
 * let the run pass over the switch this reads for.
 */
function readHeadReflog(capture, hasHeadLog) {
  const present = hasHeadLog();
  if (present === null) return null;
  if (!present) return { present: false, count: 0, top: null };
  const count = capture("git rev-list --walk-reflogs --count HEAD");
  const top = capture("git reflog show --format=%H -n 1 HEAD");
  if (count === null || top === null) return null;
  const entries = Number.parseInt(count.trim(), 10);
  if (!Number.isInteger(entries)) return null;
  // A log file with no entries records nothing, exactly as an absent one does.
  if (entries === 0) return { present: false, count: 0, top: null };
  return { present: true, count: entries, top: top.trim() };
}

function lines(stdout) {
  return stdout === null ? null : stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
}
