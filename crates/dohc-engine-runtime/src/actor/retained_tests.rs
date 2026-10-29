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
            busy_check_unsupported: false,
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

/// The actor's store opens through its engine folder, by the folder's ID on
/// a Mac and by the descriptor held for it on Linux. After the folder moves
/// and another takes its name, the worker still reads a retained file,
/// recorded under the name main stores, in the folder the store opened
/// through (#2468).
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
#[test]
fn the_worker_reads_retained_files_in_the_folder_the_store_opened_through() {
    let scratch = ScratchDir::new().unwrap();
    let engine = scratch.path().join(".dohc/engine");
    std::fs::create_dir_all(&engine).unwrap();
    let folder = std::fs::File::open(&engine).unwrap();
    let shown = std::path::Path::new(".dohc/engine");
    #[cfg(target_vendor = "apple")]
    let dir = dohc_macos_files::path_by_id(&folder, shown)
        .unwrap()
        .expect("APFS reaches a folder by ID");
    #[cfg(target_os = "linux")]
    let dir = dohc_linux_files::held::held_path(std::os::fd::AsFd::as_fd(&folder), shown).unwrap();
    let db = dir.join("engine.db");
    drop(EngineStore::open(&db, 0).unwrap());
    let identity = EngineDbIdentity::of_existing(&db).unwrap();
    let mut actor = WorkspaceActor::spawn(db, identity, 1, 0, None).unwrap();
    add_sources(&actor, &scratch, 1);
    std::fs::write(engine.join("displaced/worker-0"), b"outside").unwrap();
    std::fs::rename(&engine, scratch.path().join(".dohc/moved")).unwrap();
    std::fs::create_dir_all(engine.join("displaced")).unwrap();
    bind(&actor, &scratch);
    wait_for(&actor.retention_root, |p| p.iter().any(|v| v.0 == 1));
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
            Ok(())
        })
        .unwrap();
    assert_eq!(
        std::fs::read_dir(engine.join("displaced")).unwrap().count(),
        0
    );
    actor.close().unwrap();
    drop(folder);
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

