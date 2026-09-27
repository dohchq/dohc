//! Crash-injection matrix for the durable materialization pipeline
//! (`dohc-engine-files::materialize`, `TEST_ORACLE.md` §3.3 points 12-16 and
//! §3.10 the bounded-retry contract). Each test drives the five-step pipeline,
//! injects a crash (or an external write / transient lock / superseding
//! generation), then proves the recovery contract by reopening the store and
//! replaying — durability is never trusted from the in-process outcome flag.

use dohc_engine_files::{
    AtomicReplacer, CheckThenRenameFailed, DurabilityPolicy, JobOutcome, MaterializeOptions,
    NoBackoff, Placement, ReplaceBackoff, StdReplacer, backoff_delay, materialize_one,
    materialize_secret_one, path_is_displaced, recover_displacements, recover_path_displacements,
    run_pending_jobs, workspace_lacks_atomic_placement,
};
use dohc_engine_storage::{
    DisplacementSpec, DisplacementState, EngineStore, FaultInjector, FaultPoint, JobStatus,
    MaterializationJobSpec, NoFaults, Preimage, StorageError, cancel_pending_jobs_for_path,
    enqueue_delete_job, enqueue_job, hex_sha256,
};
use dohc_engine_testkit::{
    ScriptedFaults,
    scratch::{try_make_dir_alias, try_make_file_symlink},
};
use dohc_test_scratch::ScratchDir;
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

struct Scratch {
    root: ScratchDir,
}
impl Scratch {
    fn new(tag: &str) -> Self {
        let root =
            ScratchDir::new_named(&format!("r04-mat-{tag}")).expect("create scratch directory");
        std::fs::create_dir_all(root.join(".dohc").join("engine")).expect("mkdir engine dir");
        Scratch { root }
    }
    fn workspace(&self) -> &Path {
        &self.root
    }
    fn db(&self) -> PathBuf {
        self.root.join(".dohc").join("engine").join("engine.db")
    }
    fn target(&self, rel: &str) -> PathBuf {
        let mut p = self.root.to_path_buf();
        for seg in rel.split('/') {
            p.push(seg);
        }
        p
    }
}
fn remove_dir_alias(path: &Path) {
    #[cfg(unix)]
    std::fs::remove_file(path).expect("remove directory symlink");
    #[cfg(windows)]
    std::fs::remove_dir(path).expect("remove directory junction/symlink");
    #[cfg(not(any(unix, windows)))]
    let _ = path;
}

fn spec(
    id: &str,
    path: &str,
    sha: &str,
    preimage: Preimage,
    generation: i64,
    now: i64,
) -> MaterializationJobSpec {
    MaterializationJobSpec {
        job_id: id.to_owned(),
        workspace_id: "ws".to_owned(),
        target_path: path.to_owned(),
        content_sha256: sha.to_owned(),
        preimage,
        target_generation: generation,
        now_ms: now,
    }
}

/// Put a content blob and enqueue a job for it in one transaction (phase 1).
fn stage_job(store: &mut EngineStore, content: &[u8], job: &MaterializationJobSpec) {
    let sha = store.put_binary_blob(content).expect("blob");
    assert_eq!(sha, job.content_sha256, "spec content sha must match blob");
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(tx, job)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue");
}

#[test]
fn materializes_a_new_file_and_marks_complete() {
    let sc = Scratch::new("basic");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"hello materialize";
    let job = spec(
        "j1",
        "notes/a.md",
        &hex_sha256(content),
        Preimage::Absent,
        1,
        10,
    );
    stage_job(&mut store, content, &job);

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("run");

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("notes/a.md")).expect("read"),
        content
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
    assert_eq!(
        store
            .load_materialization_job("j1")
            .expect("load")
            .unwrap()
            .status,
        JobStatus::Complete
    );
}

#[test]
fn ordinary_write_refuses_symlinked_ancestor_then_recovers_with_real_directory() {
    let sc = Scratch::new("ordinary-write-ancestor");
    let outside = Scratch::new("ordinary-write-outside");
    std::fs::create_dir(sc.target("real")).expect("real parent");
    let alias = sc.target("real/linked");
    if !try_make_dir_alias(outside.workspace(), &alias).expect("create directory alias") {
        eprintln!("skipping: directory alias creation is unavailable");
        return;
    }

    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"must stay contained";
    let job = spec(
        "ordinary-write",
        "real/linked/write.md",
        &hex_sha256(content),
        Preimage::Absent,
        1,
        10,
    );
    stage_job(&mut store, content, &job);
    let unrelated = b"unrelated proceeds";
    let sibling = spec(
        "ordinary-write-sibling",
        "notes/unrelated.md",
        &hex_sha256(unrelated),
        Preimage::Absent,
        2,
        11,
    );
    stage_job(&mut store, unrelated, &sibling);

    // The blocked job stays pending without stalling the batch: the unrelated
    // job in the same run must still materialize.
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("a blocked ancestor must not fail the whole run");
    let outcome_of = |id: &str| {
        results
            .iter()
            .find(|result| result.job_id == id)
            .expect("job result")
            .outcome
    };
    assert_eq!(outcome_of("ordinary-write"), JobOutcome::Blocked);
    assert_eq!(outcome_of("ordinary-write-sibling"), JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("notes/unrelated.md")).unwrap(),
        unrelated
    );
    assert!(!outside.target("write.md").exists());
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    remove_dir_alias(&alias);
    std::fs::create_dir(&alias).expect("replace alias with real directory");
    let recovered = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 30,
            faults: &NoFaults,
        },
    )
    .expect("pending write must recover after containment is restored");
    assert_eq!(recovered[0].outcome, JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("real/linked/write.md")).unwrap(),
        content
    );
    assert!(!outside.target("write.md").exists());
}

#[test]
fn ordinary_write_temp_symlink_blocks_only_that_job_then_recovers() {
    let sc = Scratch::new("ordinary-write-temp-symlink");
    let outside = Scratch::new("ordinary-write-temp-outside");
    std::fs::create_dir(sc.target("notes")).expect("target parent");
    let outside_target = outside.target("outside.txt");
    std::fs::write(&outside_target, b"outside must survive").expect("outside target");

    let blocked_content = b"blocked temp content";
    let blocked = spec(
        "ordinary-temp-symlink",
        "notes/blocked.md",
        &hex_sha256(blocked_content),
        Preimage::Absent,
        1,
        10,
    );
    let temp_alias = sc.target("notes/.dohc-write-ordinary-temp-symlink.tmp");
    if !try_make_file_symlink(&outside_target, &temp_alias).expect("create temp symlink") {
        eprintln!("skipping: file symlink creation is unavailable");
        return;
    }

    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_job(&mut store, blocked_content, &blocked);
    let unrelated_content = b"unrelated same-batch content";
    let unrelated = spec(
        "ordinary-temp-sibling",
        "notes/unrelated.md",
        &hex_sha256(unrelated_content),
        Preimage::Absent,
        2,
        11,
    );
    stage_job(&mut store, unrelated_content, &unrelated);

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("a symlinked temp must not fail the batch");
    let outcome_of = |id: &str| {
        results
            .iter()
            .find(|result| result.job_id == id)
            .expect("job result")
            .outcome
    };
    assert_eq!(outcome_of("ordinary-temp-symlink"), JobOutcome::Blocked);
    assert_eq!(outcome_of("ordinary-temp-sibling"), JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("notes/unrelated.md")).expect("unrelated artifact"),
        unrelated_content
    );
    assert_eq!(
        std::fs::read(&outside_target).expect("outside remains"),
        b"outside must survive"
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    std::fs::remove_file(&temp_alias).expect("remove temp symlink");
    let recovered = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 30,
            faults: &NoFaults,
        },
    )
    .expect("blocked temp job must recover after alias removal");
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].outcome, JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("notes/blocked.md")).expect("recovered artifact"),
        blocked_content
    );
    assert_eq!(
        std::fs::read(&outside_target).expect("outside remains"),
        b"outside must survive"
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn ordinary_delete_refuses_symlinked_ancestor_then_recovers_with_real_directory() {
    let sc = Scratch::new("ordinary-delete-ancestor");
    let outside = Scratch::new("ordinary-delete-outside");
    let old = b"outside must survive";
    std::fs::write(outside.target("delete.md"), old).expect("outside target");
    let alias = sc.target("linked");
    if !try_make_dir_alias(outside.workspace(), &alias).expect("create directory alias") {
        eprintln!("skipping: directory alias creation is unavailable");
        return;
    }

    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let job = spec(
        "ordinary-delete",
        "linked/delete.md",
        &hex_sha256(old),
        Preimage::Present(hex_sha256(old)),
        1,
        10,
    );
    store.put_binary_blob(old).expect("blob");
    store
        .write_with(&NoFaults, |tx| {
            enqueue_delete_job(tx, &job)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue delete");

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("a blocked delete ancestor must not fail the whole run");
    assert_eq!(results[0].outcome, JobOutcome::Blocked);
    assert_eq!(std::fs::read(outside.target("delete.md")).unwrap(), old);
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    remove_dir_alias(&alias);
    std::fs::create_dir(&alias).expect("replace alias with real directory");
    std::fs::write(sc.target("linked/delete.md"), old).expect("contained target");
    let recovered = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 30,
            faults: &NoFaults,
        },
    )
    .expect("pending delete must recover after containment is restored");
    assert_eq!(recovered[0].outcome, JobOutcome::Completed);
    assert!(!sc.target("linked/delete.md").exists());
    assert_eq!(std::fs::read(outside.target("delete.md")).unwrap(), old);
}

#[test]
fn ordinary_conflict_sibling_refuses_symlinked_ancestor_then_recovers() {
    let sc = Scratch::new("ordinary-conflict-ancestor");
    let outside = Scratch::new("ordinary-conflict-outside");
    let intended = b"intended content";
    let known = b"known preimage";
    let external = b"external edit";
    std::fs::write(outside.target("conflicted.md"), external).expect("outside target");
    let alias = sc.target("linked");
    if !try_make_dir_alias(outside.workspace(), &alias).expect("create directory alias") {
        eprintln!("skipping: directory alias creation is unavailable");
        return;
    }

    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let job = spec(
        "ordinary-conflict",
        "linked/conflicted.md",
        &hex_sha256(intended),
        Preimage::Present(hex_sha256(known)),
        1,
        10,
    );
    stage_job(&mut store, intended, &job);

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("a blocked conflict ancestor must not fail the whole run");
    assert_eq!(results[0].outcome, JobOutcome::Blocked);
    assert!(
        !outside
            .target("conflicted.md.ordinary-conflict.conflict")
            .exists()
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    remove_dir_alias(&alias);
    std::fs::create_dir(&alias).expect("replace alias with real directory");
    std::fs::write(sc.target("linked/conflicted.md"), external).expect("contained external edit");
    let recovered = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 30,
            faults: &NoFaults,
        },
    )
    .expect("pending conflict must run after containment is restored");
    assert_eq!(recovered[0].outcome, JobOutcome::Conflict);
    assert_eq!(
        std::fs::read(sc.target("linked/conflicted.md")).unwrap(),
        external
    );
    assert_eq!(
        std::fs::read(sc.target("linked/conflicted.md.ordinary-conflict.conflict")).unwrap(),
        intended
    );
    assert!(
        !outside
            .target("conflicted.md.ordinary-conflict.conflict")
            .exists()
    );
}

