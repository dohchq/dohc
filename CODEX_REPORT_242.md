# Codex report — PR #242 reviewer findings

## Finding 1 (P1): preserve pending resolves when a later envelope fails

### Fix

Deferred `conflict.resolve` results are now persisted in
`replication_pending_resolves`, keyed by the imported replication coordinate.
The conflict applier writes the structured decision inside the same transaction
that subsequently inserts the imported `replication_log` row and advances the
peer ack. The table's foreign key is deferred so the sidecar can be inserted by
the domain applier before the generic envelope wrapper inserts the log row, while
still enforcing at commit that no sidecar exists without its imported
coordinate.

When an idempotent pull retry produces `ApplyOutcome::Skipped`, the relay reads
the coordinate's persisted decision and adds it back to `pending_resolves`.
Thus a later batch failure can still prevent the relay cursor from advancing,
but it cannot erase an earlier acknowledged decision; every retry re-surfaces
the decision until a pull completes and its cursor is committed.

I chose atomic persistence rather than recomputing the decision from current
conflict state. Recomputing is simpler only for the immediate-retry case:
envelopes between the resolve and the later failure may have changed the
conflict graph, so replay-time inference can produce a different reason or no
pending decision at all. The coordinate-keyed sidecar preserves the exact
original result.

### Named behavioral test

`tests::relay_retry_surfaces_pending_resolve_acked_before_later_error`

The test pulls a batch containing an unmatched `conflict.resolve`, followed by a
`version.create` whose referenced text blob is absent. It verifies that:

- the first pull errors;
- the resolve coordinate is already acknowledged;
- the relay cursor is not committed;
- after hydrating the later blob, the retry succeeds with the resolve counted as
  skipped and its original `PendingResolve` surfaced.

### Fail-before-fix evidence

Run before production changes:

```text
test tests::relay_retry_surfaces_pending_resolve_acked_before_later_error ... FAILED

thread 'tests::relay_retry_surfaces_pending_resolve_acked_before_later_error' ... panicked at crates\dohc-engine-sync\src\tests.rs:4202:5:
assertion `left == right` failed: the retry must reconstruct the already-acked pending decision
  left: []
 right: [PendingResolve { remote_conflict_id: "missing-on-receiver", local_conflict_id: None, path: Some("notes/retry.md"), reason: UnmatchedTarget }]

test result: FAILED. 0 passed; 1 failed
```

After the fix:

```text
test tests::relay_retry_surfaces_pending_resolve_acked_before_later_error ... ok
test result: ok. 1 passed; 0 failed
```

### Mutation proof

I temporarily removed only the skipped-coordinate pending-resolve lookup in
`relay.rs`, leaving the test intact. The named test failed behaviorally:

```text
test tests::relay_retry_surfaces_pending_resolve_acked_before_later_error ... FAILED

assertion `left == right` failed: the retry must reconstruct the already-acked pending decision
  left: []
 right: [PendingResolve { remote_conflict_id: "missing-on-receiver", local_conflict_id: None, path: Some("notes/retry.md"), reason: UnmatchedTarget }]

test result: FAILED. 0 passed; 1 failed
```

The lookup was restored and the named test passed again.

## Finding 2 (P2): reject unknown fork snapshot content kinds

### Oracle acceptance set

The TypeScript oracle's `VersionCreateForkSnapshot.contentKind` is optional and
typed as `VersionedFileContentKind`; that type is exactly:

```text
"text" | "binary"
```

Therefore the accepted wire set is:

- absent (legacy/default text);
- `"text"`;
- `"binary"`.

The oracle declares no additional fork-snapshot content kinds. Y.Doc's
`"plaintext"` / `"richdoc"` vocabulary is a different content-kind domain and
is not accepted by the versioned-file fork snapshot contract.

### Fix and rejection behavior

`validate_shipped_snapshots` now explicitly allowlists absent, `"text"`, and
`"binary"`. Any other string, including `"richdoc"`, returns
`SyncError::InvalidInput` before snapshot materialization.

This follows the existing malformed-envelope precedent in the same file:
invalid shipped paths, non-canonical paths, duplicate paths, malformed
`forkSnapshots`, and invalid version kinds all return `InvalidInput`. The
envelope transaction rolls back, its replication coordinate is not journaled or
acknowledged, and the relay pull returns a hard local error. It is not treated as
an acknowledged per-envelope skip.

### Named behavioral test

`tests::version_create_shipped_snapshot_accepts_only_oracle_content_kinds`

The test verifies that absent, explicit `"text"`, and `"binary"` snapshots still
apply, while a `"richdoc"` snapshot backed by a present text blob is rejected
without advancing the peer ack.

### Fail-before-fix evidence

Run before production changes:

```text
test tests::version_create_shipped_snapshot_accepts_only_oracle_content_kinds ... FAILED

thread 'tests::version_create_shipped_snapshot_accepts_only_oracle_content_kinds' ... panicked at crates\dohc-engine-sync\src\tests.rs:3228:5:
assertion failed: matches!(apply_replication_envelope(&mut engine, &operation, &NoFaults,
    &NoLiveLeases),
    Err(SyncError::InvalidInput
    { reason: "version.create shipped snapshot content kind is invalid" }))

test result: FAILED. 0 passed; 1 failed
```

After the fix:

```text
test tests::version_create_shipped_snapshot_accepts_only_oracle_content_kinds ... ok
test result: ok. 1 passed; 0 failed
```

### Mutation proof

I temporarily removed only the new content-kind allowlist from
`version_apply.rs`, leaving the test intact. The named test failed behaviorally:

```text
test tests::version_create_shipped_snapshot_accepts_only_oracle_content_kinds ... FAILED

assertion failed: matches!(apply_replication_envelope(&mut engine, &operation, &NoFaults,
    &NoLiveLeases),
    Err(SyncError::InvalidInput
    { reason: "version.create shipped snapshot content kind is invalid" }))

test result: FAILED. 0 passed; 1 failed
```

The allowlist was restored and the named test passed again.

## Verification

Every Cargo command used:

```text
CARGO_TARGET_DIR=C:/w/_targets/rpce
TEMP=C:/w/_targets/rpce-tmp
TMP=C:/w/_targets/rpce-tmp
```

Final successful checks:

```text
cargo test -p dohc-engine-sync
  99 unit tests passed
  7 r10cc probe tests passed
  1 security-contract test passed

cargo test -p dohc-engine-storage --all-features
  26 unit tests passed
  12 storage_r04 tests passed

cargo fmt --all -- --check
  passed

cargo clippy -p dohc-engine-sync --all-targets --all-features -- -D warnings
  passed
```

`git diff origin/main --stat -- packages/` is empty; the TypeScript oracle was
not modified.

## Unclosed items

None. Both findings, both behavioral regressions, both mutation checks, the
affected migration path, formatting, and the required clippy run are closed.
