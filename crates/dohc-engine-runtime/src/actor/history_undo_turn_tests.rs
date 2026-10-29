use super::super::tests::{OP, WS, fixture, remove, rename, seed};
use super::*;
use crate::actor::{CapturePassSettlement, CapturePlacementPath, WorkspaceRootGuard};
use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
use dohc_engine_testkit::engine_db_path;
use std::sync::{
    Barrier, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Default, serde::Serialize)]
struct StoreWork {
    reads: usize,
    writes: usize,
    rows: usize,
    checkpoint_rows: usize,
    inverses: usize,
    commits: usize,
    sources: usize,
}
thread_local! {
    static STORE_WORK: std::cell::Cell<StoreWork> = const { std::cell::Cell::new(StoreWork {
        reads: 0, writes: 0, rows: 0, checkpoint_rows: 0, inverses: 0, commits: 0, sources: 0,
    }) };
}
const INVERSE_PROBE: &str = "CREATE TEMP TRIGGER undo_proof_inverse AFTER INSERT ON moments WHEN NEW.metadata_origin='restore' BEGIN SELECT 'undo-proof-inverse'; END;";
fn trace_store_work(event: rusqlite::trace::TraceEvent<'_>) {
    STORE_WORK.with(|cell| {
        let mut work = cell.get();
        match event {
            rusqlite::trace::TraceEvent::Stmt(_, sql) => {
                let sql = sql.trim().to_ascii_uppercase();
                if sql.starts_with("-- SELECT 'UNDO-PROOF-INVERSE'") {
                    work.inverses += 1;
                }
                let sql = sql.strip_prefix("-- ").unwrap_or(&sql);
                if sql.starts_with("SELECT") || sql.starts_with("WITH") {
                    work.reads += 1;
                } else if sql.starts_with("INSERT")
                    || sql.starts_with("UPDATE")
                    || sql.starts_with("DELETE")
                    || sql.starts_with("REPLACE")
                {
                    work.writes += 1;
                } else if sql == "COMMIT" {
                    work.commits += 1;
                }
            }
            rusqlite::trace::TraceEvent::Row(stmt) => {
                let sql = stmt.sql();
                let sql = sql.trim_start();
                // Write admission and capture-phase WAL sampling are storage
                // bookkeeping, not rows read by the phase's own statements.
                if ["PRAGMA main.wal_checkpoint(", "PRAGMA busy_timeout"]
                    .iter()
                    .any(|prefix| {
                        sql.get(..prefix.len())
                            .is_some_and(|sql| sql.eq_ignore_ascii_case(prefix))
                    })
                {
                    work.checkpoint_rows += 1;
                } else {
                    work.rows += 1;
                }
            }
            _ => {}
        }
        cell.set(work);
    });
}
#[test]
fn store_work_probe_counts_each_inverse_row_in_one_statement() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE moments(metadata_origin TEXT);")
        .unwrap();
    conn.execute_batch(INVERSE_PROBE).unwrap();
    STORE_WORK.with(|cell| cell.set(StoreWork::default()));
    conn.trace_v2(
        rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
        Some(trace_store_work),
    );
    conn.execute_batch("INSERT INTO moments VALUES('restore'),('restore'),('api');")
        .unwrap();
    let work = STORE_WORK.with(std::cell::Cell::get);
    assert_eq!(work.inverses, 2, "count rows, not inverse statements");
    assert!(work.reads >= 2 && work.writes >= 1);

    STORE_WORK.with(|cell| cell.set(StoreWork::default()));
    conn.trace_v2(
        rusqlite::trace::TraceEventCodes::SQLITE_TRACE_ROW,
        Some(trace_store_work),
    );
    for sql in [
        "PRAGMA main.wal_checkpoint(NOOP)",
        "PRAGMA main.wal_checkpoint(PASSIVE)",
        "PRAGMA main.wal_checkpoint(RESTART)",
        "PRAGMA busy_timeout",
        "PRAGMA data_version",
    ] {
        conn.query_row(sql, [], |_| Ok(())).unwrap();
    }
    let mut stmt = conn.prepare("SELECT 1 UNION ALL SELECT 2").unwrap();
    let mut rows = stmt.query([]).unwrap();
    while rows.next().unwrap().is_some() {}
    let work = STORE_WORK.with(std::cell::Cell::get);
    assert_eq!(work.rows, 3, "keep phase SELECT and data_version rows");
    assert_eq!(work.checkpoint_rows, 4, "separate checkpoint bookkeeping");
}
pub(in crate::actor) fn source() {
    STORE_WORK.with(|cell| {
        let mut work = cell.get();
        work.sources += 1;
        cell.set(work);
    });
}
pub(in crate::actor) fn sources_in_turn() -> usize {
    STORE_WORK.with(|cell| cell.get().sources)
}
// Start on the actor, so queued Y.Doc work cannot enter this turn's counters.
pub(in crate::actor) fn begin_turn(request: &str) {
    STORE_WORK.with(|cell| cell.set(StoreWork::default()));
    probes()
        .lock()
        .unwrap()
        .entry(request.into())
        .or_default()
        .actor_totals = Some(dohc_engine_storage::capture_phase::snapshot());
}

