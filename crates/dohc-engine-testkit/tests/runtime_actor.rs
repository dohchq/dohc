//! Workspace-actor traces: lifecycle, canonical identity convergence across
//! aliases, single-writer dedup, restart generations, and deterministic
//! connection release on close.

use dohc_engine_domain::WriteText;
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, FaultInjector, FaultPoint, LifecycleState, NoFaults,
    RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::harness::wal_sidecar;
use dohc_engine_testkit::{
    PanicFaults, ScratchDir, make_hardlink, try_make_dir_alias, try_make_file_symlink,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WS: &str = "ws";

/// Spin (bounded) until the actor behind `handle` publishes `Closed`, so panic
/// teardown is observed deterministically without a fixed sleep.
fn wait_for_closed(handle: &ActorHandle) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while handle.lifecycle() != LifecycleState::Closed {
        assert!(Instant::now() < deadline, "actor never reached Closed");
        std::thread::yield_now();
    }
}

async fn seed(handle: &ActorHandle) {
    handle
        .ensure_main_version(
            WS.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main version");
}

async fn write(
    handle: &ActorHandle,
    path: &str,
    text: &str,
    now_ms: i64,
    faults: Arc<dyn FaultInjector>,
) -> Result<(), RuntimeError> {
    handle
        .versioned_text_write(
            WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: format!("object-{path}"),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: format!("moment-{path}-{now_ms}"),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
            faults,
            CancellationToken::new(),
        )
        .await
        .map(|_| ())
}

async fn read(handle: &ActorHandle, path: &str) -> Option<String> {
    handle
        .versioned_text_read(
            WS.to_owned(),
            "main".to_owned(),
            path.to_owned(),
            CancellationToken::new(),
        )
        .await
        .expect("read")
        .map(|snapshot| snapshot.text)
}

fn moments(db: &std::path::Path) -> i64 {
    EngineStore::open(db, 99)
        .expect("reopen")
        .table_row_count("moments")
        .expect("count moments")
}

// oracle: actor lifecycle open→ready→...→closed with a live write in between.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actor_lifecycle_open_ready_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open").actor;
    assert_eq!(handle.lifecycle(), LifecycleState::Ready);
    seed(&handle).await;
    write(&handle, "d1.md", "hi", 1, Arc::new(NoFaults))
        .await
        .expect("write");

    assert!(sup.close(&db).expect("close"));
    // The shared lifecycle flag reflects the released connection.
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
    // A handle to a closed actor fails cleanly instead of hanging.
    let err = write(&handle, "d2.md", "no", 2, Arc::new(NoFaults))
        .await
        .expect_err("closed actor rejects writes");
    assert_eq!(err.code(), "actor-unavailable");
}

// oracle: two aliased paths converge on ONE actor / ONE writer connection
// (canonical-identity keying), proven with a lexical alias that always works.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lexical_aliases_converge_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    // Same file, different lexical spelling (redundant `.` components).
    let engine_dir = db.parent().expect("engine dir");
    let aliased = engine_dir.join(".").join("engine.db");

    let a = sup.open(&db, 1).expect("open a").actor;
    let b = sup.open(&aliased, 1).expect("open b").actor;

    assert_eq!(a.identity(), b.identity(), "aliases must share identity");
    assert_eq!(sup.actor_count(), 1, "only one actor / one writer");

    // A write through A is visible through B — same underlying store.
    seed(&a).await;
    write(&a, "shared.md", "via-a", 1, Arc::new(NoFaults))
        .await
        .expect("write a");
    assert_eq!(read(&b, "shared.md").await.as_deref(), Some("via-a"));
}

// oracle: a symlink/junction to the same engine dir converges on the SAME
// actor (portability + file-identity). Skips honestly if the platform refuses
// to create the alias.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn symlink_or_junction_alias_converges_on_one_actor() {
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
    let real = sup.open(&db, 1).expect("open real").actor;
    let via_link = sup.open(&aliased_db, 1).expect("open via link").actor;

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

    seed(&real).await;
    write(&real, "k.md", "value", 1, Arc::new(NoFaults))
        .await
        .expect("write real");
    assert_eq!(read(&via_link, "k.md").await.as_deref(), Some("value"));
}

// oracle: restart increments the session generation and preserves state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_bumps_generation_and_preserves_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open").actor;
    seed(&handle).await;
    write(&handle, "keep.md", "durable", 1, Arc::new(NoFaults))
        .await
        .expect("write");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(1));

    let reopened = sup.restart(&db, 2).expect("restart");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(2));
    assert_eq!(sup.actor_count(), 1);

    // State survived the restart, and the reopened actor is writable.
    assert_eq!(read(&reopened, "keep.md").await.as_deref(), Some("durable"));
    write(&reopened, "more.md", "again", 2, Arc::new(NoFaults))
        .await
        .expect("write after restart");
    assert_eq!(read(&reopened, "more.md").await.as_deref(), Some("again"));
}

// oracle: close deterministically releases the connection. A second open alone
// does NOT prove release (SQLite permits concurrent connections), so we assert
// the WAL sidecar was checkpointed away — which only happens when the LAST
// connection closes — and, on Windows, that the file is now deletable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_releases_the_connection() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open").actor;
    seed(&handle).await;
    write(&handle, "d.md", "x", 1, Arc::new(NoFaults))
        .await
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
    assert_eq!(moments(&db), 1);
}

