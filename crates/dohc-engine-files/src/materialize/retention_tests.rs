use super::*;
use dohc_engine_storage::{MaterializationJobSpec, NoFaults, enqueue_job};
use dohc_test_scratch::ScratchDir;
use std::sync::atomic::{AtomicUsize, Ordering};
fn options(now_ms: i64, replacer: &dyn AtomicReplacer) -> MaterializeOptions<'_> {
    MaterializeOptions {
        policy: DurabilityPolicy::none(),
        replacer,
        backoff: &NoBackoff,
        now_ms,
        faults: &NoFaults,
    }
}
fn job(
    store: &mut EngineStore,
    id: &str,
    path: &str,
    before: &[u8],
    after: &[u8],
    n: i64,
) -> MaterializationJob {
    let preimage = store.put_binary_blob(before).unwrap();
    let content = store.put_binary_blob(after).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: id.into(),
                    workspace_id: "ws".into(),
                    target_path: path.into(),
                    content_sha256: content,
                    preimage: Preimage::Present(preimage),
                    target_generation: n,
                    now_ms: n,
                },
            )
        })
        .unwrap();
    store.load_materialization_job(id).unwrap().unwrap()
}
#[cfg(unix)]
fn sweep(store: &EngineStore, root: &Path, now: i64) {
    use crate::retained::{Inspection, inspect};
    let mut cursor = 0;
    loop {
        let rows = store.retained_displacements_after(cursor).unwrap();
        if rows.is_empty() {
            break;
        }
        cursor = rows.last().unwrap().displacement_id;
        for row in rows {
            match inspect(root, &row, now).unwrap() {
                Inspection::Release(token) => {
                    assert!(token.remove().unwrap());
                    store.release_retained(row.displacement_id).unwrap();
                    cleanup_staging_directory(
                        store,
                        root,
                        root.join(&row.source_path).parent().unwrap(),
                    )
                    .unwrap();
                }
                Inspection::Changed { current, bytes } => store
                    .record_retained_read(&row, &current, &bytes, now)
                    .unwrap(),
                Inspection::Missing => store.release_retained(row.displacement_id).unwrap(),
                Inspection::Oversized => store.keep_oversized_retained(&row, now).unwrap(),
                Inspection::Keep => {}
            }
        }
    }
}
#[cfg(unix)]
#[test]
fn p0_thousand_settles_bound_staging_and_save_latency() {
    let scratch = ScratchDir::new_named("p0-thousand").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    let mut before = vec![0u8; 64 * 1024];
    std::fs::write(&target, &before).unwrap();
    let mut timings = Vec::new();
    let mut peak = 0;
    for n in 1..=1000 {
        let after = vec![(n % 251) as u8; 64 * 1024];
        let j = job(
            &mut store,
            &format!("settle-{n}"),
            "notes.md",
            &before,
            &after,
            n,
        );
        let now = n * 1000;
        let start = std::time::Instant::now();
        assert_eq!(
            materialize_one(&store, root, &j, &options(now, &StdReplacer)).unwrap(),
            JobOutcome::Completed
        );
        timings.push(start.elapsed().as_micros());
        assert!(!store.retained_displacements_after(0).unwrap().is_empty());
        sweep(&store, root, now);
        let count = std::fs::read_dir(root.join(STAGING_DIR)).unwrap().count();
        peak = peak.max(count);
        assert!(count <= 31, "{count} retained names");
        before = after;
    }
    sweep(&store, root, 1_030_000);
    assert_eq!(
        std::fs::read_dir(root.join(STAGING_DIR)).unwrap().count(),
        0
    );
    let median = |slice: &[u128]| {
        let mut v = slice.to_vec();
        v.sort();
        v[v.len() / 2]
    };
    let early = median(&timings[50..150]);
    let late = median(&timings[900..]);
    println!("1000 settles: peak={peak}, early median={early}us, late median={late}us");
    assert!(
        late <= early * 3 + 1000,
        "save latency grew: {early} -> {late}us"
    );
}
#[cfg(unix)]
#[test]
fn p0_write_within_q_is_a_durable_observation_and_restarts_clock() {
    use std::io::Write;
    let scratch = ScratchDir::new_named("p0-late-write").unwrap();
    let root = scratch.path();
    let db = root.join("engine.db");
    let mut store = EngineStore::open(&db, 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    assert_eq!(
        materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap(),
        JobOutcome::Completed
    );
    writer.write_all(b"outside within Q").unwrap();
    writer.flush().unwrap();
    drop(writer);
    sweep(&store, root, 10_000);
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    assert_eq!(row.changed_at_ms, 10_000);
    assert_eq!(row.digest, hex_sha256(b"outside within Q"));
    drop(store);
    let store = EngineStore::open(&db, 10_000).unwrap();
    let bytes: Vec<u8> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT bytes FROM materialization_displacement_reads",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(bytes, b"outside within Q");
    sweep(&store, root, 39_999);
    assert!(root.join(&row.source_path).exists());
    sweep(&store, root, 40_000);
    assert!(!root.join(&row.source_path).exists());
    assert_eq!(std::fs::read(&target).unwrap(), b"after");
}
#[cfg(target_os = "linux")]
#[test]
fn p0_linux_held_writable_descriptor_blocks_release() {
    let scratch = ScratchDir::new_named("p0-held-descriptor").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    let file = open_displaced(&root.join(&row.source_path)).unwrap();
    assert_eq!(
        dohc_linux_files::probe(&file).unwrap(),
        dohc_linux_files::LeaseProbe::WriterPresent
    );
    sweep(&store, root, 90_000);
    assert!(root.join(&row.source_path).exists());
    drop(writer);
    sweep(&store, root, 90_001);
    assert!(!root.join(&row.source_path).exists());
}
#[cfg(unix)]
#[test]
fn p0_restart_recovery_keeps_retained_rows_and_sources() {
    let scratch = ScratchDir::new_named("p0-restart").unwrap();
    let root = scratch.path();
    let db = root.join("engine.db");
    let mut store = EngineStore::open(&db, 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    drop(store);
    let store = EngineStore::open(&db, 1000).unwrap();
    recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
    assert_eq!(
        store.retained_displacements_after(0).unwrap(),
        vec![row.clone()]
    );
    assert_eq!(
        std::fs::read(root.join(row.source_path)).unwrap(),
        b"before"
    );
}
struct CrossVolume(AtomicUsize);
impl AtomicReplacer for CrossVolume {
    fn displace(&self, target: &Path, staged: &Path) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::Relaxed);
        if staged.parent().unwrap().file_name() == Some(OsStr::new("displaced")) {
            Err(std::io::Error::from(ErrorKind::CrossesDevices))
        } else {
            std::fs::rename(target, staged)
        }
    }
}
#[test]
fn p0_cross_volume_stages_beside_target() {
    let scratch = ScratchDir::new_named("p0-cross-volume").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    let replacer = CrossVolume(AtomicUsize::new(0));
    assert_eq!(
        materialize_one(&store, root, &j, &options(0, &replacer)).unwrap(),
        JobOutcome::Completed
    );
    assert_eq!(replacer.0.load(Ordering::Relaxed), 2);
    #[cfg(unix)]
    assert_eq!(
        store.staging_location("settle").unwrap().as_deref(),
        Some(".dohc-write-displaced")
    );
    #[cfg(not(unix))]
    {
        assert!(store.staging_location("settle").unwrap().is_none());
        assert!(!root.join(".dohc-write-displaced").exists());
    }
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"after");
    recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
}

