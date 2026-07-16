//! Workspace-actor traces (CAL-1 calibration signal): lifecycle, canonical
//! identity convergence across aliases, single-writer dedup, restart
//! generations, and deterministic connection release on close.

use dohc_engine_runtime::{
    CompoundWrite, LifecycleState, NoFaults, WorkspaceSupervisor, WriteOutcome,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, try_make_dir_alias};
use std::sync::Arc;

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

// oracle: close deterministically releases the connection — a fresh direct
// EngineStore::open on the same path succeeds (on Windows this only works if
// the prior handle was truly released).
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

    // The actor's connection is gone: a brand-new writer opens cleanly and
    // sees the committed state.
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
