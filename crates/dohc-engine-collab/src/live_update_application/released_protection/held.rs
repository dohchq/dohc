//! A held document's proof, run off the store's actor. The proof reads one
//! committed snapshot on a read-only connection of its own, which closes
//! before its answer is handed over. What it read beyond the evidence the
//! document's released tail generation covers, its caller names by bounded
//! coordinates and compares again on the actor before releasing the answer.
//! A workspace has one proof at a time, shared by the callers that ask the
//! same of the same state, and stopped once none of them waits.
use super::*;
use crate::ContentKind;
use std::time::{Duration, Instant};

/// The most callers one proof answers.
pub const MAX_PROOF_WAITERS: usize = 8;

/// The held-document proofs of one store's actor. A workspace has at most
/// one, from admission until its reader closes. A caller whose request `K` is
/// the running proof's joins it, up to [`MAX_PROOF_WAITERS`] callers, and
/// shares its result `T`; any other request for the workspace is busy, never
/// queued. Each caller leaves on its own, and the last to leave stops the
/// proof, queued or running: its reader at its next statement, within
/// [`READER_STEP_OPS`] steps of the one running, and the proof itself at its
/// next [`Stop::check`]. The workspace stays busy until that reader closes,
/// so a stopping proof never runs beside the next. [`Self::close`] stops
/// every proof and waits, bounded, for their readers to close.
pub struct HeldProofs<K, T>(Arc<Proofs<K, T>>);

/// What the proofs' handles and their blocking threads share. The lock is
/// held only to admit and hand over, never while a proof reads.
struct Proofs<K, T> {
    state: Mutex<ProofState<K, T>>,
    /// Wakes [`HeldProofs::close`] once a proof's reader closes.
    ended: Condvar,
    #[cfg(any(test, feature = "test-support"))]
    gate: Arc<Gate>,
}

struct ProofState<K, T> {
    /// Each workspace's proof, by workspace ID, until its reader closes.
    running: HashMap<String, Arc<Proof<K, T>>>,
    closed: bool,
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
    result: Option<Result<Arc<T>, HeldProofError>>,
    /// Each [`HeldProofWait`] still waiting, by its number, with the task it
    /// last polled from.
    waiters: HashMap<u64, Option<Waker>>,
    next_waiter: u64,
    /// The proof's reader closed, or it never opened one.
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
    /// one with as many callers as it answers.
    Busy,
    Closed,
}

impl<K, T> Clone for HeldProofs<K, T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<K, T> Default for HeldProofs<K, T> {
    fn default() -> Self {
        Self(Arc::new(Proofs {
            state: Mutex::new(ProofState {
                running: HashMap::new(),
                closed: false,
                #[cfg(any(test, feature = "test-support"))]
                admitted: 0,
            }),
            ended: Condvar::new(),
            #[cfg(any(test, feature = "test-support"))]
            gate: Arc::default(),
        }))
    }
}