#[test]
fn capture_file_hold_worker_keeps_quiet_sources_imports_late_writes_and_releases_after_clear() {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.path().join("engine.db");
    let target = scratch.path().join("notes.md");
    let source = scratch.path().join(".dohc/engine/displaced/worker-0");
    std::fs::write(&target, b"held outside version").unwrap();
    let mut first = actor(&scratch);
    add_sources(&first, &scratch, 1);
    first.handle().run_blocking(|s, _| {
        s.write_with(&dohc_engine_storage::NoFaults, |tx| {
            tx.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','Main',1); INSERT INTO file_objects VALUES ('ws','held-object',1);").map_err(dohc_engine_storage::StorageError::persist_public)?;
            dohc_engine_storage::capture_file_holds::record_in(tx, &dohc_engine_storage::capture_file_holds::CaptureFileHold {
                workspace_id: "ws".into(), source_version_id: "main".into(), object_id: "held-object".into(), path: "notes.md".into(), observed_sha256: hex_sha256(b"held outside version"), observed_size: 20, reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE.into(), observed_at_ms: 0, attempt_count: 1, retry_requested: false,
            })
        })?;
        Ok(())
    }).unwrap();
    bind(&first, &scratch);
    wait_for(&first.retention_root, |p| {
        p.iter().filter(|v| v.0 == 1).count() >= 2
    });
    first.close().unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), b"known");
    let store = EngineStore::open(&db, 0).unwrap();
    assert_eq!(store.retained_displacements_after(0).unwrap().len(), 1);
    drop(store);

    std::fs::write(&source, b"late outside write to held original").unwrap();
    let mut second = actor(&scratch);
    bind(&second, &scratch);
    wait_for(&second.retention_root, |p| p.iter().any(|v| v.0 == 1));
    second.close().unwrap();
    let store = EngineStore::open(&db, 0).unwrap();
    let bytes: Vec<u8> = store
        .read_with(|c| {
            c.query_row(
                "SELECT bytes FROM materialization_displacement_reads",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(bytes, b"late outside write to held original");
    assert_eq!(store.retained_displacements_after(0).unwrap().len(), 1);
    store
        .read_with(|c| c.execute("UPDATE materialization_retained SET changed_at_ms=0", []))
        .unwrap();
    drop(store);

    let mut third = actor(&scratch);
    bind(&third, &scratch);
    wait_for(&third.retention_root, |p| p.iter().any(|v| v.0 == 1));
    third.close().unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    let mut store = EngineStore::open(&db, 0).unwrap();
    assert_eq!(store.retained_displacements_after(0).unwrap().len(), 1);
    store
        .write_with(&dohc_engine_storage::NoFaults, |tx| {
            dohc_engine_storage::capture_file_holds::clear_in(tx, "ws", "notes.md")
        })
        .unwrap();
    drop(store);

    let mut fourth = actor(&scratch);
    bind(&fourth, &scratch);
    wait_for(&fourth.retention_root, |p| p.iter().any(|v| v.0 == 1));
    fourth.close().unwrap();
    let store = EngineStore::open(&db, 0).unwrap();
    assert!(store.retained_displacements_after(0).unwrap().is_empty());
    assert!(!source.exists());
    assert_eq!(std::fs::read(&target).unwrap(), b"held outside version");
    assert_eq!(
        store
            .table_row_count("materialization_displacement_reads")
            .unwrap(),
        1
    );
}
#[test]
fn refused_releases_back_off_from_thirty_seconds_to_fifteen_minutes() {
    let mut wait = None;
    let mut waits = Vec::new();
    for _ in 0..8 {
        let next = next_retry(wait);
        waits.push(next.as_secs());
        wait = Some(next);
    }
    assert_eq!(waits, [30, 60, 120, 240, 480, 900, 900, 900]);
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// The first name job `job` stages its original under.
fn staged(job: &str) -> String {
    job.bytes().map(|b| format!("{b:02x}")).collect::<String>() + ".0"
}

/// A retained original of job `job` for `target`, on an unchecked volume.
fn add_source(actor: &WorkspaceActor, scratch: &ScratchDir, job: &str, target: &str) -> i64 {
    add_source_at(
        actor,
        scratch,
        job,
        target,
        &format!(".dohc/engine/displaced/{}", staged(job)),
        b"known",
    )
}

/// A retained original of job `job` for `target` at `source`, holding `bytes`.
fn add_source_at(
    actor: &WorkspaceActor,
    scratch: &ScratchDir,
    job: &str,
    target: &str,
    source: &str,
    bytes: &[u8],
) -> i64 {
    let path = scratch.path().join(source);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    let m = std::fs::metadata(&path).unwrap();
    let blob = bytes.to_vec();
    let row = RetainedDisplacement {
        displacement_id: 0,
        job_id: job.into(),
        workspace_id: "ws".into(),
        target_path: target.into(),
        source_path: source.into(),
        device: m.dev().to_string(),
        inode: m.ino().to_string(),
        digest: hex_sha256(bytes),
        size: m.len() as i64,
        mtime: format!("{}:{}", m.mtime(), m.mtime_nsec()),
        ctime: format!("{}:{}", m.ctime(), m.ctime_nsec()),
        changed_at_ms: 0,
        busy_check_unsupported: true,
    };
    actor
        .handle()
        .run_blocking(move |s, _| {
            s.put_binary_blob(&blob)?;
            Ok(s.retain_displacement(&row)?)
        })
        .unwrap()
}

/// #2205: the sweep records that a volume cannot refuse to unlink an open
/// file, keeps every original there, and counts them by workspace.
#[test]
fn the_sweep_records_an_unchecked_volume_and_keeps_its_originals() {
    let scratch = ScratchDir::new().unwrap();
    let _simulated = dohc_engine_files::retained::unchecked::simulate(scratch.path());
    let mut actor = actor(&scratch);
    add_sources(&actor, &scratch, 2);
    bind(&actor, &scratch);
    wait_for(&actor.retention_root, |p| {
        p.iter().filter(|v| v.0 == 2).count() >= 2
    });
    let (rows, summary) = actor
        .handle()
        .run_blocking(|s, _| {
            Ok((
                s.retained_displacements_after(0)?,
                s.retained_summary("ws")?,
            ))
        })
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.busy_check_unsupported));
    assert_eq!(
        summary,
        dohc_engine_storage::RetainedSummary {
            count: 2,
            bytes: 10
        }
    );
    assert_eq!(
        std::fs::read_dir(scratch.path().join(".dohc/engine/displaced"))
            .unwrap()
            .count(),
        2
    );
    actor.close().unwrap();
}

/// #2205: an explicit delete lists and removes only quiet, finished,
/// unheld originals on an unchecked volume. A changed source is recorded and
/// kept, a hold taken after the check keeps its source, and an unfinished
/// job's original and a kept recovery file stay.
#[test]
fn an_explicit_delete_removes_only_eligible_originals() {
    let scratch = ScratchDir::new().unwrap();
    let _simulated = dohc_engine_files::retained::unchecked::simulate(scratch.path());
    let mut actor = actor(&scratch);
    let displaced = scratch.path().join(".dohc/engine/displaced");
    let eligible = add_source(&actor, &scratch, "eligible", "a.md");
    let changed = add_source(&actor, &scratch, "changed", "b.md");
    let unfinished = add_source(&actor, &scratch, "unfinished", "c.md");
    let kept_name = add_source(&actor, &scratch, "kept-name", "d.md");
    let held = add_source(&actor, &scratch, "held", "held.md");
    let checked = add_source(&actor, &scratch, "checked", "e.md");
    let recent = add_source(&actor, &scratch, "recent", "f.md");
    let legacy = add_source(&actor, &scratch, "legacy", "g.md");
    std::fs::write(displaced.join("kept-file"), b"another program's bytes").unwrap();
    actor
        .handle()
        .run_blocking(move |s, _| {
            s.read_with(|c| {
                c.execute_batch(&format!(
                    "UPDATE materialization_retained SET release_blocked=NULL WHERE displacement_id={checked};
                     UPDATE materialization_retained SET changed_at_ms=9223372036854775000 WHERE displacement_id={recent};
                     UPDATE materialization_retained SET workspace_id='' WHERE displacement_id={legacy};
                     INSERT INTO materialization_jobs(job_id,target_path,content_sha256,preimage_present,target_generation,status,created_at_ms,operation,workspace_id)
                       VALUES('unfinished','c.md','{}',0,1,'pending',1,'write','ws');",
                    hex_sha256(b"known")
                ))
            })
            .unwrap();
            for (job, name) in [("kept-name", staged("kept-name")), ("kept-file", "kept-file".into())] {
                s.keep_displacement(
                    &dohc_engine_storage::DisplacementSpec {
                        job_id: job.into(),
                        workspace_id: "ws".into(),
                        target_path: "d.md".into(),
                        displaced_name: name,
                        expected_sha256: String::new(),
                        content_sha256: None,
                        now_ms: 1,
                    },
                    None,
                )?;
            }
            Ok(())
        })
        .unwrap();
    let (listed, more) = runtime()
        .block_on(actor.handle().list_retained_copies("ws".into()))
        .unwrap();
    assert!(!more);
    assert_eq!(
        listed.iter().map(|c| c.id).collect::<Vec<_>>(),
        [eligible, changed, held],
        "unfinished, kept, checked, recent and other-workspace originals are not listed"
    );
    std::fs::write(displaced.join(staged("changed")), b"outside").unwrap();
    let mut requested = listed.clone();
    for id in [unfinished, kept_name, checked, recent, legacy] {
        requested.push(RetainedCandidate { id, revision: 0 });
    }
    let commit = Arc::new(std::sync::Barrier::new(2));
    let (ready, checked_sources) = std::sync::mpsc::sync_channel(1);
    actor.retention_root.0.0.lock().unwrap().unlink_gate = Some((ready, commit.clone()));
    let (handle, root) = (actor.handle(), scratch.path().to_path_buf());
    let deleting = std::thread::spawn(move || {
        runtime().block_on(handle.delete_retained_copies(root, "ws".into(), requested))
    });
    checked_sources.recv_timeout(MAX_BACKOFF * 4).unwrap();
    actor
        .handle()
        .run_blocking(|s, _| {
            s.write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','Main',1); INSERT INTO file_objects VALUES ('ws','held-object',1);").map_err(dohc_engine_storage::StorageError::persist_public)?;
                dohc_engine_storage::capture_file_holds::record_in(tx, &dohc_engine_storage::capture_file_holds::CaptureFileHold {
                    workspace_id: "ws".into(), source_version_id: "main".into(), object_id: "held-object".into(), path: "held.md".into(), observed_sha256: hex_sha256(b"held"), observed_size: 4, reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE.into(), observed_at_ms: 0, attempt_count: 1, retry_requested: false,
                })
            })?;
            Ok(())
        })
        .unwrap();
    commit.wait();
    let outcome = deleting.join().unwrap().unwrap();
    assert_eq!(
        (outcome.deleted, outcome.skipped, outcome.failed),
        (1, 7, 0),
        "{outcome:?}"
    );
    let mut left: Vec<String> = std::fs::read_dir(&displaced)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    let mut expected: Vec<String> = [
        "changed",
        "checked",
        "held",
        "kept-name",
        "legacy",
        "recent",
        "unfinished",
    ]
    .map(staged)
    .into();
    expected.push("kept-file".into());
    expected.sort();
    assert_eq!(left, expected);
    let rows = actor
        .handle()
        .run_blocking(|s, _| Ok(s.retained_displacements_after(0)?))
        .unwrap();
    assert!(rows.iter().all(|row| row.displacement_id != eligible));
    let changed_row = rows
        .iter()
        .find(|row| row.displacement_id == changed)
        .unwrap();
    assert_eq!(changed_row.digest, hex_sha256(b"outside"));
    assert!(changed_row.busy_check_unsupported);
    let recorded: Vec<u8> = actor
        .handle()
        .run_blocking(|s, _| {
            Ok(s.read_with(|c| {
                c.query_row(
                    "SELECT bytes FROM materialization_displacement_reads",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap())
        })
        .unwrap();
    assert_eq!(recorded, b"outside");
    // changed (7 bytes), unfinished, kept-name, held and recent (5 each).
    assert_eq!(
        outcome.remaining,
        dohc_engine_storage::RetainedSummary {
            count: 5,
            bytes: 27
        }
    );
    actor.close().unwrap();
}

/// A delete records each changed source before it reads the next, so a
/// batch never holds more than one source's bytes.
#[test]
fn a_delete_records_each_changed_source_before_reading_the_next() {
    let scratch = ScratchDir::new().unwrap();
    let _simulated = dohc_engine_files::retained::unchecked::simulate(scratch.path());
    let mut actor = actor(&scratch);
    let displaced = scratch.path().join(".dohc/engine/displaced");
    let sizes = [3_000, 1_000, 2_000];
    let mut requested = Vec::new();
    for (n, size) in sizes.into_iter().enumerate() {
        let job = format!("changed-{n}");
        let id = add_source(&actor, &scratch, &job, &format!("{n}.md"));
        std::fs::write(displaced.join(staged(&job)), vec![b'x' + n as u8; size]).unwrap();
        requested.push(RetainedCandidate { id, revision: 0 });
    }
    let outcome = runtime()
        .block_on(actor.handle().delete_retained_copies(
            scratch.path().into(),
            "ws".into(),
            requested,
        ))
        .unwrap();
    assert_eq!(
        (outcome.deleted, outcome.skipped, outcome.failed),
        (0, 3, 0)
    );
    let recorded: i64 = actor
        .handle()
        .run_blocking(|s, _| Ok(s.table_row_count("materialization_displacement_reads")?))
        .unwrap();
    assert_eq!(recorded, 3);
    let state = actor.retention_root.0.0.lock().unwrap();
    assert_eq!(state.unrecorded, 0);
    assert_eq!(
        state.unrecorded_peak,
        3_000,
        "one source at a time, not {}",
        sizes.iter().sum::<usize>()
    );
    drop(state);
    actor.close().unwrap();
}

/// An explicit delete removes only a staged original in its job's staging
/// folder, whatever a row names.
#[test]
fn an_explicit_delete_skips_a_row_naming_anything_but_a_staged_original() {
    let scratch = ScratchDir::new().unwrap();
    let _simulated = dohc_engine_files::retained::unchecked::simulate(scratch.path());
    let mut actor = actor(&scratch);
    let rows = [
        ("outside", "notes.md".to_owned()),
        ("loose", ".dohc/engine/displaced/not-staged".to_owned()),
        (
            "mismatch",
            format!(".dohc/engine/displaced/{}", staged("other")),
        ),
        (
            "elsewhere",
            format!("folder/.dohc-write-displaced/{}", staged("elsewhere")),
        ),
    ];
    let mut requested = Vec::new();
    for (job, source) in &rows {
        let id = add_source_at(&actor, &scratch, job, "a.md", source, b"user bytes");
        requested.push(RetainedCandidate { id, revision: 0 });
    }
    let (listed, _) = runtime()
        .block_on(actor.handle().list_retained_copies("ws".into()))
        .unwrap();
    assert!(listed.is_empty(), "{listed:?}");
    let outcome = runtime()
        .block_on(actor.handle().delete_retained_copies(
            scratch.path().into(),
            "ws".into(),
            requested,
        ))
        .unwrap();
    assert_eq!(
        (outcome.deleted, outcome.skipped, outcome.failed),
        (0, 4, 0)
    );
    for (_, source) in &rows {
        assert_eq!(
            std::fs::read(scratch.path().join(source)).unwrap(),
            b"user bytes"
        );
    }
    actor.close().unwrap();
}

/// A deleted copy counts as deleted when its emptied staging folder can't be
/// removed.
#[test]
fn a_delete_counts_a_removed_copy_whose_staging_folder_stays() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = ScratchDir::new().unwrap();
    let _simulated = dohc_engine_files::retained::unchecked::simulate(scratch.path());
    let mut actor = actor(&scratch);
    let source = format!("folder/.dohc-write-displaced/{}", staged("stuck"));
    let id = add_source_at(&actor, &scratch, "stuck", "folder/a.md", &source, b"old");
    actor
        .handle()
        .run_blocking(|s, _| Ok(s.remember_staging("stuck", "folder/.dohc-write-displaced")?))
        .unwrap();
    // The folder that holds the staging folder refuses its removal.
    let folder = scratch.path().join("folder");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    let outcome = runtime().block_on(actor.handle().delete_retained_copies(
        scratch.path().into(),
        "ws".into(),
        vec![RetainedCandidate { id, revision: 0 }],
    ));
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    let outcome = outcome.unwrap();
    assert_eq!(
        (outcome.deleted, outcome.skipped, outcome.failed),
        (1, 0, 0)
    );
    assert!(!scratch.path().join(&source).exists());
    actor.close().unwrap();
}
