# P1 file-search index maintenance report

## Changes

- Added file-search index maintenance to the same SQLite transaction as all four
  confirmed missing mutation paths:
  - watcher/external text capture: policy-aware text upsert;
  - watcher/external binary capture: index delete, matching RPC binary write;
  - watcher/external retire: index delete;
  - Y.Doc settle projection: policy-aware projected-text upsert.
- Exposed transaction-scoped domain capture operations and added transaction hooks
  for conflict resolution and named-version creation. The domain remains free of
  search policy: the runtime actor supplies the FTS work.
- Closed the same sibling-path defect in the sync crate:
  - Y.Doc direct projection, base projection, and deferred projection drain;
  - mirrored conflict resolution for text, binary, and deletion results;
  - replicated named-version creation for copied and shipped snapshot heads.
- Added a shared sync-side FTS helper so all sync mutation paths use the same
  policy/degraded-state behavior.
- Added runtime integration coverage which certifies the current index before each
  mutation. This prevents `ensure_search_index_for_version` from rebuilding an
  already-divergent index and hiding the defect under test.
- No schema or migration changes were made.

## File-head mutation enumeration

`N/A` means the audited operation does not mutate plaintext file heads and
therefore must not maintain `engine_search_files_fts`.

| Surface | Mutation path | File-head effect | FTS before | FTS after |
| --- | --- | --- | --- | --- |
| Runtime actor | RPC text write | Creates/replaces a live text head | In-transaction upsert | Unchanged: in-transaction upsert |
| Runtime actor | RPC binary write | Creates/replaces a live binary head | In-transaction delete | Unchanged: in-transaction delete |
| Runtime actor | RPC rename | Retires old path and creates new path/head | In-transaction old-path delete plus conditional new text upsert | Unchanged |
| Runtime actor | RPC delete | Retires the live head | In-transaction delete | Unchanged |
| Runtime actor | RPC rollback | Replaces the live head with a historical object | In-transaction delete plus conditional text upsert | Unchanged |
| Runtime actor | RPC merge | Creates/replaces merged heads | In-transaction conditional upsert/delete | Unchanged |
| Runtime actor | Capture text ingest | Creates/replaces a live text head | **Missing** | In-transaction policy-aware upsert |
| Runtime actor | Capture binary ingest | Creates/replaces a live binary head | **Missing** | In-transaction delete, identical to RPC binary write |
| Runtime actor | Capture retire | Retires the live head | **Missing** | In-transaction delete |
| Runtime actor | Y.Doc settle projection | Creates/replaces the projected text head | **Missing** | In-transaction policy-aware upsert |
| Runtime actor | Local conflict resolution | Replaces or retires the conflicted head | **Missing** | Transaction hook performs conditional text upsert or delete |
| Runtime actor | Named-version creation | Copies the source version's heads into the new version | No FTS rows were created in the copy transaction; later ensure could build because the new version had no state row | Transaction hook builds/certifies the new version's index before commit |
| Runtime actor | Active-version switch | No database head mutation; changes active pointer and schedules materialization | N/A | N/A |
| Runtime actor | Conflict open | Records conflict metadata only | N/A | N/A |
| Runtime actor | Local Y.Doc update recording | Updates CRDT state only; the file head changes at settle | N/A | N/A |
| Runtime actor | Secret capture/retire/restore/fork | Mutates isolated encrypted secret tables, which are excluded from plaintext FTS | N/A | N/A |
| Runtime actor | Mutation preflight | Read-only | N/A | N/A |
| Sync | `moment.append` text/binary/rename/delete apply | Creates, replaces, renames, or retires heads | In-transaction policy-aware upsert/delete | Unchanged behavior, refactored through shared helper |
| Sync | Y.Doc direct projection apply | Creates/replaces projected text head | **Missing** | In-transaction policy-aware upsert |
| Sync | Y.Doc base projection apply | Creates/replaces projected text head | **Missing** | In-transaction policy-aware upsert |
| Sync | Y.Doc deferred projection drain | Creates/replaces projected text head | **Missing** | In-transaction policy-aware upsert |
| Sync | Mirrored conflict resolution: text | Replaces conflicted head with text | **Missing** | In-transaction delete/upsert |
| Sync | Mirrored conflict resolution: binary | Replaces conflicted head with binary | **Missing** | In-transaction delete |
| Sync | Mirrored conflict resolution: deletion | Retires conflicted head | **Missing** | In-transaction delete |
| Sync | Replicated named-version creation | Copies local heads and installs shipped snapshot heads | **Missing** | Indexes every copied/shipped snapshot head before the version transaction commits |
| Sync | Conflict open | Records conflict metadata only | N/A | N/A |
| Sync | Verbatim replicated conflict resolution | Closes conflict metadata only; content arrives through indexed `moment.append` | N/A | N/A |
| Sync | Secret apply/fork | Mutates isolated encrypted secret tables, excluded from plaintext FTS | N/A | N/A |
| Sync | Workspace initialization | Creates workspace/version metadata without file heads | N/A | N/A |

