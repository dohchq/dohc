//! Streaming SHA-256 content hashing behind a **fixed-size** worker pool.
//!
//! Two bounds live here:
//! - **Bounded read buffer.** Each worker owns one reusable buffer of
//!   `read_buffer_bytes`; a file is streamed through it, never slurped whole.
//!   Total hashing memory is `read_buffer_bytes * workers`.
//! - **Bounded concurrency.** The pool has a fixed number of worker threads
//!   created once at construction; at most `workers` jobs remain outstanding,
//!   so in-flight hashes never exceed the pool size. There is no
//!   `thread::spawn`-per-file (the banned unbounded-spawn shape). A
//!   [`PoolGauge`] records the observed peak concurrency so a test can *assert*
//!   the cap, not merely trust it.
//!
//! Cancellation is cooperative and lands between bounded units: the coordinator
//! checks the token before each submission, and a single large file's stream loop
//! checks it between buffer reads (never mid-durable-step; a content hash has
//! no durable step to tear).

use crate::error::FilesError;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::JoinHandle;
use std::time::UNIX_EPOCH;
use tokio_util::sync::CancellationToken;

/// One file to hash, tagged with its position in the caller's listing so
/// results reassemble deterministically regardless of completion order.
#[derive(Debug, Clone)]
pub struct HashInput {
    pub index: usize,
    pub abs: PathBuf,
}

/// The enumerate-time path state a scanner wants fenced by a post-hash stat.
#[derive(Debug, Clone)]
pub(crate) struct PostHashExpectation {
    pub probe_path: Option<String>,
    pub size: u64,
    pub mtime_ms: i64,
}

pub(crate) type PostHashProbe = Arc<dyn Fn(&str) -> Option<std::io::ErrorKind> + Send + Sync>;

/// The result of hashing one input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HashOutcome {
    /// Hashed to completion.
    Hashed {
        sha256: String,
        bytes: u64,
        /// Enumerate-time mtime retained only when the path still has the
        /// expected size and mtime after the byte stream is hashed. Zero when
        /// the caller did not request a fence or the path drifted.
        stable_mtime_ms: i64,
    },
    /// The token tripped while streaming this file; nothing durable produced.
    Cancelled,
    /// The file vanished between enumeration and open (a benign mid-scan race,
    /// skipped — mirrors the tolerant TS/kernel scan).
    Vanished,
    /// The streamed byte count exceeded `max_file_bytes` — the file grew or was
    /// replaced after enumeration measured it under the cap. The stream is
    /// abandoned at the boundary (never reading unbounded data); the scan moves
    /// the path into `skipped` (over-cap), the same disposition enumeration
    /// gives a file it saw over the cap.
    OverCap,
    /// A non-benign io error; the scan surfaces this as
    /// [`FilesError::ScanIo`].
    Io { kind: std::io::ErrorKind },
    /// The hash job panicked (contained by the worker's `catch_unwind`, so the
    /// worker survives and the run still yields a result instead of wedging).
    /// The scan surfaces this as a fail-closed [`FilesError::PoolUnavailable`].
    Panicked,
}

/// The outcome of a whole batched hash run.
#[derive(Debug)]
pub enum HashRun {
    /// Every input hashed (or was individually classified Vanished/Io);
    /// `outcomes[i]` corresponds to `inputs[i]`.
    Completed { outcomes: Vec<HashOutcome> },
    /// The run stopped before submitting another hash job; no listing is
    /// produced.
    Cancelled,
}

/// Observed concurrency + throughput of the pool, for bound assertions.
#[derive(Debug, Default)]
pub struct PoolGauge {
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    hashed: AtomicUsize,
}

impl PoolGauge {
    fn enter(&self) {
        // `+1` cannot overflow: in-flight is bounded by the pool size.
        let now = self
            .in_flight
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        self.max_in_flight.fetch_max(now, Ordering::AcqRel);
    }

    fn leave(&self) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        self.hashed.fetch_add(1, Ordering::AcqRel);
    }

    /// The peak number of files hashed concurrently since construction. A test
    /// asserts this never exceeds the configured pool size.
    pub fn max_concurrent(&self) -> usize {
        self.max_in_flight.load(Ordering::Acquire)
    }

    /// The total number of hash attempts completed.
    pub fn hashed(&self) -> usize {
        self.hashed.load(Ordering::Acquire)
    }
}

