//! Whether a synced update may change a lineage a released chain left. In
//! the [released window](super::settled_base::released_window) a tail keeps
//! work no file may show: Carried deliveries, an acknowledged seed among them,
//! and owner outbox work that never applied. While any of it lacks proof, the
//! lineage is protected, and ingress applies only an update structural
//! inspection shows destroys nothing.
use super::*;
use crate::Ydoc;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::task::{Poll, Waker};

mod binding;
mod held;
mod preservation;
pub use binding::ContributionArtifact;
pub use held::{
    store_identity, Charged, HeldProofAdmission, HeldProofError, HeldProofJob, HeldProofLimit,
    HeldProofRun, HeldProofStop, HeldProofWait, HeldProofs, LineageCoordinates, ProofReader,
    ProofStage, ProofStop, Stop, Work, HELD_PROOF_CLOSE_BOUND, HELD_PROOF_DEADLINE,
    MAX_PROOF_WAITERS,
};
#[cfg(all(test, feature = "held-proof-memory"))]
pub(super) use preservation::{
    deletion_index_bytes, lineage_workload, preserve_lineage, Applications,
};
pub use preservation::{
    inspect_held, HeldInspection, Preservation, PreservationFinding, PreservationReason,
    PreservationStatus, PreservedState,
};

/// The synced update protection is decided for: the feed it arrived on and
/// its coordinate there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingCoordinate {
    /// The relay namespace the host's trusted configuration names for the
    /// feed; none on a pull no configured host serves.
    pub relay_namespace: Option<String>,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub origin_id: String,
    pub origin_seq: i64,
    pub relay_seq: i64,
}

/// What [`protection`] decides for: the head's lineage and the incoming update.
#[derive(Debug, Clone, Copy)]
pub struct ProtectionKey<'a> {
    pub doc: &'a DocKey,
    pub lineage_claim_id: &'a str,
    pub incoming: &'a IncomingCoordinate,
}

/// What a held update binds: the document's scope, the incoming feed and
/// coordinate, the head it would have changed, and every protected tail with
/// its retained coverage, in namespace order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasedLineageBinding {
    pub workspace_id: String,
    pub main_version_id: String,
    pub object_id: String,
    /// The lineage the update would change: the head's, or an archived one.
    pub lineage_claim_id: String,
    /// The document's path; none when no alias holds it.
    pub current_path: Option<String>,
    /// Its restore generation, 0 before any restore; none while one fences it.
    pub restore_generation: Option<i64>,
    pub incoming: IncomingCoordinate,
    /// The SHA-256 of that lineage's full state before the update: the
    /// head's, or the state an archived lineage keeps.
    pub head_digest: String,
    /// Shared with every decision the same validation answers.
    pub tails: Arc<ProtectedTails>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtectedTails {
    /// Every protected namespace's tail, in namespace order.
    Listed(Vec<ProtectedTail>),
    /// The window's own evidence does not read: a current activation, or a
    /// namespace's tail, that cannot be named.
    Invalid,
}

/// A released chain tail whose retained work protects its lineage.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProtectedTail {
    pub namespace: String,
    pub activation_id: String,
    /// What the tail's release bound; none when it does not read.
    pub release: Option<TailRelease>,
    pub coverage: RetainedCoverage,
}

/// The path and restore generation a tail's release bound.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TailRelease {
    pub path: String,
    pub restore_generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetainedCoverage {
    /// The work this commitment names lacks proof of application or terminal
    /// coverage.
    Unproven(UnprovenCommitment),
    /// Its evidence, or the release that bound it, is missing, conflicting
    /// or corrupt.
    Invalid,
}

/// The retained work a tail's validation found without proof, named once,
/// when it validates, by how many contributions there are and a digest of
/// all of them, every field, kind and repetition included. A binding never
/// lists the work itself, so its size and every comparison of it stay the
/// same however much a tail retains.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct UnprovenCommitment {
    pub count: i64,
    pub digest: String,
}

/// One piece of retained work no proof covers, with who made it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetainedContribution {
    /// A Carried delivery, a seed among them, that no host here applied.
    Carried {
        delivery_id: String,
        update_digest: String,
        journal_cursor: i64,
        authors: RetainedAuthors,
    },
    /// Any other outbox entry of the chain without such proof.
    Outbox {
        outbox_id: String,
        sequence: i64,
        delivery_id: String,
        update_digest: String,
        authors: RetainedAuthors,
    },
}

/// Who made one contribution, as a moment names its authors: the canonical
/// JSON of a list of the one author its evidence credits, or of the
/// unattributed marker when that evidence credits nobody. An adoption seed
/// credits nobody, so a copy never credits it to whoever keeps the copy.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RetainedAuthors(String);

impl RetainedAuthors {
    /// The authors of a write `actor` made with `attribution`: unattributed
    /// without either, as admission counts it. None when they do not
    /// validate.
    pub fn credited(
        actor: Option<&str>,
        attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    ) -> Option<Self> {
        let list = match dohc_engine_domain::moment_author_json(actor, attribution) {
            Some(json) => serde_json::from_str(&json).ok()?,
            None => serde_json::json!([{"kind": "unattributed"}]),
        };
        Self::from_json(&list)
    }

    /// The canonical JSON of the list.
    pub fn json(&self) -> &str {
        &self.0
    }
}

/// Where a piece of retained work is, without who made it: what a finding
/// names, even when the work's authorship does not read.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ContributionLocator {
    Carried {
        delivery_id: String,
        update_digest: String,
        journal_cursor: i64,
    },
    Outbox {
        outbox_id: String,
        sequence: i64,
        delivery_id: String,
        update_digest: String,
    },
}

impl RetainedContribution {
    /// Where the contribution is.
    pub fn locator(&self) -> ContributionLocator {
        match self {
            Self::Carried {
                delivery_id,
                update_digest,
                journal_cursor,
                ..
            } => ContributionLocator::Carried {
                delivery_id: delivery_id.clone(),
                update_digest: update_digest.clone(),
                journal_cursor: *journal_cursor,
            },
            Self::Outbox {
                outbox_id,
                sequence,
                delivery_id,
                update_digest,
                ..
            } => ContributionLocator::Outbox {
                outbox_id: outbox_id.clone(),
                sequence: *sequence,
                delivery_id: delivery_id.clone(),
                update_digest: update_digest.clone(),
            },
        }
    }

    pub fn authors(&self) -> &RetainedAuthors {
        match self {
            Self::Carried { authors, .. } | Self::Outbox { authors, .. } => authors,
        }
    }

