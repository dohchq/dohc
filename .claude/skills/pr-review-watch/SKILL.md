---
name: pr-review-watch
description: Watch open PRs for bot review rounds (codex, CodeRabbit) without going silent, and decide whether a PR's CURRENT head has actually been reviewed before merging. Use when you open or push to a PR, when a review seems slow or a trigger may not have taken, and always immediately before merging.
---

# PR review: never silent, and never "reviewed" by assumption

CI is dispatch-only in this repo (see AGENTS.md), so bot review is a real gate.
A watcher that misses a round means merging unreviewed code — and a watcher that
*mislabels* a round is worse, because it manufactures false confidence.

## Two jobs, deliberately separated

The biggest design mistake here is one thing that both watches and judges. Three
successive versions of this skill did that, and **every** bug was in the judging
half: false closure spam, one reviewer's findings attributed to another, a
`CHANGES_REQUESTED` read as a pass, and a shared coverage flag that disabled the
very timeout it was guarding.

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
| codex | has findings | a **review** (`pulls/N/reviews`) with `commit_id`, plus inline comments |
| codex | **no findings** | an **issue comment** reading "Didn't find any major issues", carrying `**Reviewed commit:** <short-sha>` |
| CodeRabbit | approves / requests changes | a **review** with `state` |
| CodeRabbit | rate-limited | an **issue comment** containing "Review limit reached" |
| CodeRabbit | internal error | an **issue comment** containing "Review failed" |

So `pulls/N/reviews` being empty says **nothing** about whether the code was
reviewed. A clean codex pass leaves that endpoint untouched.

**Other traps, each of which produced a wrong answer in practice:**

- `gh api --jq` does **not** accept `--arg`. That is a standalone-`jq` flag, and
  `jq` is not installed here. It exits 1 printing nothing, which under
  `2>/dev/null` reads exactly like "no matches" — a false negative shaped like a
  real answer. Embed values: `--jq ".[]|select(.x==\"$v\")"`.
- codex writes the **10-char short SHA** in `Reviewed commit:`, while
  `headRefOid` is the full 40. `contains(full_sha)` never matches.
- `gh api` pages at 30 by default. Without `--paginate` the current head's review
  can fall off page one and be invisible.
- **Zero findings is not a pass.** `CHANGES_REQUESTED` can carry its entire
  explanation in the review body with no inline comments. Report the **state**,
  and flag a non-empty body.
- GitHub **re-anchors** older inline comments onto a new `commit_id` (see
  `docs/superpowers/plans/rust-engine/SESSION_HANDOFF.md:948-950`). Count by
  `pull_request_review_id`, not by commit, or you over-count.
- `gh pr list --state open` omits a merged PR, and its output is
  **newline**-delimited — `case " $list " in *" $n "*)` never matches and spams
  false closure every cycle.
- A failing query is **not** an empty result. Treat failure as *unknown*, never as
  "no reviews", or a transient blip fires a false alarm — or exits the watcher.

## The watcher — notices, does not judge

Run via `Monitor` with `persistent: true`.

```bash
REPO=dohc-ai/dohc
DEADLINE_MIN=25
CODEX="chatgpt-codex-connector[bot]"
RABBIT="coderabbitai[bot]"

declare -A high seen watched
fails=0

newest_bot_event() {
  { gh api "repos/$REPO/pulls/$1/reviews"   --paginate --jq '.[]|select(.user.type=="Bot")|.submitted_at' 2>/dev/null
    gh api "repos/$REPO/pulls/$1/comments"  --paginate --jq '.[]|select(.user.type=="Bot")|.created_at'   2>/dev/null
    gh api "repos/$REPO/issues/$1/comments" --paginate --jq '.[]|select(.user.type=="Bot")|.created_at'   2>/dev/null
  } | sort | tail -1
}

while true; do
  if ! prs=$(gh pr list --repo "$REPO" --state open --json number --jq '.[].number' 2>/dev/null); then
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

    latest=$(newest_bot_event "$n")
    if [ -n "$latest" ] && [ "$latest" != "${high[$n]:-}" ]; then
      high[$n]=$latest
      echo "BOT ACTIVITY #$n @$short — newest event $latest — run: review_status $n"
    fi

    pushed=$(gh api "repos/$REPO/commits/$head" --jq '.commit.committer.date' 2>/dev/null)
    trig=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
            --jq '.[]|select(.body|test("@codex review|@coderabbitai review"))|.created_at' 2>/dev/null | sort | tail -1)
    base=$(printf '%s\n%s\n' "$pushed" "$trig" | grep -v '^$' | sort | tail -1)
    [ -n "$base" ] || continue

    for who in "$CODEX" "$RABBIT"; do
      # An answer is EITHER a review object, or the one comment shape that
      # reviewer uses instead of one: codex names the head in a clean pass,
      # CodeRabbit says it was limited or failed. A generic comment — a
      # walkthrough, a "starting review" — is not an answer.
      case "$who" in
        "$CODEX") shape="$short" ;;
        *)        shape="Review limit|rate limit|Review failed" ;;
      esac
      answered=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
        --jq "[.[]|select(.commit_id==\"$head\" and .user.login==\"$who\" and .submitted_at>=\"$base\")]|length" 2>/dev/null) || continue
      if [ "${answered:-0}" -eq 0 ]; then
        answered=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
          --jq "[.[]|select(.user.login==\"$who\" and .created_at>=\"$base\")|select(.body|test(\"$shape\"))]|length" 2>/dev/null) || continue
      fi
      if [ "${answered:-0}" -eq 0 ]; then
        age=$(( ( $(date -u +%s) - $(date -u -d "$base" +%s) ) / 60 ))
        if [ "$age" -ge "$DEADLINE_MIN" ]; then
          k="to-$n-$short-$who-$base"
          [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "NO REVIEW #$n @$short from $who after ${age}m of this round — re-post the bare trigger"; }
        fi
      fi
    done
  done
  sleep 120
done
```

