//! The writer thread's cache of live Y.Docs, serving the replay-parity gate's
//! base on cached local and ordinary-remote append paths so they stop paying a
//! full `load_doc_in` reconstruction per append.
//!
//! ## The CACHE-VALID invariant
//!
//! An entry may serve as the gate base only when it is **byte-replay-identical**
//! to what `load_doc_in` would rebuild inside the same transaction:
//! the cached doc applied exactly the byte sequence, in the same order, that a
//! fresh reconstruction would apply. Logical CRDT equality is not sufficient —
//! yrs block splits are history-sensitive, and the gate reads the base's
//! delete-set endpoints. The proof is carried by [`CacheTuple`]: every marker
//! field that names the replay path, plus the sha of the log row at the head
//! seq. A hit requires the whole tuple to match inside the caller's write
//! transaction; any mismatch is a miss and the caller reconstructs as before.
//!
//! ## Containment
//!
//! The cache serves local and ordinary remote parity-gate bases plus read-only
//! consumers: settle projection, resync, deferred-update validation, and final
//! drain projection. Forced compaction, close, `claim_base`, origination, and
//! lineage successor always fully reconstruct. Durable lineage bytes are never
//! derived from the cache.
//! The byte-replay document, frontier, tuple, map, and accounting are never
//! mutated inside a transaction. The check-4-only persistent scratch applies a
//! gated candidate in place; the transaction probe retains it only after an
//! exact commit and evicts it after any rollback or post-mutation refusal.
//!
//! Single writer: one workspace store has one writer thread (`worker_main`),
//! and the cache is a plain local of that thread. The head-row sha probe is
//! defense-in-depth on top of that contract.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use dohc_engine_storage::{EngineStore, TxnOutcome};
use rusqlite::{Connection, OptionalExtension};

use crate::durable::{
    binary_blob_for_gate, latest_snapshot, map_sql, read_marker_in, AppendOutcome, Marker,
};
use crate::error::CollabError;
use crate::replay_parity::{IntegratedFrontier, IntegratedFrontierDelta};
use crate::ydoc::Ydoc;
use crate::DocKey;

/// Hard cap on resident entries.
const MAX_ENTRIES: usize = 16;
/// Encoded-wire-byte budget across all entries. It does not bound in-memory size.
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// The durable coordinates that name one exact replay path. Two lineage states
/// with equal tuples replay the same byte sequence, except a lineage reset that
/// later rebuilds the same coordinates over different history. Every such reset
/// must call [`WriterDocCache::remove`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct CacheTuple {
    head_update_seq: i64,
    head_snapshot_seq: i64,
    lineage_claim_id: Option<String>,
    lineage_epoch_tag: Option<String>,
    /// Sha of the log row at `head_update_seq`; `None` when the head is folded
    /// into the snapshot (`head_update_seq == head_snapshot_seq`).
    head_row_sha: Option<String>,
}

impl CacheTuple {
    fn from_marker(marker: &Marker, head_row_sha: Option<String>) -> Self {
        CacheTuple {
            head_update_seq: marker.head_update_seq,
            head_snapshot_seq: marker.head_snapshot_seq,
            lineage_claim_id: marker.lineage_claim_id.clone(),
            lineage_epoch_tag: marker.lineage_epoch_tag.clone(),
            head_row_sha,
        }
    }

    fn after_append(marker: &Marker, seq: i64, update_sha: &str) -> Self {
        let mut tuple = Self::from_marker(marker, Some(update_sha.to_owned()));
        tuple.head_update_seq = seq;
        tuple
    }

    fn read_for_marker(
        conn: &Connection,
        key: &DocKey,
        marker: &Marker,
    ) -> Result<Option<Self>, CollabError> {
        let head_row_sha = if marker.head_update_seq > marker.head_snapshot_seq {
            match head_row_sha(conn, key, marker.head_update_seq)? {
                Some(sha) => Some(sha),
                None => return Ok(None),
            }
        } else {
            None
        };
        Ok(Some(CacheTuple::from_marker(marker, head_row_sha)))
    }

    /// Read the current tuple from the caller's connection, or `None` when the
    /// marker is absent or torn (head row missing).
    fn read_current(conn: &Connection, key: &DocKey) -> Result<Option<Self>, CollabError> {
        let Some(marker) = read_marker_in(conn, key)? else {
            return Ok(None);
        };
        Self::read_for_marker(conn, key, &marker)
    }
}

