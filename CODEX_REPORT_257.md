# PR #257 review closure report

Branch head reviewed: `c845b745` plus the fixes in this commit.

## Findings

### 1. `PRRT_kwDOSk1N0c6T4lGG` — initial Y.Doc open drops buffered remote updates

- Disposition: fixed.
- Change: the initial generation now forwards every update buffered before
  installation and returns `Y.encodeStateAsUpdate(canonicalDoc)` instead of
  the provider's stale pre-update encoding.
- Proving test: `mutation proof: installs remote updates buffered during the initial Y.Doc open`
  in `workspaceEngineCapture.test.ts`.
- Mutation result: restoring the buffer discard and `current.initialUpdate`
  made the assertion fail with renderer text `"base"` instead of
  `"base+remote"`. The fix was restored and the test passes.

### 2. `PRRT_kwDOSk1N0c6T4_I4` — duplicate initial-open buffer loss

- Disposition: fixed by the same change as finding 1.
- Proving test: `mutation proof: installs remote updates buffered during the initial Y.Doc open`.
- Mutation result: same assertion-proven failure as finding 1; restored and
  passing.

### 3. `PRRT_kwDOSk1N0c6T4lGH` — merge selects an older matching conflict

- Disposition: fixed.
- Change: Rust returns the exact `conflictId` produced by
  `MergeTextFileResult::Conflict`; the client contract decodes it; the live
  store looks up that id rather than the first matching path/version triple.
- Proving tests:
  - `merge_conflict_returns_the_exact_created_conflict_id`
  - `mutation proof: returns the conflict id created by this merge`
- Mutation results:
  - Removing `conflictId` from the Rust response failed the Rust assertion that
    the field is a string.
  - Restoring tuple-based lookup returned `"conflict"` instead of
    `"created-conflict"` and failed the desktop assertion.
  Both fixes were restored and both tests pass.

### 4. `PRRT_kwDOSk1N0c6T4lGK` — 16,385–49,152 byte binary JSON arrays exceed the wire limit

- Disposition: fixed.
- Change: in-band binary byte arrays are limited by the negotiated collection
  ceiling of 16,384 elements; larger values use `versionedBinary.writeBlob`.
- Proving test: `mutation proof: routes a 16,385-byte binary around the wire collection limit`
  in `versionedLiveAdapter.test.ts`.
- Mutation result: restoring the 48 KiB branch selected
  `versionedBinary.write` instead of `versionedBinary.writeBlob` and failed the
  method assertion. Restored and passing.

### 5. `PRRT_kwDOSk1N0c6T4_I1` — 48–128 KiB captured text cannot be read

- Disposition: refuted.
- Evidence: `versioned_text_read` passes
  `MAX_DESKTOP_CAPTURE_TEXT_BYTES` (`128 * 1024`) to
  `read_text_inband`. That domain method uses the caller-supplied cap in the
  single SQL hydration query. The 48 KiB
  `dohc_engine_domain::INBAND_CONTENT_CAP_BYTES` cited by the finding is used
  by binary/history response paths, not `versionedText.read`.
- Proving test: `the_read_surface_reflects_rpc_writes_and_autonomous_capture`
  now asserts that an autonomously captured 64 KiB text file is returned with
  its full body through `versionedText.read`.
- Mutation result: changing the endpoint to pass the unrelated 48 KiB cap
  failed the assertion with `None` instead of `Some(65536)`. The 128 KiB call
  was restored and the test passes.

### 6. `PRRT_kwDOSk1N0c6T4_Iy` — failed run-attribution teardown loses the live run

- Disposition: fixed.
- Change: attribution clear errors now propagate. A finalized live run is
  removed only after clear succeeds, so a duplicate completion notification
  can retry teardown. App-quit cleanup follows the same clear-before-delete
  ordering.
- Proving test: `mutation proof: retains a finalized run until attribution teardown succeeds`
  in `chatDispatchService.test.ts`. The checked sibling pre-spawn failure path
  is covered by `retains a pre-spawn reservation when attribution teardown fails`.
- Mutation result: restoring the swallowed clear error made
  `hasLiveRun(workspace)` return `false` instead of `true` after the failed
  teardown. Independently restoring the pre-spawn swallow made its activation
  resolve instead of reject/retain the reservation. Restored and passing.

### 7. `PRRT_kwDOSk1N0c6T4_I0` — rejected capture author is remembered for reopen

- Disposition: fixed.
- Change: `rememberCaptureAuthor` now runs only after
  `adapter.setCaptureAuthor` succeeds.
- Proving test: `mutation proof: does not remember capture authorship rejected by the daemon`
  in `workspaceEngineCaptureLiveStore.test.ts`.
- Mutation result: moving the remember call before the RPC caused subsequent
  generations to see the rejected agent author instead of `[null, null]`.
  Restored and passing.

### 8. `PRRT_kwDOSk1N0c6T4lGJ` — daemon watcher degradation never reaches capture health

- Disposition: fixed.
- Change: daemon-owned capture polls `watcher.status` every five seconds and
  reports unhealthy when the watcher is stopped, degraded, or terminal.
  Polling is single-instance and is cancelled on stop.
