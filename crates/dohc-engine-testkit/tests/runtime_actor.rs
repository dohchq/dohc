//! Workspace-actor traces: lifecycle, canonical identity convergence across
//! aliases, single-writer dedup, restart generations, and deterministic
//! connection release on close.

use dohc_engine_domain::WriteText;
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, FaultInjector, FaultPoint, LifecycleState, NoFaults,
    RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::EngineStore;

use dohc_engine_testkit::{
    PanicFaults, ScratchDir, engine_db_path, make_hardlink, try_make_dir_alias,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WS: &str = "ws";

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

// oracle: a symlink/junction to the engine dir never forks a second writer.
// On a Mac and Linux the engine refuses a store reached through a linked
// folder; on Windows the alias converges on the same actor (portability +
// file-identity). Skips honestly if the platform refuses to create the alias.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn symlink_or_junction_alias_never_forks_a_writer() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db path"); // creates .dohc/engine
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
    #[cfg(any(target_vendor = "apple", target_os = "linux"))]
    {
        let Err(refused) = sup.open(&aliased_db, 1) else {
            panic!("a store reached through a linked folder must be refused");
        };
        assert!(
            matches!(refused, RuntimeError::Identity { .. }),
            "{refused:?}"
        );
        assert_ne!(real.lifecycle(), LifecycleState::Closed);
    }
    #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
    let via_link = {
        let via_link = sup.open(&aliased_db, 1).expect("open via link").actor;
        assert_eq!(
            real.identity(),
            via_link.identity(),
            "the junction/symlink must canonicalize to the real db identity"
        );
        via_link
    };
    assert_eq!(
        sup.actor_count(),
        1,
        "aliased opens must not fork a second writer"
    );

    seed(&real).await;
    write(&real, "k.md", "value", 1, Arc::new(NoFaults))
        .await
        .expect("write real");
    #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
    assert_eq!(read(&via_link, "k.md").await.as_deref(), Some("value"));
}

// Close joins the writer and checkpoint worker. Retained WAL bytes are durable
// data, not an open connection. The Windows gate proves handle release with
// exclusive opens; on POSIX this test proves only that a fresh writer can
// reopen and read every committed row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_releases_the_connection() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db path");
    let sup = WorkspaceSupervisor::new();

    let handle = sup.open(&db, 1).expect("open").actor;
    seed(&handle).await;
    write(&handle, "d.md", "x", 1, Arc::new(NoFaults))
        .await
        .expect("write");
    sup.close_all().expect("close all");
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
    assert_eq!(sup.actor_count(), 0);

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        for path in [
            db.clone(),
            db.with_extension("db-wal"),
            db.with_extension("db-shm"),
        ] {
            if path.exists() {
                let exclusive = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .share_mode(0)
                    .open(&path)
                    .expect("close must release every database and sidecar handle");
                drop(exclusive);
            }
        }
    }

    // A fresh writer reads the committed row through any retained WAL.
    let mut reopened = EngineStore::open(&db, 99).expect("fresh writer after close");
    assert_eq!(reopened.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        dohc_engine_domain::VersionedTextStore::new(&mut reopened)
            .read_text(WS, "main", "d.md")
            .unwrap()
            .unwrap()
            .text,
        "x"
    );
}

// oracle: a hard link addresses the same bytes → same file identity → one
// actor (a path-key would have forked a second writer).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hardlink_converges_on_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db path");
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

// oracle: restart after a panicked predecessor preserves generation continuity
// and yields a fresh, writable actor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_after_panicked_predecessor_continues_generation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db path");
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

// oracle: concurrent opens of the same file converge on one actor / one writer
// (the reservation protocol dedups; the lock is not held across the spawn).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_opens_share_one_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db path");
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