// oracle: dropping the supervisor closes every actor (deterministic Drop, no
// detached worker outlives its owner).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_supervisor_releases_all_actors() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");

    {
        let sup = WorkspaceSupervisor::new();
        let handle = sup.open(&db, 1).expect("open").actor;
        seed(&handle).await;
        write(&handle, "d.md", "x", 1, Arc::new(NoFaults))
            .await
            .expect("write");
        // sup drops here → its actors drop → each joins its worker + releases.
    }

    // Reopen proves the connection was released when the supervisor dropped.
    assert_eq!(moments(&db), 1);
}

// oracle: a hard link addresses the same bytes → same file identity → one
// actor (a path-key would have forked a second writer).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hardlink_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    // Open (creates + initializes the db), then hard-link a second name to it.
    let a = sup.open(&db, 1).expect("open real").actor;
    seed(&a).await;
    write(&a, "k.md", "value", 1, Arc::new(NoFaults))
        .await
        .expect("write");

    let linked = db.parent().expect("engine dir").join("engine-hardlink.db");
    make_hardlink(&db, &linked).expect("hard link");

    let b = sup.open(&linked, 1).expect("open hardlink").actor;
    assert_eq!(a.identity(), b.identity(), "hard links share file identity");
    assert_eq!(sup.actor_count(), 1, "one actor / one writer");
    assert_eq!(read(&b, "k.md").await.as_deref(), Some("value"));
}

// oracle: a filename-case alias on a case-insensitive volume addresses the same
// file → one actor. Skips on case-sensitive filesystems.
#[test]
fn case_alias_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();
    let a = sup.open(&db, 1).expect("open").actor;

    // Upper-case the file name; on a case-insensitive volume this is the same
    // file, on a case-sensitive one it does not exist.
    let upper = db.parent().expect("dir").join("ENGINE.DB");
    if !upper.exists() {
        eprintln!("SKIP: case-sensitive filesystem — case-alias convergence N/A");
        return;
    }
    let b = sup.open(&upper, 1).expect("open case alias").actor;
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
    let a = sup.open(&db, 1).expect("open real").actor;

    let link = db.parent().expect("dir").join("engine-symlink.db");
    match try_make_file_symlink(&db, &link) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("SKIP: platform refused a file symlink (no privilege)");
            return;
        }
        Err(err) => panic!("symlink creation failed: {err}"),
    }

    let b = sup.open(&link, 1).expect("open via symlink").actor;
    assert_eq!(
        a.identity(),
        b.identity(),
        "symlink resolves to the target's id"
    );
    assert_eq!(sup.actor_count(), 1);
}

// oracle: a worker panic publishes Closed (panic-safe teardown) and the handle
// fails cleanly rather than hanging.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_panic_publishes_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open").actor;
    seed(&handle).await;

    let panic_faults: Arc<dyn FaultInjector> = PanicFaults::at(FaultPoint::StorageBeforePersist);
    let err = write(&handle, "d1.md", "boom", 1, panic_faults)
        .await
        .expect_err("panic in the worker surfaces as a lost reply");
    assert_eq!(err.code(), "actor-unavailable");

    wait_for_closed(&handle);
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
}

// oracle: restart after a panicked predecessor preserves generation continuity
// and yields a fresh, writable actor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_after_panicked_predecessor_continues_generation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open").actor;
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(1));
    seed(&handle).await;

    let panic_faults: Arc<dyn FaultInjector> = PanicFaults::at(FaultPoint::StorageBeforePersist);
    let _ = write(&handle, "d1.md", "boom", 1, panic_faults).await;
    wait_for_closed(&handle);

    // Restart evicts the dead actor and carries the generation forward.
    let reopened = sup.restart(&db, 2).expect("restart");
    assert_eq!(sup.generation_of(&db).expect("gen"), Some(2));
    assert_eq!(sup.actor_count(), 1);

    // The reopened actor is writable; the rolled-back panic left no data.
    write(&reopened, "d2.md", "ok", 2, Arc::new(NoFaults))
        .await
        .expect("write after restart");
    assert_eq!(read(&reopened, "d1.md").await, None);
    assert_eq!(read(&reopened, "d2.md").await.as_deref(), Some("ok"));
}

// oracle: concurrent opens of the same file converge on ONE actor / ONE writer
// (the reservation protocol dedups; the lock is not held across the spawn).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_opens_share_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let sup = Arc::new(WorkspaceSupervisor::new());

    let mut joins = Vec::new();
    for t in 0..8 {
        let sup = Arc::clone(&sup);
        let db = db.clone();
        joins.push(tokio::spawn(async move {
            let handle = sup.open(&db, 1).expect("concurrent open").actor;
            seed(&handle).await;
            write(&handle, &format!("d-{t}.md"), "v", 1, Arc::new(NoFaults))
                .await
                .expect("write");
            handle
        }));
    }
    let mut handles = Vec::new();
    for join in joins {
        handles.push(join.await.expect("join"));
    }

    assert_eq!(sup.actor_count(), 1, "all opens share one actor");
    let first_identity = handles[0].identity();
    for handle in &handles {
        assert_eq!(handle.identity(), first_identity, "one file identity");
    }
    // Every concurrent write landed in the single store.
    for t in 0..8 {
        assert_eq!(
            read(&handles[0], &format!("d-{t}.md")).await.as_deref(),
            Some("v")
        );
    }
}