Each of these shapes was a real defect in an earlier version:

- Discovery checks the **exit status**, because an empty list from a failed query
  once made this watcher exit permanently on one transient blip — the anti-stall
  tool stalling.
- Coverage and timeouts are **per reviewer**. A shared flag let one reviewer
  answering mask another's trigger failing, and since CodeRabbit reviews nearly
  every head, that disabled the codex timeout almost always.
- The timeout measures from the **later of head push and newest trigger**, and its
  key includes that baseline — so a *second* failed trigger on an unchanged head
  still alerts instead of being suppressed as already-seen.
- Closure matches **line-wise** (`grep -qx`), because the list is newline-delimited.
- What counts as an answer is **shape-specific per reviewer**. Accepting any
  comment would let CodeRabbit's opening walkthrough — or a codex "starting
  review" — suppress the timeout for a round that then never completed, which is
  precisely the silence this watcher exists to break.

## `review_status` — judges, on demand

Source it and run it before merging, and whenever the watcher says to look.

```bash
review_status() {
  local REPO=dohc-ai/dohc n="$1"
  local CODEX="chatgpt-codex-connector[bot]" RABBIT="coderabbitai[bot]"
  local head verdict=OK

  head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid) \
    || { echo "PR #$n — head query FAILED, verdict UNKNOWN"; return 2; }
  local short=${head:0:10}
  echo "PR #$n head $short"

  for who in "$CODEX" "$RABBIT"; do
    local rows
    if ! rows=$(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
          --jq ".[]|select(.commit_id==\"$head\" and .user.login==\"$who\")|\"\(.id) \(.state)\"" 2>/dev/null); then
      echo "  $who — reviews query FAILED, coverage UNKNOWN"; verdict=UNKNOWN; continue
    fi

    if [ -n "$rows" ]; then
      while read -r rid st; do
        [ -n "$rid" ] || continue
        local cnt blen
        cnt=$(gh api "repos/$REPO/pulls/$n/comments" --paginate \
               --jq "[.[]|select(.pull_request_review_id==$rid)]|length" 2>/dev/null)
        blen=$(gh api "repos/$REPO/pulls/$n/reviews/$rid" --jq '.body|length' 2>/dev/null)
        echo "  $who review $rid [$st] — ${cnt:-?} inline, body ${blen:-0} chars"
        [ "$st" = CHANGES_REQUESTED ] && verdict=BLOCKED
        if [ "${cnt:-0}" -eq 0 ] && [ "${blen:-0}" -gt 0 ] && [ "$st" != APPROVED ]; then
          echo "    ^ zero inline but a non-empty body — READ THE BODY; this is not a pass"
        fi
      done <<<"$rows"
      continue
    fi

    if [ "$who" = "$CODEX" ] && gh api "repos/$REPO/issues/$n/comments" --paginate \
         --jq ".[]|select(.user.login==\"$CODEX\")|select(.body|contains(\"$short\"))|.body" 2>/dev/null \
       | grep -qiE "didn.t find any major issues|no major issues"; then
      echo "  $who — CLEAN PASS (issue comment naming $short)"
      continue
    fi

    echo "  $who — NO REVIEW of this head"
    [ "$verdict" = OK ] && verdict=UNREVIEWED
  done

  if gh api "repos/$REPO/issues/$n/comments" --paginate \
       --jq ".[]|select(.user.login==\"$RABBIT\")|.body" 2>/dev/null \
     | grep -qiE "review limit|rate limit|review failed"; then
    echo "  NOTE $RABBIT posted a rate-limit or failure notice on this PR — silence is not approval"
  fi

  echo "  VERDICT: $verdict"
  [ "$verdict" = OK ]
}
```

Verdicts: `OK` (both reviewers covered this head, nothing blocking), `BLOCKED`
(a `CHANGES_REQUESTED` on this head), `UNREVIEWED` (a required reviewer has not
covered it), `UNKNOWN` (a query failed — decide nothing).

It returns non-zero unless the verdict is `OK`, so it can gate a script. It is
deliberately strict about requiring **both** reviewers: when one is rate-limited
you still get to merge, but knowingly, rather than by mistaking silence for
approval.

## Triggering a re-review

Post `@codex review` (or `@coderabbitai review`) as a **bare, standalone**
comment. A long body sometimes fails to trigger, so never append a trigger to a
report. After a force-push or rebase the head changes and prior reviews no longer
apply — expect and require a fresh round.

## Adjacent trap, different system

The canonical Rust gate can **exit 0 while its own summary block says FAIL**. Read
`== summary ==`, never the exit code.
