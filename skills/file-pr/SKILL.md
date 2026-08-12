---
name: file-pr
description: >-
  Use when the user asks to file, open, create, or publish a pull request for
  the current branch, or when completed work must be proposed for review.
---

# File a pull request

File an accurate PR that represents the whole branch.

## Establish the change

1. Read the repository's PR, test, and review instructions.
2. Find the base branch from repository state. Do not assume `main`.
3. Check whether the current branch already has an open PR.
4. Use the existing PR when one exists. Do not create a duplicate.
5. Review the complete diff against the base branch.
6. Read the commits and the user's original request.
7. Confirm that the diff matches the requested outcome.
8. Keep unrelated work out of the PR.
9. Preserve unrelated worktree changes.
10. Commit and push all in-scope changes.

Describe the branch as it exists now. Do not describe only the last commit.

## Write the title

Review recent merged PRs and Git history before choosing the title. Follow the
repository's established type and scope format.

Write one short line that names the outcome. Prefer the behavior a person will
notice or the risk the change removes.

Use implementation terms only when the repository's readers need them. Use a
measured result when it makes the benefit clear. Never invent a measurement.

Bad:

> `perf(server): negotiate permessage-deflate on the websocket`

Good:

> `perf(server): cut websocket frame size by 67%+ with compression`

Bad:

> `chore(engine): add an expected-content-hash contract`

Good:

> `fix: keep delayed saves from overwriting newer file changes`

PR titles often become squash commit subjects. Make the title useful in Git
history without requiring the PR description.

## Write the description

Start every description with the attribution required by `AGENTS.md`. Put the
human section immediately after it:

```markdown
> Written by <model name>.

## For humans

<Explain the problem in plain language. Then explain what now happens instead.>
```

Write two to four sentences when that is enough. Anchor the explanation in the
user's request, then verify every claim against the diff.

Use first or second person when it makes the experience concrete. Preserve the
user's voice when the prompt gives you one.

Use words that appear in the product or the user's request. Avoid file names,
function names, internal architecture, commit SHAs, and test counts here.

If the change has no direct user interface, explain why the maintenance matters.
State the concrete failure, delay, risk, or future work it prevents.

Bad:

> Replaced both renderer activation paths with the shared navigation helper and
> added protocol classification in the main-process bridge.

Good:

> Links looked clickable in read-only documents, but they did nothing. They now
> open without making the document editable.

Also good when the user's prompt has a personal voice:

> My read-only documents showed clickable links, but they did nothing. Super
> confusing. Now the links open without making the document editable.

After `## For humans`, add only the sections the change needs. Use this default:

```markdown
## What changed

- <Describe a behavior-level change.>
- <Add technical detail only when it helps review.>

## Verification

- `<command or gate>` — <result>
- <Required gate not run yet, with the reason, or why no code gate applies.>
```

Keep `## What changed` shorter than the diff. Group related changes instead of
listing every file, function, or test case.

Make `## Verification` exact. Name each selected gate and its result. Never say
a check passed when it did not run.

Add limits, migration notes, screenshots, linked issues, or review findings only
when they help someone decide whether to merge the PR.

## File and verify the PR

1. Follow the repository's policy for draft and ready PRs.
2. Use a draft while implementation or required verification remains incomplete.
3. Use a ready PR when the change and required local gates are complete.
4. Preserve Markdown with a body file or an API field designed for multiline text.
5. Create or update the PR with the chosen base, title, body, and draft state.
6. Read the PR back from GitHub.
7. Verify its head, base, title, body, and draft state.
8. Return the PR link to the user.

Do not request reviews or start a review watcher for a draft PR.

When the PR becomes ready, follow the repository's simplification and reviewer
policy. Use the `pr-review-watch` skill when the repository requires it. Keep
the PR description current with gate results, review coverage, replacement
reviewers, and declined findings.
