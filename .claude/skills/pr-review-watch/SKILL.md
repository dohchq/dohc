---
name: pr-review-watch
description: Watch open PRs for bot review rounds (codex, CodeRabbit) without stalling or missing a round. Use whenever you open or push to a PR and need to know when a review lands, when it is clean, when a reviewer is rate-limited, or when a review trigger silently failed. Also use before merging any PR, to confirm the CURRENT head was reviewed rather than an older commit.
---

# Watching PR reviews without stalling

CI is dispatch-only in this repo (see AGENTS.md), so bot review is a real gate,
not decoration. A watcher that misses a round means merging unreviewed code.

**The rule this skill exists to enforce: a review applies to a COMMIT, not to a
PR.** Every stall below came from forgetting that.

## The failure modes this replaces

All six were hit in a single session. They are not hypothetical.

1. **Assumed commit timestamps.** A filter of `submitted_at > <guessed time>`
   excluded the reviews *of the very commit being checked*, and reported "0
   findings" while six sat unread — including a `CHANGES_REQUESTED`.
2. **One-shot waiters.** `until <cond>; do sleep; done` exits on the first hit.
   Push again, trigger again, and nothing is watching the next round. A whole
   review round went unseen this way.
3. **Watching one reviewer.** Polling only codex missed CodeRabbit's
   `CHANGES_REQUESTED` entirely.
4. **A trigger that silently did not take.** `@codex review` was posted and no
   review ever arrived. Nothing detected the silence.
5. **CodeRabbit rate limits quietly.** It posts a "Review limit reached" comment
   rather than failing, so absence of findings looks like approval.
6. **Alerting on finished files.** A monitor that fires on logs which have
   legitimately stopped trains you to ignore it.

## Where a review actually lives — the part that breaks watchers

**A bot review is not always a review object.** This is the single most important
fact here, and getting it wrong makes a watcher confidently report the opposite
of the truth.

| bot | outcome | where it lands |
|---|---|---|
| codex | has findings | a **review** (`pulls/N/reviews`) with `commit_id`, plus inline `pulls/N/comments` |
| codex | **no findings** | an **issue comment** (`issues/N/comments`) reading "Didn't find any major issues", carrying `**Reviewed commit:** <sha>` |
| CodeRabbit | approves / requests changes | a **review**, `state` = `APPROVED` / `CHANGES_REQUESTED` |
| CodeRabbit | rate-limited | an **issue comment** containing "Review limit reached" |
| CodeRabbit | internal error | an **issue comment** containing "Review failed" |

So `pulls/N/reviews` being empty means **nothing at all** about whether the code
was reviewed. A clean codex pass leaves that endpoint untouched. Watching only
reviews reports "unreviewed" for a PR that was reviewed and passed.

The `Reviewed commit:` line in codex's clean-pass comment is the authoritative
head match for that case — parse it, do not infer from timestamps.

## Invariants

- **Match on the reviewed COMMIT, never on time.** For reviews, compare
  `commit_id` to `gh pr view N --json headRefOid`. For codex clean passes, parse
  `Reviewed commit:` out of the comment body. Timestamps are unusable: a branch
  cut before a dependency merged, a rebase, or a force-push all break them.
- **Catch-all before classification.** Track the newest bot activity timestamp per
  PR and report *any* advance, even if the shape is unrecognised. Specific
  parsing gives good labels; the catch-all is what guarantees a new or changed bot
  format degrades to "go look at this" instead of silence. Every stall in this
  skill's history came from a shape the watcher did not know about.
- **Persistent, not one-shot.** Report every round for the lifetime of the PR.
  Exit only when every watched PR is closed or merged.
- **Discover the PRs, do not hardcode them.** A hardcoded list silently omits any
  PR opened later — that is how a third open PR went unwatched entirely.
- **Silence is never success.** Emit on every terminal state: findings,
  reviewed-clean, rate-limited, review-failed, or deadline with no review.
- **Re-check fresh at every decision point.** Before merging, query the API again.
  Watchers die with the shell, the session, and the machine.
- **Never alert on a job that has finished.** Skip anything already terminal
  before evaluating staleness, or the noise trains you to ignore real alerts.

## `gh api --jq` does NOT accept `--arg` — read this first

```bash
# BROKEN. Exits 1, prints "accepts 1 arg(s), received 4", outputs nothing.
gh api repos/O/R/pulls/1/reviews --jq --arg h "$head" '[.[]|select(.commit_id==$h)]|length'

# CORRECT. Embed the value in the jq program text.
gh api repos/O/R/pulls/1/reviews --jq "[.[]|select(.commit_id==\"$head\")]|length"
```

