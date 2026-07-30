---
name: pr-review-watch
description: Watch open PRs for bot review rounds (codex, CodeRabbit) without going silent, and decide whether a PR's CURRENT head has actually been reviewed before merging. Use when you open or push to a PR, when a review seems slow or a trigger may not have taken, and always immediately before merging.
---

# PR review: never silent, and never "reviewed" by assumption

CI is dispatch-only in this repo (see AGENTS.md), so bot review is a real gate.
A watcher that misses a round means merging unreviewed code — and a watcher that
*mislabels* a round is worse, because it manufactures false confidence.

## Two jobs, deliberately separated

The biggest design mistake here is one thing that both watches and judges. Early
versions did that, and nearly every bug landed in the judging half: a
`CHANGES_REQUESTED` read as a pass, one reviewer's findings attributed to
another, and a shared coverage flag that disabled the very timeout it guarded.

| job | how | why |
|---|---|---|
| **Notice** something happened | background watcher reporting any advance in bot activity | cheap, nearly impossible to get wrong, cannot be silent |
| **Judge** whether the head is reviewed | `review_status <PR>`, on demand | synchronous, you read the output, so it cannot silently cache a wrong answer |

The watcher deliberately does **not** decide whether a PR is reviewed. It tells
you to go look. `review_status` decides, at the moment you need the answer.

## Facts that break naive implementations

**A bot review is not always a review object.**

| bot | outcome | where it lands |
|---|---|---|
| codex | has findings | a **review** with `state: COMMENTED` — *not* `CHANGES_REQUESTED` — plus inline comments |
| codex | **no findings** | an **issue comment** reading "Didn't find any major issues", carrying `**Reviewed commit:** <short-sha>` |
| codex | **cannot run** | an issue comment reading "To use Codex here, create an environment for this repo" — re-posting the trigger will never fix this |
| CodeRabbit | reviewed | a **review** with `state`. This is the *only* proof it reviewed |
| CodeRabbit | received a head | one **status comment it edits in place**: `between <base-sha> and <head-sha>`, both **full 40-char** |
| CodeRabbit | still working | that same comment reading "Currently processing new changes in this PR" |
| CodeRabbit | rate-limited | that same comment containing "Review limit reached" |
| CodeRabbit | internal error | that same comment containing "Review failed" |
| CodeRabbit | **rate-limited** | **also a commit status of `state=success`**, description "Review rate limited" — a **green check** in the UI for a head it did not review |

**That green check is the worst trap on this surface.** On a rate-limited head CodeRabbit
reports `success` to the commit-status API with the description `Review rate limited`,
so the PR page shows a passing CodeRabbit check next to zero reviews. Glance at the
checks and you conclude it approved. Read the *description*, or read `pulls/N/reviews`,
and you find it never looked. `review_status` prints that description whenever
CodeRabbit has no review of the head, precisely so the green tick cannot stand
unqualified.

**The status comment proves receipt, not coverage — and I got this backwards once.**
Watching a markdown-only PR through five heads that produced zero entries in
`pulls/N/reviews`, I concluded CodeRabbit often reviews without creating a review
object, and taught the judge to accept the status comment as coverage. That was an
artifact of watching it while **rate-limited**. It later produced both `APPROVED`
and `CHANGES_REQUESTED` on that same PR. CodeRabbit writes `between X and Y` when it
**receives** a head, before doing any work.

So: **CodeRabbit coverage means a review object at this commit. Nothing else counts.**
Two live PRs had the status comment naming their head with zero reviews ever produced;
accepting that as coverage returns `OK` on genuinely unreviewed code. Use the status
comment only to explain *why* a review is missing.

**What keeps a rate limit from blocking the PR forever is the ORDER, not the scoping.**
The rate-limit wrapper and its help text (`your plan's rate limits`, `How do review
limits work?`) never leave the comment once added — and since CodeRabbit keeps *one*
comment that it edits to name the current head, the comment you scope to *is* the one
holding the permanent wrapper. Scoping cannot help with that. Only consulting the
status comment **when no review of this head exists** does. #317 is the proof: its
head-scoped comment matches "Review limit reached" for a head CodeRabbit
**approved** — get the order wrong and you reject a genuinely reviewed PR forever.