#[test]
fn job_committed_but_pipeline_unrun_replays_after_restart() {
    // `materialize.after-job-commit` (point 12): the job row is durable but the
    // pipeline never ran. Driven as a real crash at the wired fault point, then
    // proven to replay on restart.
    let sc = Scratch::new("after-job-commit");
    let content = b"deferred";
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        let job = spec(
            "j1",
            "notes/a.md",
            &hex_sha256(content),
            Preimage::Absent,
            1,
            10,
        );
        stage_job(&mut store, content, &job);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
        let results = run_pending_jobs(
            &store,
            sc.workspace(),
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &StdReplacer,
                backoff: &NoBackoff,
                now_ms: 20,
                faults: faults.as_ref(),
            },
        )
        .expect("run");
        assert!(matches!(results[0].outcome, JobOutcome::Crashed(_)));
        assert!(
            !sc.target("notes/a.md").exists(),
            "nothing on disk after job-commit crash"
        );
        assert_eq!(store.pending_materialization_count().expect("pending"), 1);
        drop(store);
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("replay");
    assert_eq!(results[0].outcome, JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("notes/a.md")).expect("read"),
        content
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn crash_after_temp_write_leaves_no_torn_target_and_replay_completes() {
    let sc = Scratch::new("after-temp");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"content-x";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterTempWrite);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: faults.as_ref(),
        },
    )
    .expect("run");
    assert!(matches!(results[0].outcome, JobOutcome::Crashed(_)));
    assert!(
        !sc.target("a.md").exists(),
        "target must not exist after temp-only crash"
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("replay");
    assert_eq!(results[0].outcome, JobOutcome::Completed);
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn crash_after_flush_before_rename_replays_to_completion() {
    let sc = Scratch::new("after-flush");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"flushed";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterFlushBeforeRename);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: faults.as_ref(),
        },
    )
    .expect("run");
    assert!(matches!(results[0].outcome, JobOutcome::Crashed(_)));
    assert!(!sc.target("a.md").exists());
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("replay");
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn crash_after_rename_before_complete_replays_exactly_once() {
    let sc = Scratch::new("after-rename");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"renamed-content";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: faults.as_ref(),
        },
    )
    .expect("run");
    assert!(matches!(results[0].outcome, JobOutcome::Crashed(_)));
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("replay");
    assert_eq!(results[0].outcome, JobOutcome::AlreadyMaterialized);
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn external_newer_content_is_preserved_not_clobbered() {
    let sc = Scratch::new("preserve-both");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");

    let intended = b"new-intended-content";
    let old_known = b"old-known-content";
    let external = b"external-newer-content";
    std::fs::write(sc.target("a.md"), external).expect("pre-write external");

    let job = spec(
        "j1",
        "a.md",
        &hex_sha256(intended),
        Preimage::Present(hex_sha256(old_known)),
        1,
        10,
    );
    stage_job(&mut store, intended, &job);

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("run");
    assert_eq!(results[0].outcome, JobOutcome::Conflict);

    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), external);
    let conflict = sc.target("a.md.j1.conflict");
    assert_eq!(std::fs::read(&conflict).expect("read conflict"), intended);
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
    assert_eq!(
        store
            .load_materialization_job("j1")
            .expect("load")
            .unwrap()
            .status,
        JobStatus::Conflict
    );
}

#[test]
fn delete_job_replays_after_remove_before_complete() {
    let sc = Scratch::new("delete-replay");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let old = b"old-known-content";
    std::fs::write(sc.target("a.md"), old).expect("target");
    let job = spec(
        "j-delete",
        "a.md",
        &hex_sha256(old),
        Preimage::Present(hex_sha256(old)),
        1,
        10,
    );
    let sha = store.put_binary_blob(old).expect("blob");
    assert_eq!(sha, job.content_sha256);
    store
        .write_with(&NoFaults, |tx| {
            enqueue_delete_job(tx, &job)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue delete");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    let first = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: faults.as_ref(),
        },
    )
    .expect("delete crash");
    assert!(matches!(first[0].outcome, JobOutcome::Crashed(_)));
    assert!(!sc.target("a.md").exists());
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let recovered = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("replay");
    assert_eq!(recovered[0].outcome, JobOutcome::AlreadyMaterialized);
    assert!(!sc.target("a.md").exists());
    assert!(displaced_files(&sc).is_empty(), "the deleted copy is gone");
    assert!(
        store
            .list_unsettled_displacements()
            .expect("open")
            .is_empty()
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn delete_job_syncs_parent_dir_before_marking_complete() {
    let sc = Scratch::new("delete-durable-order");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let old = b"durably-deleted-content";
    std::fs::write(sc.target("a.md"), old).expect("target");
    let job = spec(
        "j-delete-durable",
        "a.md",
        &hex_sha256(old),
        Preimage::Present(hex_sha256(old)),
        1,
        10,
    );
    let sha = store.put_binary_blob(old).expect("blob");
    assert_eq!(sha, job.content_sha256);
    store
        .write_with(&NoFaults, |tx| {
            enqueue_delete_job(tx, &job)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue delete");

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    let first = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: faults.as_ref(),
        },
    )
    .expect("delete crash");
    assert!(matches!(first[0].outcome, JobOutcome::Crashed(_)));
    assert!(!sc.target("a.md").exists());
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let recovered = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("replay");
    assert_eq!(recovered[0].outcome, JobOutcome::AlreadyMaterialized);
    assert!(!sc.target("a.md").exists());
    assert_eq!(
        store
            .load_materialization_job("j-delete-durable")
            .expect("load")
            .expect("job")
            .status,
        JobStatus::Complete
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn superseded_lower_generation_job_is_skipped() {
    // A newer generation is materialized at the path first; a later-arriving job
    // carrying an older generation must not regress the path to older content.
    let sc = Scratch::new("superseded");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let newer = b"generation-2-content";
    let older = b"generation-1-content";

    let g2 = spec("j-g2", "a.md", &hex_sha256(newer), Preimage::Absent, 2, 10);
    stage_job(&mut store, newer, &g2);
    let r = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("run g2");
    assert_eq!(r[0].outcome, JobOutcome::Completed);
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), newer);

    let g1 = spec("j-g1", "a.md", &hex_sha256(older), Preimage::Absent, 1, 30);
    stage_job(&mut store, older, &g1);
    let r = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("run g1");
    assert_eq!(r[0].outcome, JobOutcome::Superseded);
    assert_eq!(
        std::fs::read(sc.target("a.md")).expect("read"),
        newer,
        "path not regressed"
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

// --- bounded atomic-replace retry (env.sharing-violation-transient) ---------

/// A replacer that fails the first `fail_count` attempts with a transient
/// sharing-violation, then delegates to a real rename. Counts every attempt.
struct FlakyReplacer {
    remaining_failures: AtomicU32,
    attempts: AtomicU32,
}
impl FlakyReplacer {
    fn new(fail_count: u32) -> Self {
        FlakyReplacer {
            remaining_failures: AtomicU32::new(fail_count),
            attempts: AtomicU32::new(0),
        }
    }
}
impl FlakyReplacer {
    /// Count the attempt, and fail it while injected failures remain.
    fn fail(&self) -> Option<std::io::Error> {
        self.attempts.fetch_add(1, Ordering::AcqRel);
        self.remaining_failures
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_sub(1).or(Some(0))
            })
            .is_ok_and(|prev| prev > 0)
            .then(transient_lock_error)
    }
}
impl AtomicReplacer for FlakyReplacer {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        match self.fail() {
            Some(err) => Err(err),
            None => StdReplacer.displace(target, displaced),
        }
    }

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        match self.fail() {
            Some(err) => Err(err),
            None => StdReplacer.place(incoming, target),
        }
    }
}

/// The real transient shape per platform: a Windows AV/indexer handle
/// surfaces ERROR_SHARING_VIOLATION; POSIX has no sharing violations, so its
/// retryable class is EACCES-shaped. A fake injecting the ambiguous
/// PermissionDenied kind on Windows would certify a classification the real
/// error never takes.
fn transient_lock_error() -> std::io::Error {
    if cfg!(windows) {
        std::io::Error::from_raw_os_error(32)
    } else {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected transient permission denial",
        )
    }
}

struct NonTransientFailingReplacer;

impl AtomicReplacer for NonTransientFailingReplacer {
    fn try_replace_secret(
        &self,
        _from: &Path,
        _to: &Path,
        _pinned_replace: &mut dyn FnMut() -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        Err(std::io::Error::other("injected non-transient failure"))
    }
}

#[test]
fn secret_non_transient_replace_error_removes_plaintext_temp() {
    let sc = Scratch::new("secret-temp-cleanup");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let staged = b"encrypted-placeholder";
    let spec = spec(
        "secret-temp-cleanup",
        ".env",
        &hex_sha256(staged),
        Preimage::Absent,
        1,
        10,
    );
    stage_job(&mut store, staged, &spec);
    let job = store
        .load_materialization_job("secret-temp-cleanup")
        .expect("load")
        .expect("job");

    materialize_secret_one(
        &store,
        sc.workspace(),
        &job,
        b"SECRET=plaintext",
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &NonTransientFailingReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect_err("replace must fail");

    let leftovers = std::fs::read_dir(sc.workspace())
        .expect("workspace entries")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".dohc-write-"))
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "plaintext temps remain: {leftovers:?}"
    );
    assert_eq!(
        store
            .load_materialization_job("secret-temp-cleanup")
            .expect("load")
            .expect("job")
            .status,
        JobStatus::Pending
    );
}

/// Records which failed-attempt numbers the pipeline asked us to back off on, so
/// a test can assert the retry schedule is actually wired (no real sleep).
#[derive(Default)]
struct RecordingBackoff {
    calls: Mutex<Vec<u32>>,
}
impl ReplaceBackoff for RecordingBackoff {
    fn wait_before_retry(&self, failed_attempt: u32) {
        self.calls.lock().unwrap().push(failed_attempt);
    }
}