    /// The contribution at `locator`, made by `authors`.
    pub fn at(locator: ContributionLocator, authors: RetainedAuthors) -> Self {
        match locator {
            ContributionLocator::Carried {
                delivery_id,
                update_digest,
                journal_cursor,
            } => Self::Carried {
                delivery_id,
                update_digest,
                journal_cursor,
                authors,
            },
            ContributionLocator::Outbox {
                outbox_id,
                sequence,
                delivery_id,
                update_digest,
            } => Self::Outbox {
                outbox_id,
                sequence,
                delivery_id,
                update_digest,
                authors,
            },
        }
    }
}

/// What one tail's validation found: the work it retains without proof, in
/// canonical order, and each contradiction its evidence holds. A tail with
/// any contradiction has invalid coverage; its work is never committed to in
/// part.
#[derive(Debug, Default)]
pub(crate) struct TailWork {
    pub contributions: Vec<RetainedContribution>,
    pub contradictions: Vec<PreservationFinding>,
}

pub enum Protection {
    Unprotected,
    /// The head the binding names, loaded for inspection.
    Protected {
        binding: Box<ReleasedLineageBinding>,
        head: Ydoc,
    },
    /// Nothing validated answers the generation the deciding transaction
    /// reads. The caller ends that transaction, waits for
    /// [`PendingValidation::validate`], and decides again in a fresh one.
    Pending(Box<PendingValidation>),
}

/// What [`lineage_protection`] decides from the tails alone.
pub enum LineageProtection {
    Unprotected,
    /// The tails that protect the lineage, as a binding names them.
    Protected(Arc<ProtectedTails>),
    /// As [`Protection::Pending`].
    Pending(Box<PendingValidation>),
}

impl ReleasedLineageBinding {
    /// Whether an update at `path` would land off what a protected tail's
    /// release bound: another path, or a restore since. A release no
    /// evidence names cannot show the update stays on it.
    pub fn moved(&self, path: &str) -> bool {
        let here = |bound: &str| self.current_path.as_deref() == Some(bound);
        let ProtectedTails::Listed(tails) = &*self.tails else {
            return true;
        };
        !here(path)
            || tails.iter().any(|tail| match &tail.release {
                Some(release) => {
                    !here(&release.path)
                        || self.restore_generation != Some(release.restore_generation)
                }
                None => true,
            })
    }
}

/// The value `result` reads, or none when its evidence does not read.
/// Storage failures and a cancelled read stay errors.
pub(super) fn readable<T>(
    result: Result<T, ApplicationError>,
) -> Result<Option<T>, ApplicationError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(
            error @ (ApplicationError::Storage(_)
            | ApplicationError::Collab(CollabError::Storage(_))
            | ApplicationError::Cancelled),
        ) => Err(error),
        Err(_) => Ok(None),
    }
}

/// The protected tails of each document lineage as validated on one open
/// store, at the document's released tail generation then; none for a
/// lineage nothing protects. Tails read activations, outboxes and their
/// entries, applications and accepted history of their deliveries, seed
/// captures, the journal rows native entries name, the document's head and
/// lineage columns, and terminal blobs. The store's triggers move the
/// generation with every change to those rows, whichever connection makes
/// it, so a decision whose transaction reads the store identity and
/// generation kept tails were validated at reuses them. The path, restore
/// generation and head stay each decision's own.
///
/// A decision never validates on its own connection. One whose transaction
/// reads a generation nothing kept answers is [`Protection::Pending`]: its
/// caller ends the transaction, waits for [`PendingValidation::validate`],
/// and decides again in a fresh one. Validation runs on a worker thread of
/// these tails, one at a time, each in a read-only connection and
/// transaction of its own that end before it reports, and identical requests
/// share one. Only committed state is kept, and only when no newer result
/// is. A document with no recorded generation has never been activated, and
/// nothing protects it; an activation without one is corrupt. The actor's
/// connection is the store's only writer; [`crate::WriterDocCache`] keeps one
/// of these for it, and binding it to another open of a store, a reopen or
/// restore among them, forgets everything kept before. [`Self::close`] stops
/// the worker and waits for its connection to close. A queued validation
/// nobody waits for any more leaves the queue, and one that panics fails its
/// waiters without stopping the worker.
#[derive(Clone)]
pub struct ReleasedTails(Option<Arc<Shared>>);

/// What the tails' handles and their worker share. The lock is held only to
/// hand work and results over, never while a validation reads.
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    /// Wakes the worker, and anyone waiting on it, when the state changes.
    changed: Condvar,
    /// Set once the tails close; the worker's reader stops at its next
    /// statement, and within [`READER_STEP_OPS`] steps of the one running.
    stopped: Arc<AtomicBool>,
}

/// SQLite VM steps between the worker reader's checks for close.
const READER_STEP_OPS: std::ffi::c_int = 100;

#[derive(Default)]
struct State {
    store: Option<CachedStore>,
    validated: HashMap<(DocKey, String), Validated>,
    /// Requested validations, until their worker completes them.
    jobs: HashMap<JobKey, Arc<Job>>,
    queue: VecDeque<Arc<Job>>,
    /// The latest worker thread; it ends once the queue is empty.
    worker: Option<std::thread::JoinHandle<()>>,
    working: bool,
    closed: bool,
    validations: u64,
    requests: u64,
    #[cfg(any(test, feature = "test-support"))]
    gate: Gate,
}

/// The open store kept tails come from: its opening and its file.
struct CachedStore {
    opening: u64,
    path: std::path::PathBuf,
}

/// Tails validated on the store `engine` names, at `generation`.
struct Validated {
    engine: String,
    generation: i64,
    tails: Option<Arc<ProtectedTails>>,
}

/// A document lineage at the generation a decision read.
type JobKey = (DocKey, String, i64);

/// One requested validation and everyone waiting for it.
struct Job {
    key: JobKey,
    engine: String,
    opening: u64,
    outcome: Mutex<Outcome>,
}

#[derive(Default)]
struct Outcome {
    result: Option<Result<(), ValidationError>>,
    /// Each [`Validation`] still waiting, by its number, with the task it
    /// last polled from.
    waiters: HashMap<u64, Option<Waker>>,
    next_waiter: u64,
}

impl Job {
    fn complete(&self, result: Result<(), ValidationError>) {
        let waiters = {
            let mut outcome = lock(&self.outcome);
            outcome.result = Some(result);
            std::mem::take(&mut outcome.waiters)
        };
        for waker in waiters.into_values().flatten() {
            waker.wake();
        }
    }

