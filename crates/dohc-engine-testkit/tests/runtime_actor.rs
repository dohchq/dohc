//! Workspace-actor traces (CAL-1 calibration signal): lifecycle, canonical
//! identity convergence across aliases, single-writer dedup, restart
//! generations, and deterministic connection release on close.

use dohc_engine_runtime::{
    CompoundWrite, FaultInjector, FaultPoint, LifecycleState, NoFaults, WorkspaceSupervisor,
    WriteOutcome,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::harness::wal_sidecar;
use dohc_engine_testkit::{
    GateFaults, PanicFaults, ScratchDir, make_hardlink, try_make_dir_alias, try_make_file_symlink,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Spin (bounded) until the actor behind `handle` publishes `Closed`, so panic
/// teardown is observed deterministically without a fixed sleep.
fn wait_for_closed(handle: &dohc_engine_runtime::ActorHandle) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while handle.lifecycle() != LifecycleState::Closed {
        assert!(Instant::now() < deadline, "actor never reached Closed");
        std::thread::yield_now();
    }
}

fn write(request_id: &str, doc_id: &str, body: &str, now_ms: i64) -> CompoundWrite {
    CompoundWrite {
        request_id: request_id.to_owned(),
        doc_id: doc_id.to_owned(),
        body: body.to_owned(),
        op_kind: "text.write".to_owned(),
        now_ms,
    }
}

// oracle: actor lifecycle open→ready→...→closed with a live write in between.
#[test]
fn actor_lifecycle_open_ready_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open");
    assert_eq!(handle.lifecycle(), LifecycleState::Ready);

    let outcome = handle
        .write(write("r1", "d1", "hi", 1), Arc::new(NoFaults))
        .expect("write");
    assert_eq!(
        outcome,
        WriteOutcome::Acked {
            seq: 1,
            deduped: false
        }
    );

    assert!(sup.close(&db).expect("close"));
    // The shared lifecycle flag reflects the released connection.
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
    // A handle to a closed actor fails cleanly instead of hanging.
    let err = handle
        .write(write("r2", "d2", "no", 2), Arc::new(NoFaults))
        .expect_err("closed actor rejects writes");
    assert_eq!(err.code(), "actor-unavailable");
}

// oracle: two aliased paths converge on ONE actor / ONE writer connection
// (canonical-identity keying), proven with a lexical alias that always works.
#[test]
fn lexical_aliases_converge_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    // Same file, different lexical spelling (redundant `.` components).
    let engine_dir = db.parent().expect("engine dir");
    let aliased = engine_dir.join(".").join("engine.db");

    let a = sup.open(&db, 1).expect("open a");
    let b = sup.open(&aliased, 1).expect("open b");

    assert_eq!(a.identity(), b.identity(), "aliases must share identity");
    assert_eq!(sup.actor_count(), 1, "only one actor / one writer");

    // A write through A is visible through B — same underlying store.
    a.write(write("r1", "shared", "via-a", 1), Arc::new(NoFaults))
        .expect("write a");
    let doc = b.read("shared").expect("read b").expect("present");
    assert_eq!(doc.body, "via-a");
}

// oracle: a symlink/junction to the same engine dir converges on the SAME
// actor (portability + file-identity). Skips honestly if the platform refuses
// to create the alias.
#[test]
fn symlink_or_junction_alias_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path"); // creates .dohc/engine
    let real_engine_dir = db.parent().expect("engine dir").to_path_buf();

    let link_dir = scratch.join("engine-alias");
    match try_make_dir_alias(&real_engine_dir, &link_dir) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("SKIP: platform refused to create a directory alias (no privilege)");
            return;
        }
        Err(err) => panic!("alias creation failed: {err}"),
    }
    let aliased_db = link_dir.join("engine.db");

    let sup = WorkspaceSupervisor::new();
    let real = sup.open(&db, 1).expect("open real");
    let via_link = sup.open(&aliased_db, 1).expect("open via link");

    assert_eq!(
        real.identity(),
        via_link.identity(),
        "the junction/symlink must canonicalize to the real db identity"
    );
    assert_eq!(
        sup.actor_count(),
        1,
        "aliased opens must not fork a second writer"
    );

    real.write(write("r1", "k", "value", 1), Arc::new(NoFaults))
        .expect("write real");
    let doc = via_link.read("k").expect("read via link").expect("present");
    assert_eq!(doc.body, "value");
}