struct Job {
    index: usize,
    abs: PathBuf,
    token: CancellationToken,
    post_hash: Option<PostHashExpectation>,
    post_hash_probe: Option<PostHashProbe>,
}

/// Immutable per-worker config: the streaming read buffer size and the file-size
/// cap enforced while streaming (a second defense against a file that grows past
/// the cap between enumeration and hashing).
#[derive(Clone, Copy)]
struct WorkerConfig {
    read_buffer_bytes: usize,
    max_file_bytes: u64,
}

struct Indexed {
    index: usize,
    outcome: HashOutcome,
}

/// A fixed-size hash-worker pool. Owns its worker threads; dropping it tears
/// them down deterministically (drop the job channel so every `recv` ends, then
/// join every worker — no detached thread outlives the pool).
pub struct HashPool {
    workers: usize,
    job_tx: Option<SyncSender<Job>>,
    result_rx: Receiver<Indexed>,
    handles: Vec<JoinHandle<()>>,
    gauge: Arc<PoolGauge>,
}

impl HashPool {
    /// Create a pool with `workers` threads, each streaming through a
    /// `read_buffer_bytes` buffer and enforcing `max_file_bytes` mid-stream.
    pub fn new(
        workers: usize,
        read_buffer_bytes: usize,
        max_file_bytes: u64,
    ) -> Result<Self, FilesError> {
        if workers == 0 || read_buffer_bytes == 0 {
            return Err(FilesError::PoolUnavailable {
                reason: "hash pool needs a non-zero worker count and buffer size",
            });
        }
        let config = WorkerConfig {
            read_buffer_bytes,
            max_file_bytes,
        };
        // Bounded queues: the job channel holds at most `workers` queued jobs,
        // matching the outstanding-work cap; the result channel likewise.
        // Neither can grow unbounded.
        let (job_tx, job_rx) = sync_channel::<Job>(workers);
        let (result_tx, result_rx) = sync_channel::<Indexed>(workers);
        let job_rx = Arc::new(std::sync::Mutex::new(job_rx));
        let gauge = Arc::new(PoolGauge::default());

        let mut handles = Vec::with_capacity(workers);
        for n in 0..workers {
            let job_rx = Arc::clone(&job_rx);
            let result_tx = result_tx.clone();
            let gauge = Arc::clone(&gauge);
            let handle = std::thread::Builder::new()
                .name(format!("dohc-hash-{n}"))
                .spawn(move || worker_main(&job_rx, &result_tx, &gauge, config))
                .map_err(|_| FilesError::PoolUnavailable {
                    reason: "could not spawn hash worker thread",
                })?;
            handles.push(handle);
        }

        Ok(HashPool {
            workers,
            job_tx: Some(job_tx),
            result_rx,
            handles,
            gauge,
        })
    }

    /// The fixed pool size.
    pub fn workers(&self) -> usize {
        self.workers
    }

    /// The concurrency gauge (for bound assertions).
    pub fn gauge(&self) -> &Arc<PoolGauge> {
        &self.gauge
    }

    /// Hash every input, at most `workers` at a time, cancellable between
    /// submissions. `outcomes[i]` corresponds to `inputs[i]`.
    pub fn hash_batched(
        &self,
        inputs: &[HashInput],
        token: &CancellationToken,
    ) -> Result<HashRun, FilesError> {
        self.hash_batched_inner(inputs, None, None, token)
    }

    /// Hash scanner inputs and fence each successful read with the path's
    /// enumerate-time size/mtime pair before the worker takes another job.
    pub(crate) fn hash_batched_with_post_stat(
        &self,
        inputs: &[HashInput],
        expectations: &[PostHashExpectation],
        probe: Option<PostHashProbe>,
        token: &CancellationToken,
    ) -> Result<HashRun, FilesError> {
        if inputs.len() != expectations.len() {
            return Err(FilesError::PoolUnavailable {
                reason: "post-hash expectation count did not match hash inputs",
            });
        }
        self.hash_batched_inner(inputs, Some(expectations), probe, token)
    }