    /// A new waiter for this job of `tails`.
    fn join(self: &Arc<Self>, tails: &Arc<Shared>) -> Validation {
        let mut outcome = lock(&self.outcome);
        let waiter = outcome.next_waiter;
        outcome.next_waiter += 1;
        outcome.waiters.insert(waiter, None);
        Validation(Waiting::Job {
            job: Arc::clone(self),
            waiter,
            tails: Arc::downgrade(tails),
        })
    }
}

/// Why a validation did not complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    /// The store is closing; nothing validates for it any more.
    #[error("the store closed before its released tails were validated")]
    Closed,
    /// The worker could not read the store, or read another store there.
    #[error("released tails could not be validated")]
    Failed,
    /// The decision read a generation committed state never recorded: its
    /// transaction changed the tail inputs before it decided.
    #[error("a decision read released tails its transaction had changed")]
    Uncommitted,
}

/// A decision waiting for its lineage's tails to be validated on committed
/// state. It holds no transaction or connection.
#[derive(Clone)]
pub struct PendingValidation {
    tails: Arc<Shared>,
    doc: DocKey,
    lineage: String,
    generation: i64,
    engine: String,
    opening: u64,
}

impl std::fmt::Debug for PendingValidation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingValidation")
            .field("doc", &self.doc)
            .field("lineage", &self.lineage)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl PartialEq for PendingValidation {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.tails, &other.tails)
            && (
                &self.doc,
                &self.lineage,
                self.generation,
                &self.engine,
                self.opening,
            ) == (
                &other.doc,
                &other.lineage,
                other.generation,
                &other.engine,
                other.opening,
            )
    }
}

impl Eq for PendingValidation {}

impl PendingValidation {
    /// Validate the lineage on its store's worker, or join the validation
    /// already requested. Ready at once when the store closed, when the
    /// request is for an earlier open of it, or when a result at least as new
    /// is kept: the fresh decision reads what stands.
    pub fn validate(&self) -> Validation {
        let shared = &self.tails;
        let mut state = lock(&shared.state);
        if state.closed {
            return Validation::ready(Err(ValidationError::Closed));
        }
        let kept = state
            .validated
            .get(&(self.doc.clone(), self.lineage.clone()))
            .is_some_and(|kept| kept.engine == self.engine && kept.generation >= self.generation);
        if kept
            || state
                .store
                .as_ref()
                .is_none_or(|store| store.opening != self.opening)
        {
            return Validation::ready(Ok(()));
        }
        let key = (self.doc.clone(), self.lineage.clone(), self.generation);
        if let Some(job) = state.jobs.get(&key) {
            return job.join(shared);
        }
        let job = Arc::new(Job {
            key: key.clone(),
            engine: self.engine.clone(),
            opening: self.opening,
            outcome: Mutex::default(),
        });
        state.jobs.insert(key, Arc::clone(&job));
        state.queue.push_back(Arc::clone(&job));
        state.requests += 1;
        let mut ended = None;
        if !state.working {
            let worker = Arc::clone(shared);
            match std::thread::Builder::new()
                .name("dohc-released-tails".to_owned())
                .spawn(move || work(&worker))
            {
                Ok(handle) => {
                    state.working = true;
                    ended = state.worker.replace(handle);
                }
                Err(_) => {
                    state.jobs.remove(&job.key);
                    state.queue.clear();
                    return Validation::ready(Err(ValidationError::Failed));
                }
            }
        }
        let validation = job.join(shared);
        shared.changed.notify_all();
        drop(state);
        // The thread it replaces had found the queue empty and was ending.
        if let Some(ended) = ended {
            let _ = ended.join();
        }
        validation
    }
}

/// Completes when a requested validation does, whichever request asked for
/// it first. It never fails over to validating anywhere else. Dropping it
/// stops waiting, and a validation still queued that nobody else waits for
/// leaves the queue.
#[must_use]
pub struct Validation(Waiting);

enum Waiting {
    Ready(Option<Result<(), ValidationError>>),
    Job {
        job: Arc<Job>,
        waiter: u64,
        tails: Weak<Shared>,
    },
}

impl Drop for Validation {
    fn drop(&mut self) {
        let Waiting::Job { job, waiter, tails } = &self.0 else {
            return;
        };
        let Some(shared) = tails.upgrade() else {
            return;
        };
        let mut state = lock(&shared.state);
        let mut outcome = lock(&job.outcome);
        outcome.waiters.remove(waiter);
        if outcome.result.is_some() || !outcome.waiters.is_empty() {
            return;
        }
        drop(outcome);
        // One already running completes, and a later request can join it.
        if let Some(at) = state
            .queue
            .iter()
            .position(|queued| Arc::ptr_eq(queued, job))
        {
            state.queue.remove(at);
            if state
                .jobs
                .get(&job.key)
                .is_some_and(|current| Arc::ptr_eq(current, job))
            {
                state.jobs.remove(&job.key);
            }
        }
    }
}

impl Validation {
    fn ready(result: Result<(), ValidationError>) -> Self {
        Self(Waiting::Ready(Some(result)))
    }

    /// Block this thread until the validation completes.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn wait(mut self) -> Result<(), ValidationError> {
        struct Unpark(std::thread::Thread);
        impl std::task::Wake for Unpark {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
        let mut context = std::task::Context::from_waker(&waker);
        loop {
            if let Poll::Ready(result) =
                std::future::Future::poll(std::pin::Pin::new(&mut self), &mut context)
            {
                return result;
            }
            std::thread::park();
        }
    }
}

