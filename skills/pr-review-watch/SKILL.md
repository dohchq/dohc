---
name: pr-review-watch
description: Keep a heartbeat running so you never go silent while ready-for-review PRs wait on bot review rounds (codex, CodeRabbit), and decide whether a ready PR's CURRENT head has actually been reviewed before merging. Use when a PR becomes ready for review, when you push to a ready PR, when a review seems slow or a trigger may not have taken, and always immediately before merging. Never request reviews or start this watcher for a draft PR.
---

# PR review: never silent, and never "reviewed" by assumption

CI is dispatch-only in this repo (see AGENTS.md), so bot review is a real gate.
A watcher that misses a round means merging unreviewed code — and a watcher that
*mislabels* a round is worse, because it manufactures false confidence.

Draft PRs are work in progress. Do not request reviews, start the watcher, or
run local Claude review while a PR is a draft. Start this workflow when the PR
becomes ready for review. If a ready PR returns to draft, stop its watcher.

## Two jobs, deliberately separated

The biggest design mistake here is one thing that both watches and judges. Early
versions did that, and nearly every bug landed in the judging half: a
`CHANGES_REQUESTED` read as a pass, one reviewer's findings attributed to
another, and a shared coverage flag that disabled the very timeout it guarded.

| job | how | why |
|---|---|---|
| **Notice** that it is time to look | background watcher printing a numbered heartbeat every interval | zero API calls, and it reads nothing, so it can report nothing wrong |
| **Judge** whether the head is reviewed | `review_status <PR>`, on demand | synchronous, you read the output, so it cannot silently cache a wrong answer |

The heartbeat notices **nothing**. It does not query GitHub, it does not track
PRs, and it never says a review landed. It wakes you up. You decide which PRs
sit at a decision point, and `review_status` judges each one.

**Why it stopped polling.** The old watcher ran three REST queries per PR per
two-minute cycle. Across a campaign's PRs that drains the shared 5,000/hour
GitHub budget, which happened twice — and an exhausted budget blocks merging
outright, because coverage cannot be checked at all. The tool that guards the
gate must not be the thing that closes it. A heartbeat spends nothing, so every
API call is now a deliberate act of the judge.

**What you give up, stated plainly.** Activity is noticed only as fast as the
wake interval; nothing reaches you between wakes. And a wake with nothing to
judge costs either a `review_status` run or a check you skip.

**A wake is not an instruction to query.** Most wakes should cost zero API
calls. Run `review_status` when you expect an answer to exist: you requested a
round, you pushed a head, or you are about to merge. A beat with no PR in that
state needs no action at all.

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
- `gh api` pages at 30 by default. Without `--paginate` the current head's review
  is invisible.
- **`--paginate` runs the `--jq` program once per page and concatenates the
  output.** So an aggregate like `[.[]|select(…)]|length` returns *one count per
  page* — `"0\n0"` past 100 items. `[ "$x" -eq 0 ]` then dies with
  `integer expression expected`, which in an `if` reads as false. Emit one line
  per match and count lines.
- **Coverage must not be filtered by timestamp at all.** A review of *this commit*
  is coverage whichever round produced it.
- **Zero findings is not a pass.** `CHANGES_REQUESTED` can carry its entire
  explanation in the review body with no inline comments at all.
- GitHub **re-anchors** older inline comments onto a new `commit_id` (see
  `docs/superpowers/plans/rust-engine/SESSION_HANDOFF.md:948-950`). Count by
  `pull_request_review_id`, not by commit, or you over-count.
- A failing query is **not** an empty result. Treat failure as *unknown*, never as
  "no reviews", or a transient blip reports a verdict nobody verified.

## The watcher — a heartbeat, not a poller

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

Read from a path **only you control** — a worktree, not a shared checkout. A
concurrent session switching branches in a shared tree deleted this file out from under
a running watcher, the extraction produced nothing, and `bash` of an empty script exited
instantly: a monitor that reported nothing because it was dead. The non-empty check, the
`bash -n`, the armed line, and the exit line all exist for that failure, so that silence
can never be ambiguous.

Export `INTERVAL_SECONDS` before the launcher to change the wake interval. The
default is 300 seconds. Restart the watcher after you edit block 1: the extraction
matches this file at launch, not forever.

```bash
INTERVAL_SECONDS="${INTERVAL_SECONDS:-300}"

# A bad interval makes `sleep` fail on every pass, and the loop then spins hot
# while it still prints heartbeats. Refuse to start instead.
if ! [ "$INTERVAL_SECONDS" -gt 0 ] 2>/dev/null; then
  echo "WATCHER CANNOT START — INTERVAL_SECONDS must be a whole number of seconds above 0 (got \"$INTERVAL_SECONDS\", default 300)"
  exit 1
fi

# No GitHub query belongs in this loop. It notices nothing and it costs nothing.
# It only guarantees you come back. review_status does the judging, when you ask.
beat=0
while true; do
  beat=$((beat + 1))
  echo "HEARTBEAT $beat @$(date -u +%H:%M:%SZ) — judge only a PR at a decision point (new push, a round you requested, pre-merge): run review_status <PR>; if none, do nothing until the next beat"
  sleep "$INTERVAL_SECONDS"
done
```

