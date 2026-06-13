# E5 Graph Codex Review

Date: 2026-06-13

Scope: uncommitted E5 graph slice on `codex/desktop-experience-parity`.

Command:

```sh
CODEX_HOME=/tmp/codex-e5-graph-review codex review --uncommitted
```

Temporary review traces were written under `/tmp/e5-graph-review-*.raw`. They are
not committed because they include noisy CLI transcripts; this file records the
actionable review ledger.

## Findings Fixed

- P1: bounded graph scans before buffering file bodies. Added per-file and
  aggregate graph text caps.
- P2: capped graph edges before returning over IPC.
- P2: replaced the collision-prone graph refresh key with a stable key from
  latest change-set id, counts, and file paths.
- P2: preserved root-relative Markdown links as workspace-root targets.
- P2: kept ordinary Markdown links relative to their source document instead of
  falling back to workspace root.
- P2: kept ambiguous bare wikilinks unresolved instead of guessing a root file.
- P2: bounded link-candidate processing globally, including unresolved,
  duplicate, and self links.
- P2: skipped non-document wikilinks and known non-markdown local asset links.
- P2: allowed dotted extensionless note names such as `v1.0` to resolve to
  local Markdown documents.
- P2: handled Markdown link destinations with balanced parentheses.
- P2: handled escaped Markdown link destination characters for spaces and
  parentheses while still rejecting actual backslash path separators.
- P2: normalized CRLF before fenced-code matching.
- P3: ignored indented code blocks.
- P3: made fenced and inline code stripping delimiter-aware, including longer
  fences and multi-backtick inline spans.
- P3: hid valid self-links without reporting them as unresolved.

## Closeout

Final review trace: `/tmp/e5-graph-review-clean-final5.raw`.

Final result:

> I did not identify any discrete correctness, security, or maintainability
> issues in the current changes.
