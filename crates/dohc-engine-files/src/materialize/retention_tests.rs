use super::*;
use dohc_engine_storage::{MaterializationJobSpec, NoFaults, enqueue_job};
use dohc_test_scratch::ScratchDir;
use std::sync::atomic::{AtomicUsize, Ordering};
fn options(now_ms: i64, replacer: &dyn AtomicReplacer) -> MaterializeOptions<'_> {
    MaterializeOptions {
        holds: None,
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
            let held = crate::materialize::placement_is_held_in(
                store,
                &row.workspace_id,
                &row.target_path,
            )
            .unwrap();
            match inspect(root, store.database_path(), &row, now, held, 0).unwrap() {
                Inspection::Release(token) => {
                    if crate::materialize::placement_is_held_in(
                        store,
                        &row.workspace_id,
                        &row.target_path,
                    )
                    .unwrap()
                    {
                        continue;
                    }
                    if !token.remove().unwrap() {
                        continue;
                    }
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
                Inspection::Missing => {
                    if !crate::materialize::placement_is_held_in(
                        store,
                        &row.workspace_id,
                        &row.target_path,
                    )
                    .unwrap()
                    {
                        store.release_retained(row.displacement_id).unwrap();
                    }
                }
                Inspection::Oversized => store.keep_oversized_retained(&row, now).unwrap(),
                Inspection::BusyCheck { unsupported } => {
                    store.record_retained_busy_check(&row, unsupported).unwrap()
                }
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
/// #2205: on a volume that cannot refuse to unlink an open file, a replace
/// records why its original stays, and the sweep never releases it.
#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn an_unchecked_volume_keeps_every_original_and_counts_it() {
    let scratch = ScratchDir::new_named("unchecked-originals").unwrap();
    let root = scratch.path();
    let _simulated = crate::retained::unchecked::simulate(root);
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"v0").unwrap();
    for n in 1..=3 {
        let before = format!("v{}", n - 1);
        let after = format!("v{n}");
        let j = job(
            &mut store,
            &format!("settle-{n}"),
            "notes.md",
            before.as_bytes(),
            after.as_bytes(),
            n,
        );
        assert_eq!(
            materialize_one(&store, root, &j, &options(n, &StdReplacer)).unwrap(),
            JobOutcome::Completed
        );
    }
    let rows = store.retained_displacements_after(0).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|row| row.busy_check_unsupported));
    sweep(&store, root, 1_000_000);
    assert_eq!(store.retained_displacements_after(0).unwrap().len(), 3);
    assert_eq!(
        store.retained_summary("ws").unwrap(),
        dohc_engine_storage::RetainedSummary { count: 3, bytes: 6 }
    );
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"v3");
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
#[cfg(target_vendor = "apple")]
#[test]
fn macos_open_descriptor_keeps_the_original_until_it_closes() {
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;
    let scratch = ScratchDir::new_named("macos-held-descriptor").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let mut writer = std::fs::OpenOptions::new()
        .append(true)
        .open(&target)
        .unwrap();
    let j = job(&mut store, "settle", "notes.md", b"before", b"after", 1);
    materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    let source = root.join(&row.source_path);
    sweep(&store, root, 90_000);
    writer.write_all(b" appended after Q").unwrap();
    assert!(
        writer.metadata().unwrap().nlink() > 0,
        "the original was unlinked while a writer still held it"
    );
    drop(writer);
    sweep(&store, root, 90_001);
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    assert_eq!(row.digest, hex_sha256(b"before appended after Q"));
    let reader = std::fs::File::open(&source).unwrap();
    sweep(&store, root, 200_000);
    assert!(source.exists(), "a reader also keeps the original");
    drop(reader);
    sweep(&store, root, 200_001);
    assert!(!source.exists());
    assert!(store.retained_displacements_after(0).unwrap().is_empty());
    assert_eq!(std::fs::read(&target).unwrap(), b"after");
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
/// A store opened through its engine folder, as the engine opens one, by the
/// folder's ID on a Mac and by the descriptor held for it on Linux, with that
/// folder held open, and the path to open it by again.
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
fn store_by_id(root: &Path) -> (EngineStore, PathBuf, std::fs::File) {
    let engine = root.join(".dohc/engine");
    std::fs::create_dir_all(&engine).unwrap();
    let folder = std::fs::File::open(&engine).unwrap();
    let shown = Path::new(".dohc/engine");
    #[cfg(target_vendor = "apple")]
    let dir = dohc_macos_files::path_by_id(&folder, shown)
        .unwrap()
        .expect("APFS reaches a folder by ID");
    #[cfg(target_os = "linux")]
    let dir = dohc_linux_files::held::held_path(std::os::fd::AsFd::as_fd(&folder), shown).unwrap();
    let db = dir.join("engine.db");
    (EngineStore::open(&db, 0).unwrap(), db, folder)
}
/// Move the engine folder aside and put an empty one at its name.
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
fn swap_engine_folder(root: &Path) -> PathBuf {
    let moved = root.join(".dohc/moved");
    std::fs::rename(root.join(".dohc/engine"), &moved).unwrap();
    std::fs::create_dir(root.join(".dohc/engine")).unwrap();
    moved
}
/// The engine folder moves after the store opens, and another takes its
/// name. A replace sets the old version aside in the folder the store opened
/// through, under the workspace-relative name main stores, and the other
/// folder gets nothing (#2468).
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
#[test]
fn a_replace_sets_the_old_version_aside_in_the_folder_the_store_opened_through() {
    let scratch = ScratchDir::new_named("displaced-by-id").unwrap();
    let root = std::fs::canonicalize(scratch.path()).unwrap();
    let (mut store, _, _folder) = store_by_id(&root);
    let moved = swap_engine_folder(&root);
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "by-id", "notes.md", b"before", b"after", 1);
    materialize_one(&store, &root, &j, &options(0, &StdReplacer)).unwrap();
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"after");
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    let name = row.source_path.strip_prefix(".dohc/engine/displaced/");
    let name = name.expect("the name main stores");
    let kept = moved.join("displaced").join(name);
    assert_eq!(std::fs::read(kept).unwrap(), b"before");
    let replacement = root.join(".dohc/engine");
    assert_eq!(std::fs::read_dir(replacement).unwrap().count(), 0);
}
/// A replace stops after it sets the old version aside and before any row
/// names it. The engine folder then moves and another takes its name. After
/// a restart, recovery still finds the version in the folder the store opens
/// through and puts it back, and the retained-file check finds a retained
/// version there by the name main stores (#2468).
#[cfg(all(
    any(target_vendor = "apple", target_os = "linux"),
    feature = "fault-injection"
))]
#[test]
fn recovery_after_a_restart_reaches_the_folder_the_store_opens_through() {
    use crate::retained::{Inspection, inspect};
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
    let scratch = ScratchDir::new_named("recovery-by-id").unwrap();
    let root = std::fs::canonicalize(scratch.path()).unwrap();
    let (mut store, db, _folder) = store_by_id(&root);
    std::fs::write(root.join("kept.md"), b"kept before").unwrap();
    let kept = job(
        &mut store,
        "kept",
        "kept.md",
        b"kept before",
        b"kept after",
        1,
    );
    materialize_one(&store, &root, &kept, &options(0, &StdReplacer)).unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "crashed", "notes.md", b"before", b"after", 2);
    let crash = CrashAt(FaultPoint::MaterializeAfterDisplaceBeforePlace);
    let mut opts = options(0, &StdReplacer);
    opts.faults = &crash;
    let crashed = materialize_one(&store, &root, &j, &opts).unwrap();
    assert!(matches!(crashed, JobOutcome::Crashed(_)));
    assert!(!root.join("notes.md").exists());
    drop(store);
    swap_engine_folder(&root);
    let store = EngineStore::open(&db, 1000).unwrap();
    recover_displacements(&store, &root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"before");
    let found = inspect(&root, store.database_path(), &row, 1000, false, 0).unwrap();
    assert!(matches!(found, Inspection::Keep));
    let replacement = root.join(".dohc/engine");
    assert_eq!(std::fs::read_dir(replacement).unwrap().count(), 0);
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
    // The same bytes under a new identity are recorded once (#2205); the
    // source is then released after its quiet period.
    match inspect(root, store.database_path(), &row, 30_000, false, 0).unwrap() {
        Inspection::Changed { current, bytes } => {
            assert_eq!(bytes, b"before");
            assert_eq!(current.digest, row.digest);
            assert_ne!(current.device, row.device);
            store
                .record_retained_read(&row, &current, &bytes, 30_000)
                .unwrap();
        }
        _ => panic!("a new identity is recorded once"),
    }
    let refreshed = store.retained_displacements_after(0).unwrap().remove(0);
    assert!(matches!(
        inspect(root, store.database_path(), &refreshed, 30_001, false, 0).unwrap(),
        Inspection::Keep
    ));
    assert!(matches!(
        inspect(root, store.database_path(), &refreshed, 60_000, false, 0).unwrap(),
        Inspection::Release(_)
    ));
    // Another remount, with bytes changed meanwhile.
    store
        .read_with(|c| {
            c.execute(
                "UPDATE materialization_retained SET device='changed-device'",
                [],
            )
        })
        .unwrap();
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    let source = root.join(&row.source_path);
    std::fs::write(&source, b"outside after mount").unwrap();
    match inspect(root, store.database_path(), &row, 30_001, false, 0).unwrap() {
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
        inspect(root, store.database_path(), &row, 1, false, 0).unwrap(),
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
            sync_parent_dir(&store, Some(parent), DurabilityPolicy::per_os())
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

#[test]
fn blocked_job_cleans_empty_sibling_staging() {
    let scratch = ScratchDir::new_named("blocked-entry-cleanup").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let j = job(
        &mut store,
        "blocked-cleanup",
        "notes.md",
        b"before",
        b"after",
        1,
    );
    let real = root.join("real.md");
    std::fs::write(&real, b"before").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, root.join("notes.md")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&real, root.join("notes.md")).unwrap();
    let sibling = root.join(".dohc-write-displaced");
    std::fs::create_dir(&sibling).unwrap();
    store
        .remember_staging(&j.job_id, ".dohc-write-displaced")
        .unwrap();
    assert_eq!(
        materialize_one(&store, root, &j, &options(0, &StdReplacer)).unwrap(),
        JobOutcome::Blocked
    );
    assert!(!sibling.exists());
    assert!(store.staging_location(&j.job_id).unwrap().is_none());
    assert_eq!(std::fs::read(&real).unwrap(), b"before");
}