fn head_row_sha(conn: &Connection, key: &DocKey, seq: i64) -> Result<Option<String>, CollabError> {
    conn.query_row(
        "SELECT update_blob_sha256 FROM ydoc_updates \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND seq = ?4",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id, seq],
        |row| row.get(0),
    )
    .optional()
    .map_err(map_sql)
}

struct CacheEntry {
    doc: Ydoc,
    frontier: IntegratedFrontier,
    /// Full-state fork used only for replay-parity check 4. It is never served
    /// as content, promoted to `doc`, or used to produce durable bytes.
    gate_scratch: Option<PersistentGateScratch>,
    tuple: CacheTuple,
    approx_bytes: usize,
    last_used: Cell<u64>,
}

type CachedGateArtifacts<'a> = (&'a Ydoc, &'a IntegratedFrontier, Option<&'a Ydoc>);

struct CacheInstall {
    doc: Ydoc,
    frontier: IntegratedFrontier,
    gate_scratch: Option<Ydoc>,
    candidate: IntegratedFrontierDelta,
}

struct PersistentGateScratch {
    doc: Ydoc,
    approx_bytes: usize,
}

impl PersistentGateScratch {
    fn new(doc: Ydoc) -> Self {
        let approx_bytes = approx_doc_bytes(&doc);
        PersistentGateScratch { doc, approx_bytes }
    }
}

fn approx_doc_bytes(doc: &Ydoc) -> usize {
    doc.encode_full_state()
        .len()
        .saturating_add(doc.pending_update_v1().map_or(0, |bytes| bytes.len()))
}

/// Hit/miss/maintenance counters (test evidence; negligible cost).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub installs: u64,
    pub advances: u64,
    pub removes: u64,
}

/// What one gate invocation observed, carried out of the append transaction so
/// the post-commit step knows how to advance the cache. Built only by
/// [`super::durable`]'s local append path.
#[derive(Default)]
pub(crate) struct GateBaseProbe {
    pub(crate) served: Option<ServedGateBase>,
    pub(crate) candidate: Option<IntegratedFrontierDelta>,
    /// Fresh post-candidate scratch when the entry had none at gate time.
    pub(crate) rebuilt_scratch: Option<Ydoc>,
    /// Set immediately before a resident scratch applies the candidate.
    pub(crate) scratch_mutated: bool,
    commit: Option<CacheCommitToken>,
}

impl GateBaseProbe {
    /// Capture the transaction's final replay coordinates without making cache
    /// maintenance capable of failing the append.
    pub(crate) fn capture_commit(&mut self, conn: &Connection, key: &DocKey) {
        self.commit = Some(CacheCommitToken(
            CacheTuple::read_current(conn, key).ok().flatten(),
        ));
    }
}

pub(crate) struct ServedGateBase {
    pub(crate) source: GateBaseSource,
    /// The marker as observed inside the append transaction, at gate time.
    pub(crate) observed: Marker,
}

pub(crate) enum GateBaseSource {
    Hit,
    /// The rebuilt PRE-APPEND base doc, read inside the append transaction and
    /// handed out with the frontier derived from that gate's exact base scan
    /// for a post-commit install.
    Rebuilt {
        doc: Ydoc,
        frontier: IntegratedFrontier,
    },
}

/// Proof carried from an ordinary remote admission transaction to post-commit
/// cache maintenance. The gate records the exact pre-append base and the sync
/// caller captures the transaction's final replay tuple after projection.
#[derive(Default)]
#[doc(hidden)]
pub struct RemoteAppendProbe {
    pub(crate) served: Option<ServedGateBase>,
    pub(crate) applied_seq: Option<i64>,
    pub(crate) candidate: Option<IntegratedFrontierDelta>,
    /// Fresh post-candidate scratch when the entry had none at gate time.
    pub(crate) rebuilt_scratch: Option<Ydoc>,
    /// Set immediately before a resident scratch applies the candidate.
    pub(crate) scratch_mutated: bool,
    commit: Option<CacheCommitToken>,
}