`--arg` is a flag of standalone `jq`, which is **not installed here**; `gh api
--jq` takes only the program string. Combined with `2>/dev/null`, the broken form
produces empty output that reads as "no reviews match" — a **false negative that
looks exactly like a real answer.** This single mistake caused a watcher to report
two reviewed-clean PRs as unreviewed. Values interpolated this way are SHAs and
logins, so quoting is safe.

## The watcher

Run via `Monitor` with `persistent: true`. It discovers open PRs itself.

```bash
REPO=dohc-ai/dohc
DEADLINE_MIN=25
CODEX="chatgpt-codex-connector[bot]"
RABBIT="coderabbitai[bot]"
REQUIRED="$CODEX $RABBIT"

declare -A seen high watched
fails=0

while true; do
  # Discovery must distinguish "no open PRs" from "the query failed", or a
  # transient error permanently kills a persistent watcher.
  if ! prs=$(gh pr list --repo "$REPO" --state open --json number --jq '.[].number' 2>/dev/null); then
    fails=$((fails+1))
    [ "$fails" = 3 ] && echo "DISCOVERY FAILING — gh pr list errored 3x; watcher alive but results may be stale"
    sleep 120; continue
  fi
  fails=0

  # Anything we were watching that left the open list gets a closure event.
  for n in "${!watched[@]}"; do
    case " $prs " in *" $n "*) continue ;; esac
    st=$(gh pr view "$n" --repo "$REPO" --json state --jq .state 2>/dev/null) || st="GONE"
    echo "PR #$n is $st — stopped watching"
    unset "watched[$n]"
  done

  for n in $prs; do
    watched[$n]=1
    head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) || continue
    short=${head:0:10}

    # CATCH-ALL: any advance in bot activity, whatever shape it takes.
    latest=$( { gh api "repos/$REPO/pulls/$n/reviews"  --paginate --jq '.[]|select(.user.type=="Bot")|.submitted_at' 2>/dev/null
                gh api "repos/$REPO/pulls/$n/comments" --paginate --jq '.[]|select(.user.type=="Bot")|.created_at'   2>/dev/null
                gh api "repos/$REPO/issues/$n/comments" --paginate --jq '.[]|select(.user.type=="Bot")|.created_at'  2>/dev/null
              } | sort | tail -1 )
    if [ -n "$latest" ] && [ "$latest" != "${high[$n]:-}" ]; then
      high[$n]=$latest; echo "BOT ACTIVITY #$n @$short — newest event $latest"
    fi

    # Round baseline = later of (head pushed) and (newest review trigger).
    # ISO-8601 UTC sorts lexicographically, so string max is correct.
    pushed=$(gh api "repos/$REPO/commits/$head" --jq '.commit.committer.date' 2>/dev/null)
    trig=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
            --jq '.[]|select(.body|test("@codex review|@coderabbitai review"))|.created_at' 2>/dev/null | sort | tail -1)
    base=$(printf '%s\n%s\n' "$pushed" "$trig" | grep -v '^$' | sort | tail -1)

    for who in $REQUIRED; do
      covered=0

      # Formal reviews of THIS head by THIS reviewer, keyed by review id so a
      # repeat round with the same state is still reported.
      while read -r rid st; do
        [ -n "$rid" ] || continue
        covered=1
        k="rev-$n-$rid"; [ "${seen[$k]:-}" = "1" ] && continue; seen[$k]=1
        inline=$(gh api "repos/$REPO/pulls/$n/comments" --paginate \
          --jq "[.[]|select((.original_commit_id==\"$head\" or .commit_id==\"$head\") and .user.login==\"$who\")]|length" 2>/dev/null)
        echo "REVIEW #$n @$short — $who [$st] — ${inline:-0} inline finding(s)"
      done < <(gh api "repos/$REPO/pulls/$n/reviews" --paginate \
                --jq ".[]|select(.commit_id==\"$head\" and .user.login==\"$who\")|\"\(.id) \(.state)\"" 2>/dev/null)

      # codex files a CLEAN pass as an issue comment, not a review. Author-checked.
      if [ "$who" = "$CODEX" ] && gh api "repos/$REPO/issues/$n/comments" --paginate \
           --jq ".[]|select(.user.login==\"$CODEX\")|select(.body|test(\"Reviewed commit\"))|select(.body|contains(\"$short\"))|.body" 2>/dev/null \
         | grep -qiE "didn.t find any major issues|no major issues"; then
        covered=1
        k="clean-$n-$short"
        [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "REVIEWED CLEAN #$n @$short — $CODEX found no major issues on THIS head"; }
      fi

      # Degraded CodeRabbit states, scoped to THIS round so a historical notice
      # does not shadow a later successful review.
      if [ "$who" = "$RABBIT" ] && [ -n "$base" ]; then
        recent=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
                  --jq ".[]|select(.user.login==\"$RABBIT\")|select(.created_at>=\"$base\")|.body" 2>/dev/null)
        case "$recent" in *"Review limit"*|*"rate limit"*)
          covered=1; k="rl-$n-$short"
          [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "RATE LIMIT #$n @$short — $RABBIT hit a review limit THIS round; its silence is NOT approval"; } ;;
        esac
        case "$recent" in *"Review failed"*)
          covered=1; k="rf-$n-$short"
          [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "REVIEW FAILED #$n @$short — $RABBIT errored THIS round; re-request with '@coderabbitai review'"; } ;;
        esac
      fi

      # Independent per-reviewer timeout: one reviewer answering must never mask
      # another reviewer's trigger silently failing.
      if [ "$covered" -eq 0 ] && [ -n "$base" ]; then
        age=$(( ( $(date -u +%s) - $(date -u -d "$base" +%s) ) / 60 ))
        if [ "$age" -ge "$DEADLINE_MIN" ]; then
          k="to-$n-$short-$who"
          [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "NO REVIEW #$n @$short from $who after ${age}m — re-post the bare trigger comment"; }
        fi
      fi
    done
  done
  sleep 120
done
```

