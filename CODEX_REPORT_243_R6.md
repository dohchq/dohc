# PR #243 round-6 report

Branch: `codex/rust-engine-rpc-e-moment-append`  
Commit: `673adeb8` (`fix(engine): complete moment metadata handling`)

## Findings addressed

1. Local plaintext and binary snapshot writers now replace the complete metadata
   tuple. Local writers with no summary/correlation ID explicitly store `NULL`,
   so imported peer metadata cannot survive a newer local head. Rename/rollback
   snapshot records carry their intentional metadata values instead of inheriting
   stale columns from the row being replaced.
2. `metadata_summary` and `metadata_correlation_id` now flow through moment and
   snapshot domain read models, in-band reads, conflict/merge snapshot reads, and
   the plaintext RPC serializers as `metadataSummary` and
   `metadataCorrelationId`.
3. The moment-metadata migration and related mutation-proof comments now identify
   the migration as ordinal 18.
4. Files/visibility policy parsing reports a non-array `rule` error once, with a
   regression covering both parsers.
5. The moment-apply policy test now covers degraded policy behavior: an invalid
   files policy freezes the previously indexed FTS row while the imported moment
   still applies.

`packages/` was not modified.

## Verification

- `cargo test -p dohc-engine-sync -p dohc-engine-runtime` — passed.
  - `dohc-engine-sync`: 161 unit tests passed, plus 7 R10CC probes and the
    security-contract test.
  - All scoped runtime unit/integration/doc tests passed.
- `cargo test -p dohc-engine-sync moment_apply_tests::local_overwrite_clears_imported_snapshot_metadata -- --exact` — passed after restoration.
- `cargo test -p dohc-engine-files search_policy::tests::non_array_rule_is_reported_once -- --exact` — passed.
- `cargo check -p dohc-workspace-engine` — passed.
- `cargo clippy -p dohc-engine-sync -p dohc-engine-runtime --all-targets -- -D warnings` — passed.
- `cargo fmt --all -- --check` — passed.
- `git diff --check` — passed.

Environment:

```text
CARGO_TARGET_DIR=C:/w/_targets/rpcema
TEMP=C:/w/_targets/rpcema-tmp
TMP=C:/w/_targets/rpcema-tmp
```

## Mutation proof for finding 1

Temporarily removed the local text snapshot upsert assignments for
`metadata_summary` and `metadata_correlation_id`, then ran:

```text
cargo test -p dohc-engine-sync moment_apply_tests::local_overwrite_clears_imported_snapshot_metadata -- --exact
```

The regression failed as intended:

```text
left:  ("api", Some("peer summary"), Some("peer correlation"))
right: ("api", None, None)
```

After restoring both assignments, the exact test passed.

## Worktree note

This report is intentionally uncommitted. The pre-existing deletion of
`CODEX_REPORT_243_R5.md` was preserved and excluded from the round-6 commit.