impl<K: PartialEq, T> HeldProofs<K, T> {
    /// A proof of `store`'s committed state for `workspace_id`, asking `key`,
    /// or a wait for the running one that asks the same. Admitting reads
    /// nothing.
    pub fn admit(
        &self,
        store: &dohc_engine_storage::EngineStore,
        workspace_id: &str,
        key: K,
    ) -> HeldProofAdmission<K, T> {
        let mut state = lock(&self.0.state);
        if state.closed {
            return HeldProofAdmission::Closed;
        }
        if let Some(proof) = state.running.get(workspace_id) {
            let joins = proof.key == key
                && !proof.job.cancelled()
                && lock(&proof.outcome).waiters.len() < MAX_PROOF_WAITERS;
            return if joins {
                HeldProofAdmission::Joined(proof.wait())
            } else {
                HeldProofAdmission::Busy
            };
        }
        let proof = Arc::new(Proof {
            workspace_id: workspace_id.to_owned(),
            key,
            job: HeldProofJob {
                opening: store.opening(),
                path: store.database_path().to_owned(),
                cancelled: Arc::default(),
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
        HeldProofAdmission::Started(
            HeldProofRun {
                proofs: Arc::clone(&self.0),
                proof: Some(proof),
            },
            wait,
        )
    }
}

impl<K, T> HeldProofs<K, T> {
    /// Stop proving for good: refuse new proofs, stop queued and running
    /// ones, answer everyone waiting as closed, and wait up to `bound` for
    /// every reader to close. Whether they all did. Call it off the actor,
    /// before the store's files are replaced.
    pub fn close(&self, bound: Duration) -> bool {
        let running: Vec<_> = {
            let mut state = lock(&self.0.state);
            state.closed = true;
            state.running.values().cloned().collect()
        };
        for proof in &running {
            proof.job.cancel();
            proof.complete(Err(HeldProofError::Closed));
        }
        let deadline = Instant::now() + bound;
        let mut state = lock(&self.0.state);
        #[cfg(any(test, feature = "test-support"))]
        if !state.running.is_empty() {
            self.0.gate.closing();
        }
        while !state.running.is_empty() {
            let Some(left) = deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
            else {
                return false;
            };
            state = self
                .0
                .ended
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}

impl<K, T> Proof<K, T> {
    /// A new caller of this proof.
    fn wait(self: &Arc<Self>) -> HeldProofWait<K, T> {
        let mut outcome = lock(&self.outcome);
        let waiter = outcome.next_waiter;
        outcome.next_waiter += 1;
        outcome.waiters.insert(waiter, None);
        drop(outcome);
        #[cfg(any(test, feature = "test-support"))]
        self.job.gate.wake();
        HeldProofWait {
            proof: Some(Arc::clone(self)),
            waiter,
        }
    }

    /// Answer everyone waiting with `result`, unless they were answered.
    fn complete(&self, result: Result<Arc<T>, HeldProofError>) {
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
    /// yet answered, the proof stops too; whether it did.
    fn leave(&self, waiter: u64) -> bool {
        let mut outcome = lock(&self.outcome);
        if outcome.waiters.remove(&waiter).is_none()
            || outcome.result.is_some()
            || !outcome.waiters.is_empty()
        {
            return false;
        }
        drop(outcome);
        self.job.cancel();
        true
    }
}

/// An admitted proof, for its first caller to run on a blocking thread of
/// its own. Dropped unrun, it ends as closed, and its workspace is free.
#[must_use]
pub struct HeldProofRun<K, T> {
    proofs: Arc<Proofs<K, T>>,
    proof: Option<Arc<Proof<K, T>>>,
}

impl<K, T> HeldProofRun<K, T> {
    /// Run `prove` on this thread with the proof's job, unless nobody waits
    /// for it any more, and answer whoever still does. `prove` closes every
    /// reader it opens before it returns, a panic's unwinding included; the
    /// workspace takes another proof only then. A proof stopped meanwhile
    /// answers nobody, whatever `prove` returned: an interrupted reader is a
    /// cancellation, never a storage failure.
    pub fn prove(mut self, prove: impl FnOnce(&HeldProofJob) -> T) {
        let Some(proof) = self.proof.take() else {
            return;
        };
        let result = (!proof.job.cancelled()).then(|| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prove(&proof.job)))
                .map(Arc::new)
                .map_err(|_| HeldProofError::Panicked)
        });
        self.end(&proof, result);
    }

    /// Free the proof's workspace, then answer its callers.
    fn end(&self, proof: &Arc<Proof<K, T>>, result: Option<Result<Arc<T>, HeldProofError>>) {
        {
            let mut state = lock(&self.proofs.state);
            if state
                .running
                .get(&proof.workspace_id)
                .is_some_and(|running| Arc::ptr_eq(running, proof))
            {
                state.running.remove(&proof.workspace_id);
            }
            self.proofs.ended.notify_all();
        }
        // A stopped proof has nobody to answer, unless close answered them.
        let result = match result {
            Some(result) if !proof.job.cancelled() => result,
            _ => Err(HeldProofError::Closed),
        };
        let stopping = {
            let mut outcome = lock(&proof.outcome);
            outcome.ended = true;
            std::mem::take(&mut outcome.stopping)
        };
        proof.complete(result);
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
    /// Stop waiting, as dropping does. Completes once the proof's reader has
    /// closed when this stopped it, and at once otherwise.
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
    type Output = Result<Arc<T>, HeldProofError>;

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

/// Completes once a proof its last caller stopped has closed its reader.
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
    /// Set when nobody waits for the proof any more, or the store closes.
    /// Its reader stops at its next statement, and within
    /// [`READER_STEP_OPS`] steps of the one running.
    cancelled: Arc<AtomicBool>,
    #[cfg(any(test, feature = "test-support"))]
    gate: Arc<Gate>,
}

impl HeldProofJob {
    /// A proof of `store`'s committed state that nothing coalesces or
    /// stops, for a caller with no actor.
    pub fn of(store: &dohc_engine_storage::EngineStore) -> Self {
        Self {
            opening: store.opening(),
            path: store.database_path().to_owned(),
            cancelled: Arc::default(),
            #[cfg(any(test, feature = "test-support"))]
            gate: Arc::default(),
        }
    }

    /// The open of the store the proof reads.
    pub fn opening(&self) -> u64 {
        self.opening
    }

    /// Stop the proof: its reader at its next statement, and the proof
    /// itself at its next check.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        #[cfg(any(test, feature = "test-support"))]
        self.gate.wake();
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// What the proof checks between the units of work it does outside
    /// SQLite.
    pub fn stop(&self) -> Stop<'_> {
        Stop(Some(self))
    }

    /// The proof's read-only connection to its store, which never
    /// checkpoints it and stops once the proof is cancelled.
    pub fn reader(&self) -> Result<Connection, ApplicationError> {
        let reader = open_reader(&self.path)?;
        let cancelled = Arc::clone(&self.cancelled);
        reader
            .progress_handler(
                READER_STEP_OPS,
                Some(move || cancelled.load(Ordering::Relaxed)),
            )
            .map_err(read_sql)?;
        Ok(reader)
    }

    /// Begin the proof's one deferred read transaction on `reader` and fix
    /// its snapshot with the transaction's first read, the store's identity,
    /// before the proof reads anything else. Every later read of the
    /// transaction, the hold and its freshness included, sees that snapshot.
    pub fn snapshot<'c>(
        &self,
        reader: &'c mut Connection,
    ) -> Result<(Transaction<'c>, String), ApplicationError> {
        let tx = reader.transaction().map_err(read_sql)?;
        let engine = store_identity(&tx)?;
        #[cfg(any(test, feature = "test-support"))]
        self.gate.stall(&tx)?;
        self.stop().check(ProofStage::Snapshot)?;
        Ok((tx, engine))
    }
}

/// Where a held proof checks whether to stop, between the units of work it
/// does outside SQLite, whose statements the reader's progress handler stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofStage {
    /// Once its snapshot is fixed, before it reads the hold.
    Snapshot,
    /// Before the lineage's state loads, and before and after it is hashed.
    Replay,
    /// Before each retained entry's evidence is validated.
    Validation,
    /// Before each contribution's bytes load, and again before they apply.
    Merge,
    /// Before the merged state is projected, and before it is encoded.
    Projection,
    /// Before and after the contribution artifact is encoded and hashed.
    Encoding,
}

/// What a read checks to stop between its stages: a held proof's job, or
/// nothing for a read nobody stops.
#[derive(Clone, Copy)]
pub struct Stop<'a>(Option<&'a HeldProofJob>);