impl RemoteAppendProbe {
    /// Capture the transaction's final replay coordinates. Call this after all
    /// envelope-side work that can affect the lineage and before returning the
    /// retained mutation outcome.
    #[doc(hidden)]
    pub fn capture_commit(&mut self, conn: &Connection, key: &DocKey) {
        self.commit = Some(CacheCommitToken(
            CacheTuple::read_current(conn, key).ok().flatten(),
        ));
    }
}

/// The final replay coordinates observed after all in-transaction append work.
/// Only a normally committed outcome may consume this token.
struct CacheCommitToken(Option<CacheTuple>);

enum GateScratchAdvance {
    /// The cached append gate already applied this candidate in-transaction.
    AlreadyApplied,
    /// A cold check-4 replay produced the exact post-candidate scratch.
    Replace(Ydoc),
    /// A deferred gate stayed cold; advance any resident companion now.
    ApplyAfterCommit,
}

/// The single-writer-thread cache. `!Send` on purpose (it caches `Ydoc`s); it
/// lives and dies with the workspace store's worker thread.
#[derive(Default)]
pub struct WriterDocCache {
    entries: HashMap<DocKey, CacheEntry>,
    /// Keys of currently open live sessions: evicted last. Order-only state —
    /// a leaked pin (a session that never closes cleanly) affects eviction
    /// preference, never correctness.
    pinned: HashSet<DocKey>,
    tick: Cell<u64>,
    hits: Cell<u64>,
    misses: Cell<u64>,
    installs: u64,
    advances: u64,
    removes: u64,
    max_entries: Option<usize>,
    max_total_bytes: Option<usize>,
}

impl WriterDocCache {
    pub fn new() -> Self {
        WriterDocCache::default()
    }

    /// A cache with tiny limits so tests can exercise eviction without
    /// building 64 MiB of documents.
    #[doc(hidden)]
    pub fn with_limits_for_test(max_entries: usize, max_total_bytes: usize) -> Self {
        WriterDocCache {
            max_entries: Some(max_entries),
            max_total_bytes: Some(max_total_bytes),
            ..WriterDocCache::default()
        }
    }

    fn touch(&self, entry: &CacheEntry) {
        self.tick.set(self.tick.get() + 1);
        entry.last_used.set(self.tick.get());
    }