// oracle: restart increments the session generation and preserves state.
#[test]
fn restart_bumps_generation_and_preserves_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open");
    handle
        .write(write("r1", "keep", "durable", 1), Arc::new(NoFaults))
        .expect("write");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(1));

    let reopened = sup.restart(&db, 2).expect("restart");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(2));
    assert_eq!(sup.actor_count(), 1);

    // State survived the restart, and the reopened actor is writable.
    let doc = reopened.read("keep").expect("read").expect("present");
    assert_eq!(doc.body, "durable");
    let snap = reopened.snapshot().expect("snapshot");
    assert_eq!(snap.documents, 1);

    reopened
        .write(write("r2", "more", "again", 2), Arc::new(NoFaults))
        .expect("write after restart");
    assert_eq!(reopened.snapshot().expect("snap").documents, 2);
}

// oracle: close deterministically releases the connection. A second open alone
// does NOT prove release (SQLite permits concurrent connections), so we assert
// the WAL sidecar was checkpointed away — which only happens when the LAST
// connection closes — and, on Windows, that the file is now deletable.
#[test]
fn close_releases_the_connection() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open");
    handle
        .write(write("r1", "d", "x", 1), Arc::new(NoFaults))
        .expect("write");
    sup.close_all().expect("close all");
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
    assert_eq!(sup.actor_count(), 0);

    // Last-connection close checkpoints and removes the -wal sidecar; a still-
    // open connection would leave it behind.
    let wal = wal_sidecar(&db);
    assert!(
        !wal.exists(),
        "-wal must be gone once the last writer closed"
    );

    // On Windows an open handle blocks deletion; being able to rename the file
    // proves no handle remains. (POSIX allows unlink of open files, so this is
    // a Windows-specific release proof.)
    #[cfg(windows)]
    {
        let moved = db.with_extension("moved");
        std::fs::rename(&db, &moved).expect("db must be movable after release");
        std::fs::rename(&moved, &db).expect("restore");
    }

    // And a brand-new writer opens cleanly and sees the committed state.
    let store = EngineStore::open(&db, 2).expect("reopen after release");
    assert_eq!(store.document_count().expect("docs"), 1);
}

// oracle: dropping the supervisor closes every actor (deterministic Drop, no
// detached worker outlives its owner).
#[test]
fn dropping_supervisor_releases_all_actors() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");

    {
        let sup = WorkspaceSupervisor::new();
        let handle = sup.open(&db, 1).expect("open");
        handle
            .write(write("r1", "d", "x", 1), Arc::new(NoFaults))
            .expect("write");
        // sup drops here → its actors drop → each joins its worker + releases.
    }

    // Reopen proves the connection was released when the supervisor dropped.
    let store = EngineStore::open(&db, 2).expect("reopen after supervisor drop");
    assert_eq!(store.document_count().expect("docs"), 1);
}

// oracle: a hard link addresses the same bytes → same file identity → one
// actor (a path-key would have forked a second writer).
#[test]
fn hardlink_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    // Open (creates + initializes the db), then hard-link a second name to it.
    let a = sup.open(&db, 1).expect("open real");
    a.write(write("r1", "k", "value", 1), Arc::new(NoFaults))
        .expect("write");

    let linked = db.parent().expect("engine dir").join("engine-hardlink.db");
    make_hardlink(&db, &linked).expect("hard link");

    let b = sup.open(&linked, 1).expect("open hardlink");
    assert_eq!(a.identity(), b.identity(), "hard links share file identity");
    assert_eq!(sup.actor_count(), 1, "one actor / one writer");
    let doc = b.read("k").expect("read").expect("present");
    assert_eq!(doc.body, "value");
}

// oracle: a filename-case alias on a case-insensitive volume addresses the same
// file → one actor. Skips on case-sensitive filesystems.
#[test]
fn case_alias_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();
    let a = sup.open(&db, 1).expect("open");

    // Upper-case the file name; on a case-insensitive volume this is the same
    // file, on a case-sensitive one it does not exist.
    let upper = db.parent().expect("dir").join("ENGINE.DB");
    if !upper.exists() {
        eprintln!("SKIP: case-sensitive filesystem — case-alias convergence N/A");
        return;
    }
    let b = sup.open(&upper, 1).expect("open case alias");
    assert_eq!(
        a.identity(),
        b.identity(),
        "case aliases share file identity"
    );
    assert_eq!(sup.actor_count(), 1);
}

