use super::super::{EngineDbIdentity, LifecycleState, WorkspaceActor};
use super::*;
use dohc_engine_storage::{EngineStore, RetainedDisplacement, hex_sha256};
use dohc_engine_testkit::ScratchDir;
use std::os::unix::fs::MetadataExt;
use std::time::Instant;
fn actor(scratch: &ScratchDir) -> WorkspaceActor {
    let db = scratch.path().join("engine.db");
    drop(EngineStore::open(&db, 0).unwrap());
    WorkspaceActor::spawn(
        db.clone(),
        EngineDbIdentity::of_existing(&db).unwrap(),
        1,
        0,
        None,
    )
    .unwrap()
}
fn add_sources(actor: &WorkspaceActor, scratch: &ScratchDir, count: usize) {
    let directory = scratch.path().join(".dohc/engine/displaced");
    std::fs::create_dir_all(&directory).unwrap();
    let mut rows = Vec::new();
    for n in 0..count {
        let path = directory.join(format!("worker-{n}"));
        std::fs::write(&path, b"known").unwrap();
        let m = std::fs::metadata(&path).unwrap();
        rows.push(RetainedDisplacement {
            displacement_id: 0,
            job_id: format!("worker-{n}"),
            workspace_id: "ws".into(),
            target_path: "notes.md".into(),
            source_path: format!(".dohc/engine/displaced/worker-{n}"),
            device: m.dev().to_string(),
            inode: m.ino().to_string(),
            digest: hex_sha256(b"known"),
            size: m.len() as i64,
            mtime: format!("{}:{}", m.mtime(), m.mtime_nsec()),
            ctime: format!("{}:{}", m.ctime(), m.ctime_nsec()),
            changed_at_ms: 0,
        });
    }
    actor
        .handle()
        .run_blocking(move |s, _| {
            s.put_binary_blob(b"known")?;
            for row in rows {
                s.retain_displacement(&row)?;
            }
            Ok(())
        })
        .unwrap();
}
fn wait_for(root: &Root, predicate: impl Fn(&[(i64, bool, Duration)]) -> bool) {
    let deadline = Instant::now() + MAX_BACKOFF * 4;
    let (lock, cv) = &*root.0;
    let mut state = lock.lock().unwrap();
    while !predicate(&state.passes) {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "worker progress: {:?}", state.passes);
        state = cv.wait_timeout(state, left).unwrap().0;
    }
}
fn bind(actor: &WorkspaceActor, scratch: &ScratchDir) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(
            actor
                .handle()
                .materialize_replay_pending(scratch.path().into(), "ws".into(), 0),
        )
        .unwrap();
}
#[test]
fn production_worker_binds_through_replay_pages_and_joins_on_close() {
    let scratch = ScratchDir::new().unwrap();
    let mut actor = actor(&scratch);
    add_sources(&actor, &scratch, 130);
    assert!(actor.retention_root.0.0.lock().unwrap().passes.is_empty());
    assert!(
        scratch
            .path()
            .join(".dohc/engine/displaced/worker-0")
            .exists()
    );
    bind(&actor, &scratch);
    wait_for(&actor.retention_root, |p| p.iter().any(|v| v.0 == 130));
    let passes = &actor.retention_root.0.0.lock().unwrap().passes.clone();
    assert!(
        passes.iter().any(|v| v.0 == 128),
        "first bounded page: {passes:?}"
    );
    assert!(
        actor
            .handle()
            .run_blocking(|s, _| Ok(s.retained_displacements_after(0)?))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        std::fs::read_dir(scratch.path().join(".dohc/engine/displaced"))
            .unwrap()
            .count(),
        0
    );
    actor.close().unwrap();
    assert_eq!(actor.lifecycle(), LifecycleState::Closed);
    assert!(actor.retention.as_ref().unwrap().join.is_none());
    actor.close().unwrap();
}
#[test]
fn production_worker_retries_a_failed_listing_and_backs_off_when_empty() {
    let scratch = ScratchDir::new().unwrap();
    let mut actor = actor(&scratch);
    bind(&actor, &scratch);
    wait_for(&actor.retention_root, |p| !p.is_empty());
    actor
        .handle()
        .run_blocking(|s, _| {
            s.read_with(|c| {
                c.execute_batch(
                    "ALTER TABLE materialization_retained RENAME TO temporarily_unavailable",
                )
            })
            .unwrap();
            Ok(())
        })
        .unwrap();
    actor.retention_root.set(scratch.path().into());
    wait_for(&actor.retention_root, |p| p.iter().any(|v| v.1));
    actor
        .handle()
        .run_blocking(|s, _| {
            s.read_with(|c| {
                c.execute_batch(
                    "ALTER TABLE temporarily_unavailable RENAME TO materialization_retained",
                )
            })
            .unwrap();
            Ok(())
        })
        .unwrap();
    add_sources(&actor, &scratch, 1);
    // No wake after repairing the store: the real retry deadline must fire.
    wait_for(&actor.retention_root, |p| {
        p.iter().any(|v| v.0 == 1 && !v.1)
    });
    wait_for(&actor.retention_root, |p| {
        p.iter()
            .rev()
            .take(1)
            .any(|v| v.0 == 0 && !v.1 && v.2 >= Duration::from_secs(4))
    });
    assert!(
        !scratch
            .path()
            .join(".dohc/engine/displaced/worker-0")
            .exists()
    );
    actor.close().unwrap();
    assert!(actor.retention.as_ref().unwrap().join.is_none());
}
#[test]
fn production_worker_closes_while_unbound() {
    let scratch = ScratchDir::new().unwrap();
    let mut actor = actor(&scratch);
    actor.close().unwrap();
    assert!(actor.retention.as_ref().unwrap().join.is_none());
    assert!(actor.retention_root.0.0.lock().unwrap().passes.is_empty());
}