Scoping to the head-naming comment is still right, for a smaller reason: it keeps the
"received this head" claim honest when CodeRabbit never got this head at all.

CodeRabbit is also incremental and says so: *"does not re-review already reviewed
commits."* An explicit `@coderabbitai review` on an unchanged head returns
"Action performed: Review finished" seconds later without doing new work. That is an
acknowledgement that a *command* arrived. It is never evidence a review happened.

So `pulls/N/reviews` being empty says **nothing** about whether the code was
reviewed — a clean codex pass leaves that endpoint untouched. And a *populated*
`reviews` entry says nothing about whether the code **passed**: codex files real
findings under `COMMENTED`, so keying "blocked" off `CHANGES_REQUESTED` alone
green-lights a head with unresolved findings.

**Other traps, each of which produced a wrong answer in practice:**

- `gh api --jq` does **not** accept `--arg`. That is a standalone-`jq` flag, and
  `jq` is not installed here. It exits 1 printing nothing, which under
  `2>/dev/null` reads exactly like "no matches" — a false negative shaped like a
  real answer. Embed values: `--jq ".[]|select(.x==\"$v\")"`.
- codex writes the **10-char short SHA** in `Reviewed commit:`, while
  `headRefOid` is the full 40. `contains(full_sha)` never matches.
- `gh api` pages at 30 by default, and so does **`gh pr list`**. Without
  `--paginate` / `--limit` the current head's review, or a whole PR, is invisible.
- **`--paginate` runs the `--jq` program once per page and concatenates the
  output.** So an aggregate like `[.[]|select(…)]|length` returns *one count per
  page* — `"0\n0"` past 100 items. `[ "$x" -eq 0 ]` then dies with
  `integer expression expected`, which in an `if` reads as false, i.e. "answered",
  and the whole timeout branch is skipped. Emit one line per match and count lines.
- **Bot comment bodies quote the trigger verbatim** — codex's clean-pass text
  contains `Comment "@codex review".` — so a naive trigger search matches bot
  boilerplate, drags the round baseline past reviews that already landed, and
  invents a missed round. Require a human author and a bare, standalone comment.
- **CodeRabbit edits one status comment in place** instead of appending, so its
  `created_at` stays behind every later round. The activity scan must read
  `updated_at` or a whole round of progress is invisible to it.
- **Coverage must not be filtered by timestamp at all.** A review of *this commit*
  is coverage whichever round produced it. Filtering on the round baseline meant a
  watcher **restart** — which resets first-observation to now — discarded every
  existing review of the current head and raised a false alarm 25 minutes later.
- **A commit's committer date is not when the PR received it.** Cutting a branch
  from an older commit makes a push-time deadline fire on the first poll.
- **Zero findings is not a pass.** `CHANGES_REQUESTED` can carry its entire
  explanation in the review body with no inline comments at all.
- GitHub **re-anchors** older inline comments onto a new `commit_id` (see
  `docs/superpowers/plans/rust-engine/SESSION_HANDOFF.md:948-950`). Count by
  `pull_request_review_id`, not by commit, or you over-count.
- `gh pr list --state open` output is **newline**-delimited — `case " $list " in
  *" $n "*)` never matches and spams false closure every cycle.
- A failing query is **not** an empty result. Treat failure as *unknown*, never as
  "no reviews", or a transient blip fires a false alarm — or exits the watcher.

## The watcher — notices, does not judge

Run via `Monitor` with `persistent: true`, extracting it from this file at launch.
Use this launcher, not a bare `bash <(awk …)` — the point is that silence can never be
ambiguous, and a bare process substitution of an empty extraction exits instantly
while looking armed:

```
S="$(git rev-parse --show-toplevel)/skills/pr-review-watch/SKILL.md"
W=$(mktemp -t live-watcher.XXXXXX)   # NOT a fixed name: two sessions launching at
trap 'rm -f "$W"' EXIT               # once would overwrite each other's script
awk '/^```bash$/{f=1;n++;next} /^```$/{f=0} f&&n==1{print}' "$S" > "$W"
[ -s "$W" ] || { echo "WATCHER CANNOT START — empty extraction from $S"; exit 1; }
bash -n "$W" || { echo "WATCHER CANNOT START — extracted script does not parse"; exit 1; }
echo "WATCHER ARMED from $S ($(wc -l < "$W") lines)"
bash "$W"
echo "WATCHER EXITED unexpectedly (rc=$?) — no longer watching"
```

If you add invariant checks (say, that a recent fix is present in the extraction),
make them **warn and start anyway**. A guard that refuses to start converts a
staleness worry into a total outage: one of mine had an unmatchable `grep -F` pattern
and took the watcher down for several minutes, which is strictly worse than running
slightly stale logic.

Extraction guarantees the running process matches this file **at the moment it
started**, not forever. **Whenever you edit block 1, restart the watcher** — otherwise a process that
looks armed is running logic you already fixed, which is how a corrected watcher stayed
silent about a rate-limited reviewer for another half hour. Diff to be sure rather than
guessing:

```
git show <prev>:SKILL.md | awk '…n==1…' > /tmp/old.sh
awk '…n==1…' SKILL.md > /tmp/new.sh
diff -q /tmp/old.sh /tmp/new.sh || echo "restart the watcher"
```

Also read from a path **only you control** — a worktree, not a shared checkout. A
concurrent session switching branches in a shared tree deleted this file out from under
a running watcher, the extraction produced nothing, and `bash` of an empty script exited
instantly: a monitor that reported nothing because it was dead. Make the launcher check
the file is non-empty and `bash -n` the extracted script, print a line when it arms, and
print a line if it ever exits, so silence can never be ambiguous.