The heartbeat prints before its first sleep, so arming the watcher proves at once
that it runs. Every later line proves only that time passed.

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
# Set PR yourself, to the pull request you are actually checking. Do not paste a
# number out of this doc — a copied literal reports another PR's verdict as
# yours. This form fails loudly when PR is unset instead of guessing.
: "${PR:?set PR to the pull request number you are checking}"
# Keep the default for routine code. Set REVIEWERS=codex for prose-only,
# low-risk changes, or coderabbit when it replaces an unavailable Codex review.
REVIEWERS="${REVIEWERS:-both}"

if [ -s "$R" ] && bash -n "$R"; then
  . "$R"
  review_status "$PR" "$REVIEWERS"
else
  echo "review_status NOT AVAILABLE — extraction from $S was empty or does not parse"
fi
```

(This block is deliberately fenced as plain ``` rather than ```bash: the extraction
counts `bash` blocks, so making this one of them would renumber the very block it is
trying to fetch. Block 1 is the heartbeat, block 2 is `review_status`.)

Run it before merging, and at any heartbeat where you expect a round to have
landed. The optional second argument selects `codex` or `coderabbit`; the
default is `both`.

```bash
review_status() {
  local REPO=dohc-ai/dohc n="$1"
  local CODEX="chatgpt-codex-connector[bot]" RABBIT="coderabbitai[bot]"
  local required="${2:-both}"
  local -a reviewers
  local CLEAN="didn.t find any major issues|no major issues"
  local DEGRADED="Review limit|rate limit|Review failed"
  local head short rows lines rid st cnt blen who body cbody envt newest now crs draft verdict=OK
  local blocked=0 findings=0 unknown=0 unreviewed=0 pending=0

  [ -n "$n" ] || { echo "review_status: no PR number given"; return 2; }
  case "$required" in
    both)       reviewers=("$CODEX" "$RABBIT") ;;
    codex)      reviewers=("$CODEX") ;;
    coderabbit) reviewers=("$RABBIT") ;;
    *) echo "review_status: reviewer set must be both, codex, or coderabbit"; return 2 ;;
  esac
  draft=$(gh pr view "$n" --repo "$REPO" --json isDraft --jq .isDraft) \
    || { echo "PR #$n — draft-state query FAILED, verdict UNKNOWN"; return 2; }
  if [ "$draft" = "true" ]; then
    echo "PR #$n is DRAFT — review coverage is not required yet"
    return 3
  fi
  head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid) \
    || { echo "PR #$n — head query FAILED, verdict UNKNOWN"; return 2; }
  # An empty head would turn every filter below into contains(""), matching all
  # history and making an unresolved head look reviewed.
  [ -n "$head" ] || { echo "PR #$n — head resolved EMPTY, verdict UNKNOWN"; return 2; }
  short=${head:0:10}
  echo "PR #$n head $short"
  echo "  required reviewer set: $required"

  for who in "${reviewers[@]}"; do
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
      # sha-scoped body above — query it separately or this branch cannot run.
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
| `OK` | every selected reviewer covered this head and none left findings |
| `BLOCKED` | a `CHANGES_REQUESTED` on this head |
| `FINDINGS` | a review of this head carries inline comments or a body — unresolved work, even though its state is only `COMMENTED` |
| `UNREVIEWED` | a required reviewer filed no review of this head — including when it acknowledged receiving it, hit a rate limit, or (codex) cannot run on this repo at all |
| `PENDING` | CodeRabbit filed no review but says it is still processing this head — wait rather than re-trigger |
| `UNKNOWN` | a query failed — decide nothing |

It returns non-zero unless the verdict is `OK`, so it can gate a script.
`FINDINGS` requires triage, not an automatic code change. The review policy in
`AGENTS.md` decides whether a finding blocks. Document declined findings in the
PR before merging with a non-zero `FINDINGS` verdict.

The default reviewer set is `both`. Use `codex` only for prose-only, low-risk
changes under the policy in `AGENTS.md`. Use `coderabbit` when CodeRabbit
replaces an unavailable Codex review. Do not use a smaller set to bypass a
required review.

A limited or failed required reviewer scores `UNREVIEWED`. Replace an
unavailable reviewer as `AGENTS.md` requires, and record the reason in the PR.
Do not read a rate limit as approval.

## Triggering a re-review

Post `@codex review` (or `@coderabbitai review`) as a **bare, standalone**
comment. A long body sometimes fails to trigger, so never append a trigger to a
report. After a force-push or rebase the head changes and prior reviews no longer
apply — expect and require a fresh round.

## Adjacent trap, different system

The canonical Rust gate can **exit 0 while its own summary block says FAIL**. Read
`== summary ==`, never the exit code.