type Hook = (std::sync::mpsc::Sender<()>, Arc<Barrier>);
#[derive(Default)]
struct Probe {
    times: Vec<Duration>,
    turn_budget: Option<Duration>,
    phases: Vec<Phase>,
    actor_totals: Option<dohc_engine_storage::capture_phase::Snapshot>,
    hook: Option<Hook>,
    notify: Option<Arc<tokio::sync::Notify>>,
    checkpoint: Option<[Arc<tokio::sync::Notify>; 2]>,
}
fn probes() -> &'static Mutex<std::collections::HashMap<String, Probe>> {
    static PROBES: OnceLock<Mutex<std::collections::HashMap<String, Probe>>> = OnceLock::new();
    PROBES.get_or_init(Mutex::default)
}
// Override only the elapsed-time cutoff; the production 16-member cap still applies.
pub(in crate::actor) fn set_turn_budget(request: &str, budget: Duration) {
    probes()
        .lock()
        .unwrap()
        .entry(request.into())
        .or_default()
        .turn_budget = Some(budget);
}
pub(super) fn turn_budget(request: &str) -> Option<Duration> {
    probes()
        .lock()
        .unwrap()
        .get(request)
        .and_then(|p| p.turn_budget)
}
#[derive(Clone, serde::Serialize)]
struct Phase {
    phase: String,
    member: Option<usize>,
    elapsed_ns: u128,
    actor: bool,
    check_ns: Option<u128>,
    storage: Option<serde_json::Value>,
    store_work: Option<StoreWork>,
}
pub(in crate::actor) fn record_phase(
    request: &str,
    phase: &str,
    member: Option<usize>,
    elapsed: Duration,
    actor: bool,
) {
    let current = actor.then(dohc_engine_storage::capture_phase::snapshot);
    let mut probes = probes().lock().unwrap();
    let probe = probes.entry(request.to_owned()).or_default();
    // begin_turn fences these counters around only this Undo actor turn.
    let storage = current.and_then(|after| {
        probe
            .actor_totals
            .replace(after.clone())
            .map(|before| after.delta(&before))
    });
    probe.phases.push(Phase {
        phase: phase.into(),
        member,
        elapsed_ns: elapsed.as_nanos(),
        actor,
        check_ns: None,
        storage,
        store_work: actor.then(|| STORE_WORK.with(std::cell::Cell::get)),
    });
}
pub(super) struct TurnProbe {
    request: String,
    phase: &'static str,
    member: Option<usize>,
    started: Instant,
}
impl TurnProbe {
    pub(super) fn new(request: &str, phase: &'static str, member: Option<usize>) -> Self {
        begin_turn(request);
        Self {
            request: request.into(),
            phase,
            member,
            started: Instant::now(),
        }
    }
    pub(super) fn finish(self) {
        let elapsed = self.started.elapsed();
        record_phase(&self.request, self.phase, self.member, elapsed, true);
        let (hook, notify) = {
            let mut probes = probes().lock().unwrap();
            let probe = probes.get_mut(&self.request).unwrap();
            probe.times.push(elapsed);
            if self.phase.contains("inverse") {
                (probe.hook.take(), probe.notify.take())
            } else {
                (None, None)
            }
        };
        if let Some(notify) = notify {
            notify.notify_one();
        }
        if let Some((sender, barrier)) = hook {
            let _ = sender.send(());
            barrier.wait();
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub(in crate::actor) struct UpdateWait {
    pub(in crate::actor) wait_ns: u128,
    pub(in crate::actor) total_wait_ns: u128,
    pub(in crate::actor) turn_gap: usize,
    pub(in crate::actor) max_turn_gap: usize,
    pub(in crate::actor) retries: usize,
}

pub(in crate::actor) async fn retry_ydoc_update<T, F>(
    serial: &tokio::sync::Mutex<()>,
    turn_count: impl Fn() -> usize,
    mut operation: impl FnMut() -> F,
) -> (T, UpdateWait, tokio::sync::MutexGuard<'_, ()>)
where
    F: std::future::Future<Output = Result<T, RuntimeError>>,
{
    let total_start = Instant::now();
    let policy: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/workspace-engine-client/src/daemon/storeBusyRetry.json"
    ))
    .unwrap();
    let deadline =
        total_start + Duration::from_millis(policy["engineStoreBusyRetryMs"].as_u64().unwrap());
    let mut backoff = Duration::from_millis(5);
    let mut retries = 0;
    let mut max_turn_gap = 0;
    loop {
        let start = Instant::now();
        let before = turn_count();
        let admission = serial.lock().await;
        let result = operation().await;
        let wait_ns = start.elapsed().as_nanos();
        let turn_gap = turn_count() - before;
        max_turn_gap = max_turn_gap.max(turn_gap);
        match result {
            Ok(value) => {
                let timing = UpdateWait {
                    wait_ns,
                    total_wait_ns: total_start.elapsed().as_nanos(),
                    turn_gap,
                    max_turn_gap,
                    retries,
                };
                if retries > 0 {
                    eprintln!("YDOC update retry evidence: {timing:?}");
                }
                // Keep admission until the caller records the commit position.
                return (value, timing, admission);
            }
            Err(RuntimeError::Storage(StorageError::FileLocked))
            | Err(RuntimeError::Collab(dohc_engine_collab::CollabError::Storage(
                StorageError::FileLocked,
            ))) => {
                drop(admission);
                retries += 1;
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "Y.Doc update stayed FileLocked until the client busy deadline; retries={retries}"
                );
                tokio::time::sleep(backoff.min(remaining)).await;
                backoff = (backoff * 2).min(Duration::from_millis(200));
            }
            Err(error) => panic!("Y.Doc update failed: {error:?}"),
        }
    }
}

type DiskObserver = Arc<dyn Fn() + Send + Sync>;
fn disk_observers() -> &'static Mutex<std::collections::HashMap<PathBuf, DiskObserver>> {
    static OBSERVERS: OnceLock<Mutex<std::collections::HashMap<PathBuf, DiskObserver>>> =
        OnceLock::new();
    OBSERVERS.get_or_init(Mutex::default)
}
pub(in crate::actor) fn set_disk_observer(root: PathBuf, observer: Option<DiskObserver>) {
    let mut observers = disk_observers().lock().unwrap();
    if let Some(observer) = observer {
        observers.insert(root, observer);
    } else {
        observers.remove(&root);
    }
}
pub(super) fn observe_disk_probe(root: &Path) {
    let observer = disk_observers().lock().unwrap().get(root).cloned();
    if let Some(observer) = observer {
        observer();
    }
}
struct CrashAfter(AtomicUsize);
impl FaultInjector for CrashAfter {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::StorageAfterCommitBeforeAck
            && self.0.fetch_sub(1, Ordering::SeqCst) == 1
        {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
fn setup(
    count: usize,
) -> (
    dohc_engine_testkit::ScratchDir,
    crate::WorkspaceSupervisor,
    ActorHandle,
) {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "old.md", "mover", "move body");
    rename(&mut store, root.path(), "old.md", "new.md", "rename", OP);
    for index in 1..count {
        let path = format!("file-{index:04}.md");
        seed(
            &mut store,
            root.path(),
            &path,
            &format!("object-{index}"),
            "retained body",
        );
        remove(&mut store, root.path(), &path, &format!("delete-{index}"));
    }
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 4)
        .unwrap()
        .actor;
    (root, supervisor, actor)
}
async fn close(supervisor: crate::WorkspaceSupervisor) {
    tokio::task::spawn_blocking(move || supervisor.close_all())
        .await
        .unwrap()
        .unwrap();
}
async fn run(
    actor: &ActorHandle,
    root: &Path,
    request: &str,
    faults: Arc<dyn FaultInjector>,
) -> Result<HistoryUndoResult, RuntimeError> {
    actor
        .history_undo_in_turns(
            WS.into(),
            OP.into(),
            request.into(),
            None,
            root.to_path_buf(),
            faults,
            10,
            [Arc::default(), Arc::default()],
            Arc::new(()),
            None,
            crate::CancellationToken::new(),
        )
        .await
}