```bash
REPO=dohc-ai/dohc
DEADLINE_MIN=25
CODEX="chatgpt-codex-connector[bot]"
RABBIT="coderabbitai[bot]"
CLEAN="didn.t find any major issues|no major issues"

declare -A high seen watched firstseen qn
fails=0

# Repeat, don't fire once. A key that is set and never cleared means a persistent
# outage produces one line and then indefinite silence while nothing is verified —
# the anti-silence tool going silent during exactly the outage it exists to expose.
note() {
  local k="$1"; shift
  qn[$k]=$(( ${qn[$k]:-0} + 1 ))
  [ $(( ${qn[$k]} % 3 )) -eq 1 ] && echo "$* (${qn[$k]}x)"
}
clear_note() { unset "qn[$1]"; }

# Clearing only watched[] on closure leaves high/firstseen/seen/qn behind. If the PR
# is reopened at the same head, the stale seen key suppresses every timeout and the
# stale activity watermark suppresses the first notice — a reopened PR that is watched
# in name only. Every per-PR key is prefixed "$n|" so one sweep clears all of it.
forget_pr() {
  local p="$1" k
  unset "watched[$p]" "high[$p]"
  for k in "${!firstseen[@]}"; do case "$k" in "$p|"*) unset "firstseen[$k]";; esac; done
  for k in "${!seen[@]}";      do case "$k" in "$p|"*) unset "seen[$k]";;      esac; done
  for k in "${!qn[@]}";        do case "$k" in "$p|"*) unset "qn[$k]";;        esac; done
}

# Newest bot event across all three endpoints, into ACTIVITY_LATEST, plus
# ACTIVITY_OK = how many of the three queries succeeded, so a dead endpoint
# cannot read as quiet. Both are globals and the caller must NOT wrap this in
# `$(...)`: command substitution runs a subshell, which would discard them.
newest_bot_event() {
  local out="" part ep
  ACTIVITY_OK=0
  for ep in "pulls/$1/reviews" "pulls/$1/comments" "issues/$1/comments"; do
    # updated_at before created_at: CodeRabbit can complete a whole round by
    # EDITING its status comment, whose created_at never moves. Reading created_at
    # means ACTIVITY_LATEST never advances, so the watcher emits neither
    # BOT ACTIVITY nor (once the edit satisfies coverage) NO REVIEW — silence.
    if part=$(gh api "repos/$REPO/$ep" --paginate \
                --jq '.[]|select(.user.type=="Bot")|(.submitted_at // .updated_at // .created_at)' 2>/dev/null); then
      ACTIVITY_OK=$((ACTIVITY_OK+1))
      out=$(printf '%s\n%s\n' "$out" "$part")
    fi
  done
  ACTIVITY_LATEST=$(printf '%s\n' "$out" | grep -v '^$' | sort | tail -1)
}

# Never skip a reviewer on a failed query without saying so. A silent `continue`
# means no timeout AND no notice, which is the single outcome this watcher exists
# to prevent.
qfail() {
  note "$1|qf|$3|$4" "QUERY FAILED #$1 @$2 — the $4 query for $3 errored; coverage is UNKNOWN, not clear"
}

while true; do
  if ! prs=$(gh pr list --repo "$REPO" --state open --limit 200 --json number --jq '.[].number' 2>/dev/null); then
    fails=$((fails+1))
    # Re-announce every third failure. Alerting only at exactly 3 means a
    # persistent outage produces one line and then indefinite silence, while
    # nothing at all is being watched.
    [ $((fails % 3)) -eq 0 ] && echo "DISCOVERY FAILING — gh pr list errored ${fails}x; watcher alive, results are stale"
    sleep 120; continue
  fi
  fails=0

  for n in "${!watched[@]}"; do
    printf '%s\n' "$prs" | grep -qx "$n" && continue
    st=$(gh pr view "$n" --repo "$REPO" --json state --jq .state 2>/dev/null) || st="UNKNOWN"
    echo "PR #$n is $st — stopped watching"
    forget_pr "$n"
  done

  for n in $prs; do
    watched[$n]=1
    # A failing head query must not silently drop the PR: other PRs keep printing
    # normal output, which conceals that this one has no coverage checked at all.
    # An EMPTY head is as dangerous as a failed query: it turns contains("") into a
    # match against every historical comment, so a PR with any past bot activity
    # looks reviewed.
    if ! head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) || [ -z "$head" ]; then
      note "$n|hq" "HEAD QUERY FAILING #$n — cannot resolve its head; this PR is UNCHECKED, not clear"
      continue
    fi
    clear_note "$n|hq"
    short=${head:0:10}

    newest_bot_event "$n"
    if [ "${ACTIVITY_OK:-0}" -lt 3 ]; then
      note "$n|deg" "PARTIAL VIEW #$n @$short — only ${ACTIVITY_OK:-0}/3 activity queries succeeded; quiet here may mean broken, not idle"
    else
      clear_note "$n|deg"
    fi
    if [ -n "$ACTIVITY_LATEST" ] && [ "$ACTIVITY_LATEST" != "${high[$n]:-}" ]; then
      high[$n]=$ACTIVITY_LATEST
      echo "BOT ACTIVITY #$n @$short — newest event $ACTIVITY_LATEST — run: review_status $n"
    fi

    # Deadlines run from when WE first saw this head, never from the commit's
    # committer date — that is when it was authored, so a branch cut from an
    # older commit would alert on the first poll, before the bots had the PR.
    fk="$n|$short"
    [ -n "${firstseen[$fk]:-}" ] || firstseen[$fk]=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    for who in "$CODEX" "$RABBIT"; do
      # ANSWERED means the head is covered, never that a bot acknowledged something.
      # codex needs the short SHA *and* the clean-pass phrase. CodeRabbit gets NO
      # comment shape at all: its status comment is written when it RECEIVES a head,
      # its "Review finished" is a reply to a command, and a rate limit means the
      # round did not complete — which is precisely when the alert must fire. Its
      # only proof of coverage is a review object, handled below.
      case "$who" in
        "$CODEX") pat="@codex review"
                  ans="(.body|contains(\"$short\")) and (.body|test(\"$CLEAN\";\"i\"))" ;;
        *)        pat="@coderabbitai review"
                  ans="false" ;;
      esac

      # Each reviewer's round starts at ITS OWN newest trigger, and the trigger
      # must come from a HUMAN and be bare. Bot bodies quote the trigger verbatim
      # ('Comment "@codex review".'), so matching those walks the baseline forward
      # past reviews that already landed and invents a missed round — which then
      # tells you to post another trigger, which advances it again.
      # Capture output and status separately: in `gh api … | sort | tail` the
      # pipeline reports tail's status, so a failed query looks like "no trigger"
      # and quietly drags the baseline back to first-observation.
      if ! raw=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
              --jq ".[]|select(.user.type!=\"Bot\")|select(.body|test(\"^[[:space:]]*$pat[[:space:]]*\$\"))|.created_at" 2>/dev/null); then
        qfail "$n" "$short" "$who" trigger; continue
      fi
      trig=$(printf '%s' "$raw" | grep -v '^$' | sort | tail -1)
      base=$(printf '%s\n%s\n' "${firstseen[$fk]}" "$trig" | grep -v '^$' | sort | tail -1)

      # NO timestamp filter on coverage. A review of THIS COMMIT is coverage
      # whichever round produced it — filtering on the round baseline meant that
      # restarting the watcher (which resets firstseen to now) threw away every
      # existing review of the current head and raised a false NO REVIEW 25
      # minutes later. The baseline governs only WHEN to complain, not what counts.
      #
      # Count by LINES, never with a jq `|length` aggregate: --paginate runs the jq
      # program once per page and concatenates, so an aggregate yields one number
      # per page. "0\n0" then makes `[ -eq 0 ]` fail with an integer-expression
      # error, which reads as "answered" and skips the timeout entirely.
      # Only TERMINAL states count as coverage. A DISMISSED or PENDING review is
      # not a statement about the code, and counting it would suppress the timeout
      # for a round that never completed — and would make the watcher disagree with
      # review_status, which rejects those states.
      if ! rows=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
            --jq ".[]|select(.commit_id==\"$head\" and .user.login==\"$who\" and (.state==\"APPROVED\" or .state==\"CHANGES_REQUESTED\" or .state==\"COMMENTED\"))|.id" 2>/dev/null); then
        qfail "$n" "$short" "$who" reviews; continue
      fi
      answered=$(printf '%s' "$rows" | grep -c . || true)
      if [ "$answered" -eq 0 ] && [ "$ans" != false ]; then
        if ! rows=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
              --jq ".[]|select(.user.login==\"$who\")|select($ans)|.id" 2>/dev/null); then
          qfail "$n" "$short" "$who" comments; continue
        fi
        answered=$(printf '%s' "$rows" | grep -c . || true)
      fi
      clear_note "$n|qf|$who|reviews"; clear_note "$n|qf|$who|comments"; clear_note "$n|qf|$who|trigger"
      [ "$answered" -eq 0 ] || continue

      age=$(( ( $(date -u +%s) - $(date -u -d "$base" +%s) ) / 60 ))
      [ "$age" -ge "$DEADLINE_MIN" ] || continue
      # The key carries the round baseline, so a SECOND failed trigger on an
      # unchanged head still alerts instead of being suppressed as already-seen.
      # Don't prescribe a remedy the watcher cannot diagnose: a re-trigger is
      # useless against a rate limit, and useless against codex lacking an
      # environment. Point at the judge, which knows which case this is.
      k="$n|to|$short|$who|$base"
      [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "NO REVIEW #$n @$short from $who after ${age}m of this round — run: review_status $n"; }
    done
  done
  sleep 120
done
```

