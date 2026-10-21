use super::*;
use std::sync::mpsc::{Receiver, Sender};

#[derive(Default)]
struct Probe {
    turns: Vec<(usize, u128)>,
    pause: Option<(Arc<tokio::sync::Notify>, Receiver<()>)>,
    faults: Option<Arc<dyn FaultInjector>>,
}
fn placements() -> &'static Mutex<HashMap<String, Probe>> {
    static DATA: OnceLock<Mutex<HashMap<String, Probe>>> = OnceLock::new();
    DATA.get_or_init(Mutex::default)
}
pub(in crate::actor) struct Turn {
    ws: String,
    start: Instant,
    pub(in crate::actor) jobs: usize,
}
impl Turn {
    pub(in crate::actor) fn start(ws: &str) -> Self {
        let pause = placements()
            .lock()
            .unwrap()
            .entry(ws.into())
            .or_default()
            .pause
            .take();
        if let Some((entered, release)) = pause {
            entered.notify_one();
            release.recv().unwrap();
        }
        Self {
            ws: ws.into(),
            start: Instant::now(),
            jobs: 0,
        }
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        placements()
            .lock()
            .unwrap()
            .entry(self.ws.clone())
            .or_default()
            .turns
            .push((self.jobs, self.start.elapsed().as_nanos()));
    }
}
pub(in crate::actor) fn faults(ws: &str) -> Arc<dyn FaultInjector> {
    placements()
        .lock()
        .unwrap()
        .get(ws)
        .and_then(|p| p.faults.clone())
        .unwrap_or_else(|| Arc::new(NoFaults))
}
pub(in crate::actor) fn remove(ws: &str) {
    placements().lock().unwrap().remove(ws);
}
fn pause(ws: &str) -> (Arc<tokio::sync::Notify>, Sender<()>) {
    let entered = Arc::new(tokio::sync::Notify::new());
    let (tx, rx) = std::sync::mpsc::channel();
    placements()
        .lock()
        .unwrap()
        .entry(ws.into())
        .or_default()
        .pause = Some((entered.clone(), rx));
    (entered, tx)
}
impl Fixture {
    async fn wait_disk(&self, sources: usize) {
        tokio::time::timeout(Duration::from_secs(120), async {
            let mut next = 0;
            loop {
                while next < sources
                    && std::fs::read_to_string(self.root.join(format!("source-{next:04}.md")))
                        .ok()
                        .as_deref()
                        == Some("[[new#part|label]] [[./new.md]] [old](old.md)")
                {
                    next += 1;
                }
                if next == sources {
                    break;
                }
                self.actor.run(|_, _| Ok(())).await.unwrap();
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("committed rewrites must reach disk automatically");
        for i in 0..sources {
            assert_eq!(
                std::fs::read_to_string(self.root.join(format!("source-{i:04}.md"))).unwrap(),
                "[[new#part|label]] [[./new.md]] [old](old.md)"
            );
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishes_three_closed_sources_and_an_open_document_without_a_placement_caller() {
    for open in [false, true] {
        let f = Fixture::new(3, 3);
        let lease = if open {
            Some(f.open_document("source-0001").await.0)
        } else {
            None
        };
        assert_eq!(
            f.pass("disk", Arc::new(NoFaults)).await.unwrap()["documents"],
            3
        );
        f.wait_disk(3).await;
        if open {
            assert!(
                f.leases
                    .is_held_by_session(&DocKey::new(&f.ws, "main", "source-0001").unwrap())
            );
        }
        drop(lease);
        f.close().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_placement_recovers_and_retries_without_another_request() {
    let f = Fixture::new(3, 3);
    let fault = Arc::new(CrashNth {
        point: FaultPoint::MaterializeAfterDisplaceBeforePlace,
        nth: 1,
        seen: AtomicUsize::new(0),
    });
    placements()
        .lock()
        .unwrap()
        .entry(f.ws.clone())
        .or_default()
        .faults = Some(fault.clone());
    f.pass("interrupted-placement", Arc::new(NoFaults))
        .await
        .unwrap();
    f.wait_disk(3).await;
    assert!(fault.seen.load(Ordering::SeqCst) >= 1);
    f.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_receipt_restarts_unpublished_work_after_actor_restart() {
    let mut f = Fixture::new(3, 3);
    let hold = f.capture.clone().lock_owned().await;
    let reply = f.pass("receipt-debt", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        BODY
    );
    f.restart().await;
    drop(hold);
    assert_eq!(
        f.pass("receipt-debt", Arc::new(NoFaults)).await.unwrap(),
        reply
    );
    f.wait_disk(3).await;
    f.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_cancels_publication_between_complete_file_placements() {
    let f = Fixture::new(3, 3);
    let hold = f.capture.clone().lock_owned().await;
    f.pass("undo-publication", Arc::new(NoFaults))
        .await
        .unwrap();
    let (entered, release) = pause(&f.ws);
    drop(hold);
    tokio::time::timeout(Duration::from_secs(120), entered.notified())
        .await
        .expect("publisher must enter its first turn");
    let result = {
        let undo = f.undo();
        tokio::pin!(undo);
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(undo.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();
        undo.await.unwrap()
    };
    assert_eq!(result.moments.len(), 4);
    assert!(result.not_restored.is_empty());
    for i in 0..3 {
        let path = format!("source-{i:04}.md");
        assert_eq!(f.text(&path).await, BODY);
        let disk = std::fs::read_to_string(f.root.join(path)).unwrap();
        assert!(disk == BODY || disk == "[[new#part|label]] [[./new.md]] [old](old.md)");
    }
    let turns = placements().lock().unwrap()[&f.ws].turns.clone();
    assert_eq!(turns.iter().map(|(n, _)| n).sum::<usize>(), 1);
    f.close().await;
}

#[derive(Default)]
struct FlushTimings {
    start: Mutex<Option<Instant>>,
    tails: Mutex<Vec<u128>>,
}
impl FaultInjector for FlushTimings {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeAfterTempWrite {
            *self.start.lock().unwrap() = Some(Instant::now());
        }
        if point == FaultPoint::MaterializeAfterFlushBeforeRename
            && let Some(start) = self.start.lock().unwrap().take()
        {
            self.tails.lock().unwrap().push(start.elapsed().as_nanos());
        }
        FaultAction::Continue
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_thousand_placements_are_bounded_and_admit_a_queued_ydoc_update() {
    let f = Fixture::new(2000, 2001);
    let _index = f.actor.hold_link_drain();
    let hold = f.capture.clone().lock_owned().await;
    let timings = Arc::new(FlushTimings::default());
    placements()
        .lock()
        .unwrap()
        .entry(f.ws.clone())
        .or_default()
        .faults = Some(timings.clone());
    let start = Instant::now();
    f.pass("placement-turns", Arc::new(NoFaults)).await.unwrap();
    let (entered, release) = pause(&f.ws);
    drop(hold);
    tokio::time::timeout(Duration::from_secs(120), entered.notified())
        .await
        .expect("publisher must enter its first turn");
    let admission = f.serial.clone().lock_owned();
    tokio::pin!(admission);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(admission.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let update_start = Instant::now();
    release.send(()).unwrap();
    let admission = admission.await;
    let turns_before_update = placements().lock().unwrap()[&f.ws].turns.len();
    assert!(
        turns_before_update <= 1,
        "queued update waited behind more than one placement turn"
    );
    let key = DocKey::new(&f.ws, "main", "source-2000").unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    f.actor
        .ydoc_record_update(
            key,
            "source-2000.md".into(),
            dohc_engine_collab::ContentKind::Plaintext,
            dohc_engine_collab::Regime::LocalOnly,
            doc.plaintext_insert(0, "typing"),
            None,
            None,
            None,
            true,
            None,
            Some("placement-typing".into()),
            5,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    let update_ns = update_start.elapsed().as_nanos();
    drop(admission);
    f.wait_disk(2000).await;
    let disk_ns = start.elapsed().as_nanos();
    let turns = placements().lock().unwrap()[&f.ws].turns.clone();
    assert_eq!(turns.iter().map(|(n, _)| n).sum::<usize>(), 2000);
    assert!(
        turns.iter().all(|(n, _)| *n <= 1),
        "one placement per turn: {turns:?}"
    );
    let mut flushes = timings.tails.lock().unwrap().clone();
    flushes.sort();
    assert_eq!(flushes.len(), 2000);
    let evidence = json!({"sources":2000,"diskNs":disk_ns,"updateWaitNs":update_ns,
        "turnsBeforeQueuedUpdate":turns_before_update,"longestActorHoldNs":turns.iter().map(|(_,ns)|ns).max(),
        "fsyncP95Ns":flushes[1899],"fsyncP99Ns":flushes[1979],"fsyncMaxNs":flushes.last(),
        "placementTurns":turns});
    eprintln!("LINK_PUBLICATION sources=2000 diskNs={disk_ns} updateWaitNs={update_ns}");
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("publication.json"),
            evidence.to_string(),
        )
        .unwrap();
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_placement_stays_pending_and_retries_after_its_hold_is_released() {
    let f = Fixture::new(1, 1);
    let capture = f.capture.clone().lock_owned().await;
    f.pass("held-publication", Arc::new(NoFaults))
        .await
        .unwrap();
    let ws = f.ws.clone();
    f.actor.run(move |store,_| {
        store.read_with(|conn| conn.execute(
            "INSERT INTO capture_file_holds(workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested)
            VALUES(?1,'main','source-0000','source-0000.md',?2,1,'ydoc-resolution-not-representable',1,1,0)",
            params![ws,hex_sha256(BODY.as_bytes())])).map_err(StorageError::persist_public)?;
        Ok(())
    }).await.unwrap();
    drop(capture);
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if placements()
                .lock()
                .unwrap()
                .get(&f.ws)
                .is_some_and(|p| p.turns.iter().any(|(n, _)| *n == 1))
            {
                break;
            }
            f.actor.run(|_, _| Ok(())).await.unwrap();
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        BODY
    );
    assert_eq!(
        f.actor
            .history_operation_pending_jobs(f.ws.clone(), OP.into())
            .await
            .unwrap()
            .len(),
        1
    );
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            store
                .read_with(|conn| {
                    conn.execute("DELETE FROM capture_file_holds WHERE workspace_id=?1", [ws])
                })
                .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .await
        .unwrap();
    f.wait_disk(1).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_undo_before_its_plan_resumes_pending_publication() {
    let f = Fixture::new(1, 1);
    let capture = f.capture.clone().lock_owned().await;
    f.pass("cancel-undo-publication", Arc::new(NoFaults))
        .await
        .unwrap();
    let undo_gate = f.actor.link_rewrites.undo_gate.clone().lock_owned().await;
    let token = CancellationToken::new();
    {
        let undo = f.actor.history_undo_in_turns(
            f.ws.clone(),
            OP.into(),
            "cancelled-undo".into(),
            None,
            f.root.to_path_buf(),
            Arc::new(NoFaults),
            10,
            [f.capture.clone(), f.serial.clone()],
            Arc::new(()),
            None,
            token.clone(),
        );
        tokio::pin!(undo);
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(undo.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(capture);
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                if placements()
                    .lock()
                    .unwrap()
                    .get(&f.ws)
                    .is_some_and(|p| !p.turns.is_empty())
                {
                    break;
                }
                f.actor.run(|_, _| Ok(())).await.unwrap();
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
            BODY
        );
        token.cancel();
        assert!(matches!(undo.await, Err(RuntimeError::Cancelled)));
    }
    drop(undo_gate);
    f.wait_disk(1).await;
    f.close().await;
}