// oracle: a file symlink to the db converges on the same actor. Skips if the
// platform refuses symlink creation.
#[test]
fn file_symlink_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();
    let a = sup.open(&db, 1).expect("open real");

    let link = db.parent().expect("dir").join("engine-symlink.db");
    match try_make_file_symlink(&db, &link) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("SKIP: platform refused a file symlink (no privilege)");
            return;
        }
        Err(err) => panic!("symlink creation failed: {err}"),
    }

    let b = sup.open(&link, 1).expect("open via symlink");
    assert_eq!(
        a.identity(),
        b.identity(),
        "symlink resolves to the target's id"
    );
    assert_eq!(sup.actor_count(), 1);
}

// oracle: a worker panic publishes Closed (panic-safe teardown) and the handle
// fails cleanly rather than hanging.
#[test]
fn worker_panic_publishes_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open");

    let panic_faults: Arc<dyn FaultInjector> = PanicFaults::at(FaultPoint::StorageBeforePersist);
    let err = handle
        .write(write("r1", "d1", "boom", 1), panic_faults)
        .expect_err("panic in the worker surfaces as a lost reply");
    assert_eq!(err.code(), "actor-unavailable");

    wait_for_closed(&handle);
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
}

// oracle: restart after a panicked predecessor preserves generation continuity
// and yields a fresh, writable actor.
#[test]
fn restart_after_panicked_predecessor_continues_generation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(1));

    let panic_faults: Arc<dyn FaultInjector> = PanicFaults::at(FaultPoint::StorageBeforePersist);
    let _ = handle.write(write("r1", "d1", "boom", 1), panic_faults);
    wait_for_closed(&handle);

    // Restart evicts the dead actor and carries the generation forward.
    let reopened = sup.restart(&db, 2).expect("restart");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(2));
    assert_eq!(sup.actor_count(), 1);

    // The reopened actor is writable; the rolled-back panic left no data.
    let outcome = reopened
        .write(write("r2", "d2", "ok", 2), Arc::new(NoFaults))
        .expect("write after restart");
    assert_eq!(
        outcome,
        WriteOutcome::Acked {
            seq: 1,
            deduped: false
        }
    );
    assert_eq!(reopened.snapshot().expect("snap").documents, 1);
}

// oracle: bounded backpressure is observable — filling the command queue behind
// a wedged worker yields a typed Overloaded, not an unbounded queue or a hang.
#[test]
fn full_command_queue_reports_overloaded() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open");

    // Wedge the worker: it dequeues this write and parks inside the gate.
    let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
    let gate_dyn: Arc<dyn FaultInjector> = gate.clone();
    handle
        .try_submit_write(write("wedge", "wd", "held", 1), gate_dyn)
        .expect("submit wedger");
    gate.wait_until_reached();

    // Fill the bounded queue; a bounded number of submits must hit Overloaded.
    let mut overloaded = false;
    for i in 0..512 {
        match handle.try_submit_write(
            write(&format!("fill-{i}"), &format!("fd-{i}"), "x", 1),
            Arc::new(NoFaults),
        ) {
            Ok(()) => {}
            Err(err) if err.code() == "overloaded" => {
                overloaded = true;
                break;
            }
            Err(err) => panic!("unexpected error while filling queue: {err}"),
        }
    }
    assert!(overloaded, "a full bounded queue must report Overloaded");

    // Release the worker before teardown so close can drain (no deadlock).
    gate.release();
    sup.close_all().expect("close all");
}

// oracle: concurrent opens of the same file converge on ONE actor / ONE writer
// (the reservation protocol dedups; the lock is not held across the spawn).
#[test]
fn concurrent_opens_share_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = Arc::new(WorkspaceSupervisor::new());

    let mut joins = Vec::new();
    for t in 0..8 {
        let sup = Arc::clone(&sup);
        let db = db.clone();
        joins.push(std::thread::spawn(move || {
            let handle = sup.open(&db, 1).expect("concurrent open");
            handle
                .write(
                    write(&format!("r-{t}"), &format!("d-{t}"), "v", 1),
                    Arc::new(NoFaults),
                )
                .expect("write");
            handle
        }));
    }
    let handles: Vec<_> = joins.into_iter().map(|j| j.join().expect("join")).collect();

    assert_eq!(sup.actor_count(), 1, "all opens share one actor");
    let first_identity = handles[0].identity();
    for handle in &handles {
        assert_eq!(handle.identity(), first_identity, "one file identity");
    }
    // Every concurrent write landed in the single store.
    assert_eq!(handles[0].snapshot().expect("snap").documents, 8);
}
