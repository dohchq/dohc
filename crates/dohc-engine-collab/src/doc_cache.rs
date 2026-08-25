//! The writer thread's cache of live Y.Docs, serving the replay-parity gate's
//! base on the LOCAL append path so a keystroke batch stops paying a full
//! `load_for_replay_gate` reconstruction per append.
//!
//! ## The CACHE-VALID invariant
//!
//! An entry may serve as the gate base only when it is **byte-replay-identical**
//! to what `load_for_replay_gate` would rebuild inside the same transaction:
//! the cached doc applied exactly the byte sequence, in the same order, that a
//! fresh reconstruction would apply. Logical CRDT equality is NOT sufficient —
//! yrs block splits are history-sensitive, and the gate reads the base's
//! delete-set endpoints. The proof is carried by [`CacheTuple`]: every marker
//! field that names the replay path, plus the sha of the log row at the head
//! seq. A hit requires the whole tuple to match inside the caller's WRITE
//! transaction; any mismatch is a miss and the caller reconstructs as before.
//!
//! ## Containment (PR1)
//!
//! The cache serves ONLY the parity-gate base on the local append path.
//! Forced compaction, close, `claim_base`, origination, and successor encodes
//! always fully reconstruct. Durable BYTES are never derived from the cache.
//! The cache is never mutated inside a transaction: `base_for_gate` takes
//! `&self`; advancement happens only after `TxnOutcome::Committed`.
//!
//! Single writer: one workspace store has one writer thread (`worker_main`),
//! and the cache is a plain local of that thread. The head-row sha probe is
//! defense-in-depth on top of that contract.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use dohc_engine_storage::{EngineStore, TxnOutcome};
use rusqlite::{Connection, OptionalExtension};

use crate::durable::{
    binary_blob_for_gate, latest_snapshot, map_sql, query_marker, AppendOutcome,
    LineageClaimStatus, Marker, Regime,
};
use crate::error::CollabError;
use crate::ydoc::{ContentKind, Ydoc};
use crate::DocKey;

/// Hard cap on resident entries.
const MAX_ENTRIES: usize = 16;
/// Byte budget across all entries (approximate, from encoded sizes).
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// The durable coordinates that name one exact replay path. Two lineage states
/// with equal tuples replay the same byte sequence — except a head-rewind that
/// re-appends the same head bytes over different history with identical claim
/// fields (the local-only prune ABA), which is why every such reset must call
/// [`WriterDocCache::remove`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CacheTuple {
    head_update_seq: i64,
    head_snapshot_seq: i64,
    lineage_claim_status: LineageClaimStatus,
    lineage_claim_id: Option<String>,
    lineage_epoch_tag: Option<String>,
    content_kind: ContentKind,
    regime: Regime,
    /// Sha of the log row at `head_update_seq`; `None` when the head is folded
    /// into the snapshot (`head_update_seq == head_snapshot_seq`).
    head_row_sha: Option<String>,
}

impl CacheTuple {
    fn from_marker(marker: &Marker, head_row_sha: Option<String>) -> Self {
        CacheTuple {
            head_update_seq: marker.head_update_seq,
            head_snapshot_seq: marker.head_snapshot_seq,
            lineage_claim_status: marker.lineage_claim_status,
            lineage_claim_id: marker.lineage_claim_id.clone(),
            lineage_epoch_tag: marker.lineage_epoch_tag.clone(),
            content_kind: marker.content_kind,
            regime: marker.regime,
            head_row_sha,
        }
    }

