//! R14 robustness closure: soak smoke test.
//!
//! The plan's "Resource and soak tests -- right-sized" section names the
//! CUTOVER-BLOCKING target as ~1,000 workspace open/close cycles over a
//! 30-60 minute soak, asserting threads/handles/queue-depth return exactly
//! to baseline after every workspace closes and no unbounded growth occurs.
//! That full-scale soak is post-cutover-window infrastructure and a
//! deliberate follow-up (see `tools/rust-engine-program/soak-config.json`
//! for its parameters); this file is the FAST, `cargo test --workspace`-sized
//! subset that proves the MECHANISM holds at small scale, so it can run in
//! every PR rather than only nightly.
//!
//! What this proves: `WorkspaceSupervisor::actor_count()` returns to exactly
//! 0 after every single open/close cycle (never leaks an actor slot), for
//! both the same-identity-reused case and the many-distinct-identities case
//! closed via `close_all` (the primitive R14's daemon shutdown drain uses).
//!
//! What this does NOT prove (explicitly out of scope here, tracked as the
//! post-cutover soak follow-up): OS thread/handle counts returning to an
//! exact baseline, RSS/allocator trend bounds, WAL/replication-log growth
//! bounds, or anything at the ~1,000-cycle / 30-60-minute scale. Those need
//! OS-level instrumentation and wall-clock time this fast PR-gate test
//! deliberately does not take on.

use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

/// Smoke-scale cycle count -- fast enough for the required `cargo test
/// --workspace` gate (well under a second). The right-sized cutover-blocking
/// target (~1,000 cycles) lives in `tools/rust-engine-program/soak-config.json`.
const SOAK_SMOKE_CYCLES: usize = 50;

/// Repeatedly open and close the SAME workspace identity. Bounded resource
/// check: `actor_count()` must return to exactly 0 after every close, never
/// drifting upward across cycles (the "workspace close returns owned
/// resources to baseline" property, at the session-registry layer).
#[test]
fn repeated_open_close_of_one_workspace_returns_to_baseline_every_cycle() {
    let scratch = ScratchDir::new().expect("scratch");
    let db_path = scratch.engine_db_path().expect("db path");
    // Isolated instance, never `WorkspaceSupervisor::global()` -- a soak
    // test must not pollute (or be polluted by) the process-wide registry.
    let supervisor = WorkspaceSupervisor::new();

    assert_eq!(supervisor.actor_count(), 0, "baseline before any open");
    for cycle in 0..SOAK_SMOKE_CYCLES {
        let now_ms = 1_000 + cycle as i64;
        supervisor.open(&db_path, now_ms).expect("open");
        assert_eq!(
            supervisor.actor_count(),
            1,
            "cycle {cycle}: exactly one open actor"
        );
        let closed = supervisor.close(&db_path).expect("close");
        assert!(closed, "cycle {cycle}: close must report an actor closed");
        assert_eq!(
            supervisor.actor_count(),
            0,
            "cycle {cycle}: actor count must return to baseline after close"
        );
    }
}

/// Open many DISTINCT workspace identities, then release them all through
/// `close_all` -- the exact primitive R14's daemon shutdown drain uses
/// (`crates/dohc-workspace-engine/src/bin/dohc-workspace-engine.rs`).
/// Bounded resource check: no leaked actor slot regardless of how many
/// distinct identities were ever opened.
#[test]
fn close_all_returns_many_distinct_workspaces_to_baseline() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();

    let paths: Vec<_> = (0..SOAK_SMOKE_CYCLES)
        .map(|i| scratch.path().join(format!("ws-{i}")).join("engine.db"))
        .collect();
    for (i, path) in paths.iter().enumerate() {
        supervisor.open(path, 2_000 + i as i64).expect("open");
    }
    assert_eq!(supervisor.actor_count(), SOAK_SMOKE_CYCLES);

    supervisor.close_all().expect("close_all");
    assert_eq!(
        supervisor.actor_count(),
        0,
        "close_all must return every distinct workspace to baseline"
    );
}