    fn hash_batched_inner(
        &self,
        inputs: &[HashInput],
        expectations: Option<&[PostHashExpectation]>,
        probe: Option<PostHashProbe>,
        token: &CancellationToken,
    ) -> Result<HashRun, FilesError> {
        let Some(job_tx) = self.job_tx.as_ref() else {
            return Err(FilesError::PoolUnavailable {
                reason: "hash pool has been torn down",
            });
        };
        let mut slots: Vec<Option<HashOutcome>> = (0..inputs.len()).map(|_| None).collect();

        let mut next = 0;
        let mut outstanding = 0;
        let mut cancelled = false;
        let mut panicked = false;

        loop {
            while !cancelled && !panicked && outstanding < self.workers && next < inputs.len() {
                if token.is_cancelled() {
                    cancelled = true;
                    break;
                }
                let input = &inputs[next];
                job_tx
                    .send(Job {
                        index: input.index,
                        abs: input.abs.clone(),
                        token: token.clone(),
                        post_hash: expectations
                            .and_then(|items| items.get(input.index))
                            .cloned(),
                        post_hash_probe: probe.clone(),
                    })
                    .map_err(|_| FilesError::PoolUnavailable {
                        reason: "hash pool job channel closed",
                    })?;
                next += 1;
                outstanding += 1;
            }
            if outstanding == 0 {
                break;
            }
            let indexed = self
                .result_rx
                .recv()
                .map_err(|_| FilesError::PoolUnavailable {
                    reason: "hash pool result channel closed",
                })?;
            outstanding -= 1;
            // Drain submitted jobs before returning so this pool can be reused.
            if indexed.outcome == HashOutcome::Panicked {
                panicked = true;
            } else if let Some(slot) = slots.get_mut(indexed.index) {
                *slot = Some(indexed.outcome);
            }
        }
        if panicked {
            return Err(FilesError::PoolUnavailable {
                reason: "a hash worker panicked",
            });
        }
        if cancelled {
            return Ok(HashRun::Cancelled);
        }

        // Every slot must be filled — a missing one is an internal accounting
        // bug, surfaced as a pool error rather than a panic.
        let mut outcomes = Vec::with_capacity(slots.len());
        for slot in slots {
            match slot {
                Some(outcome) => outcomes.push(outcome),
                None => {
                    return Err(FilesError::PoolUnavailable {
                        reason: "hash pool dropped a result",
                    });
                }
            }
        }
        Ok(HashRun::Completed { outcomes })
    }
}

impl Drop for HashPool {
    fn drop(&mut self) {
        // Deterministic teardown: close the job channel first so every worker's
        // blocking `recv` returns `Err` and the loop exits, THEN join. No
        // detached worker outlives the pool.
        self.job_tx = None;
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

fn worker_main(
    job_rx: &std::sync::Mutex<Receiver<Job>>,
    result_tx: &SyncSender<Indexed>,
    gauge: &PoolGauge,
    config: WorkerConfig,
) {
    // One reusable buffer per worker — the bounded read buffer.
    let mut buffer = vec![0u8; config.read_buffer_bytes];
    loop {
        // Hold the receiver lock only to take one job, never across the hash.
        let job = {
            let rx = job_rx.lock().unwrap_or_else(|poison| poison.into_inner());
            match rx.recv() {
                Ok(job) => job,
                // The pool dropped the sender: no more work, exit.
                Err(_) => return,
            }
        };
        gauge.enter();
        // Contain a panicking hash so a poisoned job never wedges the coordinator's
        // result drain (`recv` would otherwise block forever waiting on a
        // result the dead worker can't produce). The worker survives and the
        // run surfaces a typed, fail-closed outcome.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            hash_one(&job, &mut buffer, config.max_file_bytes)
        }))
        .unwrap_or(HashOutcome::Panicked);
        gauge.leave();
        // If the result channel is gone the pool is being torn down; stop.
        if result_tx
            .send(Indexed {
                index: job.index,
                outcome,
            })
            .is_err()
        {
            return;
        }
    }
}