    /// Read the current tuple from the caller's connection, or `None` when the
    /// marker is absent or torn (head row missing).
    fn read_current(conn: &Connection, key: &DocKey) -> Result<Option<Self>, CollabError> {
        let Some(marker) = query_marker(conn, key)? else {
            return Ok(None);
        };
        let head_row_sha = if marker.head_update_seq > marker.head_snapshot_seq {
            match head_row_sha(conn, key, marker.head_update_seq)? {
                Some(sha) => Some(sha),
                None => return Ok(None),
            }
        } else {
            None
        };
        Ok(Some(CacheTuple::from_marker(&marker, head_row_sha)))
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
    tuple: CacheTuple,
    approx_bytes: usize,
    last_used: Cell<u64>,
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
/// the post-commit step knows how to advance the cache. Built ONLY by
/// [`super::durable`]'s local append path.
#[derive(Default)]
pub(crate) struct GateBaseProbe {
    pub(crate) served: Option<ServedGateBase>,
}

pub(crate) struct ServedGateBase {
    /// True when the cache served the base; false when the base was rebuilt.
    pub(crate) hit: bool,
    /// The rebuilt PRE-APPEND base doc (miss only), read inside the append
    /// transaction, handed out for a post-commit install.
    pub(crate) rebuilt: Option<Ydoc>,
    /// The marker as observed inside the append transaction, at gate time.
    pub(crate) observed: Marker,
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

    /// Serve the replay-parity gate base for a LOCAL append, or `None` when
    /// the entry is absent or its tuple does not match the durable state
    /// inside the caller's WRITE transaction (the caller then falls back to
    /// `load_for_replay_gate`, unchanged).
    ///
    /// `marker` is the marker the caller already queried inside this same
    /// transaction. Takes `&self`: the cache is never mutated inside a
    /// transaction.
    pub(crate) fn base_for_gate(
        &self,
        conn: &Connection,
        key: &DocKey,
        marker: &Marker,
    ) -> Result<Option<&Ydoc>, CollabError> {
        let Some(entry) = self.entries.get(key) else {
            self.misses.set(self.misses.get() + 1);
            return Ok(None);
        };
        let t = &entry.tuple;
        let marker_fields_match = t.head_update_seq == marker.head_update_seq
            && t.head_snapshot_seq == marker.head_snapshot_seq
            && t.lineage_claim_status == marker.lineage_claim_status
            && t.lineage_claim_id == marker.lineage_claim_id
            && t.lineage_epoch_tag == marker.lineage_epoch_tag
            && t.content_kind == marker.content_kind
            && t.regime == marker.regime;
        if !marker_fields_match {
            self.misses.set(self.misses.get() + 1);
            return Ok(None);
        }
        // O(1) head-row probe: the row at the head seq must hold exactly the
        // sha the entry advanced with. A folded head (head == snapshot seq)
        // has no row and the tuple must agree.
        let expected_row = if marker.head_update_seq > marker.head_snapshot_seq {
            head_row_sha(conn, key, marker.head_update_seq)?
        } else {
            None
        };
        if expected_row != t.head_row_sha
            || (marker.head_update_seq > marker.head_snapshot_seq && expected_row.is_none())
        {
            self.misses.set(self.misses.get() + 1);
            return Ok(None);
        }

        // Differential check: in every test/debug build, a hit re-proves
        // CACHE-VALID against a fresh reconstruction, so the whole debug test
        // fleet checks the invariant on every cache-served gate. The compared
        // predicate is the CANONICAL wire structure the gate consumes
        // (`replay_parity::scan_v1`), not the raw re-encode bytes: yrs
        // `Any::Map` is HashMap-backed, so two byte-replay-identical docs can
        // legitimately re-encode an embed's map keys in different orders — and
        // the gate itself fingerprints such payloads order-independently.
        #[cfg(any(test, debug_assertions))]
        {
            use crate::replay_parity::scan_v1;
            let fresh = crate::durable::load_for_replay_gate(conn, key)?;
            assert_eq!(
                scan_v1(&fresh.encode_full_state())?,
                scan_v1(&entry.doc.encode_full_state())?,
                "CACHE-VALID violated: cached Y.Doc full-state structure \
                 diverges from load_for_replay_gate for {key:?}"
            );
            let fresh_pending = fresh.pending_update_v1();
            let cached_pending = entry.doc.pending_update_v1();
            match (&fresh_pending, &cached_pending) {
                (None, None) => {}
                (Some(fresh_bytes), Some(cached_bytes)) => assert_eq!(
                    scan_v1(fresh_bytes)?,
                    scan_v1(cached_bytes)?,
                    "CACHE-VALID violated: cached Y.Doc pending structure \
                     diverges from load_for_replay_gate for {key:?}"
                ),
                _ => panic!(
                    "CACHE-VALID violated: cached Y.Doc pending presence \
                     diverges from load_for_replay_gate for {key:?} \
                     (fresh: {}, cached: {})",
                    fresh_pending.is_some(),
                    cached_pending.is_some(),
                ),
            }
        }

        self.hits.set(self.hits.get() + 1);
        self.touch(entry);
        Ok(Some(&entry.doc))
    }

    /// Advance or install the entry for one COMMITTED, genuinely-new local
    /// append. Verifies against a fresh durable read that the commit changed
    /// the replay path by exactly this append (head advanced by one, head row
    /// holds `update_sha`, every other tuple field unchanged from the in-tx
    /// observation); anything else — an in-transaction base origination, a
    /// hook that appended more — removes the entry instead. Cache maintenance
    /// never fails the append: every internal failure degrades to `remove`.
    pub(crate) fn finish_local_append(
        &mut self,
        store: &EngineStore,
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
                let Some(served) = probe.served else {
                    // A non-deduped append that never reached the gate is
                    // unexpected; fail safe.
                    self.remove(key);
                    return;
                };
                let fresh = store.read_with(|conn| CacheTuple::read_current(conn, key));
                let Ok(Some(fresh)) = fresh else {
                    self.remove(key);
                    return;
                };
                let observed = &served.observed;
                let exactly_this_append = fresh.head_update_seq == app.seq
                    && app.seq == observed.head_update_seq + 1
                    && fresh.head_row_sha.as_deref() == Some(update_sha)
                    && fresh.head_snapshot_seq == observed.head_snapshot_seq
                    && fresh.lineage_claim_status == observed.lineage_claim_status
                    && fresh.lineage_claim_id == observed.lineage_claim_id
                    && fresh.lineage_epoch_tag == observed.lineage_epoch_tag
                    && fresh.content_kind == observed.content_kind
                    && fresh.regime == observed.regime;
                if !exactly_this_append {
                    self.remove(key);
                    return;
                }
                if served.hit {
                    self.advance_committed(key, update, fresh);
                } else if let Some(doc) = served.rebuilt {
                    self.install_committed(key, doc, update, fresh);
                } else {
                    self.remove(key);
                }
            }
            // Durable-but-unacked: the head advanced without a verified
            // advancement path. Fail safe.
            TxnOutcome::Crashed { committed: true } => self.remove(key),
            // Rolled back: durable state is unchanged, so the entry (validated
            // by the tuple probe on its next use anyway) stays.
            TxnOutcome::Crashed { committed: false } => {}
        }
    }

