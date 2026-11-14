//! Crash-injection matrix for the durable materialization pipeline
//! (`dohc-engine-files::materialize`) and its bounded-retry contract. Each
//! test drives the five-step pipeline,
//! injects a crash (or an external write / transient lock / superseding
//! generation), then proves the recovery contract by reopening the store and
//! replaying — durability is never trusted from the in-process outcome flag.

use dohc_engine_files::{
    AtomicReplacer, DurabilityPolicy, JobOutcome, KeptCopySave, MaterializeOptions, NoBackoff,
    Placement, ReplaceBackoff, StdReplacer, materialize_one, materialize_secret_one,
    path_is_displaced, recover_displacements, recover_path_displacements, run_pending_jobs,
    save_kept_displacement, workspace_lacks_atomic_placement,
};
use dohc_engine_storage::{
    DisplacementSpec, DisplacementState, EngineStore, FaultInjector, FaultPoint, JobStatus,
    MaterializationJobSpec, NoFaults, Preimage, StorageError, enqueue_delete_job, enqueue_job,
    hex_sha256,
};
use dohc_engine_testkit::{ScriptedFaults, scratch::try_make_dir_alias};
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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
            holds: None,
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

/// Every remaining staged original has a retained row; no unknown copy remains.
fn assert_nothing_displaced(sc: &Scratch, store: &EngineStore) {
    let mut expected: Vec<String> = Vec::new();
    #[cfg(unix)]
    for row in store.retained_displacements_after(0).expect("retained") {
        assert!(sc.workspace().join(&row.source_path).exists());
        assert!(
            store.holds_content(&row.digest).unwrap(),
            "known baseline is recoverable"
        );
        expected.push(staged(row.source_path.rsplit('/').next().unwrap()));
    }
    expected.sort();
    let mut actual = displaced_files(sc);
    actual.sort();
    assert_eq!(actual, expected);
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

/// A kept file becomes a visible copy beside its path when asked, taking the
/// next free name, and its row ends so nothing lists it again.
#[test]
fn a_kept_file_is_saved_as_a_visible_copy() {
    let sc = Scratch::new("kept-copy");
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
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1, "{kept:?}");
    std::fs::write(sc.target("a (kept copy).md"), b"taken").expect("occupy the first name");
    let options = MaterializeOptions {
        holds: None,
        policy: DurabilityPolicy::none(),
        replacer: &StdReplacer,
        backoff: &NoBackoff,
        now_ms: 30,
        faults: &NoFaults,
    };

    assert_eq!(
        save_kept_displacement(
            &store,
            sc.workspace(),
            "other-ws",
            kept[0].displacement_id,
            &options
        )
        .expect("another workspace"),
        KeptCopySave::Gone,
        "a row belongs to its own workspace"
    );
    let saved = save_kept_displacement(
        &store,
        sc.workspace(),
        "ws",
        kept[0].displacement_id,
        &options,
    )
    .expect("save");

    assert_eq!(saved, KeptCopySave::Saved("a (kept copy 2).md".to_owned()));
    assert_eq!(read(&sc, "a (kept copy 2).md").as_deref(), Some(OUTSIDE));
    assert_eq!(
        read(&sc, "a (kept copy).md").as_deref(),
        Some(&b"taken"[..])
    );
    assert_eq!(read(&sc, "a.md").as_deref(), Some(CREATED));
    assert!(
        displaced_files(&sc).is_empty(),
        "{:?}",
        displaced_files(&sc)
    );
    assert!(
        store
            .list_kept_displacements("ws")
            .expect("kept")
            .is_empty()
    );
    assert_eq!(
        save_kept_displacement(
            &store,
            sc.workspace(),
            "ws",
            kept[0].displacement_id,
            &options
        )
        .expect("again"),
        KeptCopySave::Gone
    );
}