- Proving test: `mutation proof: polls daemon watcher degradation after startup`
  in `workspaceEngineCapture.test.ts`.
- Mutation result: restoring the one-time store-open success report produced
  outcomes `[true]` instead of `[true, false]` and failed the assertion.
  Restored and passing.

### 9. `PRRT_kwDOSk1N0c6T4lGL` — secret-only daemon switch reports zero changes

- Disposition: fixed.
- Change: daemon-mode switch counting includes the protected-file
  materialization plan in addition to plaintext/binary metadata differences.
- Proving test: `mutation proof: counts a secret-only daemon version switch`
  in `workspaceEngineCapture.test.ts`.
- Mutation result: removing the protected operation count returned
  `changedFileCount: 0` instead of `1`. Restored and passing.

### 10. `PRRT_kwDOSk1N0c6T4_I2` — duplicate secret-file switch count omission

- Disposition: fixed by the same change as finding 9.
- Proving test: `mutation proof: counts a secret-only daemon version switch`.
- Mutation result: same `0` versus `1` assertion failure as finding 9;
  restored and passing.

### 11. `PRRT_kwDOSk1N0c6T4lGM` — absent and empty metadata hash identically

- Disposition: fixed.
- Change: text write, binary write, rename, and delete request fingerprints
  now hash an explicit `some`/`none` discriminator before each optional
  summary and correlation id.
- Proving test: `empty_metadata_is_distinct_from_absent_in_mutation_fingerprints`
  in `rpc_write_surface.rs`; it covers all four mutation kinds.
- Mutation results: making absent summaries hash as empty made the summary
  retry silently replay and failed its explicit `outcome.is_err()` assertion;
  independently removing only the correlation-id presence tag failed the
  correlation assertion. Restored and passing.

### 12. `PRRT_kwDOSk1N0c6T4lGO` — rename before payload uses destination path

- Disposition: fixed.
- Change: the domain hydrates `payload_before_path`, Rust emits `beforePath`,
  the client contract decodes it, and `payloadSnapshot` uses it for the before
  side. The loopback engine mirrors the wire shape.
- Proving tests:
  - `rename_is_one_moment_atomic_and_secret_floor_is_enforced`
  - `mutation proof: preserves a rename moment's source path`
- Mutation results:
  - Removing Rust `beforePath` failed with `Null` instead of `"old.md"`.
  - Restoring `moment.path` on both payload sides failed with `"renamed.md"`
    instead of `"note.md"`.
  Restored and passing.

### 13. `PRRT_kwDOSk1N0c6T4_I6` — duplicate rename before-path loss

- Disposition: fixed by the same change as finding 12.
- Proving tests: the two rename tests listed under finding 12.
- Mutation result: same wire-null and destination-versus-source assertion
  failures as finding 12; restored and passing.

### 14. `PRRT_kwDOSk1N0c6T4lGP` — Rust mutation endpoints omit 16 KiB metadata bounds

- Disposition: fixed.
- Change: a shared UTF-8 byte-length validator enforces 16 KiB summary and
  correlation-id limits before mutation work. It is applied to text write,
  both binary write transports, rename, delete, merge, and the sibling secret
  write/delete/apply/restore paths. Rollback has no summary/correlation fields.
- Proving test: `mutation_metadata_fields_are_bounded_at_every_rpc_entry`
  in `rpc_write_surface.rs`.
- Mutation results: disabling the validator let the oversized-summary write
  succeed and failed the explicit `outcome.is_err()` assertion; independently
  ignoring only correlation ids let the oversized-correlation write succeed
  and failed the same named test. Restored and passing.

## Additional branch repair

`cargo test -p dohc-engine-domain` initially could not compile because three
pre-existing `merge_conflicts.rs` fixtures still called
`ConflictFileState::binary_head` with the old four-argument signature. The
fixtures now supply the already-required byte length. This is not a review
finding; it is a test-callsite alignment needed to run the requested crate
validation. The full domain suite passes.

## Validation

- `pnpm --filter @dohc/workspace-engine-client test` — 175 passed.
- Affected desktop suites — 132 passed.
- `pnpm --filter @dohc/workspace-engine-client typecheck` — passed.
- `pnpm --filter @dohc/desktop typecheck` — passed.
- `cargo test -p dohc-workspace-engine --test rpc_write_surface` — 81 passed.
- `cargo test -p dohc-workspace-engine --test rpc_read_surface` — passed.
- `cargo test -p dohc-engine-domain` — passed.
- `cargo check -p dohc-workspace-engine` — passed.
- `cargo fmt --all` — completed.
- `git diff --check` — passed.
- No database migration was added.

## Package scope guard

`packages/workspace-engine` (the read-only oracle) has no diff.

The literal command requested in the task,
`git diff origin/main --stat -- packages/`, was already non-empty at the
provided branch head `c845b745`: PR #257 contains seven existing
`packages/workspace-engine-client` files, and finding 4 plus the merge/rename
wire fixes necessarily update that client. No file under
`packages/workspace-engine` was modified.
