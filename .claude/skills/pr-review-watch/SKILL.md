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
| CodeRabbit | approves / requests changes | a **review** with `state` |
| CodeRabbit | anything at all | also one **status comment it edits in place**, naming what it covered: `between <base-sha> and <head-sha>`, both **full 40-char** |
| CodeRabbit | still working | that same comment reading "Currently processing new changes in this PR" |
| CodeRabbit | rate-limited | that same comment containing "Review limit reached" |
| CodeRabbit | internal error | that same comment containing "Review failed" |

**CodeRabbit does not always produce a review object at all.** On a PR whose only
change was a markdown file it worked through five successive heads and created zero
entries in `pulls/N/reviews` and zero inline comments — its entire output lived in
that one edited comment. So treating a missing review object as "unreviewed" blocks
such a PR *permanently*. Read the status comment, and match the **full** SHA there
— the opposite of codex, which writes the short one. Because that comment is edited
in place rather than appended, a "Review limit reached" seen earlier can silently
vanish; its absence is not evidence it never happened.

CodeRabbit is also incremental and says so: *"does not re-review already reviewed
commits."* An explicit `@coderabbitai review` on an unchanged head just returns
"Action performed: Review finished" without doing new work.

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
- **CodeRabbit edits one status comment in place** instead of appending. Its
  `created_at` therefore stays behind every later round baseline; match on
  `updated_at`, or its answer is invisible.
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

Run via `Monitor` with `persistent: true`. Extract it from this file at launch
(`bash <(awk '/^```bash$/{f=1;n++;next} /^```$/{f=0} f&&n==1{print}' SKILL.md)`)
so the running process and the documented script cannot drift apart.