    /// Apply exactly the committed candidate bytes to the cached doc.
    fn advance_committed(&mut self, key: &DocKey, applied: &[u8], tuple: CacheTuple) {
        let Some(entry) = self.entries.get_mut(key) else {
            return;
        };
        if entry.doc.apply(applied).is_err() {
            // The gate admitted these bytes; an apply failure here means the
            // cached doc cannot be trusted.
            self.remove(key);
            return;
        }
        entry.tuple = tuple;
        entry.approx_bytes = entry.approx_bytes.saturating_add(applied.len());
        self.advances += 1;
        let entry = &self.entries[key];
        self.touch(entry);
        self.evict_to_budget();
    }

    /// Warm the cache from the base doc rebuilt INSIDE the just-committed
    /// transaction, advanced with the committed candidate.
    fn install_committed(&mut self, key: &DocKey, doc: Ydoc, applied: &[u8], tuple: CacheTuple) {
        if doc.apply(applied).is_err() {
            self.remove(key);
            return;
        }
        let approx_bytes =
            doc.encode_full_state().len() + doc.pending_update_v1().map_or(0, |bytes| bytes.len());
        let entry = CacheEntry {
            doc,
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
    pub(crate) fn note_compacted(
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
        let doc = Ydoc::wire();
        if doc.apply(&bytes).is_err() {
            self.remove(key);
            return;
        }
        let approx_bytes = bytes.len();
        let entry = CacheEntry {
            doc,
            tuple,
            approx_bytes,
            last_used: Cell::new(0),
        };
        self.touch(&entry);
        self.entries.insert(key.clone(), entry);
        self.evict_to_budget();
    }

    /// Drop the entry for `key`. The mandatory hook for every lineage reset
    /// the tuple cannot see (a local-only prune re-appended to the same head
    /// coordinates replays DIFFERENT bytes under an identical tuple). Always
    /// safe: the next append misses and reconstructs.
    pub fn remove(&mut self, key: &DocKey) {
        if self.entries.remove(key).is_some() {
            self.removes += 1;
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

    /// Replace the cached doc WITHOUT touching its tuple — a deliberately
    /// invalid entry for tests that prove the differential check catches a
    /// doc/tuple divergence. Never call outside tests.
    #[doc(hidden)]
    pub fn poison_doc_for_test(&mut self, key: &DocKey, doc: Ydoc) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.doc = doc;
        }
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
