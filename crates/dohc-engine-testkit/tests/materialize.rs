//! Crash-injection matrix for the durable materialization pipeline
//! (`dohc-engine-files::materialize`, `TEST_ORACLE.md` §3.3 points 12-16 and
//! §3.10 the bounded-retry contract). Each test drives the five-step pipeline,
//! injects a crash (or an external write / transient lock), then proves the
//! recovery contract by REOPENING the store and replaying — durability is never
//! trusted from the in-process outcome flag.

use dohc_engine_files::{
    AtomicReplacer, DurabilityPolicy, JobOutcome, StdReplacer, run_pending_jobs,
};
use dohc_engine_storage::{
    EngineStore, JobStatus, MaterializationJobSpec, NoFaults, Preimage, StorageError, enqueue_job,
    hex_sha256,
};
use dohc_engine_testkit::ScriptedFaults;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

struct Scratch {
    root: PathBuf,
}
static SCRATCH_SEQ: AtomicU32 = AtomicU32::new(0);

impl Scratch {
    fn new(tag: &str) -> Self {
        let mut root = std::env::temp_dir();
        // pid + monotonic sequence: unique even across parallel test threads
        // that start in the same nanosecond.
        root.push(format!(
            "dohc-r04-mat-{tag}-{}-{}",
            std::process::id(),
            SCRATCH_SEQ.fetch_add(1, Ordering::AcqRel)
        ));
        std::fs::create_dir_all(root.join(".dohc").join("engine")).expect("mkdir engine dir");
        Scratch { root }
    }
    /// The workspace root the pipeline materializes into.
    fn workspace(&self) -> &Path {
        &self.root
    }
    /// The engine.db path (under the excluded `.dohc/engine` floor).
    fn db(&self) -> PathBuf {
        self.root.join(".dohc").join("engine").join("engine.db")
    }
    fn target(&self, rel: &str) -> PathBuf {
        let mut p = self.root.clone();
        for seg in rel.split('/') {
            p.push(seg);
        }
        p
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn spec(id: &str, path: &str, sha: &str, preimage: Preimage, now: i64) -> MaterializationJobSpec {
    MaterializationJobSpec {
        job_id: id.to_owned(),
        target_path: path.to_owned(),
        content_sha256: sha.to_owned(),
        preimage,
        target_generation: 1,
        now_ms: now,
    }
}

/// Put a content blob and enqueue a job for it in one transaction (phase 1).
fn stage_job(store: &mut EngineStore, content: &[u8], job: &MaterializationJobSpec) -> String {
    let sha = store.put_binary_blob(content).expect("blob");
    assert_eq!(sha, job.content_sha256, "spec content sha must match blob");
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(tx, job)?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue");
    sha
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
        10,
    );
    stage_job(&mut store, content, &job);

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::per_os(),
        &StdReplacer,
        20,
        &NoFaults,
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
fn job_committed_but_pipeline_unrun_replays_after_restart() {
    // `materialize.after-job-commit` (point 12): the job row is durable but the
    // pipeline never ran (crash right after the phase-1 commit). A fresh restart
    // must replay it to completion.
    let sc = Scratch::new("after-job-commit");
    {
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        let content = b"deferred";
        let job = spec(
            "j1",
            "notes/a.md",
            &hex_sha256(content),
            Preimage::Absent,
            10,
        );
        stage_job(&mut store, content, &job);
        // Simulate death immediately after the job commit: drop without running
        // the pipeline.
        assert_eq!(store.pending_materialization_count().expect("pending"), 1);
        drop(store);
    }
    let store = EngineStore::open(&sc.db(), 20).expect("reopen");
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        30,
        &NoFaults,
    )
    .expect("replay");
    assert_eq!(results[0].outcome, JobOutcome::Completed);
    assert_eq!(
        std::fs::read(sc.target("notes/a.md")).expect("read"),
        b"deferred"
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn crash_after_temp_write_leaves_no_torn_target_and_replay_completes() {
    let sc = Scratch::new("after-temp");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"content-x";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 10);
    stage_job(&mut store, content, &job);

    let faults =
        ScriptedFaults::crash_at(dohc_engine_storage::FaultPoint::MaterializeAfterTempWrite);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        20,
        faults.as_ref(),
    )
    .expect("run");
    assert!(matches!(results[0].outcome, JobOutcome::Crashed(_)));
    // No torn target: the temp is NEVER the user file.
    assert!(
        !sc.target("a.md").exists(),
        "target must not exist after temp-only crash"
    );
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    // Restart: reopen and replay with no fault → completes exactly once.
    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        40,
        &NoFaults,
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
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(
        dohc_engine_storage::FaultPoint::MaterializeAfterFlushBeforeRename,
    );
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::per_os(),
        &StdReplacer,
        20,
        faults.as_ref(),
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
        DurabilityPolicy::none(),
        &StdReplacer,
        40,
        &NoFaults,
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
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(
        dohc_engine_storage::FaultPoint::MaterializeAfterRenameBeforeComplete,
    );
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        20,
        faults.as_ref(),
    )
    .expect("run");
    assert!(matches!(results[0].outcome, JobOutcome::Crashed(_)));
    // The file IS renamed (present with the content), but the job is not yet
    // marked complete.
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);

    // Restart replay: idempotent — the target already equals the desired
    // content, so no second write, marked complete (exactly-once).
    drop(store);
    let store = EngineStore::open(&sc.db(), 30).expect("reopen");
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        40,
        &NoFaults,
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

    // The job intends to write "new-intended" over content whose known preimage
    // hash is that of "old-known". But an external editor wrote "external-newer"
    // to the target after the DB commit.
    let intended = b"new-intended-content";
    let old_known = b"old-known-content";
    let external = b"external-newer-content";

    // Pre-create the target with the external content.
    std::fs::write(sc.target("a.md"), external).expect("pre-write external");

    let job = spec(
        "j1",
        "a.md",
        &hex_sha256(intended),
        Preimage::Present(hex_sha256(old_known)),
        10,
    );
    stage_job(&mut store, intended, &job);

    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        20,
        &NoFaults,
    )
    .expect("run");
    assert_eq!(results[0].outcome, JobOutcome::Conflict);

    // The external content is preserved untouched (NOT overwritten).
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), external);
    // Our intended content is preserved beside it (preserve-both), not lost.
    let conflict = sc.target("a.md.j1.conflict");
    assert_eq!(std::fs::read(&conflict).expect("read conflict"), intended);
    // The job is terminal-conflict, never silently replayed.
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
impl AtomicReplacer for FlakyReplacer {
    fn try_replace(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        self.attempts.fetch_add(1, Ordering::AcqRel);
        if self
            .remaining_failures
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_sub(1).or(Some(0))
            })
            .is_ok_and(|prev| prev > 0)
        {
            // A transient sharing violation (PermissionDenied is treated as
            // transient on every platform by the pipeline).
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected sharing violation",
            ));
        }
        std::fs::rename(from, to)
    }
}

