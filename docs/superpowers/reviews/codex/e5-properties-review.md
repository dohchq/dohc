# E5 Properties Codex Review

Date: 2026-06-14

Scope: uncommitted E5 markdown properties/frontmatter slice on
`codex/desktop-experience-parity`, including the desktop properties panel,
WYSIWYG/frontmatter seam, shared Y.Doc frontmatter map wiring, hocuspocus
import/export parity, and the properties E2E gate.

Commands:

```sh
codex review --uncommitted
coderabbit review --agent -t uncommitted -c AGENTS.md
```

Temporary review traces were written under `/tmp/e5-properties-review*.raw` and
`/tmp/e5-properties-coderabbit-after-parser-owned-seam.raw`. They are not
committed because they include noisy CLI transcripts; this file records the
actionable review ledger.

## Findings Fixed

- P2: structured YAML values were stringified when editing a different
  property. Untouched arrays/objects now keep their parsed raw values.
- P2: shared property edits could clear and rewrite the full Y.Map, dropping
  concurrent frontmatter keys. Shared edits now patch only changed editable
  keys.
- P2: a read-mode refresh could reset dirty property edits before autosave.
  Dirty local properties now update the draft/saved view through the existing
  save seam.
- P2: renaming a user property to a reserved system key could delete the
  original user field. Reserved partials defer commit and preserve source keys.
- P2: WYSIWYG editing rendered and serialized raw frontmatter as document
  content. The editor now strips only parser-recognized frontmatter for editing
  and reattaches the original bytes on save.
- P2: truncated markdown reads exposed property/collab editing that could
  rewrite only the visible file prefix. Properties and collab are disabled for
  truncated markdown reads.
- P2: malformed, scalar, array, explicit `null`, and other non-map
  frontmatter-looking blocks could be swallowed as metadata. Parser helpers now
  preserve them as body text across desktop and hocuspocus.
- P2: hocuspocus always inserted an extra blank separator when projecting
  frontmatter. It now mirrors the desktop conditional separator.
- P2: duplicate editable property names collapsed values during local/shared
  rename. Duplicate rows are shown as invalid and are not committed until
  resolved.
- P3: the WYSIWYG frontmatter gate duplicated YAML heuristics and missed
  comment-only/anchor cases. It now delegates the decision to
  `parseFrontmatter` and only keeps the raw fence for reattachment.

## Closeout

Final direct CodeRabbit trace:
`/tmp/e5-properties-coderabbit-after-parser-owned-seam.raw`.

Result:

> `{"type":"complete","status":"review_completed","findings":0}`

Note: the outer `codex review --uncommitted` wrapper was stopped after the
scoped CodeRabbit pass inside it had already completed with zero findings. The
wrapper then spent time retrying subpackage Vitest/tsx command forms that fail
at startup in this WSL workspace; the authoritative test gates were run
directly with the known-good root commands.