#[cfg(feature = "fault-injection")]
#[test]
fn p0_sibling_staging_crash_recovers_pending_job() {
    struct CrashAt(FaultPoint);
    impl FaultInjector for CrashAt {
        fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == self.0 {
                dohc_engine_storage::FaultAction::Crash
            } else {
                dohc_engine_storage::FaultAction::Continue
            }
        }
    }
    for point in [
        FaultPoint::MaterializeAfterDisplaceBeforePlace,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
        FaultPoint::MaterializeAfterDisplacedHash,
        FaultPoint::MaterializeAfterKnownCopyDeletion,
    ] {
        let scratch = ScratchDir::new_named("p0-sibling-crash").unwrap();
        let root = scratch.path();
        let db = root.join("engine.db");
        let mut store = EngineStore::open(&db, 0).unwrap();
        std::fs::write(root.join("notes.md"), b"before").unwrap();
        let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
        let replacer = CrossVolume(AtomicUsize::new(0));
        let crash = CrashAt(point);
        let mut opts = options(0, &replacer);
        opts.faults = &crash;
        assert_eq!(
            materialize_one(&store, root, &j, &opts).unwrap(),
            JobOutcome::Crashed(point)
        );
        drop(store);
        let store = EngineStore::open(&db, 1000).unwrap();
        recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
        let j = store.load_materialization_job("settle").unwrap().unwrap();
        materialize_one(&store, root, &j, &options(1000, &StdReplacer)).unwrap();
        assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"after");
        #[cfg(unix)]
        assert_eq!(
            std::fs::read(
                root.join(&store.retained_displacements_after(0).unwrap()[0].source_path)
            )
            .unwrap(),
            b"before"
        );
    }
}
#[cfg(unix)]
#[test]
fn p0_hard_link_releases_the_staged_name_immediately() {
    let scratch = ScratchDir::new_named("p0-links").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    std::fs::hard_link(root.join("notes.md"), root.join("other.md")).unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    assert!(store.retained_displacements_after(0).unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(root.join(STAGING_DIR)).unwrap().count(),
        0
    );
    assert_eq!(std::fs::read(root.join("other.md")).unwrap(), b"before");
}