#[test]
fn bounded_retry_succeeds_below_the_cap_with_exact_attempt_count() {
    let sc = Scratch::new("retry-ok");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"retryable";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 10);
    stage_job(&mut store, content, &job);

    // 2 transient failures (< 5) ⇒ success on attempt 3, exactly 3 traversals.
    let replacer = FlakyReplacer::new(2);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &replacer,
        20,
        &NoFaults,
    )
    .expect("run");
    assert_eq!(results[0].outcome, JobOutcome::Completed);
    assert_eq!(
        replacer.attempts.load(Ordering::Acquire),
        3,
        "n+1 = 3 attempts"
    );
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), content);
    assert_eq!(store.pending_materialization_count().expect("pending"), 0);
}

#[test]
fn bounded_retry_fails_closed_at_the_cap_and_leaves_job_pending() {
    let sc = Scratch::new("retry-exhaust");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let content = b"stuck";
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 10);
    stage_job(&mut store, content, &job);

    // 5 (>= cap) transient failures ⇒ fail closed after exactly 5 attempts.
    let replacer = FlakyReplacer::new(5);
    let err = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &replacer,
        20,
        &NoFaults,
    )
    .unwrap_err();
    assert_eq!(err.code(), "file-locked");
    assert_eq!(
        replacer.attempts.load(Ordering::Acquire),
        5,
        "exactly 5 attempts"
    );
    // Fail-closed: nothing on disk, job left pending for startup replay.
    assert!(!sc.target("a.md").exists());
    assert_eq!(store.pending_materialization_count().expect("pending"), 1);
}
