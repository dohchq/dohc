# PR #243 round-7 report

Branch: `codex/rust-engine-rpc-e-moment-append`  
Commit: `4fbe3a40` (`fix(sync): preserve rollbackable imported preimages`)

## Findings addressed

1. A claimed text-capture dedupe now replaces the complete snapshot metadata
   tuple. Transferring ownership to the capture origin clears an imported
   summary and correlation ID instead of retaining peer provenance on a
   capture-owned head.
2. Imported moments now persist the complete rollback preimage identity:
   object, version, path, timestamp, head ID, and metadata, in addition to the
   existing content digest. Rollback prefers that durable identity and retains
   producer lookup as the compatibility path for older/local rows.
3. Ordinal 19 (`v1-moment-rollback-preimage`) adds those columns and backfills
   existing moments from their producer or, for producer-less shipped heads,
   the frozen `fork_base_snapshots` row.

`packages/` was not modified.

## Verification

Environment:

```text
CARGO_TARGET_DIR=C:/w/_targets/rpcema
TEMP=C:/w/_targets/rpcema-tmp
TMP=C:/w/_targets/rpcema-tmp
```

Passed:

- `cargo test -p dohc-engine-sync -p dohc-engine-domain -p dohc-engine-storage`
- `cargo test -p dohc-engine-domain --test capture a_claimed_dedupe_transfers_ownership_to_capture -- --exact`
- `cargo test -p dohc-engine-sync moment_apply_tests::moment_append_after_a_shipped_fork_head_rolls_back_after_reopen -- --exact`
- `cargo test -p dohc-engine-storage migration::tests::rollback_preimage_migration_backfills_a_shipped_fork_head -- --exact`
- `cargo fmt --all -- --check`
- `cargo clippy -p dohc-engine-sync -p dohc-engine-domain -p dohc-engine-storage --all-targets -- -D warnings`
- `git diff --check`

The shipped-head regression materializes a `version.create` fork snapshot,
applies the first remote edit, closes the store, reopens the database, rolls
the edit back, and verifies the exact shipped text, head ID, timestamp, and
metadata tuple.

## Mutation proofs

### Claimed-dedupe metadata clearing

Temporarily removed the two optional-column clears from the ownership-transfer
update and ran the exact capture test. It failed as intended:

```text
left:  ("capture-test", Some("peer summary"), Some("peer correlation"))
right: ("capture-test", None, None)
```

After restoration, the exact test passed.

### Producer-less shipped-head rollback

Temporarily bypassed the persisted rollback-preimage lookup and ran the exact
sync regression. The post-reopen rollback failed as intended:

```text
StateCorrupt { reason: "moment preimage producer is missing" }
```

After restoration, the exact test passed.

## Worktree note

This report is intentionally uncommitted. The pre-existing deletion of
`CODEX_REPORT_243_R6.md` was preserved and excluded from the round-7 commit.
