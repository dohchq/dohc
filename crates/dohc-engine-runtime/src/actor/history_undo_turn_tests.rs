use super::super::tests::{OP, WS, fixture, remove, rename, seed};
use super::*;
use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
use dohc_engine_testkit::engine_db_path;
use std::sync::{
    Barrier, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

#[derive(Clone, Copy, Default, serde::Serialize)]
struct StoreWork {
    reads: usize,
    writes: usize,
    rows: usize,
    inverses: usize,
    commits: usize,
}
thread_local! {
    static STORE_WORK: std::cell::Cell<StoreWork> = const { std::cell::Cell::new(StoreWork {
        reads: 0, writes: 0, rows: 0, inverses: 0, commits: 0,
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
            rusqlite::trace::TraceEvent::Row(_) => work.rows += 1,
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
}
// Start on the actor, so queued Y.Doc work cannot enter this turn's counters.
pub(super) fn begin_turn(request: &str) {
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
    phases: Vec<Phase>,
    actor_totals: Option<dohc_engine_storage::capture_phase::Snapshot>,
    hook: Option<Hook>,
    notify: Option<Arc<tokio::sync::Notify>>,
}
fn probes() -> &'static Mutex<std::collections::HashMap<String, Probe>> {
    static PROBES: OnceLock<Mutex<std::collections::HashMap<String, Probe>>> = OnceLock::new();
    PROBES.get_or_init(Mutex::default)
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
pub(super) fn record_phase(
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
pub(super) fn record(
    request: &str,
    member: usize,
    operation: &str,
    last: bool,
    elapsed: Duration,
    checks: Duration,
) {
    record_phase(
        request,
        &format!(
            "{operation}-inverse{}",
            if last { "+complete-ledger" } else { "" }
        ),
        Some(member),
        elapsed,
        true,
    );
    let (hook, notify) = {
        let mut probes = probes().lock().unwrap();
        let probe = probes.entry(request.to_owned()).or_default();
        probe.phases.last_mut().unwrap().check_ns = Some(checks.as_nanos());
        probe.times.push(elapsed);
        (probe.hook.take(), probe.notify.take())
    };
    if let Some(notify) = notify {
        notify.notify_one();
    }
    if let Some((sender, barrier)) = hook {
        sender.send(()).unwrap();
        barrier.wait();
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
        .history_undo_commit(
            WS.into(),
            OP.into(),
            request.into(),
            None,
            root.to_path_buf(),
            faults,
            10,
        )
        .await
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
    assert!(result.deduped);
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
            .history_undo_commit(
                WS.into(),
                OP.into(),
                "turn-crash".into(),
                Some("[]".into()),
                root.to_path_buf(),
                Arc::new(NoFaults),
                30
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
async fn two_thousand_members_bound_store_work_and_ydoc_wait_with_p95_under_fifty_ms() {
    let (root, supervisor, actor) = setup(2000);
    let hold = actor.hold_link_drain();
    actor
        .run(|store, _| {
            store
                .read_with(|conn| {
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
        for i in 0..100 {
            let payload = doc.plaintext_insert(i, "x");
            let before = probes().lock().unwrap()["turn-perf"].times.len();
            let start = Instant::now();
            let _guard = serial.lock().await;
            let update = updates_actor
                .ydoc_record_update(
                    key.clone(),
                    "typing.md".into(),
                    dohc_engine_collab::ContentKind::Plaintext,
                    dohc_engine_collab::Regime::LocalOnly,
                    payload,
                    None,
                    None,
                    claim,
                    i == 0,
                    None,
                    Some(format!("typing-{i}")),
                    5,
                    Arc::new(NoFaults),
                    tokio_util::sync::CancellationToken::new(),
                    None,
                )
                .await
                .unwrap();
            claim = update.lineage_claim_id;
            waits.push(start.elapsed().as_nanos());
            gaps.push(probes().lock().unwrap()["turn-perf"].times.len() - before);
        }
        (waits, gaps)
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
        )
        .await
        .unwrap();
    let total = start.elapsed();
    let (waits, gaps) = updates.await.unwrap();
    assert_eq!(result.moments.len(), 2000);
    let phases = probes().lock().unwrap()["turn-perf"].phases.clone();
    let times: Vec<Duration> = phases
        .iter()
        .filter(|p| p.actor)
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
        "UNDO 2000 members: turns={} p95={:?} max={:?} ydoc_max_gap={:?} ydoc_max_wait_ns={:?}",
        times.len(),
        p95,
        sorted.last(),
        gaps.iter().max(),
        waits.iter().max()
    );
    if let Ok(dir) = std::env::var("DOHC_HISTORY_UNDO_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        let evidence = serde_json::json!({"members":2000,"totalNs":total.as_nanos(),"turnNs":times.iter().map(Duration::as_nanos).collect::<Vec<_>>(),"phases":phases,"updateWaitNs":waits,"updateTurnGaps":gaps}).to_string();
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
        gaps.iter().all(|&gap| gap <= 1),
        "a Y.Doc update waited behind more than one turn: {gaps:?}"
    );
    let mut inverses = 0;
    for phase in phases.iter().filter(|phase| phase.actor) {
        let work = phase.store_work.unwrap();
        inverses += work.inverses;
        assert!(
            work.inverses <= 1 && work.commits <= 1,
            "one inverse and transaction per turn: {} member={:?} work={}",
            phase.phase,
            phase.member,
            serde_json::to_string(&work).unwrap()
        );
        if let Some(storage) = &phase.storage {
            for label in ["BEGIN", "transaction_callback", "COMMIT", "prepare_write"] {
                assert!(
                    storage[label]["calls"].as_u64().unwrap_or(0) <= 1,
                    "one store transaction per turn: {} {label}: {storage}",
                    phase.phase
                );
            }
            assert!(storage["commits"]["count"].as_u64().unwrap_or(0) <= 1);
        }
        // Fixed statement and result-row budgets, independent of member count.
        // Include SQL executed by trigger programs, not only root statements.
        assert!(
            work.reads <= 128 && work.writes <= 128 && work.rows <= 256,
            "bounded store work per turn: {} member={:?} work={}",
            phase.phase,
            phase.member,
            serde_json::to_string(&work).unwrap()
        );
    }
    assert_eq!(inverses, 2000, "the probe must observe every inverse row");
    // Decision 16: the idle-host release benchmark owns the maximum ceiling.
    assert!(
        p95 <= Duration::from_millis(50),
        "2,000-member Undo actor-turn p95 exceeded 50 ms: {p95:?}; max={:?}",
        sorted.last()
    );
}