#[test]
fn production_worker_imports_changed_bytes_and_promotes_oversized_sources() {
    let scratch = ScratchDir::new().unwrap();
    let mut actor = actor(&scratch);
    add_sources(&actor, &scratch, 2);
    let directory = scratch.path().join(".dohc/engine/displaced");
    std::fs::write(directory.join("worker-0"), b"outside").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(directory.join("worker-1"))
        .unwrap()
        .set_len(dohc_engine_storage::MAX_MATERIALIZE_BYTES as u64 + 1)
        .unwrap();
    bind(&actor, &scratch);
    wait_for(&actor.retention_root, |p| p.iter().any(|v| v.0 == 2));
    actor
        .handle()
        .run_blocking(|s, _| {
            let bytes: Vec<u8> = s
                .read_with(|c| {
                    c.query_row(
                        "SELECT bytes FROM materialization_displacement_reads",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(bytes, b"outside");
            assert_eq!(s.retained_displacements_after(0)?.len(), 1);
            assert_eq!(s.list_kept_displacements("ws")?.len(), 1);
            Ok(())
        })
        .unwrap();
    assert!(directory.join("worker-1").exists());
    actor.close().unwrap();
}

#[test]
fn close_finishes_an_inflight_changed_read_before_closing_the_writer() {
    let scratch = ScratchDir::new().unwrap();
    let mut actor = actor(&scratch);
    add_sources(&actor, &scratch, 1);
    std::fs::write(
        scratch.path().join(".dohc/engine/displaced/worker-0"),
        b"last outside version",
    )
    .unwrap();
    let root = actor.retention_root.clone();
    let handle = actor.handle();
    let commit = Arc::new(std::sync::Barrier::new(2));
    let (ready, read) = std::sync::mpsc::sync_channel(1);
    root.0.0.lock().unwrap().import_gate = Some((ready, commit.clone()));
    bind(&actor, &scratch);
    read.recv_timeout(MAX_BACKOFF * 4).unwrap();
    let closer = std::thread::spawn(move || {
        actor.close().unwrap();
    });
    let (lock, cv) = &*root.0;
    let state = lock.lock().unwrap();
    let (state, timeout) = cv
        .wait_timeout_while(state, MAX_BACKOFF * 4, |s| !s.joining)
        .unwrap();
    assert!(!timeout.timed_out());
    drop(state);
    // A failed probe must also release the import gate so the test cannot hang.
    let writer_alive = handle.run_blocking(|_, _| Ok(())).is_ok();
    commit.wait();
    closer.join().unwrap();
    assert!(writer_alive, "writer closed ahead of the in-flight import");
    let store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let bytes: Vec<u8> = store
        .read_with(|c| {
            c.query_row(
                "SELECT bytes FROM materialization_displacement_reads",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(bytes, b"last outside version");
}
#[test]
fn passive_store_never_spawns_a_retention_worker_even_after_root_binding() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.path().join("engine.db");
    drop(EngineStore::open_passive(&db, 0, None, None).unwrap());
    let mut actor = WorkspaceActor::spawn_passive(
        db.clone(),
        EngineDbIdentity::of_existing(&db).unwrap(),
        1,
        0,
        None,
        None,
    )
    .unwrap();
    assert!(actor.retention.is_none());
    bind(&actor, &scratch);
    assert!(actor.retention.is_none());
    assert!(actor.retention_root.0.0.lock().unwrap().passes.is_empty());
    actor.close().unwrap();
    assert_eq!(actor.lifecycle(), LifecycleState::Closed);
}
