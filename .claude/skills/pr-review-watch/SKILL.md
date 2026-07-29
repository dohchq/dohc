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

declare -A seen high
while true; do
  prs=$(gh pr list --repo "$REPO" --state open --json number --jq '.[].number' 2>/dev/null)
  [ -n "$prs" ] || { echo "No open PRs — watcher exiting"; break; }
  for n in $prs; do
    head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) || continue
    short=${head:0:10}

    # CATCH-ALL: any new bot activity at all, whatever shape it takes.
    latest=$( { gh api "repos/$REPO/pulls/$n/reviews" --jq '.[]|select(.user.type=="Bot")|.submitted_at' 2>/dev/null
                gh api "repos/$REPO/pulls/$n/comments" --paginate --jq '.[]|select(.user.type=="Bot")|.created_at' 2>/dev/null
                gh api "repos/$REPO/issues/$n/comments" --paginate --jq '.[]|select(.user.type=="Bot")|.created_at' 2>/dev/null
              } | sort | tail -1 )
    if [ -n "$latest" ] && [ "$latest" != "${high[$n]:-}" ]; then
      high[$n]=$latest; echo "BOT ACTIVITY #$n @$short — newest bot event $latest"
    fi

    reviewed_head=0

    # Formal reviews of THIS head (codex when it HAS findings; CodeRabbit always).
    while read -r who st; do
      [ -n "$who" ] || continue
      reviewed_head=1
      k="rev-$n-$short-$who-$st"; [ "${seen[$k]:-}" = "1" ] && continue; seen[$k]=1
      inline=$(gh api "repos/$REPO/pulls/$n/comments" --paginate \
        --jq "[.[]|select(.original_commit_id==\"$head\" or .commit_id==\"$head\")]|length" 2>/dev/null)
      echo "REVIEW #$n @$short — $who [$st] — ${inline:-0} inline finding(s)"
    done < <(gh api "repos/$REPO/pulls/$n/reviews" \
              --jq ".[]|select(.commit_id==\"$head\")|\"\(.user.login) \(.state)\"" 2>/dev/null | sort -u)

    # codex CLEAN pass: an ISSUE comment naming the short sha, not a review.
    if gh api "repos/$REPO/issues/$n/comments" --paginate \
         --jq ".[]|select(.body|test(\"Reviewed commit\"))|select(.body|contains(\"$short\"))|.body" 2>/dev/null \
       | grep -qiE "didn.t find any major issues|no major issues"; then
      reviewed_head=1
      k="clean-$n-$short"
      [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "REVIEWED CLEAN #$n @$short — codex found no major issues on THIS head"; }
    fi

    # CodeRabbit degraded states — both masquerade as "no findings".
    bodies=$(gh api "repos/$REPO/issues/$n/comments" --paginate \
              --jq '.[]|select(.user.login=="coderabbitai[bot]")|.body' 2>/dev/null)
    case "$bodies" in *"Review limit"*|*"rate limit"*)
      k="rl-$n"; [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "RATE LIMIT #$n — CodeRabbit hit a review limit; its silence is NOT approval"; };; esac
    case "$bodies" in *"Review failed"*)
      k="rf-$n"; [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "REVIEW FAILED #$n — CodeRabbit errored; re-request with '@coderabbitai review'"; };; esac

    # A trigger that never took.
    pushed=$(gh api "repos/$REPO/commits/$head" --jq '.commit.committer.date' 2>/dev/null)
    if [ "$reviewed_head" -eq 0 ] && [ -n "$pushed" ]; then
      age=$(( ( $(date -u +%s) - $(date -u -d "$pushed" +%s) ) / 60 ))
      if [ "$age" -ge "$DEADLINE_MIN" ]; then
        k="to-$n-$short"
        [ "${seen[$k]:-}" = "1" ] || { seen[$k]=1; echo "NO REVIEW #$n @$short after ${age}m — re-post the bare comment '@codex review'"; }
      fi
    fi
  done
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
