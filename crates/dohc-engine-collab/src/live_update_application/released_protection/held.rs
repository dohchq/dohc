//! A held document's proof, run off the store's actor. The proof reads one
//! committed snapshot on a read-only connection of its own, which closes
//! before its answer is handed over. What it read beyond the evidence the
//! document's released tail generation covers, its caller names by bounded
//! coordinates and compares again on the actor before releasing the answer.
use super::*;
use crate::ContentKind;

/// The held-document proofs of one store's actor.
#[derive(Clone, Default)]
pub struct HeldProofs {
    #[cfg(any(test, feature = "test-support"))]
    gate: Arc<Gate>,
}

/// One held-document proof of a store's committed state: the open of the
/// store it reads, and whether it should stop. Everyone waiting for the
/// proof shares it.
pub struct HeldProofJob {
    opening: u64,
    path: std::path::PathBuf,
    /// Set when nobody waits for the proof any more. Its reader stops at its
    /// next statement, and within [`READER_STEP_OPS`] steps of the one
    /// running.
    cancelled: Arc<AtomicBool>,
    #[cfg(any(test, feature = "test-support"))]
    gate: Arc<Gate>,
}

impl HeldProofs {
    /// A proof of `store`'s committed state. Admitting it reads nothing.
    pub fn job(&self, store: &dohc_engine_storage::EngineStore) -> HeldProofJob {
        HeldProofJob {
            opening: store.opening(),
            path: store.database_path().to_owned(),
            cancelled: Arc::default(),
            #[cfg(any(test, feature = "test-support"))]
            gate: Arc::clone(&self.gate),
        }
    }
}

impl HeldProofJob {
    /// The open of the store the proof reads.
    pub fn opening(&self) -> u64 {
        self.opening
    }

    /// Stop the proof: its reader at its next statement, and the proof
    /// itself at its next check.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
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
        self.gate.hold();
        Ok((tx, engine))
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

/// What tests hold proofs with: a pause at each proof's snapshot.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
struct GateState {
    paused: bool,
    /// Proofs holding at the pause.
    waiting: usize,
    /// Tasks waiting for a proof to hold there.
    wakers: Vec<Waker>,
}

#[cfg(any(test, feature = "test-support"))]
impl Gate {
    fn hold(&self) {
        let mut state = lock(&self.state);
        state.waiting += 1;
        for waker in std::mem::take(&mut state.wakers) {
            waker.wake();
        }
        self.changed.notify_all();
        while state.paused {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.waiting -= 1;
    }
}

#[cfg(any(test, feature = "test-support"))]
impl HeldProofs {
    /// Hold every proof at its snapshot until [`Self::resume_proofs`].
    #[doc(hidden)]
    pub fn pause_proofs(&self) {
        lock(&self.gate.state).paused = true;
    }

    #[doc(hidden)]
    pub fn resume_proofs(&self) {
        lock(&self.gate.state).paused = false;
        self.gate.changed.notify_all();
    }

    /// Block until a proof holds at the pause.
    #[doc(hidden)]
    pub fn wait_for_paused_proof(&self) {
        let mut state = lock(&self.gate.state);
        while state.waiting == 0 {
            state = self
                .gate
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Completes once a proof holds at the pause, for a task that must not
    /// block its thread.
    #[doc(hidden)]
    pub fn paused_proof(&self) -> impl std::future::Future<Output = ()> + '_ {
        std::future::poll_fn(move |context| {
            let mut state = lock(&self.gate.state);
            if state.waiting > 0 {
                return Poll::Ready(());
            }
            state.wakers.push(context.waker().clone());
            Poll::Pending
        })
    }
}