impl std::future::Future for Validation {
    type Output = Result<(), ValidationError>;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> Poll<Self::Output> {
        match &mut self.get_mut().0 {
            Waiting::Ready(result) => Poll::Ready(result.take().unwrap_or(Ok(()))),
            Waiting::Job { job, waiter, .. } => {
                let mut outcome = lock(&job.outcome);
                if let Some(result) = outcome.result {
                    return Poll::Ready(result);
                }
                if let Some(slot) = outcome.waiters.get_mut(waiter) {
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
    }
}

/// The worker: validate each queued request in turn, then end.
fn work(shared: &Shared) {
    loop {
        let (job, path) = {
            let mut state = lock(&shared.state);
            let next = if state.closed {
                None
            } else {
                state.queue.pop_front()
            };
            let Some(job) = next else {
                state.working = false;
                shared.changed.notify_all();
                return;
            };
            let path = state
                .store
                .as_ref()
                .filter(|store| store.opening == job.opening)
                .map(|store| store.path.clone());
            (job, path)
        };
        // A panic fails this validation's waiters, and the next goes on.
        let validated = match path {
            Some(path) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                validate_committed(shared, &job, &path)
            }))
            .unwrap_or(Err(ValidationError::Failed))
            .map(Some),
            None => Ok(None),
        };
        let result = {
            let mut state = lock(&shared.state);
            if state
                .jobs
                .get(&job.key)
                .is_some_and(|current| Arc::ptr_eq(current, &job))
            {
                state.jobs.remove(&job.key);
            }
            let current = state
                .store
                .as_ref()
                .is_some_and(|store| store.opening == job.opening);
            match validated {
                _ if state.closed => Err(ValidationError::Closed),
                Ok(Some(validated)) if current => {
                    state.validations += 1;
                    let key = (job.key.0.clone(), job.key.1.clone());
                    // A result validated on an older snapshot never replaces
                    // a newer one; the decision that needs the newer state
                    // asks again.
                    if state
                        .validated
                        .get(&key)
                        .is_none_or(|kept| kept.generation <= validated.generation)
                    {
                        state.validated.insert(key, validated);
                    }
                    Ok(())
                }
                // Another open of the store: the fresh decision asks again.
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            }
        };
        job.complete(result);
    }
}

/// The lineage's tails as the store's committed state records them, at the
/// generation that state records, which is never older than the one the
/// decision read. The read-only connection closes before this returns.
fn validate_committed(
    shared: &Shared,
    job: &Job,
    path: &std::path::Path,
) -> Result<Validated, ValidationError> {
    let (doc, lineage, requested) = &job.key;
    let mut reader = open_reader(path).map_err(|_| ValidationError::Failed)?;
    #[cfg(any(test, feature = "test-support"))]
    if let Some(hook) = *READER_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        hook(&reader);
    }
    let stopped = Arc::clone(&shared.stopped);
    reader
        .progress_handler(
            READER_STEP_OPS,
            Some(move || stopped.load(Ordering::Relaxed)),
        )
        .map_err(|_| ValidationError::Failed)?;
    if shared.stopped.load(Ordering::Relaxed) {
        return Err(ValidationError::Closed);
    }
    let tx = reader.transaction().map_err(|_| ValidationError::Failed)?;
    let (generation, engine) = tail_generation(&tx, doc).map_err(|_| ValidationError::Failed)?;
    if engine != job.engine {
        return Err(ValidationError::Failed);
    }
    let generation = generation
        .filter(|generation| generation >= requested)
        .ok_or(ValidationError::Uncommitted)?;
    #[cfg(any(test, feature = "test-support"))]
    gate(shared, &tx)?;
    let tails = protected_tails(&tx, doc, lineage)
        .map_err(|_| ValidationError::Failed)?
        .map(Arc::new);
    tx.commit().map_err(|_| ValidationError::Failed)?;
    drop(reader);
    Ok(Validated {
        engine,
        generation,
        tails,
    })
}

/// What tests hold the worker with: a pause at each validation's committed
/// snapshot, failures to report or panics to raise instead of validating,
/// and a scan of many statements that waits for close after its first.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
struct Gate {
    paused: bool,
    waiting: bool,
    failures: u64,
    panics: u64,
    /// Statements the next validation's stalled scan runs.
    stall: u64,
    /// How many of them ran.
    stalled: u64,
    /// Tasks waiting for a validation to hold at the pause.
    wakers: Vec<Waker>,
}

#[cfg(any(test, feature = "test-support"))]
fn gate(shared: &Shared, conn: &Connection) -> Result<(), ValidationError> {
    let mut state = lock(&shared.state);
    if state.gate.failures > 0 {
        state.gate.failures -= 1;
        return Err(ValidationError::Failed);
    }
    if state.gate.panics > 0 {
        state.gate.panics -= 1;
        drop(state);
        panic!("a released-tail validation panicked");
    }
    let statements = std::mem::take(&mut state.gate.stall);
    if statements > 0 {
        drop(state);
        return stall(shared, conn, statements);
    }
    state.gate.waiting = true;
    shared.changed.notify_all();
    for waker in std::mem::take(&mut state.gate.wakers) {
        waker.wake();
    }
    while state.gate.paused && !state.closed {
        state = shared
            .changed
            .wait(state)
            .unwrap_or_else(PoisonError::into_inner);
    }
    state.gate.waiting = false;
    if state.closed {
        return Err(ValidationError::Closed);
    }
    Ok(())
}

