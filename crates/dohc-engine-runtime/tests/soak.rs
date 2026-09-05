//! Workspace open/close leaks no actor slot: `WorkspaceSupervisor::actor_count()`
//! returns to exactly 0 after every close, whether one identity is reopened
//! repeatedly or many distinct identities are released through `close_all`
//! (the primitive the daemon's shutdown drain uses). Small-scale and fast.

use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

/// Enough cycles to expose a per-cycle leak, few enough to stay well under a
/// second.
const SOAK_SMOKE_CYCLES: usize = 50;

/// Repeatedly open and close the same workspace identity. Bounded resource
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

/// Open many distinct workspace identities, then release them all through
/// `close_all` -- the primitive the daemon's shutdown drain uses
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