#[test]
fn bounded_retry_succeeds_below_the_cap_with_exact_attempt_count_and_backoff() {
    let sc = Scratch::new("retry-ok");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"retryable";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    // 2 transient failures (< 5) ⇒ success on attempt 3, exactly 3 traversals,
    // backoff invoked after failed attempts 1 and 2.
    let replacer = FlakyReplacer::new(2);
    let backoff = RecordingBackoff::default();
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &replacer,
            backoff: &backoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect("run");
    assert_eq!(results[0].outcome, JobOutcome::Completed);
    assert_eq!(
        replacer.attempts.load(Ordering::Acquire),
        3,
        "n+1 = 3 attempts"
    );
    assert_eq!(
        *backoff.calls.lock().unwrap(),
        vec![1, 2],
        "backoff between retries"
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn bounded_retry_fails_closed_at_the_cap_and_leaves_job_pending() {
    let sc = Scratch::new("retry-exhaust");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"stuck";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    // 5 (>= cap) transient failures ⇒ fail closed after exactly 5 attempts; the
    // final (5th) failure returns immediately without backing off.
    let replacer = FlakyReplacer::new(5);
    let backoff = RecordingBackoff::default();
    let err = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &replacer,
            backoff: &backoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .unwrap_err();
    // The terminal error says what the code says: on Windows the
    // injected failure is a real sharing violation, so exhaustion keeps the
    // retryable file-locked contract; on POSIX the persistent EACCES is
    // terminal io — there is no lock to poll.
    #[cfg(windows)]
    assert_eq!(err.code(), "file-locked");
    #[cfg(not(windows))]
    assert_eq!(err.code(), "materialize-io");
    assert_eq!(
        replacer.attempts.load(Ordering::Acquire),
        5,
        "exactly 5 attempts"
    );
    assert_eq!(
        *backoff.calls.lock().unwrap(),
        vec![1, 2, 3, 4],
        "backoff on attempts 1-4 only"
    );
    assert!(!sc.target("a.md").exists());
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);
}

#[test]
fn backoff_schedule_is_increasing_and_capped() {
    assert_eq!(backoff_delay(1).as_millis(), 10);
    assert_eq!(backoff_delay(2).as_millis(), 20);
    assert_eq!(backoff_delay(3).as_millis(), 40);
    assert_eq!(backoff_delay(5).as_millis(), 160);
    assert_eq!(backoff_delay(6).as_millis(), 200); // capped
    assert_eq!(backoff_delay(100).as_millis(), 200);
    let mut prev = 0u128;
    for n in 1..=10 {
        let ms = backoff_delay(n).as_millis();
        assert!(ms >= prev, "monotonic");
        prev = ms;
    }
}

#[test]
fn every_materialize_fault_point_has_a_live_call_site() {
    // Registry consistency: arming each materialize.* point crashes the pipeline
    // at that point — no dead/inert fault points. A new materialize FaultPoint
    // that is not wired would fail here.
    // The displacement points only exist on an overwrite, and the journal
    // point only once the staged bytes are unknown, so every point runs
    // against a target that holds the job's preimage until another program
    // writes it just before the move.
    let points = [
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterTempWrite,
        FaultPoint::MaterializeAfterFlushBeforeRename,
        FaultPoint::MaterializeBeforePreimageRevalidate,
        FaultPoint::MaterializeAfterDisplaceBeforePlace,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
        FaultPoint::MaterializeAfterDisplacedHash,
        FaultPoint::MaterializeAfterDisplacementJournal,
        FaultPoint::MaterializeAfterKnownCopyDeletion,
    ];
    for (i, point) in points.into_iter().enumerate() {
        let sc = Scratch::new(&format!("live-{i}"));
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        let content = format!("content-{i}");
        std::fs::write(sc.target("a.md"), PREIMAGE).expect("preimage");
        store.put_binary_blob(PREIMAGE).expect("preimage blob");
        let job = spec(
            "j1",
            "a.md",
            &hex_sha256(content.as_bytes()),
            Preimage::Present(hex_sha256(PREIMAGE)),
            1,
            10,
        );
        stage_job(&mut store, content.as_bytes(), &job);

        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(point);
        let results = run_pending_jobs(
            &store,
            sc.workspace(),
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: if point == FaultPoint::MaterializeAfterKnownCopyDeletion {
                    &StdReplacer
                } else {
                    &racer
                },
                backoff: &NoBackoff,
                now_ms: 20,
                faults: faults.as_ref(),
            },
        )
        .expect("run");
        assert_eq!(
            results[0].outcome,
            JobOutcome::Crashed(point),
            "fault point {} must fire",
            point.as_str()
        );
    }
}

// --- displace, then place: bytes another program wrote are never destroyed ---

const PREIMAGE: &[u8] = b"preimage the engine already has";
const OURS: &[u8] = b"content the job writes";
const OUTSIDE: &[u8] = b"bytes another program wrote after the check";
const CREATED: &[u8] = b"a file another program created while the name was empty";

fn drain(
    store: &EngineStore,
    sc: &Scratch,
    replacer: &dyn AtomicReplacer,
    faults: &dyn FaultInjector,
) -> Vec<JobOutcome> {
    run_pending_jobs(
        store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults,
        },
    )
    .expect("run")
    .into_iter()
    .map(|result| result.outcome)
    .collect()
}

/// Stage an overwrite of `a.md`. Its disk bytes are the job's preimage, and
/// the store holds them, as it holds any head it wrote.
fn stage_overwrite(sc: &Scratch, store: &mut EngineStore) {
    std::fs::write(sc.target("a.md"), PREIMAGE).expect("preimage on disk");
    store.put_binary_blob(PREIMAGE).expect("preimage blob");
    let job = spec(
        "j1",
        "a.md",
        &hex_sha256(OURS),
        Preimage::Present(hex_sha256(PREIMAGE)),
        1,
        10,
    );
    stage_job(store, OURS, &job);
}

fn stage_delete(sc: &Scratch, store: &mut EngineStore) {
    std::fs::write(sc.target("a.md"), PREIMAGE).expect("preimage on disk");
    let job = spec(
        "j1",
        "a.md",
        &hex_sha256(PREIMAGE),
        Preimage::Present(hex_sha256(PREIMAGE)),
        1,
        10,
    );
    store.put_binary_blob(PREIMAGE).expect("blob");
    store
        .write_with(&NoFaults, |tx| {
            enqueue_delete_job(tx, &job)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue delete");
}

const STAGING: &str = ".dohc/engine/displaced";

/// The workspace-relative path of a staged file.
fn staged(name: &str) -> String {
    format!("{STAGING}/{name}")
}

/// Every staged file, as workspace-relative paths.
fn displaced_files(sc: &Scratch) -> Vec<String> {
    match std::fs::read_dir(sc.target(STAGING)) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        entries => entries
            .expect("staging entries")
            .filter_map(Result::ok)
            .map(|entry| staged(&entry.file_name().to_string_lossy()))
            .collect(),
    }
}

/// A move into staging, as the paths a replacer sees.
fn is_staged(path: &Path) -> bool {
    path.parent().is_some_and(|dir| dir.ends_with("displaced"))
}

fn job_status(store: &EngineStore) -> JobStatus {
    store
        .load_materialization_job("j1")
        .expect("load")
        .expect("job")
        .status
}

fn read(sc: &Scratch, rel: &str) -> Option<Vec<u8>> {
    std::fs::read(sc.target(rel)).ok()
}

/// Nothing is left in staging and no displacement row remains.
fn assert_nothing_displaced(sc: &Scratch, store: &EngineStore) {
    assert!(displaced_files(sc).is_empty(), "{:?}", displaced_files(sc));
    assert!(
        store
            .list_unsettled_displacements()
            .expect("unsettled")
            .is_empty()
    );
    assert!(
        store
            .list_kept_displacements("ws")
            .expect("kept")
            .is_empty()
    );
}

/// Bytes another program wrote after the check are back at their path, the
/// job's content is in the conflict sibling, and the job conflicts.
fn assert_outside_change_returned(sc: &Scratch, store: &EngineStore) {
    assert_returned(sc, store, OUTSIDE);
}

fn assert_returned(sc: &Scratch, store: &EngineStore, outside: &[u8]) {
    assert_eq!(read(sc, "a.md").as_deref(), Some(outside));
    assert_eq!(read(sc, "a.md.j1.conflict").as_deref(), Some(OURS));
    assert_nothing_displaced(sc, store);
    assert_eq!(job_status(store), JobStatus::Conflict);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RenameStep {
    Displace,
    Place,
}

type Race = Box<dyn Fn() + Send + Sync>;

/// Lets other programs act once each, the moment before the named rename
/// runs for the first time.
struct RaceBefore {
    races: Vec<(RenameStep, Race, AtomicBool)>,
}

impl RaceBefore {
    fn new(step: RenameStep, race: impl Fn() + Send + Sync + 'static) -> Self {
        RaceBefore {
            races: vec![(step, Box::new(race), AtomicBool::new(false))],
        }
    }

    fn then(mut self, step: RenameStep, race: impl Fn() + Send + Sync + 'static) -> Self {
        self.races
            .push((step, Box::new(race), AtomicBool::new(false)));
        self
    }

    fn arrive(&self, step: RenameStep) {
        for (at, race, fired) in &self.races {
            if *at == step && !fired.swap(true, Ordering::SeqCst) {
                race();
                return;
            }
        }
    }
}

impl AtomicReplacer for RaceBefore {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        self.arrive(RenameStep::Displace);
        StdReplacer.displace(target, displaced)
    }

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        self.arrive(RenameStep::Place);
        StdReplacer.place(incoming, target)
    }
}

/// An editor that writes into the existing file.
fn write_in_place(path: PathBuf, bytes: &'static [u8]) -> impl Fn() + Send + Sync {
    move || std::fs::write(&path, bytes).expect("outside in-place write")
}

/// An editor that saves atomically: a new file renamed over the old one, as
/// git and vim do.
fn rename_over(path: PathBuf) -> impl Fn() + Send + Sync {
    move || {
        let save = path.with_file_name("a.md.editor-save");
        std::fs::write(&save, OUTSIDE).expect("editor temp");
        std::fs::rename(&save, &path).expect("editor rename-over");
    }
}

#[test]
fn an_overwrite_moves_the_preimage_aside_and_deletes_it() {
    let sc = Scratch::new("displace-clean");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);

    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
}