async fn placement_waits_for_writer(member_count: usize, close_actor: bool) {
    let (root, supervisor, actor) = setup(member_count);
    let hold = actor.hold_link_drain();
    let request = if close_actor {
        "placement-close"
    } else {
        "placement-retry"
    };
    let undo = run(&actor, &root, request, Arc::new(NoFaults))
        .await
        .unwrap();
    let count = undo.moments.len();
    let [entered, release] = pause_checkpoint(&undo.compensation_operation_id);
    let writer = rusqlite::Connection::open(engine_db_path(&root).unwrap()).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let placed_count = Arc::new(AtomicUsize::new(0));
    let observed_count = Arc::clone(&placed_count);
    let task_actor = actor.clone();
    let path = root.to_path_buf();
    let placement = tokio::spawn(async move {
        task_actor
            .history_undo_place(WS.into(), undo, path, Arc::new(()), 11, |members| {
                observed_count.fetch_add(members.len(), Ordering::SeqCst);
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .unwrap();
    assert!(
        !placement.is_finished(),
        "busy placement must remain scheduled"
    );
    assert_eq!(
        placed_count.load(Ordering::SeqCst),
        0,
        "keep leases until placement succeeds"
    );
    assert_eq!(
        actor.active_version_id(WS.into()).await.unwrap(),
        "main",
        "backoff must release the actor"
    );
    if close_actor {
        close(supervisor).await;
        writer.execute_batch("ROLLBACK").unwrap();
        release.notify_one();
        let result = tokio::time::timeout(Duration::from_secs(10), placement)
            .await
            .unwrap()
            .unwrap();
        assert!(!result.materialized);
        assert_eq!(placed_count.load(Ordering::SeqCst), 0);
    } else {
        writer.execute_batch("ROLLBACK").unwrap();
        release.notify_one();
        let result = tokio::time::timeout(Duration::from_secs(10), placement)
            .await
            .unwrap()
            .unwrap();
        assert!(result.materialized);
        assert_eq!(
            placed_count.load(Ordering::SeqCst),
            count,
            "notify each member exactly once"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("old.md")).unwrap(),
            "move body"
        );
        assert!(!root.join("new.md").exists());
        for index in 1..member_count {
            assert_eq!(
                std::fs::read_to_string(root.join(format!("file-{index:04}.md"))).unwrap(),
                "retained body"
            );
        }
        close(supervisor).await;
    }
    drop(hold);
}

#[tokio::test(flavor = "multi_thread")]
async fn history_undo_placement_retries_file_locked_outside_the_actor() {
    placement_waits_for_writer(2, false).await;
    placement_waits_for_writer(10, false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn history_undo_placement_stops_retrying_when_the_actor_closes() {
    placement_waits_for_writer(10, true).await;
}

type MaterializationFault = Arc<
    dyn Fn(&dohc_engine_storage::MaterializationJob) -> Option<dohc_engine_files::MaterializeError>
        + Send
        + Sync,
>;
fn materialization_faults()
-> &'static Mutex<std::collections::HashMap<PathBuf, MaterializationFault>> {
    static FAULTS: OnceLock<Mutex<std::collections::HashMap<PathBuf, MaterializationFault>>> =
        OnceLock::new();
    FAULTS.get_or_init(Mutex::default)
}
pub(in crate::actor) fn materialization_error(
    root: &Path,
    job: &dohc_engine_storage::MaterializationJob,
) -> Option<dohc_engine_files::MaterializeError> {
    let fault = materialization_faults().lock().unwrap().get(root).cloned();
    fault.and_then(|fault| fault(job))
}
struct PlacementFault(PathBuf);
impl PlacementFault {
    fn install(root: &Path, path: &'static str, store_busy: bool) -> (Self, Arc<AtomicUsize>) {
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        materialization_faults().lock().unwrap().insert(
            root.to_path_buf(),
            Arc::new(move |job| {
                (job.target_path == path).then(|| {
                    observed.fetch_add(1, Ordering::SeqCst);
                    if store_busy {
                        dohc_engine_files::MaterializeError::Storage(StorageError::FileLocked)
                    } else {
                        dohc_engine_files::MaterializeError::FileLocked
                    }
                })
            }),
        );
        (Self(root.to_path_buf()), attempts)
    }
}
impl Drop for PlacementFault {
    fn drop(&mut self) {
        materialization_faults().lock().unwrap().remove(&self.0);
    }
}

async fn placement_with_busy_job(clears: bool) {
    let (root, supervisor, actor) = setup(2);
    let hold = actor.hold_link_drain();
    let request = if clears {
        "placement-busy-job-clears"
    } else {
        "placement-busy-job-deadline"
    };
    let undo = run(&actor, &root, request, Arc::new(NoFaults))
        .await
        .unwrap();
    let [entered, release] = pause_checkpoint(&undo.compensation_operation_id);
    let (fault, attempts) = PlacementFault::install(&root, "file-0001.md", true);
    let task_actor = actor.clone();
    let path = root.to_path_buf();
    let start = Instant::now();
    let mut placement = tokio::spawn(async move {
        task_actor
            .history_undo_place(WS.into(), undo, path, Arc::new(()), 11, |_| {})
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert!(!placement.is_finished());
    let mut fault = Some(fault);
    if clears {
        drop(fault.take());
    }
    release.notify_one();
    let outcome = tokio::time::timeout(Duration::from_secs(15), &mut placement).await;
    if outcome.is_err() {
        placement.abort();
    }
    let placed = outcome
        .expect("placement must stop at the busy deadline")
        .unwrap();
    assert_eq!(placed.materialized, clears);
    let pending = actor
        .history_operation_pending_jobs(WS.into(), OP.into())
        .await
        .unwrap();
    if clears {
        assert!(pending.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("file-0001.md")).unwrap(),
            "retained body"
        );
    } else {
        assert!(start.elapsed() >= Duration::from_secs(10));
        assert!(attempts.load(Ordering::SeqCst) > 1);
        assert!(
            !pending.is_empty(),
            "keep durable jobs after the retry deadline"
        );
        assert!(!root.join("file-0001.md").exists());
        drop(fault.take());
        let replayed = actor
            .history_undo_place(
                WS.into(),
                placed,
                root.to_path_buf(),
                Arc::new(()),
                12,
                |_| {},
            )
            .await;
        assert!(replayed.materialized, "pending jobs must remain replayable");
    }
    close(supervisor).await;
    drop(hold);
}

#[tokio::test(flavor = "multi_thread")]
async fn history_undo_placement_completes_when_a_busy_store_job_clears() {
    placement_with_busy_job(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn history_undo_placement_deadline_keeps_busy_store_jobs_pending() {
    placement_with_busy_job(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn history_undo_placement_parks_a_held_workspace_file_without_retrying() {
    let (root, supervisor, actor) = setup(2);
    let hold = actor.hold_link_drain();
    let undo = run(&actor, &root, "placement-held-file", Arc::new(NoFaults))
        .await
        .unwrap();
    let (fault, attempts) = PlacementFault::install(&root, "file-0001.md", false);
    let placed = actor
        .history_undo_place(
            WS.into(),
            undo,
            root.to_path_buf(),
            Arc::new(()),
            11,
            |_| {},
        )
        .await;
    assert!(!placed.materialized);
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        1,
        "a held workspace file must park without a busy-store loop"
    );
    assert!(
        !actor
            .history_operation_pending_jobs(WS.into(), OP.into())
            .await
            .unwrap()
            .is_empty()
    );
    drop(fault);
    assert!(
        actor
            .history_undo_place(
                WS.into(),
                placed,
                root.to_path_buf(),
                Arc::new(()),
                12,
                |_| {}
            )
            .await
            .materialized
    );
    close(supervisor).await;
    drop(hold);
}

#[tokio::test(flavor = "multi_thread")]
async fn history_undo_rename_succeeds_with_a_held_workspace_file() {
    let (root, supervisor, actor) = setup(2);
    let hold = actor.hold_link_drain();
    let (fault, attempts) = PlacementFault::install(&root, "old.md", false);
    let undo = run(&actor, &root, "rename-held-file", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        undo.moments.len(),
        2,
        "finish every compensation despite parked rename placement"
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert!(!root.join("old.md").exists());
    assert!(
        !actor
            .history_operation_pending_jobs(WS.into(), OP.into())
            .await
            .unwrap()
            .is_empty()
    );
    drop(fault);
    assert!(
        actor
            .history_undo_place(
                WS.into(),
                undo,
                root.to_path_buf(),
                Arc::new(()),
                12,
                |_| {}
            )
            .await
            .materialized
    );
    assert_eq!(
        std::fs::read_to_string(root.join("old.md")).unwrap(),
        "move body"
    );
    close(supervisor).await;
    drop(hold);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_every_member_before_any_compensation() {
    let (root, supervisor, actor) = setup(3);
    std::fs::write(root.join("file-0001.md"), "occupied").unwrap();
    assert!(matches!(
        run(&actor, &root, "turn-refusal", Arc::new(NoFaults)).await,
        Err(RuntimeError::Domain(DomainError::UndoRefused { .. }))
    ));
    let moments = actor
        .run(|store, _| {
            store.read_with(|conn| {
                Ok::<_, RuntimeError>(undo_compensation_moments_in(
                    conn,
                    WS,
                    "main",
                    OP,
                    "turn-refusal",
                )?)
            })
        })
        .await
        .unwrap();
    assert!(moments.is_empty());
    assert!(root.join("new.md").exists());
    assert!(
        actor
            .pending_history_undos(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    close(supervisor).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn crash_resumes_the_remaining_members_and_replay_writes_nothing() {
    let (root, supervisor, actor) = setup(6);
    // One member per turn, so a fast host cannot finish the plan before the crash.
    set_turn_budget("turn-crash", Duration::ZERO);
    assert!(matches!(
        run(
            &actor,
            &root,
            "turn-crash",
            Arc::new(CrashAfter(AtomicUsize::new(3)))
        )
        .await,
        Err(RuntimeError::OperationCrashed)
    ));
    assert_eq!(
        actor.pending_history_undos(WS.into()).await.unwrap().len(),
        1
    );
    let first = actor
        .run(|store, _| {
            store.read_with(|conn| {
                Ok::<_, RuntimeError>(undo_compensation_moments_in(
                    conn,
                    WS,
                    "main",
                    OP,
                    "turn-crash",
                )?)
            })
        })
        .await
        .unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first.last().unwrap().operation, "rename");
    assert!(
        actor
            .preflight_history_undo(WS.into(), OP.into(), "turn-crash".into(), None)
            .await
            .unwrap()
            .is_none()
    );
    close(supervisor).await;
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 20)
        .unwrap()
        .actor;
    let result = run(&actor, &root, "turn-crash", Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(!result.deduped, "resuming committed new inverses");
    assert_eq!(result.moments.len(), 6);
    assert!(result.not_restored.is_empty());
    let replay = run(&actor, &root, "turn-crash", Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(replay.deduped);
    assert_eq!(replay.moments, result.moments);
    assert!(
        actor
            .pending_history_undos(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        actor
            .history_undo_in_turns(
                WS.into(),
                OP.into(),
                "turn-crash".into(),
                Some(r#"[{"humanId":"other"}]"#.into()),
                root.to_path_buf(),
                Arc::new(NoFaults),
                30,
                [Arc::default(), Arc::default()],
                Arc::new(()),
                None,
                crate::CancellationToken::new(),
            )
            .await,
        Err(RuntimeError::Domain(
            DomainError::IdempotencyKeyReuseMismatch
        ))
    ));
    close(supervisor).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn a_member_changed_after_check_is_not_restored() {
    let (root, supervisor, actor) = setup(20);
    let (send, receive) = std::sync::mpsc::channel();
    let barrier = Arc::new(Barrier::new(2));
    probes()
        .lock()
        .unwrap()
        .entry("turn-changed".into())
        .or_default()
        .hook = Some((send, barrier.clone()));
    let path = root.join("file-0001.md");
    let edit = tokio::task::spawn_blocking(move || {
        receive.recv().unwrap();
        std::fs::write(path, "new occupant").unwrap();
        barrier.wait();
    });
    let result = run(&actor, &root, "turn-changed", Arc::new(NoFaults))
        .await
        .unwrap();
    edit.await.unwrap();
    assert_eq!(result.not_restored, vec!["file-0001.md"]);
    assert_eq!(result.moments.len(), 19);
    assert_eq!(
        std::fs::read_to_string(root.join("file-0001.md")).unwrap(),
        "new occupant"
    );
    let replay = actor
        .preflight_history_undo(WS.into(), OP.into(), "turn-changed".into(), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.not_restored, result.not_restored);
    close(supervisor).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn an_alias_claimed_after_check_is_not_restored_before_it_reaches_disk() {
    let (root, supervisor, actor) = setup(20);
    let (send, receive) = std::sync::mpsc::channel();
    let barrier = Arc::new(Barrier::new(2));
    probes()
        .lock()
        .unwrap()
        .entry("turn-alias".into())
        .or_default()
        .hook = Some((send, barrier.clone()));
    let db = engine_db_path(&root).unwrap();
    let edit = tokio::task::spawn_blocking(move || {
        receive.recv().unwrap();
        let mut store = EngineStore::open(&db, 21).unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    object_id: "new-occupant".into(),
                    path: "file-0001.md".into(),
                    text: "new pending head".into(),
                    moment_id: "new-claim".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 22,
                },
                &NoFaults,
            )
            .unwrap();
        barrier.wait();
    });
    let result = run(&actor, &root, "turn-alias", Arc::new(NoFaults))
        .await
        .unwrap();
    edit.await.unwrap();
    assert_eq!(result.not_restored, vec!["file-0001.md"]);
    assert_eq!(result.moments.len(), 19);
    assert!(!root.join("file-0001.md").exists());
    close(supervisor).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_undo_refuses_version_switch_and_changed_payload() {
    let (root, supervisor, actor) = setup(3);
    actor
        .create_named_version(
            dohc_engine_domain::CreateNamedVersion {
                workspace_id: WS.into(),
                new_version_id: "other".into(),
                name: "Other".into(),
                from_version_id: "main".into(),
                now_ms: 5,
                request_id: None,
            },
            Arc::new(NoFaults),
            crate::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        run(
            &actor,
            &root,
            "pending-binding",
            Arc::new(CrashAfter(AtomicUsize::new(1)))
        )
        .await,
        Err(RuntimeError::OperationCrashed)
    ));
    let refused = actor
        .set_active_version(
            crate::ActiveVersionSwitch {
                workspace_id: WS.into(),
                version_id: "other".into(),
                root_dir: root.to_path_buf(),
                self_writes: Arc::new(()),
                now_ms: 6,
            },
            Arc::new(NoFaults),
            crate::CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(refused, Err(RuntimeError::Domain(DomainError::InvalidInput { reason })) if reason.contains("Undo is still running"))
    );
    assert_eq!(
        actor.active_version(WS.into()).await.unwrap().version_id,
        "main"
    );
    let mismatch = actor
        .history_undo_in_turns(
            WS.into(),
            OP.into(),
            "pending-binding".into(),
            Some(r#"[{"humanId":"other"}]"#.into()),
            root.to_path_buf(),
            Arc::new(NoFaults),
            8,
            [Arc::default(), Arc::default()],
            Arc::new(()),
            None,
            crate::CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        mismatch,
        Err(RuntimeError::Domain(
            DomainError::IdempotencyKeyReuseMismatch
        ))
    ));
    let cursor: i64 = actor
        .run(|store, _| {
            store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT result_seq FROM engine_requests WHERE request_id='pending-binding'",
                        [],
                        |r| r.get(0),
                    )
                })
                .map_err(StorageError::corrupt_public)
                .map_err(Into::into)
        })
        .await
        .unwrap();
    assert_eq!(cursor, 0, "neither refusal commits an inverse");
    let result = run(&actor, &root, "pending-binding", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.moments.len(), 3);
    assert!(matches!(
        run(&actor, &root, "second-request", Arc::new(NoFaults)).await,
        Err(RuntimeError::Domain(DomainError::UndoRefused {
            reason: "Operation already undone",
            ..
        }))
    ));
    close(supervisor).await;
}
struct PauseBefore {
    calls: AtomicUsize,
    at: usize,
    reached: std::sync::mpsc::Sender<()>,
    release: Arc<Barrier>,
}
impl FaultInjector for PauseBefore {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::StorageBeforePersist
            && self.calls.fetch_add(1, Ordering::SeqCst) + 1 == self.at
        {
            self.reached.send(()).unwrap();
            self.release.wait();
        }
        FaultAction::Continue
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn abort_mid_turn_resumes_and_rename_is_placed_before_the_next_inverse() {
    let (root, supervisor, actor) = setup(4);
    let (reached, receive) = std::sync::mpsc::channel();
    let release = Arc::new(Barrier::new(2));
    let faults = Arc::new(PauseBefore {
        calls: AtomicUsize::new(0),
        at: 3,
        reached,
        release: release.clone(),
    });
    let task_actor = actor.clone();
    let path = root.to_path_buf();
    let task = tokio::spawn(async move { run(&task_actor, &path, "abort-turn", faults).await });
    tokio::task::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(30)).unwrap())
        .await
        .unwrap();
    // The second inverse has run its callback but has not committed yet.
    let old_exists = root.join("old.md").exists();
    let new_exists = root.join("new.md").exists();
    task.abort();
    release.wait();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(old_exists);
    assert!(!new_exists);
    actor.run(|_, _| Ok(())).await.unwrap(); // Finish the atomic actor call after cancellation.
    close(supervisor).await;
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 20)
        .unwrap()
        .actor;
    let result = run(&actor, &root, "abort-turn", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.moments.len(), 4);
    assert!(result.not_restored.is_empty());
    let replay = run(&actor, &root, "abort-turn", Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(replay.deduped);
    assert_eq!(replay.moments, result.moments);
    close(supervisor).await;
}
#[tokio::test]
async fn running_checkpoint_does_not_exhaust_the_pinned_wal_budget() {
    use dohc_engine_storage::CheckpointWait;

    let token = crate::CancellationToken::new();
    let mut since = Some(Instant::now() - Duration::from_secs(2));
    ActorHandle::wait_undo_checkpoint(&token, &mut since, Arc::new(|| CheckpointWait::Running))
        .await
        .unwrap();
    assert!(since.is_none(), "checkpoint I/O is not a pinned WAL");

    since = Some(Instant::now() - Duration::from_secs(2));
    assert!(matches!(
        ActorHandle::wait_undo_checkpoint(
            &token,
            &mut since,
            Arc::new(|| CheckpointWait::Finished)
        )
        .await,
        Err(RuntimeError::Storage(StorageError::FileLocked))
    ));
    // A cancel during the wait wins over a spent budget.
    since = Some(Instant::now() - Duration::from_secs(2));
    let cancel = token.clone();
    assert!(matches!(
        ActorHandle::wait_undo_checkpoint(
            &token,
            &mut since,
            Arc::new(move || {
                cancel.cancel();
                CheckpointWait::Finished
            })
        )
        .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(matches!(
        ActorHandle::wait_undo_checkpoint(&token, &mut since, Arc::new(|| CheckpointWait::Running))
            .await,
        Err(RuntimeError::Cancelled)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn pinned_wal_backs_off_returns_file_locked_and_observes_cancellation() {
    let (root, supervisor, actor) = setup(3);
    let hold = actor.hold_link_drain();
    assert!(matches!(
        run(
            &actor,
            &root,
            "pinned-undo",
            Arc::new(CrashAfter(AtomicUsize::new(1)))
        )
        .await,
        Err(RuntimeError::OperationCrashed)
    ));
    actor
        .run(|store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute_batch("CREATE TABLE undo_pin_load(id INTEGER PRIMARY KEY, body BLOB)")
                    .map_err(StorageError::persist_public)
            })?;
            Ok(())
        })
        .await
        .unwrap();
    let reader = rusqlite::Connection::open(engine_db_path(&root).unwrap()).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM undo_pin_load")
        .unwrap();
    actor
        .run(|store, _| {
            for id in 0..400 {
                match store.write_background_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO undo_pin_load VALUES(?1,?2)",
                        params![id, vec![42_u8; 128 * 1024]],
                    )
                    .map_err(StorageError::persist_public)
                }) {
                    Ok(TxnOutcome::Committed(_)) => {}
                    Err(StorageError::FileLocked) => return Ok(()),
                    other => panic!("unexpected load write: {other:?}"),
                }
            }
            panic!("WAL never reached the pinned admission limit");
        })
        .await
        .unwrap();
    let start = Instant::now();
    assert!(matches!(
        run(&actor, &root, "pinned-undo", Arc::new(NoFaults)).await,
        Err(RuntimeError::Storage(StorageError::FileLocked))
    ));
    assert!(start.elapsed() >= Duration::from_secs(1));
    assert!(
        start.elapsed() < Duration::from_secs(15),
        "bounded FileLocked wait"
    );
    let phases = probes().lock().unwrap()["pinned-undo"].phases.clone();
    assert!(
        phases
            .iter()
            .filter(|p| p.phase.contains("inverse"))
            .count()
            <= 22,
        "no hot retry loop"
    );
    let token = crate::CancellationToken::new();
    let task_token = token.clone();
    let task_actor = actor.clone();
    let path = root.to_path_buf();
    let task = tokio::spawn(async move {
        task_actor
            .history_undo_in_turns(
                WS.into(),
                OP.into(),
                "pinned-undo".into(),
                None,
                path,
                Arc::new(NoFaults),
                10,
                [Arc::default(), Arc::default()],
                Arc::new(()),
                None,
                task_token,
            )
            .await
    });
    // Poll the turn probe, so cancellation exercises the checkpoint backoff.
    let before = phases.len();
    tokio::time::timeout(Duration::from_secs(10), async {
        while probes().lock().unwrap()["pinned-undo"].phases.len() <= before + 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    token.cancel();
    assert!(matches!(task.await.unwrap(), Err(RuntimeError::Cancelled)));
    assert_eq!(
        actor.pending_history_undos(WS.into()).await.unwrap().len(),
        1
    );
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    let result = run(&actor, &root, "pinned-undo", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.moments.len(), 3);
    assert!(result.not_restored.is_empty());
    drop(hold);
    close(supervisor).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn synced_deletion_refusal_skips_member_without_leaving_undo_pending() {
    use dohc_engine_domain::{
        ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, TextConflict,
        insert_text_conflict_if_absent,
    };

    let (root, mut store) = fixture();
    seed(&mut store, &root, "guarded.md", "guarded", "retained text");
    let base = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", "guarded.md")
        .unwrap();
    remove(&mut store, &root, "guarded.md", "guarded-delete");
    seed(&mut store, &root, "safe.md", "safe", "safe text");
    remove(&mut store, &root, "safe.md", "safe-delete");
    let conflict = TextConflict {
        conflict_id: "both-absent".into(),
        workspace_id: WS.into(),
        path: "guarded.md".into(),
        target_version_id: "main".into(),
        source_version_id: "main".into(),
        created_at_ms: 4,
        updated_at_ms: 4,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("sync"),
        base: ConflictFileState::text("guarded.md", base),
        current: ConflictFileState::text("guarded.md", None),
        incoming: ConflictFileState::text("guarded.md", None),
    };
    store
        .write_with(&NoFaults, |tx| {
            insert_text_conflict_if_absent(tx, &conflict)
        })
        .unwrap();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 5)
        .unwrap()
        .actor;
    assert!(
        actor
            .preflight_history_undo(WS.into(), OP.into(), "guarded-undo".into(), None)
            .await
            .unwrap()
            .is_none()
    );
    let result = run(&actor, &root, "guarded-undo", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.not_restored, ["guarded.md"]);
    assert_eq!(result.moments.len(), 1);
    assert_eq!(result.moments[0].object_id, "safe");
    assert!(!root.join("guarded.md").exists());
    let (kind, attempts, errors): (String, i64, String) = actor
        .run(|store, _| {
            let files = VersionedTextStore::new(store);
            assert!(files.read_text(WS, "main", "guarded.md")?.is_none());
            assert_eq!(files.read_text(WS, "main", "safe.md")?.unwrap().text, "safe text");
            store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT r.kind,p.attempts,p.errors_json FROM engine_requests r
                         JOIN history_undo_plans p USING(request_id) WHERE request_id='guarded-undo'",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                })
                .map_err(StorageError::corrupt_public)
                .map_err(Into::into)
        })
        .await
        .unwrap();
    assert_eq!(kind, "history-undo-complete");
    assert_eq!(attempts, 0);
    assert!(errors.contains(&DomainError::SyncedDeletionRevivalRefused.to_string()));
    assert!(
        actor
            .pending_history_undos(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    let replay = run(&actor, &root, "guarded-undo", Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(replay.deduped);
    assert_eq!(replay.not_restored, result.not_restored);
    assert_eq!(replay.moments, result.moments);
    close(supervisor).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn repeating_member_errors_stop_after_three_attempts_across_opens() {
    let (root, mut supervisor, mut actor) = setup(3);
    assert!(matches!(
        run(
            &actor,
            &root,
            "three-errors",
            Arc::new(CrashAfter(AtomicUsize::new(2)))
        )
        .await,
        Err(RuntimeError::OperationCrashed)
    ));
    actor.run(|store,_| {
        store.write_with(&NoFaults, |tx| tx.execute_batch(
            "CREATE TRIGGER undo_test_error BEFORE INSERT ON moments WHEN NEW.metadata_origin='restore' AND NEW.object_id='object-2' BEGIN SELECT RAISE(ABORT,'persistent inverse error'); END;")
            .map_err(StorageError::persist_public))?;
        Ok(())
    }).await.unwrap();
    for attempt in 1..=2 {
        assert!(matches!(
            run(
                &actor,
                &root,
                "three-errors",
                Arc::new(CrashAfter(AtomicUsize::new(1)))
            )
            .await,
            Err(RuntimeError::OperationCrashed)
        ));
        let attempts: i64 = actor.run(|store,_| store.read_with(|conn| conn.query_row(
            "SELECT attempts FROM history_undo_plans WHERE request_id='three-errors'",[],|r|r.get(0)))
            .map_err(StorageError::corrupt_public).map_err(Into::into)).await.unwrap();
        assert_eq!(attempts, attempt);
        close(supervisor).await;
        supervisor = crate::WorkspaceSupervisor::new();
        actor = supervisor
            .open(&engine_db_path(&root).unwrap(), 20)
            .unwrap()
            .actor;
    }
    let result = run(&actor, &root, "three-errors", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.not_restored, ["file-0002.md"]);
    assert_eq!(result.moments.len(), 2);
    let error: String = actor
        .run(|store, _| {
            store
                .read_with(|conn| {
                    conn.query_row(
        "SELECT errors_json FROM history_undo_plans WHERE request_id='three-errors'",[],|r|r.get(0))
                })
                .map_err(StorageError::corrupt_public)
                .map_err(Into::into)
        })
        .await
        .unwrap();
    assert!(error.contains("write failed to persist"), "{error}");
    assert!(
        actor
            .pending_history_undos(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    close(supervisor).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn parked_rename_after_restart_completes_and_allows_version_switch() {
    parked_rename_after_restart(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn retry_held_after_parked_rename_captures_edit_and_places_selected_version() {
    parked_rename_after_restart(true).await;
}

async fn parked_rename_after_restart(held: bool) {
    let (root, supervisor, actor) = setup(3);
    actor
        .create_named_version(
            dohc_engine_domain::CreateNamedVersion {
                workspace_id: WS.into(),
                new_version_id: "other".into(),
                name: "Other".into(),
                from_version_id: "main".into(),
                now_ms: 5,
                request_id: None,
            },
            Arc::new(NoFaults),
            crate::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        run(
            &actor,
            &root,
            "parked-resume",
            Arc::new(CrashAfter(AtomicUsize::new(2)))
        )
        .await,
        Err(RuntimeError::OperationCrashed)
    ));
    close(supervisor).await;
    std::fs::write(root.join("old.md"), "outside edit").unwrap();
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor
        .open(&engine_db_path(&root).unwrap(), 20)
        .unwrap()
        .actor;
    if held {
        // Capture pins the outside observation to its source version before replay.
        actor
            .run(|store, _| {
                store.write_with(&NoFaults, |tx| {
                    dohc_engine_storage::capture_file_holds::record_in(
                        tx,
                        &dohc_engine_storage::capture_file_holds::CaptureFileHold {
                            workspace_id: WS.into(),
                            source_version_id: "main".into(),
                            object_id: "mover".into(),
                            path: "old.md".into(),
                            observed_sha256: dohc_engine_storage::hex_sha256(b"outside edit"),
                            observed_size: 12,
                            reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE
                                .into(),
                            observed_at_ms: 20,
                            attempt_count: 1,
                            retry_requested: false,
                        },
                    )
                })?;
                Ok(())
            })
            .await
            .unwrap();
    }
    let result = run(&actor, &root, "parked-resume", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.moments.len(), 3);
    assert!(result.not_restored.is_empty());
    let rename_inverse = result
        .moments
        .iter()
        .find(|m| m.operation == "rename")
        .unwrap();
    let rename_jobs = undo_job_ids(WS, "main", rename_inverse);
    let parked_write = rename_jobs[0].clone();
    let placed = actor
        .history_undo_place(
            WS.into(),
            result,
            root.to_path_buf(),
            Arc::new(()),
            21,
            |_| {},
        )
        .await;
    assert!(!placed.materialized, "held placement stays parked");
    assert_eq!(
        std::fs::read_to_string(root.join("old.md")).unwrap(),
        "outside edit"
    );
    assert!(
        actor
            .pending_history_undos(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    let expected_write = parked_write.clone();
    actor
        .run(move |store, _| {
            let job = store.load_materialization_job(&expected_write)?.unwrap();
            assert_eq!(job.target_path, "old.md");
            assert_ne!(job.status, JobStatus::Complete);
            if held {
                assert_eq!(
                    job.status,
                    JobStatus::Pending,
                    "held placement remains pending"
                );
            }
            Ok(())
        })
        .await
        .unwrap();
    let switched = actor
        .set_active_version(
            crate::ActiveVersionSwitch {
                workspace_id: WS.into(),
                version_id: "other".into(),
                root_dir: root.to_path_buf(),
                self_writes: Arc::new(()),
                now_ms: 22,
            },
            Arc::new(NoFaults),
            crate::CancellationToken::new(),
        )
        .await;
    if held {
        // Capture holds park jobs without making a version switch fail.
        assert!(switched.is_ok(), "{switched:?}");
    } else {
        // Decision 17 completes Undo; the switch still reports the outside conflict.
        assert!(
            matches!(
                switched,
                Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 })
            ),
            "{switched:?}"
        );
    }
    let switch_job = actor.run(move |store, _| {
        let write = store.load_materialization_job(&parked_write)?.unwrap();
        assert_ne!(write.status, JobStatus::Complete);
        let incomplete: Vec<(String,String,String)> = store.read_with(|conn| {
            conn.prepare("SELECT job_id,target_path,status FROM materialization_jobs WHERE workspace_id=?1 AND status!='complete' AND job_id GLOB 'version-switch-*'")?.query_map([WS], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()
        }).map_err(StorageError::corrupt_public)?;
        assert_eq!(incomplete.len(), 1, "only the parked rename path remains incomplete");
        assert_eq!(incomplete[0].1, write.target_path, "the switch reports that same parked path");
        if held { assert_eq!(incomplete[0].2, "pending"); }
        Ok(incomplete[0].0.clone())
    }).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("old.md")).unwrap(),
        "outside edit"
    );
    assert_eq!(
        actor.active_version(WS.into()).await.unwrap().version_id,
        "other"
    );

    if !held {
        close(supervisor).await;
        return;
    }
    assert!(
        actor
            .retry_capture_file(WS.into(), "old.md".into())
            .await
            .unwrap()
    );
    let captured = actor
        .capture_ingest(
            dohc_engine_domain::CaptureIngest {
                workspace_id: WS.into(),
                version_id: "other".into(),
                path: "old.md".into(),
                text: "outside edit".into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 23,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            crate::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(captured.released_capture_hold);
    assert_eq!(captured.snapshot.version_id, "main");
    assert_eq!(captured.snapshot.text, "outside edit");
    struct ExistingRoot;
    impl WorkspaceRootGuard for ExistingRoot {
        fn validate(&self, root: &Path) -> Result<(), RuntimeError> {
            root.is_dir().then_some(()).ok_or(RuntimeError::Identity {
                reason: "test workspace root disappeared",
                source: None,
            })
        }
    }
    // Retry held captures the observation, then places the selected version's job.
    actor
        .finish_capture_pass(
            WS.into(),
            root.to_path_buf(),
            CapturePassSettlement {
                paths: vec![CapturePlacementPath {
                    path: "old.md".into(),
                    released_hold: captured.released_capture_hold,
                }],
                repair_recoveries: false,
            },
            Arc::new(()),
            24,
            Arc::new(ExistingRoot),
        )
        .await
        .unwrap();
    actor
        .run(move |store, _| {
            let placed = store.load_materialization_job(&switch_job)?.unwrap();
            assert_eq!(placed.status, JobStatus::Complete);
            assert_eq!(placed.target_path, "old.md");
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        actor
            .capture_file_holds(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!root.join("old.md").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("new.md")).unwrap(),
        "move body"
    );
    let retained = actor
        .versioned_text_read(
            WS.into(),
            "main".into(),
            "old.md".into(),
            crate::CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.text, "outside edit");
    close(supervisor).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_member_error_uses_only_one_attempt_per_call() {
    let (root, supervisor, actor) = setup(3);
    assert!(matches!(
        run(
            &actor,
            &root,
            "transient-error",
            Arc::new(CrashAfter(AtomicUsize::new(2)))
        )
        .await,
        Err(RuntimeError::OperationCrashed)
    ));
    actor.run(|store,_| {
        store.write_with(&NoFaults, |tx| tx.execute_batch(
            "CREATE TRIGGER undo_transient_error BEFORE INSERT ON moments WHEN NEW.metadata_origin='restore' AND NEW.object_id='object-2' BEGIN SELECT RAISE(ABORT,'transient inverse error'); END;")
            .map_err(StorageError::persist_public))?;
        Ok(())
    }).await.unwrap();
    assert!(
        run(&actor, &root, "transient-error", Arc::new(NoFaults))
            .await
            .is_err()
    );
    let attempts: i64 = actor
        .run(|store, _| {
            store
                .read_with(|conn| {
                    conn.query_row(
        "SELECT attempts FROM history_undo_plans WHERE request_id='transient-error'",[],|r|r.get(0))
                })
                .map_err(StorageError::corrupt_public)
                .map_err(Into::into)
        })
        .await
        .unwrap();
    assert_eq!(attempts, 1, "a single call must not burn every attempt");
    actor
        .run(|store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute_batch("DROP TRIGGER undo_transient_error")
                    .map_err(StorageError::persist_public)
            })?;
            Ok(())
        })
        .await
        .unwrap();
    let result = run(&actor, &root, "transient-error", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.moments.len(), 3);
    assert!(result.not_restored.is_empty());
    close(supervisor).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_replay_reports_only_its_own_committed_work() {
    let (root, supervisor, actor) = setup(1);
    let (first, second) = tokio::join!(
        run(&actor, &root, "concurrent-undo", Arc::new(NoFaults)),
        run(&actor, &root, "concurrent-undo", Arc::new(NoFaults)),
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_ne!(first.deduped, second.deduped);
    assert_eq!(first.moments, second.moments);
    assert_eq!(first.moments.len(), 1);
    close(supervisor).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn two_thousand_members_bound_store_work_and_ydoc_wait() {
    let (root, supervisor, actor) = setup(2000);
    set_turn_budget("turn-perf", Duration::MAX);
    let hold = actor.hold_link_drain();
    actor
        .run(|store, _| {
            store
                .read_with(|conn| {
                    dohc_engine_storage::capture_phase::enable_for_current_thread();
                    // Count inserted inverse rows, including a regression that inserts
                    // several members with one SQL statement. Keep the engine's row hook.
                    conn.execute_batch(INVERSE_PROBE)?;
                    conn.trace_v2(
                        rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT
                            | rusqlite::trace::TraceEventCodes::SQLITE_TRACE_ROW,
                        Some(trace_store_work),
                    );
                    Ok::<_, rusqlite::Error>(())
                })
                .map_err(StorageError::corrupt_public)?;
            Ok::<_, RuntimeError>(())
        })
        .await
        .unwrap();
    let gates = [
        Arc::new(tokio::sync::Mutex::new(())),
        Arc::new(tokio::sync::Mutex::new(())),
    ];
    let notify = Arc::new(tokio::sync::Notify::new());
    probes()
        .lock()
        .unwrap()
        .entry("turn-perf".into())
        .or_default()
        .notify = Some(notify.clone());
    let updates_actor = actor.clone();
    let serial = gates[1].clone();
    let updates = tokio::spawn(async move {
        notify.notified().await;
        let key = dohc_engine_collab::DocKey::new(WS, "main", "typing").unwrap();
        let doc = dohc_engine_collab::Ydoc::wire();
        let mut claim = None;
        let mut waits = Vec::new();
        let mut gaps = Vec::new();
        let mut retry_evidence = Vec::new();
        for i in 0..100 {
            let payload = doc.plaintext_insert(i, "x");
            let (update, timing, _admission) = retry_ydoc_update(
                &serial,
                || turn_count("turn-perf"),
                || {
                    updates_actor.ydoc_record_update(
                        key.clone(),
                        "typing.md".into(),
                        dohc_engine_collab::ContentKind::Plaintext,
                        dohc_engine_collab::Regime::LocalOnly,
                        payload.clone(),
                        None,
                        None,
                        claim.clone(),
                        i == 0,
                        None,
                        Some(format!("typing-{i}")),
                        5,
                        Arc::new(NoFaults),
                        tokio_util::sync::CancellationToken::new(),
                        None,
                    )
                },
            )
            .await;
            claim = update.lineage_claim_id;
            waits.push(timing.wait_ns);
            gaps.push(timing.turn_gap);
            retry_evidence.push(timing);
        }
        (waits, gaps, retry_evidence)
    });
    let start = Instant::now();
    let result = actor
        .history_undo_in_turns(
            WS.into(),
            OP.into(),
            "turn-perf".into(),
            None,
            root.to_path_buf(),
            Arc::new(NoFaults),
            10,
            gates,
            Arc::new(()),
            None,
            crate::CancellationToken::new(),
        )
        .await
        .unwrap();
    let total = start.elapsed();
    let (waits, gaps, retry_evidence) = updates.await.unwrap();
    assert_eq!(result.moments.len(), 2000);
    let phases = probes().lock().unwrap()["turn-perf"].phases.clone();
    let times: Vec<Duration> = phases
        .iter()
        .filter(|p| p.actor && p.store_work.is_some_and(|work| work.inverses > 0))
        .map(|p| Duration::from_nanos(u64::try_from(p.elapsed_ns).unwrap()))
        .collect();
    for (turn, phase) in phases.iter().enumerate() {
        eprintln!(
            "UNDO phase={turn} activity={} member={:?} actor={} elapsed_ms={:.4} check_ms={:?} write_ms={:?} store_work={}",
            phase.phase,
            phase.member,
            phase.actor,
            phase.elapsed_ns as f64 / 1_000_000.0,
            phase.check_ns.map(|ns| ns as f64 / 1_000_000.0),
            phase
                .check_ns
                .map(|ns| (phase.elapsed_ns - ns) as f64 / 1_000_000.0),
            serde_json::to_string(&phase.store_work).unwrap()
        );
        if phase.actor && phase.elapsed_ns > 50_000_000 {
            eprintln!(
                "UNDO storage phase={turn} activity={} member={:?} totals={}",
                phase.phase,
                phase.member,
                serde_json::to_string(&phase.storage).unwrap()
            );
        }
    }
    let mut sorted = times.clone();
    sorted.sort();
    let p95 = sorted[(sorted.len() * 95).div_ceil(100) - 1];
    eprintln!(
        "UNDO 2000 members: inverse_turns={} p95={:?} max={:?} ydoc_max_gap={:?} ydoc_max_wait_ns={:?}",
        times.len(),
        p95,
        sorted.last(),
        gaps.iter().max(),
        waits.iter().max()
    );
    let other_times: Vec<u128> = phases
        .iter()
        .filter(|p| p.actor && p.store_work.is_some_and(|work| work.inverses == 0))
        .map(|p| p.elapsed_ns)
        .collect();
    let mut other_sorted = other_times.clone();
    other_sorted.sort();
    eprintln!(
        "UNDO non-inverse turns={} p95_ns={:?} max_ns={:?}",
        other_times.len(),
        other_sorted.get((other_sorted.len() * 95).div_ceil(100).saturating_sub(1)),
        other_sorted.last()
    );
    if let Ok(dir) = std::env::var("DOHC_HISTORY_UNDO_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        let evidence = serde_json::json!({"members":2000,"totalNs":total.as_nanos(),"inverseTurnNs":times.iter().map(Duration::as_nanos).collect::<Vec<_>>(),"otherTurnNs":other_times,"phases":phases,"updateWaitNs":waits,"updateTurnGaps":gaps,"updateRetries":retry_evidence}).to_string();
        let attempt = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::fs::write(
            Path::new(&dir).join(format!("turn-timings-{attempt}.json")),
            &evidence,
        )
        .unwrap();
        std::fs::write(Path::new(&dir).join("turn-timings.json"), evidence).unwrap();
    }
    drop(hold);
    close(supervisor).await;
    assert!(
        retry_evidence.iter().all(|timing| timing.max_turn_gap <= 1),
        "a Y.Doc update attempt waited behind more than one turn: {retry_evidence:?}"
    );
    let mut inverses = 0;
    for phase in phases.iter().filter(|phase| phase.actor) {
        let work = phase.store_work.unwrap();
        inverses += work.inverses;
        assert!(
            work.inverses <= 16
                && work.commits
                    <= if phase.phase == "rename-placement" {
                        3
                    } else {
                        1
                    },
            "at most 16 inverses and one transaction per turn: {} member={:?} work={}",
            phase.phase,
            phase.member,
            serde_json::to_string(&work).unwrap()
        );
        let storage = phase
            .storage
            .as_ref()
            .expect("every actor turn records storage hooks");
        if work.inverses > 0 {
            for label in ["BEGIN", "transaction_callback", "COMMIT", "prepare_write"] {
                let calls = storage
                    .get(label)
                    .and_then(|v| v["calls"].as_u64())
                    .unwrap_or_else(|| panic!("missing storage timing label {label}: {storage}"));
                assert_eq!(
                    calls, 1,
                    "one inverse transaction: {} {label}: {storage}",
                    phase.phase
                );
            }
            let commits = storage
                .get("commits")
                .and_then(|v| v["count"].as_u64())
                .expect("missing commits counter");
            assert_eq!(commits, 1);
        }
        // Fixed statement and result-row budgets, independent of member count.
        // Include SQL executed by trigger programs, not only root statements.
        assert!(
            work.reads <= 16 + 112 * work.inverses.max(1)
                && work.writes <= 16 + 112 * work.inverses.max(1)
                && work.rows <= 32 + 224 * work.inverses.max(1),
            "bounded store work per turn: {} member={:?} work={}",
            phase.phase,
            phase.member,
            serde_json::to_string(&work).unwrap()
        );
    }
    assert_eq!(
        times.len(),
        1 + 1999usize.div_ceil(16),
        "the rename runs alone; a fixed budget fills every remaining batch"
    );
    assert_eq!(inverses, 2000, "the probe must observe every inverse row");
}

pub(in crate::actor) fn enable_work_probe(store: &EngineStore) {
    store
        .read_with(|conn| {
            conn.execute_batch(INVERSE_PROBE).unwrap();
            conn.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT
                    | rusqlite::trace::TraceEventCodes::SQLITE_TRACE_ROW,
                Some(trace_store_work),
            );
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}
pub(in crate::actor) fn turn_count(request: &str) -> usize {
    probes()
        .lock()
        .unwrap()
        .get(request)
        .map_or(0, |p| p.phases.iter().filter(|p| p.actor).count())
}
pub(in crate::actor) fn proof(request: &str, members: usize, forward: bool) -> serde_json::Value {
    let phases = probes().lock().unwrap()[request].phases.clone();
    let mut inverses = 0;
    let mut times = Vec::new();
    for p in phases.iter().filter(|p| p.actor) {
        let w = p.store_work.unwrap();
        assert!(w.sources <= 16);
        // A write inverse replaces an existing search entry, including its FTS
        // shadow rows. The delete-inverse proof above keeps its smaller bounds.
        assert!(
            w.reads
                <= if forward {
                    4 + 64 * w.sources
                } else {
                    16 + 112 * w.inverses.max(1)
                }
                && w.writes
                    <= if forward {
                        (if matches!(p.phase.as_str(), "admission" | "reply") {
                            3
                        } else {
                            2
                        }) + 112 * w.sources
                    } else {
                        16 + 496 * w.inverses.max(1)
                    }
                && w.rows
                    <= if forward {
                        (match p.phase.as_str() {
                            "admission" => 16,
                            // Receipt reservation and reply return no phase rows.
                            "reserve" | "reply" => 0,
                            _ => 8,
                        }) + 96 * w.sources
                    } else {
                        32 + 480 * w.inverses.max(1)
                    },
            "{}: reads={} writes={} rows={}",
            p.phase,
            w.reads,
            w.writes,
            w.rows
        );
        assert!(w.inverses <= if forward { 0 } else { 16 });
        assert!(
            w.commits
                <= if forward {
                    w.sources.max(1)
                } else if p.phase == "rename-placement" {
                    3
                } else {
                    1
                }
        );
        inverses += w.inverses;
        times.push(p.elapsed_ns);
    }
    if !forward {
        assert_eq!(inverses, members);
    }
    times.sort();
    serde_json::json!({"turns":phases,"p95Ns":times[(times.len()*95).div_ceil(100)-1],
        "maxNs":times.last(),"inverseRows":inverses})
}

pub(in crate::actor) fn notify_inverse(request: &str, notify: Arc<tokio::sync::Notify>) {
    probes()
        .lock()
        .unwrap()
        .entry(request.into())
        .or_default()
        .notify = Some(notify);
}

pub(in crate::actor) fn pause_inverse(
    request: &str,
) -> (std::sync::mpsc::Receiver<()>, Arc<Barrier>) {
    let (send, receive) = std::sync::mpsc::channel();
    let barrier = Arc::new(Barrier::new(2));
    probes()
        .lock()
        .unwrap()
        .entry(request.into())
        .or_default()
        .hook = Some((send, barrier.clone()));
    (receive, barrier)
}

#[tokio::test(flavor = "multi_thread")]
async fn ydoc_update_retries_a_locked_writer() {
    let (root, supervisor, actor) = setup(1);
    let _hold = actor.hold_link_drain();
    actor
        .run(|store, _| {
            store
                .read_with(|conn| conn.busy_timeout(Duration::ZERO))
                .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .await
        .unwrap();
    let writer = rusqlite::Connection::open(engine_db_path(&root).unwrap()).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let key = dohc_engine_collab::DocKey::new(WS, "main", "typing").unwrap();
    let payload = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "x");
    let serial = tokio::sync::Mutex::new(());
    let refusals = AtomicUsize::new(0);
    let (update, timing, _admission) = retry_ydoc_update(
        &serial,
        || 0,
        || async {
            let result = actor
                .ydoc_record_update(
                    key.clone(),
                    "typing.md".into(),
                    dohc_engine_collab::ContentKind::Plaintext,
                    dohc_engine_collab::Regime::LocalOnly,
                    payload.clone(),
                    None,
                    None,
                    None,
                    true,
                    None,
                    Some("locked-typing".into()),
                    5,
                    Arc::new(NoFaults),
                    crate::CancellationToken::new(),
                    None,
                )
                .await;
            if matches!(
                result,
                Err(RuntimeError::Collab(
                    dohc_engine_collab::CollabError::Storage(StorageError::FileLocked)
                ))
            ) {
                assert_eq!(refusals.fetch_add(1, Ordering::SeqCst), 0);
                writer.execute_batch("ROLLBACK").unwrap();
            }
            result
        },
    )
    .await;
    assert_eq!(refusals.load(Ordering::SeqCst), 1);
    assert_eq!(timing.retries, 1);
    assert_eq!(update.outcome.seq, 1);
    close(supervisor).await;
}

pub(in crate::actor) fn pause_checkpoint(request: &str) -> [Arc<tokio::sync::Notify>; 2] {
    let hook = [Arc::default(), Arc::default()];
    probes()
        .lock()
        .unwrap()
        .entry(request.into())
        .or_default()
        .checkpoint = Some(hook.clone());
    hook
}

pub(in crate::actor) async fn checkpoint_wait(request: &str) {
    let hook = probes()
        .lock()
        .unwrap()
        .get_mut(request)
        .and_then(|p| p.checkpoint.take());
    if let Some([entered, release]) = hook {
        entered.notify_one();
        release.notified().await;
    }
}