impl Stop<'static> {
    pub const NEVER: Self = Stop(None);
}

impl Stop<'_> {
    /// Cancelled once the proof should stop.
    pub fn check(self, stage: ProofStage) -> Result<(), ApplicationError> {
        let Some(job) = self.0 else {
            return Ok(());
        };
        #[cfg(any(test, feature = "test-support"))]
        job.gate.at(stage, &job.cancelled);
        #[cfg(not(any(test, feature = "test-support")))]
        let _ = stage;
        if job.cancelled() {
            #[cfg(any(test, feature = "test-support"))]
            job.gate.linger();
            return Err(ApplicationError::Cancelled);
        }
        #[cfg(any(test, feature = "test-support"))]
        job.gate.passed();
        Ok(())
    }
}

/// The identity of the store `conn` reads.
pub fn store_identity(conn: &Connection) -> Result<String, ApplicationError> {
    conn.prepare_cached("SELECT engine_uuid FROM engine_ownership WHERE rowid_guard=1")
        .map_err(read_sql)?
        .query_row([], |row| row.get(0))
        .map_err(read_sql)
}

/// What a held proof read of a document lineage beyond the evidence its
/// released tail generation covers, each by key: that generation, the
/// document's path and restore generation, and where the lineage's state
/// stands. Reading them loads, replays and hashes nothing, however much the
/// lineage holds.
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
    /// compaction its state loads from.
    Head {
        kind: ContentKind,
        update_seq: i64,
        snapshot_seq: i64,
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

/// What tests hold proofs with: a pause at one stage's checks, a statement
/// that runs until its proof stops, a stopped proof kept from ending, and
/// counts of what proofs passed.
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
    /// Proofs holding there.
    waiting: usize,
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
        for waker in std::mem::take(&mut state.wakers) {
            waker.wake();
        }
        self.changed.notify_all();
    }

    /// Hold a proof at `stage` while proofs pause there, until they resume
    /// or the proof stops.
    fn at(&self, stage: ProofStage, cancelled: &AtomicBool) {
        let mut state = lock(&self.state);
        if state.pause != Some(stage) || cancelled.load(Ordering::Relaxed) {
            return;
        }
        state.waiting += 1;
        for waker in std::mem::take(&mut state.wakers) {
            waker.wake();
        }
        self.changed.notify_all();
        while state.pause == Some(stage) && !cancelled.load(Ordering::Relaxed) {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.waiting -= 1;
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
        lock(&self.0.gate.state).pause = Some(stage);
    }

    /// Let every held proof go on, and stopped ones end.
    #[doc(hidden)]
    pub fn resume_proofs(&self) {
        {
            let mut state = lock(&self.0.gate.state);
            state.pause = None;
            state.linger = false;
        }
        self.0.gate.wake();
    }

    /// Block until a proof holds at the pause.
    #[doc(hidden)]
    pub fn wait_for_paused_proof(&self) {
        let gate = &self.0.gate;
        let mut state = lock(&gate.state);
        while state.waiting == 0 {
            state = gate
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
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
        let gate = &self.0.gate;
        let mut state = lock(&gate.state);
        while !state.closing {
            state = gate
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
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

    /// How many workspaces hold a proof whose reader has not closed.
    #[doc(hidden)]
    pub fn running_proofs(&self) -> usize {
        lock(&self.0.state).running.len()
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
    use dohc_engine_storage::EngineStore;

    type Held = HeldProofs<&'static str, u32>;
    type Run = HeldProofRun<&'static str, u32>;
    type Wait = HeldProofWait<&'static str, u32>;

    fn store() -> (dohc_test_scratch::ScratchDir, EngineStore) {
        let scratch = dohc_test_scratch::ScratchDir::new().unwrap();
        let store = EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        (scratch, store)
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

    fn started(proofs: &Held, store: &EngineStore, key: &'static str) -> (Run, Wait) {
        match proofs.admit(store, "workspace", key) {
            HeldProofAdmission::Started(run, wait) => (run, wait),
            _ => panic!("a free workspace starts its proof"),
        }
    }

    fn joined(proofs: &Held, store: &EngineStore, key: &'static str) -> Wait {
        match proofs.admit(store, "workspace", key) {
            HeldProofAdmission::Joined(wait) => wait,
            _ => panic!("the running proof asks the same"),
        }
    }

    /// A proof that holds at its merge until it stops, and answers whether
    /// it did.
    fn merging(run: Run) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            run.prove(|job| u32::from(job.stop().check(ProofStage::Merge).is_err()));
        })
    }

    /// Ruling B, item 6: callers that ask the same share one proof, which
    /// runs once and answers each with one result, however many left first.
    /// Asking anything else of the workspace, or joining past the bound, is
    /// busy; another workspace proves beside it.
    #[test]
    fn identical_requests_share_one_proof_and_anything_else_is_busy() {
        let (_scratch, store) = store();
        let proofs = Held::default();
        let (run, first) = started(&proofs, &store, "key");
        let mut others: Vec<_> = (1..MAX_PROOF_WAITERS)
            .map(|_| joined(&proofs, &store, "key"))
            .collect();
        assert!(matches!(proofs.admit(&store, "workspace", "key"), HeldProofAdmission::Busy), "bounded");
        assert!(matches!(proofs.admit(&store, "workspace", "other"), HeldProofAdmission::Busy), "another request");
        assert!(matches!(proofs.admit(&store, "elsewhere", "other"), HeldProofAdmission::Started(..)), "another workspace");
        drop(others.pop());
        run.prove(|job| {
            assert!(!job.cancelled(), "one caller leaving stops nothing");
            7
        });
        assert_eq!(block_on(first).map(|answer| *answer), Ok(7));
        for other in others {
            assert_eq!(block_on(other).map(|answer| *answer), Ok(7));
        }
        assert_eq!(proofs.proofs_admitted(), 2, "the shared proof ran once");
        assert!(matches!(proofs.admit(&store, "workspace", "other"), HeldProofAdmission::Started(..)), "an ended proof frees its workspace");
    }

    /// Ruling B, item 6: the last caller to leave stops the running proof,
    /// unlike [`ReleasedTails`], whose validation runs on. The workspace
    /// stays busy until the proof ends, for an identical request too, and
    /// the leaving caller can wait for that.
    #[test]
    fn the_last_caller_to_leave_stops_the_proof_which_keeps_its_workspace_until_it_ends() {
        let (_scratch, store) = store();
        let proofs = Held::default();
        proofs.pause_proofs_at(ProofStage::Merge);
        proofs.linger_stopped_proofs();
        let (run, first) = started(&proofs, &store, "key");
        let second = joined(&proofs, &store, "key");
        let worker = merging(run);
        proofs.wait_for_paused_proof();
        drop(first);
        let passed = proofs.checks_passed();
        let stopped = second.leave();
        assert!(matches!(proofs.admit(&store, "workspace", "key"), HeldProofAdmission::Busy), "a stopping proof takes no caller");
        assert_eq!(proofs.running_proofs(), 1, "its reader is still open");
        proofs.resume_proofs();
        block_on(stopped);
        assert_eq!(proofs.running_proofs(), 0, "the stop completes once the proof ends");
        assert_eq!(proofs.checks_passed(), passed, "the proof went no further");
        worker.join().unwrap();
        assert!(matches!(proofs.admit(&store, "workspace", "key"), HeldProofAdmission::Started(..)));
    }

    /// A proof nobody waits for any more before it starts never runs, and an
    /// admitted proof dropped unrun frees its workspace.
    #[test]
    fn a_proof_nobody_waits_for_never_runs() {
        let (_scratch, store) = store();
        let proofs = Held::default();
        let (run, wait) = started(&proofs, &store, "key");
        drop(wait);
        run.prove(|_| panic!("a stopped proof runs nothing"));
        assert_eq!(proofs.running_proofs(), 0);
        let (run, wait) = started(&proofs, &store, "key");
        drop(run);
        assert_eq!(block_on(wait), Err(HeldProofError::Closed));
        assert_eq!(proofs.running_proofs(), 0);
    }

    /// r2c-3c-1's open item: close stops every proof, answers its callers as
    /// closed and returns once their readers closed; past its bound it says
    /// they have not.
    #[test]
    fn close_stops_proofs_and_returns_once_their_readers_closed() {
        let (_scratch, store) = store();
        let proofs = Held::default();
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
        assert!(proofs.close(Duration::from_secs(30)), "the reader closed in time");
        assert_eq!(proofs.running_proofs(), 0, "close returned after the reader closed");
        assert_eq!(block_on(wait), Err(HeldProofError::Closed));
        assert!(matches!(proofs.admit(&store, "workspace", "key"), HeldProofAdmission::Closed));
        release.join().unwrap();
        worker.join().unwrap();

        let lingering = Held::default();
        lingering.pause_proofs_at(ProofStage::Merge);
        lingering.linger_stopped_proofs();
        let (run, _wait) = started(&lingering, &store, "key");
        let worker = merging(run);
        lingering.wait_for_paused_proof();
        assert!(!lingering.close(Duration::ZERO), "the reader is still open");
        lingering.resume_proofs();
        worker.join().unwrap();
        assert_eq!(lingering.running_proofs(), 0);
    }
}