#[test]
fn a_write_in_place_between_check_and_swap_returns_and_conflicts() {
    let sc = Scratch::new("race-in-place");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

#[test]
fn a_rename_over_between_check_and_swap_returns_and_conflicts() {
    let sc = Scratch::new("race-rename-over");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(RenameStep::Displace, rename_over(sc.target("a.md")));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

/// A version switch takes its preimage from disk, so a matching hash does
/// not prove the engine has the bytes. The store decides.
#[test]
fn a_preimage_the_store_lacks_is_never_deleted() {
    let sc = Scratch::new("preimage-not-stored");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    std::fs::write(sc.target("a.md"), OUTSIDE).expect("uncaptured bytes on disk");
    let job = spec(
        "j1",
        "a.md",
        &hex_sha256(OURS),
        Preimage::Present(hex_sha256(OUTSIDE)),
        1,
        10,
    );
    stage_job(&mut store, OURS, &job);

    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

/// The displaced file cannot go back: a program created the target while its
/// name was empty. The displaced bytes stay, with evidence, and the job
/// conflicts so the person is told.
#[test]
fn a_displaced_file_that_cannot_return_is_kept_and_conflicts() {
    let sc = Scratch::new("kept");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OUTSIDE),
    )
    .then(
        RenameStep::Place,
        write_in_place(sc.target("a.md"), CREATED),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(CREATED));
    assert_eq!(read(&sc, "a.md.j1.conflict").as_deref(), Some(OURS));
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(kept[0].state, DisplacementState::Kept);
    assert_eq!(
        kept[0].displaced_sha256.as_deref(),
        Some(hex_sha256(OUTSIDE).as_str())
    );
    assert_eq!(
        read(&sc, &staged(&kept[0].displaced_name)).as_deref(),
        Some(OUTSIDE)
    );
    assert_eq!(job_status(&store), JobStatus::Conflict);
}

/// A replace that finds nothing unexpected writes no displacement row: the
/// staged file is found by its name alone.
#[test]
fn a_clean_replace_stages_without_a_row() {
    let sc = Scratch::new("no-row");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    assert!(matches!(
        drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
        [JobOutcome::Crashed(_)]
    ));

    assert_eq!(displaced_files(&sc), vec![staged("6a31.0")]);
    assert!(
        store
            .list_unsettled_displacements()
            .expect("unsettled")
            .is_empty()
    );
}

#[cfg(windows)]
#[test]
fn a_known_staged_file_denies_writers_until_it_is_removed() {
    struct WriteAfterHash(PathBuf, AtomicBool, AtomicBool);
    impl FaultInjector for WriteAfterHash {
        fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == FaultPoint::MaterializeAfterDisplacedHash {
                self.1.store(true, Ordering::SeqCst);
                let err = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&self.0)
                    .expect_err("inspection must keep denying writers through removal");
                assert_eq!(err.raw_os_error(), Some(32));
                std::fs::hard_link(&self.0, self.0.with_extension("guard"))
                    .expect("alias to the inspected file");
            }
            if point == FaultPoint::MaterializeAfterKnownCopyDeletion {
                self.2.store(true, Ordering::SeqCst);
                // The name is gone. Its alias still identifies the same file,
                // and must remain write-denied until inspection closes.
                let err = std::fs::OpenOptions::new()
                    .write(true)
                    .open(self.0.with_extension("guard"))
                    .expect_err("guard through deletion");
                assert_eq!(err.raw_os_error(), Some(32));
            }
            dohc_engine_storage::FaultAction::Continue
        }
    }
    for delete in [false, true] {
        let sc = Scratch::new("hash-delete-guard");
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        if delete {
            stage_delete(&sc, &mut store);
        } else {
            stage_overwrite(&sc, &mut store);
        }
        let faults = WriteAfterHash(
            sc.target(&staged("6a31.0")),
            AtomicBool::new(false),
            AtomicBool::new(false),
        );
        assert_eq!(
            drain(&store, &sc, &StdReplacer, &faults),
            vec![JobOutcome::Completed]
        );
        assert!(faults.1.load(Ordering::SeqCst));
        assert!(faults.2.load(Ordering::SeqCst));
        std::fs::OpenOptions::new()
            .write(true)
            .open(faults.0.with_extension("guard"))
            .expect("guard released after completion");
        std::fs::remove_file(faults.0.with_extension("guard")).expect("remove test alias");
        assert_nothing_displaced(&sc, &store);
    }
}

#[test]
fn crash_after_known_copy_deletion_replays_from_history() {
    for delete in [false, true] {
        let sc = Scratch::new("known-copy-deleted");
        {
            let mut store = EngineStore::open(&sc.db(), 1).expect("open");
            if delete {
                stage_delete(&sc, &mut store);
            } else {
                stage_overwrite(&sc, &mut store);
            }
            let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterKnownCopyDeletion);
            assert_eq!(
                drain(&store, &sc, &StdReplacer, faults.as_ref()),
                vec![JobOutcome::Crashed(
                    FaultPoint::MaterializeAfterKnownCopyDeletion
                )]
            );
            assert_eq!(job_status(&store), JobStatus::Pending);
            assert_nothing_displaced(&sc, &store);
        }
        let store = EngineStore::open(&sc.db(), 30).expect("reopen");
        assert_eq!(
            store
                .get_binary_blob(&hex_sha256(PREIMAGE))
                .expect("history")
                .as_deref(),
            Some(PREIMAGE)
        );
        assert_eq!(
            drain(&store, &sc, &StdReplacer, &NoFaults),
            vec![JobOutcome::AlreadyMaterialized]
        );
        assert_eq!(
            read(&sc, "a.md").as_deref(),
            if delete { None } else { Some(OURS) }
        );
        assert_nothing_displaced(&sc, &store);
    }
}

#[test]
fn delete_crash_points_preserve_closed_writer_bytes() {
    for point in [
        FaultPoint::MaterializeAfterRenameBeforeComplete,
        FaultPoint::MaterializeAfterDisplacedHash,
        FaultPoint::MaterializeAfterDisplacementJournal,
    ] {
        for rename in [false, true] {
            let sc = Scratch::new("delete-crash-outside");
            {
                let mut store = EngineStore::open(&sc.db(), 1).expect("open");
                stage_delete(&sc, &mut store);
                let target = sc.target("a.md");
                let writer = RaceBefore::new(
                    RenameStep::Displace,
                    Box::new(move || {
                        if rename {
                            let tmp = target.with_extension("save");
                            std::fs::write(&tmp, OUTSIDE).expect("save");
                            std::fs::rename(&tmp, &target).expect("rename save");
                        } else {
                            std::fs::write(&target, OUTSIDE).expect("closed write");
                        }
                    }),
                );
                let faults = ScriptedFaults::crash_at(point);
                assert_eq!(
                    drain(&store, &sc, &writer, faults.as_ref()),
                    vec![JobOutcome::Crashed(point)]
                );
                assert_eq!(read(&sc, &staged("6a31.0")).as_deref(), Some(OUTSIDE));
            }
            let store = EngineStore::open(&sc.db(), 30).expect("reopen");
            assert_eq!(
                drain(&store, &sc, &StdReplacer, &NoFaults),
                vec![JobOutcome::Conflict]
            );
            assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
            assert_nothing_displaced(&sc, &store);
        }
    }
}

#[test]
fn staging_selects_an_unused_name_and_preserves_a_retained_copy() {
    let sc = Scratch::new("staging-collision");
    let mut store = EngineStore::open(&sc.db(), 1).unwrap();
    stage_overwrite(&sc, &mut store);
    put_staged(&sc, "6a31.0", OUTSIDE);
    store
        .keep_displacement(
            &DisplacementSpec {
                job_id: "j1".into(),
                workspace_id: "ws".into(),
                target_path: "a.md".into(),
                displaced_name: "6a31.0".into(),
                expected_sha256: hex_sha256(PREIMAGE),
                content_sha256: Some(hex_sha256(OURS)),
                now_ms: 5,
            },
            Some(&hex_sha256(OUTSIDE)),
        )
        .unwrap();
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
    assert!(matches!(
        drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
        [JobOutcome::Crashed(_)]
    ));
    assert_eq!(read(&sc, &staged("6a31.0")).as_deref(), Some(OUTSIDE));
    assert_eq!(read(&sc, &staged("6a31.1")).as_deref(), Some(PREIMAGE));
}

#[test]
fn direct_replay_finds_a_rowless_copy_after_a_gap() {
    let sc = Scratch::new("rowless-gap");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    std::fs::create_dir_all(sc.target(STAGING)).expect("staging");
    std::fs::write(sc.target(&staged("6a31.3")), OUTSIDE).expect("outside copy");
    std::fs::write(sc.target("a.md"), OURS).expect("placed content");
    let job = store
        .load_materialization_job("j1")
        .expect("load")
        .expect("job");
    materialize_one(&store, sc.workspace(), &job, &sweep_options()).expect("replay");
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
}

/// The staged file was read and not yet judged. Replay reads it again: known
/// bytes are deleted and the job completes.
#[test]
fn crash_after_hashing_a_known_staged_file_deletes_it_on_replay() {
    let sc = Scratch::new("crash-after-hash-known");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplacedHash);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
        assert_eq!(displaced_files(&sc).len(), 1);
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::AlreadyMaterialized]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
}

/// The staged file held an outside change and no row names it yet. Replay
/// reads it again, writes the row, swaps it back, and the job conflicts.
#[test]
fn crash_after_hashing_an_outside_change_returns_it_on_replay() {
    let sc = Scratch::new("crash-after-hash-outside");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplacedHash);
        assert!(matches!(
            drain(&store, &sc, &racer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert!(
            store
                .list_unsettled_displacements()
                .expect("unsettled")
                .is_empty()
        );
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

/// The synced row names the outside change before it moves again. Replay
/// swaps it back from the row.
#[test]
fn crash_after_the_displacement_row_returns_the_outside_change() {
    let sc = Scratch::new("crash-after-journal");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplacementJournal);
        assert_eq!(
            drain(&store, &sc, &racer, faults.as_ref()),
            vec![JobOutcome::Crashed(
                FaultPoint::MaterializeAfterDisplacementJournal
            )]
        );
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
        let rows = store.list_unsettled_displacements().expect("unsettled");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, DisplacementState::Open);
        assert_eq!(
            read(&sc, &staged(&rows[0].displaced_name)).as_deref(),
            Some(OUTSIDE)
        );
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

#[test]
fn crash_between_displace_and_place_puts_the_file_back_and_replays() {
    let sc = Scratch::new("crash-mid-swap");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert_eq!(
            drain(&store, &sc, &StdReplacer, faults.as_ref()),
            vec![JobOutcome::Crashed(
                FaultPoint::MaterializeAfterDisplaceBeforePlace
            )]
        );
        assert!(!sc.target("a.md").exists(), "the name is empty mid-swap");
        let displaced = displaced_files(&sc);
        assert_eq!(displaced.len(), 1);
        assert_eq!(read(&sc, &displaced[0]).as_deref(), Some(PREIMAGE));
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
}

#[test]
fn crash_between_displace_and_place_returns_an_outside_change_to_its_path() {
    let sc = Scratch::new("crash-mid-swap-outside");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &racer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert!(!sc.target("a.md").exists());
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    // The outside bytes go back to their path, so the rerun sees them and
    // conflicts instead of writing over them.
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

/// A staged file has no row until its bytes turn out unknown, and a power
/// failure can lose a row while the rename survives. Replay finds the staged
/// file by its name and puts it back.
#[test]
fn a_displaced_file_whose_row_was_lost_is_found_and_returned() {
    let sc = Scratch::new("orphan");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM materialization_displacements", [])
                    .map_err(|_| StorageError::PersistFailed { source: None })?;
                Ok::<_, StorageError>(())
            })
            .expect("lose the row");
        assert_eq!(displaced_files(&sc).len(), 1);
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
}

#[test]
fn crash_after_the_swap_deletes_the_preimage_copy_on_replay() {
    let sc = Scratch::new("crash-after-swap");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
        assert_eq!(displaced_files(&sc).len(), 1);
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::AlreadyMaterialized]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
}

