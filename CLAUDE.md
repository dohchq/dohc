@AGENTS.md

# Personal Preferences

## TypeScript

- Never use `any` unless 100% necessary or specifically instructed.

## Commands

- Don't run dev server commands (e.g., `pnpm dev`)—assume it's already
  running.
- Don't run build commands unless the task or an applicable repository gate
  requires them.
- Focus on checking commands like `pnpm typecheck` and `pnpm test`.

## Package Managers

- Use pnpm if the project already uses it, otherwise use bun.
- Never use npm or yarn.

## Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.

## General preferences

- If asked to do too much work at once, stop and state that clearly.
- If computer use is helpful, use the `codex-computer-use` skill with
  GPT-5.6-sol.

@.agents/model-routing.md

## Using Codex inside workflows and subagents

The workflow model parameter accepts only Claude models. Use a thin Claude
wrapper to run GPT-5.6-sol:

- Spawn a thin Claude wrapper agent with `model: 'opus', effort: 'low'` whose
  prompt instructs it to write a self-contained Codex prompt, run `codex exec`
  via Bash, and return the report (use `schema` on the wrapper to get
  structured output back).
- Use GPT-5.6-sol through the imported routing policy. Pass
  `-m gpt-5.6-sol` when the configured default differs.
- Label the wrapper with GPT-5.6-sol, such as
  `{label: 'gpt-5.6-sol:review-auth'}`. The workflow UI otherwise shows only
  the wrapper's Claude model.
- Codex runs can exceed Bash's 10-minute timeout: pass an explicit timeout, or
  run in background and poll for the report file.
- Parallel Codex implementation agents must use `isolation: 'worktree'`.
- Workflow token budgets only count Claude tokens; Codex work is free and
  invisible to `budget.spent()`.