    /// Tuple-validated base plus both parity companions for cached local and
    /// ordinary-remote appends. Deferred remote paths remain cold.
    pub(crate) fn base_frontier_and_scratch_for_gate(
        &self,
        conn: &Connection,
        key: &DocKey,
        marker: &Marker,
    ) -> Result<Option<CachedGateArtifacts<'_>>, CollabError> {
        let Some(entry) = self.validated_entry(conn, key, marker)? else {
            return Ok(None);
        };
        // This assertion deliberately sits outside replay_parity's
        // catch_unwind so a poisoned frontier fails the debug/test process
        // loudly instead of being mapped to an ordinary gate refusal.
        #[cfg(any(test, debug_assertions))]
        entry.frontier.assert_matches_doc(&entry.doc)?;
        Ok(Some((
            &entry.doc,
            &entry.frontier,
            entry.gate_scratch.as_ref().map(|scratch| &scratch.doc),
        )))
    }

    /// A cached-local gate can fail after mutating the resident check-4
    /// scratch. The database transaction rolls back, but yrs cannot, so drop
    /// only that companion and rebuild it cold on the next gate.
    pub(crate) fn finish_local_gate_error(&mut self, key: &DocKey, probe: &GateBaseProbe) {
        if probe.scratch_mutated {
            self.evict_gate_scratch(key);
        }
    }

    /// An ordinary-remote transaction failed or rolled back after its gate
    /// mutated the resident check-4 scratch. Keep the writer doc and frontier,
    /// but discard the companion that yrs cannot roll back.
    #[doc(hidden)]
    pub fn finish_remote_gate_error(&mut self, key: &DocKey, probe: &RemoteAppendProbe) {
        if probe.scratch_mutated {
            self.evict_gate_scratch(key);
        }
    }

    /// Serve a read-only PR3 consumer after validating the entry against the
    /// current durable replay tuple. A miss leaves reconstruction to the
    /// caller, preserving each consumer's existing absence/error semantics.
    pub fn doc_for_consumer(
        &self,
        conn: &Connection,
        key: &DocKey,
    ) -> Result<Option<&Ydoc>, CollabError> {
        let Some(marker) = read_marker_in(conn, key)? else {
            self.misses.set(self.misses.get() + 1);
            return Ok(None);
        };
        Ok(self
            .validated_entry(conn, key, &marker)?
            .map(|entry| &entry.doc))
    }

    fn validated_entry(
        &self,
        conn: &Connection,
        key: &DocKey,
        marker: &Marker,
    ) -> Result<Option<&CacheEntry>, CollabError> {
        let Some(entry) = self.entries.get(key) else {
            self.misses.set(self.misses.get() + 1);
            return Ok(None);
        };
        // O(1) head-row probe: the row at the head seq must hold exactly the
        // sha the entry advanced with. A folded head (head == snapshot seq)
        // has no row and the tuple must agree.
        let current = CacheTuple::read_for_marker(conn, key, marker)?;
        if current.as_ref() != Some(&entry.tuple) {
            self.misses.set(self.misses.get() + 1);
            return Ok(None);
        }

        // Differential check: in every test/debug build, a hit re-proves
        // CACHE-VALID against a fresh reconstruction, so the whole debug test
        // fleet checks the invariant on every cache-served gate. The v2
        // predicate compares canonical full-state wire topology, decoded state
        // vectors, and pending internals. It never compares raw re-encode or
        // encoded state-vector bytes because HashMap key order is semantically
        // inert and can differ across Y.Doc instances.
        #[cfg(any(test, debug_assertions))]
        {
            use crate::replay_parity::structurally_equal_v2;
            let fresh = crate::durable::load_doc_in(conn, key)?;
            assert!(
                structurally_equal_v2(&fresh, &entry.doc)?,
                "CACHE-VALID violated: cached Y.Doc structure \
                 diverges from load_doc_in for {key:?}"
            );
        }

        self.hits.set(self.hits.get() + 1);
        self.touch(entry);
        Ok(Some(entry))
    }

    /// Advance a resident entry after a deferred remote delta committed.
    ///
    /// This does not serve the deferred replay gate, which remains cold under
    /// It only keeps the already-validated cached document aligned so
    /// the drain's final read-only projection can reuse it. The post-commit
    /// marker tuple must prove that exactly this one row advanced the lineage;
    /// a fold, reset, crash-after-commit, or any surprising side effect evicts.
    pub(crate) fn finish_deferred_remote_append(
        &mut self,
        store: &EngineStore,
        key: &DocKey,
        outcome: &TxnOutcome<crate::replication::ReplicationApplyOutcome>,
        update: &[u8],
        candidate: Option<IntegratedFrontierDelta>,
    ) {
        use crate::replication::ReplicationApplyOutcome;

        match outcome {
            TxnOutcome::Committed(ReplicationApplyOutcome::Deduped { .. }) => {}
            TxnOutcome::Committed(ReplicationApplyOutcome::Applied { seq, .. }) => {
                let Some(candidate) = candidate else {
                    self.remove(key);
                    return;
                };
                let Some(observed) = self.entries.get(key).map(|entry| entry.tuple.clone()) else {
                    return;
                };
                let current = store
                    .read_with(|conn| CacheTuple::read_current(conn, key))
                    .ok()
                    .flatten();
                let update_sha = crate::hex_sha256(update);
                let mut expected = observed.clone();
                expected.head_update_seq = *seq;
                expected.head_row_sha = Some(update_sha);
                if *seq == observed.head_update_seq + 1 && current.as_ref() == Some(&expected) {
                    self.advance_committed(
                        key,
                        update,
                        candidate,
                        expected,
                        GateScratchAdvance::ApplyAfterCommit,
                    );
                } else {
                    self.remove(key);
                }
            }
            TxnOutcome::Crashed { committed: true } => self.remove(key),
            TxnOutcome::Crashed { committed: false } => {}
        }
    }

    /// Advance or install the entry after an ordinary remote append and its
    /// admission transaction committed. The final tuple proves that the
    /// transaction changed the replay path by exactly the gated candidate.
    /// This includes a retained mutation whose projection was refused.
    #[doc(hidden)]
    pub fn finish_remote_append(&mut self, key: &DocKey, update: &[u8], probe: RemoteAppendProbe) {
        let RemoteAppendProbe {
            served,
            applied_seq,
            candidate,
            rebuilt_scratch,
            scratch_mutated,
            commit,
        } = probe;
        let Some(served) = served else {
            if scratch_mutated {
                self.evict_gate_scratch(key);
            }
            return;
        };
        let (Some(seq), Some(candidate), Some(CacheCommitToken(Some(fresh)))) =
            (applied_seq, candidate, commit)
        else {
            self.remove(key);
            return;
        };
        let update_sha = crate::hex_sha256(update);
        let expected = CacheTuple::after_append(&served.observed, seq, &update_sha);
        if seq != served.observed.head_update_seq + 1 || fresh != expected {
            self.remove(key);
            return;
        }
        let scratch_advance = match (scratch_mutated, rebuilt_scratch) {
            (true, None) => GateScratchAdvance::AlreadyApplied,
            (false, Some(scratch)) => GateScratchAdvance::Replace(scratch),
            _ => {
                self.remove(key);
                return;
            }
        };
        match served.source {
            GateBaseSource::Hit => {
                self.advance_committed(key, update, candidate, fresh, scratch_advance)
            }
            GateBaseSource::Rebuilt { doc, frontier } => {
                let GateScratchAdvance::Replace(scratch) = scratch_advance else {
                    self.remove(key);
                    return;
                };
                self.install_committed(
                    key,
                    CacheInstall {
                        doc,
                        frontier,
                        gate_scratch: Some(scratch),
                        candidate,
                    },
                    update,
                    fresh,
                )
            }
        }
    }

    /// Advance or install the entry for one committed, genuinely-new local
    /// append. The end-of-transaction token proves that the commit changed the
    /// replay path by exactly this append: the head advanced by one, its row
    /// holds `update_sha`, and every other tuple field is unchanged. An
    /// in-transaction base origination or an extra append removes the entry.
    /// Cache maintenance never fails the append.
    pub(crate) fn finish_local_append(
        &mut self,
        key: &DocKey,
        outcome: &TxnOutcome<AppendOutcome>,
        update: &[u8],
        update_sha: &str,
        probe: GateBaseProbe,
    ) {
        match outcome {
            TxnOutcome::Committed(app) if app.deduped => {
                // A dedupe changed nothing: the entry (if any) is still valid.
            }
            TxnOutcome::Committed(app) => {
                let GateBaseProbe {
                    served,
                    candidate,
                    rebuilt_scratch,
                    scratch_mutated,
                    commit,
                } = probe;
                let Some(served) = served else {
                    // A non-deduped append that never reached the gate is
                    // unexpected; fail safe.
                    self.remove(key);
                    return;
                };
                let Some(CacheCommitToken(Some(fresh))) = commit else {
                    self.remove(key);
                    return;
                };
                let Some(candidate) = candidate else {
                    self.remove(key);
                    return;
                };
                let observed = &served.observed;
                let expected = CacheTuple::after_append(observed, app.seq, update_sha);
                let exactly_this_append =
                    app.seq == observed.head_update_seq + 1 && fresh == expected;
                if !exactly_this_append {
                    self.remove(key);
                    return;
                }
                let scratch_advance = match (scratch_mutated, rebuilt_scratch) {
                    (true, None) => GateScratchAdvance::AlreadyApplied,
                    (false, Some(scratch)) => GateScratchAdvance::Replace(scratch),
                    _ => {
                        self.remove(key);
                        return;
                    }
                };
                match served.source {
                    GateBaseSource::Hit => {
                        self.advance_committed(key, update, candidate, fresh, scratch_advance)
                    }
                    GateBaseSource::Rebuilt { doc, frontier } => {
                        let GateScratchAdvance::Replace(scratch) = scratch_advance else {
                            self.remove(key);
                            return;
                        };
                        self.install_committed(
                            key,
                            CacheInstall {
                                doc,
                                frontier,
                                gate_scratch: Some(scratch),
                                candidate,
                            },
                            update,
                            fresh,
                        )
                    }
                }
            }
            // Durable-but-unacked: the head advanced without a verified
            // advancement path. Fail safe.
            TxnOutcome::Crashed { committed: true } => self.remove(key),
            // The writer doc/frontier stay valid across rollback. A resident
            // scratch already applied the candidate and has no rollback, so
            // evict only that companion.
            TxnOutcome::Crashed { committed: false } => {
                if probe.scratch_mutated {
                    self.evict_gate_scratch(key);
                }
            }
        }
    }

    /// Apply exactly the committed candidate bytes to the cached doc.
    fn advance_committed(
        &mut self,
        key: &DocKey,
        applied: &[u8],
        candidate: IntegratedFrontierDelta,
        tuple: CacheTuple,
        scratch_advance: GateScratchAdvance,
    ) {
        let Some(entry) = self.entries.get_mut(key) else {
            return;
        };
        if entry.doc.apply(applied).is_err() {
            // The gate admitted these bytes; an apply failure here means the
            // cached doc cannot be trusted.
            self.remove(key);
            return;
        }
        let (previous_frontier_bytes, frontier_bytes) = entry.frontier.fold(candidate);
        entry.tuple = tuple;
        entry.approx_bytes = entry
            .approx_bytes
            .saturating_sub(previous_frontier_bytes)
            .saturating_add(applied.len())
            .saturating_add(frontier_bytes);

        let scratch_valid = match scratch_advance {
            GateScratchAdvance::AlreadyApplied => {
                if let Some(scratch) = entry.gate_scratch.as_mut() {
                    scratch.approx_bytes = scratch.approx_bytes.saturating_add(applied.len());
                    entry.approx_bytes = entry.approx_bytes.saturating_add(applied.len());
                    true
                } else {
                    false
                }
            }
            GateScratchAdvance::Replace(doc) => {
                if let Some(previous) = entry.gate_scratch.take() {
                    entry.approx_bytes = entry.approx_bytes.saturating_sub(previous.approx_bytes);
                }
                let replacement = PersistentGateScratch::new(doc);
                entry.approx_bytes = entry.approx_bytes.saturating_add(replacement.approx_bytes);
                entry.gate_scratch = Some(replacement);
                true
            }
            GateScratchAdvance::ApplyAfterCommit => {
                if let Some(scratch) = entry.gate_scratch.as_mut() {
                    if scratch.doc.apply(applied).is_err() {
                        let discarded = entry
                            .gate_scratch
                            .take()
                            .expect("the failed resident scratch still exists");
                        entry.approx_bytes =
                            entry.approx_bytes.saturating_sub(discarded.approx_bytes);
                    } else {
                        scratch.approx_bytes = scratch.approx_bytes.saturating_add(applied.len());
                        entry.approx_bytes = entry.approx_bytes.saturating_add(applied.len());
                    }
                }
                true
            }
        };
        if !scratch_valid {
            self.remove(key);
            return;
        }
        self.advances += 1;
        let entry = &self.entries[key];
        self.touch(entry);
        self.evict_to_budget();
    }

    /// Warm the cache from the base doc rebuilt inside the just-committed
    /// transaction, advanced with the committed candidate.
    fn install_committed(
        &mut self,
        key: &DocKey,
        install: CacheInstall,
        applied: &[u8],
        tuple: CacheTuple,
    ) {
        let CacheInstall {
            doc,
            mut frontier,
            gate_scratch,
            candidate,
        } = install;
        if doc.apply(applied).is_err() {
            self.remove(key);
            return;
        }
        frontier.fold(candidate);
        let gate_scratch = gate_scratch.map(PersistentGateScratch::new);
        let approx_bytes = approx_doc_bytes(&doc)
            .saturating_add(frontier.approx_bytes())
            .saturating_add(
                gate_scratch
                    .as_ref()
                    .map_or(0, |scratch| scratch.approx_bytes),
            );
        if approx_bytes > self.max_total_bytes() {
            self.remove(key);
            return;
        }
        let entry = CacheEntry {
            doc,
            frontier,
            gate_scratch,
            tuple,
            approx_bytes,
            last_used: Cell::new(0),
        };
        self.touch(&entry);
        self.entries.insert(key.clone(), entry);
        self.installs += 1;
        self.evict_to_budget();
    }

    /// Re-base the entry across a compaction: the freshly minted snapshot IS
    /// the whole replay path (head == snapshot seq), so rebuilding from its
    /// bytes preserves replay-path equality. Anything unexpected (a torn read,
    /// a different latest snapshot, a head past the fold) removes the entry.
    #[doc(hidden)]
    pub fn note_compacted(
        &mut self,
        store: &EngineStore,
        key: &DocKey,
        up_to_seq: i64,
        snapshot_sha: &str,
    ) {
        if !self.entries.contains_key(key) {
            return;
        }
        let read = store.read_with(|conn| -> Result<_, CollabError> {
            let tuple = CacheTuple::read_current(conn, key)?;
            let snapshot = latest_snapshot(conn, key)?;
            let bytes = binary_blob_for_gate(conn, snapshot_sha)?;
            Ok((tuple, snapshot, bytes))
        });
        let Ok((Some(tuple), Some((latest_seq, latest_sha)), bytes)) = read else {
            self.remove(key);
            return;
        };
        let rebased = tuple.head_update_seq == up_to_seq
            && tuple.head_snapshot_seq == up_to_seq
            && tuple.head_row_sha.is_none()
            && latest_seq == up_to_seq
            && latest_sha == snapshot_sha;
        if !rebased {
            self.remove(key);
            return;
        }
        // Rebuild the companion from the exact snapshot bytes that now define
        // the replay path, never from a later re-encode of the applied doc.
        let Ok(frontier) = IntegratedFrontier::from_full_state_bytes(&bytes) else {
            self.remove(key);
            return;
        };
        let doc = Ydoc::wire();
        if doc.apply(&bytes).is_err() {
            self.remove(key);
            return;
        }
        // Rebuild both Y.Docs from the exact snapshot replay base. The
        // persistent scratch remains a full-state fork used only by check 4.
        let pending = doc.pending_update_v1();
        let Ok(gate_scratch) =
            crate::replay_parity::rebuild_persistent_gate_scratch(&bytes, pending.as_deref())
        else {
            self.remove(key);
            return;
        };
        let gate_scratch = PersistentGateScratch::new(gate_scratch);
        let approx_bytes = bytes
            .len()
            .saturating_add(frontier.approx_bytes())
            .saturating_add(gate_scratch.approx_bytes);
        let entry = CacheEntry {
            doc,
            frontier,
            gate_scratch: Some(gate_scratch),
            tuple,
            approx_bytes,
            last_used: Cell::new(0),
        };
        self.touch(&entry);
        self.entries.insert(key.clone(), entry);
        self.evict_to_budget();
    }

    /// Drop the entry for `key`. The mandatory hook for every lineage reset
    /// the tuple cannot see. Always safe: the next append misses and
    /// reconstructs.
    pub fn remove(&mut self, key: &DocKey) {
        if self.entries.remove(key).is_some() {
            self.removes += 1;
        }
    }

    fn evict_gate_scratch(&mut self, key: &DocKey) {
        let Some(entry) = self.entries.get_mut(key) else {
            return;
        };
        if let Some(scratch) = entry.gate_scratch.take() {
            entry.approx_bytes = entry.approx_bytes.saturating_sub(scratch.approx_bytes);
        }
    }

    /// Drop every entry. Always safe.
    pub fn clear(&mut self) {
        self.removes += self.entries.len() as u64;
        self.entries.clear();
    }

    /// Mark `key` as an open live session: its entry is evicted last.
    pub fn pin(&mut self, key: &DocKey) {
        // The pin set is order-only state; bound it so leaked pins (sessions
        // torn down without a close) cannot grow it unboundedly.
        if self.pinned.len() >= 256 {
            let entries = &self.entries;
            self.pinned.retain(|pinned| entries.contains_key(pinned));
        }
        self.pinned.insert(key.clone());
    }

    /// Clear the live-session mark for `key`.
    pub fn unpin(&mut self, key: &DocKey) {
        self.pinned.remove(key);
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.hits.get(),
            misses: self.misses.get(),
            installs: self.installs,
            advances: self.advances,
            removes: self.removes,
        }
    }

    /// Replace the cached doc without touching its tuple — a deliberately
    /// invalid entry for tests that prove the differential check catches a
    /// doc/tuple divergence. Never call outside tests.
    #[doc(hidden)]
    pub fn poison_doc_for_test(&mut self, key: &DocKey, doc: Ydoc) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.doc = doc;
        }
    }

    /// Corrupt one retained live identity without changing the doc or tuple.
    /// The next cached serve must trip the FR1-VALID oracle.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn poison_frontier_for_test(&mut self, key: &DocKey) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.frontier.poison_identity_for_test();
        }
    }

    /// Replace the check-4 scratch with an empty document without changing its
    /// tuple. The next cached gate must trip FR2-VALID.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn poison_gate_scratch_for_test(&mut self, key: &DocKey) {
        if let Some(entry) = self.entries.get_mut(key) {
            let replacement = PersistentGateScratch::new(Ydoc::wire());
            if let Some(previous) = entry.gate_scratch.replace(replacement) {
                entry.approx_bytes = entry.approx_bytes.saturating_sub(previous.approx_bytes);
            }
            entry.approx_bytes = entry.approx_bytes.saturating_add(
                entry
                    .gate_scratch
                    .as_ref()
                    .expect("the poison scratch was just installed")
                    .approx_bytes,
            );
        }
    }

    /// Differential frontier evidence for mutation tests.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn frontier_matches_doc_for_test(&self, key: &DocKey) -> Result<Option<bool>, CollabError> {
        self.entries
            .get(key)
            .map(|entry| entry.frontier.matches_doc(&entry.doc))
            .transpose()
    }

    /// `(live identities, unsafe interiors, canonical deletion endpoints)`.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn frontier_fact_counts_for_test(&self, key: &DocKey) -> Option<(usize, usize, usize)> {
        self.entries
            .get(key)
            .map(|entry| entry.frontier.fact_counts())
    }

    /// Whether the check-4-only scratch is resident for this entry.
    #[doc(hidden)]
    pub fn gate_scratch_is_resident_for_test(&self, key: &DocKey) -> bool {
        self.entries
            .get(key)
            .is_some_and(|entry| entry.gate_scratch.is_some())
    }

    /// FR2's exact observation comparison against the writer replay base.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn gate_scratch_matches_doc_for_test(
        &self,
        key: &DocKey,
    ) -> Result<Option<bool>, CollabError> {
        self.entries
            .get(key)
            .and_then(|entry| {
                entry
                    .gate_scratch
                    .as_ref()
                    .map(|scratch| (&entry.doc, &scratch.doc))
            })
            .map(|(doc, scratch)| {
                crate::replay_parity::persistent_gate_scratch_matches_base(doc, scratch)
            })
            .transpose()
    }

    /// `(writer doc + frontier, check-4 scratch)` approximate bytes.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn entry_byte_breakdown_for_test(&self, key: &DocKey) -> Option<(usize, usize)> {
        self.entries.get(key).map(|entry| {
            let scratch = entry
                .gate_scratch
                .as_ref()
                .map_or(0, |scratch| scratch.approx_bytes);
            (entry.approx_bytes.saturating_sub(scratch), scratch)
        })
    }

    /// Whether an entry is resident (test evidence for eviction/removal).
    #[doc(hidden)]
    pub fn contains_for_test(&self, key: &DocKey) -> bool {
        self.entries.contains_key(key)
    }

    /// The cached doc's full-state encode (test evidence for byte-equality
    /// against a cold reconstruction).
    #[doc(hidden)]
    pub fn doc_full_state_for_test(&self, key: &DocKey) -> Option<Vec<u8>> {
        self.entries
            .get(key)
            .map(|entry| entry.doc.encode_full_state())
    }

    fn max_entries(&self) -> usize {
        self.max_entries.unwrap_or(MAX_ENTRIES)
    }

    fn max_total_bytes(&self) -> usize {
        self.max_total_bytes.unwrap_or(MAX_TOTAL_BYTES)
    }

    fn total_bytes(&self) -> usize {
        self.entries.values().map(|entry| entry.approx_bytes).sum()
    }

    /// LRU eviction under the entry cap and byte budget; pinned (live-session)
    /// entries evict last, but the caps hold absolutely.
    fn evict_to_budget(&mut self) {
        while self.entries.len() > self.max_entries() || self.total_bytes() > self.max_total_bytes()
        {
            let victim = self
                .entries
                .iter()
                .min_by_key(|(key, entry)| (self.pinned.contains(*key), entry.last_used.get()))
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else {
                return;
            };
            self.entries.remove(&victim);
            self.removes += 1;
        }
    }
}
