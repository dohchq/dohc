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

## Invariants

- **Match on `commit_id`, never on time.** `gh api …/pulls/N/reviews` returns
  `commit_id` per review. Compare it to `gh pr view N --json headRefOid`. That is
  the only statement of "the current head has been reviewed" that survives
  force-pushes, rebases, and branches cut before a dependency merged.
- **Persistent, not one-shot.** Report every round for the lifetime of the PR.
  Exit only when every watched PR is closed or merged.
- **Silence is never success.** Emit on *every* terminal state: findings arrived,
  reviewed-clean, rate-limited, or deadline passed with no review.
- **Re-check fresh at every decision point.** Before merging, query the API
  again. Never merge on a watcher's last remembered output — watchers die with
  the shell, the session, or the machine.
- **Never alert on a file or job that has finished.** Skip anything already
  terminal before evaluating staleness.

## The watcher

Run via `Monitor` with `persistent: true`. Pass the PR numbers you care about.

```bash
REPO=dohc-ai/dohc
PRS="360 367"          # PRs to watch
DEADLINE_MIN=25        # no review on a head this long => trigger probably failed

declare -A seen
while true; do
  any_open=0
  for n in $PRS; do
    state=$(gh pr view "$n" --json state --jq .state 2>/dev/null) || continue
    if [ "$state" != "OPEN" ]; then
      [ "${seen[closed-$n]:-}" = "1" ] || { seen[closed-$n]=1; echo "PR #$n is $state — stopped watching"; }
      continue
    fi
    any_open=1
    head=$(gh pr view "$n" --json headRefOid --jq .headRefOid 2>/dev/null) || continue
    short=${head:0:10}

    # Reviews of THIS head, keyed by reviewer.
    while read -r who st; do
      [ -n "$who" ] || continue
      key="rev-$n-$short-$who"
      [ "${seen[$key]:-}" = "1" ] && continue
      seen[$key]=1
      finds=$(gh api "repos/$REPO/pulls/$n/reviews" --jq \
        --arg h "$head" '[.[]|select(.commit_id==$h)]|length' 2>/dev/null)
      inline=$(gh api "repos/$REPO/pulls/$n/comments" --paginate --jq \
        --arg h "$head" '[.[]|select(.original_commit_id==$h or .commit_id==$h)]|length' 2>/dev/null)
      echo "REVIEW #$n @$short — $who [$st] — ${inline:-0} inline finding(s)"
    done < <(gh api "repos/$REPO/pulls/$n/reviews" --jq \
              --arg h "$head" '.[]|select(.commit_id==$h)|"\(.user.login) \(.state)"' 2>/dev/null | sort -u)

    # Rate-limit notices — these masquerade as "no findings".
    if gh api "repos/$REPO/issues/$n/comments" --paginate --jq \
         '.[]|select(.user.login=="coderabbitai[bot]")|.body' 2>/dev/null \
       | grep -qiE "review limit|rate limit"; then
      [ "${seen[rl-$n]:-}" = "1" ] || { seen[rl-$n]=1; echo "RATE LIMIT #$n — CodeRabbit reported a review limit; its silence is NOT approval"; }
    fi

    # A trigger that never took.
    pushed=$(gh api "repos/$REPO/commits/$head" --jq '.commit.committer.date' 2>/dev/null)
    if [ -n "$pushed" ]; then
      age=$(( ( $(date -u +%s) - $(date -u -d "$pushed" +%s) ) / 60 ))
      reviewed=$(gh api "repos/$REPO/pulls/$n/reviews" --jq \
        --arg h "$head" '[.[]|select(.commit_id==$h)]|length' 2>/dev/null)
      if [ "${reviewed:-0}" -eq 0 ] && [ "$age" -ge "$DEADLINE_MIN" ]; then
        [ "${seen[to-$n-$short]:-}" = "1" ] || { seen[to-$n-$short]=1; echo "NO REVIEW #$n @$short after ${age}m — re-post the bare comment '@codex review'"; }
      fi
    fi
  done
  [ "$any_open" -eq 0 ] && { echo "All watched PRs closed or merged — watcher exiting"; break; }
  sleep 120
done
```

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