Two more shapes worth naming, both of which were real defects:

- Discovery checks the **exit status**, because an empty list from a failed query
  once made this watcher exit permanently on one transient blip — the anti-stall
  tool stalling.
- Coverage and timeouts are **per reviewer**. A shared flag let one reviewer
  answering mask another's trigger failing, and since CodeRabbit reviews nearly
  every head, that disabled the codex timeout almost always.

## `review_status` — judges, on demand

It is a shell function in a Markdown file, so `source SKILL.md` cannot work. Extract
it the same way the watcher is extracted, then call it:

```
S="$(git rev-parse --show-toplevel)/skills/pr-review-watch/SKILL.md"
R=$(mktemp -t review_status.XXXXXX)   # not a fixed name: concurrent sessions
awk '/^```bash$/{f=1;n++;next} /^```$/{f=0} f&&n==2{print}' "$S" > "$R"

# Drop any definition already in scope FIRST. A failed extraction must not leave
# a stale review_status callable — it would answer with superseded gate logic and
# look exactly like a fresh verdict.
unset -f review_status 2>/dev/null

# The guards must PREVENT the source and the call, not just announce a problem.
# Printing and falling through is how you get a verdict from the wrong function.
if [ -s "$R" ] && bash -n "$R"; then
  . "$R"
  review_status 371
else
  echo "review_status NOT AVAILABLE — extraction from $S was empty or does not parse"
fi
```

