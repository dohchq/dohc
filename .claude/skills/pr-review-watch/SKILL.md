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
| CodeRabbit | rate-limited | an **issue comment** containing "Review limit reached" |
| CodeRabbit | internal error | an **issue comment** containing "Review failed" |

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
    if part=$(gh api "repos/$REPO/$ep" --paginate \
                --jq '.[]|select(.user.type=="Bot")|(.submitted_at // .created_at)' 2>/dev/null); then
      ACTIVITY_OK=$((ACTIVITY_OK+1))
      out=$(printf '%s\n%s\n' "$out" "$part")
    fi
  done
  ACTIVITY_LATEST=$(printf '%s\n' "$out" | grep -v '^$' | sort | tail -1)
}

while true; do
  if ! prs=$(gh pr list --repo "$REPO" --state open --limit 200 --json number --jq '.[].number' 2>/dev/null); then
    fails=$((fails+1))
    [ "$fails" = 3 ] && echo "DISCOVERY FAILING — gh pr list errored 3x; watcher alive, results may be stale"
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
    head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) || continue
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
        *)        pat="@coderabbitai review"
                  ans="(.body|test(\"$DEGRADED\";\"i\"))" ;;
      esac

      # Each reviewer's round starts at ITS OWN newest trigger. One shared
      # baseline lets a later "@codex review" invalidate CodeRabbit's perfectly
      # good review of the same head, after which the watcher demands a trigger
      # that was never missing.
      trig=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
              --jq ".[]|select(.body|contains(\"$pat\"))|.created_at" 2>/dev/null | sort | tail -1)
      base=$(printf '%s\n%s\n' "${firstseen[$fk]}" "$trig" | grep -v '^$' | sort | tail -1)

      answered=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
        --jq "[.[]|select(.commit_id==\"$head\" and .user.login==\"$who\" and .submitted_at>=\"$base\")]|length" 2>/dev/null) || continue
      if [ "${answered:-0}" -eq 0 ]; then
        answered=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
          --jq "[.[]|select(.user.login==\"$who\" and .created_at>=\"$base\")|select($ans)]|length" 2>/dev/null) || continue
      fi
      [ "${answered:-0}" -eq 0 ] || continue

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
  local head short rows rid st cnt blen who verdict=OK
  local blocked=0 findings=0 unknown=0 unreviewed=0

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
      while read -r rid st; do
        [ -n "$rid" ] || continue
        # Count only comments belonging to THIS review — GitHub re-anchors older
        # inline comments onto new commits, so counting by commit over-counts.
        if ! cnt=$(gh api "repos/$REPO/pulls/$n/comments" --paginate \
              --jq "[.[]|select(.pull_request_review_id==$rid)]|length" 2>/dev/null); then
          echo "  $who review $rid [$st] — inline-count query FAILED, UNKNOWN"; unknown=1; continue
        fi
        if ! blen=$(gh api "repos/$REPO/pulls/$n/reviews/$rid" --jq '.body|length' 2>/dev/null); then
          echo "  $who review $rid [$st] — body query FAILED, UNKNOWN"; unknown=1; continue
        fi
        echo "  $who review $rid [$st] — ${cnt:-0} inline, body ${blen:-0} chars"
        case "$st" in
          CHANGES_REQUESTED) blocked=1 ;;
          APPROVED)
            [ "${cnt:-0}" -gt 0 ] && echo "    ^ APPROVED yet ${cnt} inline comment(s) — read them before merging" ;;
          *)
            if [ "${cnt:-0}" -gt 0 ] || [ "${blen:-0}" -gt 0 ]; then
              echo "    ^ $st carrying ${cnt:-0} inline / ${blen:-0}-char body — these are findings, not a pass"
              findings=1
            fi ;;
        esac
      done <<<"$rows"
      continue
    fi

    # codex records a CLEAN pass as an issue comment, not a review.
    if [ "$who" = "$CODEX" ] && gh api "repos/$REPO/issues/$n/comments" --paginate \
         --jq ".[]|select(.user.login==\"$CODEX\")|select(.body|contains(\"$short\"))|.body" 2>/dev/null \
       | grep -qiE "$CLEAN"; then
      echo "  $who — CLEAN PASS (issue comment naming $short)"
      continue
    fi

    echo "  $who — NO REVIEW of this head"
    unreviewed=1
  done

  if gh api "repos/$REPO/issues/$n/comments" --paginate \
       --jq ".[]|select(.user.login==\"$RABBIT\")|.body" 2>/dev/null \
     | grep -qiE "Review limit|rate limit|Review failed"; then
    echo "  NOTE $RABBIT posted a rate-limit or failure notice on this PR — silence is not approval"
  fi

  if   [ "$blocked"    = 1 ]; then verdict=BLOCKED
  elif [ "$unknown"    = 1 ]; then verdict=UNKNOWN
  elif [ "$unreviewed" = 1 ]; then verdict=UNREVIEWED
  elif [ "$findings"   = 1 ]; then verdict=FINDINGS
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
| `UNREVIEWED` | a required reviewer has not covered this head |
| `UNKNOWN` | a query failed — decide nothing |

It returns non-zero unless the verdict is `OK`, so it can gate a script. Note
what `FINDINGS` implies about the loop: findings never disappear from the API, so
the only way to reach `OK` is to push fixes — which changes the head, retires the
old review, and earns a fresh round. That is the intended shape, not a nuisance.

It is deliberately strict about requiring **both** reviewers: when one is
rate-limited you still get to merge, but knowingly, rather than by mistaking
silence for approval.

## Triggering a re-review

Post `@codex review` (or `@coderabbitai review`) as a **bare, standalone**
comment. A long body sometimes fails to trigger, so never append a trigger to a
report. After a force-push or rebase the head changes and prior reviews no longer
apply — expect and require a fresh round.

## Adjacent trap, different system

The canonical Rust gate can **exit 0 while its own summary block says FAIL**. Read
`== summary ==`, never the exit code.
