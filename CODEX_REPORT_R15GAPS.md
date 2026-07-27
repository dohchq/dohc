# R15 evidence-gap closure

## Gap 1: ordinal-14 secret capture-ownership backfill

Added
`migration::tests::secret_capture_ownership_migration_backfills_only_completed_present_rows`
in `crates/dohc-engine-storage/src/migration.rs`.

The test migrates a database through `BASELINE_MIGRATIONS[..14]`, seeds the
four combinations of:

- `after_present = 1` / `after_present = 0`
- matching `secret-mat_<moment_id>` job `complete` / `pending`

It then runs the full migration list and asserts that `capture_owned = 1`
only for the present moment with a completed matching materialization job.

Windows command (with `CARGO_TARGET_DIR=C:/w/r15gaps/target`):

```text
cargo test -p dohc-engine-storage --lib secret_capture_ownership_migration_backfills_only_completed_present_rows
```

Unmutated result: `1 passed; 0 failed`.

Mutation 1:

```diff
- UPDATE secret_moments SET capture_owned = 1
+ UPDATE secret_moments SET capture_owned = 0
```

Result: the named test failed on its assertion (not compilation):

```text
assertion `left == right` failed: a present secret with a completed materialization job owns its capture
  left: 0
 right: 1
```

Mutation 2: removed the complete-job `AND EXISTS (...)` guard, leaving only
`WHERE after_present = 1`.

Result: the named test failed on its assertion (not compilation):

```text
assertion `left == right` failed: an incomplete job is not proof of plaintext disk ownership
  left: 1
 right: 0
```

Both mutations were reverted with targeted patches. The unmutated named test
and the full scoped storage suites pass.

## Gap 2: Linux `openat2` symlink refusal

Added the Linux-only direct regression test
`materialize::tests::secret_parent_openat2_refuses_a_symlinked_component_directly`
in `crates/dohc-engine-files/src/materialize.rs`.

The test gives the Linux parent opener `link/nested`, where `link` is a
symlink to another directory inside the workspace. This is deliberate:
`BENEATH` alone permits that traversal, while `NO_SYMLINKS` must refuse it.
If the opener mistakenly returns a parent descriptor, the test attempts the
real descriptor-relative secret write and asserts that plaintext was not
written through the alias. It separately asserts that no plaintext appears
outside the pinned workspace root.

Linux/WSL command:

```text
CARGO_TARGET_DIR=$HOME/_rusttargets/r15gaps cargo test -p dohc-engine-files --lib secret_parent_openat2_refuses_a_symlinked_component_directly -- --nocapture
```

Unmutated Linux result: `1 passed; 0 failed`.

Linux mutation in the primary `open_secret_parent_unix` `openat2` call:

```diff
- ResolveFlags::NO_SYMLINKS | ResolveFlags::BENEATH
+ ResolveFlags::BENEATH
```

Linux mutation result: the named test failed on its assertion (not
compilation):

```text
thread 'materialize::tests::secret_parent_openat2_refuses_a_symlinked_component_directly' panicked at crates/dohc-engine-files/src/materialize.rs:2162:9:
plaintext must not be written through a symlinked ancestor
```

This was run under WSL2 on Linux kernel
`6.18.33.2-microsoft-standard-WSL2`. The mutation allowed the parent
descriptor and the descriptor-relative write reached the symlink destination.
Therefore this run exercised the `openat2` path; an `ENOSYS`/`EINVAL`
fallback to the component walk would still have refused the symlink with
`O_NOFOLLOW`, and the mutation would not have produced this failure.

The mutation was reverted with a targeted patch. The final formatted source
was copied to WSL, the named test passed again, and the Linux checkout's
original tracked file was restored afterward.

## Gap 3: false scoped failures without `fault-injection`

No new migration or production seam was added. The existing design explicitly
makes `fault-injection` opt-in so production/default builds dead-code-eliminate
fault polling. The honest fix is therefore to gate the four tests that require
the crash seam, along with their local `OneShotCrash` helper and the synthetic
two-migration fixture:

- `crash_before_ledger_commit_rolls_back_and_reopen_recovers`
- `crash_between_steps_resumes_second_migration_from_ledger`
- `incomplete_migration_with_changed_checksum_fails_closed`
- `non_transactional_started_then_resumes`

Each now has `#[cfg(feature = "fault-injection")]`. This gap was a test
configuration error rather than a missing production guarantee, so no
production-code mutation was applicable.

Windows scoped results:

```text
cargo test -p dohc-engine-storage --lib
test result: ok. 24 passed; 0 failed

cargo test -p dohc-engine-storage --lib --features fault-injection
test result: ok. 28 passed; 0 failed
```

The default scoped run is now honestly green with the four crash tests absent,
and the feature-enabled run proves all four still execute and pass when their
seam exists.

## Final verification

All Windows commands used `CARGO_TARGET_DIR=C:/w/r15gaps/target`.

```text
cargo fmt --all

cargo test -p dohc-engine-storage --lib
24 passed; 0 failed

cargo test -p dohc-engine-storage --lib --features fault-injection
28 passed; 0 failed

cargo test -p dohc-engine-files --lib
45 passed; 0 failed
```

Linux-only final verification used
`CARGO_TARGET_DIR=$HOME/_rusttargets/r15gaps`:

```text
cargo test -p dohc-engine-files --lib secret_parent_openat2_refuses_a_symlinked_component_directly -- --nocapture
1 passed; 0 failed
```

No migration was added. `packages/workspace-engine` was not modified, and
`git diff origin/main --stat -- packages/` is empty.
