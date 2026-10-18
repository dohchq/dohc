use super::super::tests::{OP, WS, fixture, remove, rename, seed};
use super::*;
use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
use std::sync::{
    Barrier, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};

type Hook = (std::sync::mpsc::Sender<()>, Arc<Barrier>);
#[derive(Default)]
struct Probe {
    times: Vec<Duration>,
    hook: Option<Hook>,
    notify: Option<Arc<tokio::sync::Notify>>,
}
fn probes() -> &'static Mutex<std::collections::HashMap<String, Probe>> {
    static PROBES: OnceLock<Mutex<std::collections::HashMap<String, Probe>>> = OnceLock::new();
    PROBES.get_or_init(Mutex::default)
}
pub(super) fn record(request: &str, elapsed: Duration) {
    let (hook, notify) = {
        let mut probes = probes().lock().unwrap();
        let probe = probes.entry(request.to_owned()).or_default();
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
        .open(&crate::engine_db_path(&root).unwrap(), 4)
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
        .open(&crate::engine_db_path(&root).unwrap(), 20)
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
    let db = crate::engine_db_path(&root).unwrap();
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
async fn two_thousand_members_hold_each_turn_under_fifty_ms_and_admit_ydoc_updates() {
    let (root, supervisor, actor) = setup(2000);
    let hold = actor.hold_link_drain();
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
    let times = probes().lock().unwrap()["turn-perf"].times.clone();
    if let Ok(dir) = std::env::var("DOHC_HISTORY_UNDO_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(Path::new(&dir).join("turn-timings.json"),serde_json::json!({"members":2000,"totalNs":total.as_nanos(),"turnNs":times.iter().map(Duration::as_nanos).collect::<Vec<_>>(),"updateWaitNs":waits,"updateTurnGaps":gaps}).to_string()).unwrap();
    }
    drop(hold);
    close(supervisor).await;
    assert!(
        gaps.iter().all(|&gap| gap <= 1),
        "a Y.Doc update waited behind more than one turn: {gaps:?}"
    );
    assert!(
        times.iter().all(|&time| time <= Duration::from_millis(50)),
        "STOP: 2,000-member Undo commit turn exceeded 50 ms: {:?}",
        times.iter().max()
    );
}
