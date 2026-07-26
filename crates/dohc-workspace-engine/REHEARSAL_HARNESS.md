# GATE6 clone-reset rehearsal harness

`dohc-rehearsal-harness` is the runnable, harness-feature-only caller for
`run_rehearsal(RehearsalConfig)`. It exercises the GATE6 criterion against a
capture-floor-aware byte clone of a real workspace tree without authorizing
any write to the real workspace.

## Recorded interpretation — Ice post-hoc review required

The live dogfood `.dohc/engine/engine.db` is TypeScript-authored. The Rust
fence in `cutover_rehearse/fence.rs` correctly refuses that foreign schema
fingerprint; opening or migrating it would violate the cutover contract.

The authorized cutover is a **reset**: a fresh Rust store plus recapture, with
the prior data wipe accepted by Ice. For this rehearsal the harness therefore:

1. records a hash, size, path, and mtime snapshot of the real source tree,
   including the existence and root mtime of each floor-skipped directory;
2. clones every capture-visible source directory and file, preserving file
   bytes and mtimes, and also clones `.dohc` because the rehearsal machinery
   operates on it;
3. proves the untouched clone exactly matches the floor-filtered source
   snapshot;
4. retains any TypeScript SQLite `engine.db`/sidecars under
   `.dohc/engine/typescript-engine-byte-clone/` inside the clone;
5. follows the existing R13/R15 fixture recipe: writes both 64-lowercase-hex
   harness markers, initializes a fresh Rust `engine.db`, and binds that store
   to the `SHADOW_CLONE` token;
6. calls `run_rehearsal` with `NoFaults`;
7. requires the `Complete` outcome, takes a second full source snapshot, and
   banks evidence only if the source is byte/mtime unchanged.

This interpretation is deliberately recorded in the evidence and remains
flagged for Ice's post-hoc review.

## Recorded design decision — byte clone uses the capture floor

The byte-clone walk imports the canonical reserved-name and ignored-prefix
constants from `dohc_engine_files::floor`. It skips directory roots named
`.git`, `node_modules`, or `.dohc-write-*` at any depth, with the floor's
platform-specific normalization. It deliberately does **not** skip `.dohc`.

This is a hard-floor rule, not a best-effort optimization. Reset never touches
capture-excluded directories: they are outside the engine's world. Cloning a
pnpm package tree would therefore introduce junction aliases the real reset
never observes, while regenerable dependencies are not user data covered by
the inventory's no-data-loss proof. The harness records the complete list and
counts of skipped roots in `REHEARSAL_EVIDENCE.json`; it does not traverse or
silently truncate their contents. The full before/after source proof still
records each skipped root's existence and root mtime. Any alias or special file
outside a skipped root remains a fail-closed error during cloning and
snapshotting.

The existing rehearsal driver's “capture” proof is the inventory equality and
protected `.dohc` snapshot proof implemented by `capture_proofs`; the fixture
recipe does not run a production daemon or migrate the TypeScript database.
The final reset store is fresh and shadow-bound, while the real user file tree
is proven preserved around the reset.

## Safety contract

The binary takes:

```text
--source <real workspace root>
--scratch <clone parent>
--recovery <outside-root artifact directory>
```

It refuses a source without a real `.dohc` directory, refuses scratch or
recovery paths within source, and requires scratch and recovery to be separate
non-nested directories. Outside the explicitly recorded floor-skipped
directory roots, it refuses aliases and special files instead of silently
skipping them. It never writes markers, databases, state, or evidence under
`--source`.

The source-untouched assertion runs even when clone preparation or the
rehearsal fails. A changed path, byte hash, size, or mtime is a hard failure,
and `REHEARSAL_EVIDENCE.json` is not published.

Close the desktop app and every process that can write or exclusively hold the
workspace before invoking the harness. Use a new recovery directory so no
prior rehearsal artifacts can be mistaken for this run.

The `harness` feature is required and must never be enabled in a production
build:

```powershell
$env:CARGO_TARGET_DIR='C:/w/_targets/rehearse'
$env:CARGO_BUILD_JOBS='4'
$env:TEMP='C:/w/_targets/rehearse-tmp'
$env:TMP='C:/w/_targets/rehearse-tmp'
cargo run -p dohc-workspace-engine --features harness --bin dohc-rehearsal-harness -- --source <workspace> --scratch <clone-parent> --recovery <artifact-dir>
```

## Evidence and real-data debris

On success, `<recovery>/REHEARSAL_EVIDENCE.json` contains:

- the complete state record and history;
- the `BackupFingerprint` fields and fresh engine UUID;
- before/after source snapshot fingerprints and counts;
- floor-filtered clone-input, initial byte-clone, and final clone counts;
- every floor-skipped root, its source-root mtime and kind, plus total,
  directory, and alias root counts;
- clone and recovery paths;
- hashes for retained TypeScript store files and recovery artifacts;
- per-phase timings; and
- every `.dohc/**/ui-state.json.tmp-*` orphan found in the byte clone.

The current dogfood tree is expected to contain 17 such UI-state temp orphans.
They are not skipped or deleted. The rehearsal settle walk traverses `.dohc`,
so an unreadable or otherwise invalid orphan must fail as a real finding. The
harness does not work around debris.
