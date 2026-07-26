# PR #243 — Codex-bot round 4

Commit: `92756b0edf70e37f2db1869bf503ee0a83e4d519`

Branch: `codex/rust-engine-rpc-e-moment-append`

The implementation is committed locally and has not been pushed. This report is
intentionally uncommitted.

## Findings addressed

### 1. Preserve newly opened conflict counts through the router

`router.rs` now derives `RoutedApply.conflicts_opened` from the structured
`ConflictApply.inserted` result:

- `Some(true)` maps to `1`.
- Replayed/already-present opens map to `0`.
- The complete structured conflict result is still returned.

Regression:
`router_counts_only_newly_inserted_replicated_open_conflicts` applies the same
logical `conflict.open` at two replication coordinates and verifies that only
the first application reports one newly opened conflict.

Mutation proof: replacing the mapping with a constant zero made this test fail
at the first count assertion (`left: 0`, `right: 1`).

### 2. Round-trip complete replicated moment metadata

Fast-forward adoption now persists the full metadata tuple used by local
writers: `origin`, `summary`, and `correlationId`. Both the moment-history row
and the live snapshot retain all three fields.

Storage migration ordinal 17 adds `metadata_summary` and
`metadata_correlation_id` to `moments`, `snapshots`, and
`fork_base_snapshots`. Snapshot reads, moment inserts, and snapshot upserts now
round-trip the complete tuple.

Regression:
`moment_append_persists_full_wire_payload_provenance` now verifies all three
metadata fields on both the adopted moment and its resulting snapshot.

### 3. Apply search policy to replicated indexing

The existing local search-policy implementation was moved into
`dohc-engine-files::search_policy`, with the runtime module re-exporting it.
This gives local and replicated writers one policy parser and resolver without
introducing a sync-to-runtime dependency cycle.

The replicated path now:

1. Recovers the workspace root from the store's canonical
   `.dohc/engine/engine.db` path.
2. Reads `.dohc/files.toml` and `.dohc/visibility.toml` through the shared
   fail-closed policy reader.
3. On a healthy policy, removes the object's old FTS row and inserts a new row
   only when the content is text and the effective policy says the path is
   tracked, searchable, and not hidden.
4. On a degraded policy, or when the workspace root cannot be established,
   leaves existing file-index rows frozen and marks any existing
   `engine_search_index_state` row as `file_policy_degraded=1`.

Regression:
`moment_append_search_index_respects_files_and_visibility_policy` verifies that
a replicated write under a `files.toml` `searchable = false` rule is absent
from FTS, a replicated write under a `visibility.toml` `hidden` rule is absent,
and an ordinary searchable replicated write is present.

Mutation proof: bypassing `path_is_search_indexed` caused the test to fail
because `private-object` appeared in FTS.

### 4. Reject incomplete payload-before tuples

Validation now enforces the migration-15 column contract for
`payloadBeforePath` and `payloadBeforeBlobSha256`: both must be absent, or both
must be present and non-empty. Invalid envelopes fail with
`SyncError::InvalidInput` before history mutation or acknowledgement.

Regression:
`moment_append_rejects_each_incomplete_payload_before_tuple_without_ack`
covers both path-only and digest-only payloads and verifies no moment or peer
ack is written.

### 5. Delete the actual live alias after path divergence

For an adopted replicated delete, alias removal now uses the path from the
matched local snapshot when one exists. The remote payload path is only the
fallback when no local snapshot exists. A stale remote path therefore cannot
leave the live local alias behind.

Regression:
`replicated_delete_after_path_divergent_rename_removes_the_live_alias` performs
a local-head-matching replicated rename from `old.md` to `new.md`, then applies
a remote delete carrying `old.md`. It verifies that `new.md` is removed and the
snapshot is deleted.

### 6. Bound replicated moment and object identifiers

`momentId` and `objectId` now use the shared replicated-identifier validator,
which rejects empty values, ASCII controls, and values beyond
`MAX_IDENTIFIER_BYTES` (512 bytes). Failures remain hard
`SyncError::InvalidInput` errors at this layer.

Regression:
`moment_append_rejects_overlong_moment_and_object_ids_without_ack` covers each
identifier independently at 513 bytes and verifies that the peer ack does not
advance.

## Verification evidence

All commands used:

- `CARGO_TARGET_DIR=C:/w/_targets/rpcema`
- `TEMP=C:/w/_targets/rpcema-tmp`
- `TMP=C:/w/_targets/rpcema-tmp`
- `CARGO_BUILD_JOBS=2`

Final verification:

- `cargo test -p dohc-engine-sync` — passed: 128 unit tests, 7 r10cc probes,
  1 security-contract test, 0 failures (136 total).
- `cargo fmt --all -- --check` — passed.
- `cargo clippy -p dohc-engine-sync --all-targets -- -D warnings` — passed.
- `git diff --check` — passed before commit.
- `git diff --numstat -- packages` — empty; the `packages/` oracle remained
  read-only.

No full repository gate was run, per instruction.
