# Rust engine switch-barrier report

## Outcome

Both PR #239 switch-time obligations are closed in the Rust daemon composition:

1. `versions.setActive` stops Y.Doc admission, settles and closes every live
   session for the workspace, and keeps admission closed through the switch.
2. Capture applies are drained and blocked, a mandatory full filesystem scan is
   reconciled into the version being left, degraded scans fail closed, and the
   apply barrier remains held through the active-version transaction and switch
   materialization.

No file under `packages/` was modified.

## Design choices

### Y.Doc admission gate

The implementation reuses `EngineService::session_ops`, which already guards
every `ydoc.open`, `ydoc.recordUpdate`, `ydoc.settle`, `ydoc.close`,
`ydoc.resync`, and legacy Y.Doc apply path. `versions.setActive` acquires this
mutex before inspecting the live-session registry and retains it through:

1. target validation and the already-active no-op check;
2. the complete session sweep;
3. capture drain and forced reconcile;
4. the active-version transaction and materialization.

Each session is closed through the same settle-on-close implementation used by
the public `ydoc.close` RPC. A settle or close error returns immediately and the
switch does not run. Because `ydoc.open` needs the same mutex, a new session
cannot be admitted between the sweep and the switch.

The production daemon constructs one `EngineService`, so this mutex covers the
daemon-owned registry and every admission path in the supported topology.

### Capture sequencing barrier

Choice: quiesce and drain the capture driver, rather than pinning plans to a
version and rejecting straddlers.

Reason: the existing driver is a single reconcile/apply owner, and every apply
already resolves the active version immediately before constructing its sink.
A per-workspace async mutex around the driver's complete
reconcile-plus-apply operation therefore gives a direct sequencing point:
acquiring it in `versions.setActive` proves any in-flight apply has completed,
and retaining it prevents another apply from resolving a destination until the
switch is complete. The startup/rebuild baseline apply also uses the gate.

While holding the gate, `versions.setActive` creates a temporary files actor
seeded from the active version's captured manifest and calls the unconditional
`reconcile` operation. It does not call `reconcile_if_dirty`. The temporary
actor has no watcher; the normal capture driver remains alive but blocked at
the gate. A degraded reconcile plan is rejected before any safe-subset apply,
matching the TypeScript switch path's strict scan. A clean plan is applied and
acknowledged through the same `StoreCaptureSink` path as autonomous capture,
then the gate remains held through `set_active_version`.

The manifest seed helper now preserves errors for the forced path. Autonomous
startup keeps its prior degrade-and-retry behavior by explicitly converting a
seed error back to an empty seed only on that existing path.

## Behavioral tests and mutation evidence

All four tests are in
`crates/dohc-workspace-engine/tests/rpc_switch_barriers.rs`.

### `set_active_settles_live_ydoc_into_old_version_and_closes_session`

- Passing behavior: an unsettled live edit is present in the feature version
  being left, absent from Main, Main is materialized on disk, and a later
  settle using the old session id returns `ydoc-session-not-found`.
- Mutation: replaced the session-id sweep with an empty iteration.
- Expected failure observed: the feature head remained `main base` instead of
  `live feature edit`.

### `set_active_full_scans_even_when_watcher_dirty_bit_is_still_unset`

- Passing behavior: a real direct filesystem write made inside the watcher's
  settle window is captured into Main before switching to the feature.
- Mutation: bypassed `reconcile_full_for_switch`, modeling a
  `reconcile_if_dirty`/no-scan result while the dirty bit is unset.
- Expected failure observed: Main remained `main base` instead of
  `unannounced disk edit`.

### `set_active_fails_closed_when_the_forced_scan_is_degraded`

- Passing behavior: a real Windows no-share locked file makes the forced scan
  degraded; `versions.setActive` returns `pre-switch-scan-degraded` and Main
  remains active.
- Mutation: accepted the degraded reconcile plan without applying it.
- Expected failure observed: the switch returned success and made the feature
  active.

### `set_active_drains_an_apply_already_in_flight_before_switching`

- Passing behavior: a harness-only probe pauses the real capture driver after
  it has prepared a reconcile plan. `versions.setActive` remains pending until
  the apply is released; afterward the edit is in Main and the feature retains
  its forked content.
- Mutation: removed the driver tick's acquisition of the apply gate.
- Expected failure observed: `versions.setActive` completed while the prepared
  apply was still paused.

After every mutation the production implementation was restored, and the four
tests passed together.

## Oracle and differential parity

The TypeScript oracle in
`apps/desktop/src/workspaces/workspaceEngineCapture.ts` does three relevant
things in its serialized switch operation: closes all live Y.Doc sessions,
performs a strict filesystem scan/reconcile into the source version, and
rejects failed scan paths before setting the active version. The Rust
composition now has the same ordering and fail-closed result.

The fcompE capture differential
(`crates/dohc-workspace-engine/tests/capture_differential.rs`) contains no
`versions.setActive` or switch scenario, so it cannot evaluate these
composition barriers. The fcompE domain differential does toggle the
store-level active version; it was run and passed:

`cargo test -p dohc-engine-domain --test differential`

Result: 2 passed. This confirms the existing normalized active-version/history
trace, but it is not evidence for Y.Doc admission, filesystem scanning, or
capture sequencing. Those are covered by the new daemon-level behavioral
tests.

## Verification

Environment:

- `CARGO_TARGET_DIR=C:/w/_targets/swbar`
- `TEMP=C:/w/_targets/swbar-tmp`
- `TMP=C:/w/_targets/swbar-tmp`

Commands:

- `cargo test -p dohc-workspace-engine --test rpc_switch_barriers -- --nocapture`
  — 4 passed.
- `cargo test -p dohc-workspace-engine -p dohc-engine-files`
  — all scoped unit, integration, and doc tests passed.
- `cargo clippy -p dohc-workspace-engine -p dohc-engine-files --all-targets --all-features -- -D warnings`
  — passed.
- `git diff origin/main --stat -- packages/`
  — empty.

## Anything not closed

No cutover-blocking implementation obligation from the requested two-item
scope remains.

The only coverage limitation is that fcompE has no daemon-composition switch
trace. Its domain trace cannot cover session admission or capture straddling;
the new mutation-proven RPC tests supply that missing coverage in Rust.