#[test]
fn p0_unsupported_sibling_staging_saves_with_a_reported_exception() {
    struct Unsupported;
    impl AtomicReplacer for Unsupported {
        fn displace(&self, _from: &Path, to: &Path) -> std::io::Result<()> {
            Err(std::io::Error::from(
                if to.parent().unwrap().file_name() == Some(OsStr::new("displaced")) {
                    ErrorKind::CrossesDevices
                } else {
                    ErrorKind::Unsupported
                },
            ))
        }
    }
    let scratch = ScratchDir::new_named("p0-staging-fallback").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    assert_eq!(
        materialize_one(&store, root, &j, &options(0, &Unsupported)).unwrap(),
        JobOutcome::Completed
    );
    assert!(workspace_lacks_atomic_placement(root));
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"after");
}

#[cfg(unix)]
#[test]
fn p0_cross_volume_delete_retains_the_original_on_its_volume() {
    let scratch = ScratchDir::new_named("p0-delete-mount").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let before = store.put_binary_blob(b"before").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::enqueue_delete_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "delete".into(),
                    workspace_id: "ws".into(),
                    target_path: "notes.md".into(),
                    content_sha256: before.clone(),
                    preimage: Preimage::Present(before),
                    target_generation: 1,
                    now_ms: 0,
                },
            )
        })
        .unwrap();
    let j = store.load_materialization_job("delete").unwrap().unwrap();
    let replacer = CrossVolume(AtomicUsize::new(0));
    assert_eq!(
        materialize_one(&store, root, &j, &options(0, &replacer)).unwrap(),
        JobOutcome::Completed
    );
    assert!(!root.join("notes.md").exists());
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    assert!(row.source_path.starts_with(".dohc-write-displaced/"));
    assert_eq!(
        std::fs::read(root.join(row.source_path)).unwrap(),
        b"before"
    );
}