/// The new file was in place when the engine stopped, and the person deleted
/// it before restart. Replay must not bring the old file back.
#[test]
fn a_file_deleted_after_its_replace_placed_it_stays_deleted() {
    let sc = Scratch::new("placed-then-deleted");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
    }
    std::fs::remove_file(sc.target("a.md")).expect("the person deletes the file");
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert!(
        !sc.target("a.md").exists(),
        "the old file did not come back"
    );
    assert_nothing_displaced(&sc, &store);
}

/// The first displace hits a sharing violation, and another program writes
/// the file while the engine backs off. The retry's recheck sees it.
struct WriteDuringFirstLock {
    target: PathBuf,
    displaces: AtomicU32,
}

impl AtomicReplacer for WriteDuringFirstLock {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        if self.displaces.fetch_add(1, Ordering::SeqCst) == 0 {
            std::fs::write(&self.target, OUTSIDE).expect("outside write during the lock");
            return Err(transient_lock_error());
        }
        StdReplacer.displace(target, displaced)
    }
}

#[test]
fn a_sharing_violation_retry_rechecks_the_preimage() {
    let sc = Scratch::new("retry-recheck");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let replacer = WriteDuringFirstLock {
        target: sc.target("a.md"),
        displaces: AtomicU32::new(0),
    };

    assert_eq!(
        drain(&store, &sc, &replacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(replacer.displaces.load(Ordering::SeqCst), 1);
    assert_outside_change_returned(&sc, &store);
}

/// A rename can report failure after it happened (an NFS client that
/// retransmits it gets ENOENT). The displaced name decides.
struct ReportsNotFoundAfterMoving;

impl AtomicReplacer for ReportsNotFoundAfterMoving {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        StdReplacer.displace(target, displaced)?;
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    }
}

#[test]
fn a_displace_that_reports_not_found_after_moving_still_completes() {
    let sc = Scratch::new("retransmit");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);

    assert_eq!(
        drain(&store, &sc, &ReportsNotFoundAfterMoving, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
}

/// A real Windows sharing violation: a handle without FILE_SHARE_DELETE
/// blocks the move. The engine retries, then fails closed with nothing moved.
#[cfg(windows)]
#[test]
fn a_handle_without_delete_sharing_fails_closed_without_moving_anything() {
    use std::os::windows::fs::OpenOptionsExt;
    let sc = Scratch::new("held-no-delete-share");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // read | write, no delete
        .open(sc.target("a.md"))
        .expect("hold the target");

    let err = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect_err("a held target cannot be moved");
    drop(holder);

    assert_eq!(err.code(), "file-locked");
    assert_eq!(read(&sc, "a.md").as_deref(), Some(PREIMAGE));
    assert!(!sc.target(".dohc-write-j1.tmp").exists(), "temp removed");
    assert_nothing_displaced(&sc, &store);
    assert_eq!(job_status(&store), JobStatus::Pending);
}

/// A program keeps the file open for writing across the move. The file goes
/// back to its path with the handle still on it, so later writes land where
/// the program expects, and the job conflicts.
#[cfg(windows)]
#[test]
fn a_displaced_file_still_open_for_writing_goes_back_and_conflicts() {
    use std::io::Write as _;
    use std::os::windows::fs::OpenOptionsExt;
    let sc = Scratch::new("held-for-writing");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let mut writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0x1 | 0x2 | 0x4) // read | write | delete
        .open(sc.target("a.md"))
        .expect("open for writing");

    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(read(&sc, "a.md.j1.conflict").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);

    writer.write_all(b"LATE").expect("late write");
    drop(writer);
    let on_disk = read(&sc, "a.md").expect("target");
    assert!(
        on_disk.starts_with(b"LATE"),
        "the late write lands at the path"
    );
}

#[test]
fn an_absent_target_created_before_the_rename_is_not_replaced() {
    let sc = Scratch::new("race-create");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let job = spec("j1", "a.md", &hex_sha256(OURS), Preimage::Absent, 1, 10);
    stage_job(&mut store, OURS, &job);
    let racer = RaceBefore::new(
        RenameStep::Place,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

#[test]
fn a_file_created_between_displace_and_place_is_not_replaced() {
    let sc = Scratch::new("race-recreate");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(
        RenameStep::Place,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_outside_change_returned(&sc, &store);
}

#[test]
fn a_write_racing_a_delete_returns_and_conflicts() {
    let sc = Scratch::new("race-delete");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_delete(&sc, &mut store);
    let racer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
    assert_nothing_displaced(&sc, &store);
    assert_eq!(job_status(&store), JobStatus::Conflict);
}

#[test]
fn a_delete_removes_a_file_the_store_holds() {
    let sc = Scratch::new("delete-clean");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_delete(&sc, &mut store);

    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert!(!sc.target("a.md").exists());
    assert_nothing_displaced(&sc, &store);
}

/// A crash leaves a replace half done, and the job is cancelled before the
/// next run. The sweep still puts the displaced file back.
#[test]
fn a_cancelled_job_still_gets_its_displaced_file_back() {
    let sc = Scratch::new("sweep-cancelled");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        store
            .write_with(&NoFaults, |tx| {
                cancel_pending_jobs_for_path(tx, "ws", "a.md", 15)?;
                Ok::<_, StorageError>(())
            })
            .expect("cancel");
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert!(drain(&store, &sc, &StdReplacer, &NoFaults).is_empty());
    assert_eq!(read(&sc, "a.md").as_deref(), Some(PREIMAGE));
    assert_nothing_displaced(&sc, &store);
    assert_eq!(job_status(&store), JobStatus::Cancelled);
}

/// `git checkout -- notes.md` or an editor's revert writes an older head the
/// store holds. It is still an outside change: only the preimage or the
/// job's own content may be deleted.
#[test]
fn a_revert_to_an_older_stored_head_returns_and_conflicts() {
    const OLDER: &[u8] = b"an older head the store still holds";
    let sc = Scratch::new("revert-older");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    store.put_binary_blob(OLDER).expect("older head");
    let racer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OLDER),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_returned(&sc, &store, OLDER);
}

/// Node's `writeFile`, VS Code and `echo x > f` truncate the file and then
/// write it. A displaced file caught in between is empty, and still the
/// writer's: only an empty preimage makes an empty file known.
#[test]
fn a_file_truncated_mid_write_returns_and_conflicts() {
    let sc = Scratch::new("truncated");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(RenameStep::Displace, write_in_place(sc.target("a.md"), b""));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_returned(&sc, &store, b"");
}

/// Refuses to move a displaced file back, as a lock that outlasts the
/// return's budget would.
struct ReturnsFail;

impl AtomicReplacer for ReturnsFail {
    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        if is_staged(incoming) {
            return Err(std::io::Error::other("injected return failure"));
        }
        StdReplacer.place(incoming, target)
    }
}

/// A return that fails leaves the name empty. The next look at the path,
/// which is what the actor does before it refuses an absence, tries again,
/// and the outside bytes come back.
#[test]
fn a_failed_return_is_retried_and_the_file_comes_back() {
    let sc = Scratch::new("failed-return");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let replacer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );
    struct Both<'a>(&'a RaceBefore, ReturnsFail);
    impl AtomicReplacer for Both<'_> {
        fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
            self.0.displace(target, displaced)
        }
        fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
            self.1.place(incoming, target)
        }
    }
    let failing = Both(&replacer, ReturnsFail);
    run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &failing,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect_err("the return fails");
    assert!(!sc.target("a.md").exists(), "the name is empty");
    assert!(store.path_is_displaced("ws", "a.md").expect("query"));

    recover_path_displacements(
        &store,
        sc.workspace(),
        "ws",
        "a.md",
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &StdReplacer,
            backoff: &NoBackoff,
            now_ms: 30,
            faults: &NoFaults,
        },
    )
    .expect("retry the return");
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
    assert_nothing_displaced(&sc, &store);
}

/// Records every rename a replace makes.
#[derive(Default)]
struct RecordRenames {
    steps: Mutex<Vec<String>>,
    race: Option<RaceBefore>,
}

impl RecordRenames {
    fn record(&self, step: &str, from: &Path, to: &Path) {
        let name = |path: &Path| {
            let name = path
                .file_name()
                .expect("name")
                .to_string_lossy()
                .into_owned();
            if is_staged(path) {
                "displaced".to_owned()
            } else if name.ends_with(".tmp") {
                "temp".to_owned()
            } else {
                name
            }
        };
        self.steps
            .lock()
            .unwrap()
            .push(format!("{step} {} -> {}", name(from), name(to)));
    }
}

impl AtomicReplacer for RecordRenames {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        self.record("displace", target, displaced);
        match &self.race {
            Some(race) => race.displace(target, displaced),
            None => StdReplacer.displace(target, displaced),
        }
    }

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        self.record("place", incoming, target);
        StdReplacer.place(incoming, target)
    }
}

