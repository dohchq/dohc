//! A held document's proof, run off the store's actor. The proof reads one
//! committed snapshot on a read-only connection of its own, which closes
//! before its answer is handed over. What it read beyond the evidence the
//! document's released tail generation covers, its caller names by bounded
//! coordinates and compares again on the actor before releasing the answer.
//! A workspace has one proof at a time until it ends, shared by the callers
//! that ask the same of the same state, and stopped once none of them waits, its
//! store closes, its store's WAL needs its reader gone, or its deadline
//! passes. A daemon runs a few proofs at once, within a memory budget its
//! proofs and their results share: a proof takes more of it before it holds
//! more than its reservation, while it works or in what its result keeps,
//! and a result keeps only what fits.
use super::binding::MAX_ARTIFACT_BYTES;
use super::*;
use crate::ContentKind;
use dohc_engine_storage::{HeldReader, WalPressure};
use std::sync::atomic::AtomicU8;
use std::time::{Duration, Instant};

/// The most callers one proof answers.
pub const MAX_PROOF_WAITERS: usize = 8;

/// The longest a proof runs from its admission, however many callers join.
pub const HELD_PROOF_DEADLINE: Duration = Duration::from_secs(60);

/// How long its store's close, or a held read's last caller, waits for a
/// stopped proof's reader to close: twice SQLite's busy timeout. A stopped
/// proof ends at its next statement step or stage check; between them it
/// may wait out that timeout, or replay, merge or encode one document's
/// state.
pub const HELD_PROOF_CLOSE_BOUND: Duration =
    Duration::from_millis(2 * dohc_engine_storage::ENGINE_SQLITE_BUSY_TIMEOUT_MS as u64);

/// How long a proof's reader waits out a lock. Neither the progress handler
/// nor a stage check runs while SQLite waits, so this stays below half
/// [`HELD_PROOF_CLOSE_BOUND`].
const READER_BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// The proofs one daemon runs at once, across all its stores.
const MAX_RUNNING_PROOFS: usize = 2;

/// What a starting proof reserves of its daemon's proof memory: what most
/// proofs hold while they work and keep, a contribution artifact up to the
/// 64 MiB a blob streams included. A proof takes more before it holds more.
const PROOF_RESERVATION_BYTES: u64 = 128 << 20;

/// The memory a daemon's running proofs, and the results their callers
/// still hold, may keep.
const PROOF_MEMORY_BYTES: u64 = 2 * PROOF_RESERVATION_BYTES;

/// The held-document proofs of one store's actor. A workspace has at most
/// one, from admission until it ends, its encoding after its reader closed
/// included. A caller whose request `K` is the workspace's proof joins it,
/// up to [`MAX_PROOF_WAITERS`] callers, and shares its result `T`; any other
/// request for the workspace is busy until that proof ends, never queued,
/// and so is a new proof beyond its daemon's [`HeldProofLimit`] or while the
/// store's WAL presses on held readers. Each caller leaves on its own, and
/// the last to leave stops the proof, queued or running: its reader at its
/// next statement, within [`READER_STEP_OPS`] steps of the one running, and
/// the proof itself at its next [`Stop::check`]. [`Self::close`] stops every
/// proof and waits, bounded, for their readers to close, those still opening
/// included, but not for a proof that only encodes.
pub struct HeldProofs<K, T>(Arc<Proofs<K, T>>);

/// What the proofs' handles and their blocking threads share. The lock is
/// held only to admit and hand over, never while a proof reads.
struct Proofs<K, T> {
    state: Mutex<ProofState<K, T>>,
    readers: Arc<OpenReaders>,
    limit: HeldProofLimit,
    #[cfg(any(test, feature = "test-support"))]
    gate: Arc<Gate>,
}

/// How many readers a store's proofs hold open, which its close waits for.
/// A reader counts from before its connection opens, under this lock, which
/// close takes once it stopped every proof: so close waits for a reader
/// opening as for one open, and none starts opening after close began.
#[derive(Default)]
struct OpenReaders {
    open: Mutex<usize>,
    /// Wakes [`HeldProofs::close`] once a proof's reader closes.
    closed: Condvar,
}

struct ProofState<K, T> {
    /// Each workspace's proof, by workspace ID, until it ends.
    running: HashMap<String, Arc<Proof<K, T>>>,
    closed: bool,
    /// How long a proof admitted now may run.
    deadline: Duration,
    /// How long close waits for proofs' readers to close.
    close_bound: Duration,
    /// The largest contribution artifact a proof admitted now encodes.
    artifact_cap: usize,
    #[cfg(any(test, feature = "test-support"))]
    admitted: u64,
}

/// One admitted proof, and everyone waiting for it.
struct Proof<K, T> {
    workspace_id: String,
    key: K,
    job: HeldProofJob,
    outcome: Mutex<ProofOutcome<T>>,
}

struct ProofOutcome<T> {
    result: Option<Result<Arc<Charged<T>>, HeldProofError>>,
    /// Each [`HeldProofWait`] still waiting, by its number, with the task it
    /// last polled from.
    waiters: HashMap<u64, Option<Waker>>,
    next_waiter: u64,
    /// The proof ended: its reader closed, or it never opened one.
    ended: bool,
    /// Tasks waiting for that.
    stopping: Vec<Waker>,
}

/// Why a proof answered nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HeldProofError {
    /// The store is closing; nothing proves for it any more.
    #[error("the store closed before the held document was proved")]
    Closed,
    /// The store's WAL needed the proof's reader gone, or the proof reached
    /// its deadline. Its caller asks again later.
    #[error("the held document's proof gave way to the store's writes or its deadline")]
    Busy,
    /// What the proof holds while it works, or its result keeps, is more
    /// than its daemon's proof memory holds. Asking again answers the same.
    #[error("the held document's answer is larger than a held read may keep")]
    TooLarge,
    #[error("the held document's proof panicked")]
    Panicked,
}

/// What [`HeldProofs::admit`] answers.
pub enum HeldProofAdmission<K, T> {
    /// A new proof, which the caller runs on a blocking thread of its own,
    /// and the caller's wait for it.
    Started(HeldProofRun<K, T>, HeldProofWait<K, T>),
    /// The workspace's running proof, which asks the same.
    Joined(HeldProofWait<K, T>),
    /// The workspace has a proof that asks something else, one stopping, or
    /// one with as many callers as it answers; or its daemon runs as many
    /// proofs as it may, or the store's WAL presses on held readers.
    Busy,
    Closed,
}

/// Why a proof stopped, once it did. The first reason holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofStop {
    /// Nobody waits for it any more.
    Cancelled = 1,
    /// Its store closed.
    Closed = 2,
    /// Its store's WAL needed its reader gone.
    Preempted = 3,
    /// It reached its deadline.
    Deadline = 4,
    /// Its daemon's proof memory could not hold more of what it works with
    /// or its result keeps until other proofs and results free theirs.
    Memory = 5,
    /// What it works with or its result keeps would never fit: more than its
    /// daemon's proof memory.
    TooLarge = 6,
}

impl ProofStop {
    fn of(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Cancelled),
            2 => Some(Self::Closed),
            3 => Some(Self::Preempted),
            4 => Some(Self::Deadline),
            5 => Some(Self::Memory),
            6 => Some(Self::TooLarge),
            _ => None,
        }
    }

    /// What a proof stopped for this answers whoever still waits.
    fn error(self) -> HeldProofError {
        match self {
            Self::Preempted | Self::Deadline | Self::Memory => HeldProofError::Busy,
            Self::TooLarge => HeldProofError::TooLarge,
            Self::Cancelled | Self::Closed => HeldProofError::Closed,
        }
    }
}

/// What a proof, its reader's progress handler and its stage checks share
/// to stop: the reason it stopped, its deadline, and its store's WAL
/// pressure, which counts only while its reader is open.
struct Halt {
    reason: AtomicU8,
    deadline: Option<Instant>,
    pressure: Option<Arc<WalPressure>>,
    reading: AtomicBool,
    /// Its reader closed; it opens no other.
    read: AtomicBool,
}

impl Halt {
    fn new(deadline: Option<Instant>, pressure: Option<Arc<WalPressure>>) -> Self {
        Self {
            reason: AtomicU8::new(0),
            deadline,
            pressure,
            reading: AtomicBool::new(false),
            read: AtomicBool::new(false),
        }
    }

    /// Whether the proof's reader closed.
    fn read(&self) -> bool {
        self.read.load(Ordering::Acquire)
    }

    fn stop(&self, reason: ProofStop) {
        let _ = self
            .reason
            .compare_exchange(0, reason as u8, Ordering::AcqRel, Ordering::Acquire);
    }

    /// Why the proof stopped, as recorded.
    fn reason(&self) -> Option<ProofStop> {
        ProofStop::of(self.reason.load(Ordering::Acquire))
    }

    /// Why the proof should stop now, if it should, recording WAL pressure
    /// or the deadline when either is the first to end it.
    fn stopped(&self) -> Option<ProofStop> {
        if self.reason().is_none() {
            if self.reading.load(Ordering::Relaxed)
                && self
                    .pressure
                    .as_ref()
                    .is_some_and(|pressure| pressure.raised())
            {
                self.stop(ProofStop::Preempted);
            } else if self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                self.stop(ProofStop::Deadline);
            }
        }
        self.reason()
    }
}

