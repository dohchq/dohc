//! Streaming SHA-256 content hashing behind a **fixed-size** worker pool.
//!
//! Two bounds live here (`plan §Rust policy`; `PORTING.md` §14):
//! - **Bounded read buffer.** Each worker owns ONE reusable buffer of
//!   `read_buffer_bytes`; a file is streamed through it, never slurped whole.
//!   Total hashing memory is `read_buffer_bytes * workers`.
//! - **Bounded concurrency.** The pool has a fixed number of worker threads
//!   created once at construction; work is fed in batches of at most `workers`,
//!   so in-flight hashes never exceed the pool size. There is no
//!   `thread::spawn`-per-file (the banned unbounded-spawn shape). A
//!   [`PoolGauge`] records the observed peak concurrency so a test can *assert*
//!   the cap, not merely trust it.
//!
//! Cancellation is cooperative and lands BETWEEN bounded units: the batch loop
//! checks the token before each batch, and a single large file's stream loop
//! checks it between buffer reads (`PORTING.md` §12 — never mid-durable-step;
//! a content hash has no durable step to tear).

use crate::error::FilesError;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::JoinHandle;
use tokio_util::sync::CancellationToken;

/// One file to hash, tagged with its position in the caller's listing so
/// results reassemble deterministically regardless of completion order.
#[derive(Debug, Clone)]
pub struct HashInput {
    pub index: usize,
    pub abs: PathBuf,
}

/// The result of hashing one input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HashOutcome {
    /// Hashed to completion.
    Hashed { sha256: String, bytes: u64 },
    /// The token tripped while streaming this file; nothing durable produced.
    Cancelled,
    /// The file vanished between enumeration and open (a benign mid-scan race,
    /// skipped — mirrors the tolerant TS/kernel scan).
    Vanished,
    /// A non-benign io error; the scan surfaces this as
    /// [`FilesError::ScanIo`].
    Io { kind: std::io::ErrorKind },
}

/// The outcome of a whole batched hash run.
#[derive(Debug)]
pub enum HashRun {
    /// Every input hashed (or was individually classified Vanished/Io);
    /// `outcomes[i]` corresponds to `inputs[i]`.
    Completed { outcomes: Vec<HashOutcome> },
    /// The run stopped at a between-batch cancellation boundary; no listing is
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
    /// `read_buffer_bytes` buffer.
    pub fn new(workers: usize, read_buffer_bytes: usize) -> Result<Self, FilesError> {
        if workers == 0 || read_buffer_bytes == 0 {
            return Err(FilesError::PoolUnavailable {
                reason: "hash pool needs a non-zero worker count and buffer size",
            });
        }
        // Bounded queues: the job channel holds at most `workers` queued jobs,
        // matching the batch size; the result channel likewise. Neither can
        // grow unbounded.
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
                .spawn(move || worker_main(&job_rx, &result_tx, &gauge, read_buffer_bytes))
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
    /// batches. `outcomes[i]` corresponds to `inputs[i]`.
    pub fn hash_batched(
        &self,
        inputs: &[HashInput],
        token: &CancellationToken,
    ) -> Result<HashRun, FilesError> {
        let Some(job_tx) = self.job_tx.as_ref() else {
            return Err(FilesError::PoolUnavailable {
                reason: "hash pool has been torn down",
            });
        };
        let mut slots: Vec<Option<HashOutcome>> = (0..inputs.len()).map(|_| None).collect();

        for batch in inputs.chunks(self.workers) {
            // Cancellation point: BETWEEN batches (a bounded unit), before any
            // of this batch's jobs are submitted.
            if token.is_cancelled() {
                return Ok(HashRun::Cancelled);
            }
            // Submit ≤ workers jobs (channel capacity == workers, so these
            // never block beyond a worker picking one up).
            for input in batch {
                job_tx
                    .send(Job {
                        index: input.index,
                        abs: input.abs.clone(),
                        token: token.clone(),
                    })
                    .map_err(|_| FilesError::PoolUnavailable {
                        reason: "hash pool job channel closed",
                    })?;
            }
            // Drain exactly this batch's results before submitting the next —
            // this is what bounds in-flight work to `workers`.
            for _ in 0..batch.len() {
                let indexed = self
                    .result_rx
                    .recv()
                    .map_err(|_| FilesError::PoolUnavailable {
                        reason: "hash pool result channel closed",
                    })?;
                if let Some(slot) = slots.get_mut(indexed.index) {
                    *slot = Some(indexed.outcome);
                }
            }
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
    read_buffer_bytes: usize,
) {
    // One reusable buffer per worker — the bounded read buffer.
    let mut buffer = vec![0u8; read_buffer_bytes];
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
        let outcome = hash_one(&job, &mut buffer);
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

fn hash_one(job: &Job, buffer: &mut [u8]) -> HashOutcome {
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
        if let Some(chunk) = buffer.get(..read) {
            hasher.update(chunk);
        }
    }
    HashOutcome::Hashed {
        sha256: to_hex(&hasher.finalize()),
        bytes,
    }
}

/// Lowercase-hex encode a digest without allocating twice or risking a panic
/// (writing to a `String` is infallible).
fn to_hex(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
