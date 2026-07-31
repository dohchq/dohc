---
name: claude-collaboration
description: >-
  Use Claude Code CLI as a separate collaborator for taste-sensitive design
  and writing, architecture, investigation, scoped implementation, or
  independent review. Trigger when the user asks Codex to use Claude, Fable,
  or Opus; when repository review policy requires local Claude; when a
  user-facing decision needs Claude's taste; or when another capable model
  should challenge Codex's plan or patch. Do not use for routine mechanical
  work that Codex can complete directly.
---

# Claude Collaboration

Run Claude Code non-interactively. Codex owns the scope, permissions,
verification, and final answer.

## Select the model

Read the shared
[model-routing policy](../../model-routing.md) before overriding the model.

Follow an explicit user choice. If the configured Claude default fits the
task, omit `--model`.

When an override is useful, pass `fable` or `opus`. Choose effort separately
from model choice.

Do not hardcode Fable or another Claude model into this workflow.

## Prepare the run

1. Run from the repository root.
2. Inspect `git status --short` before any write-capable run.
3. Record all pre-existing changes that overlap the task.
4. Define one outcome, one review target, and explicit boundaries.
5. Select the smallest tool set that can complete the task.
6. State whether Claude may edit files.

Claude Code loads `CLAUDE.md` from the repository root. That file imports
`AGENTS.md`, so do not repeat their full contents in the prompt.

Do not use `--bare` for repository work. Bare mode skips `CLAUDE.md`
auto-discovery and most repository or user customization.

Use `--bare` only for a hermetic task with a fully self-contained prompt.

## Run Claude

Start from this command:

```text
claude -p [--model <alias>] [--effort <level>] --permission-mode dontAsk --output-format json "<prompt>"
```

Use `dontAsk` with explicit tool rules. A non-interactive run cannot answer a
permission prompt.

For advice, investigation, planning, or review, restrict Claude to read-only
tools:

```text
--tools "Read,Glob,Grep,Bash"
--allowedTools "Read" "Glob" "Grep" "Bash(git status)" "Bash(git status *)" "Bash(git diff)" "Bash(git diff *)" "Bash(git show *)" "Bash(git log *)"
--disallowedTools "mcp__*"
```

For implementation, add `Edit` and `Write`. Add only the exact verification
commands that the task needs:

```text
--tools "Read,Glob,Grep,Edit,Write,Bash"
--allowedTools "Read" "Glob" "Grep" "Edit" "Write" <narrow Bash rules>
--disallowedTools "mcp__*" "Bash(git commit)" "Bash(git commit *)" "Bash(git push *)" "Bash(git reset *)" "Bash(git clean *)" "Bash(gh *)"
```

Treat tool rules as guardrails, not as a security boundary. Do not allow broad
`Bash` access because it is convenient.

Allow MCP or external tools only when the user's request requires them.
Preserve the user's existing authorization and review gates.

Do not use `bypassPermissions` outside a disposable isolated environment.
Require explicit user authorization before using it.

## Write the prompt

Tell Claude the outcome and constraints. Let Claude choose the procedure.

Include:

- The repository path and exact target.
- The outcome and acceptance criteria.
- Relevant source files, requirements, or commit SHA.
- Whether Claude may edit files.
- Existing user changes that Claude must preserve.
- Actions that Claude must not take.
- The response contract.

Do not restate repository instructions that Claude will load itself.

Use this shape:

```text
You are collaborating with Codex in <repository>.

Outcome:
<one concrete result>

Target:
<files, diff, commit SHA, or behavior>

Constraints:
- <read-only, or exact write scope>
- Preserve unrelated user changes.
- Do not commit, push, deploy, or edit global configuration.
- <task-specific boundaries>

Return:
- <the evidence or artifact Codex needs>
- <remaining uncertainty or test gaps>
```

For a review, require findings before summary. Ask for severity, file and line,
failure mode, and fix direction.

Ask Claude to say that it found no substantive issues when the review is
clean. Require it to name residual test gaps.

When using Fable, describe the desired outcome instead of prescribing each
step. Avoid repeated reminders to investigate or verify.

## Manage output and sessions

Use JSON output by default. Read `result`, `session_id`, `modelUsage`, and
`total_cost_usd`.

Check `modelUsage` when aliases, fallbacks, or model restrictions can change
the selected model.

Check the command's exit status and standard error before using Claude's
answer.

Use `--json-schema` when another command must consume stable fields. Read the
validated value from `structured_output`.

Use `--no-session-persistence` for a one-shot answer with no expected follow-up.

Keep the session when follow-up is likely. Resume it with:

```text
claude -p --resume <session_id> <same model, effort, permission, and tool flags> --output-format json "<focused follow-up>"
```

Run the resume command from the same repository directory. Repeat the original
model, effort, permission, and tool flags.

Pipe long input through stdin. If input exceeds Claude Code's stdin limit,
create a task-local file with the host's approved file tool. Ask Claude to read
that file.

Do not set arbitrary turn or cost limits. Add a limit only when the user gives
one or measured healthy work justifies one.

Claude runs can take longer than a normal shell call. Use the command runner's
yield or background mechanism and poll the same process. Do not start duplicate
runs because the first run is quiet.

## Verify Claude's work

After a read-only run:

1. Verify material claims against the cited source.
2. Separate confirmed findings from unverified suggestions.
3. Use the result as evidence, not authority.

After a write-capable run:

1. Inspect `git status --short`.
2. Inspect the complete diff.
3. Separate Claude's changes from pre-existing user changes.
4. Run the cheapest reliable verification.
5. Fix or reject unsupported changes before reporting completion.

Never let Claude commit, push, deploy, merge, or edit global configuration
unless the user explicitly requests that action.

Never run concurrent write-capable Claude sessions in the same checkout. Use
separate worktrees only when the user requests parallel implementation.

## Review a pull request

Follow the repository's review policy before starting.

- Do not run the required local Claude review while the pull request is draft.
- Review the exact current head SHA.
- Use the reviewer required by `AGENTS.md`.
- Re-run only for a new verified blocker or unresolved high-risk concern.
- Verify every finding before deciding whether it blocks.
- Record the reviewed SHA and result in the pull request when authorized.

Use the repository's review watcher separately. This skill does not replace
review-coverage checks.

## Handle failures

If `claude` is missing, authentication fails, or a flag is unsupported, report
the exact error. Check `claude --version` and `claude --help`.

Do not update Claude Code or change authentication without the user's request.

If the selected model is unavailable, follow the shared routing policy or
report the exact constraint. Report every fallback.

If a tool is denied, add one exact rule only after confirming that the action
is required. Do not switch to `bypassPermissions` to clear the error.

If Claude stops because of a turn, cost, or timeout limit, treat the result as
partial. Resume or rerun it before claiming completion.

Consult the official
[CLI reference](https://code.claude.com/docs/en/cli-usage),
[headless guide](https://code.claude.com/docs/en/headless), and
[model configuration](https://code.claude.com/docs/en/model-config) when the
installed CLI behavior has changed.