/// What every store's held proofs share in one daemon: how many run at once,
/// and the memory they and the results their callers still hold keep, which
/// never passes its capacity. A proof takes its reservation only when it
/// starts, and is busy beyond it, never queued; it takes more before it
/// holds more than that, while it works or in what its result keeps, and is
/// busy or too large when that does not fit. It frees its place once its
/// reader closed and its result is handed over, and its result keeps what
/// fits of its memory until the last caller drops it.
#[derive(Clone)]
pub struct HeldProofLimit(Arc<Mutex<Budget>>);

struct Budget {
    running: usize,
    max_running: usize,
    /// Never more than `capacity`.
    reserved: u64,
    capacity: u64,
    reservation: u64,
    /// The most ever reserved at once.
    #[cfg(any(test, feature = "test-support"))]
    peak: u64,
}

impl Budget {
    /// Replace `held` of the bytes reserved with `bytes`, unless that would
    /// pass capacity: too large when `bytes` alone would, and short of
    /// memory while others hold theirs.
    fn replace(&mut self, held: u64, bytes: u64) -> Result<(), ProofStop> {
        let others = self.reserved - held;
        if bytes > self.capacity {
            return Err(ProofStop::TooLarge);
        }
        if others.saturating_add(bytes) > self.capacity {
            return Err(ProofStop::Memory);
        }
        self.reserve(others + bytes);
        Ok(())
    }

    fn reserve(&mut self, reserved: u64) {
        self.reserved = reserved;
        #[cfg(any(test, feature = "test-support"))]
        {
            self.peak = self.peak.max(reserved);
        }
    }
}

impl Default for HeldProofLimit {
    fn default() -> Self {
        Self::new(
            MAX_RUNNING_PROOFS,
            PROOF_MEMORY_BYTES,
            PROOF_RESERVATION_BYTES,
        )
    }
}

impl HeldProofLimit {
    /// `running` proofs at once, within `capacity` bytes for them and their
    /// results, each reserving `reservation` bytes when it starts.
    pub fn new(running: usize, capacity: u64, reservation: u64) -> Self {
        Self(Arc::new(Mutex::new(Budget {
            running: 0,
            max_running: running,
            reserved: 0,
            capacity,
            reservation,
            #[cfg(any(test, feature = "test-support"))]
            peak: 0,
        })))
    }

    fn refuses(&self) -> bool {
        let budget = lock(&self.0);
        budget.running >= budget.max_running
            || budget.reserved.saturating_add(budget.reservation) > budget.capacity
    }

    fn start(&self) -> Option<ProofPermit> {
        let mut budget = lock(&self.0);
        if budget.running >= budget.max_running
            || budget.reserved.saturating_add(budget.reservation) > budget.capacity
        {
            return None;
        }
        budget.running += 1;
        let reserved = budget.reserved + budget.reservation;
        budget.reserve(reserved);
        Some(ProofPermit {
            memory: Arc::new(ProofMemory {
                limit: self.clone(),
                taken: Mutex::new(Taken {
                    held: budget.reservation,
                    kept: 0,
                    working: 0,
                }),
            }),
        })
    }

    /// The bytes running proofs reserve and results keep charged.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn reserved_bytes(&self) -> u64 {
        lock(&self.0).reserved
    }

    /// The most bytes ever reserved and charged at once.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn peak_reserved_bytes(&self) -> u64 {
        lock(&self.0).peak
    }
}

/// A running proof's place in its daemon's limit, with the memory it holds,
/// which goes back when the permit drops unless its result took it.
struct ProofPermit {
    memory: Arc<ProofMemory>,
}

/// What a running proof holds of its daemon's proof memory, which its job
/// grows through [`Stop::reserve`] and [`Work::grow`].
struct ProofMemory {
    limit: HeldProofLimit,
    taken: Mutex<Taken>,
}

struct Taken {
    /// Bytes the proof holds of its daemon's proof memory: its reservation,
    /// and what more it took. None once its result took them or it ended.
    held: u64,
    /// Bytes of what its result keeps that the proof reserved so far.
    kept: u64,
    /// Bytes its work holds now, which its result never keeps.
    working: u64,
}

impl Taken {
    /// Hold at least `needed` bytes, taking more of `limit`'s memory when
    /// they pass what is held; why not, when that does not fit.
    fn cover(&mut self, limit: &HeldProofLimit, needed: u64) -> Result<(), ProofStop> {
        if needed > self.held {
            lock(&limit.0).replace(self.held, needed)?;
            self.held = needed;
        }
        Ok(())
    }
}

impl ProofMemory {
    /// Reserve `bytes` more of what the proof's result keeps, before they
    /// are allocated, beside what its work holds.
    fn reserve(&self, bytes: u64) -> Result<(), ProofStop> {
        let mut taken = lock(&self.taken);
        let kept = taken.kept.saturating_add(bytes);
        let needed = kept.saturating_add(taken.working);
        taken.cover(&self.limit, needed)?;
        taken.kept = kept;
        Ok(())
    }

    /// Reserve `bytes` more of what the proof's work holds, before they are
    /// allocated, beside what its result keeps.
    fn work(&self, bytes: u64) -> Result<(), ProofStop> {
        let mut taken = lock(&self.taken);
        let working = taken.working.saturating_add(bytes);
        let needed = working.saturating_add(taken.kept);
        taken.cover(&self.limit, needed)?;
        taken.working = working;
        Ok(())
    }

    /// The proof's work freed `bytes`. What it took stays held until it ends.
    fn worked(&self, bytes: u64) {
        let mut taken = lock(&self.taken);
        taken.working = taken.working.saturating_sub(bytes);
    }
}

impl ProofPermit {
    /// Turn the memory the proof holds into the charge of a result that
    /// keeps `retained` bytes, unless that would pass capacity; the place
    /// stays taken until the permit drops.
    fn charge(&self, retained: u64) -> Result<ProofCharge, HeldProofError> {
        let mut taken = lock(&self.memory.taken);
        lock(&self.memory.limit.0)
            .replace(taken.held, retained)
            .map_err(ProofStop::error)?;
        taken.held = 0;
        Ok(ProofCharge {
            limit: self.memory.limit.clone(),
            bytes: retained,
        })
    }
}

impl Drop for ProofPermit {
    fn drop(&mut self) {
        let mut taken = lock(&self.memory.taken);
        let mut budget = lock(&self.memory.limit.0);
        budget.running -= 1;
        budget.reserved -= taken.held;
        taken.held = 0;
    }
}

/// The memory a proof's result keeps charged.
struct ProofCharge {
    limit: HeldProofLimit,
    bytes: u64,
}

impl Drop for ProofCharge {
    fn drop(&mut self) {
        lock(&self.limit.0).reserved -= self.bytes;
    }
}

/// A proof's result, which keeps its charge against its daemon's proof
/// memory until the last of its holders drops it.
pub struct Charged<T> {
    value: T,
    _charge: Option<ProofCharge>,
}

impl<T> std::ops::Deref for Charged<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T: std::fmt::Debug> std::fmt::Debug for Charged<T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(&self.value, formatter)
    }
}

impl<K, T> Clone for HeldProofs<K, T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<K, T> HeldProofs<K, T> {
    /// A store's proofs, within its daemon's `limit`.
    pub fn new(limit: HeldProofLimit) -> Self {
        Self(Arc::new(Proofs {
            state: Mutex::new(ProofState {
                running: HashMap::new(),
                closed: false,
                deadline: HELD_PROOF_DEADLINE,
                close_bound: HELD_PROOF_CLOSE_BOUND,
                artifact_cap: MAX_ARTIFACT_BYTES,
                #[cfg(any(test, feature = "test-support"))]
                admitted: 0,
            }),
            readers: Arc::default(),
            limit,
            #[cfg(any(test, feature = "test-support"))]
            gate: Arc::default(),
        }))
    }

    /// Whether a request for `workspace_id` is busy whatever it asks, which
    /// reads nothing: its proof is stopping or answers as many callers as it
    /// can; or with none the daemon runs as many proofs as it may.
    pub fn refuses(&self, workspace_id: &str) -> bool {
        let state = lock(&self.0.state);
        if state.closed {
            return false;
        }
        match state.running.get(workspace_id) {
            Some(proof) => {
                proof.job.halt.stopped().is_some()
                    || lock(&proof.outcome).waiters.len() >= MAX_PROOF_WAITERS
            }
            None => self.0.limit.refuses(),
        }
    }
}