#[cfg(unix)]
fn checked_delete_job(store: &mut EngineStore) -> MaterializationJob {
    let before = store.put_binary_blob(b"before").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::enqueue_delete_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "restore-delete-mat_crash-retention".into(),
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
    store
        .load_materialization_job("restore-delete-mat_crash-retention")
        .unwrap()
        .unwrap()
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn checked_delete_crash_after_retention_replays_without_returning_late_write() {
    use std::io::Write;
    struct CrashAfterRetention;
    impl FaultInjector for CrashAfterRetention {
        fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == FaultPoint::MaterializeAfterKnownCopyDeletion {
                dohc_engine_storage::FaultAction::Crash
            } else {
                dohc_engine_storage::FaultAction::Continue
            }
        }
    }
    let scratch = ScratchDir::new_named("checked-delete-retained-crash").unwrap();
    let root = scratch.path();
    let db = root.join("engine.db");
    let mut store = EngineStore::open(&db, 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let j = checked_delete_job(&mut store);
    let mut opts = options(0, &StdReplacer);
    opts.faults = &CrashAfterRetention;
    assert_eq!(
        materialize_one_ordinary(&store, root, &j, &opts).unwrap(),
        JobOutcome::Crashed(FaultPoint::MaterializeAfterKnownCopyDeletion)
    );
    let row = store.retained_displacements_after(0).unwrap().remove(0);
    assert_eq!(
        store
            .load_materialization_job(&j.job_id)
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Pending
    );
    assert_eq!(
        std::fs::read(root.join(&row.source_path)).unwrap(),
        b"before"
    );
    writer.write_all(b"late outside write").unwrap();
    drop(writer);
    drop(store);
    let store = EngineStore::open(&db, 1000).unwrap();
    recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
    assert!(!target.exists());
    let pending = store.load_materialization_job(&j.job_id).unwrap().unwrap();
    assert_eq!(
        materialize_one_ordinary(&store, root, &pending, &options(1000, &StdReplacer)).unwrap(),
        JobOutcome::AlreadyMaterialized
    );
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
    assert!(!target.exists());
    assert_eq!(
        store
            .load_materialization_job(&j.job_id)
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Complete
    );
}

#[cfg(unix)]
#[test]
fn checked_delete_receipt_failure_returns_retained_original() {
    use std::sync::Arc;
    for (linked, occupied) in [(false, false), (true, false), (false, true)] {
        let scratch = ScratchDir::new_named("checked-delete-retained-rollback").unwrap();
        let root = scratch.path();
        let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
        let target = root.join("notes.md");
        std::fs::write(&target, b"before").unwrap();
        if linked {
            std::fs::hard_link(&target, root.join("other.md")).unwrap();
        }
        let j = checked_delete_job(&mut store);
        let commits = Arc::new(AtomicUsize::new(0));
        let hook = commits.clone();
        let competing_target = target.clone();
        store
            .read_with(|conn| {
                conn.commit_hook(Some(move || {
                    let refuse = hook.fetch_add(1, Ordering::SeqCst) == 1;
                    if refuse && occupied {
                        std::fs::write(&competing_target, b"outside replacement").unwrap();
                    }
                    refuse
                }))
                .unwrap();
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .unwrap();
        assert!(matches!(
            materialize_one_ordinary(&store, root, &j, &options(0, &StdReplacer)),
            Err(MaterializeError::Storage(_))
        ));
        assert!(commits.load(Ordering::SeqCst) >= 3);
        store
            .read_with(|conn| {
                conn.commit_hook(None::<fn() -> bool>).unwrap();
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .unwrap();
        assert!(store.retained_displacements_after(0).unwrap().is_empty());
        if occupied {
            assert_eq!(std::fs::read(&target).unwrap(), b"outside replacement");
            let kept = store.list_kept_displacements("ws").unwrap();
            assert_eq!(kept.len(), 1);
            assert_eq!(
                std::fs::read(root.join(STAGING_DIR).join(&kept[0].displaced_name)).unwrap(),
                b"before"
            );
            sweep(&store, root, 100_000);
            assert!(
                root.join(STAGING_DIR)
                    .join(&kept[0].displaced_name)
                    .exists()
            );
            continue;
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"before");
        assert_eq!(
            store
                .load_materialization_job(&j.job_id)
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
        sweep(&store, root, 1000);
        assert!(store.retained_displacements_after(0).unwrap().is_empty());
        assert_eq!(
            materialize_one_ordinary(&store, root, &j, &options(1000, &StdReplacer)).unwrap(),
            JobOutcome::Completed
        );
        assert!(!target.exists());
        if linked {
            assert_eq!(std::fs::read(root.join("other.md")).unwrap(), b"before");
        }
    }
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn checked_delete_release_failure_preserves_receipt_error_and_rolls_back() {
    for occupied in [false, true] {
        let scratch = ScratchDir::new_named("checked-delete-release-failure").unwrap();
        let root = scratch.path();
        let db = root.join("engine.db");
        let mut store = EngineStore::open(&db, 0).unwrap();
        let target = root.join("notes.md");
        std::fs::write(&target, b"before").unwrap();
        let j = checked_delete_job(&mut store);
        store
            .read_with(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER fail_receipt BEFORE UPDATE OF status ON materialization_jobs
             WHEN NEW.status='complete' BEGIN SELECT RAISE(FAIL, 'receipt failure'); END;
             CREATE TRIGGER fail_release BEFORE DELETE ON materialization_retained
             BEGIN SELECT RAISE(FAIL, 'release failure'); END;",
                )
            })
            .unwrap();
        struct OccupyOnReceipt<'a>(&'a Path, bool);
        impl FaultInjector for OccupyOnReceipt<'_> {
            fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
                if self.1 && point == FaultPoint::MaterializeAfterKnownCopyDeletion {
                    std::fs::write(self.0, b"outside replacement").unwrap();
                }
                dohc_engine_storage::FaultAction::Continue
            }
        }
        let fill = OccupyOnReceipt(&target, occupied);
        let mut opts = options(0, &StdReplacer);
        opts.faults = &fill;
        let error = materialize_one_ordinary(&store, root, &j, &opts).unwrap_err();
        assert!(
            format!("{error:?}").contains("receipt failure"),
            "{error:?}"
        );
        let row = store.retained_displacements_after(0).unwrap().remove(0);
        assert_eq!(
            store
                .load_materialization_job(&j.job_id)
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
        assert!(store.list_kept_displacements("ws").unwrap().is_empty());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            if occupied {
                b"outside replacement".as_slice()
            } else {
                b"before".as_slice()
            }
        );
        if occupied {
            assert_eq!(
                std::fs::read(root.join(&row.source_path)).unwrap(),
                b"before"
            );
        } else {
            assert!(!root.join(&row.source_path).exists());
            assert!(matches!(
                crate::retained::inspect(root, store.database_path(), &row, 1000, false, 0)
                    .unwrap(),
                crate::retained::Inspection::Missing
            ));
        }
        drop(store);
        let store = EngineStore::open(&db, 1000).unwrap();
        recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
        assert_eq!(
            store.retained_displacements_after(0).unwrap(),
            vec![row.clone()]
        );
        store
            .read_with(|conn| {
                conn.execute_batch("DROP TRIGGER fail_receipt; DROP TRIGGER fail_release;")
            })
            .unwrap();
        if occupied {
            std::fs::write(root.join(&row.source_path), b"late outside write").unwrap();
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
        } else {
            sweep(&store, root, 1000);
            assert!(store.retained_displacements_after(0).unwrap().is_empty());
        }
        assert_eq!(
            std::fs::read(&target).unwrap(),
            if occupied {
                b"outside replacement".as_slice()
            } else {
                b"before".as_slice()
            }
        );
    }
}

#[cfg(unix)]
#[test]
fn checked_delete_retry_reserves_missing_retained_name_after_recovering_another_row() {
    let scratch = ScratchDir::new_named("checked-delete-reserved-name").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = checked_delete_job(&mut store);
    store
        .read_with(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_receipt BEFORE UPDATE OF status ON materialization_jobs
         WHEN NEW.status='complete' BEGIN SELECT RAISE(FAIL, 'receipt failure'); END;
         CREATE TRIGGER fail_release BEFORE DELETE ON materialization_retained
         BEGIN SELECT RAISE(FAIL, 'release failure'); END;",
            )
        })
        .unwrap();
    materialize_one_ordinary(&store, root, &j, &options(0, &StdReplacer)).unwrap_err();
    let old = store.retained_displacements_after(0).unwrap().remove(0);
    assert!(!root.join(&old.source_path).exists());
    store
        .read_with(|conn| conn.execute_batch("DROP TRIGGER fail_receipt;"))
        .unwrap();
    // Force recovery through its row loop instead of its empty-row fast path.
    let name = staged_name(&j.job_id, 1);
    std::fs::write(root.join(STAGING_DIR).join(&name), b"before").unwrap();
    store
        .open_displacement(&DisplacementSpec {
            job_id: j.job_id.clone(),
            workspace_id: "ws".into(),
            target_path: "notes.md".into(),
            displaced_name: name,
            expected_sha256: hex_sha256(b"before"),
            content_sha256: None,
            now_ms: 1,
        })
        .unwrap();
    assert_eq!(
        materialize_one_ordinary(&store, root, &j, &options(1000, &StdReplacer)).unwrap(),
        JobOutcome::Completed
    );
    assert!(
        !root.join(&old.source_path).exists(),
        "retry must not reuse the stale row's name"
    );
    let rows = store.retained_displacements_after(0).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0], old);
    store
        .read_with(|conn| conn.execute_batch("DROP TRIGGER fail_release;"))
        .unwrap();
    sweep(&store, root, 31_000);
    assert!(store.retained_displacements_after(0).unwrap().is_empty());
    assert!(!root.join("notes.md").exists());
}

