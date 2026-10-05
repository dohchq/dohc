//! Behavioral proofs that also compile against the P0 main baseline.
#![cfg(unix)]
use dohc_engine_files::{
    AtomicReplacer, DurabilityPolicy, JobOutcome, MaterializeOptions, NoBackoff, StdReplacer,
    materialize_one, recover_displacements,
};
use dohc_engine_storage::{
    EngineStore, MaterializationJob, MaterializationJobSpec, NoFaults, Preimage, enqueue_job,
};
use dohc_test_scratch::ScratchDir;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
fn options(replacer: &dyn AtomicReplacer) -> MaterializeOptions<'_> {
    MaterializeOptions {
        policy: DurabilityPolicy::none(),
        replacer,
        backoff: &NoBackoff,
        now_ms: 0,
        faults: &NoFaults,
    }
}
fn job(store: &mut EngineStore, path: &str) -> MaterializationJob {
    let before = store.put_binary_blob(b"before").unwrap();
    let after = store.put_binary_blob(b"after").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "settle".into(),
                    workspace_id: "ws".into(),
                    target_path: path.into(),
                    content_sha256: after,
                    preimage: Preimage::Present(before),
                    target_generation: 1,
                    now_ms: 0,
                },
            )
        })
        .unwrap();
    store.load_materialization_job("settle").unwrap().unwrap()
}
#[test]
fn p0_main_proof_held_descriptor_stays_reachable() {
    let scratch = ScratchDir::new_named("p0-main-descriptor").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let j = job(&mut store, "notes.md");
    assert_eq!(
        materialize_one(&store, root, &j, &options(&StdReplacer)).unwrap(),
        JobOutcome::Completed
    );
    assert!(
        writer.metadata().unwrap().nlink() > 0,
        "main unlinks an inode still open for writing"
    );
}
#[test]
fn p0_main_proof_write_within_q_has_a_reachable_source() {
    let scratch = ScratchDir::new_named("p0-main-write").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    let target = root.join("notes.md");
    std::fs::write(&target, b"before").unwrap();
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&target)
        .unwrap();
    let j = job(&mut store, "notes.md");
    materialize_one(&store, root, &j, &options(&StdReplacer)).unwrap();
    writer.write_all(b"outside within Q").unwrap();
    drop(writer);
    let retained = std::fs::read_dir(root.join(".dohc/engine/displaced"))
        .unwrap()
        .any(|p| std::fs::read(p.unwrap().path()).unwrap() == b"outside within Q");
    assert!(retained, "main loses the descriptor write before Q");
}
#[test]
fn p0_main_proof_restart_keeps_a_known_staged_original() {
    let scratch = ScratchDir::new_named("p0-main-restart").unwrap();
    let root = scratch.path();
    let db = root.join("engine.db");
    let mut store = EngineStore::open(&db, 0).unwrap();
    let j = job(&mut store, "notes.md");
    let staging = root.join(".dohc/engine/displaced");
    std::fs::create_dir_all(&staging).unwrap();
    let staged = staging.join("736574746c65.0");
    std::fs::write(&staged, b"before").unwrap();
    std::fs::write(root.join("notes.md"), b"after").unwrap();
    drop(store);
    let store = EngineStore::open(&db, 1000).unwrap();
    recover_displacements(&store, root, Some("ws"), &options(&StdReplacer)).unwrap();
    assert!(
        staged.exists(),
        "main recovery deletes the known staged original"
    );
    assert_eq!(j.job_id, "settle");
}
struct CrossVolume(AtomicUsize);
impl AtomicReplacer for CrossVolume {
    fn displace(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::Relaxed);
        if to.parent().unwrap().file_name().unwrap() == "displaced" {
            Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices))
        } else {
            std::fs::rename(from, to)
        }
    }
}
#[test]
fn p0_main_proof_cross_volume_retries_on_target_volume() {
    let scratch = ScratchDir::new_named("p0-main-cross").unwrap();
    let root = scratch.path();
    let mut store = EngineStore::open(&root.join("engine.db"), 0).unwrap();
    std::fs::write(root.join("notes.md"), b"before").unwrap();
    let j = job(&mut store, "notes.md");
    let replacer = CrossVolume(AtomicUsize::new(0));
    assert_eq!(
        materialize_one(&store, root, &j, &options(&replacer)).unwrap(),
        JobOutcome::Completed
    );
    assert_eq!(
        replacer.0.load(Ordering::Relaxed),
        2,
        "main uses the checked fallback instead of sibling staging"
    );
}
#[cfg(target_os = "linux")]
#[test]
#[ignore = "run only in the task-owned Docker container with DOHC_P0_CONTAINER=1"]
fn p0_real_cross_volume_save_uses_sibling_staging() {
    assert_eq!(std::env::var("DOHC_P0_CONTAINER").as_deref(), Ok("1"));
    let scratch = ScratchDir::new_named("p0-real-mount").unwrap();
    let name = scratch.path().file_name().unwrap().to_str().unwrap();
    let parent = format!("dev/shm/{name}");
    let rel = format!("{parent}/notes.md");
    let root = Path::new("/");
    std::fs::create_dir(root.join(&parent)).unwrap();
    std::fs::write(root.join(&rel), b"before").unwrap();
    let mut store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let j = job(&mut store, &rel);
    assert_eq!(
        materialize_one(&store, root, &j, &options(&StdReplacer)).unwrap(),
        JobOutcome::Completed
    );
    let sibling = root.join(&parent).join(".dohc-write-displaced");
    assert!(sibling.is_dir(), "no same-volume staging directory");
    assert_ne!(
        std::fs::metadata(root.join(".dohc/engine/displaced"))
            .unwrap()
            .dev(),
        std::fs::metadata(&sibling).unwrap().dev()
    );
    assert_eq!(std::fs::read(root.join(&rel)).unwrap(), b"after");
    // These explicit names belong to this test's unique directory in the container.
    for item in std::fs::read_dir(&sibling).unwrap() {
        std::fs::remove_file(item.unwrap().path()).unwrap();
    }
    std::fs::remove_dir(&sibling).unwrap();
    std::fs::remove_file(root.join(&rel)).unwrap();
    std::fs::remove_dir(root.join(&parent)).unwrap();
}
