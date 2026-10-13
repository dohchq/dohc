use super::parser::parse;
use super::{
    ACTOR_SLICE_BUDGET, Prepared, SETTLE_TO_INDEX_BUDGET, Staged, Work, defer_sources, gc_step,
    now_ms, prepare_batch, reseed_step, seed_step, stage_batch,
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct LinkDrainMetrics {
    #[cfg(test)]
    pub(crate) worker_starts: u64,
    #[cfg(test)]
    pub(crate) worker_starts_at_publication: Option<u64>,
    #[cfg(test)]
    pub(crate) actor_batches_at_publication: Option<u64>,
    pub actor_batches: u64,
    pub max_actor_us: u64,
    pub total_actor_us: u64,
    pub over_budget_batches: u64,
    pub certified_sources: u64,
    pub max_settle_to_index_ms: u64,
    pub over_settle_budget_sources: u64,
}
pub type SharedMetrics = Arc<Mutex<LinkDrainMetrics>>;
type ParserResult = Vec<(Work, Result<Staged, StorageError>)>;
type ParserJobs = Vec<Prepared>;

// One owned parser thread, one in-flight bounded batch, no SQLite connection.
// Results use a separate channel so actor shutdown never waits for command
// queue capacity. Dropping this owner closes and joins the parser.
pub struct DrainWorker {
    jobs: Option<mpsc::SyncSender<ParserJobs>>,
    results: tokio::sync::mpsc::UnboundedReceiver<ParserResult>,
    ready_result: Option<ParserResult>,
    thread: Option<JoinHandle<()>>,
    parsing: bool,
    staged: std::collections::VecDeque<Staged>,
    retry_at: Instant,
    metrics: SharedMetrics,
    #[cfg(test)]
    measurement_initialized: bool,
    #[cfg(test)]
    phase: &'static str,
}
impl DrainWorker {
    pub fn new(metrics: SharedMetrics) -> std::io::Result<Self> {
        let (jobs, jobs_rx) = mpsc::sync_channel::<ParserJobs>(1);
        let (results_tx, results) = tokio::sync::mpsc::unbounded_channel();
        let thread = std::thread::Builder::new()
            .name("dohc-link-parser".into())
            .spawn(move || {
                while let Ok(jobs) = jobs_rx.recv() {
                    let result = jobs
                        .into_iter()
                        .map(|(w, h)| {
                            let result = h.and_then(|h| parse(w.clone(), h)).map(Staged::new);
                            (w, result)
                        })
                        .collect();
                    if results_tx.send(result).is_err() {
                        break;
                    }
                }
            })?;
        #[cfg(test)]
        {
            metrics.lock().unwrap().worker_starts += 1;
        }
        Ok(Self {
            jobs: Some(jobs),
            results,
            ready_result: None,
            thread: Some(thread),
            parsing: false,
            staged: std::collections::VecDeque::new(),
            retry_at: Instant::now(),
            metrics,
            #[cfg(test)]
            measurement_initialized: false,
            #[cfg(test)]
            phase: "prepare",
        })
    }
    pub fn waiting_for_parser(&self) -> bool {
        self.parsing
    }
    // recv is cancellation-safe when a foreground command wins the actor wait.
    // Keep the result for the next tick so SQLite work stays outside the wait.
    pub async fn parser_finished(&mut self) {
        self.ready_result = self.results.recv().await;
        if self.ready_result.is_none() {
            self.parsing = false;
        }
    }
    // Called between foreground commands. Immediate work returns zero delay;
    // idle and transient failures wait without monopolizing the actor.
    pub fn tick(&mut self, store: &mut EngineStore) -> Duration {
        if store.is_passive() {
            return Duration::MAX;
        }
        #[cfg(feature = "fault-injection")]
        let mut phase =
            dohc_engine_storage::capture_phase::Phase::new("link_drain_tick", None, 0, true);
        #[cfg(test)]
        {
            if !self.measurement_initialized {
                super::tests::observe_checkpoints(store);
                self.measurement_initialized = true;
            }
            super::tests::begin_tick_measurement();
            self.phase = "prepare";
        }
        let began = Instant::now();
        let delay = self.tick_inner(store);
        let mut m = self
            .metrics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let us = began.elapsed().as_micros().min(u64::MAX as u128) as u64;
        m.actor_batches += 1;
        m.max_actor_us = m.max_actor_us.max(us);
        m.total_actor_us = m.total_actor_us.saturating_add(us);
        m.over_budget_batches += u64::from(us > ACTOR_SLICE_BUDGET.as_micros() as u64);
        #[cfg(test)]
        super::tests::report_slow_tick(Duration::from_micros(us), self.phase);
        #[cfg(feature = "fault-injection")]
        {
            phase.field("actor_us", us);
            phase.finish("completed");
        }
        delay
    }
    fn tick_inner(&mut self, store: &mut EngineStore) -> Duration {
        if Instant::now() < self.retry_at {
            return Duration::from_millis(10);
        }
        if let Some(results) = self
            .ready_result
            .take()
            .or_else(|| self.results.try_recv().ok())
        {
            self.parsing = false;
            let mut failed_sources = Vec::new();
            for (w, result) in results {
                match result {
                    Ok(staged) => self.staged.push_back(staged),
                    Err(error) => {
                        failed_sources.push(w);
                        eprintln!("links drain deferred: {}", error.code());
                    }
                }
            }
            if !failed_sources.is_empty() {
                if let Err(error) = defer_sources(store, &failed_sources) {
                    self.staged.clear();
                    self.retry_at = Instant::now() + Duration::from_secs(1);
                    eprintln!("links drain deferred: {}", error.code());
                }
                // Retry markers and staging each get their own actor slice.
                return Duration::ZERO;
            }
        }
        let result = self.step(store);
        match result {
            Ok(delay) => delay,
            Err(error) => {
                // Storage faults remain durable retryable work, with a bounded
                // delay. They never fail a foreground mutation or a fork.
                self.staged.clear();
                self.retry_at = Instant::now() + Duration::from_secs(1);
                eprintln!("links drain deferred: {}", error.code());
                Duration::from_millis(10)
            }
        }
    }
    fn step(&mut self, store: &mut EngineStore) -> Result<Duration, StorageError> {
        if !self.staged.is_empty() {
            #[cfg(test)]
            {
                self.phase = "stage";
            }
            let certified = stage_batch(&mut self.staged, store, &NoFaults)?;
            let mut m = self
                .metrics
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for w in certified {
                let latency = now_ms().saturating_sub(w.queued_at_ms).max(0) as u64;
                m.certified_sources += 1;
                m.max_settle_to_index_ms = m.max_settle_to_index_ms.max(latency);
                m.over_settle_budget_sources +=
                    u64::from(latency > SETTLE_TO_INDEX_BUDGET.as_millis() as u64);
            }
            return Ok(Duration::ZERO);
        }
        if self.parsing {
            return Ok(Duration::MAX);
        }
        if seed_step(store)? {
            return Ok(Duration::ZERO);
        }
        let jobs = prepare_batch(store, super::SOURCE_SLICE)?;
        if !jobs.is_empty() {
            if self.jobs.as_ref().is_some_and(|tx| tx.send(jobs).is_ok()) {
                self.parsing = true;
            } else {
                return Err(StorageError::InvalidInput {
                    reason: "link parser stopped",
                });
            }
            Ok(Duration::MAX)
        } else {
            // Obsolete generations are invisible to readers. Drain pending
            // sources first; cleanup runs only with no parse or staging active.
            #[cfg(test)]
            {
                self.phase = "cleanup";
            }
            if gc_step(store)? || reseed_step(store)? {
                return Ok(Duration::ZERO);
            }
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