(This block is deliberately fenced as plain ``` rather than ```bash: the extraction
counts `bash` blocks, so making this one of them would renumber the very block it is
trying to fetch. Block 1 is the watcher, block 2 is `review_status`.)

Run it before merging, and whenever the watcher says to look.

```bash
review_status() {
  local REPO=dohc-ai/dohc n="$1"
  local CODEX="chatgpt-codex-connector[bot]" RABBIT="coderabbitai[bot]"
  local CLEAN="didn.t find any major issues|no major issues"
  local DEGRADED="Review limit|rate limit|Review failed"
  local head short rows lines rid st cnt blen who body cbody envt newest now crs verdict=OK
  local blocked=0 findings=0 unknown=0 unreviewed=0 pending=0

  [ -n "$n" ] || { echo "review_status: no PR number given"; return 2; }
  head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid) \
    || { echo "PR #$n — head query FAILED, verdict UNKNOWN"; return 2; }
  # An empty head would turn every filter below into contains(""), matching all
  # history and making an unresolved head look reviewed.
  [ -n "$head" ] || { echo "PR #$n — head resolved EMPTY, verdict UNKNOWN"; return 2; }
  short=${head:0:10}
  echo "PR #$n head $short"

  for who in "$CODEX" "$RABBIT"; do
    if ! rows=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
          --jq ".[]|select(.commit_id==\"$head\" and .user.login==\"$who\")|\"\(.submitted_at) \(.id) \(.state)\"" 2>/dev/null); then
      echo "  $who — reviews query FAILED, coverage UNKNOWN"; unknown=1; continue
    fi

    if [ -n "$rows" ]; then
      # The NEWEST review decides. A reviewer can leave a stale CHANGES_REQUESTED
      # and later clear the round on the same head, and findings from a superseded
      # review are equally stale — so earlier rows are history, printed but not
      # counted. ISO timestamps sort lexicographically, so `sort` is chronological.
      newest=$(printf '%s\n' "$rows" | sort | tail -1)
      printf '%s\n' "$rows" | sort | head -n -1 | while read -r _ rid st; do
        [ -n "$rid" ] && echo "  $who review $rid [$st] — superseded by a later review of this head"
      done
      while read -r _ rid st; do
        [ -n "$rid" ] || continue
        # Count only comments belonging to THIS review — GitHub re-anchors older
        # inline comments onto new commits, so counting by commit over-counts.
        # And count LINES, not with a jq `|length`: under --paginate the program
        # runs per page, so an aggregate returns one number per page.
        if ! lines=$(gh api "repos/$REPO/pulls/$n/comments" --paginate \
              --jq ".[]|select(.pull_request_review_id==$rid)|.id" 2>/dev/null); then
          echo "  $who review $rid [$st] — inline-count query FAILED, UNKNOWN"; unknown=1; continue
        fi
        cnt=$(printf '%s' "$lines" | grep -c . || true)
        if ! blen=$(gh api "repos/$REPO/pulls/$n/reviews/$rid" --jq '.body|length' 2>/dev/null); then
          echo "  $who review $rid [$st] — body query FAILED, UNKNOWN"; unknown=1; continue
        fi
        echo "  $who review $rid [$st] — ${cnt:-0} inline, body ${blen:-0} chars (newest)"
        case "$st" in
          CHANGES_REQUESTED) blocked=1 ;;
          APPROVED)
            # Not just a warning: the function is usable as a scripted gate, so an
            # approval carrying inline comments must still fail it.
            if [ "${cnt:-0}" -gt 0 ]; then
              echo "    ^ APPROVED yet ${cnt} inline comment(s) — read them; this is not a clean pass"
              findings=1
            fi ;;
          COMMENTED)
            if [ "${cnt:-0}" -gt 0 ] || [ "${blen:-0}" -gt 0 ]; then
              echo "    ^ COMMENTED carrying ${cnt:-0} inline / ${blen:-0}-char body — these are findings, not a pass"
              findings=1
            fi ;;
          *)
            # DISMISSED, PENDING, or a state GitHub adds later: not a statement
            # about the code, so it proves no coverage.
            echo "    ^ state $st is not a terminal review — proves nothing about this head"
            unreviewed=1 ;;
        esac
      done <<<"$newest"
      continue
    fi

    # codex records a CLEAN pass as an issue comment, not a review. Capture before
    # grepping: a pipeline's status is grep's, so a failed query would read as
    # "no clean pass" and be reported as a missing review instead of UNKNOWN.
    if [ "$who" = "$CODEX" ]; then
      if ! cbody=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
            --jq ".[]|select(.user.login==\"$CODEX\")|select(.body|contains(\"$short\"))|.body" 2>/dev/null); then
        echo "  $who — clean-pass query FAILED, coverage UNKNOWN"; unknown=1; continue
      fi
      if printf '%s' "$cbody" | grep -qiE "$CLEAN"; then
        echo "  $who — CLEAN PASS (issue comment naming $short)"
        continue
      fi
      # The "cannot run" reply names NO sha, so it can never appear in the
      # sha-scoped body above — query it separately or the branch is dead code.
      # It is intermittent: the same PR got three of these interleaved with five
      # successful reviews, so report it with its timestamp as a reason a trigger
      # may not have taken, never as a verdict.
      if envt=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
            --jq ".[]|select(.user.login==\"$CODEX\")|select(.body|test(\"create an environment for this repo\"))|.created_at" 2>/dev/null) \
         && [ -n "$envt" ]; then
        echo "  $who — note: it replied \"create an environment for this repo\" on this PR (latest $(printf '%s' "$envt" | sort | tail -1)); if a round seems missing, check first whether the head was superseded"
      fi
    fi

    # No review object means CodeRabbit has NOT covered this head. Its status
    # comment is written when it RECEIVES a head, so it can never prove completion
    # — read it only to explain WHY the review is missing, scoped to the comment
    # that names this head, since the rate-limit wrapper is permanent once added.
    if [ "$who" = "$RABBIT" ]; then
      if ! body=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
            --jq ".[]|select(.user.login==\"$RABBIT\")|select(.body|contains(\"$head\"))|.body" 2>/dev/null); then
        echo "  $who — status-comment query FAILED, coverage UNKNOWN"; unknown=1; continue
      fi
      # Surface CodeRabbit's COMMIT STATUS too: on a rate-limited head it reports
      # state=success with description "Review rate limited", so the PR page shows a
      # green CodeRabbit check for a head it never reviewed. Say so out loud.
      crs=$(gh api "repos/$REPO/commits/$head/status" \
              --jq '.statuses[]?|select(.context=="CodeRabbit")|"\(.state): \(.description)"' 2>/dev/null | tail -1)
      [ -n "$crs" ] && echo "  $who — its commit status says \"$crs\" — a green check here does NOT mean it reviewed"
      if [ -n "$body" ]; then
        # DEGRADED is tested FIRST: the wrapper is permanent, so a rate-limited
        # comment often still carries processing text, and reporting "just wait"
        # for a round that is actually blocked sends you to wait forever.
        if printf '%s' "$body" | grep -qiE "$DEGRADED"; then
          echo "  $who — NO REVIEW of this head; rate-limited or failed — its silence is NOT approval"
          unreviewed=1
        elif printf '%s' "$body" | grep -qiE "currently processing|review in progress"; then
          echo "  $who — NO REVIEW of this head; it says it is still processing — wait, do not re-trigger"
          pending=1
        else
          echo "  $who — NO REVIEW of this head; it acknowledged receiving $short but filed no review"
          unreviewed=1
        fi
        continue
      fi
    fi

    echo "  $who — NO REVIEW of this head"
    unreviewed=1
  done

  # The head can move while these queries run — this repo has concurrent sessions,
  # and this function is the synchronous pre-merge gate, so a stale OK is the one
  # answer that must never happen. Re-read the head and void the result if it moved.
  # A failed or empty re-read is NOT confirmation that the head held still. Skipping
  # the check on failure would let reviews of the old head produce OK unverified,
  # which is the same mistake as treating a failed query as "no reviews".
  if ! now=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) \
     || [ -z "$now" ]; then
    echo "  HEAD RE-CHECK FAILED — cannot confirm $short is still the head; verdict VOID"
    return 2
  fi
  if [ "$now" != "$head" ]; then
    echo "  HEAD MOVED during the check ($short -> ${now:0:10}) — verdict VOID, run it again"
    return 2
  fi

  if   [ "$blocked"    = 1 ]; then verdict=BLOCKED
  elif [ "$unknown"    = 1 ]; then verdict=UNKNOWN
  elif [ "$unreviewed" = 1 ]; then verdict=UNREVIEWED
  elif [ "$findings"   = 1 ]; then verdict=FINDINGS
  elif [ "$pending"    = 1 ]; then verdict=PENDING
  fi
  echo "  VERDICT: $verdict"
  [ "$verdict" = OK ]
}
```