/// A scan of `statements` statements, each of a few thousand VM steps,
/// that waits between its first and second until the tails close.
#[cfg(any(test, feature = "test-support"))]
fn stall(shared: &Shared, conn: &Connection, statements: u64) -> Result<(), ValidationError> {
    for ran in 1..=statements {
        conn.query_row(
            "WITH RECURSIVE steps(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM steps WHERE n<200)
             SELECT count(*) FROM steps",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| ValidationError::Failed)?;
        let mut state = lock(&shared.state);
        state.gate.stalled = ran;
        shared.changed.notify_all();
        while ran == 1 && !state.closed {
            state = shared
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
    Ok(())
}

impl Default for ReleasedTails {
    fn default() -> Self {
        Self(Some(Arc::default()))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Results are published whole under the lock, so a panic leaves nothing
    // half kept.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a decision's transaction reads of the tails.
enum Read {
    Tails(Option<Arc<ProtectedTails>>),
    Pending(PendingValidation),
}

impl ReleasedTails {
    /// Tails each decision validates in its own transaction and never keeps:
    /// the oracle tests compare kept tails with. No production decision scans
    /// on its own connection, so only tests can build these.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn uncached() -> Self {
        Self(None)
    }

    /// These tails, for decisions on `store`. Everything kept for another
    /// open of a store is forgotten first, and its validations publish
    /// nothing.
    pub fn bound_to(&self, store: &dohc_engine_storage::EngineStore) -> Self {
        if let Some(shared) = &self.0 {
            let mut state = lock(&shared.state);
            if state
                .store
                .as_ref()
                .is_none_or(|kept| kept.opening != store.opening())
            {
                state.validated.clear();
                state.store = Some(CachedStore {
                    opening: store.opening(),
                    path: store.database_path().to_owned(),
                });
            }
        }
        self.clone()
    }

    /// Stop validating for good: refuse new requests, cancel queued ones and
    /// stop the read of the one running, wake everyone waiting, and wait for
    /// the worker and its connection to end. Call it off the actor, before
    /// the store's files are replaced.
    pub fn close(&self) {
        let Some(shared) = &self.0 else {
            return;
        };
        let (queued, worker) = {
            let mut state = lock(&shared.state);
            state.closed = true;
            shared.stopped.store(true, Ordering::Relaxed);
            state.jobs.clear();
            let queued: Vec<_> = state.queue.drain(..).collect();
            shared.changed.notify_all();
            (queued, state.worker.take())
        };
        for job in queued {
            job.complete(Err(ValidationError::Closed));
        }
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    /// How many validations these tails ran on committed state.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn validations(&self) -> u64 {
        self.0
            .as_ref()
            .map_or(0, |shared| lock(&shared.state).validations)
    }

    /// How many validations decisions asked these tails' worker for.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn validation_requests(&self) -> u64 {
        self.0
            .as_ref()
            .map_or(0, |shared| lock(&shared.state).requests)
    }

    /// Whether a worker thread of these tails is running.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn validating(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|shared| lock(&shared.state).working)
    }

    /// Hold every validation at its committed snapshot until
    /// [`Self::resume_validation`].
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn pause_validation(&self) {
        if let Some(shared) = &self.0 {
            lock(&shared.state).gate.paused = true;
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn resume_validation(&self) {
        if let Some(shared) = &self.0 {
            lock(&shared.state).gate.paused = false;
            shared.changed.notify_all();
        }
    }

    /// Block until a validation holds at the pause.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn wait_for_paused_validation(&self) {
        if let Some(shared) = &self.0 {
            let mut state = lock(&shared.state);
            while !state.gate.waiting {
                state = shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        }
    }

    /// Completes once a validation holds at the pause, for a task that must
    /// not block its thread.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn paused_validation(&self) -> impl std::future::Future<Output = ()> + '_ {
        std::future::poll_fn(move |context| {
            let Some(shared) = &self.0 else {
                return Poll::Ready(());
            };
            let mut state = lock(&shared.state);
            if state.gate.waiting {
                return Poll::Ready(());
            }
            state.gate.wakers.push(context.waker().clone());
            Poll::Pending
        })
    }

    /// Have the next `count` validations fail instead of reading.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn fail_validations(&self, count: u64) {
        if let Some(shared) = &self.0 {
            lock(&shared.state).gate.failures += count;
        }
    }

    /// Have the next `count` validations panic instead of reading.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn panic_validations(&self, count: u64) {
        if let Some(shared) = &self.0 {
            lock(&shared.state).gate.panics += count;
        }
    }

    /// Have the next validation scan `statements` statements, waiting after
    /// the first until these tails close.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn stall_validation(&self, statements: u64) {
        if let Some(shared) = &self.0 {
            lock(&shared.state).gate.stall = statements;
        }
    }

    /// How many statements the stalled scan ran, once its first did.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn stalled_statements(&self) -> u64 {
        self.0.as_ref().map_or(0, |shared| {
            let mut state = lock(&shared.state);
            while state.gate.stalled == 0 {
                state = shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            state.gate.stalled
        })
    }

    /// How many validations wait in the queue, none of them running.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn queued_validations(&self) -> usize {
        self.0
            .as_ref()
            .map_or(0, |shared| lock(&shared.state).queue.len())
    }

    /// The protected tails of the document lineage, as `conn` reads them, or
    /// the validation they wait for.
    fn read(
        &self,
        conn: &Connection,
        doc: &DocKey,
        lineage: &str,
    ) -> Result<Read, ApplicationError> {
        let Some(shared) = &self.0 else {
            return Ok(Read::Tails(
                protected_tails(conn, doc, lineage)?.map(Arc::new),
            ));
        };
        let (generation, engine) = tail_generation(conn, doc)?;
        let Some(generation) = generation else {
            // The first activation records the generation.
            return if activated(conn, doc)? {
                Err(corrupt(
                    "an activated document has no released tail generation",
                ))
            } else {
                Ok(Read::Tails(None))
            };
        };
        let opening = {
            let state = lock(&shared.state);
            let Some(store) = &state.store else {
                return Err(corrupt("released tails are not bound to a store"));
            };
            if let Some(kept) = state
                .validated
                .get(&(doc.clone(), lineage.to_owned()))
                .filter(|kept| kept.generation == generation && kept.engine == engine)
            {
                return Ok(Read::Tails(kept.tails.clone()));
            }
            store.opening
        };
        // The window is empty while an activation is current, as the worker
        // would find; every owner edit moves the generation, so asking it
        // would wait after each one.
        if readable(super::owner_activations::current_activation(
            conn, None, doc, lineage,
        ))?
        .flatten()
        .is_some()
        {
            return Ok(Read::Tails(None));
        }
        Ok(Read::Pending(PendingValidation {
            tails: Arc::clone(shared),
            doc: doc.clone(),
            lineage: lineage.to_owned(),
            generation,
            engine,
            opening,
        }))
    }
}

fn corrupt(reason: &'static str) -> ApplicationError {
    StorageError::corrupt_public(std::io::Error::other(reason)).into()
}

/// Whether any activation of the document was ever recorded, by its index.
fn activated(conn: &Connection, doc: &DocKey) -> Result<bool, ApplicationError> {
    conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM live_owner_activations
         WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
    )
    .map_err(read_sql)?
    .query_row(
        params![doc.workspace_id, doc.version_id, doc.object_id],
        |row| row.get(0),
    )
    .map_err(read_sql)
}

/// A read-only connection to the store at `path` that never checkpoints it.
fn open_reader(path: &std::path::Path) -> Result<Connection, ApplicationError> {
    let reader = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(open_failure)?;
    reader
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .map_err(open_failure)?;
    reader
        .busy_timeout(std::time::Duration::from_millis(u64::from(
            dohc_engine_storage::ENGINE_SQLITE_BUSY_TIMEOUT_MS,
        )))
        .map_err(open_failure)?;
    Ok(reader)
}

/// Why a reader could not open or fix its snapshot. A store that is busy,
/// cannot open or fails I/O, a Windows sharing violation among them, is
/// locked, which waiting may clear; anything else is the store's own state.
fn open_failure(error: rusqlite::Error) -> ApplicationError {
    use rusqlite::ErrorCode;
    match error.sqlite_error_code() {
        Some(
            ErrorCode::CannotOpen
            | ErrorCode::SystemIoFailure
            | ErrorCode::DatabaseBusy
            | ErrorCode::DatabaseLocked
            | ErrorCode::PermissionDenied,
        ) => StorageError::FileLocked.into(),
        _ => read_sql(error),
    }
}