```bash
REPO=dohc-ai/dohc
DEADLINE_MIN=25
CODEX="chatgpt-codex-connector[bot]"
RABBIT="coderabbitai[bot]"
CLEAN="didn.t find any major issues|no major issues"
DEGRADED="Review limit|rate limit|Review failed"

declare -A high seen watched firstseen
fails=0

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
  local k="qf-$1-$2-$3-$4"
  [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "QUERY FAILED #$1 @$2 — the $4 query for $3 errored; coverage is UNKNOWN, not clear"; }
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
    unset "watched[$n]"
  done

  for n in $prs; do
    watched[$n]=1
    # A failing head query must not silently drop the PR: other PRs keep printing
    # normal output, which conceals that this one has no coverage checked at all.
    if ! head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null); then
      k="hq-$n"
      [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "HEAD QUERY FAILING #$n — cannot resolve its head; this PR is UNCHECKED, not clear"; }
      continue
    fi
    unset "seen[hq-$n]"
    short=${head:0:10}

    newest_bot_event "$n"
    if [ "${ACTIVITY_OK:-0}" -lt 3 ]; then
      k="deg-$n-$short-${ACTIVITY_OK:-0}"
      [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "PARTIAL VIEW #$n @$short — only ${ACTIVITY_OK:-0}/3 activity queries succeeded; quiet here may mean broken, not idle"; }
    fi
    if [ -n "$ACTIVITY_LATEST" ] && [ "$ACTIVITY_LATEST" != "${high[$n]:-}" ]; then
      high[$n]=$ACTIVITY_LATEST
      echo "BOT ACTIVITY #$n @$short — newest event $ACTIVITY_LATEST — run: review_status $n"
    fi

    # Deadlines run from when WE first saw this head, never from the commit's
    # committer date — that is when it was authored, so a branch cut from an
    # older commit would alert on the first poll, before the bots had the PR.
    fk="$n-$short"
    [ -n "${firstseen[$fk]:-}" ] || firstseen[$fk]=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    for who in "$CODEX" "$RABBIT"; do
      # An answer is a review object, or the ONE comment shape this reviewer
      # substitutes for one. The codex case requires the SHA *and* the clean-pass
      # phrase: a comment that merely mentions the head would otherwise suppress
      # the timeout forever for a round that never finished.
      case "$who" in
        "$CODEX") pat="@codex review"
                  ans="(.body|contains(\"$short\")) and (.body|test(\"$CLEAN\";\"i\"))" ;;
        # "Review finished" is CodeRabbit's answer to a trigger on a head it has
        # already reviewed — it means coverage exists from an earlier round, so it
        # must count, or re-posting a trigger produces a false NO REVIEW that
        # invites re-posting the same useless trigger.
        *)        pat="@coderabbitai review"
                  ans="(.body|contains(\"$head\")) or (.body|test(\"$DEGRADED|Review finished|Action performed\";\"i\"))" ;;
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

      # Count by LINES, never with a jq `|length` aggregate: --paginate runs the
      # jq program once per page and concatenates, so an aggregate yields one
      # number per page. "0\n0" then makes `[ -eq 0 ]` fail with an
      # integer-expression error, which reads as "answered" and skips the timeout
      # entirely — the watcher goes silent in exactly the case it must alert.
      # Comments are matched on updated_at: CodeRabbit EDITS its status comment in
      # place, so its created_at stays behind the round baseline forever.
      if ! rows=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
            --jq ".[]|select(.commit_id==\"$head\" and .user.login==\"$who\" and .submitted_at>=\"$base\")|.id" 2>/dev/null); then
        qfail "$n" "$short" "$who" reviews; continue
      fi
      answered=$(printf '%s' "$rows" | grep -c .)
      if [ "$answered" -eq 0 ]; then
        if ! rows=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
              --jq ".[]|select(.user.login==\"$who\" and .updated_at>=\"$base\")|select($ans)|.id" 2>/dev/null); then
          qfail "$n" "$short" "$who" comments; continue
        fi
        answered=$(printf '%s' "$rows" | grep -c .)
      fi
      [ "$answered" -eq 0 ] || continue

      age=$(( ( $(date -u +%s) - $(date -u -d "$base" +%s) ) / 60 ))
      [ "$age" -ge "$DEADLINE_MIN" ] || continue
      # The key carries the round baseline, so a SECOND failed trigger on an
      # unchanged head still alerts instead of being suppressed as already-seen.
      k="to-$n-$short-$who-$base"
      [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "NO REVIEW #$n @$short from $who after ${age}m of this round — re-post the bare trigger"; }
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

Source it and run it before merging, and whenever the watcher says to look.

```bash
review_status() {
  local REPO=dohc-ai/dohc n="$1"
  local CODEX="chatgpt-codex-connector[bot]" RABBIT="coderabbitai[bot]"
  local CLEAN="didn.t find any major issues|no major issues"
  local DEGRADED="Review limit|rate limit|Review failed"
  local head short rows lines rid st cnt blen who body covered verdict=OK
  local blocked=0 findings=0 unknown=0 unreviewed=0 pending=0

  head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid) \
    || { echo "PR #$n — head query FAILED, verdict UNKNOWN"; return 2; }
  short=${head:0:10}
  echo "PR #$n head $short"

  for who in "$CODEX" "$RABBIT"; do
    if ! rows=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
          --jq ".[]|select(.commit_id==\"$head\" and .user.login==\"$who\")|\"\(.id) \(.state)\"" 2>/dev/null); then
      echo "  $who — reviews query FAILED, coverage UNKNOWN"; unknown=1; continue
    fi

    if [ -n "$rows" ]; then
      # Decide coverage per REVIEWER, not per row. A dismissed review alongside a
      # later approval for the same commit must not leave the reviewer uncovered.
      covered=0
      while read -r rid st; do
        [ -n "$rid" ] || continue
        # Count only comments belonging to THIS review — GitHub re-anchors older
        # inline comments onto new commits, so counting by commit over-counts.
        # And count LINES, not with a jq `|length`: under --paginate the program
        # runs per page, so an aggregate returns one number per page.
        if ! lines=$(gh api "repos/$REPO/pulls/$n/comments" --paginate \
              --jq ".[]|select(.pull_request_review_id==$rid)|.id" 2>/dev/null); then
          echo "  $who review $rid [$st] — inline-count query FAILED, UNKNOWN"; unknown=1; continue
        fi
        cnt=$(printf '%s' "$lines" | grep -c .)
        if ! blen=$(gh api "repos/$REPO/pulls/$n/reviews/$rid" --jq '.body|length' 2>/dev/null); then
          echo "  $who review $rid [$st] — body query FAILED, UNKNOWN"; unknown=1; continue
        fi
        echo "  $who review $rid [$st] — ${cnt:-0} inline, body ${blen:-0} chars"
        case "$st" in
          CHANGES_REQUESTED) covered=1; blocked=1 ;;
          APPROVED)
            covered=1
            # Not just a warning: the function is usable as a scripted gate, so an
            # approval carrying inline comments must still fail it.
            if [ "${cnt:-0}" -gt 0 ]; then
              echo "    ^ APPROVED yet ${cnt} inline comment(s) — read them; this is not a clean pass"
              findings=1
            fi ;;
          COMMENTED)
            covered=1
            if [ "${cnt:-0}" -gt 0 ] || [ "${blen:-0}" -gt 0 ]; then
              echo "    ^ COMMENTED carrying ${cnt:-0} inline / ${blen:-0}-char body — these are findings, not a pass"
              findings=1
            fi ;;
          *)
            # DISMISSED, PENDING, or a state GitHub adds later: not a statement
            # about the code, so it contributes no coverage either way.
            echo "    ^ state $st is not a terminal review — ignored as coverage" ;;
        esac
      done <<<"$rows"
      # Only fall through to the comment-shaped paths if no row covered the head.
      [ "$covered" = 1 ] && continue
    fi

    # codex records a CLEAN pass as an issue comment, not a review.
    if [ "$who" = "$CODEX" ] && gh api "repos/$REPO/issues/$n/comments" --paginate \
         --jq ".[]|select(.user.login==\"$CODEX\")|select(.body|contains(\"$short\"))|.body" 2>/dev/null \
       | grep -qiE "$CLEAN"; then
      echo "  $who — CLEAN PASS (issue comment naming $short)"
      continue
    fi

    # CodeRabbit may never create a review object; the status comment it edits in
    # place is then the only record of what it covered, and it names the FULL sha.
    if [ "$who" = "$RABBIT" ]; then
      body=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
              --jq ".[]|select(.user.login==\"$RABBIT\")|.body" 2>/dev/null) || body=""
      if printf '%s' "$body" | grep -q "$head"; then
        if printf '%s' "$body" | grep -qiE "currently processing|review in progress"; then
          echo "  $who — REVIEW IN PROGRESS on this head; wait, do not re-trigger"
          pending=1
        elif printf '%s' "$body" | grep -qiE "$DEGRADED"; then
          echo "  $who — DEGRADED on this head (limit or failure); its silence is NOT approval"
          unreviewed=1
        else
          echo "  $who — covered this head via its status comment (no review object)"
        fi
        continue
      fi
    fi

    echo "  $who — NO REVIEW of this head"
    unreviewed=1
  done

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
| `UNREVIEWED` | a required reviewer has not covered this head, or covered it only to report a limit or failure |
| `PENDING` | CodeRabbit says it is still processing this head — wait, do not re-trigger |
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
