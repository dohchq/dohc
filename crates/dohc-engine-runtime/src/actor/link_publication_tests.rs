use super::*;
use std::sync::mpsc::{Receiver, Sender};

#[derive(Default)]
struct Probe {
    turns: Vec<(usize, u128)>,
    pause: Option<(Arc<tokio::sync::Notify>, Receiver<()>)>,
    faults: Option<Arc<dyn FaultInjector>>,
    work: Vec<StoreWork>,
    before_attempt: Option<Arc<dyn Fn(usize) + Send + Sync>>,
}
fn placements() -> &'static Mutex<HashMap<String, Probe>> {
    static DATA: OnceLock<Mutex<HashMap<String, Probe>>> = OnceLock::new();
    DATA.get_or_init(Mutex::default)
}
pub(in crate::actor) struct Turn {
    ws: String,
    start: Instant,
    paused_ns: u128,
    staging_before: u64,
    pub(in crate::actor) jobs: usize,
}
impl Turn {
    pub(in crate::actor) fn start(ws: &str) -> Self {
        STORE_WORK.with(|cell| cell.set(Some(StoreWork::default())));
        Self {
            ws: ws.into(),
            start: Instant::now(),
            paused_ns: 0,
            staging_before: dohc_engine_storage::capture_phase::snapshot()
                .count("publication_staging_entries"),
            jobs: 0,
        }
    }
    pub(in crate::actor) fn ready(&mut self) {
        let (hook, attempt) = {
            let mut data = placements().lock().unwrap();
            let probe = data.entry(self.ws.clone()).or_default();
            (
                probe.before_attempt.clone(),
                probe.turns.iter().map(|(n, _)| n).sum::<usize>() + 1,
            )
        };
        if let Some(hook) = hook {
            hook(attempt);
        }
        let pause = placements()
            .lock()
            .unwrap()
            .entry(self.ws.clone())
            .or_default()
            .pause
            .take();
        if let Some((entered, release)) = pause {
            let start = Instant::now();
            entered.notify_one();
            release.recv().unwrap();
            self.paused_ns += start.elapsed().as_nanos();
        }
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        let mut work = STORE_WORK.with(|cell| cell.take()).unwrap();
        work.staging_entries = dohc_engine_storage::capture_phase::snapshot()
            .count("publication_staging_entries")
            - self.staging_before;
        placements()
            .lock()
            .unwrap()
            .entry(self.ws.clone())
            .or_default()
            .work
            .push(work);
        placements()
            .lock()
            .unwrap()
            .entry(self.ws.clone())
            .or_default()
            .turns
            .push((self.jobs, self.start.elapsed().as_nanos() - self.paused_ns));
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
        // A busy machine slows publication down without stopping it, so only a
        // minute in which no file lands and no pending job finishes counts as a
        // stall. A retried attempt changes neither. Reading the pending jobs
        // costs a query over the whole operation, so it runs at most once a second.
        let quiet = Duration::from_secs(60);
        let (mut next, mut since, mut read_at) = (0, Instant::now(), None::<Instant>);
        let mut pending: Option<Vec<String>> = None;
        let stalled = loop {
            let landed = next;
            while next < sources
                && std::fs::read_to_string(self.root.join(format!("source-{next:04}.md")))
                    .ok()
                    .as_deref()
                    == Some("[[new#part|label]] [[./new.md]] [old](old.md)\n")
            {
                next += 1;
            }
            if next == sources {
                break false;
            }
            if next != landed {
                since = Instant::now();
            }
            if read_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                let read = self
                    .actor
                    .history_operation_pending_jobs(self.ws.clone(), OP.into());
                let Ok(jobs) = tokio::time::timeout(quiet, read).await else {
                    break true;
                };
                let jobs = jobs.unwrap();
                read_at = Some(Instant::now());
                if pending.as_ref() != Some(&jobs) {
                    (pending, since) = (Some(jobs), Instant::now());
                }
            }
            if since.elapsed() >= quiet {
                break true;
            }
            match tokio::time::timeout(quiet, self.actor.run(|_, _| Ok(()))).await {
                Ok(result) => result.unwrap(),
                Err(_) => break true,
            }
            tokio::task::yield_now().await;
        };
        if stalled {
            // The actor may be the thing that stopped, so report the last list it gave.
            let pending = pending.map_or_else(|| "never read".into(), |jobs| format!("{jobs:?}"));
            let turns = placements()
                .lock()
                .unwrap()
                .get(&self.ws)
                .map(|p| p.turns.clone())
                .unwrap_or_default();
            let remaining: Vec<_> = (0..sources)
                .filter(|i| {
                    std::fs::read_to_string(self.root.join(format!("source-{i:04}.md")))
                        .ok()
                        .as_deref()
                        != Some("[[new#part|label]] [[./new.md]] [old](old.md)\n")
                })
                .collect();
            panic!(
                "automatic publication stalled: pending={pending}, remaining={remaining:?}, turns={}",
                turns.len()
            );
        }
        tokio::time::timeout(quiet, self.actor.run(|_, _| Ok(())))
            .await
            .expect("the actor stopped answering after publication wrote every file")
            .unwrap();
        for i in 0..sources {
            assert_eq!(
                std::fs::read_to_string(self.root.join(format!("source-{i:04}.md"))).unwrap(),
                "[[new#part|label]] [[./new.md]] [old](old.md)\n"
            );
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishes_three_closed_sources_and_an_open_document_without_a_placement_caller() {
    for open in [false, true] {
        let f = Fixture::new(3, 3).await;
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
async fn completed_receipt_restarts_unpublished_work_after_actor_restart() {
    let mut f = Fixture::new(3, 3).await;
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
async fn open_document_conflict_clears_its_claim_to_be_settled_on_disk() {
    let f = Fixture::new(1, 1).await;
    let (_lease, _) = f.open_document("source-0000").await;
    let gate = f.capture.clone().lock_owned().await;
    f.pass("open-conflict", Arc::new(NoFaults)).await.unwrap();
    let ws = f.ws.clone();
    f.actor.run(move |store, _| {
        let sha: Option<String> = store.read_with(|c| c.query_row(
            "SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND object_id='source-0000'",
            [&ws], |r| r.get(0))).map_err(StorageError::corrupt_public)?;
        assert!(sha.is_some());
        Ok(())
    }).await.unwrap();
    std::fs::write(f.root.join("source-0000.md"), "external edit").unwrap();
    drop(gate);
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let ws = f.ws.clone();
            let pending = f.actor.run(move |store, _| {
                store.read_with(|c| c.query_row(
                    "SELECT status='pending' FROM materialization_jobs WHERE workspace_id=?1 AND job_id LIKE 'ydoc-mat_%'",
                    [&ws], |r| r.get::<_, bool>(0))).map_err(|e| StorageError::corrupt_public(e).into())
            }).await.unwrap();
            if !pending { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let ws = f.ws.clone();
    f.actor.run(move |store, _| {
        store.read_with(|c| {
            let status: String = c.query_row("SELECT status FROM materialization_jobs WHERE workspace_id=?1 AND job_id LIKE 'ydoc-mat_%'", [&ws], |r| r.get(0))?;
            assert_eq!(status, "conflict");
            let sha: Option<String> = c.query_row("SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND object_id='source-0000'", [&ws], |r| r.get(0))?;
            assert_eq!(sha, None, "conflicted rewrite is not settled on disk");
            Ok::<_, rusqlite::Error>(())
        }).map_err(StorageError::corrupt_public)?;
        Ok(())
    }).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        "external edit"
    );
    assert!(std::fs::read_dir(&f.root).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".conflict")
    }));
    f.close().await;
}
fn trace_store_work(event: rusqlite::trace::TraceEvent<'_>) {
    STORE_WORK.with(|cell| {
        let Some(mut work) = cell.get() else { return };
        match event {
            rusqlite::trace::TraceEvent::Stmt(_, sql) => {
                let sql = sql.trim().to_ascii_uppercase();
                let sql = sql.strip_prefix("-- ").unwrap_or(&sql);
                if sql.starts_with("SELECT") || sql.starts_with("WITH") {
                    work.reads += 1;
                } else if ["INSERT", "UPDATE", "DELETE", "REPLACE"]
                    .iter()
                    .any(|p| sql.starts_with(p))
                {
                    work.writes += 1;
                }
            }
            rusqlite::trace::TraceEvent::Row(stmt) => {
                let sql = stmt.sql();
                if !["PRAGMA main.wal_checkpoint(", "PRAGMA busy_timeout"]
                    .iter()
                    .any(|p| {
                        sql.trim_start()
                            .get(..p.len())
                            .is_some_and(|s| s.eq_ignore_ascii_case(p))
                    })
                {
                    work.rows += 1;
                }
            }
            _ => {}
        }
        cell.set(Some(work));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_turn_has_constant_store_work_with_twenty_or_two_thousand_pending_jobs() {
    let mut counts = Vec::new();
    let mut initialization = Vec::new();
    let mut expected_staging_entries = Vec::new();
    for pending in [20, 2000] {
        let sources = pending + 1;
        let f = Fixture::new(sources, sources).await;
        let _index = f.actor.hold_link_drain();
        let ws = f.ws.clone();
        f.actor.run(move |store, _| {
            store.write_with(&NoFaults, |tx| tx.execute(
                "INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [&ws]
            ).map_err(StorageError::persist_public))?;
            Ok(())
        }).await.unwrap();
        let hold = f.capture.clone().lock_owned().await;
        f.pass("publication-work", Arc::new(NoFaults))
            .await
            .unwrap();
        let staging = f.root.join(".dohc/engine/displaced");
        std::fs::create_dir_all(&staging).unwrap();
        for i in 0..pending {
            std::fs::write(staging.join(format!("unrelated-{i}")), []).unwrap();
        }
        let ws = f.ws.clone();
        f.actor.run(move |store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,settle_seq,last_settled_sha,updated_at_ms,settled_update_seq,settle_prior_update_seq)
                    SELECT m.workspace_id,m.version_id,m.object_id,'plaintext',m.moment_order,j.content_sha256,3,0,0
                    FROM moments m JOIN materialization_jobs j ON j.job_id='authored-mat_'||m.moment_id
                    WHERE m.workspace_id=?1 AND m.metadata_correlation_id=?2 AND j.status='pending'",
                    params![ws,OP]).map_err(StorageError::persist_public)?;
                tx.execute("UPDATE materialization_jobs SET job_id='ydoc-mat_'||substr(job_id,14)
                    WHERE workspace_id=?1 AND job_id LIKE 'authored-mat_%' AND status='pending'",
                    [&ws]).map_err(StorageError::persist_public)?;
                tx.execute("INSERT INTO capture_file_holds(workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested)
                    SELECT workspace_id,version_id,object_id,path,blob_sha256,0,'ydoc-resolution-not-representable',3,1,0 FROM snapshots
                    WHERE workspace_id=?1 AND object_id LIKE 'source-%' AND object_id NOT IN ('source-0000','source-0001')",
                    [&ws]).map_err(StorageError::persist_public)?;
                Ok::<_, RuntimeError>(())
            })?;
            store.read_with(|conn| {
                let count: i64 = conn.query_row("SELECT count(*) FROM materialization_jobs WHERE workspace_id=?1 AND status='pending'",[&ws],|r|r.get(0))?;
                assert_eq!(count, sources as i64);
                Ok::<_, rusqlite::Error>(())
            }).map_err(StorageError::corrupt_public)?;
            store.hooks_with(|conn| {
                conn.trace_v2(rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT | rusqlite::trace::TraceEventCodes::SQLITE_TRACE_ROW, Some(trace_store_work))
            }).map_err(StorageError::corrupt_public)?;
            Ok(())
        }).await.unwrap();
        let (entered, release) = pause(&f.ws);
        drop(hold);
        let first = finish_one_turn(&f, entered, release).await;
        initialization.push(placements().lock().unwrap()[&f.ws].work[0]);
        let ws = f.ws.clone();
        f.actor.run(move |store,_| {
            store.read_with(|conn| {
                let actual: i64 = conn.query_row("SELECT count(*) FROM materialization_jobs WHERE workspace_id=?1 AND status='pending'",[&ws],|r|r.get(0))?;
                assert_eq!(actual, pending as i64, "measure exactly this pending population");
                Ok::<_, rusqlite::Error>(())
            }).map_err(StorageError::corrupt_public)?;
            store.write_with(&NoFaults, |tx| tx.execute("UPDATE ydoc_docs SET updated_at_ms=updated_at_ms+1 WHERE workspace_id=?1 AND object_id='source-0000'",[&ws]).map_err(StorageError::persist_public))?;
            Ok(())
        }).await.unwrap();
        expected_staging_entries.push(
            std::fs::read_dir(&staging)
                .unwrap()
                .collect::<std::io::Result<Vec<_>>>()
                .unwrap()
                .len() as u64,
        );
        let (entered, release) = pause(&f.ws);
        drop(first);
        let next = finish_one_turn(&f, entered, release).await;
        f.actor.run(|_, _| Ok(())).await.unwrap();
        let ws = f.ws.clone();
        f.actor.run(move |store, _| {
            let prior: Option<i64> = store.read_with(|conn| conn.query_row(
                "SELECT settle_prior_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND object_id='source-0001'",
                [&ws], |row| row.get(0)).map_err(StorageError::corrupt_public))?;
            assert_eq!(prior, None, "successful placement reconciles its own settlement after the status batch");
            Ok(())
        }).await.unwrap();
        let probe = placements().lock().unwrap()[&f.ws].work[1];
        counts.push(probe);
        eprintln!("PUBLICATION_WORK pending={pending} {probe:?}");
        f.close().await;
        drop(next);
    }
    let evidence = json!({"pending":[20,2000],"work":counts,"initialization":initialization});
    if let Ok(dir) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("publication-work.json"),
            evidence.to_string(),
        )
        .unwrap();
    }
    assert!(counts[0].reads > 0 && counts[0].writes > 0 && counts[0].rows > 0);
    assert_eq!(counts[0].reads, counts[1].reads);
    assert_eq!(counts[0].writes, counts[1].writes);
    assert_eq!(counts[0].rows, counts[1].rows);
    assert!(expected_staging_entries[0] >= 20);
    assert!(expected_staging_entries[1] >= 2000);
    for (actual, expected) in counts.iter().zip(expected_staging_entries) {
        assert_eq!(
            actual.staging_entries, expected,
            "one placement turn must enumerate each staging entry once"
        );
    }
}