impl<K: PartialEq, T> HeldProofs<K, T> {
    /// A proof of `store`'s committed state for `workspace_id`, asking `key`,
    /// or a wait for the workspace's proof when it asks the same. Admitting a
    /// new proof measures the store's WAL and nothing else, after the
    /// writer's bounded checkpoint when it presses and no held reader holds
    /// it; see [`dohc_engine_storage::EngineStore::measure_wal_pressure`].
    pub fn admit(
        &self,
        store: &dohc_engine_storage::EngineStore,
        workspace_id: &str,
        key: K,
    ) -> Result<HeldProofAdmission<K, T>, dohc_engine_storage::StorageError> {
        let mut state = lock(&self.0.state);
        if state.closed {
            return Ok(HeldProofAdmission::Closed);
        }
        if let Some(proof) = state.running.get(workspace_id) {
            return Ok(match proof.join(&key) {
                Some(wait) => HeldProofAdmission::Joined(wait),
                None => HeldProofAdmission::Busy,
            });
        }
        if store.measure_wal_pressure()? {
            return Ok(HeldProofAdmission::Busy);
        }
        let Some(permit) = self.0.limit.start() else {
            return Ok(HeldProofAdmission::Busy);
        };
        let proof = Arc::new(Proof {
            workspace_id: workspace_id.to_owned(),
            key,
            job: HeldProofJob {
                opening: store.opening(),
                path: store.database_path().to_owned(),
                halt: Arc::new(Halt::new(
                    Some(Instant::now() + state.deadline),
                    Some(store.wal_pressure()),
                )),
                memory: Some(Arc::clone(&permit.memory)),
                artifact_cap: state.artifact_cap,
                readers: Arc::clone(&self.0.readers),
                #[cfg(any(test, feature = "test-support"))]
                gate: Arc::clone(&self.0.gate),
            },
            outcome: Mutex::new(ProofOutcome {
                result: None,
                waiters: HashMap::new(),
                next_waiter: 0,
                ended: false,
                stopping: Vec::new(),
            }),
        });
        state
            .running
            .insert(workspace_id.to_owned(), Arc::clone(&proof));
        #[cfg(any(test, feature = "test-support"))]
        {
            state.admitted += 1;
        }
        let wait = proof.wait();
        Ok(HeldProofAdmission::Started(
            HeldProofRun {
                proofs: Arc::clone(&self.0),
                proof: Some(proof),
                permit: Some(permit),
            },
            wait,
        ))
    }
}

impl<K, T> HeldProofs<K, T> {
    /// Stop proving for good: refuse new proofs, stop queued and running
    /// ones, answer everyone waiting as closed, and wait, within
    /// [`HELD_PROOF_CLOSE_BOUND`] of this call, for every reader a proof
    /// opened or is opening to close; no proof starts opening one once this
    /// began, and a proof still encoding its answer is not waited for.
    /// Whether they all closed. Call it off the actor, before the store's
    /// files are replaced.
    pub fn close(&self) -> bool {
        let mut state = lock(&self.0.state);
        let deadline = Instant::now() + state.close_bound;
        state.closed = true;
        let proofs: Vec<_> = state.running.values().cloned().collect();
        drop(state);
        // Each stops before close takes the readers' lock below, so a reader
        // not yet counted finds its proof stopped.
        for proof in &proofs {
            proof.job.stop_for(ProofStop::Closed);
            proof.complete(Err(HeldProofError::Closed));
        }
        #[cfg(any(test, feature = "test-support"))]
        if !self.drained() {
            self.0.gate.closing();
        }
        let mut open = lock(&self.0.readers.open);
        while *open > 0 {
            let Some(left) = deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
            else {
                return false;
            };
            open = self
                .0
                .readers
                .closed
                .wait_timeout(open, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    /// Whether every reader a proof opened, or began opening, has closed.
    pub fn drained(&self) -> bool {
        *lock(&self.0.readers.open) == 0
    }
}

impl<K: PartialEq, T> Proof<K, T> {
    /// A new caller of this proof, while it asks `key`, is not stopping and
    /// answers fewer callers than it can. Decided and recorded under the
    /// lock the last caller leaves under, so a joiner never joins a proof
    /// that caller stops.
    fn join(self: &Arc<Self>, key: &K) -> Option<HeldProofWait<K, T>> {
        let mut outcome = lock(&self.outcome);
        if self.key != *key
            || self.job.halt.stopped().is_some()
            || outcome.waiters.len() >= MAX_PROOF_WAITERS
        {
            return None;
        }
        let waiter = outcome.add_waiter();
        drop(outcome);
        self.job.wake();
        Some(HeldProofWait {
            proof: Some(Arc::clone(self)),
            waiter,
        })
    }
}

impl<T> ProofOutcome<T> {
    fn add_waiter(&mut self) -> u64 {
        let waiter = self.next_waiter;
        self.next_waiter += 1;
        self.waiters.insert(waiter, None);
        waiter
    }
}

impl<K, T> Proof<K, T> {
    /// The caller that admitted this proof.
    fn wait(self: &Arc<Self>) -> HeldProofWait<K, T> {
        let waiter = lock(&self.outcome).add_waiter();
        self.job.wake();
        HeldProofWait {
            proof: Some(Arc::clone(self)),
            waiter,
        }
    }

    /// Answer everyone waiting with `result`, unless they were answered.
    fn complete(&self, result: Result<Arc<Charged<T>>, HeldProofError>) {
        let waiters = {
            let mut outcome = lock(&self.outcome);
            if outcome.result.is_none() {
                outcome.result = Some(result);
            }
            std::mem::take(&mut outcome.waiters)
        };
        for waker in waiters.into_values().flatten() {
            waker.wake();
        }
    }

    /// `waiter` stops waiting. When it was the last caller of a proof not
    /// yet answered, the proof stops too, under the lock joining takes;
    /// whether it did.
    fn leave(&self, waiter: u64) -> bool {
        let mut outcome = lock(&self.outcome);
        if outcome.waiters.remove(&waiter).is_none()
            || outcome.result.is_some()
            || !outcome.waiters.is_empty()
        {
            return false;
        }
        self.job.halt.stop(ProofStop::Cancelled);
        drop(outcome);
        #[cfg(any(test, feature = "test-support"))]
        self.job.gate.leaving();
        self.job.wake();
        true
    }
}

/// An admitted proof, for its first caller to run on a blocking thread of
/// its own, with its place in its daemon's limit. Dropped unrun, it ends as
/// closed, and its workspace and place are free.
#[must_use]
pub struct HeldProofRun<K, T> {
    proofs: Arc<Proofs<K, T>>,
    proof: Option<Arc<Proof<K, T>>>,
    permit: Option<ProofPermit>,
}

impl<K, T> HeldProofRun<K, T> {
    /// Run `prove` on this thread with the proof's job, unless it stopped or
    /// its store closed first, and answer whoever still waits. `prove`
    /// answers the result and the bytes it keeps, which stay charged until
    /// the last caller drops it, and reserves through [`Stop::reserve`]
    /// before it grows them past the proof's reservation. A result whose
    /// bytes do not fit the daemon's proof memory answers busy, or too large
    /// when they never would. `prove` opens at most one reader and closes it
    /// before it returns, a panic's unwinding included; the workspace takes
    /// another proof once this one ends. A proof stopped meanwhile answers
    /// nobody, whatever `prove` returned: an interrupted reader is a stop,
    /// never a storage failure. One preempted, past its deadline or short of
    /// memory answers busy.
    pub fn prove(mut self, prove: impl FnOnce(&HeldProofJob) -> (T, u64)) {
        let Some(proof) = self.proof.take() else {
            return;
        };
        // Decided under the lock close marks the proofs closed under, so a
        // proof that starts after close began runs nothing.
        let starts = !lock(&self.proofs.state).closed && proof.job.halt.stopped().is_none();
        let result = starts.then(|| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prove(&proof.job)))
                .map_err(|_| HeldProofError::Panicked)
        });
        self.end(&proof, result);
    }

    /// Free the proof's place in its workspace, answer its callers, then
    /// free its place in the daemon's limit.
    fn end(&mut self, proof: &Arc<Proof<K, T>>, result: Option<Result<(T, u64), HeldProofError>>) {
        {
            let mut state = lock(&self.proofs.state);
            if state
                .running
                .get(&proof.workspace_id)
                .is_some_and(|running| Arc::ptr_eq(running, proof))
            {
                state.running.remove(&proof.workspace_id);
            }
        }
        // A stopped proof has nobody to answer, unless close answered them,
        // or it gave way to writes, its deadline or its memory.
        let result = match (result, proof.job.halt.reason()) {
            (Some(Ok((value, retained))), None) => self
                .permit
                .as_ref()
                .map(|permit| permit.charge(retained))
                .transpose()
                .map(|charge| {
                    Arc::new(Charged {
                        value,
                        _charge: charge,
                    })
                }),
            (Some(Err(panicked)), None) => Err(panicked),
            (_, Some(stop)) => Err(stop.error()),
            (None, None) => Err(HeldProofError::Closed),
        };
        let stopping = {
            let mut outcome = lock(&proof.outcome);
            outcome.ended = true;
            std::mem::take(&mut outcome.stopping)
        };
        proof.complete(result);
        drop(self.permit.take());
        for waker in stopping {
            waker.wake();
        }
    }
}

impl<K, T> Drop for HeldProofRun<K, T> {
    fn drop(&mut self) {
        if let Some(proof) = self.proof.take() {
            self.end(&proof, None);
        }
    }
}

/// One caller's wait for a proof, whichever caller started it. Dropping it,
/// or [`Self::leave`], stops waiting; when nobody else waits, the proof
/// stops too, queued or running.
#[must_use]
pub struct HeldProofWait<K, T> {
    proof: Option<Arc<Proof<K, T>>>,
    waiter: u64,
}

impl<K, T> HeldProofWait<K, T> {
    /// Stop waiting, as dropping does. Completes once the proof ended, its
    /// reader closed, when this stopped it, and at once otherwise.
    pub fn leave(mut self) -> HeldProofStop<K, T> {
        let waiter = self.waiter;
        HeldProofStop(self.proof.take().filter(|proof| proof.leave(waiter)))
    }
}