/// The target name is empty only between the first two renames. The
/// displaced file is read after the job's content is in place; an outside
/// change found then is swapped back.
#[test]
fn the_name_is_empty_only_between_two_renames() {
    let sc = Scratch::new("rename-order");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let clean = RecordRenames::default();
    assert_eq!(
        drain(&store, &sc, &clean, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(
        *clean.steps.lock().unwrap(),
        vec!["displace a.md -> displaced", "place temp -> a.md"]
    );

    let sc = Scratch::new("rename-order-race");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racing = RecordRenames {
        race: Some(RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        )),
        ..RecordRenames::default()
    };
    assert_eq!(
        drain(&store, &sc, &racing, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(
        *racing.steps.lock().unwrap(),
        vec![
            "displace a.md -> displaced",
            "place temp -> a.md",
            "displace a.md -> displaced",
            "place displaced -> a.md",
        ]
    );
    assert_outside_change_returned(&sc, &store);
}

/// A replace placed its content and found an outside change, then stopped
/// before swapping it back. While dohc was closed, the person saved a newer
/// file. Replay must not move that newer file: the older outside change stays
/// displaced, with its row kept, and the job conflicts.
#[test]
fn a_newer_save_after_a_crash_is_never_moved_aside() {
    const NEWEST: &[u8] = b"the person's newest save, made while dohc was closed";
    let sc = Scratch::new("newer-save-after-crash");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
        assert!(matches!(
            drain(&store, &sc, &racer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    }
    std::fs::write(sc.target("a.md"), NEWEST).expect("a newer save");
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let recorder = RecordRenames::default();
    drain(&store, &sc, &recorder, &NoFaults);
    assert!(
        recorder.steps.lock().unwrap().is_empty(),
        "replay moved nothing: {:?}",
        recorder.steps.lock().unwrap()
    );

    assert_eq!(
        read(&sc, "a.md").as_deref(),
        Some(NEWEST),
        "the newest save stays"
    );
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    let kept_file = staged(&kept[0].displaced_name);
    assert_eq!(read(&sc, &kept_file).as_deref(), Some(OUTSIDE));
    assert_eq!(displaced_files(&sc), vec![kept_file]);
    assert_eq!(job_status(&store), JobStatus::Conflict);
}

/// The job writes an empty file, and a writer truncates the target to start
/// its own write. The empty displaced file is still the writer's: only an
/// empty preimage makes an empty file known.
#[test]
fn an_empty_write_does_not_make_a_truncated_file_known() {
    let sc = Scratch::new("empty-write-truncated");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    std::fs::write(sc.target("a.md"), PREIMAGE).expect("preimage on disk");
    store.put_binary_blob(PREIMAGE).expect("preimage blob");
    let job = spec(
        "j1",
        "a.md",
        &hex_sha256(b""),
        Preimage::Present(hex_sha256(PREIMAGE)),
        1,
        10,
    );
    stage_job(&mut store, b"", &job);
    let racer = RaceBefore::new(RenameStep::Displace, write_in_place(sc.target("a.md"), b""));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(&b""[..]));
    assert_eq!(read(&sc, "a.md.j1.conflict").as_deref(), Some(&b""[..]));
    assert_nothing_displaced(&sc, &store);
}

/// The job's content cannot move to the conflict sibling. It stays at its
/// displaced name under a kept row that names its hash, instead of being
/// deleted with no copy to open.
#[test]
fn a_failed_conflict_copy_keeps_the_jobs_content() {
    let sc = Scratch::new("conflict-copy-fails");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    std::fs::create_dir(sc.target("a.md.j1.conflict")).expect("block the conflict name");
    let racer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        kept[0].displaced_sha256.as_deref(),
        Some(hex_sha256(OURS).as_str())
    );
    assert_eq!(
        read(&sc, &staged(&kept[0].displaced_name)).as_deref(),
        Some(OURS)
    );
    assert_eq!(job_status(&store), JobStatus::Conflict);
}

const NEWER: &[u8] = b"a newer save that landed while dohc moved its own content aside";

/// Two outside saves during one replace: OUTSIDE before dohc moves the
/// preimage aside, NEWER before it moves its own content aside to put
/// OUTSIDE back. The process can stop right after the second move, and the
/// put-back of a displaced file can stay locked.
struct TwoSaves {
    displaces: AtomicU32,
    crash_after_second_move: bool,
    lock_put_backs: bool,
    snapshot_before_second_move: Option<DbSnapshot>,
}

impl TwoSaves {
    fn new(crash_after_second_move: bool, lock_put_backs: bool) -> Self {
        TwoSaves {
            displaces: AtomicU32::new(0),
            crash_after_second_move,
            lock_put_backs,
            snapshot_before_second_move: None,
        }
    }
}

/// A copy of the engine database at one moment. Restoring it while the files
/// stay as they are is what an operating-system crash leaves: every commit
/// synced by then survives, and later commits are lost.
struct DbSnapshot {
    db: PathBuf,
    dir: PathBuf,
}

impl DbSnapshot {
    fn files(&self) -> Vec<(PathBuf, PathBuf)> {
        let name = self
            .db
            .file_name()
            .expect("db name")
            .to_string_lossy()
            .into_owned();
        ["", "-wal"]
            .into_iter()
            .map(|suffix| {
                (
                    self.db.with_file_name(format!("{name}{suffix}")),
                    self.dir.join(format!("{name}{suffix}")),
                )
            })
            .collect()
    }

    /// Copy through a handle that shares read, write and delete, as SQLite
    /// holds its files open.
    fn copy(from: &Path, to: &Path) {
        let mut source = std::fs::File::open(from).expect("open database file");
        let mut copy = std::fs::File::create(to).expect("create copy");
        std::io::copy(&mut source, &mut copy).expect("copy database file");
    }

    fn take(&self) {
        std::fs::create_dir_all(&self.dir).expect("snapshot dir");
        for (live, saved) in self.files() {
            if live.exists() {
                Self::copy(&live, &saved);
            }
        }
    }

    /// Put the copy back. The store must be closed.
    fn restore(&self) {
        let shm = {
            let name = self
                .db
                .file_name()
                .expect("db name")
                .to_string_lossy()
                .into_owned();
            self.db.with_file_name(format!("{name}-shm"))
        };
        let _ = std::fs::remove_file(shm);
        for (live, saved) in self.files() {
            let _ = std::fs::remove_file(&live);
            if saved.exists() {
                Self::copy(&saved, &live);
            }
        }
    }
}

impl AtomicReplacer for TwoSaves {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        let n = self.displaces.fetch_add(1, Ordering::SeqCst);
        match n {
            0 => std::fs::write(target, OUTSIDE).expect("first outside save"),
            1 => std::fs::write(target, NEWER).expect("newer outside save"),
            _ => {}
        }
        if n == 1
            && let Some(snapshot) = &self.snapshot_before_second_move
        {
            snapshot.take();
        }
        StdReplacer.displace(target, displaced)?;
        if n == 1 && self.crash_after_second_move {
            panic!("the process stops right after moving the newer save aside");
        }
        Ok(())
    }

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        if self.lock_put_backs && is_staged(incoming) {
            return Err(transient_lock_error());
        }
        StdReplacer.place(incoming, target)
    }
}

/// After the newer save, the older outside change stays displaced under a
/// kept row, and the job conflicts.
fn assert_newer_save_shown(sc: &Scratch, store: &EngineStore) {
    assert_eq!(
        read(sc, "a.md").as_deref(),
        Some(NEWER),
        "the newest save is at its path"
    );
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    let kept_file = staged(&kept[0].displaced_name);
    assert_eq!(read(sc, &kept_file).as_deref(), Some(OUTSIDE));
    assert_eq!(displaced_files(sc), vec![kept_file]);
    assert!(
        store
            .list_unsettled_displacements()
            .expect("unsettled")
            .is_empty()
    );
    assert_eq!(job_status(store), JobStatus::Conflict);
}

/// Crash between moving the newer save aside and putting it back. The name
/// is empty and two rows name the path; recovery returns the newest file.
#[test]
fn a_crash_after_moving_a_newer_save_aside_returns_the_newer_save() {
    let sc = Scratch::new("crash-after-aside");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let replacer = TwoSaves::new(true, false);
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drain(&store, &sc, &replacer, &NoFaults)
        }));
        assert!(stopped.is_err(), "the process stopped mid-replace");
        assert!(!sc.target("a.md").exists(), "the name is empty");
        assert_eq!(displaced_files(&sc).len(), 2);
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    drain(&store, &sc, &StdReplacer, &NoFaults);
    assert_newer_save_shown(&sc, &store);
}

/// The put-back of the newer save stays locked past its tries. The next run
/// returns the newer save, not the older outside change.
#[test]
fn a_locked_put_back_of_a_newer_save_returns_it_on_the_next_run() {
    let sc = Scratch::new("locked-put-back");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &TwoSaves::new(false, true),
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    )
    .expect_err("the put-back stays locked");
    assert!(!sc.target("a.md").exists(), "the name is empty");

    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_newer_save_shown(&sc, &store);
}

/// An operating-system crash after the row naming the newer save's file was
/// synced keeps every commit up to that row and can lose every commit after
/// it, here the one that kept the older change's row. The renames survive.
/// Recovery still returns the newer save.
#[test]
fn a_power_loss_after_the_synced_row_still_returns_the_newer_save() {
    let sc = Scratch::new("power-loss");
    let snapshot = DbSnapshot {
        db: sc.db(),
        dir: sc.root.join(".dohc").join("power-loss-snapshot"),
    };
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let mut replacer = TwoSaves::new(false, true);
        replacer.snapshot_before_second_move = Some(DbSnapshot {
            db: snapshot.db.clone(),
            dir: snapshot.dir.clone(),
        });
        run_pending_jobs(
            &store,
            sc.workspace(),
            &MaterializeOptions {
                policy: DurabilityPolicy::none(),
                replacer: &replacer,
                backoff: &NoBackoff,
                now_ms: 20,
                faults: &NoFaults,
            },
        )
        .expect_err("the put-back stays locked");
    }
    snapshot.restore();
    assert!(!sc.target("a.md").exists(), "the name is empty");
    assert_eq!(displaced_files(&sc).len(), 2, "both renames survived");

    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let rows = store.list_unsettled_displacements().expect("unsettled");
    assert_eq!(
        rows.iter().map(|row| row.state).collect::<Vec<_>>(),
        vec![DisplacementState::Open, DisplacementState::Open],
        "the newer save's synced row survived; the later keep was lost"
    );
    drain(&store, &sc, &StdReplacer, &NoFaults);
    assert_newer_save_shown(&sc, &store);
}

/// A filesystem with neither an exclusive rename nor hard links, as FAT or an
/// SMB share can be on Linux and macOS. Its placement is the check-then-rename
/// fallback; here the ordinary no-replace rename stands in for it and reports
/// the fallback.
struct NoAtomicRename;

impl AtomicReplacer for NoAtomicRename {
    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        StdReplacer.place(incoming, target)?;
        Ok(Placement::CheckThenRename)
    }
}