async fn finish_one_turn(
    f: &Fixture,
    entered: Arc<tokio::sync::Notify>,
    release: Sender<()>,
) -> tokio::sync::OwnedMutexGuard<()> {
    tokio::time::timeout(Duration::from_secs(120), entered.notified())
        .await
        .unwrap();
    let next = f.capture.clone().lock_owned();
    tokio::pin!(next);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(next.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    release.send(()).unwrap();
    next.await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn many_placements_are_bounded_and_admit_a_queued_ydoc_update() {
    let f = Fixture::new(64, 65).await;
    let _index = f.actor.hold_link_drain();
    let ws = f.ws.clone();
    f.actor.run(move |store, _| {
        store.write_with(&NoFaults, |tx| tx.execute(
            "INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [&ws]
        ).map_err(StorageError::persist_public))?;
        Ok(())
    }).await.unwrap();
    let hold = f.capture.clone().lock_owned().await;
    let timings = Arc::new(FlushTimings::default());
    placements()
        .lock()
        .unwrap()
        .entry(f.ws.clone())
        .or_default()
        .faults = Some(timings.clone());
    let start = Instant::now();
    assert_eq!(
        f.pass("placement-turns", Arc::new(NoFaults)).await.unwrap()["documents"],
        64
    );
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
    let key = DocKey::new(&f.ws, "main", "source-0064").unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    let update = doc.plaintext_insert(0, "typing");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let result = f
            .actor
            .ydoc_record_update(
                key.clone(),
                "source-0064.md".into(),
                dohc_engine_collab::ContentKind::Plaintext,
                dohc_engine_collab::Regime::LocalOnly,
                update.clone(),
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
            .await;
        match result {
            Err(RuntimeError::Storage(StorageError::FileLocked))
            | Err(RuntimeError::Collab(dohc_engine_collab::CollabError::Storage(
                StorageError::FileLocked,
            ))) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            result => {
                result.unwrap();
                break;
            }
        }
    }
    let jobs_before_update: usize = placements().lock().unwrap()[&f.ws]
        .turns
        .iter()
        .take(turns_before_update)
        .map(|(n, _)| n)
        .sum();
    assert!(
        jobs_before_update <= 1,
        "queued update waits behind at most one placement: {jobs_before_update}"
    );
    let update_ns = update_start.elapsed().as_nanos();
    drop(admission);
    f.wait_disk(64).await;
    let disk_ns = start.elapsed().as_nanos();
    let turns = placements().lock().unwrap()[&f.ws].turns.clone();
    assert_eq!(turns.iter().map(|(n, _)| n).sum::<usize>(), 64);
    assert!(
        turns.iter().all(|(n, _)| *n <= 1),
        "one placement per turn: {turns:?}"
    );
    let mut flushes = timings.tails.lock().unwrap().clone();
    flushes.sort();
    assert_eq!(flushes.len(), 64);
    let evidence = json!({"sources":64,"diskNs":disk_ns,"updateWaitNs":update_ns,
        "turnsBeforeQueuedUpdate":turns_before_update,"longestActorHoldNs":turns.iter().map(|(_,ns)|ns).max(),
        "fsyncP95Ns":flushes[60],"fsyncP99Ns":flushes[63],"fsyncMaxNs":flushes.last(),
        "placementTurns":turns});
    eprintln!("LINK_PUBLICATION sources=64 diskNs={disk_ns} updateWaitNs={update_ns}");
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

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, serde::Serialize)]
struct StoreWork {
    reads: usize,
    writes: usize,
    rows: usize,
    staging_entries: u64,
}
thread_local! {
    static STORE_WORK: std::cell::Cell<Option<StoreWork>> = const { std::cell::Cell::new(None) };
}