/// Test-only panic injection: when set, a hash job whose absolute path contains
/// this marker panics, exercising the worker's `catch_unwind` wedge defense.
/// Compiled out entirely in non-test builds (zero production cost).
#[cfg(test)]
pub(crate) static TEST_PANIC_ON: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn hash_one(job: &Job, buffer: &mut [u8], max_file_bytes: u64) -> HashOutcome {
    #[cfg(test)]
    {
        let marker = TEST_PANIC_ON
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        if let Some(marker) = marker
            && job.abs.to_string_lossy().contains(&marker)
        {
            panic!("injected hash worker panic (test)");
        }
    }
    let mut file = match std::fs::File::open(&job.abs) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return HashOutcome::Vanished,
        Err(err) => return HashOutcome::Io { kind: err.kind() },
    };
    let mut hasher = Sha256::new();
    let mut bytes: u64 = 0;
    loop {
        // Cooperative cancellation between buffer reads of a single large file.
        if job.token.is_cancelled() {
            return HashOutcome::Cancelled;
        }
        let read = match file.read(buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return HashOutcome::Vanished,
            Err(err) => return HashOutcome::Io { kind: err.kind() },
        };
        bytes = bytes.saturating_add(read as u64);
        // Enforce the size cap while streaming: a file that grew past the cap
        // after enumeration is abandoned at the boundary, never read unbounded.
        if bytes > max_file_bytes {
            return HashOutcome::OverCap;
        }
        if let Some(chunk) = buffer.get(..read) {
            hasher.update(chunk);
        }
    }
    let stable_mtime_ms = match &job.post_hash {
        None => 0,
        Some(expectation) => {
            if let Some(kind) = job
                .post_hash_probe
                .as_ref()
                .zip(expectation.probe_path.as_deref())
                .and_then(|(probe, path)| probe(path))
            {
                return HashOutcome::Io { kind };
            }
            if post_hash_identity_matches(&file, &job.abs, expectation) {
                expectation.mtime_ms
            } else {
                0
            }
        }
    };
    HashOutcome::Hashed {
        sha256: dohc_engine_storage::hex(&hasher.finalize()),
        bytes,
        stable_mtime_ms,
    }
}

fn metadata_matches(metadata: &std::fs::Metadata, expectation: &PostHashExpectation) -> bool {
    metadata.is_file()
        && metadata.len() == expectation.size
        && mtime_ms(metadata) == expectation.mtime_ms
}

fn post_hash_identity_matches(
    hashed_file: &std::fs::File,
    current_path: &std::path::Path,
    expectation: &PostHashExpectation,
) -> bool {
    let Ok(hashed_metadata) = hashed_file.metadata() else {
        return false;
    };
    let Ok(current_file) = std::fs::File::open(current_path) else {
        return false;
    };
    let Ok(current_metadata) = current_file.metadata() else {
        return false;
    };
    if !metadata_matches(&hashed_metadata, expectation)
        || !metadata_matches(&current_metadata, expectation)
    {
        return false;
    }
    let Ok(hashed_clone) = hashed_file.try_clone() else {
        return false;
    };
    matches!(
        (
            same_file::Handle::from_file(hashed_clone),
            same_file::Handle::from_file(current_file),
        ),
        (Ok(hashed), Ok(current)) if hashed == current
    )
}