fn kept_copy_options() -> MaterializeOptions<'static> {
    MaterializeOptions {
        holds: None,
        policy: DurabilityPolicy::none(),
        replacer: &StdReplacer,
        backoff: &NoBackoff,
        now_ms: 30,
        faults: &NoFaults,
    }
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
fn selected_replay_recovers_listed_staged_files_with_or_without_rows() {
    for has_row in [false, true] {
        let sc = Scratch::new("selected-listed-copy");
        let mut store = EngineStore::open(&sc.db(), 1).unwrap();
        stage_overwrite(&sc, &mut store);
        put_staged(&sc, "6a31.63", OUTSIDE);
        put_staged(&sc, "6f74686572.0", CREATED);
        std::fs::write(sc.target("a.md"), OURS).unwrap();
        if has_row {
            store
                .open_displacement(&DisplacementSpec {
                    job_id: "j1".into(),
                    workspace_id: "ws".into(),
                    target_path: "a.md".into(),
                    displaced_name: "6a31.63".into(),
                    expected_sha256: hex_sha256(PREIMAGE),
                    content_sha256: Some(hex_sha256(OURS)),
                    now_ms: 5,
                })
                .unwrap();
        }
        let job = store.load_materialization_job("j1").unwrap().unwrap();
        materialize_one(&store, sc.workspace(), &job, &sweep_options()).unwrap();
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE));
        assert_eq!(read(&sc, &staged("6f74686572.0")).as_deref(), Some(CREATED));
        assert!(!sc.target(&staged("6a31.63")).exists());
    }
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
            holds: None,
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
            holds: None,
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
                holds: None,
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
            holds: None,
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

fn sweep_options() -> MaterializeOptions<'static> {
    MaterializeOptions {
        holds: None,
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
fn newest_staged_copy_returns_first_after_a_crash_during_adoption() {
    for recovery in ["workspace", "path", "job"] {
        let sc = Scratch::new("adoption-order-crash");
        {
            let mut store = EngineStore::open(&sc.db(), 1).unwrap();
            stage_overwrite(&sc, &mut store);
            let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplaceBeforePlace);
            assert!(matches!(
                drain(&store, &sc, &StdReplacer, faults.as_ref())[..],
                [JobOutcome::Crashed(_)]
            ));
            put_staged(&sc, "6a31.1", OUTSIDE);
            let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterDisplacementJournal);
            let options = MaterializeOptions {
                holds: None,
                faults: faults.as_ref(),
                ..sweep_options()
            };
            assert!(recover_displacements(&store, sc.workspace(), None, &options).is_err());
            let rows = store.list_unsettled_displacements().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].displaced_name, "6a31.1");
            assert!(read(&sc, "a.md").is_none());
            assert_eq!(read(&sc, &staged("6a31.0")).as_deref(), Some(PREIMAGE));
        }
        let store = EngineStore::open(&sc.db(), 50).unwrap();
        match recovery {
            "workspace" => {
                recover_displacements(&store, sc.workspace(), None, &sweep_options()).unwrap()
            }
            "path" => {
                recover_path_displacements(&store, sc.workspace(), "ws", "a.md", &sweep_options())
                    .unwrap()
            }
            _ => {
                drain(&store, &sc, &StdReplacer, &NoFaults);
            }
        }
        assert_eq!(read(&sc, "a.md").as_deref(), Some(OUTSIDE), "{recovery}");
        assert_nothing_displaced(&sc, &store);
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

#[test]
fn an_adopted_orphan_stays_available_in_the_recovery_folder() {
    let sc = Scratch::new("orphan-kept-save");
    let store = EngineStore::open(&sc.db(), 1).expect("open");
    put_staged(&sc, "6a6f62.0", OUTSIDE);
    recover_displacements(&store, sc.workspace(), Some("ws"), &kept_copy_options()).expect("adopt");
    let kept = store.list_kept_displacements("ws").expect("kept");
    assert_eq!(kept.len(), 1);
    assert!(kept[0].target_path.is_empty());
    assert_eq!(
        save_kept_displacement(
            &store,
            sc.workspace(),
            "ws",
            kept[0].displacement_id,
            &kept_copy_options()
        )
        .expect("save"),
        KeptCopySave::NoValidName
    );
    assert_eq!(read(&sc, &staged("6a6f62.0")).as_deref(), Some(OUTSIDE));
    assert_eq!(store.list_kept_displacements("ws").expect("kept").len(), 1);
}
