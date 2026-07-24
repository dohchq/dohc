//! Crash-injection matrix for the durable materialization pipeline
//! (`dohc-engine-files::materialize`, `TEST_ORACLE.md` §3.3 points 12-16 and
//! §3.10 the bounded-retry contract). Each test drives the five-step pipeline,
//! injects a crash (or an external write / transient lock / superseding
//! generation), then proves the recovery contract by REOPENING the store and
//! replaying — durability is never trusted from the in-process outcome flag.

use dohc_engine_files::{
    AtomicReplacer, DurabilityPolicy, JobOutcome, NoBackoff, ReplaceBackoff, StdReplacer,
    backoff_delay, materialize_secret_one, run_pending_jobs,
};
use dohc_engine_storage::{
    EngineStore, FaultPoint, JobStatus, MaterializationJobSpec, NoFaults, Preimage, StorageError,
    enqueue_delete_job, enqueue_job, hex_sha256,
};
use dohc_engine_testkit::ScriptedFaults;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

static SCRATCH_SEQ: AtomicU32 = AtomicU32::new(0);

struct Scratch {
    root: PathBuf,
}
impl Scratch {
    fn new(tag: &str) -> Self {
        let mut root = std::env::temp_dir();
        root.push(format!(
            "dohc-r04-mat-{tag}-{}-{}",
            std::process::id(),
            SCRATCH_SEQ.fetch_add(1, Ordering::AcqRel)
        ));
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
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &NoBackoff,
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
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            20,
            faults.as_ref(),
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        40,
        &NoFaults,
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        20,
        faults.as_ref(),
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
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
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterFlushBeforeRename);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &NoBackoff,
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
        &NoBackoff,
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
    let job = spec("j1", "a.md", &hex_sha256(content), Preimage::Absent, 1, 10);
    stage_job(&mut store, content, &job);

    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    let results = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        20,
        faults.as_ref(),
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        20,
        &NoFaults,
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        20,
        faults.as_ref(),
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
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        40,
        &NoFaults,
    )
    .expect("replay");
    assert_eq!(recovered[0].outcome, JobOutcome::AlreadyMaterialized);
    assert!(!sc.target("a.md").exists());
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
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &NoBackoff,
        20,
        faults.as_ref(),
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
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &NoBackoff,
        40,
        &NoFaults,
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
    // carrying an OLDER generation must not regress the path to older content.
    let sc = Scratch::new("superseded");
    let mut store = EngineStore::open(&sc.db(), 1).expect("open");
    let newer = b"generation-2-content";
    let older = b"generation-1-content";

    let g2 = spec("j-g2", "a.md", &hex_sha256(newer), Preimage::Absent, 2, 10);
    stage_job(&mut store, newer, &g2);
    let r = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        20,
        &NoFaults,
    )
    .expect("run g2");
    assert_eq!(r[0].outcome, JobOutcome::Completed);
    assert_eq!(std::fs::read(sc.target("a.md")).expect("read"), newer);

    let g1 = spec("j-g1", "a.md", &hex_sha256(older), Preimage::Absent, 1, 30);
    stage_job(&mut store, older, &g1);
    let r = run_pending_jobs(
        &store,
        sc.workspace(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        40,
        &NoFaults,
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
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected sharing violation",
            ));
        }
        std::fs::rename(from, to)
    }
}

struct NonTransientFailingReplacer;

impl AtomicReplacer for NonTransientFailingReplacer {
    fn try_replace(&self, _from: &Path, _to: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("injected non-transient failure"))
    }

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
    // MUTATION: propagate the secret replace error before temp cleanup -> a
    // `.dohc-write-*.tmp` sibling containing SECRET=plaintext survives.
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
        DurabilityPolicy::none(),
        &NonTransientFailingReplacer,
        &NoBackoff,
        20,
        &NoFaults,
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
        DurabilityPolicy::none(),
        &replacer,
        &backoff,
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
        DurabilityPolicy::none(),
        &replacer,
        &backoff,
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
    let points = [
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterTempWrite,
        FaultPoint::MaterializeAfterFlushBeforeRename,
        FaultPoint::MaterializeBeforePreimageRevalidate,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ];
    for (i, point) in points.into_iter().enumerate() {
        let sc = Scratch::new(&format!("live-{i}"));
        let mut store = EngineStore::open(&sc.db(), 1).expect("open");
        let content = format!("content-{i}");
        let job = spec(
            "j1",
            "a.md",
            &hex_sha256(content.as_bytes()),
            Preimage::Absent,
            1,
            10,
        );
        stage_job(&mut store, content.as_bytes(), &job);

        let faults = ScriptedFaults::crash_at(point);
        let results = run_pending_jobs(
            &store,
            sc.workspace(),
            DurabilityPolicy::none(),
            &StdReplacer,
            &NoBackoff,
            20,
            faults.as_ref(),
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
