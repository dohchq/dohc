use super::parser::parse;
use super::{
    ACTOR_SLICE_BUDGET, Head, SETTLE_TO_INDEX_BUDGET, Staged, Work, gc_step, now_ms, prepare,
    reseed_step,
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use rusqlite::params;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct LinkDrainMetrics {
    pub actor_batches: u64,
    pub max_actor_us: u64,
    pub over_budget_batches: u64,
    pub certified_sources: u64,
    pub max_settle_to_index_ms: u64,
    pub over_settle_budget_sources: u64,
}
pub type SharedMetrics = Arc<Mutex<LinkDrainMetrics>>;

// One owned parser thread, one in-flight document, no SQLite connection.
// Results use a separate channel so actor shutdown never waits for command
// queue capacity. Dropping this owner closes and joins the parser.
pub struct DrainWorker {
    jobs: Option<mpsc::SyncSender<(Work, Option<Head>)>>,
    results: mpsc::Receiver<(Work, Result<Staged, StorageError>)>,
    thread: Option<JoinHandle<()>>,
    parsing: bool,
    staged: Option<Staged>,
    retry_at: Instant,
    metrics: SharedMetrics,
}
impl DrainWorker {
    pub fn new(metrics: SharedMetrics) -> std::io::Result<Self> {
        let (jobs, jobs_rx) = mpsc::sync_channel::<(Work, Option<Head>)>(1);
        let (results_tx, results) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("dohc-link-parser".into())
            .spawn(move || {
                while let Ok((w, h)) = jobs_rx.recv() {
                    let result = parse(w.clone(), h).map(Staged::new);
                    if results_tx.send((w, result)).is_err() {
                        break;
                    }
                }
            })?;
        Ok(Self {
            jobs: Some(jobs),
            results,
            thread: Some(thread),
            parsing: false,
            staged: None,
            retry_at: Instant::now(),
            metrics,
        })
    }
    // Called between foreground commands. Immediate work returns zero delay;
    // idle and transient failures wait without monopolizing the actor.
    pub fn tick(&mut self, store: &mut EngineStore) -> Duration {
        if Instant::now() < self.retry_at {
            return Duration::from_millis(10);
        }
        if let Ok((w, result)) = self.results.try_recv() {
            self.parsing = false;
            match result {
                Ok(staged) => self.staged = Some(staged),
                Err(error) => {
                    let _=store.write_with(&NoFaults,|tx| {
                        tx.execute("UPDATE link_pending SET retry_after_ms=?3 WHERE pending_id=?1 AND revision=?2",params![w.id,w.revision,now_ms()+1000]).map_err(super::sql)?;
                        Ok::<_,StorageError>(())
                    });
                    eprintln!("links drain deferred: {}", error.code());
                }
            }
        }
        let began = Instant::now();
        let result = self.step(store);
        let us = began.elapsed().as_micros().min(u64::MAX as u128) as u64;
        {
            let mut m = self
                .metrics
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            m.actor_batches += 1;
            m.max_actor_us = m.max_actor_us.max(us);
            m.over_budget_batches += u64::from(us > ACTOR_SLICE_BUDGET.as_micros() as u64);
        }
        match result {
            Ok(delay) => delay,
            Err(error) => {
                // Storage faults remain durable retryable work, with a bounded
                // delay. They never fail a foreground mutation or a fork.
                self.staged = None;
                self.retry_at = Instant::now() + Duration::from_secs(1);
                eprintln!("links drain deferred: {}", error.code());
                Duration::from_millis(10)
            }
        }
    }
    fn step(&mut self, store: &mut EngineStore) -> Result<Duration, StorageError> {
        if let Some(staged) = self.staged.as_mut() {
            if staged.step(store, &NoFaults)? {
                // Only count certification if this exact obligation vanished.
                let w = &staged.parsed.work;
                let certified=store.read_with(|c|c.query_row("SELECT EXISTS(SELECT 1 FROM link_sources WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND index_key=?4)",params![w.workspace,w.version,w.object,w.index_key()],|r|r.get::<_,bool>(0))).map_err(super::sql)?;
                if certified {
                    let latency = now_ms().saturating_sub(w.queued_at_ms).max(0) as u64;
                    let mut m = self
                        .metrics
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    m.certified_sources += 1;
                    m.max_settle_to_index_ms = m.max_settle_to_index_ms.max(latency);
                    m.over_settle_budget_sources +=
                        u64::from(latency > SETTLE_TO_INDEX_BUDGET.as_millis() as u64);
                }
                self.staged = None;
            }
            return Ok(Duration::ZERO);
        }
        if self.parsing {
            return Ok(Duration::from_millis(1));
        }
        if gc_step(store)? || reseed_step(store)? {
            return Ok(Duration::ZERO);
        }
        if let Some(job) = prepare(store)? {
            if self.jobs.as_ref().is_some_and(|tx| tx.send(job).is_ok()) {
                self.parsing = true;
            } else {
                return Err(StorageError::InvalidInput {
                    reason: "link parser stopped",
                });
            }
            Ok(Duration::from_millis(1))
        } else {
            let pending = store
                .read_with(|c| {
                    c.query_row("SELECT EXISTS(SELECT 1 FROM link_pending)", [], |r| {
                        r.get::<_, bool>(0)
                    })
                })
                .map_err(super::sql)?;
            Ok(if pending {
                Duration::from_secs(1)
            } else {
                Duration::MAX
            })
        }
    }
}
impl Drop for DrainWorker {
    fn drop(&mut self) {
        drop(self.jobs.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
