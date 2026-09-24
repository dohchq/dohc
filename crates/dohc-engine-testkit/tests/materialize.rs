//! Crash-injection matrix for the durable materialization pipeline
//! (`dohc-engine-files::materialize`, `TEST_ORACLE.md` §3.3 points 12-16 and
//! §3.10 the bounded-retry contract). Each test drives the five-step pipeline,
//! injects a crash (or an external write / transient lock / superseding
//! generation), then proves the recovery contract by reopening the store and
//! replaying — durability is never trusted from the in-process outcome flag.

use dohc_engine_files::{
    AtomicReplacer, DurabilityPolicy, JobOutcome, MaterializeOptions, NoBackoff, ReplaceBackoff,
    StdReplacer, backoff_delay, materialize_secret_one, run_pending_jobs,
};
use dohc_engine_storage::{
    DisplacementState, EngineStore, FaultInjector, FaultPoint, JobStatus, MaterializationJobSpec,
    NoFaults, Preimage, StorageError, cancel_pending_jobs_for_path, enqueue_delete_job,
    enqueue_job, hex_sha256,
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
    assert!(store.list_open_displacements().expect("open").is_empty());
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

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<()> {
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
    // The displacement points only exist on an overwrite, so every point runs
    // against a target that holds the job's preimage.
    let points = [
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterTempWrite,
        FaultPoint::MaterializeAfterFlushBeforeRename,
        FaultPoint::MaterializeBeforePreimageRevalidate,
        FaultPoint::MaterializeAfterDisplacementJournal,
        FaultPoint::MaterializeAfterDisplaceBeforePlace,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ];
    for (i, point) in points.into_iter().enumerate() {
        let sc = Scratch::new(&format!("live-{i}"));
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        let content = format!("content-{i}");
        std::fs::write(sc.target("a.md"), PREIMAGE).expect("preimage");
        let job = spec(
            "j1",
            "a.md",
            &hex_sha256(content.as_bytes()),
            Preimage::Present(hex_sha256(PREIMAGE)),
            1,
            10,
        );
        stage_job(&mut store, content.as_bytes(), &job);

        let faults = ScriptedFaults::crash_at(point);
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

/// Stage an overwrite of `a.md`, whose disk bytes are the job's preimage.
fn stage_overwrite(sc: &Scratch, store: &mut EngineStore) {
    std::fs::write(sc.target("a.md"), PREIMAGE).expect("preimage on disk");
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

fn displaced_files(sc: &Scratch) -> Vec<String> {
    std::fs::read_dir(sc.workspace())
        .expect("workspace entries")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".displaced"))
        .collect()
}

fn job_status(store: &EngineStore) -> JobStatus {
    store
        .load_materialization_job("j1")
        .expect("load")
        .expect("job")
        .status
}

/// The bytes another program wrote after the check survive at the one kept
/// displaced file, with evidence naming them, and the job is complete.
fn assert_outside_change_kept(sc: &Scratch, store: &EngineStore, target_now: Option<&[u8]>) {
    assert_eq!(std::fs::read(sc.target("a.md")).ok().as_deref(), target_now);
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "one outside change: {kept:?}");
    assert_eq!(kept[0].target_path, "a.md");
    assert_eq!(kept[0].state, DisplacementState::Kept);
    assert_eq!(
        kept[0].displaced_sha256.as_deref(),
        Some(hex_sha256(OUTSIDE).as_str())
    );
    assert_eq!(
        std::fs::read(sc.target(&kept[0].displaced_name)).expect("kept file"),
        OUTSIDE
    );
    assert_eq!(displaced_files(sc), vec![kept[0].displaced_name.clone()]);
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert_eq!(job_status(store), JobStatus::Complete);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RenameStep {
    Displace,
    Place,
}

/// Lets another program act once, the moment before the named rename runs.
struct RaceBefore {
    step: RenameStep,
    race: Box<dyn Fn() + Send + Sync>,
    fired: AtomicBool,
}

impl RaceBefore {
    fn new(step: RenameStep, race: impl Fn() + Send + Sync + 'static) -> Self {
        RaceBefore {
            step,
            race: Box::new(race),
            fired: AtomicBool::new(false),
        }
    }

    fn arrive(&self, step: RenameStep) {
        if self.step == step && !self.fired.swap(true, Ordering::SeqCst) {
            (self.race)();
        }
    }
}

impl AtomicReplacer for RaceBefore {
    fn displace(&self, target: &Path, displaced: &Path) -> std::io::Result<()> {
        self.arrive(RenameStep::Displace);
        StdReplacer.displace(target, displaced)
    }

    fn place(&self, incoming: &Path, target: &Path) -> std::io::Result<()> {
        self.arrive(RenameStep::Place);
        StdReplacer.place(incoming, target)
    }
}

/// An editor that writes into the existing file.
fn write_in_place(path: PathBuf) -> impl Fn() + Send + Sync {
    move || std::fs::write(&path, OUTSIDE).expect("outside in-place write")
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
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OURS);
    assert!(displaced_files(&sc).is_empty(), "the preimage copy is gone");
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert!(
        store
            .list_kept_displacements("ws")
            .expect("kept")
            .is_empty()
    );
}

#[test]
fn a_write_in_place_between_check_and_swap_is_kept() {
    let sc = Scratch::new("race-in-place");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(RenameStep::Displace, write_in_place(sc.target("a.md")));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_outside_change_kept(&sc, &store, Some(OURS));
}

#[test]
fn a_rename_over_between_check_and_swap_is_kept() {
    let sc = Scratch::new("race-rename-over");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(RenameStep::Displace, rename_over(sc.target("a.md")));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_outside_change_kept(&sc, &store, Some(OURS));
}

#[test]
fn crash_after_displacement_journal_replays_to_completion() {
    let sc = Scratch::new("crash-after-journal");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplacementJournal);
        assert_eq!(
            drain(&store, &sc, &StdReplacer, faults.as_ref()),
            vec![JobOutcome::Crashed(
                FaultPoint::MaterializeAfterDisplacementJournal
            )]
        );
        assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), PREIMAGE);
        assert_eq!(store.list_open_displacements().expect("open").len(), 1);
        assert!(displaced_files(&sc).is_empty());
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OURS);
    assert!(displaced_files(&sc).is_empty());
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert!(
        store
            .list_kept_displacements("ws")
            .expect("kept")
            .is_empty()
    );
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
        assert_eq!(
            std::fs::read(sc.target(&displaced[0])).expect("displaced"),
            PREIMAGE
        );
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OURS);
    assert!(displaced_files(&sc).is_empty());
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert!(
        store
            .list_kept_displacements("ws")
            .expect("kept")
            .is_empty()
    );
}

