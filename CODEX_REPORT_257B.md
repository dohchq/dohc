# PR #257 Rust gate repair

## Root cause

The branch added binary byte-length hydration to `CONFLICT_SELECT` and made
`map_side` compare each conflict side's recorded `binary_blobs.byte_length`
with `LENGTH(binary_blobs.bytes)` while reconstructing the conflict row.

That validation ran before `apply_mirrored_binary_write`, which is the
classification boundary that deliberately distinguishes:

- absent local bytes as `BinaryUnhydrated`, an acknowledged and surfaced
  refusal; and
- present-but-corrupt bytes as `StorageError::BlobIntegrity`, a fail-closed
  storage error that rolls back without acking.

For both missing and corrupt bytes, the eager row check instead returned
`DomainError::StateCorrupt`. `map_domain` then collapsed that error to
`SyncError::InvalidInput { reason: "replicated conflict operation is invalid" }`.
The consequence was a local hydration/integrity condition being mislabeled as
a terminal replicated-payload fault before the intended classifier could run.

## Changes

- Conflict row reconstruction now carries the optional recorded binary byte
  length without reading or validating the bytes. Hydration and integrity
  remain classified at the existing byte-use boundary via
  `get_binary_blob`.
- Added `ApplyRunContext` to group the capture apply dependencies shared by
  `apply_run` and `apply_run_with_handle`, removing the new eight-argument
  signatures without suppressing Clippy.

No test expectation was relaxed.

## Named regression tests

- `conflict_apply::tests::mirrored_unhydrated_binary_side_resolve_is_surfaced_and_acked`
- `conflict_apply::tests::mirrored_corrupt_binary_side_resolve_errs_and_does_not_close`

Both pass in the corrected `cargo test -p dohc-engine-sync conflict_apply`
run.

## Mutation proof

I reintroduced the premature row-loader validation, including the
recorded-versus-actual byte-length comparison, and ran each fully qualified
test independently.

- `mirrored_unhydrated_binary_side_resolve_is_surfaced_and_acked` compiled and
  ran one test, then failed at its acknowledgement/surfacing assertion because
  it received `InvalidInput { reason: "replicated conflict operation is invalid" }`.
- `mirrored_corrupt_binary_side_resolve_errs_and_does_not_close` compiled and
  ran one test, then failed its error-taxonomy assertion because it received
  the same `InvalidInput` instead of
  `StorageError::BlobIntegrity`.

The mutation was restored to the corrected implementation before final
validation.

## Validation

- `cargo clippy -p dohc-workspace-engine --all-targets -- -D warnings` — passed.
- `cargo test -p dohc-engine-sync conflict_apply` — 25 passed.
- `cargo fmt --all` — completed.
- `git diff --check` — passed.

## Package scope

This repair made no worktree changes under `packages/`, including
`packages/workspace-engine`.

The literal comparison `git diff origin/main --stat -- packages/` was already
non-empty at the supplied branch head because PR #257 contains seven committed
`packages/workspace-engine-client` changes. `git diff HEAD --stat -- packages/`
is empty for this repair.