impl<K, T> Drop for HeldProofWait<K, T> {
    fn drop(&mut self) {
        if let Some(proof) = self.proof.take() {
            proof.leave(self.waiter);
        }
    }
}

impl<K, T> std::future::Future for HeldProofWait<K, T> {
    type Output = Result<Arc<Charged<T>>, HeldProofError>;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> Poll<Self::Output> {
        let this = self.get_mut();
        let Some(proof) = &this.proof else {
            return Poll::Ready(Err(HeldProofError::Closed));
        };
        let mut outcome = lock(&proof.outcome);
        if let Some(result) = &outcome.result {
            return Poll::Ready(result.clone());
        }
        if let Some(slot) = outcome.waiters.get_mut(&this.waiter) {
            if !slot
                .as_ref()
                .is_some_and(|waker| waker.will_wake(context.waker()))
            {
                *slot = Some(context.waker().clone());
            }
        }
        Poll::Pending
    }
}

/// Completes once a proof its last caller stopped has ended, its reader
/// closed.
#[must_use]
pub struct HeldProofStop<K, T>(Option<Arc<Proof<K, T>>>);

impl<K, T> std::future::Future for HeldProofStop<K, T> {
    type Output = ();

    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> Poll<Self::Output> {
        let Some(proof) = &self.0 else {
            return Poll::Ready(());
        };
        let mut outcome = lock(&proof.outcome);
        if outcome.ended {
            return Poll::Ready(());
        }
        if !outcome
            .stopping
            .iter()
            .any(|waker| waker.will_wake(context.waker()))
        {
            outcome.stopping.push(context.waker().clone());
        }
        Poll::Pending
    }
}

/// One held-document proof of a store's committed state: the open of the
/// store it reads, and whether it should stop.
pub struct HeldProofJob {
    opening: u64,
    path: std::path::PathBuf,
    /// Why it stops, once it should. Its reader stops at its next statement,
    /// and within [`READER_STEP_OPS`] steps of the one running.
    halt: Arc<Halt>,
    /// What it holds of its daemon's proof memory; none for a proof nothing
    /// limits.
    memory: Option<Arc<ProofMemory>>,
    /// The largest contribution artifact it encodes.
    artifact_cap: usize,
    /// The readers its store's proofs hold open, its own among them.
    readers: Arc<OpenReaders>,
    #[cfg(any(test, feature = "test-support"))]
    gate: Arc<Gate>,
}

impl HeldProofJob {
    /// A proof of `store`'s committed state that nothing coalesces, limits
    /// or stops, for a caller with no actor.
    pub fn of(store: &dohc_engine_storage::EngineStore) -> Self {
        Self {
            opening: store.opening(),
            path: store.database_path().to_owned(),
            halt: Arc::new(Halt::new(None, None)),
            memory: None,
            artifact_cap: MAX_ARTIFACT_BYTES,
            readers: Arc::default(),
            #[cfg(any(test, feature = "test-support"))]
            gate: Arc::default(),
        }
    }

    /// The open of the store the proof reads.
    pub fn opening(&self) -> u64 {
        self.opening
    }

    /// Stop the proof for `reason`, unless it stopped already: its reader at
    /// its next statement, and the proof itself at its next check.
    fn stop_for(&self, reason: ProofStop) {
        self.halt.stop(reason);
        self.wake();
    }

    fn wake(&self) {
        #[cfg(any(test, feature = "test-support"))]
        self.gate.wake();
    }

    /// Why the proof should stop, once it should.
    pub fn stopped(&self) -> Option<ProofStop> {
        self.halt.stopped()
    }

    /// What the proof checks between the units of work it does outside
    /// SQLite.
    pub fn stop(&self) -> Stop<'_> {
        Stop(Some(self))
    }

    /// The proof's read-only connection to its store, which never
    /// checkpoints it, stops once the proof should, and counts as a held
    /// reader of the store's WAL until it closes. It counts as its store's
    /// open reader from before it opens, so close waits for it, bounded,
    /// while it opens. None starts opening once the proof stopped, or once
    /// its one reader closed, and one that opened as the proof stopped closes
    /// again. A store that is busy or cannot open is locked, never corrupt.
    pub fn reader(&self) -> Result<ProofReader, ApplicationError> {
        #[cfg(any(test, feature = "test-support"))]
        self.gate.before_open();
        let closed = {
            let mut open = lock(&self.readers.open);
            if self.halt.stopped().is_some() || self.halt.read() {
                return Err(ApplicationError::Cancelled);
            }
            *open += 1;
            ReaderClosed {
                halt: Arc::clone(&self.halt),
                readers: Arc::clone(&self.readers),
            }
        };
        #[cfg(any(test, feature = "test-support"))]
        self.gate.inside_open();
        let conn = open_reader(&self.path)?;
        conn.busy_timeout(READER_BUSY_TIMEOUT)
            .map_err(open_failure)?;
        let halt = Arc::clone(&self.halt);
        conn.progress_handler(READER_STEP_OPS, Some(move || halt.stopped().is_some()))
            .map_err(open_failure)?;
        if self.halt.stopped().is_some() {
            return Err(ApplicationError::Cancelled);
        }
        let held = self.halt.pressure.as_ref().map(WalPressure::hold);
        self.halt.reading.store(true, Ordering::Relaxed);
        #[cfg(any(test, feature = "test-support"))]
        self.gate.opened();
        Ok(ProofReader {
            conn,
            _held: held,
            _closed: closed,
        })
    }

    /// Begin the proof's one deferred read transaction on `reader` and fix
    /// its snapshot with the transaction's first read, the store's identity,
    /// before the proof reads anything else. Every later read of the
    /// transaction, the hold and its freshness included, sees that snapshot.
    /// A store that is busy or cannot be read is locked, never corrupt.
    pub fn snapshot<'c>(
        &self,
        reader: &'c mut Connection,
    ) -> Result<(Transaction<'c>, String), ApplicationError> {
        let tx = reader.transaction().map_err(open_failure)?;
        let engine = identity(&tx, open_failure)?;
        #[cfg(any(test, feature = "test-support"))]
        self.gate.stall(&tx)?;
        self.stop().check(ProofStage::Snapshot)?;
        Ok((tx, engine))
    }
}

/// A proof's reader: its connection, counted as a held reader of its store's
/// WAL until it closes. Fields drop in order, so the connection has closed
/// before the reader counts as closed.
pub struct ProofReader {
    conn: Connection,
    _held: Option<HeldReader>,
    _closed: ReaderClosed,
}

/// Marks a proof's reader closed once its connection has, for its store's
/// close and its workspace's next proof.
struct ReaderClosed {
    halt: Arc<Halt>,
    readers: Arc<OpenReaders>,
}

impl Drop for ReaderClosed {
    fn drop(&mut self) {
        self.halt.reading.store(false, Ordering::Relaxed);
        self.halt.read.store(true, Ordering::Release);
        *lock(&self.readers.open) -= 1;
        self.readers.closed.notify_all();
    }
}

impl std::ops::Deref for ProofReader {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

impl std::ops::DerefMut for ProofReader {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

/// Where a held proof checks whether to stop, between the units of work it
/// does outside SQLite, whose statements the reader's progress handler stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofStage {
    /// Once its snapshot is fixed, before it reads the hold.
    Snapshot,
    /// Before the lineage's state loads, before each of its blobs loads and
    /// applies, and before and after it is hashed.
    Replay,
    /// Before a tail's manifest decodes, and before each retained entry's
    /// evidence is validated.
    Validation,
    /// Before the merge starts, before each contribution's bytes load, and
    /// again before they apply.
    Merge,
    /// Around the merged state's projection and its encoding.
    Projection,
    /// Before the contribution artifact is encoded, every 1,024 of its
    /// binding's tails and of its contributions, and around each hash, once
    /// the reader closed.
    Encoding,
}

/// What a read checks to stop between its stages: a held proof's job, or
/// nothing for a read nobody stops.
#[derive(Clone, Copy)]
pub struct Stop<'a>(Option<&'a HeldProofJob>);

impl Stop<'static> {
    pub const NEVER: Self = Stop(None);
}

impl<'a> Stop<'a> {
    /// Cancelled once the proof should stop, for whichever reason.
    pub fn check(self, stage: ProofStage) -> Result<(), ApplicationError> {
        let Some(job) = self.0 else {
            return Ok(());
        };
        #[cfg(any(test, feature = "test-support"))]
        job.gate.at(stage, &job.halt);
        #[cfg(not(any(test, feature = "test-support")))]
        let _ = stage;
        if job.halt.stopped().is_some() {
            #[cfg(any(test, feature = "test-support"))]
            job.gate.linger();
            return Err(ApplicationError::Cancelled);
        }
        #[cfg(any(test, feature = "test-support"))]
        job.gate.passed();
        Ok(())
    }

    /// Reserve `bytes` more of what the proof's result keeps, before they
    /// are allocated: within its reservation, or taking more of its daemon's
    /// proof memory. Cancelled when that does not fit, and the proof then
    /// answers busy, or too large when it never would.
    pub fn reserve(self, bytes: usize) -> Result<(), ApplicationError> {
        let Some(memory) = self.memory() else {
            return Ok(());
        };
        memory
            .reserve(u64::try_from(bytes).unwrap_or(u64::MAX))
            .map_err(|reason| self.refuse(reason))
    }