## Integration tests

Added `crates/dohc-engine-runtime/tests/fts_mutation_paths.rs`:

1. `capture_text_ingest_and_retire_update_certified_search_index`
   verifies captured text becomes searchable and is removed on retire.
2. `ydoc_settle_replaces_old_search_content_with_projected_text`
   verifies settled projected text replaces the old searchable content.
3. `binary_capture_matches_rpc_binary_write_search_index_behavior`
   verifies both binary paths remove any prior text row, including by direct raw
   FTS-row comparison after actor shutdown.

## Mutation proof

Each index operation below was commented out independently. The named test was
run to a behavioral assertion failure, the operation was restored, and the same
test was rerun to a pass. All temporary comments were removed.

### Capture text ingest

Command:

```text
cargo test -p dohc-engine-runtime --test fts_mutation_paths capture_text_ingest_and_retire_update_certified_search_index -- --exact
```

Failure with the text-capture upsert removed:

```text
assertion `left == right` failed: capture ingest must become visible without relying on an index rebuild
  left: []
 right: ["notes/captured.md"]
test result: FAILED. 0 passed; 1 failed
```

Pass after restoration:

```text
test capture_text_ingest_and_retire_update_certified_search_index ... ok
test result: ok. 1 passed; 0 failed; 2 filtered out
```

### Capture retire

Command:

```text
cargo test -p dohc-engine-runtime --test fts_mutation_paths capture_text_ingest_and_retire_update_certified_search_index -- --exact
```

Failure with the retire delete removed:

```text
capture retire must remove the stale search result, got [SearchResult { surface: File, path: "notes/captured.md", title: "notes/captured.md", line: 1, preview: "capturemutationneedle", ... }]
test result: FAILED. 0 passed; 1 failed
```

Pass after restoration:

```text
test capture_text_ingest_and_retire_update_certified_search_index ... ok
test result: ok. 1 passed; 0 failed; 2 filtered out
```

### Capture binary ingest

Command:

```text
cargo test -p dohc-engine-runtime --test fts_mutation_paths binary_capture_matches_rpc_binary_write_search_index_behavior -- --exact
```

Failure with the binary-capture delete removed:

```text
assertion `left == right` failed: capture and RPC binary writes must both delete the prior text FTS row
  left: (1, 0)
 right: (0, 0)
test result: FAILED. 0 passed; 1 failed
```

Pass after restoration:

```text
test binary_capture_matches_rpc_binary_write_search_index_behavior ... ok
test result: ok. 1 passed; 0 failed; 2 filtered out
```

### Y.Doc settle

Command:

```text
cargo test -p dohc-engine-runtime --test fts_mutation_paths ydoc_settle_replaces_old_search_content_with_projected_text -- --exact
```

Failure with the settle upsert removed:

```text
assertion `left == right` failed: settle must index the projected text in its mutation transaction
  left: []
 right: ["notes/live.md"]
test result: FAILED. 0 passed; 1 failed
```

Pass after restoration:

```text
test ydoc_settle_replaces_old_search_content_with_projected_text ... ok
test result: ok. 1 passed; 0 failed; 2 filtered out
```

## Canonical gate

Environment and dependency install:

```powershell
$env:TEMP='C:/w/_targets/filefts/tmp'
$env:TMP='C:/w/_targets/filefts/tmp'
$env:CARGO_TARGET_DIR='C:/w/_targets/filefts'
pnpm install --frozen-lockfile
```

`pnpm install --frozen-lockfile` completed successfully with the lockfile
unchanged. The canonical command was then run:

```powershell
node tools/rust-engine-program/run-rust-checks.mjs
```

Final verdict line:

```text
- 2026-07-28T06:00:34.184Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=PASS
```

## Anything not closed

None. Every audited plaintext file-head mutation now updates or constructs its
version-scoped FTS state within the same database transaction. Secret mutations
remain intentionally outside plaintext file search.
