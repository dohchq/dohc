# Y.Doc PR #240 parity repair

## Outcome

The Rust richdoc projection now matches the current
`packages/ydoc-projection` serializer for all 26 fixtures the live TypeScript
oracle can produce. The five stale lossy expectations were regenerated and
renamed without `known-lossy-`; none of those five cases remains lossy in both
engines.

`code-language-backtick` remains a separate TypeScript oracle failure. It is
excluded and reported by the fixture-drift guard, not counted as passing
cross-engine parity.

## Per-case findings and proof

### `code-fence-collision`

- Current TypeScript output:

  ~~~~~text
  ````js
  before
  ```
  after
  ````
  ~~~~~

- Why: `rewriteCodeBlockFences` restores the original code text after the base
  serializer runs, then `backtickFence(content, 3)` chooses
  `max(3, longest backtick run + 1)`. The content contains a run of three
  backticks, so the opening and closing fences contain four.
- Previous Rust output:

  ~~~~~text
  ```js
  before
  ```
  after
  ```
  ~~~~~

  The fixed triple fence collided with the content and changed the block
  structure.
- Rust change: code blocks now collect raw descendant text (matching the TS
  `textContent` behavior) and use the same longest-run dynamic backtick rule.
- Proving test:
  `ydoc::projection_tests::code_block_uses_collision_free_backtick_fence`.
- Mutation result: replacing the dynamic fence with a fixed triple fence made
  the named test fail on its equality assertion with the previous Rust output
  above. Restoring the dynamic fence made the same test pass.

### `inline-code-backticks`

- Current TypeScript output:

  ```text
  ``a`b`` / `` `edge` `` / `  spaced  ` / `   `
  ```

- Why: adjacent text nodes carrying the same code-mark attributes are
  coalesced into one code run. `backtickFence(value, 1)` chooses one more
  backtick than the longest run in the value. A value beginning or ending in a
  backtick is padded inside the fence. A value with an edge ASCII space is also
  padded unless the value consists entirely of spaces; CommonMark then removes
  one padding space at each edge and reconstructs the original value.
- Previous Rust output:

  ```text
  `a`b` / ``edge`` /  `spaced`  / ``
  ```

  Rust always opened and closed the code mark with one backtick and its generic
  mark whitespace handling moved or discarded significant edge spaces.
- Rust change: inline code is rendered as a complete literal span before other
  marks are serialized, using the TS delimiter and padding rules. Consecutive
  runs with equal code-mark attributes share one fence. HTML-special characters
  stay raw inside code, as they do through the TS sentinel path.
- Proving test:
  `ydoc::projection_tests::inline_code_uses_collision_free_commonmark_delimiters`.