/// The document's released tail generation, none before its first
/// activation, and the identity of the store that records it.
fn tail_generation(
    conn: &Connection,
    doc: &DocKey,
) -> Result<(Option<i64>, String), ApplicationError> {
    conn.prepare_cached(
        "SELECT (SELECT generation FROM released_tail_generations
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3),engine_uuid
         FROM engine_ownership WHERE rowid_guard=1",
    )
    .map_err(read_sql)?
    .query_row(
        params![doc.workspace_id, doc.version_id, doc.object_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(read_sql)
}

/// Whether the released window protects the head of `key`'s lineage from
/// the incoming update, and the binding a hold of it names. A tail whose
/// retained work all has proof leaves the lineage unprotected; a window or
/// tail whose evidence does not read protects it. The tails come from
/// `tails` when their validation still holds, and the decision is pending
/// otherwise; the path, restore generation and head are read for each
/// update. Storage failures stay errors.
pub fn protection(
    conn: &Connection,
    key: &ProtectionKey<'_>,
    tails: &ReleasedTails,
) -> Result<Protection, ApplicationError> {
    let tails = match tails.read(conn, key.doc, key.lineage_claim_id)? {
        Read::Tails(Some(tails)) => tails,
        Read::Tails(None) => return Ok(Protection::Unprotected),
        Read::Pending(pending) => return Ok(Protection::Pending(Box::new(pending))),
    };
    #[cfg(any(test, feature = "test-support"))]
    HEAD_LOADS_HERE.with(|loads| loads.set(loads.get() + 1));
    let head = durable::load_doc_in(conn, key.doc)?;
    let head_digest = hex_sha256(&head.encode_full_state());
    Ok(Protection::Protected {
        binding: Box::new(ReleasedLineageBinding::bound(
            conn,
            key,
            tails,
            head_digest,
        )?),
        head,
    })
}

/// Whether the released window protects `doc`'s `lineage`, from the tails
/// [`ReleasedTails::read`] answers alone: nothing of the document is loaded.
/// For a lineage no decision inspects the state of, such as an archived one.
pub fn lineage_protection(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
    tails: &ReleasedTails,
) -> Result<LineageProtection, ApplicationError> {
    #[cfg(any(test, feature = "test-support"))]
    LINEAGE_CHECKS_HERE.with(|checks| checks.set(checks.get() + 1));
    Ok(match tails.read(conn, doc, lineage)? {
        Read::Tails(Some(tails)) => LineageProtection::Protected(tails),
        Read::Tails(None) => LineageProtection::Unprotected,
        Read::Pending(pending) => LineageProtection::Pending(Box::new(pending)),
    })
}

impl ReleasedLineageBinding {
    /// The binding a hold of an archived lineage names: `key`'s lineage, its
    /// document's path and restore generation, the incoming update, the
    /// `tails` that protect it, and `state_digest`, the digest of the full
    /// state the archive keeps, in place of a head's. Never the head's.
    pub fn archived(
        conn: &Connection,
        key: &ProtectionKey<'_>,
        tails: Arc<ProtectedTails>,
        state_digest: String,
    ) -> Result<Self, ApplicationError> {
        Self::bound(conn, key, tails, state_digest)
    }

    fn bound(
        conn: &Connection,
        key: &ProtectionKey<'_>,
        tails: Arc<ProtectedTails>,
        head_digest: String,
    ) -> Result<Self, ApplicationError> {
        let doc = key.doc;
        Ok(Self {
            workspace_id: doc.workspace_id.clone(),
            main_version_id: doc.version_id.clone(),
            object_id: doc.object_id.clone(),
            lineage_claim_id: key.lineage_claim_id.to_owned(),
            current_path: bound_path(conn, doc)?,
            restore_generation: bound_restore_generation(conn, doc)?,
            incoming: key.incoming.clone(),
            head_digest,
            tails,
        })
    }
}

/// The document's path, as a binding names it; none when no alias holds it.
fn bound_path(conn: &Connection, doc: &DocKey) -> Result<Option<String>, ApplicationError> {
    conn.query_row(
        "SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![doc.workspace_id, doc.version_id, doc.object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(read_sql)
}

/// The document's restore generation, as a binding names it: 0 before any
/// restore, none while one fences it.
fn bound_restore_generation(
    conn: &Connection,
    doc: &DocKey,
) -> Result<Option<i64>, ApplicationError> {
    match restore_fence::current_generation(conn, doc) {
        Ok(generation) => Ok(Some(generation.unwrap_or(0))),
        Err(CollabError::RestoreFenced) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// How many times the calling thread loaded a head to decide its protection.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn released_head_loads_on_this_thread() -> u64 {
    HEAD_LOADS_HERE.with(std::cell::Cell::get)
}

/// How many times the calling thread decided a lineage's protection from its
/// tails alone.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn lineage_protection_checks_on_this_thread() -> u64 {
    LINEAGE_CHECKS_HERE.with(std::cell::Cell::get)
}

/// How many stored bindings the calling thread decoded.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn binding_decodes_on_this_thread() -> u64 {
    BINDING_DECODES_HERE.with(std::cell::Cell::get)
}

/// How many times this process read a released window's tails from a store,
/// on any connection, for measurements that compare revisions.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn released_tail_scans() -> u64 {
    SCANS.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(any(test, feature = "test-support"))]
static SCANS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Run `hook` on each connection a validation opens of its own, before it
/// reads, for measurements that attribute its statements; none stops.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn on_released_tail_reader(hook: Option<fn(&Connection)>) {
    *READER_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = hook;
}

#[cfg(any(test, feature = "test-support"))]
static READER_HOOK: std::sync::Mutex<Option<fn(&Connection)>> = std::sync::Mutex::new(None);

/// How many times the calling thread read a released window's tails: a
/// thread that decides on a worker's validations reads none.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn released_tail_scans_on_this_thread() -> u64 {
    SCANS_HERE.with(std::cell::Cell::get)
}