| verdict | meaning |
|---|---|
| `OK` | both reviewers covered this head and neither left findings |
| `BLOCKED` | a `CHANGES_REQUESTED` on this head |
| `FINDINGS` | a review of this head carries inline comments or a body — unresolved work, even though its state is only `COMMENTED` |
| `UNREVIEWED` | a required reviewer filed no review of this head — including when it acknowledged receiving it, hit a rate limit, or (codex) cannot run on this repo at all |
| `PENDING` | CodeRabbit filed no review but says it is still processing this head — wait rather than re-trigger |
| `UNKNOWN` | a query failed — decide nothing |

It returns non-zero unless the verdict is `OK`, so it can gate a script. Note
what `FINDINGS` implies about the loop: findings never disappear from the API, so
the only way to reach `OK` is to push fixes — which changes the head, retires the
old review, and earns a fresh round. That is the intended shape, not a nuisance.

It is deliberately strict about requiring **both** reviewers, and a rate limit is
no exception: a limited or failed CodeRabbit round scores `UNREVIEWED`, so the
function returns non-zero and **does not** let you merge. If you decide to go
ahead anyway, that is a conscious override — say so in the PR, naming which
reviewer never covered the head and why you accepted that. Do not read a rate
limit as approval, and do not read this paragraph as permission.

## Triggering a re-review

Post `@codex review` (or `@coderabbitai review`) as a **bare, standalone**
comment. A long body sometimes fails to trigger, so never append a trigger to a
report. After a force-push or rebase the head changes and prior reviews no longer
apply — expect and require a fresh round.

## Adjacent trap, different system

The canonical Rust gate can **exit 0 while its own summary block says FAIL**. Read
`== summary ==`, never the exit code.