#[cfg(unix)]
#[test]
fn checked_delete_rollback_stat_failure_preserves_receipt_error() {
    use std::sync::Arc;
    let scratch = ScratchDir::new_named("checked-delete-rollback-stat").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let j = checked_delete_job(&mut store);
    store
        .read_with(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_receipt BEFORE UPDATE OF status ON materialization_jobs
         WHEN NEW.status='complete' BEGIN SELECT RAISE(FAIL, 'receipt failure'); END;",
            )
        })
        .unwrap();
    let commits = Arc::new(AtomicUsize::new(0));
    let hook = commits.clone();
    let staging = root.join(STAGING_DIR);
    let displaced_directory = root.join("saved-staging");
    let hook_staging = staging.clone();
    let hook_saved = displaced_directory.clone();
    store
        .read_with(|conn| {
            conn.commit_hook(Some(move || {
                // Register succeeds; the receipt trigger refuses; release then fails.
                if hook.fetch_add(1, Ordering::SeqCst) == 2 {
                    std::fs::rename(&hook_staging, &hook_saved).unwrap();
                    std::fs::write(&hook_staging, b"not a directory").unwrap();
                    true
                } else {
                    false
                }
            }))
            .unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    let error = materialize_one_ordinary(&store, root, &j, &options(0, &StdReplacer)).unwrap_err();
    assert!(
        format!("{error:?}").contains("receipt failure"),
        "{error:?}"
    );
    assert_eq!(commits.load(Ordering::SeqCst), 3);
    let rows = store.retained_displacements_after(0).unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert!(matches!(
        entry_exists(&root.join(&row.source_path)),
        Err(MaterializeError::Io {
            kind: ErrorKind::NotADirectory,
            ..
        })
    ));
    assert_eq!(
        store
            .load_materialization_job(&j.job_id)
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Pending
    );
    assert!(!target.exists());
    assert_eq!(
        std::fs::read(displaced_directory.join(Path::new(&row.source_path).file_name().unwrap()))
            .unwrap(),
        b"before"
    );
    store
        .read_with(|conn| {
            conn.commit_hook(None::<fn() -> bool>).unwrap();
            conn.execute_batch("DROP TRIGGER fail_receipt")
        })
        .unwrap();
    std::fs::remove_file(&staging).unwrap();
    std::fs::rename(displaced_directory, staging).unwrap();
    recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
    assert_eq!(store.retained_displacements_after(0).unwrap(), rows);
    assert_eq!(
        std::fs::read(root.join(&row.source_path)).unwrap(),
        b"before"
    );
    assert!(!target.exists());
}
#[test]
fn passive_store_materialization_leaves_sources_rows_and_sibling_cleanup_untouched() {
    use dohc_engine_storage::RetainedDisplacement;
    let scratch = ScratchDir::new_named("passive-materialization-retention").unwrap();
    let root = scratch.path();
    let db = root.join("engine.db");
    let mut store = EngineStore::open(&db, 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let write = job(
        &mut store,
        "passive-write",
        "notes.md",
        b"before",
        b"after",
        1,
    );
    store
        .read_with(|conn| {
            conn.execute_batch(
                "UPDATE materialization_jobs SET operation='delete' WHERE job_id='passive-write'",
            )
        })
        .unwrap();
    let delete = store
        .load_materialization_job(&write.job_id)
        .unwrap()
        .unwrap();
    let staging = staging_dir(store.database_path(), root, true).unwrap();
    let name = staged_name(&write.job_id, 0);
    let source = staging.join(&name);
    std::fs::write(&source, b"late outside bytes").unwrap();
    let mut retained = RetainedDisplacement {
        displacement_id: 0,
        job_id: write.job_id.clone(),
        workspace_id: "ws".into(),
        target_path: "notes.md".into(),
        source_path: format!("{STAGING_DIR}/{name}"),
        device: "1".into(),
        inode: "1".into(),
        digest: hex_sha256(b"before"),
        size: 6,
        mtime: "0:0".into(),
        ctime: "0:0".into(),
        changed_at_ms: 0,
        busy_check_unsupported: false,
    };
    retained.displacement_id = store.retain_displacement(&retained).unwrap();
    let sibling = root.join(".dohc-write-displaced");
    std::fs::create_dir(&sibling).unwrap();
    store
        .remember_staging(&write.job_id, ".dohc-write-displaced")
        .unwrap();
    // Simulate leftover owner work in a passive database, as startup recovery can find it.
    store
        .read_with(|conn| conn.execute_batch("UPDATE engine_ownership SET store_role='passive'"))
        .unwrap();
    drop(store);
    let store = EngineStore::open_passive(&db, 1, None, None).unwrap();
    let settings = options(60_000, &StdReplacer);
    assert!(
        run_pending_jobs(&store, root, &settings)
            .unwrap()
            .is_empty()
    );
    recover_displacements(&store, root, None, &settings).unwrap();
    recover_path_displacements(&store, root, "ws", "notes.md", &settings).unwrap();
    cleanup_staging_directory(&store, root, &sibling).unwrap();
    for job in [&write, &delete] {
        assert!(materialize_one(&store, root, job, &settings).is_err());
        assert!(materialize_one_ordinary(&store, root, job, &settings).is_err());
    }
    assert!(materialize_secret_one(&store, root, &write, b"after", &settings).is_err());
    assert!(materialize_secret_delete_one(&store, root, &delete, &settings).is_err());
    assert!(save_kept_displacement(&store, root, "ws", 1, &settings).is_err());
    assert!(store.retain_displacement(&retained).is_err());
    assert!(
        store
            .record_retained_read(&retained, &retained, b"before", 2)
            .is_err()
    );
    assert!(store.release_retained(retained.displacement_id).is_err());
    assert!(store.keep_oversized_retained(&retained, 2).is_err());
    assert!(
        store
            .remember_staging("new-job", ".dohc-write-displaced")
            .is_err()
    );
    assert!(
        store
            .forget_staging_directory(".dohc-write-displaced")
            .is_err()
    );
    assert_eq!(
        store.retained_displacements_after(0).unwrap(),
        vec![retained]
    );
    assert_eq!(
        store
            .table_row_count("materialization_displacement_reads")
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("materialization_displacements")
            .unwrap(),
        0
    );
    assert_eq!(
        store.staging_locations().unwrap(),
        vec![".dohc-write-displaced"]
    );
    assert_eq!(
        store
            .load_materialization_job(&write.job_id)
            .unwrap()
            .unwrap(),
        delete
    );
    assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"before");
    assert_eq!(std::fs::read(source).unwrap(), b"late outside bytes");
    assert!(sibling.is_dir());
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn capture_file_hold_parks_checked_delete_replay_and_preserves_late_retained_source() {
    held_checked_delete_recovery(FaultPoint::MaterializeAfterKnownCopyDeletion, true);
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn capture_file_hold_parks_open_checked_delete_displacement_until_clear() {
    held_checked_delete_recovery(FaultPoint::MaterializeAfterDisplacedHash, false);
}

#[cfg(all(unix, feature = "fault-injection"))]
fn held_checked_delete_recovery(point: FaultPoint, retained: bool) {
    use std::io::Write;
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
    let scratch = ScratchDir::new_named("held-checked-delete-retention").unwrap();
    let root = scratch.path();
    let db = root.join("engine.db");
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    let j = checked_delete_job(&mut store);
    let crash = CrashAt(point);
    let mut settings = options(0, &StdReplacer);
    settings.faults = &crash;
    assert_eq!(
        materialize_one_ordinary(&store, root, &j, &settings).unwrap(),
        JobOutcome::Crashed(point)
    );
    let rows = store.retained_displacements_after(0).unwrap();
    assert_eq!(rows.len(), usize::from(retained));
    let source = std::fs::read_dir(root.join(STAGING_DIR))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    writer.write_all(b"late outside write").unwrap();
    drop(writer);
    std::fs::write(&target, b"held outside version").unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','Main',1); INSERT INTO file_objects VALUES ('ws','held-object',1);").map_err(dohc_engine_storage::StorageError::persist_public)?;
        dohc_engine_storage::capture_file_holds::record_in(tx, &dohc_engine_storage::capture_file_holds::CaptureFileHold {
            workspace_id: "ws".into(), source_version_id: "main".into(), object_id: "held-object".into(), path: "notes.md".into(), observed_sha256: hex_sha256(b"held outside version"), observed_size: 20, reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE.into(), observed_at_ms: 1, attempt_count: 1, retry_requested: false,
        })
    }).unwrap();
    drop(store);
    let mut store = EngineStore::open(&db, 1000).unwrap();
    // The pre-retention crash enters RecoveryEntry::recover; a retained source
    // instead stays owned by its row and is inspected by the worker.
    recover_displacements(&store, root, Some("ws"), &options(1000, &StdReplacer)).unwrap();
    assert_eq!(
        store
            .load_materialization_job(&j.job_id)
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Pending
    );
    let pending = store.load_materialization_job(&j.job_id).unwrap().unwrap();
    assert_eq!(
        materialize_one_ordinary(&store, root, &pending, &options(1000, &StdReplacer)).unwrap(),
        JobOutcome::Parked
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"held outside version");
    assert_eq!(std::fs::read(&source).unwrap(), b"late outside write");
    assert_eq!(store.retained_displacements_after(0).unwrap(), rows);
    sweep(&store, root, 1000);
    sweep(&store, root, 31_000);
    assert!(source.exists(), "a hold must fence quiet release");
    if retained {
        let bytes: Vec<u8> = store
            .read_with(|c| {
                c.query_row(
                    "SELECT bytes FROM materialization_displacement_reads",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(bytes, b"late outside write");
    } else {
        let open = store.list_unsettled_displacements().unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(
            open[0].state,
            DisplacementState::Open,
            "recovery must stop at the hold gate"
        );
    }
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::capture_file_holds::clear_in(tx, "ws", "notes.md")
        })
        .unwrap();
    recover_displacements(&store, root, Some("ws"), &options(31_001, &StdReplacer)).unwrap();
    let replay = store.load_materialization_job(&j.job_id).unwrap().unwrap();
    // New outside bytes supersede the delete preimage: terminate as conflict.
    assert_eq!(
        materialize_one_ordinary(&store, root, &replay, &options(31_001, &StdReplacer)).unwrap(),
        JobOutcome::Conflict
    );
    assert_eq!(
        store
            .load_materialization_job(&j.job_id)
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Conflict
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"held outside version");
    assert_eq!(std::fs::read(&source).unwrap(), b"late outside write");
    if retained {
        sweep(&store, root, 31_001);
        assert!(!source.exists());
        assert!(store.retained_displacements_after(0).unwrap().is_empty());
        assert_eq!(
            store
                .table_row_count("materialization_displacement_reads")
                .unwrap(),
            1
        );
    } else {
        let kept = store.list_kept_displacements("ws").unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].state, DisplacementState::Kept);
        recover_displacements(&store, root, Some("ws"), &options(31_002, &StdReplacer)).unwrap();
        assert_eq!(store.list_kept_displacements("ws").unwrap(), kept);
        assert_eq!(std::fs::read(&source).unwrap(), b"late outside write");
    }
    assert_eq!(std::fs::read(&target).unwrap(), b"held outside version");
}