    /// What the proof's work holds, none yet, given back once dropped.
    pub fn working(self) -> Work<'a> {
        Work {
            stop: self,
            bytes: 0,
        }
    }

    /// The largest contribution artifact the proof encodes.
    pub fn artifact_cap(self) -> usize {
        self.0.map_or(MAX_ARTIFACT_BYTES, |job| job.artifact_cap)
    }

    fn memory(self) -> Option<&'a ProofMemory> {
        self.0.and_then(|job| job.memory.as_deref())
    }

    /// Stop the proof for `reason`, a refusal of its memory, and what its
    /// work answers: cancelled, the proof answering for that reason, or over
    /// budget for a read with no proof.
    fn refuse(self, reason: ProofStop) -> ApplicationError {
        match self.0 {
            Some(job) => {
                job.stop_for(reason);
                ApplicationError::Cancelled
            }
            None => ApplicationError::ConfiguredByteBudgetExceeded,
        }
    }
}

/// What a proof's work holds of its memory while it runs, reserved before
/// it is allocated and given back once dropped. A read nothing limits holds
/// nothing.
#[must_use]
pub struct Work<'a> {
    stop: Stop<'a>,
    bytes: u64,
}

impl Work<'_> {
    /// Whether the proof's memory limits what this holds, so a workload is
    /// worth reading for it.
    pub fn limited(&self) -> bool {
        self.stop.memory().is_some()
    }

    /// Reserve `bytes` more, before they are allocated: within the proof's
    /// reservation, or taking more of its daemon's proof memory. Cancelled
    /// when that does not fit, and the proof then answers busy, or too large
    /// when it never would.
    pub fn grow(&mut self, bytes: u64) -> Result<(), ApplicationError> {
        let Some(memory) = self.stop.memory() else {
            return Ok(());
        };
        memory
            .work(bytes)
            .map_err(|reason| self.stop.refuse(reason))?;
        self.bytes = self.bytes.saturating_add(bytes);
        Ok(())
    }
}

impl Drop for Work<'_> {
    fn drop(&mut self) {
        if let Some(memory) = self.stop.memory() {
            memory.worked(self.bytes);
        }
    }
}

/// The identity of the store `conn` reads.
pub fn store_identity(conn: &Connection) -> Result<String, ApplicationError> {
    identity(conn, read_sql)
}

fn identity(
    conn: &Connection,
    failure: fn(rusqlite::Error) -> ApplicationError,
) -> Result<String, ApplicationError> {
    conn.prepare_cached("SELECT engine_uuid FROM engine_ownership WHERE rowid_guard=1")
        .map_err(failure)?
        .query_row([], |row| row.get(0))
        .map_err(failure)
}

/// What a held proof read of a document lineage beyond the evidence its
/// released tail generation covers, each by key: that generation, the
/// document's path and restore generation, and where the lineage's state
/// stands. Reading them loads, replays and hashes nothing, however much the
/// lineage holds. The generation covers the rest of the state the proof
/// loads, and any change to it that is later undone: the journal rows
/// between the head's snapshot and its last row, the latest snapshot going
/// or being rebound, an archive going or being rebound, and the bytes of
/// every blob the head or an archive names, a missing one arriving included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageCoordinates {
    /// None before the document's first activation.
    generation: Option<i64>,
    path: Option<String>,
    /// None while a restore fences the document.
    restore_generation: Option<i64>,
    state: LineageState,
}

/// Where a lineage's state stands, as inspection loads it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LineageState {
    /// The head holds it: its content kind, its last journal row and the
    /// compaction its state loads from, as the document names them and as
    /// the journal holds them, each row with the blob it names.
    Head {
        kind: ContentKind,
        update_seq: i64,
        snapshot_seq: i64,
        snapshot: Option<(i64, String)>,
        last_update: Option<(i64, String)>,
    },
    /// An archive keeps it: the digest of the full state kept, and its kind.
    Archived { full_state: String, kind: String },
    /// The document holds no such lineage.
    Absent,
}