/// Without an atomic no-replace rename the write still happens, and the
/// workspace reports the limit. A workspace on an ordinary filesystem never
/// does.
#[test]
fn a_filesystem_without_atomic_no_replace_writes_and_reports_the_limit() {
    for preimage_on_disk in [true, false] {
        let sc = Scratch::new(if preimage_on_disk {
            "no-atomic-overwrite"
        } else {
            "no-atomic-create"
        });
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        if preimage_on_disk {
            stage_overwrite(&sc, &mut store);
        } else {
            let job = spec("j1", "a.md", &hex_sha256(OURS), Preimage::Absent, 1, 10);
            stage_job(&mut store, OURS, &job);
        }
        assert!(!workspace_lacks_atomic_placement(sc.workspace()));

        assert_eq!(
            drain(&store, &sc, &NoAtomicRename, &NoFaults),
            vec![JobOutcome::Completed]
        );
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
        assert_nothing_displaced(&sc, &store);
        assert!(
            workspace_lacks_atomic_placement(sc.workspace()),
            "the workspace reports no-atomic-placement"
        );
    }

    let ordinary = Scratch::new("atomic-ordinary");
    let mut store = EngineStore::open(&ordinary.db(), 1).expect("open");
    stage_overwrite(&ordinary, &mut store);
    assert_eq!(
        drain(&store, &ordinary, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert!(!workspace_lacks_atomic_placement(ordinary.workspace()));
}

/// A crash left a replace between its renames. After the restart, only the
/// recovery sweep runs, and it puts the file back with a check-then-rename on
/// this drive. The workspace reports the limit from recovery alone.
#[test]
fn recovery_after_a_restart_on_a_drive_without_atomic_renames_reports_the_limit() {
    let sc = Scratch::new("no-atomic-recovery");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &NoAtomicRename, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert!(!sc.target("a.md").exists());
        assert!(
            !workspace_lacks_atomic_placement(sc.workspace()),
            "nothing was placed before the crash"
        );
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    recover_displacements(
        &store,
        sc.workspace(),
        None,
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &NoAtomicRename,
            backoff: &NoBackoff,
            now_ms: 40,
            faults: &NoFaults,
        },
    )
    .expect("recover");
    assert_eq!(
        read(&sc, "a.md").as_deref(),
        Some(PREIMAGE),
        "the file is back"
    );
    assert!(workspace_lacks_atomic_placement(sc.workspace()));
}

/// A write creates, truncates and follows nothing but its own names. A file
/// and a symlink at the names an earlier build's probe used, the symlink
/// pointing outside the workspace, are left exactly as they were.
#[test]
fn a_write_leaves_files_and_symlinks_at_old_probe_names_untouched() {
    let sc = Scratch::new("old-probe-names");
    let outside = Scratch::new("old-probe-outside");
    let outside_file = outside.target("precious.txt");
    std::fs::write(&outside_file, b"outside the workspace").expect("outside file");
    let pid = std::process::id();
    let probe = sc.target(&format!(".dohc-write-probe-{pid}"));
    std::fs::write(&probe, b"someone else's bytes").expect("file at the probe name");
    let moved = sc.target(&format!(".dohc-write-probe-{pid}.moved"));
    let linked = try_make_file_symlink(&outside_file, &moved).expect("symlink");

    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );

    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_eq!(
        std::fs::read(&probe).expect("probe file"),
        b"someone else's bytes"
    );
    if linked {
        assert!(
            std::fs::symlink_metadata(&moved)
                .expect("symlink kept")
                .file_type()
                .is_symlink()
        );
    }
    assert_eq!(
        std::fs::read(&outside_file).expect("outside file"),
        b"outside the workspace"
    );
}

/// A network filesystem can do a rename and then report it failed. A
/// check-then-rename that errors after taking effect still records the limit.
struct FallbackRenameFailsAfterMoving;

impl AtomicReplacer for FallbackRenameFailsAfterMoving {
    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<Placement> {
        StdReplacer.place(incoming, target)?;
        Err(CheckThenRenameFailed::wrap(std::io::Error::from(
            std::io::ErrorKind::NotFound,
        )))
    }
}

#[test]
fn a_fallback_rename_that_reports_failure_after_moving_still_reports_the_limit() {
    let sc = Scratch::new("fallback-fails-after-moving");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let job = spec("j1", "a.md", &hex_sha256(OURS), Preimage::Absent, 1, 10);
    stage_job(&mut store, OURS, &job);

    let result = run_pending_jobs(
        &store,
        sc.workspace(),
        &MaterializeOptions {
            policy: DurabilityPolicy::none(),
            replacer: &FallbackRenameFailsAfterMoving,
            backoff: &NoBackoff,
            now_ms: 20,
            faults: &NoFaults,
        },
    );
    assert!(result.is_err(), "the rename reported failure");
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS), "it took effect");
    assert!(workspace_lacks_atomic_placement(sc.workspace()));
}

/// Stage `n` overwrites of `f{i}.md`, each file on disk holding its preimage.
fn stage_overwrites(sc: &Scratch, store: &mut EngineStore, n: usize) {
    for i in 0..n {
        let before = format!("preimage {i}");
        let after = format!("content {i}");
        std::fs::write(sc.target(&format!("f{i}.md")), &before).expect("preimage on disk");
        store
            .put_binary_blob(before.as_bytes())
            .expect("preimage blob");
        let job = spec(
            &format!("j{i}"),
            &format!("f{i}.md"),
            &hex_sha256(after.as_bytes()),
            Preimage::Present(hex_sha256(before.as_bytes())),
            1,
            10 + i as i64,
        );
        stage_job(store, after.as_bytes(), &job);
    }
}

/// Records the most displacement rows the store held at any rename.
struct CountRowsAtRenames {
    db: PathBuf,
    most: Mutex<i64>,
}

impl AtomicReplacer for CountRowsAtRenames {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        let conn = rusqlite::Connection::open_with_flags(
            &self.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("read the store");
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM materialization_displacements",
                [],
                |row| row.get(0),
            )
            .expect("count rows");
        let mut most = self.most.lock().unwrap();
        *most = (*most).max(rows);
        drop(most);
        StdReplacer.displace(target, displaced)
    }
}

/// Overwrites of files that hold their preimage write no displacement row,
/// so a batch pays no synced commit per file.
#[test]
fn a_batch_of_clean_overwrites_writes_no_displacement_row() {
    let sc = Scratch::new("batch-no-rows");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrites(&sc, &mut store, 3);
    let replacer = CountRowsAtRenames {
        db: sc.db(),
        most: Mutex::new(0),
    };

    assert_eq!(
        drain(&store, &sc, &replacer, &NoFaults),
        vec![JobOutcome::Completed; 3]
    );
    assert_eq!(*replacer.most.lock().unwrap(), 0);
    for i in 0..3 {
        assert_eq!(
            read(&sc, &format!("f{i}.md")).as_deref(),
            Some(format!("content {i}").as_bytes())
        );
    }
    assert_nothing_displaced(&sc, &store);
}

/// A crash mid-batch leaves one staged file and no row. Replay finds it by
/// name, puts it back, and runs every job.
#[test]
fn a_crash_mid_batch_recovers_every_job() {
    let sc = Scratch::new("batch-crash");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrites(&sc, &mut store, 3);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert_eq!(displaced_files(&sc).len(), 1);
        assert!(
            store
                .list_unsettled_displacements()
                .expect("unsettled")
                .is_empty()
        );
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed; 3]
    );
    for i in 0..3 {
        assert_eq!(
            read(&sc, &format!("f{i}.md")).as_deref(),
            Some(format!("content {i}").as_bytes())
        );
    }
    assert_nothing_displaced(&sc, &store);
}

fn sweep_options() -> MaterializeOptions<'static> {
    MaterializeOptions {
        policy: DurabilityPolicy::none(),
        replacer: &StdReplacer,
        backoff: &NoBackoff,
        now_ms: 40,
        faults: &NoFaults,
    }
}

/// Leave a file in staging under `name`, as a crash or another program would.
fn put_staged(sc: &Scratch, name: &str, bytes: &[u8]) {
    std::fs::create_dir_all(sc.target(STAGING)).expect("staging");
    std::fs::write(sc.target(&staged(name)), bytes).expect("staged file");
}

/// A staged file whose job the store no longer has is never deleted, even
/// when the store holds its bytes: nothing says which path they came from.
/// It stays with a kept row, and later sweeps leave it alone.
#[test]
fn a_staged_file_whose_job_is_gone_is_kept() {
    let sc = Scratch::new("orphan-kept");
    let store = EngineStore::open(&sc.db(), 1).expect("open");
    store.put_binary_blob(PREIMAGE).expect("blob");
    // The name spells the job id "gone".
    put_staged(&sc, "676f6e65.0", PREIMAGE);

    for _ in 0..2 {
        recover_displacements(&store, sc.workspace(), Some("ws"), &sweep_options()).expect("sweep");
    }
    assert_eq!(read(&sc, &staged("676f6e65.0")).as_deref(), Some(PREIMAGE));
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(kept[0].job_id, "gone");
    assert_eq!(kept[0].target_path, "");
    assert_eq!(
        kept[0].displaced_sha256.as_deref(),
        Some(hex_sha256(PREIMAGE).as_str())
    );
}

/// A known file left staged after its job finished, as a delete that failed
/// leaves it, goes with the next sweep.
#[test]
fn a_finished_jobs_known_staged_file_is_deleted() {
    let sc = Scratch::new("finished-leftover");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    put_staged(&sc, "6a31.0", PREIMAGE);

    recover_displacements(&store, sc.workspace(), None, &sweep_options()).expect("sweep");
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
    assert_nothing_displaced(&sc, &store);
    assert_eq!(job_status(&store), JobStatus::Complete);
}

/// A crash left a write between its renames with an outside change staged,
/// and a program created the target before restart. The new file stays; the
/// staged change cannot go back, so it stays with a kept row and the job
/// conflicts.
#[test]
fn a_name_taken_before_recovery_keeps_the_staged_file() {
    let sc = Scratch::new("recover-occupied");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &racer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert!(!sc.target("a.md").exists());
    }
    std::fs::write(sc.target("a.md"), CREATED).expect("a program creates the file");
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert!(drain(&store, &sc, &StdReplacer, &NoFaults).is_empty());

    assert_eq!(read(&sc, "a.md").as_deref(), Some(CREATED));
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        kept[0].displaced_sha256.as_deref(),
        Some(hex_sha256(OUTSIDE).as_str())
    );
    assert_eq!(
        read(&sc, &staged(&kept[0].displaced_name)).as_deref(),
        Some(OUTSIDE)
    );
    assert_eq!(job_status(&store), JobStatus::Conflict);
}