### Why it is shaped this way

Each of these was a real defect in an earlier version of this script, found in
review. They are the reasons the code looks more careful than a poller "should".

- **Discovery failure is not emptiness.** `gh pr list` failing with stderr
  discarded yields an empty list, which a naive watcher reads as "no open PRs"
  and exits — permanently. The anti-stall tool stalls. Check the exit status.
- **Per-reviewer coverage, per-reviewer timeout.** A shared "was this head
  reviewed" flag lets one reviewer answering mask another's trigger silently
  failing. Since CodeRabbit normally reviews every head, a shared flag disables
  the codex timeout almost always.
- **Key by review id, not by (reviewer, state).** A second `COMMENTED` round on
  an unchanged head has an identical (reviewer, state) key and would be
  suppressed; `sort -u` collapses them before the loop even sees them.
- **Attribute inline findings to the reviewer being reported.** Counting every
  inline comment on the commit prints the same aggregate beside each reviewer, so
  a clean reviewer appears to own another's findings.
- **Scope degraded notices to the current round.** A rate-limit or failure
  comment matches forever otherwise, so it keeps firing after CodeRabbit later
  reviews the head successfully — a false alarm that teaches you to ignore a real
  one.
- **Measure the deadline from the trigger, not the commit.** A PR opened, or a
  re-request posted, well after the commit was authored would otherwise be
  declared failed before the bot had any time to answer.
- **Author-check the clean-pass comment.** Anyone quoting an earlier review can
  contain `Reviewed commit`, the short SHA and "no major issues"; unfiltered, that
  quote is accepted as a passing review gate.
- **Paginate every review query.** `gh api` defaults to 30 per page, so on a busy
  PR the current head's review can fall off page one and be invisible.
- **Track watched PRs to report closure.** `gh pr list --state open` simply omits
  a merged PR, so without its own set the watcher never emits the terminal event.

## Reading the output

| line | meaning | action |
|---|---|---|
| `REVIEW … N inline finding(s)` with N>0 | findings on the current head | read each, verify against the code, fix or refute |
| `REVIEW … 0 inline finding(s)` | that reviewer passed **this** head | one clean reviewer is not all reviewers |
| `RATE LIMIT` | CodeRabbit did not actually review | do not read its silence as approval |
| `NO REVIEW … after Nm` | the trigger did not take | re-post `@codex review` as a **bare** comment |
| `PR #N is MERGED/CLOSED` | done | — |

## Triggering a re-review

Post the bare text `@codex review` as its own comment. A long comment body
sometimes does not trigger it, so never append the trigger to a report — post it
separately. After a force-push or rebase, the head SHA changes and the previous
round's reviews no longer apply; expect and require a fresh round.

## Before merging — always

```bash
gh pr view <N> --json headRefOid --jq .headRefOid          # current head
gh api repos/dohc-ai/dohc/pulls/<N>/reviews \
  --jq '.[]|"\(.user.login) \(.state) \(.commit_id[0:10])"' # who reviewed WHAT
```

If no review's `commit_id` equals the head, **the current code is unreviewed**
regardless of how many reviews the PR has collected.

## Notes

- Standalone `jq` is not installed here — use `gh api --jq`.
- `--paginate` matters on comments; a busy PR exceeds one page and a truncated
  read looks like "no findings".
- This skill covers review *rounds*. The canonical Rust gate is separate, and its
  own trap is that it can exit 0 while its summary block says FAIL — read the
  `== summary ==` block, never the exit code.