impl LineageCoordinates {
    /// The coordinates of `doc`'s `lineage` as `conn` reads them.
    pub fn read(conn: &Connection, doc: &DocKey, lineage: &str) -> Result<Self, ApplicationError> {
        let head = durable::read_marker_in(conn, doc)?
            .filter(|marker| marker.lineage_claim_id.as_deref() == Some(lineage));
        let state = match head {
            Some(marker) => LineageState::Head {
                kind: marker.content_kind,
                update_seq: marker.head_update_seq,
                snapshot_seq: marker.head_snapshot_seq,
                snapshot: durable::latest_snapshot(conn, doc)?,
                last_update: conn
                    .prepare_cached(
                        "SELECT seq,update_blob_sha256 FROM ydoc_updates
                         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
                         ORDER BY seq DESC LIMIT 1",
                    )
                    .map_err(read_sql)?
                    .query_row(
                        params![doc.workspace_id, doc.version_id, doc.object_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(read_sql)?,
            },
            None => conn
                .query_row(
                    "SELECT full_state_blob_sha256,content_kind FROM ydoc_inactive_lineages
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
                    params![doc.workspace_id, doc.version_id, doc.object_id, lineage],
                    |row| {
                        Ok(LineageState::Archived {
                            full_state: row.get(0)?,
                            kind: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(read_sql)?
                .unwrap_or(LineageState::Absent),
        };
        Ok(Self {
            generation: tail_generation(conn, doc)?.0,
            path: bound_path(conn, doc)?,
            restore_generation: bound_restore_generation(conn, doc)?,
            state,
        })
    }
}

/// What tests hold proofs with: a pause at one stage's checks, at a
/// reader's open and at a last caller's leaving, a statement that runs
/// until its proof stops, a stopped proof kept from ending, and counts of
/// what proofs passed and opened.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
struct GateState {
    /// Where proofs hold until resumed.
    pause: Option<ProofStage>,
    /// Checks there to pass before the pause holds.
    skip: u64,
    /// Proofs holding there.
    waiting: usize,
    /// Whether proofs hold just before their reader opens, as a thread
    /// descheduled there would, until resumed.
    pause_open: bool,
    /// Proofs holding there.
    opening: usize,
    /// Whether proofs hold once their reader counts as open, before its
    /// connection opens, as a thread descheduled inside a slow open would,
    /// until resumed.
    pause_inside_open: bool,
    /// Proofs holding there.
    inside_open: usize,
    /// Readers proofs opened.
    opened: u64,
    /// Whether a last caller holds once it stopped its proof, until resumed.
    pause_leave: bool,
    /// Callers holding there.
    leaving: usize,
    /// Whether the next proof runs, once its snapshot is fixed, a statement
    /// only its progress handler ends.
    stall: bool,
    /// A proof runs that statement.
    stalling: bool,
    /// Whether a stopped proof holds at the check that found it stopped.
    linger: bool,
    /// Close waits for a reader to close.
    closing: bool,
    /// Checks proofs passed without stopping.
    passed: u64,
    /// Tasks waiting for any of this to change.
    wakers: Vec<Waker>,
}

#[cfg(any(test, feature = "test-support"))]
impl Gate {
    /// Wake everyone watching the gate. The lock is taken so a proof about
    /// to hold sees what changed.
    fn wake(&self) {
        let mut state = lock(&self.state);
        Self::notify(&mut state);
        self.changed.notify_all();
    }

    fn notify(state: &mut GateState) {
        for waker in std::mem::take(&mut state.wakers) {
            waker.wake();
        }
    }

    /// Hold a proof at `stage` while proofs pause there, past the checks to
    /// skip, until they resume or the proof stops.
    fn at(&self, stage: ProofStage, halt: &Halt) {
        let mut state = lock(&self.state);
        if state.pause != Some(stage) || halt.reason().is_some() {
            return;
        }
        if state.skip > 0 {
            state.skip -= 1;
            return;
        }
        state.waiting += 1;
        Self::notify(&mut state);
        self.changed.notify_all();
        while state.pause == Some(stage) && halt.reason().is_none() {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.waiting -= 1;
    }

    /// Hold a proof just before its reader opens while proofs pause there.
    /// Stopping the proof does not release it.
    fn before_open(&self) {
        let mut state = lock(&self.state);
        if !state.pause_open {
            return;
        }
        state.opening += 1;
        Self::notify(&mut state);
        self.changed.notify_all();
        while state.pause_open {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.opening -= 1;
    }

    /// Hold a proof once its reader counts as open, before its connection
    /// opens, while proofs pause there. Stopping the proof does not release
    /// it.
    fn inside_open(&self) {
        let mut state = lock(&self.state);
        if !state.pause_inside_open {
            return;
        }
        state.inside_open += 1;
        Self::notify(&mut state);
        self.changed.notify_all();
        while state.pause_inside_open {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.inside_open -= 1;
    }

    fn opened(&self) {
        lock(&self.state).opened += 1;
    }

    /// Hold a last caller once it stopped its proof, while callers pause
    /// there.
    fn leaving(&self) {
        let mut state = lock(&self.state);
        if !state.pause_leave {
            return;
        }
        state.leaving += 1;
        self.changed.notify_all();
        while state.pause_leave {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.leaving -= 1;
    }

    fn passed(&self) {
        lock(&self.state).passed += 1;
    }

    /// Hold a stopped proof while stopped proofs linger.
    fn linger(&self) {
        let mut state = lock(&self.state);
        while state.linger {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn closing(&self) {
        lock(&self.state).closing = true;
        self.wake();
    }

    /// Run the stalled statement on `conn` when one is asked for: a count
    /// of steps no proof could finish, which only its progress handler ends.
    fn stall(&self, conn: &Connection) -> Result<(), ApplicationError> {
        {
            let mut state = lock(&self.state);
            if !std::mem::take(&mut state.stall) {
                return Ok(());
            }
            state.stalling = true;
        }
        self.wake();
        conn.query_row(
            "WITH RECURSIVE steps(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM steps WHERE n<10000000000)
             SELECT count(*) FROM steps",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(read_sql)?;
        Ok(())
    }

    /// Block until `ready` holds of the gate.
    fn block_until(&self, ready: impl Fn(&GateState) -> bool) {
        let mut state = lock(&self.state);
        while !ready(&state) {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Completes once `ready` holds of the gate.
    fn until<'g>(
        &'g self,
        ready: impl Fn(&GateState) -> bool + 'g,
    ) -> impl std::future::Future<Output = ()> + 'g {
        std::future::poll_fn(move |context| {
            let mut state = lock(&self.state);
            if ready(&state) {
                return Poll::Ready(());
            }
            state.wakers.push(context.waker().clone());
            Poll::Pending
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
impl<K, T> HeldProofs<K, T> {
    /// Hold every proof at its snapshot until [`Self::resume_proofs`].
    #[doc(hidden)]
    pub fn pause_proofs(&self) {
        self.pause_proofs_at(ProofStage::Snapshot);
    }

    /// Hold every proof at its checks of `stage` until
    /// [`Self::resume_proofs`] or it stops.
    #[doc(hidden)]
    pub fn pause_proofs_at(&self, stage: ProofStage) {
        self.pause_proofs_at_check(stage, 1);
    }

    /// Hold the next proof at its `nth` check of `stage`, counting from one,
    /// until [`Self::resume_proofs`] or it stops.
    #[doc(hidden)]
    pub fn pause_proofs_at_check(&self, stage: ProofStage, nth: u64) {
        let mut state = lock(&self.0.gate.state);
        state.pause = Some(stage);
        state.skip = nth.saturating_sub(1);
    }

    /// Hold every proof just before its reader opens until
    /// [`Self::resume_proofs`], whether or not it stopped meanwhile.
    #[doc(hidden)]
    pub fn pause_reader_opens(&self) {
        lock(&self.0.gate.state).pause_open = true;
    }

    /// Hold every proof once its reader counts as open, before its
    /// connection opens, until [`Self::resume_proofs`], whether or not it
    /// stopped meanwhile.
    #[doc(hidden)]
    pub fn pause_inside_reader_opens(&self) {
        lock(&self.0.gate.state).pause_inside_open = true;
    }

    /// Hold the last caller of a proof once it stopped the proof, outside
    /// the lock joining takes, until [`Self::resume_proofs`].
    #[doc(hidden)]
    pub fn pause_last_leaves(&self) {
        lock(&self.0.gate.state).pause_leave = true;
    }

    /// Let every held proof and caller go on, and stopped proofs end.
    #[doc(hidden)]
    pub fn resume_proofs(&self) {
        {
            let mut state = lock(&self.0.gate.state);
            state.pause = None;
            state.skip = 0;
            state.pause_open = false;
            state.pause_inside_open = false;
            state.pause_leave = false;
            state.linger = false;
        }
        self.0.gate.wake();
    }

    /// Block until a proof holds at the pause.
    #[doc(hidden)]
    pub fn wait_for_paused_proof(&self) {
        self.0.gate.block_until(|state| state.waiting > 0);
    }

    /// Block until a proof holds just before its reader opens.
    #[doc(hidden)]
    pub fn wait_for_paused_open(&self) {
        self.0.gate.block_until(|state| state.opening > 0);
    }

    /// Block until a proof holds once its reader counts as open, before its
    /// connection opens.
    #[doc(hidden)]
    pub fn wait_for_paused_inside_open(&self) {
        self.0.gate.block_until(|state| state.inside_open > 0);
    }

    /// Block until a last caller holds once it stopped its proof.
    #[doc(hidden)]
    pub fn wait_for_leaving(&self) {
        self.0.gate.block_until(|state| state.leaving > 0);
    }

    /// How many readers proofs opened.
    #[doc(hidden)]
    pub fn readers_opened(&self) -> u64 {
        lock(&self.0.gate.state).opened
    }

    /// Completes once a proof holds at the pause, for a task that must not
    /// block its thread.
    #[doc(hidden)]
    pub fn paused_proof(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.0.gate.until(|state| state.waiting > 0)
    }

    /// Have the next proof run, once its snapshot is fixed, a statement only
    /// its reader's progress handler ends.
    #[doc(hidden)]
    pub fn stall_next_proof(&self) {
        lock(&self.0.gate.state).stall = true;
    }

    /// Completes once a proof runs that statement.
    #[doc(hidden)]
    pub fn stalled_proof(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.0.gate.until(|state| state.stalling)
    }

    /// Keep each stopped proof at the check that found it stopped, its
    /// reader open, until [`Self::resume_proofs`].
    #[doc(hidden)]
    pub fn linger_stopped_proofs(&self) {
        lock(&self.0.gate.state).linger = true;
    }

    /// Block until close waits for a reader to close.
    #[doc(hidden)]
    pub fn wait_for_closing(&self) {
        self.0.gate.block_until(|state| state.closing);
    }

    /// Block until every reader a proof opened closed.
    #[doc(hidden)]
    pub fn wait_for_drained(&self) {
        let mut open = lock(&self.0.readers.open);
        while *open > 0 {
            open = self
                .0
                .readers
                .closed
                .wait(open)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Let proofs admitted from now on run for `deadline`.
    #[doc(hidden)]
    pub fn set_proof_deadline(&self, deadline: Duration) {
        lock(&self.0.state).deadline = deadline;
    }

    /// Let close wait `bound` for proofs' readers to close.
    #[doc(hidden)]
    pub fn set_close_bound(&self, bound: Duration) {
        lock(&self.0.state).close_bound = bound;
    }

    /// Let proofs admitted from now on encode contribution artifacts of at
    /// most `bytes`.
    #[doc(hidden)]
    pub fn set_artifact_cap(&self, bytes: usize) {
        lock(&self.0.state).artifact_cap = bytes;
    }

    /// Whether the store of `workspace_id`'s running proof presses on its
    /// held readers.
    #[doc(hidden)]
    pub fn wal_pressed(&self, workspace_id: &str) -> bool {
        lock(&self.0.state)
            .running
            .get(workspace_id)
            .and_then(|proof| {
                proof
                    .job
                    .halt
                    .pressure
                    .as_ref()
                    .map(|pressure| pressure.raised())
            })
            .unwrap_or(false)
    }

    /// How many checks proofs passed without stopping.
    #[doc(hidden)]
    pub fn checks_passed(&self) -> u64 {
        lock(&self.0.gate.state).passed
    }

    /// How many proofs were admitted to run.
    #[doc(hidden)]
    pub fn proofs_admitted(&self) -> u64 {
        lock(&self.0.state).admitted
    }

    /// How many readers proofs hold open.
    #[doc(hidden)]
    pub fn open_readers(&self) -> usize {
        *lock(&self.0.readers.open)
    }

    /// Completes once the running proof of `workspace_id` has `count`
    /// callers.
    #[doc(hidden)]
    pub fn callers<'p>(
        &'p self,
        workspace_id: &'p str,
        count: usize,
    ) -> impl std::future::Future<Output = ()> + 'p {
        let proofs = &self.0;
        std::future::poll_fn(move |context| {
            // Listen before counting, without the gate's lock: admission
            // takes the gate's after the proofs'.
            lock(&proofs.gate.state)
                .wakers
                .push(context.waker().clone());
            let callers = lock(&proofs.state)
                .running
                .get(workspace_id)
                .map_or(0, |proof| lock(&proof.outcome).waiters.len());
            if callers >= count {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::{EngineStore, StorageError};

    type Held = HeldProofs<&'static str, u32>;
    type Run = HeldProofRun<&'static str, u32>;
    type Wait = HeldProofWait<&'static str, u32>;

    fn store() -> (dohc_test_scratch::ScratchDir, EngineStore) {
        let scratch = dohc_test_scratch::ScratchDir::new().unwrap();
        let store = EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        (scratch, store)
    }

    fn proofs() -> Held {
        Held::new(HeldProofLimit::default())
    }

    /// Poll `future` on this thread until it completes.
    fn block_on<F: std::future::Future + Unpin>(mut future: F) -> F::Output {
        struct Unpark(std::thread::Thread);
        impl std::task::Wake for Unpark {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
        let mut context = std::task::Context::from_waker(&waker);
        loop {
            if let Poll::Ready(output) =
                std::future::Future::poll(std::pin::Pin::new(&mut future), &mut context)
            {
                return output;
            }
            std::thread::park();
        }
    }

    /// What a wait answers: the proof's value, or why it has none.
    fn answer(wait: Wait) -> Result<u32, HeldProofError> {
        block_on(wait).map(|answer| **answer)
    }

    fn admit(
        proofs: &Held,
        store: &EngineStore,
        workspace: &str,
        key: &'static str,
    ) -> HeldProofAdmission<&'static str, u32> {
        proofs.admit(store, workspace, key).unwrap()
    }

    fn started(proofs: &Held, store: &EngineStore, key: &'static str) -> (Run, Wait) {
        match admit(proofs, store, "workspace", key) {
            HeldProofAdmission::Started(run, wait) => (run, wait),
            _ => panic!("a free workspace starts its proof"),
        }
    }

    fn joined(proofs: &Held, store: &EngineStore, key: &'static str) -> Wait {
        match admit(proofs, store, "workspace", key) {
            HeldProofAdmission::Joined(wait) => wait,
            _ => panic!("the running proof asks the same"),
        }
    }

    /// A proof that holds at its merge, its reader open, until it stops, and
    /// answers whether it did.
    fn merging(run: Run) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            run.prove(|job| {
                let _reader = job.reader();
                (u32::from(job.stop().check(ProofStage::Merge).is_err()), 0)
            });
        })
    }

    /// Ruling B, item 6: callers that ask the same share one proof, which
    /// runs once and answers each with one result, however many left first.
    /// Asking anything else of the workspace, or joining past the bound, is
    /// busy; another workspace proves beside it.
    #[test]
    fn identical_requests_share_one_proof_and_anything_else_is_busy() {
        let (_scratch, store) = store();
        let proofs = proofs();
        let (run, first) = started(&proofs, &store, "key");
        let mut others: Vec<_> = (1..MAX_PROOF_WAITERS)
            .map(|_| joined(&proofs, &store, "key"))
            .collect();
        assert!(proofs.refuses("workspace"), "full, refused before reading");
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "key"),
                HeldProofAdmission::Busy
            ),
            "bounded"
        );
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "other"),
                HeldProofAdmission::Busy
            ),
            "another request"
        );
        assert!(
            matches!(
                admit(&proofs, &store, "elsewhere", "other"),
                HeldProofAdmission::Started(..)
            ),
            "another workspace"
        );
        drop(others.pop());
        run.prove(|job| {
            assert!(job.stopped().is_none(), "one caller leaving stops nothing");
            (7, 0)
        });
        assert_eq!(answer(first), Ok(7));
        for other in others {
            assert_eq!(answer(other), Ok(7));
        }
        assert_eq!(proofs.proofs_admitted(), 2, "the shared proof ran once");
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "other"),
                HeldProofAdmission::Started(..)
            ),
            "an ended proof frees its workspace"
        );
    }

    /// Ruling B, item 6: the last caller to leave stops the running proof,
    /// unlike [`ReleasedTails`], whose validation runs on. The workspace
    /// stays busy until the proof ends, for an identical request too, and
    /// the leaving caller can wait for that.
    #[test]
    fn the_last_caller_to_leave_stops_the_proof_which_keeps_its_workspace_until_it_ends() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.pause_proofs_at(ProofStage::Merge);
        proofs.linger_stopped_proofs();
        let (run, first) = started(&proofs, &store, "key");
        let second = joined(&proofs, &store, "key");
        let worker = merging(run);
        proofs.wait_for_paused_proof();
        drop(first);
        let passed = proofs.checks_passed();
        let stopped = second.leave();
        assert!(
            proofs.refuses("workspace"),
            "stopping, refused before reading"
        );
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "key"),
                HeldProofAdmission::Busy
            ),
            "a stopping proof takes no caller"
        );
        assert_eq!(proofs.open_readers(), 1, "its reader is still open");
        proofs.resume_proofs();
        block_on(stopped);
        assert_eq!(
            proofs.open_readers(),
            0,
            "the stop completes once the proof ends"
        );
        assert_eq!(proofs.checks_passed(), passed, "the proof went no further");
        worker.join().unwrap();
        assert!(matches!(
            admit(&proofs, &store, "workspace", "key"),
            HeldProofAdmission::Started(..)
        ));
    }

    /// Sol's and Opus's r2c-3c-2 finding 2: joining and the last caller's
    /// leaving are one decision each under one lock. Once the last caller
    /// stopped the proof, and before it wakes anyone, an identical request
    /// is busy, never a caller of the stopped proof; one that joined before
    /// it left shares the proof's result.
    #[test]
    fn a_joiner_racing_the_last_caller_gets_the_result_or_busy() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.pause_last_leaves();
        let (run, last) = started(&proofs, &store, "key");
        let leaving = std::thread::spawn(move || drop(last));
        proofs.wait_for_leaving();
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "key"),
                HeldProofAdmission::Busy
            ),
            "after the last caller left"
        );
        proofs.resume_proofs();
        leaving.join().unwrap();
        run.prove(|_| panic!("a stopped proof runs nothing"));

        let (run, first) = started(&proofs, &store, "key");
        let joiner = joined(&proofs, &store, "key");
        drop(first);
        run.prove(|job| {
            assert!(job.stopped().is_none(), "a joiner still waits");
            (7, 0)
        });
        assert_eq!(answer(joiner), Ok(7));
    }

    /// A proof nobody waits for any more before it starts never runs, and an
    /// admitted proof dropped unrun frees its workspace and its place.
    #[test]
    fn a_proof_nobody_waits_for_never_runs() {
        let (_scratch, store) = store();
        let limit = HeldProofLimit::default();
        let proofs = Held::new(limit.clone());
        let (run, wait) = started(&proofs, &store, "key");
        drop(wait);
        run.prove(|_| panic!("a stopped proof runs nothing"));
        let (run, wait) = started(&proofs, &store, "key");
        drop(run);
        assert_eq!(answer(wait), Err(HeldProofError::Closed));
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "other"),
                HeldProofAdmission::Started(..)
            ),
            "the workspace is free"
        );
        assert_eq!(limit.reserved_bytes(), 0, "nothing stays reserved");
    }

    /// r2c-3c-1's open item: close stops every proof, answers its callers as
    /// closed and returns once their readers closed; past its bound it says
    /// they have not.
    #[test]
    fn close_stops_proofs_and_returns_once_their_readers_closed() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.pause_proofs_at(ProofStage::Merge);
        proofs.linger_stopped_proofs();
        let (run, wait) = started(&proofs, &store, "key");
        let worker = merging(run);
        proofs.wait_for_paused_proof();
        let releasing = proofs.clone();
        let release = std::thread::spawn(move || {
            releasing.wait_for_closing();
            releasing.resume_proofs();
        });
        proofs.set_close_bound(Duration::from_secs(30));
        assert!(proofs.close(), "the reader closed in time");
        assert_eq!(
            proofs.open_readers(),
            0,
            "close returned after the reader closed"
        );
        assert_eq!(answer(wait), Err(HeldProofError::Closed));
        assert!(matches!(
            admit(&proofs, &store, "workspace", "key"),
            HeldProofAdmission::Closed
        ));
        release.join().unwrap();
        worker.join().unwrap();

        let lingering = self::proofs();
        lingering.pause_proofs_at(ProofStage::Merge);
        lingering.linger_stopped_proofs();
        let (run, _wait) = started(&lingering, &store, "key");
        let worker = merging(run);
        lingering.wait_for_paused_proof();
        lingering.set_close_bound(Duration::ZERO);
        assert!(!lingering.close(), "the reader is still open");
        assert!(!lingering.drained());
        lingering.resume_proofs();
        worker.join().unwrap();
        assert!(lingering.drained(), "drained once the reader closed");
    }

    /// Opus's r2c-3c-2 finding 6: close before a proof's thread starts
    /// returns at once, waiting for nothing, and the proof never opens a
    /// reader when its thread does run.
    #[test]
    fn close_before_a_proof_starts_returns_at_once_and_nothing_opens() {
        let (_scratch, store) = store();
        let proofs = proofs();
        let (run, wait) = started(&proofs, &store, "key");
        proofs.set_close_bound(Duration::ZERO);
        assert!(proofs.close(), "nothing started, nothing to wait for");
        assert_eq!(answer(wait), Err(HeldProofError::Closed));
        run.prove(|job| {
            let _ = job.reader();
            panic!("a proof of a closed store runs nothing")
        });
        assert_eq!(proofs.readers_opened(), 0);
        assert_eq!(proofs.open_readers(), 0);
    }

    /// Sol's r2c-3c-2 finding 1: a proof's thread paused just before its
    /// reader opens, past every earlier check, as a descheduled thread would
    /// be, never opens one once close began: close has nothing to wait for,
    /// and the proof finds itself stopped.
    #[test]
    fn a_reader_about_to_open_when_close_begins_never_opens() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.pause_reader_opens();
        let (run, _wait) = started(&proofs, &store, "key");
        let worker = std::thread::spawn(move || {
            run.prove(|job| (u32::from(job.reader().is_err()), 0));
        });
        proofs.wait_for_paused_open();
        proofs.set_close_bound(Duration::ZERO);
        assert!(proofs.close(), "no reader is open");
        proofs.resume_proofs();
        worker.join().unwrap();
        assert_eq!(
            proofs.readers_opened(),
            0,
            "no reader opened after close began"
        );
    }

    /// Sol's r2c-3c-5 finding 2: a workspace runs one distinct proof until
    /// it ends. Once its reader closed, while it still encodes its answer, a
    /// different request for its workspace is busy and an identical one
    /// joins it; the workspace frees only once it ends. It opens no other
    /// reader and answers every caller, and close waits for no encoding
    /// (Opus's r2c-3c-3 finding 3).
    #[test]
    fn a_proof_keeps_its_workspace_until_it_ends() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.pause_proofs_at(ProofStage::Encoding);
        let (run, first) = started(&proofs, &store, "key");
        let worker = std::thread::spawn(move || {
            run.prove(|job| {
                drop(job.reader().unwrap());
                let encoded = job.stop().check(ProofStage::Encoding).is_ok();
                assert!(job.reader().is_err(), "one reader a proof");
                (u32::from(encoded), 0)
            });
        });
        proofs.wait_for_paused_proof();
        assert_eq!(proofs.open_readers(), 0, "its reader closed");
        assert!(
            !proofs.refuses("workspace"),
            "an identical request may join"
        );
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "other"),
                HeldProofAdmission::Busy
            ),
            "a different request"
        );
        let second = joined(&proofs, &store, "key");
        proofs.resume_proofs();
        worker.join().unwrap();
        assert_eq!(answer(first), Ok(1), "the proof still answers");
        assert_eq!(answer(second), Ok(1), "and so does its joiner");
        assert_eq!(proofs.proofs_admitted(), 1, "one distinct proof");
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "other"),
                HeldProofAdmission::Started(..)
            ),
            "an ended proof frees its workspace"
        );

        let (run, wait) = started(&proofs, &store, "key");
        proofs.pause_proofs_at(ProofStage::Encoding);
        let worker = std::thread::spawn(move || {
            run.prove(|job| {
                drop(job.reader().unwrap());
                (
                    u32::from(job.stop().check(ProofStage::Encoding).is_err()),
                    0,
                )
            });
        });
        proofs.wait_for_paused_proof();
        proofs.set_close_bound(Duration::ZERO);
        assert!(proofs.close(), "close waits for no encoding");
        assert_eq!(answer(wait), Err(HeldProofError::Closed));
        worker.join().unwrap();
    }

    /// Sol's and Opus's "old finding 2": a proof past its deadline, which
    /// joining callers cannot extend, answers busy, not closed or corrupt.
    #[test]
    fn a_proof_past_its_deadline_answers_busy() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.set_proof_deadline(Duration::ZERO);
        let (run, first) = started(&proofs, &store, "key");
        assert!(
            matches!(
                admit(&proofs, &store, "workspace", "key"),
                HeldProofAdmission::Busy
            ),
            "a stopping proof takes no caller"
        );
        merging(run).join().unwrap();
        assert_eq!(answer(first), Err(HeldProofError::Busy));
    }

    /// Sol's r2c-3c-2 finding 5, and Opus's "old finding 3": a daemon runs at
    /// most its limit of proofs, across its stores, and a third is busy at
    /// once. A completed result keeps its memory charged until its last
    /// caller drops it, as one waiting to stream would, so a proof that
    /// needs that memory is busy until then.
    #[test]
    fn a_daemon_runs_a_bounded_number_of_proofs_and_results_keep_their_charge() {
        let (_scratch, store) = store();
        let (_other_scratch, other) = self::store();
        let limit = HeldProofLimit::new(2, 2 * 100, 100);
        let (one, two) = (Held::new(limit.clone()), Held::new(limit.clone()));
        let (run, kept) = started(&one, &store, "key");
        let (second, _second) = match admit(&two, &other, "elsewhere", "key") {
            HeldProofAdmission::Started(run, wait) => (run, wait),
            _ => panic!("a second proof runs beside the first"),
        };
        assert!(two.refuses("third"), "refused before reading");
        assert!(
            matches!(
                admit(&two, &other, "third", "key"),
                HeldProofAdmission::Busy
            ),
            "a third proof"
        );
        run.prove(|_| (7, 100));
        let kept = block_on(kept).unwrap();
        assert_eq!(**kept, 7);
        assert_eq!(limit.reserved_bytes(), 200, "the result keeps its charge");
        assert!(
            matches!(
                admit(&one, &store, "workspace", "key"),
                HeldProofAdmission::Busy
            ),
            "no memory for a third"
        );
        drop(kept);
        assert_eq!(
            limit.reserved_bytes(),
            100,
            "freed once its last holder dropped it"
        );
        assert!(matches!(
            admit(&one, &store, "workspace", "key"),
            HeldProofAdmission::Started(..)
        ));
        drop(second);
        assert_eq!(limit.reserved_bytes(), 0);
    }

    /// Sol's r2c-3c-2 finding 6: a reader that cannot open answers a locked
    /// store, which its caller retries, never corrupt state.
    #[test]
    fn a_reader_that_cannot_open_is_locked_not_corrupt() {
        let (scratch, store) = store();
        let mut job = HeldProofJob::of(&store);
        job.path = scratch.path().join("missing").join("engine.db");
        let failed = job
            .reader()
            .and_then(|mut reader| job.snapshot(&mut reader).map(|_| ()));
        assert!(
            matches!(
                failed,
                Err(ApplicationError::Storage(StorageError::FileLocked))
            ),
            "{failed:?}"
        );
    }

    /// Sol's r2c-3c-4 finding 3: a proof's thread suspended once its reader
    /// counts as open, before its connection opens, as one inside a slow
    /// open would be, never keeps close past its bound. Close says the
    /// reader is still open, and once the thread goes on, its reader closes
    /// again without staying open.
    #[test]
    fn close_returns_within_its_bound_while_a_reader_opens() {
        let (_scratch, store) = store();
        let proofs = proofs();
        proofs.pause_inside_reader_opens();
        let (run, _wait) = started(&proofs, &store, "key");
        let worker = std::thread::spawn(move || {
            run.prove(|job| (u32::from(job.reader().is_err()), 0));
        });
        proofs.wait_for_paused_inside_open();
        proofs.set_close_bound(Duration::from_millis(50));
        let began = Instant::now();
        assert!(!proofs.close(), "the opening reader counts as open");
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "close kept to its bound"
        );
        assert!(!proofs.drained());
        proofs.resume_proofs();
        worker.join().unwrap();
        assert!(proofs.drained(), "drained once the opening reader gave up");
        assert_eq!(
            proofs.readers_opened(),
            0,
            "no reader stayed open after close began"
        );
    }

    /// Sol's r2c-3c-4 finding 2 and Opus's finding 4: what a daemon's proofs
    /// and results keep never passes its proof memory. A proof reserves
    /// before it grows past its reservation, and answers busy beside another
    /// proof or too large past the whole memory; a result larger than its
    /// reservation is charged only within capacity, so two results never
    /// keep more than the memory holds.
    #[test]
    fn proof_memory_never_passes_its_capacity() {
        let (_scratch, store) = store();
        let (_other_scratch, other) = self::store();
        let limit = HeldProofLimit::new(2, 200, 100);
        let (one, two) = (Held::new(limit.clone()), Held::new(limit.clone()));
        let (beside, beside_wait) = match admit(&two, &other, "elsewhere", "key") {
            HeldProofAdmission::Started(run, wait) => (run, wait),
            _ => panic!("a second proof runs beside the first"),
        };

        let (run, wait) = started(&one, &store, "key");
        run.prove(|job| {
            assert!(job.stop().reserve(100).is_ok(), "within its reservation");
            let refused = job.stop().reserve(1);
            assert!(
                matches!(refused, Err(ApplicationError::Cancelled)),
                "beside another proof"
            );
            assert_eq!(job.stopped(), Some(ProofStop::Memory));
            (7, 0)
        });
        assert_eq!(answer(wait), Err(HeldProofError::Busy));
        assert_eq!(
            limit.reserved_bytes(),
            100,
            "only the other proof's reservation"
        );

        let (run, wait) = started(&one, &store, "key");
        run.prove(|_| (7, 150));
        assert_eq!(
            answer(wait),
            Err(HeldProofError::Busy),
            "a result past its reservation, beside another proof"
        );
        assert_eq!(limit.reserved_bytes(), 100);

        drop((beside, beside_wait));
        assert_eq!(limit.reserved_bytes(), 0);
        let (run, wait) = started(&one, &store, "key");
        run.prove(|job| {
            job.stop()
                .reserve(150)
                .expect("alone, it takes more within capacity");
            (7, 150)
        });
        let kept = block_on(wait).unwrap();
        assert_eq!(
            limit.reserved_bytes(),
            150,
            "the result keeps what it reserved"
        );
        assert!(
            matches!(
                admit(&two, &other, "elsewhere", "key"),
                HeldProofAdmission::Busy
            ),
            "no room beside it for a reservation"
        );
        drop(kept);
        assert_eq!(limit.reserved_bytes(), 0);

        let (run, wait) = started(&one, &store, "key");
        run.prove(|job| {
            assert!(job.stop().reserve(201).is_err());
            assert_eq!(job.stopped(), Some(ProofStop::TooLarge));
            (7, 0)
        });
        assert_eq!(answer(wait), Err(HeldProofError::TooLarge));
        let (run, wait) = started(&one, &store, "key");
        run.prove(|_| (7, 201));
        assert_eq!(
            answer(wait),
            Err(HeldProofError::TooLarge),
            "a result larger than the whole memory"
        );
        assert_eq!(limit.reserved_bytes(), 0, "nothing stays reserved");
    }
}