/// A program still has the staged file open for writing when recovery runs,
/// and a newer save holds the name. The file stays under a kept row with no
/// hash; once the program closes it, the next sweep reads it.
#[cfg(windows)]
#[test]
fn a_staged_file_open_for_writing_is_read_again_once_closed() {
    use std::os::windows::fs::OpenOptionsExt;
    let sc = Scratch::new("recover-open-writer");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(
            RenameStep::Displace,
            write_in_place(sc.target("a.md"), OUTSIDE),
        );
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
        assert!(matches!(
            drain(&store, &sc, &racer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
    }
    std::fs::write(sc.target("a.md"), NEWER).expect("a newer save");
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .share_mode(0x1 | 0x2 | 0x4) // read | write | delete
        .open(sc.target(&staged("6a31.0")))
        .expect("open for writing");
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert!(drain(&store, &sc, &StdReplacer, &NoFaults).is_empty());
    let unsettled = store.list_unsettled_displacements().expect("unsettled");
    assert_eq!(unsettled.len(), 1, "{unsettled:?}");
    assert_eq!(unsettled[0].state, DisplacementState::Kept);
    assert_eq!(unsettled[0].displaced_sha256, None);

    drop(writer);
    recover_displacements(&store, sc.workspace(), None, &sweep_options()).expect("sweep");
    assert!(
        store
            .list_unsettled_displacements()
            .expect("unsettled")
            .is_empty()
    );
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(
        kept[0].displaced_sha256.as_deref(),
        Some(hex_sha256(OUTSIDE).as_str())
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(NEWER));
    assert_eq!(job_status(&store), JobStatus::Conflict);
}

/// A kept row holds its staged name after a person removes the file, so the
/// next run stages under the name after it. A job that runs without the
/// startup sweep still finds a file its stopped run staged past the gap.
#[test]
fn a_staged_file_past_an_emptied_kept_name_is_found() {
    let sc = Scratch::new("name-gap");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    store
        .keep_displacement(
            &DisplacementSpec {
                job_id: "j1".to_owned(),
                workspace_id: "ws".to_owned(),
                target_path: "a.md".to_owned(),
                displaced_name: "6a31.0".to_owned(),
                expected_sha256: hex_sha256(PREIMAGE),
                content_sha256: Some(hex_sha256(OURS)),
                now_ms: 5,
            },
            Some(&hex_sha256(OUTSIDE)),
        )
        .expect("a kept row whose file a person removed");
    let racer = RaceBefore::new(
        RenameStep::Displace,
        write_in_place(sc.target("a.md"), OUTSIDE),
    );
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    assert!(matches!(
        drain(&store, &sc, &racer, faults.as_ref())[..],
        [JobOutcome::Crashed(_)]
    ));
    assert_eq!(displaced_files(&sc), vec![staged("6a31.1")]);

    let job = store
        .load_materialization_job("j1")
        .expect("load")
        .expect("job");
    assert_eq!(
        materialize_one(&store, sc.workspace(), &job, &sweep_options()).expect("run"),
        JobOutcome::Conflict
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
    assert_eq!(read(&sc, "a.md.j1.conflict").as_deref(), Some(OURS));
    assert!(displaced_files(&sc).is_empty());
    assert_eq!(
        store.list_kept_displacements("ws").expect("kept").len(),
        1,
        "the emptied name's row stays"
    );
}

/// The staging directory is a link to somewhere else. A replace moves
/// nothing through it: the job is blocked and the file stays.
#[test]
fn a_linked_staging_directory_blocks_the_replace() {
    let sc = Scratch::new("staging-linked");
    let elsewhere = Scratch::new("staging-linked-elsewhere");
    if !try_make_dir_alias(elsewhere.workspace(), &sc.target(STAGING)).expect("alias") {
        eprintln!("skipping: directory alias creation is unavailable");
        return;
    }
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);

    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Blocked]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(PREIMAGE));
    assert!(!elsewhere.target("6a31.0").exists());
    assert_eq!(job_status(&store), JobStatus::Pending);
}

/// Capture must not record a path as deleted while its file sits staged with
/// no row. It counts as displaced until it goes back.
#[test]
fn a_rowless_staged_file_counts_as_displaced_until_it_goes_back() {
    let sc = Scratch::new("rowless-displaced");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
    assert!(matches!(
        drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
        [JobOutcome::Crashed(_)]
    ));
    assert!(!store.path_is_displaced("ws", "a.md").expect("rows"));
    assert!(path_is_displaced(&store, sc.workspace(), "ws", "a.md").expect("query"));

    recover_path_displacements(&store, sc.workspace(), "ws", "a.md", &sweep_options())
        .expect("return");
    assert_eq!(read(&sc, "a.md").as_deref(), Some(PREIMAGE));
    assert!(!path_is_displaced(&store, sc.workspace(), "ws", "a.md").expect("query"));
}

#[test]
fn unavailable_staging_does_not_stop_open_or_unrelated_creates() {
    let sc = Scratch::new("unavailable-staging");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    std::fs::write(sc.target(STAGING), b"unavailable directory").unwrap();
    recover_displacements(&store, sc.workspace(), None, &sweep_options()).unwrap();
    assert!(dohc_engine_files::workspace_recovery_unavailable(
        sc.workspace()
    ));
    assert!(drain(&store, &sc, &StdReplacer, &NoFaults).is_empty());
    stage_overwrite(&sc, &mut store);
    let create = spec(
        "j2",
        "unrelated.md",
        &hex_sha256(OURS),
        Preimage::Absent,
        1,
        11,
    );
    stage_job(&mut store, OURS, &create);
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Blocked, JobOutcome::Completed]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(PREIMAGE));
    assert_eq!(read(&sc, "unrelated.md").as_deref(), Some(OURS));
    assert_eq!(
        read(&sc, STAGING).as_deref(),
        Some(b"unavailable directory".as_slice())
    );
    std::fs::remove_file(sc.target(STAGING)).unwrap();
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert!(!dohc_engine_files::workspace_recovery_unavailable(
        sc.workspace()
    ));
}

#[test]
fn delete_refuses_a_directory_and_keeps_its_tree_at_the_target() {
    let sc = Scratch::new("delete-directory");
    let mut store = EngineStore::open(&sc.db(), 1).unwrap();
    stage_delete(&sc, &mut store);
    std::fs::remove_file(sc.target("a.md")).unwrap();
    std::fs::create_dir(sc.target("a.md")).unwrap();
    std::fs::write(sc.target("a.md/child"), OUTSIDE).unwrap();
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(read(&sc, "a.md/child").as_deref(), Some(OUTSIDE));
    assert_nothing_displaced(&sc, &store);
}

#[test]
fn startup_restores_a_newer_rowless_preimage_before_an_older_open_row() {
    for path_only in [false, true] {
        let sc = Scratch::new("newest-rowless-first");
        let mut store = EngineStore::open(&sc.db(), 1).unwrap();
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        put_staged(&sc, "6f6c64.0", OUTSIDE);
        store
            .open_displacement(&DisplacementSpec {
                job_id: "old".into(),
                workspace_id: "ws".into(),
                target_path: "a.md".into(),
                displaced_name: "6f6c64.0".into(),
                expected_sha256: hex_sha256(PREIMAGE),
                content_sha256: Some(hex_sha256(OURS)),
                now_ms: 1,
            })
            .unwrap();
        if path_only {
            recover_path_displacements(&store, sc.workspace(), "ws", "a.md", &sweep_options())
                .unwrap();
        } else {
            recover_displacements(&store, sc.workspace(), None, &sweep_options()).unwrap();
        }
        assert_eq!(read(&sc, "a.md").as_deref(), Some(PREIMAGE));
        assert_eq!(read(&sc, &staged("6f6c64.0")).as_deref(), Some(OUTSIDE));
    }
}

struct CrossVolumeStage {
    change: bool,
}
impl AtomicReplacer for CrossVolumeStage {
    fn displace(&self, target: &Path, _displaced: &Path) -> std::io::Result<()> {
        if self.change {
            std::fs::write(target, OUTSIDE)?;
        }
        Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices))
    }
}

#[test]
fn cross_volume_targets_use_checked_replace_and_delete() {
    for delete in [false, true] {
        for change in [false, true] {
            let sc = Scratch::new("cross-volume");
            let mut store = EngineStore::open(&sc.db(), 1).unwrap();
            if delete {
                stage_delete(&sc, &mut store);
            } else {
                stage_overwrite(&sc, &mut store);
            }
            assert_eq!(
                drain(&store, &sc, &CrossVolumeStage { change }, &NoFaults),
                vec![if change {
                    JobOutcome::Conflict
                } else {
                    JobOutcome::Completed
                }]
            );
            assert_eq!(
                read(&sc, "a.md").as_deref(),
                if change {
                    Some(OUTSIDE)
                } else if delete {
                    None
                } else {
                    Some(OURS)
                }
            );
            assert_nothing_displaced(&sc, &store);
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_staging_and_failed_return_preserve_attributes() {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let sc = Scratch::new("windows-attributes");
    let target = sc.target("hidden.md");
    let staged = sc.target("staged.md");
    let destination = sc.target("return.md");
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .attributes(0x2 | 0x20)
        .open(&target)
        .unwrap(); // hidden | archive
    drop(file);
    let mut permissions = std::fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&target, permissions).unwrap();
    let attrs = std::fs::metadata(&target).unwrap().file_attributes();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&target)
        .unwrap();
    assert!(StdReplacer.displace(&target, &staged).is_err());
    assert_eq!(std::fs::metadata(&target).unwrap().file_attributes(), attrs);
    drop(lock);
    StdReplacer.displace(&target, &staged).unwrap();
    assert_eq!(std::fs::metadata(&staged).unwrap().file_attributes(), attrs);
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&staged)
        .unwrap();
    assert!(StdReplacer.place(&staged, &destination).is_err());
    assert_eq!(std::fs::metadata(&staged).unwrap().file_attributes(), attrs);
    drop(lock);
    StdReplacer.place(&staged, &destination).unwrap();
    assert_eq!(
        std::fs::metadata(&destination).unwrap().file_attributes(),
        attrs
    );
    let mut permissions = std::fs::metadata(&destination).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&destination, permissions).unwrap();
}

#[cfg(windows)]
#[test]
fn unreadable_staging_retains_a_crash_copy_until_access_returns() {
    struct RestoreAccess(PathBuf);
    impl Drop for RestoreAccess {
        fn drop(&mut self) {
            let _ = std::process::Command::new("icacls")
                .arg(&self.0)
                .args(["/remove:d", "*S-1-1-0", "/q"])
                .output();
        }
    }
    let sc = Scratch::new("staging-denied");
    let mut store = EngineStore::open(&sc.db(), 1).unwrap();
    stage_overwrite(&sc, &mut store);
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
    assert!(matches!(
        drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
        [JobOutcome::Crashed(_)]
    ));
    let directory = sc.target(STAGING);
    let restore = RestoreAccess(directory.clone());
    let denied = std::process::Command::new("icacls")
        .arg(&directory)
        .args(["/deny", "*S-1-1-0:(RD)", "/q"])
        .output()
        .unwrap();
    assert!(denied.status.success(), "{denied:?}");
    assert_eq!(
        std::fs::read_dir(&directory).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    recover_displacements(&store, sc.workspace(), None, &sweep_options()).unwrap();
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Blocked]
    );
    assert!(dohc_engine_files::workspace_recovery_unavailable(
        sc.workspace()
    ));
    drop(restore);
    assert_eq!(read(&sc, &staged("6a31.0")).as_deref(), Some(PREIMAGE));
    assert!(!sc.target("a.md").exists());
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(OURS));
}
