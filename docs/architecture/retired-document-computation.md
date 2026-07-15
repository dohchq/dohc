# Retired document computation

Decision date: 2026-07-16

dohc does not execute formulas, live totals, or query languages embedded in
Markdown. The legacy cloud evaluators were removed during the local-first
transition; retaining parser-only editor nodes made unsupported behavior look
like a product capability.

The retirement boundary is explicit:

- `{key: value}` remains a structured inline value.
- Bare brace expressions and the former `{= ...}` syntax are ordinary prose.
- All fenced blocks use the normal Markdown code-block schema. Language labels
  do not opt a block into execution.
- Computation belongs in explicit source-backed sites, scripts, database tools,
  or agent workflows whose code and outputs are inspectable.
- Imported or existing Markdown text is never deleted merely because it
  resembles retired syntax.

Reintroducing document computation requires a new product decision and a
complete implementation: syntax, execution, authorization, dependency
tracking, rendering, failure behavior, and tests. Parser-only placeholders are
not permitted.