/// Milliseconds since the Unix epoch for a file's mtime, or `0` when the
/// platform cannot supply it or the time predates the epoch. A zero mtime is
/// "no observation": it never authorizes hash reuse, so the fallback fails
/// safe toward hashing.
pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    #[test]
    fn worker_panic_fails_closed_without_wedging() {
        let dir = ScratchDir::new_named("hashtest-panic").expect("temp dir");
        for i in 0..6 {
            std::fs::write(dir.join(format!("f{i}.txt")), b"data").expect("write");
        }
        // The job whose path contains "f3.txt" panics the worker mid-hash.
        *TEST_PANIC_ON.lock().unwrap_or_else(|p| p.into_inner()) = Some("f3.txt".to_owned());

        let pool = HashPool::new(2, 4096, u64::MAX).expect("pool");
        let inputs: Vec<HashInput> = (0..6)
            .map(|i| HashInput {
                index: i,
                abs: dir.join(format!("f{i}.txt")),
            })
            .collect();
        let token = CancellationToken::new();

        // Run on a side thread so a REGRESSION (a wedge/hang) surfaces as a
        // bounded test failure rather than hanging the whole suite.
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = pool.hash_batched(&inputs, &token);
            let _ = tx.send(matches!(result, Err(FilesError::PoolUnavailable { .. })));
        });
        let got = rx.recv_timeout(std::time::Duration::from_secs(10));
        *TEST_PANIC_ON.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let _ = worker.join();

        assert_eq!(
            got,
            Ok(true),
            "a panicking hash worker must fail closed (PoolUnavailable) in bounded time, not hang"
        );
    }

    #[test]
    fn streaming_enforces_the_size_cap() {
        // A file larger than the pool's cap is abandoned mid-stream and
        // classified OverCap — the defense against a file that grew past the cap
        // after enumeration measured it under the cap.
        let dir = ScratchDir::new_named("hashtest-overcap").expect("temp dir");
        std::fs::write(dir.join("big.bin"), vec![b'z'; 10_000]).expect("write");
        std::fs::write(dir.join("small.bin"), b"tiny").expect("write");

        // 64-byte cap, 16-byte buffer → the cap trips after a couple of reads.
        let pool = HashPool::new(1, 16, 64).expect("pool");
        let inputs = vec![
            HashInput {
                index: 0,
                abs: dir.join("big.bin"),
            },
            HashInput {
                index: 1,
                abs: dir.join("small.bin"),
            },
        ];
        let run = pool
            .hash_batched(&inputs, &CancellationToken::new())
            .expect("run");
        let HashRun::Completed { outcomes } = run else {
            panic!("expected completion");
        };
        assert_eq!(outcomes[0], HashOutcome::OverCap, "over-cap file abandoned");
        assert!(
            matches!(outcomes[1], HashOutcome::Hashed { bytes: 4, .. }),
            "under-cap file still hashed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod scheduler_tests {
    use super::*;
    use std::sync::mpsc::{TryRecvError, channel};
    use std::time::Duration;

    const DEADLINE: Duration = Duration::from_secs(10);
    type RunResult = (Result<HashRun, FilesError>, HashPool);

    // Real coordinator, controlled worker replies. Dropping either test-side
    // channel releases a blocked coordinator even if an assertion fails.
    fn controlled_pool(workers: usize) -> (HashPool, Receiver<Job>, SyncSender<Indexed>) {
        let (job_tx, job_rx) = sync_channel(workers);
        let (result_tx, result_rx) = sync_channel(workers);
        let pool = HashPool {
            workers,
            job_tx: Some(job_tx),
            result_rx,
            handles: Vec::new(),
            gauge: Arc::new(PoolGauge::default()),
        };
        (pool, job_rx, result_tx)
    }

    fn inputs(count: usize) -> Vec<HashInput> {
        (0..count)
            .map(|index| HashInput {
                index,
                abs: PathBuf::from(format!("file-{index}")),
            })
            .collect()
    }

    fn start(pool: HashPool, count: usize, token: CancellationToken) -> Receiver<RunResult> {
        let (done_tx, done_rx) = channel();
        std::thread::spawn(move || {
            let result = pool.hash_batched(&inputs(count), &token);
            let _ = done_tx.send((result, pool));
        });
        done_rx
    }

    fn hashed(value: &str) -> HashOutcome {
        HashOutcome::Hashed {
            sha256: value.to_owned(),
            bytes: 1,
            stable_mtime_ms: 0,
        }
    }

    fn reply(sender: &SyncSender<Indexed>, job: Job, outcome: HashOutcome) {
        sender
            .try_send(Indexed {
                index: job.index,
                outcome,
            })
            .expect("bounded reply queue must have room");
    }

    fn completed(result: Result<HashRun, FilesError>) -> Vec<HashOutcome> {
        match result.expect("hash run") {
            HashRun::Completed { outcomes } => outcomes,
            HashRun::Cancelled => panic!("unexpected cancellation"),
        }
    }

    #[test]
    fn completed_slot_refills_before_the_slowest_job_and_preserves_order() {
        let (pool, jobs, replies) = controlled_pool(2);
        let done = start(pool, 4, CancellationToken::new());
        let first = jobs.recv_timeout(DEADLINE).expect("first job");
        let second = jobs.recv_timeout(DEADLINE).expect("second job");
        assert_eq!((first.index, second.index), (0, 1));
        assert!(matches!(jobs.try_recv(), Err(TryRecvError::Empty)));

        reply(&replies, second, hashed("second"));
        let third = jobs
            .recv_timeout(DEADLINE)
            .expect("refill while first is held");
        assert_eq!(third.index, 2);
        assert!(matches!(jobs.try_recv(), Err(TryRecvError::Empty)));
        reply(&replies, third, hashed("third"));
        let fourth = jobs.recv_timeout(DEADLINE).expect("second refill");
        assert_eq!(fourth.index, 3);
        reply(&replies, fourth, hashed("fourth"));
        reply(&replies, first, hashed("first"));

        let (result, _pool) = done.recv_timeout(DEADLINE).expect("run completes");
        assert_eq!(
            completed(result),
            vec![
                hashed("first"),
                hashed("second"),
                hashed("third"),
                hashed("fourth")
            ]
        );
    }

    #[test]
    fn cancellation_drains_outstanding_results_before_pool_reuse() {
        let (pool, jobs, replies) = controlled_pool(2);
        let token = CancellationToken::new();
        let done = start(pool, 4, token.clone());
        let first = jobs.recv_timeout(DEADLINE).expect("first job");
        let second = jobs.recv_timeout(DEADLINE).expect("second job");
        token.cancel();
        reply(&replies, second, HashOutcome::Cancelled);
        reply(&replies, first, hashed("old"));

        let (result, pool) = done.recv_timeout(DEADLINE).expect("cancelled run drains");
        assert!(matches!(result, Ok(HashRun::Cancelled)));
        assert!(matches!(jobs.try_recv(), Err(TryRecvError::Empty)));
        let done = start(pool, 1, CancellationToken::new());
        let fresh = jobs.recv_timeout(DEADLINE).expect("reuse job");
        reply(&replies, fresh, hashed("new"));
        let (result, _pool) = done.recv_timeout(DEADLINE).expect("reused run completes");
        assert_eq!(completed(result), vec![hashed("new")]);
    }

    #[test]
    fn panic_drains_an_earlier_held_result_before_pool_reuse() {
        let (pool, jobs, replies) = controlled_pool(2);
        let done = start(pool, 4, CancellationToken::new());
        let held = jobs.recv_timeout(DEADLINE).expect("held job");
        let panicking = jobs.recv_timeout(DEADLINE).expect("panicking job");
        // FIFO delivery guarantees the coordinator observes the panic before
        // the held job's result, independent of thread scheduling.
        reply(&replies, panicking, HashOutcome::Panicked);
        reply(&replies, held, hashed("old"));
        let (result, pool) = done.recv_timeout(DEADLINE).expect("panic run drains");
        assert!(matches!(result, Err(FilesError::PoolUnavailable { .. })));
        assert!(matches!(jobs.try_recv(), Err(TryRecvError::Empty)));

        let done = start(pool, 1, CancellationToken::new());
        let fresh = jobs.recv_timeout(DEADLINE).expect("reuse job");
        reply(&replies, fresh, hashed("new"));
        let (result, _pool) = done.recv_timeout(DEADLINE).expect("reused run completes");
        assert_eq!(completed(result), vec![hashed("new")]);
    }

    #[test]
    fn empty_and_precancelled_runs_preserve_submission_semantics() {
        let (pool, jobs, _replies) = controlled_pool(2);
        let token = CancellationToken::new();
        token.cancel();
        assert!(completed(pool.hash_batched(&[], &token)).is_empty());
        assert!(completed(pool.hash_batched(&[], &CancellationToken::new())).is_empty());
        assert!(matches!(
            pool.hash_batched(&inputs(1), &token),
            Ok(HashRun::Cancelled)
        ));
        assert!(matches!(jobs.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn cancellation_after_the_last_submission_keeps_completed_outcomes() {
        let (pool, jobs, replies) = controlled_pool(2);
        let token = CancellationToken::new();
        let done = start(pool, 2, token.clone());
        let first = jobs.recv_timeout(DEADLINE).expect("first job");
        let second = jobs.recv_timeout(DEADLINE).expect("second job");
        token.cancel();
        reply(&replies, second, HashOutcome::Cancelled);
        reply(&replies, first, HashOutcome::Cancelled);
        let (result, _pool) = done.recv_timeout(DEADLINE).expect("final jobs drain");
        assert_eq!(completed(result), vec![HashOutcome::Cancelled; 2]);
    }
}