- Mutation result: forcing the inline fence back to one backtick made the named
  test fail on its equality assertion (`a`b` and `` `edge` `` collided).
  Restoring the dynamic rule made the same test pass.
- Additional proof:
  `adjacent_inline_code_runs_with_same_mark_share_one_fence`. Mutating the
  coalescing loop to stop after the first run failed on the assertion with
  `"`` a` ```b`"` instead of `"``a`b``"`; restoration passed.

### `headerless-table`

- Current TypeScript output:

  ```text

  | first  | row |
  | ------ | --- |
  | second | row |
  ```

- Why: before markdown serialization, `visit` changes every cell in table row
  zero to `tableHeader`, regardless of its incoming cell type. The first row is
  therefore promoted in place and is not duplicated as a body row.
- Previous Rust output:

  ```text

  |        |     |
  | ------ | --- |
  | first  | row |
  | second | row |
  ```

  Rust inserted a blank synthetic header and retained every source row in the
  body.
- Rust change: row zero is always rendered as the header row and body rendering
  starts at row one.
- Proving test:
  `ydoc::projection_tests::headerless_table_promotes_first_row_to_header`.
- Mutation result: restoring the blank header and rendering all rows in the
  body made the named test fail with the previous Rust output above. Restoring
  first-row promotion made the same test pass.

### `table-literal-pipe`

- Current TypeScript output:

  ```text

  | Value         | Other  |
  | ------------- | ------ |
  | left \| right | stable |
  ```

- Why: `prepareRenderedTableCell` scans the fully rendered cell and inserts a
  backslash before a pipe only when the immediately preceding backslash run has
  even length. Escaping happens before the table renderer computes UTF-16
  column widths, so the added backslash also lengthens the first column and its
  delimiter.
- Previous Rust output:

  ```text

  | Value        | Other  |
  | ------------ | ------ |
  | left | right | stable |
  ```

  The literal pipe was emitted as an extra table delimiter.
- Rust change: table cells now apply the same backslash-parity pipe scan before
  width calculation.
- Proving test:
  `ydoc::projection_tests::table_literal_pipes_are_escaped_before_width_measurement`.
- Mutation result: bypassing the escape scan made the named test fail with the
  previous Rust output above. Restoring the scan made the same test pass.
- Additional proof:
  `table_pipe_escaping_respects_existing_backslashes_and_break_entities`.
  Mutating the scan to escape every pipe failed because an already escaped
  `\|` became `\\|`; restoration passed. The same test covers normalization of
  `&lt;br&gt;` and `&amp;lt;br&amp;gt;` to `<br>`.

### `multi-block-table-cell-separator`

- Current TypeScript output:

  ```text

  | H               |
  | --------------- |
  | first<br>second |
  ```

- Why: the table renderer receives `cellLineSeparator: "<br>"`. GFM does not
  allow block nodes in table cells but does allow inline raw HTML, so the
  serializer represents a ProseMirror block boundary with visible inline
  `<br>`, not the old U+001F control character.
- Previous Rust output:

  ```text

  | H            |
  | ------------ |
  | first␟second |
  ```

  Here `␟` denotes the emitted U+001F control character.
- Rust change: block children in a table cell are joined with `<br>`, and
  escaped `<br>` entity spellings are normalized before width measurement.
  Code blocks in cells follow the complete TS `prepareTableCellBlock` rule:
  their language is discarded, each source line becomes collision-free inline
  code, and lines are joined with `<br>`.
- Proving test:
  `ydoc::projection_tests::multi_block_remote_table_cell_uses_gfm_inline_break`.
- Mutation result: changing the separator back to U+001F made the named test
  fail with `first\u{1f}second` and the shorter old width. Restoring `<br>` made
  the same test pass.
- Additional proof:
  `multiline_code_block_in_table_cell_uses_inline_code_and_breaks`. Disabling
  table-cell code lowering made the assertion fail with a flattened fenced
  block (` ````mermaid ... ```` `) inside the cell; restoration passed.

## Fixture audit and naming

The five regenerated semantic expectations are exactly the five outputs
explained above. No other fixture expectation or schema-coverage value changed.
Other regenerated fixture diffs are Yjs lineage churn limited to `updates`,
`mergedUpdateB64`, and update-only probe fields; the drift guard deliberately
normalizes those nondeterministic fields.

All five resolved case IDs and files lost the false `known-lossy-` prefix:

- `code-fence-collision`
- `inline-code-backticks`
- `headerless-table`
- `table-literal-pipe`
- `multi-block-table-cell-separator`

The live-oracle manifest now contains 26 richdoc projection fixtures. The
unproducible `code-language-backtick` case remains in the generator source and
the checker's self-expiring `knownOracleFailures` map, but is not presented as a
passing parity fixture.

## `code-language-backtick` owner decision

Input: a `codeBlock` whose `language` attribute is ``lang`tick`` and whose
content is `code`.

- Live TypeScript behavior: throws
  `could not restore a fenced code block serialization sentinel`.
  `rewriteCodeBlockFences` expects the serialized opening line to match
  `/(`{3,})([^`]*)$/`; the backtick in the info string prevents that match.
- Current Rust output:

  ~~~~~text
  ```lang`tick
  code
  ```
  ~~~~~

- Validity: this is not a valid CommonMark fenced code block. CommonMark 0.31.2
  permits either backtick or tilde fences, but an info string following a
  backtick fence may not contain a backtick:
  <https://spec.commonmark.org/0.31.2/#fenced-code-blocks>.
- Recommended behavior: serialize this case with a tilde fence and dynamically
  choose a fence longer than the longest tilde run in the content, for example:

  ~~~~~text
  ~~~lang`tick
  code
  ~~~
  ~~~~~

  That preserves both the content and the language attribute while remaining
  valid CommonMark. Rejecting the attribute or deleting/sanitizing its backtick
  would be less faithful. This report does not change either engine for this
  owner decision.

## Verification

- `node tools/rust-engine-program/check-fixture-drift.mjs`: passed; 78
  deterministic payloads matched, with one recorded oracle failure explicitly
  excluded and reported.
- `cargo test -p dohc-engine-collab`: passed (36 unit, 28 cross-engine, and 14
  durable-regime tests; one doc test ignored).
- `richdoc_projection_matches_typescript_byte_for_byte`: passed across all 26
  live-oracle projection fixtures.
- `git diff origin/main --stat -- packages/`: empty.