/// How many times the calling thread committed to a tail's unproven work:
/// a thread that decides on a worker's validations commits to none.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn released_tail_commitments_on_this_thread() -> u64 {
    COMMITMENTS_HERE.with(std::cell::Cell::get)
}

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static SCANS_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static COMMITMENTS_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static HEAD_LOADS_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static LINEAGE_CHECKS_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static BINDING_DECODES_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The tails of the released window that protect the document's lineage, or
/// none while nothing does. This is the one place a tail's unproven work is
/// enumerated and committed to; decisions on kept tails reuse the commitment.
fn protected_tails(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<ProtectedTails>, ApplicationError> {
    #[cfg(any(test, feature = "test-support"))]
    {
        SCANS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        SCANS_HERE.with(|scans| scans.set(scans.get() + 1));
    }
    Ok(
        window_work(conn, doc, lineage, Stop::NEVER, &mut Stop::NEVER.working())?.map(|work| {
            match work {
                WindowWork::Listed(tails) => {
                    ProtectedTails::Listed(tails.into_iter().map(|(tail, _)| tail).collect())
                }
                WindowWork::Invalid => ProtectedTails::Invalid,
            }
        }),
    )
}

/// The protected tails of the released window, each with what its
/// validation found.
pub(super) enum WindowWork {
    /// In namespace order. A tail whose coverage is invalid names no work,
    /// only the contradictions that made it so, none when its evidence does
    /// not enumerate.
    Listed(Vec<(ProtectedTail, TailWork)>),
    /// As [`ProtectedTails::Invalid`].
    Invalid,
}

/// [`protected_tails`], keeping the work each tail retains, until `stop`.
/// What it reads is reserved before it reads it, from stored lengths: the
/// window's lists, and the lineage's current activation, in `working`,
/// which also keeps each tail and its work once validated; and each tail's
/// activation and validation, with each contradiction it finds as it finds
/// it, in a reservation of their own, given back once that tail's work is
/// kept. So it reserves at most the window, every tail's kept work and the
/// largest tail's validation, never every tail's validation at once. The
/// lineage's outbox evidence, which every tail's validation reads, is
/// measured once.
pub(super) fn window_work(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
    stop: Stop<'_>,
    working: &mut Work<'_>,
) -> Result<Option<WindowWork>, ApplicationError> {
    let evidence = if working.limited() {
        working.grow(window_workload(conn, doc, lineage)?)?;
        Some(lineage_evidence(conn, doc, lineage)?)
    } else {
        None
    };
    let Some(window) = readable(super::settled_base::released_window(conn, doc, lineage))? else {
        return Ok(Some(WindowWork::Invalid));
    };
    let mut tails = Vec::new();
    for (namespace, activation_id) in window {
        let mut validating = stop.working();
        if validating.limited() {
            validating.grow(activation_workload(conn, &namespace, &activation_id)?)?;
        }
        let release = readable(super::retirement::released_binding(
            conn,
            &namespace,
            doc,
            lineage,
            &activation_id,
        ))?
        .map(|(path, restore_generation)| TailRelease {
            path,
            restore_generation,
        });
        let unproven = match release {
            Some(_) => {
                if let Some(evidence) = &evidence {
                    validating.grow(evidence.tail_workload(
                        conn,
                        &namespace,
                        doc,
                        lineage,
                        &activation_id,
                    )?)?;
                }
                readable(super::retirement::unproven_retained(
                    conn,
                    &namespace,
                    doc,
                    lineage,
                    &activation_id,
                    stop,
                    &mut validating,
                ))?
            }
            None => None,
        };
        // `unproven_retained` answers its work in canonical order.
        let (coverage, work) = match unproven {
            Some(work) if work.contradictions.is_empty() => {
                match UnprovenCommitment::of_sorted(&work.contributions) {
                    Some(unproven) => (RetainedCoverage::Unproven(unproven), work),
                    None => continue,
                }
            }
            Some(work) => (
                RetainedCoverage::Invalid,
                TailWork {
                    contributions: Vec::new(),
                    contradictions: work.contradictions,
                },
            ),
            None => (RetainedCoverage::Invalid, TailWork::default()),
        };
        let tail = ProtectedTail {
            namespace,
            activation_id,
            release,
            coverage,
        };
        // Kept before the validation that made it is given back.
        working.grow(tail_kept_bytes(&tail, &work))?;
        drop(validating);
        tails.push((tail, work));
    }
    Ok((!tails.is_empty()).then_some(WindowWork::Listed(tails)))
}

/// What a validated tail and its work keep: their text and places, its
/// contributions' and contradictions' included, and its namespace again
/// where inspection names the work it reads. The window's reservation holds
/// its namespace and activation as they are listed.
pub(super) fn tail_kept_bytes(tail: &ProtectedTail, work: &TailWork) -> u64 {
    use std::mem::size_of;
    let contributions = work.contributions.capacity() * size_of::<RetainedContribution>()
        + work
            .contributions
            .iter()
            .map(RetainedContribution::text_bytes)
            .sum::<usize>();
    let contradictions = work.contradictions.capacity() * size_of::<PreservationFinding>()
        + work
            .contradictions
            .iter()
            .map(|found| {
                found.namespace.as_ref().map_or(0, String::capacity)
                    + found
                        .contribution
                        .as_ref()
                        .map_or(0, ContributionLocator::text_bytes)
            })
            .sum::<usize>();
    let place = 2 * size_of::<(ProtectedTail, TailWork)>()
        + tail
            .release
            .as_ref()
            .map_or(0, |release| release.path.capacity())
        + tail.namespace.len();
    u64::try_from(contributions + contradictions + place).unwrap_or(u64::MAX)
}

/// A stored count or length, which is never negative.
fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

/// The most memory validating a tail holds for each byte of the evidence it
/// holds read at once: that evidence decoded, and what it lists of it, with
/// room for each list to double.
const VALIDATION_BYTES_PER_STORED_BYTE: u64 = 8;

/// What validating a tail holds beyond the bytes it reads: the row it
/// reads at a time, and the statements and sets it reads them with.
const VALIDATED_ROW_BYTES: u64 = 1024;

/// What one name a window or chain lists holds beyond its text: its place
/// in the list or set, with room for each to double.
const LISTED_NAME_BYTES: u64 = 128;

/// What a tail keeps of one outbox entry beyond the text it reads of it:
/// its place in the tail's work with room to double, and its authors'
/// canonical keys.
const KEPT_ENTRY_BYTES: u64 = 2 * std::mem::size_of::<RetainedContribution>() as u64 + 256;

/// The stored length of every text column of an activation's row that
/// reading it whole keeps.
const ACTIVATION_TEXT_SQL: &str = "coalesce(octet_length(relay_database_namespace),0)\
    +coalesce(octet_length(activation_id),0)+coalesce(octet_length(binding_json),0)\
    +coalesce(octet_length(source_moment_id),0)+coalesce(octet_length(source_digest),0)\
    +coalesce(octet_length(host_coordinate_json),0)+coalesce(octet_length(evidence_digest),0)\
    +coalesce(octet_length(coverage_digest),0)+coalesce(octet_length(terminal_receipt_json),0)\
    +coalesce(octet_length(workspace_id),0)+coalesce(octet_length(main_version_id),0)\
    +coalesce(octet_length(object_id),0)+coalesce(octet_length(lineage_claim_id),0)\
    +coalesce(octet_length(predecessor_activation_id),0)";

/// What reading one activation of `text` stored bytes and decoding its
/// binding hold.
fn activation_bytes(text: u64) -> u64 {
    text.saturating_mul(VALIDATION_BYTES_PER_STORED_BYTE)
        .saturating_add(VALIDATED_ROW_BYTES)
}

/// What reading the released window of `doc`'s `lineage` holds at most,
/// from its activations' stored lengths, read before any is: each
/// namespace and tail it lists, as listed and as each tail keeps them, and
/// the lineage's current activation, read whole, when it has one.
pub(super) fn window_workload(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
) -> Result<u64, ApplicationError> {
    let (activations, names, current): (i64, i64, i64) = conn
        .prepare_cached(&format!(
            "SELECT count(*),
               coalesce(sum(octet_length(relay_database_namespace)+octet_length(activation_id)),0),
               coalesce(max(CASE WHEN released_at_ms IS NULL THEN {ACTIVATION_TEXT_SQL} END),0)
             FROM live_owner_activations WHERE workspace_id=?1 AND main_version_id=?2
             AND object_id=?3 AND lineage_claim_id=?4"
        ))
        .map_err(read_sql)?
        .query_row(
            params![doc.workspace_id, doc.version_id, doc.object_id, lineage],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(read_sql)?;
    Ok(unsigned(names)
        .saturating_mul(2)
        .saturating_add(unsigned(activations).saturating_mul(2 * LISTED_NAME_BYTES))
        .saturating_add(activation_bytes(unsigned(current))))
}

/// What reading the activation `activation_id` of `namespace` and decoding
/// its binding hold, from its stored lengths, read before it is.
pub(super) fn activation_workload(
    conn: &Connection,
    namespace: &str,
    activation_id: &str,
) -> Result<u64, ApplicationError> {
    let text: Option<i64> = conn
        .prepare_cached(&format!(
            "SELECT {ACTIVATION_TEXT_SQL} FROM live_owner_activations
             WHERE relay_database_namespace=?1 AND activation_id=?2"
        ))
        .map_err(read_sql)?
        .query_row(params![namespace, activation_id], |row| row.get(0))
        .optional()
        .map_err(read_sql)?;
    Ok(activation_bytes(unsigned(text.unwrap_or(0))))
}

/// What validating any tail of a lineage reads of its outbox evidence, from
/// its entries' stored lengths: how many there are, the text a tail keeps
/// of all of them at most, and the longest, which it reads and decodes
/// alone.
pub(super) struct LineageEvidence {
    entries: u64,
    kept_text: u64,
    longest: u64,
}

/// The outbox evidence of `doc`'s `lineage`, measured once for every tail.
pub(super) fn lineage_evidence(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
) -> Result<LineageEvidence, ApplicationError> {
    let (entries, kept_text, longest): (i64, i64, i64) = conn
        .prepare_cached(
            "SELECT count(*),
               coalesce(sum(octet_length(e.outbox_id)+octet_length(e.delivery_id)
                 +octet_length(e.update_digest)+coalesce(octet_length(e.native_source_json),0)
                 +coalesce(octet_length(e.agent_declaration_json),0)
                 +coalesce(octet_length(e.automation_declaration_json),0)),0),
               coalesce(max(octet_length(e.outbox_id)+octet_length(e.append_key)
                 +octet_length(e.delivery_id)+octet_length(e.update_digest)
                 +coalesce(octet_length(e.native_source_json),0)
                 +coalesce(octet_length(e.accepted_receipt_json),0)
                 +coalesce(octet_length(e.terminal_reason),0)
                 +coalesce(octet_length(e.agent_declaration_json),0)
                 +coalesce(octet_length(e.automation_declaration_json),0)),0)
             FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
             WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3
             AND o.lineage_claim_id=?4",
        )
        .map_err(read_sql)?
        .query_row(
            params![doc.workspace_id, doc.version_id, doc.object_id, lineage],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(read_sql)?;
    Ok(LineageEvidence {
        entries: unsigned(entries),
        kept_text: unsigned(kept_text),
        longest: unsigned(longest),
    })
}

impl LineageEvidence {
    /// What validating the tail `tail` of `namespace` holds at most beside
    /// reading its activation, from stored lengths read before it reads
    /// any: its release's boundary and Carried manifest, decoded and listed
    /// while it runs; the lineage's entries one at a time, and what it keeps
    /// of all of them; the namespace's activations and an adoption's
    /// capture one at a time, and the identities of its chain.
    pub(super) fn tail_workload(
        &self,
        conn: &Connection,
        namespace: &str,
        doc: &DocKey,
        lineage: &str,
        tail: &str,
    ) -> Result<u64, ApplicationError> {
        let (released, activations, identities, longest_activation, longest_capture): (
            Option<i64>,
            i64,
            i64,
            i64,
            i64,
        ) = conn
            .prepare_cached(&format!(
                "SELECT
                   (SELECT coalesce(octet_length(released_boundary_json),0)
                      +coalesce(octet_length(carried_manifest_json),0)
                    FROM live_owner_activations WHERE relay_database_namespace=?1 AND activation_id=?2),
                   count(*),coalesce(sum(octet_length(activation_id)),0),
                   coalesce(max({ACTIVATION_TEXT_SQL}),0),
                   (SELECT coalesce(max(octet_length(descriptor_json)),0)
                    FROM ydoc_owner_activation_sources WHERE relay_database_namespace=?1
                    AND workspace_id=?3 AND version_id=?4 AND object_id=?5 AND lineage_claim_id=?6)
                 FROM live_owner_activations WHERE relay_database_namespace=?1"
            ))
            .map_err(read_sql)?
            .query_row(
                params![namespace, tail, doc.workspace_id, doc.version_id, doc.object_id, lineage],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(read_sql)?;
        let decoded = unsigned(released.unwrap_or(0))
            .saturating_add(self.longest)
            .saturating_add(unsigned(longest_activation))
            .saturating_add(unsigned(longest_capture))
            .saturating_mul(VALIDATION_BYTES_PER_STORED_BYTE);
        let chain = unsigned(identities)
            .saturating_add(unsigned(activations).saturating_mul(LISTED_NAME_BYTES));
        let kept = self
            .kept_text
            .saturating_add(self.entries.saturating_mul(KEPT_ENTRY_BYTES));
        Ok(decoded
            .saturating_add(chain)
            .saturating_add(kept)
            .saturating_add(VALIDATED_ROW_BYTES))
    }
}