#[cfg(unix)]
#[test]
fn remounted_identity_compares_digest_and_never_keeps_forever() {
    use crate::retained::{Inspection, inspect};
    let scratch = ScratchDir::new_named("p0-remount").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "remount", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    store
        .read_with(|c| {
            c.execute(
                "UPDATE materialization_retained SET device='changed-device'",
                [],
            )
        })
        .unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    assert!(matches!(
        inspect(root, &row, 30_000).unwrap(),
        Inspection::Release(_)
    ));
    let source = root.join(&row.source_path);
    std::fs::write(&source, b"outside after mount").unwrap();
    match inspect(root, &row, 30_001).unwrap() {
        Inspection::Changed { current, bytes } => {
            assert_eq!(bytes, b"outside after mount");
            assert_ne!(current.device, row.device);
            store
                .record_retained_read(&row, &current, &bytes, 30_001)
                .unwrap();
        }
        _ => panic!("changed identity must preserve changed bytes"),
    }
    let current = store.retained_displacements_after(0).unwrap().remove(0);
    assert_ne!(current.device, row.device);
    sweep(&store, root, 60_001);
    assert!(!source.exists());
    let observed: Vec<u8> = store
        .read_with(|c| {
            c.query_row(
                "SELECT bytes FROM materialization_displacement_reads",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(observed, b"outside after mount");
}
#[cfg(unix)]
#[test]
fn oversized_retained_source_becomes_a_recoverable_kept_copy() {
    use crate::retained::{Inspection, inspect};
    let scratch = ScratchDir::new_named("p0-retained-large").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "large", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    let source = root.join(&row.source_path);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_len(MAX_MATERIALIZE_BYTES as u64 + 1)
        .unwrap();
    assert!(matches!(
        inspect(root, &row, 1).unwrap(),
        Inspection::Oversized
    ));
    store.keep_oversized_retained(&row, 1).unwrap();
    store.keep_oversized_retained(&row, 2).unwrap(); // idempotent retry
    assert!(store.retained_displacements_after(0).unwrap().is_empty());
    recover_displacements(&store, root, Some("ws"), &options(2, &StdReplacer)).unwrap();
    let kept = store.list_kept_displacements("ws").unwrap();
    assert_eq!(kept.len(), 1);
    assert!(kept[0].displaced_sha256.is_none());
    assert_eq!(
        std::fs::metadata(&source).unwrap().len(),
        MAX_MATERIALIZE_BYTES as u64 + 1
    );
    assert!(matches!(
        save_kept_displacement(
            &store,
            root,
            "ws",
            kept[0].displacement_id,
            &options(3, &StdReplacer)
        )
        .unwrap(),
        KeptCopySave::Saved(_)
    ));
    assert_eq!(
        std::fs::metadata(root.join("notes (kept copy).md"))
            .unwrap()
            .len(),
        MAX_MATERIALIZE_BYTES as u64 + 1
    );
}
#[cfg(unix)]
#[test]
fn recovery_reconstructs_a_lost_normal_retained_row() {
    let scratch = ScratchDir::new_named("p0-lost-retained-row").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "lost", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    store.release_retained(row.displacement_id).unwrap();
    recover_displacements(&store, root, Some("ws"), &options(1, &StdReplacer)).unwrap();
    assert_eq!(store.retained_displacements_after(0).unwrap().len(), 1);
    assert_eq!(
        std::fs::read(root.join(row.source_path)).unwrap(),
        b"before"
    );
}
#[cfg(unix)]
#[test]
fn recovery_skips_bad_locations_and_keeps_the_whole_sweep_failure() {
    for symlink in [true, false] {
        let scratch = ScratchDir::new_named("p0-bad-location").unwrap();
        let outside = ScratchDir::new_named("p0-outside-location").unwrap();
        let root = scratch.path();
        let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
        if symlink {
            std::os::unix::fs::symlink(outside.path(), root.join("a-bad")).unwrap();
        } else {
            std::fs::write(root.join("a-bad"), b"not a directory").unwrap();
        }
        store
            .remember_staging("bad-location", "a-bad/.dohc-write-displaced")
            .unwrap();
        std::fs::create_dir_all(root.join("z-good/.dohc-write-displaced")).unwrap();
        for (id, path, directory) in [
            ("default", "default.md", STAGING_DIR),
            ("sibling", "z-good/notes.md", "z-good/.dohc-write-displaced"),
        ] {
            let j = job(&mut store, id, path, b"before", b"after", 1);
            if id == "sibling" {
                store.remember_staging(id, directory).unwrap();
            }
            std::fs::create_dir_all(root.join(directory)).unwrap();
            std::fs::write(
                root.join(directory).join(staged_name(&j.job_id, 0)),
                b"outside",
            )
            .unwrap();
        }
        recover_displacements(&store, root, Some("ws"), &options(1, &StdReplacer)).unwrap();
        assert_eq!(std::fs::read(root.join("default.md")).unwrap(), b"outside");
        assert_eq!(
            std::fs::read(root.join("z-good/notes.md")).unwrap(),
            b"outside"
        );
        assert!(
            workspace_recovery_unavailable(root),
            "later healthy directory hid the failure"
        );
        assert!(!root.join("z-good/.dohc-write-displaced").exists());
        assert!(store.staging_location("sibling").unwrap().is_none());
        std::fs::remove_file(root.join("a-bad")).unwrap();
        std::fs::create_dir(root.join("a-bad")).unwrap();
        recover_displacements(&store, root, Some("ws"), &options(2, &StdReplacer)).unwrap();
        assert!(!workspace_recovery_unavailable(root));
    }
}
#[cfg(unix)]
#[test]
fn releasing_last_sibling_source_removes_directory_and_location_rows() {
    let scratch = ScratchDir::new_named("p0-empty-sibling").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "empty", "notes.md", b"before", b"after", 1);
    materialize_one(
        &store,
        root,
        &j,
        &options(0, &CrossVolume(AtomicUsize::new(0))),
    )
    .unwrap();
    assert!(root.join(".dohc-write-displaced").exists());
    sweep(&store, root, 30_000);
    assert!(!root.join(".dohc-write-displaced").exists());
    assert!(store.staging_locations().unwrap().is_empty());
}

#[test]
fn sibling_cleanup_syncs_removal_before_forgetting_location() {
    for fail_sync in [false, true] {
        let scratch = ScratchDir::new_named("p0-cleanup-sync-order").unwrap();
        let root = scratch.path();
        let store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
        let relative = ".dohc-write-displaced";
        let directory = root.join(relative);
        std::fs::create_dir(&directory).unwrap();
        store.remember_staging("settle", relative).unwrap();
        let mut synced = false;
        let result = cleanup_staging_directory_with_sync(&store, root, &directory, |parent| {
            assert_eq!(parent, std::fs::canonicalize(root).unwrap());
            assert!(!directory.exists(), "remove before sync");
            assert_eq!(
                store.staging_location("settle").unwrap().as_deref(),
                Some(relative),
                "sync before forget"
            );
            synced = true;
            if fail_sync {
                return Err(MaterializeError::io(
                    parent,
                    &std::io::Error::from(ErrorKind::PermissionDenied),
                ));
            }
            sync_parent_dir(Some(parent), DurabilityPolicy::per_os())
        });
        assert!(synced, "cleanup must sync the parent");
        assert_eq!(result.is_err(), fail_sync);
        assert_eq!(
            store.staging_location("settle").unwrap().is_some(),
            fail_sync
        );
        // A retry must sync even when the directory is already absent.
        if fail_sync {
            cleanup_staging_directory(&store, root, &directory).unwrap();
            assert!(store.staging_location("settle").unwrap().is_none());
        }
    }
}

#[test]
fn kept_copy_save_succeeds_when_staging_cleanup_sync_fails() {
    for source_exists in [true, false] {
        let scratch = ScratchDir::new_named("p0-kept-cleanup-sync").unwrap();
        let root = scratch.path();
        let store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
        let relative = ".dohc-write-displaced";
        let directory = root.join(relative);
        std::fs::create_dir(&directory).unwrap();
        store.remember_staging("kept", relative).unwrap();
        let name = staged_name("kept", 0);
        let bytes = b"outside edit";
        if source_exists {
            let source = directory.join(&name);
            std::fs::write(&source, bytes).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&source)
                .unwrap()
                .sync_all()
                .unwrap();
        }
        let id = store
            .open_displacement(&DisplacementSpec {
                job_id: "kept".into(),
                workspace_id: "ws".into(),
                target_path: "notes.md".into(),
                displaced_name: name,
                expected_sha256: hex_sha256(b"before"),
                content_sha256: None,
                now_ms: 0,
            })
            .unwrap();
        store
            .resolve_displacement(
                id,
                DisplacementResolution::Keep {
                    displaced_sha256: Some(&hex_sha256(bytes)),
                },
                None,
                0,
            )
            .unwrap();
        let mut opts = options(1, &StdReplacer);
        opts.policy = DurabilityPolicy::per_os();
        let mut sync_attempted = false;
        let result = save_kept_displacement_with_cleanup(
            &store,
            root,
            "ws",
            id,
            &opts,
            |store, root, directory| {
                cleanup_staging_directory_with_sync(store, root, directory, |parent| {
                    assert!(!directory.exists());
                    assert!(store.list_kept_displacements("ws").unwrap().is_empty());
                    sync_attempted = true;
                    Err(MaterializeError::io(
                        parent,
                        &std::io::Error::from(ErrorKind::PermissionDenied),
                    ))
                })
            },
        );
        assert!(sync_attempted);
        assert_eq!(
            result.unwrap(),
            if source_exists {
                KeptCopySave::Saved("notes (kept copy).md".into())
            } else {
                KeptCopySave::Gone
            }
        );
        if source_exists {
            assert_eq!(
                std::fs::read(root.join("notes (kept copy).md")).unwrap(),
                bytes
            );
        }
        assert!(store.list_kept_displacements("ws").unwrap().is_empty());
        assert_eq!(
            store.staging_location("kept").unwrap().as_deref(),
            Some(relative)
        );
        recover_displacements(&store, root, Some("ws"), &opts).unwrap();
        assert!(store.staging_location("kept").unwrap().is_none());
    }
}

#[cfg(unix)]
#[test]
fn checked_delete_retains_late_descriptor_writes_after_publication() {
    use std::io::Write;
    let scratch = ScratchDir::new_named("checked-delete-retention").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let before = store.put_binary_blob(b"before").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::enqueue_delete_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "restore-delete-mat_retention".into(),
                    workspace_id: "ws".into(),
                    target_path: "notes.md".into(),
                    content_sha256: before.clone(),
                    preimage: Preimage::Present(before),
                    target_generation: 1,
                    now_ms: 0,
                },
            )
        })
        .unwrap();
    let j = store
        .load_materialization_job("restore-delete-mat_retention")
        .unwrap()
        .unwrap();
    assert_eq!(
        materialize_one_ordinary(&store, root, &j, &options(0, &StdReplacer)).unwrap(),
        JobOutcome::Completed
    );
    assert!(!target.exists());
    assert_eq!(
        store
            .load_materialization_job(&j.job_id)
            .unwrap()
            .unwrap()
            .status,
        dohc_engine_storage::JobStatus::Complete
    );
    writer.write_all(b"late outside write").unwrap();
    drop(writer);
    sweep(&store, root, 1000);
    let bytes: Vec<u8> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT bytes FROM materialization_displacement_reads",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(bytes, b"late outside write");
}

#[test]
fn ordinary_entry_point_cleans_empty_sibling_staging() {
    let scratch = ScratchDir::new_named("ordinary-entry-cleanup").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let j = job(
        &mut store,
        "ordinary-cleanup",
        "notes.md",
        b"before",
        b"after",
        1,
    );
    std::fs::write(root.join("notes.md"), b"after").unwrap();
    let sibling = root.join(".dohc-write-displaced");
    std::fs::create_dir(&sibling).unwrap();
    store
        .remember_staging(&j.job_id, ".dohc-write-displaced")
        .unwrap();
    assert_eq!(
        materialize_one_ordinary(&store, root, &j, &options(0, &StdReplacer)).unwrap(),
        JobOutcome::AlreadyMaterialized
    );
    assert!(!sibling.exists());
    assert!(store.staging_location(&j.job_id).unwrap().is_none());
}