#[test]
fn crash_between_displace_and_place_returns_an_outside_change_to_its_path() {
    let sc = Scratch::new("crash-mid-swap-outside");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(RenameStep::Displace, write_in_place(sc.target("a.md")));
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
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OUTSIDE);
    assert_eq!(
        std::fs::read(sc.target("a.md.j1.conflict")).expect("conflict"),
        OURS
    );
    assert!(displaced_files(&sc).is_empty());
    assert!(store.list_open_displacements().expect("open").is_empty());
}

#[test]
fn crash_after_the_swap_deletes_a_preimage_copy_on_replay() {
    let sc = Scratch::new("crash-after-swap");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
        assert!(matches!(
            drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OURS);
        assert_eq!(displaced_files(&sc).len(), 1);
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::AlreadyMaterialized]
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OURS);
    assert!(displaced_files(&sc).is_empty());
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert!(
        store
            .list_kept_displacements("ws")
            .expect("kept")
            .is_empty()
    );
}

#[test]
fn crash_after_the_swap_keeps_an_outside_change_on_replay() {
    let sc = Scratch::new("crash-after-swap-outside");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        stage_overwrite(&sc, &mut store);
        let racer = RaceBefore::new(RenameStep::Displace, rename_over(sc.target("a.md")));
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
        assert!(matches!(
            drain(&store, &sc, &racer, faults.as_ref())[..],
            [JobOutcome::Crashed(_)]
        ));
        assert!(
            store
                .list_kept_displacements("ws")
                .expect("kept")
                .is_empty()
        );
    }
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    assert_eq!(
        drain(&store, &sc, &StdReplacer, &NoFaults),
        vec![JobOutcome::AlreadyMaterialized]
    );
    assert_outside_change_kept(&sc, &store, Some(OURS));
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
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OUTSIDE);
    assert_eq!(
        std::fs::read(sc.target("a.md.j1.conflict")).expect("conflict"),
        OURS
    );
    assert!(displaced_files(&sc).is_empty());
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert_eq!(job_status(&store), JobStatus::Conflict);
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
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), PREIMAGE);
    assert!(displaced_files(&sc).is_empty());
    assert!(!sc.target(".dohc-write-j1.tmp").exists(), "temp removed");
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert_eq!(job_status(&store), JobStatus::Pending);
}

/// A program keeps the file open for writing across the swap. Its later
/// writes land in the displaced file, which is kept whatever it held when
/// inspected.
#[cfg(windows)]
#[test]
fn a_displaced_file_still_open_for_writing_is_kept() {
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
        vec![JobOutcome::Completed]
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OURS);
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].displaced_sha256, None, "not comparable while held");

    writer.write_all(b"LATE").expect("late write");
    drop(writer);
    let displaced = std::fs::read(sc.target(&kept[0].displaced_name)).expect("displaced");
    assert!(displaced.starts_with(b"LATE"), "the late write survives");
}

#[test]
fn an_absent_target_created_before_the_rename_is_not_replaced() {
    let sc = Scratch::new("race-create");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let job = spec("j1", "a.md", &hex_sha256(OURS), Preimage::Absent, 1, 10);
    stage_job(&mut store, OURS, &job);
    let racer = RaceBefore::new(RenameStep::Place, write_in_place(sc.target("a.md")));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OUTSIDE);
    assert_eq!(
        std::fs::read(sc.target("a.md.j1.conflict")).expect("conflict"),
        OURS
    );
}

#[test]
fn a_file_created_between_displace_and_place_is_not_replaced() {
    let sc = Scratch::new("race-recreate");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    stage_overwrite(&sc, &mut store);
    let racer = RaceBefore::new(RenameStep::Place, write_in_place(sc.target("a.md")));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Conflict]
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), OUTSIDE);
    assert_eq!(
        std::fs::read(sc.target("a.md.j1.conflict")).expect("conflict"),
        OURS
    );
    assert!(displaced_files(&sc).is_empty(), "the preimage copy is gone");
    assert!(store.list_open_displacements().expect("open").is_empty());
}

#[test]
fn a_write_racing_a_delete_is_kept() {
    let sc = Scratch::new("race-delete");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
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
    let racer = RaceBefore::new(RenameStep::Displace, write_in_place(sc.target("a.md")));

    assert_eq!(
        drain(&store, &sc, &racer, &NoFaults),
        vec![JobOutcome::Completed]
    );
    assert_outside_change_kept(&sc, &store, None);
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
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), PREIMAGE);
    assert!(displaced_files(&sc).is_empty());
    assert!(store.list_open_displacements().expect("open").is_empty());
    assert_eq!(job_status(&store), JobStatus::Cancelled);
}
