# Model routing

This file is the canonical model-selection policy for Claude and Codex.
`CLAUDE.md` imports it. Host-specific skills own invocation mechanics.

## Rules

- Follow an explicit user model choice.
- Do not force a model from a task skill.
- Use the configured default when it fits the work.
- Override the default only for a clear quality, latency, cost, or review need.
- Judge the output, not the model label.
- Escalate when the first output does not meet the bar.
- Follow stricter repository rules for required reviewers or workflows.
- Never use Codex Ultra.

## Observed scorecard

Higher is better. Cost score reflects this user's effective cost and limits,
not vendor list price.

Intelligence measures unsupervised task difficulty. Taste covers UI, copy,
code quality, and API design.

| Model         | Cost score | Intelligence | Taste |
| ------------- | ---------: | -----------: | ----: |
| `gpt-5.6-sol` |          9 |            8 |     6 |
| `opus-5`      |          8 |            7 |     8 |
| `sonnet-5`    |          9 |            5 |     7 |
| `fable-5`     |          2 |            9 |     9 |

Treat these scores as observed preferences, not vendor benchmarks.

## Current model roles

### Codex models

| CLI model     | Use                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `gpt-5.6-sol` | Default Codex worker for implementation, analysis, migrations, computer use, and complex open-ended work. |

This policy deliberately uses one Codex model. Cheaper tiers do not justify
more routing branches under this user's cost limits.

### Claude models

| CLI alias | Use                                                                                  |
| --------- | ------------------------------------------------------------------------------------ |
| `fable`   | The hardest, longest, most ambiguous work, especially when taste matters.            |
| `opus`    | Complex reasoning, independent review, and user-facing work that needs strong taste. |
| `sonnet`  | Routine, well-scoped Claude work, including implementation, writing, and review.      |

Never use Haiku.

Use Claude aliases unless the task requires a pinned model version. Aliases
follow the account's current provider and model configuration.

## Choose effort

Bias toward more effort. Reliability matters more than token or latency
savings.

- Use `low` only for trivial, reversible work with obvious verification.
- Use `medium` for routine, well-scoped work.
- Use `high` for multi-file work, uncertain requirements, or meaningful
  consequences.
- Use `xhigh` for difficult work with interacting constraints or
  hard-to-verify results.
- Use `max` for the hardest work or when a mistake would be costly.

When two levels seem reasonable, choose the higher level. Do not reduce effort
to save tokens, cost, or latency.

## Common routes

- Use Sol for bulk work, mechanical changes, clear implementation, analysis,
  migrations, investigation, and computer use.
- Use Sonnet for routine, well-scoped Claude work.
- Use Fable or Opus for user-facing UI, copy, and API design.
- Require a model with a taste score of at least 7 for user-facing decisions.
- Use Fable or Opus for review. Add Sol when an independent Codex perspective
  will improve coverage.
- Pair Codex implementation with Claude review for taste-sensitive code.
- Choose Fable or Sol for the hardest ambiguous work. Match the model to the
  dominant risk: taste and long autonomy, or local coding and tool execution.
- If a first pass misses the bar, use the stronger fit. Cost must not block
  escalation.

The caller remains responsible for scope, permissions, verification, and the
final result.

## Sources

- [OpenAI Codex model selection](https://developers.openai.com/codex/models)
- [OpenAI GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
