//! The durable Y.Doc cache: the content-addressed update log, folded snapshots,
//! convergence-neutral compaction, the base-once replicated lineage, and the
//! settle pipeline. Every write goes through the storage crate's single owned
//! connection via `write_with` (one `BEGIN IMMEDIATE` per durable step,
//! consulting the named storage fault points), and every reconstruct reads the
//! content-addressed blobs the log/snapshots reference.
//!
//! ## Two regimes (never conflated — plan correction)
//!
//! [`Regime::LocalOnly`] keeps the log as a PRUNABLE fast-resume cache. The
//! workspace file is the durable artifact, and a closed session prunes every
//! CRDT row to the bare marker. [`Regime::Replicated`] makes the CRDT lineage
//! durable canonical:
//! the base is emitted exactly once, local edits journal `ydoc.update` ops
//! (surfaced via [`AppendOutcome::emit_outbound`]), and close NEVER prunes — a
//! peer bootstraps from the persisted lineage.

use dohc_engine_storage::{
    enqueue_job, put_binary_blob, EngineStore, FaultInjector, MaterializationJobSpec, Preimage,
    TxnOutcome,
};
use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::error::CollabError;
use crate::limits::{DEFAULT_COMPACTION_THRESHOLD, MAX_YDOC_UPDATE_BYTES};
use crate::ydoc::{ContentKind, Projection, SuccessorBase, Ydoc};
use crate::DocKey;

/// Which durability regime a lineage lives under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Regime {
    /// Prunable fast-resume cache; the workspace file is the durable artifact.
    LocalOnly,
    /// Durable canonical CRDT lineage; base-once, never pruned on close.
    Replicated,
}

/// Whether the active base claim is usable as a causal lineage identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineageClaimStatus {
    /// No replicated base has been claimed.
    Unclaimed,
    /// The exact base blob digest is known.
    Exact,
    /// A legacy base was compacted and no candidate base envelope remains.
    Missing,
    /// A legacy base was compacted and one or more candidate base envelopes
    /// remain, but none can be proven to be the active base.
    Ambiguous,
}

impl LineageClaimStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unclaimed => "unclaimed",
            Self::Exact => "exact",
            Self::Missing => "missing",
            Self::Ambiguous => "ambiguous",
        }
    }

    /// Whether this marker has already accepted a replicated base, including
    /// legacy rows whose exact claim cannot be recovered.
    pub const fn has_claimed_base(self) -> bool {
        !matches!(self, Self::Unclaimed)
    }

    fn parse(raw: &str) -> Result<Self, CollabError> {
        match raw {
            "unclaimed" => Ok(Self::Unclaimed),
            "exact" => Ok(Self::Exact),
            "missing" => Ok(Self::Missing),
            "ambiguous" => Ok(Self::Ambiguous),
            _ => Err(CollabError::Corrupt {
                reason: format!("unknown Y.Doc lineage claim status {raw:?}"),
            }),
        }
    }
}

impl Regime {
    /// The stable column string.
    pub fn as_str(self) -> &'static str {
        match self {
            Regime::LocalOnly => "local-only",
            Regime::Replicated => "replicated",
        }
    }

    /// Parse the column string (unknown → local-only, the safe default).
    pub fn parse(raw: &str) -> Self {
        if raw == "replicated" {
            Regime::Replicated
        } else {
            Regime::LocalOnly
        }
    }
}

/// A document marker with content, regime, head pointers, and lineage identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub content_kind: ContentKind,
    pub regime: Regime,
    pub head_update_seq: i64,
    pub head_snapshot_seq: i64,
    pub lineage_claim_status: LineageClaimStatus,
    pub lineage_claim_id: Option<String>,
    pub lineage_parent_claim_id: Option<String>,
    pub lineage_epoch_tag: Option<String>,
    pub path: Option<String>,
    pub base_origin_id: Option<String>,
    pub base_origin_seq: Option<i64>,
    pub base_relay_seq: Option<i64>,
    pub base_relay_confirmed_absent: bool,
}

/// A reconstructed durable doc plus the lineage metadata it was rebuilt from.
#[derive(Debug)]
pub struct PersistedDoc {
    pub doc: Ydoc,
    pub marker: Marker,
    /// The highest update seq applied while rebuilding (== `head_update_seq`).
    pub up_to_seq: i64,
}

/// The outcome of a durable append.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendOutcome {
    /// The seq assigned (or the existing seq if this was an idempotent dedup).
    pub seq: i64,
    /// True when the update bytes were already in the log (content-addressed
    /// dedup) — a strict no-op, exactly-once under crash-retry.
    pub deduped: bool,
    /// Whether the higher layer should broadcast this as an outbound
    /// `ydoc.update` op. True only for a genuinely-new local edit on a
    /// replicated lineage; false for a dedup, a local-only doc, or a remote
    /// apply (echo suppression lives in [`crate::replication`]).
    pub emit_outbound: bool,
}

/// The outcome of a compaction attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactOutcome {
    /// The log was folded into a fresh full-state snapshot at `up_to_seq`.
    Compacted {
        up_to_seq: i64,
        snapshot_sha: String,
        pruned_updates: usize,
    },
    /// Below threshold; nothing folded. `pending` updates sit past the snapshot.
    Skipped { pending: i64 },
}

/// The bytes that originate a lineage: its full-state base, and that base's
/// state vector for provenance parity with compaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginationBase {
    pub base: Vec<u8>,
    pub state_vector: Vec<u8>,
}

/// The outcome of a base-once claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// This call minted the single base snapshot for the lineage.
    Claimed { base_snapshot_sha: String },
    /// A base already existed: the caller resumes the winner and emits NO second
    /// base (base-once). The existing base is left byte-intact.
    Resumed,
    /// A lower relay position replaced this machine's active lineage.
    Replaced {
        losing_lineage_claim_id: String,
        winner: Marker,
    },
    /// The active lineage owns the lower relay position. No bytes changed.
    AlreadyWon { winner: Marker },
}

/// The authenticated relay coordinate of one base envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseRelayCoordinate {
    pub origin_id: String,
    pub origin_seq: i64,
    pub relay_seq: i64,
}

/// The exact base coordinate to persist for an active lineage claim.
#[derive(Debug, Clone, Copy)]
pub struct BaseCoordinateRecord<'a> {
    pub key: &'a DocKey,
    pub lineage_claim_id: &'a str,
    pub origin_id: &'a str,
    pub origin_seq: i64,
    pub relay_seq: Option<i64>,
    pub now_ms: i64,
}

impl BaseRelayCoordinate {
    pub fn new(
        origin_id: impl Into<String>,
        origin_seq: i64,
        relay_seq: i64,
    ) -> Result<Self, CollabError> {
        let origin_id = origin_id.into();
        if origin_id.is_empty() || origin_id.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(CollabError::InvalidIdentifier {
                reason: "origin_id must be non-empty and contain no control bytes".to_owned(),
            });
        }
        if origin_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES {
            return Err(CollabError::InvalidIdentifier {
                reason: format!(
                    "origin_id is {} bytes; the limit is {} bytes",
                    origin_id.len(),
                    dohc_engine_storage::MAX_IDENTIFIER_BYTES
                ),
            });
        }
        if origin_seq < 0 || relay_seq < 0 {
            return Err(CollabError::InvalidIdentifier {
                reason: "base relay coordinates must be nonnegative".to_owned(),
            });
        }
        Ok(Self {
            origin_id,
            origin_seq,
            relay_seq,
        })
    }
}

/// The result of an exact predecessor-claim/state-vector successor CAS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuccessorInstallOutcome {
    Installed {
        predecessor_claim_id: String,
        successor_claim_id: String,
    },
    Replayed {
        successor_claim_id: String,
    },
}

/// The outcome of a settle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleOutcome {
    /// The artifact content projection with provenance.
    pub projection: Projection,
    /// The durable materialization job id (deterministic; a crash-retry with the
    /// same content is an idempotent no-op).
    pub job_id: String,
    /// Lowercase-hex sha-256 of the projected content (its `binary_blobs` key).
    pub content_sha256: String,
    /// True when the job was already enqueued for this content+generation.
    pub deduped: bool,
}

/// The outcome of a session close (regime-dependent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseOutcome {
    /// Replicated (or persist-closed-state) close: the lineage was compacted and
    /// KEPT durable.
    Compacted(CompactOutcome),
    /// Local-only close: the CRDT rows were pruned to the bare marker.
    Pruned {
        removed_updates: usize,
        removed_snapshots: usize,
    },
}

// ---- reads ------------------------------------------------------------------

/// Read a doc's marker, or `None` if the object is not Y.Doc-driven.
pub fn read_marker(store: &EngineStore, key: &DocKey) -> Result<Option<Marker>, CollabError> {
    store.read_with(|conn| query_marker(conn, key))
}

/// Reconstruct the persisted Y.Doc from its latest snapshot + trailing update
/// log (the crash-resume / storage-proof path). `None` if there is no marker.
pub fn load_persisted(
    store: &EngineStore,
    key: &DocKey,
) -> Result<Option<PersistedDoc>, CollabError> {
    // Read the marker, the latest snapshot, and the update tail from ONE
    // consistent SQLite read snapshot (a single DEFERRED read transaction), so a
    // concurrent compaction cannot delete the tail between reading the old
    // snapshot and reading the updates and make reconstruction silently omit
    // committed edits. (Single-writer-per-store already precludes an in-process
    // race; this also closes the cross-process window.) The content-addressed
    // blob bytes are fetched after — they are immutable under their sha, so
    // reading them outside the snapshot is safe.
    let loaded = store.read_with(|conn| -> Result<_, CollabError> {
        let read_tx = conn.unchecked_transaction().map_err(map_sql)?;
        let marker = match query_marker(&read_tx, key)? {
            Some(m) => m,
            None => return Ok(None),
        };
        let snapshot = latest_snapshot(&read_tx, key)?;
        let from_seq = snapshot.as_ref().map(|(seq, _)| *seq).unwrap_or(0);
        let tail = updates_after(&read_tx, key, from_seq)?;
        Ok(Some((marker, snapshot, tail)))
    })?;
    let (marker, snapshot, tail) = match loaded {
        Some(triple) => triple,
        None => return Ok(None),
    };
    let from_seq = snapshot.as_ref().map(|(seq, _)| *seq).unwrap_or(0);

    let doc = Ydoc::wire();
    if let Some((_, snapshot_sha)) = &snapshot {
        let bytes = store
            .get_binary_blob(snapshot_sha)?
            .ok_or_else(|| CollabError::Corrupt {
                reason: format!("snapshot blob {snapshot_sha} missing"),
            })?;
        doc.apply(&bytes)?;
    }
    let mut up_to = from_seq;
    for (seq, sha) in tail {
        let bytes = store
            .get_binary_blob(&sha)?
            .ok_or_else(|| CollabError::Corrupt {
                reason: format!("update blob {sha} missing at seq {seq}"),
            })?;
        // A journaled update that fails to apply is corruption, not a silent
        // skip — we NEVER assume state-unchanged after a failed apply
        // (constraint 5); we surface it.
        doc.apply(&bytes)?;
        up_to = seq;
    }

    // Validate the reconstructed sequence against the marker head: the applied
    // tail must reach exactly the recorded head. A shortfall means a committed
    // update is missing (a torn lineage) — surface it, never return a silently
    // truncated doc.
    if up_to != marker.head_update_seq {
        return Err(CollabError::Corrupt {
            reason: format!(
                "reconstruction reached seq {up_to} but marker head is {}",
                marker.head_update_seq
            ),
        });
    }

    Ok(Some(PersistedDoc {
        doc,
        marker,
        up_to_seq: up_to,
    }))
}

// ---- writes -----------------------------------------------------------------

/// Ensure a marker row exists for `key` (idempotent). Seeds `content_kind` and
/// `regime` on first creation; an existing marker keeps its regime/kind. The
/// caller must have seeded the parent `file_objects` row (FK).
pub fn ensure_marker(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    regime: Regime,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<()>, CollabError> {
    store.write_with(faults, |tx| {
        tx.execute(
            "INSERT INTO ydoc_docs \
             (workspace_id, version_id, object_id, content_kind, regime, \
              head_update_seq, head_snapshot_seq, lineage_claim_status, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 'unclaimed', ?6) \
             ON CONFLICT(workspace_id, version_id, object_id) DO NOTHING",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                content_kind.as_str(),
                regime.as_str(),
                now_ms,
            ],
        )
        .map_err(map_sql)?;
        Ok(())
    })
}

/// Rewrite a BARE local marker's content kind to the caller's explicit
/// request. A marker with durable doc state (or a claimed base) never changes
/// kind — the lineage owns it. A pruned, state-free local marker is only a
/// remembered default, and keeping it authoritative would permanently
/// mis-bind the doc: the 2026-07 desktop editor outage minted plaintext
/// markers for rich .md paths, and every later richdoc open would silently
/// come back plaintext (empty doc over a non-empty file; typed edits
/// discarded at close). The WHERE clause re-proves bareness inside the
/// transaction so a raced update/seed can never have its kind flipped.
pub fn rewrite_bare_marker_content_kind(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<bool>, CollabError> {
    store.write_with(faults, |tx| {
        let updated = tx
            .execute(
                "UPDATE ydoc_docs SET content_kind = ?4, updated_at_ms = ?5 \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                   AND regime = 'local-only' AND head_update_seq = 0 \
                   AND head_snapshot_seq = 0 AND lineage_claim_status = 'unclaimed'",
                rusqlite::params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    content_kind.as_str(),
                    now_ms,
                ],
            )
            .map_err(map_sql)?;
        Ok(updated == 1)
    })
}

/// Append a locally-produced update to the durable log (advancing the head).
/// Validates the bytes BEFORE any blob put / journal (constraint 5: never
/// journal bytes that fail validation); content-addresses them; and dedups on
/// the blob sha so a crash-retry is exactly-once. Self-bounds the log: a
/// genuinely-new append triggers compaction once the pending count reaches the
/// default threshold, so a long-lived session that never explicitly compacts
/// still keeps a finite log (the "everything bounded" invariant).
pub fn record_local_update(
    store: &mut EngineStore,
    key: &DocKey,
    update: &[u8],
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<AppendOutcome>, CollabError> {
    record_local_update_with_origin(store, key, update, None, faults, now_ms)
}

/// [`record_local_update`] with the requesting client's actor origin id
/// persisted onto the appended row (`ydoc_updates.actor_origin_id`) —
/// provenance/echo-filter parity with the TS driver, which stores the
/// caller-supplied origin rather than dropping it.
pub fn record_local_update_with_origin(
    store: &mut EngineStore,
    key: &DocKey,
    update: &[u8],
    actor_origin_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<AppendOutcome>, CollabError> {
    record_local_update_with_origin_and_hook(
        store,
        key,
        update,
        actor_origin_id,
        faults,
        now_ms,
        |_tx, _outcome| Ok(()),
    )
}

/// [`record_local_update_with_origin`] with a post-append hook running in the
/// SAME transaction as the CRDT append. The live-session path uses it to
/// journal the outbound `ydoc.update` replication op atomically with the
/// append (blob-before-log holds — the append stored the blob earlier in this
/// transaction). The hook runs only for a genuinely-new append.
pub fn record_local_update_with_origin_and_hook<F>(
    store: &mut EngineStore,
    key: &DocKey,
    update: &[u8],
    actor_origin_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
    post_append: F,
) -> Result<TxnOutcome<AppendOutcome>, CollabError>
where
    F: FnOnce(&Transaction<'_>, &AppendOutcome) -> Result<(), CollabError>,
{
    validate_update_bytes(update)?;
    let sha = crate::hex_sha256(update);

    let outcome = store.write_with(faults, |tx| -> Result<AppendOutcome, CollabError> {
        let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
        let outcome = append_local_update(tx, key, &marker, update, &sha, actor_origin_id, now_ms)?;
        if !outcome.deduped {
            post_append(tx, &outcome)?;
        }
        Ok(outcome)
    })?;
    self_bound_log(store, key, &outcome, faults, now_ms)?;
    Ok(outcome)
}

/// Create a marker when needed and append a locally-produced update in one
/// transaction. Validation, replay parity, blob storage, journal append, and
/// first-marker creation therefore share one rollback boundary.
#[allow(clippy::too_many_arguments)]
pub fn record_local_update_creating_marker(
    store: &mut EngineStore,
    key: &DocKey,
    path: Option<&str>,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<AppendOutcome>, CollabError> {
    record_local_update_creating_marker_with_hook(
        store,
        key,
        path,
        content_kind,
        regime,
        update,
        actor_origin_id,
        faults,
        now_ms,
        |_tx, _outcome| Ok(()),
    )
}

/// [`record_local_update_creating_marker`] with a post-append hook in the same
/// transaction (see [`record_local_update_with_origin_and_hook`]). The hook
/// runs only for a genuinely-new append.
#[allow(clippy::too_many_arguments)]
pub fn record_local_update_creating_marker_with_hook<F>(
    store: &mut EngineStore,
    key: &DocKey,
    path: Option<&str>,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
    post_append: F,
) -> Result<TxnOutcome<AppendOutcome>, CollabError>
where
    F: FnOnce(&Transaction<'_>, &AppendOutcome) -> Result<(), CollabError>,
{
    record_local_update_creating_marker_guarded(
        store,
        key,
        path,
        content_kind,
        regime,
        update,
        actor_origin_id,
        false,
        false,
        None,
        faults,
        now_ms,
        post_append,
    )
}

/// The full first-seed form: optionally ensures the `file_objects` parent row
/// and enforces the empty-lineage seed guard — all in ONE transaction with the
/// append, so a crash cannot strand a bare parent row and a timed-out-commit
/// RETRY of the same seed bytes DEDUPES (the blob check precedes the guard)
/// instead of refusing seed-onto-existing-lineage.
#[allow(clippy::too_many_arguments)]
pub fn record_local_update_creating_marker_guarded<F>(
    store: &mut EngineStore,
    key: &DocKey,
    path: Option<&str>,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<&str>,
    ensure_parent_row: bool,
    require_empty_lineage: bool,
    request_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
    post_append: F,
) -> Result<TxnOutcome<AppendOutcome>, CollabError>
where
    F: FnOnce(&Transaction<'_>, &AppendOutcome) -> Result<(), CollabError>,
{
    record_local_update_creating_marker_guarded_inner(
        store,
        key,
        path,
        content_kind,
        regime,
        update,
        actor_origin_id,
        None,
        ensure_parent_row,
        require_empty_lineage,
        None,
        request_id,
        faults,
        now_ms,
        post_append,
    )
}

/// [`record_local_update_creating_marker_guarded`] with an active-lineage CAS.
/// `None` means the caller is bound to an unclaimed lineage, not "skip the
/// guard". The idempotency hash binds the expected claim before replay.
///
/// `seed_source_sha256` is the captured head whose content this update
/// imports, recorded on the marker with the append (#815). Pass it only for a
/// client-declared seed; any other first update (a crash-replayed prior
/// state, for example) must leave it `None` so settle and close never treat
/// the file as already holding the doc.
#[allow(clippy::too_many_arguments)]
pub fn record_local_update_creating_marker_guarded_for_lineage<F>(
    store: &mut EngineStore,
    key: &DocKey,
    path: Option<&str>,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<&str>,
    expected_lineage_claim_id: Option<&str>,
    ensure_parent_row: bool,
    require_empty_lineage: bool,
    seed_source_sha256: Option<&str>,
    request_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
    post_append: F,
) -> Result<TxnOutcome<AppendOutcome>, CollabError>
where
    F: FnOnce(&Transaction<'_>, &AppendOutcome) -> Result<(), CollabError>,
{
    record_local_update_creating_marker_guarded_inner(
        store,
        key,
        path,
        content_kind,
        regime,
        update,
        actor_origin_id,
        Some(expected_lineage_claim_id),
        ensure_parent_row,
        require_empty_lineage,
        seed_source_sha256,
        request_id,
        faults,
        now_ms,
        post_append,
    )
}

#[allow(clippy::too_many_arguments)]
fn record_local_update_creating_marker_guarded_inner<F>(
    store: &mut EngineStore,
    key: &DocKey,
    path: Option<&str>,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<&str>,
    lineage_guard: Option<Option<&str>>,
    ensure_parent_row: bool,
    require_empty_lineage: bool,
    seed_source_sha256: Option<&str>,
    request_id: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
    post_append: F,
) -> Result<TxnOutcome<AppendOutcome>, CollabError>
where
    F: FnOnce(&Transaction<'_>, &AppendOutcome) -> Result<(), CollabError>,
{
    // The caller's idempotency key hashes over the DOC COORDINATES and the
    // update bytes: content-addressed dedupe alone only holds while the
    // original row survives compaction — a retry after the fold would
    // re-append the edit (and re-journal an outbound op on a replicated
    // lineage) instead of replaying the original result.
    let request_hash = request_id.map(|_| {
        let path_identity = match path {
            Some(path) => format!("some:{}", crate::hex_sha256(path.as_bytes())),
            None => "none".to_owned(),
        };
        crate::hex_sha256(
            format!(
                "ydoc-record-v3{sep}{}{sep}{}{sep}{}{sep}{path_identity}{sep}{}{sep}{}",
                key.workspace_id,
                key.version_id,
                key.object_id,
                crate::hex_sha256(update),
                match lineage_guard {
                    None => "unguarded".to_owned(),
                    Some(None) => "unclaimed".to_owned(),
                    Some(Some(claim)) => format!("claim:{claim}"),
                },
                sep = char::from(0),
            )
            .as_bytes(),
        )
    });
    let outcome = store.write_with(faults, |tx| -> Result<AppendOutcome, CollabError> {
        if let (Some(request_id), Some(hash)) = (request_id, request_hash.as_deref()) {
            let recorded: Option<(String, i64)> = tx
                .query_row(
                    "SELECT payload_hash, result_seq FROM engine_requests                      WHERE request_id = ?1",
                    rusqlite::params![request_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(map_sql)?;
            if let Some((payload_hash, result_seq)) = recorded {
                if payload_hash != hash {
                    return Err(CollabError::Corrupt {
                        reason: "idempotency key reused with different content".to_owned(),
                    });
                }
                // Negative namespace: -seq (see the insert below).
                return Ok(AppendOutcome {
                    seq: -result_seq,
                    deduped: true,
                    emit_outbound: false,
                });
            }
        }
        if let Some(expected) = lineage_guard {
            let observed = query_marker(tx, key)?.and_then(|marker| marker.lineage_claim_id);
            if observed.as_deref() != expected {
                return Err(CollabError::LineageWriteStale {
                    expected: expected.map(ToOwned::to_owned),
                    observed,
                });
            }
        }
        if let Some(path) = path {
            tx.execute(
                "UPDATE ydoc_docs SET path=?4 \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, path],
            )
            .map_err(map_sql)?;
        }
        if ensure_parent_row {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES (?1, ?2, ?3)",
                rusqlite::params![key.workspace_id, key.object_id, now_ms],
            )
            .map_err(map_sql)?;
        }
        let guarded_marker = if require_empty_lineage {
            query_marker(tx, key)?
        } else {
            None
        };
        if guarded_marker.is_some_and(|marker| marker.head_update_seq > 0) {
            // A retry of the SAME first update after a timed-out commit must
            // dedupe, not refuse: check the blob before the guard.
            let sha = crate::hex_sha256(update);
            if let Some(existing) = blob_seq_in_log(tx, key, &sha)? {
                return Ok(AppendOutcome {
                    seq: existing,
                    deduped: true,
                    emit_outbound: false,
                });
            }
            return Err(CollabError::SeedOntoExistingLineage);
        }
        validate_update_bytes(update)?;
        let marker = match query_marker(tx, key)? {
            Some(marker) => {
                if marker.content_kind != content_kind {
                    return Err(CollabError::ContentKindMismatch);
                }
                marker
            }
            None => {
                tx.execute(
                    "INSERT INTO ydoc_docs \
                     (workspace_id, version_id, object_id, content_kind, regime, \
                      head_update_seq, head_snapshot_seq, lineage_claim_status, updated_at_ms, path) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 'unclaimed', ?6, ?7)",
                    rusqlite::params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        content_kind.as_str(),
                        regime.as_str(),
                        now_ms,
                        path,
                    ],
                )
                .map_err(map_sql)?;
                Marker {
                    content_kind,
                    regime,
                    head_update_seq: 0,
                    head_snapshot_seq: 0,
                    lineage_claim_status: LineageClaimStatus::Unclaimed,
                    lineage_claim_id: None,
                    lineage_parent_claim_id: None,
                    lineage_epoch_tag: None,
                    path: path.map(str::to_owned),
                    base_origin_id: None,
                    base_origin_seq: None,
                    base_relay_seq: None,
                    base_relay_confirmed_absent: false,
                }
            }
        };
        let sha = crate::hex_sha256(update);
        {
            let outcome =
                append_local_update(tx, key, &marker, update, &sha, actor_origin_id, now_ms)?;
            if !outcome.deduped {
                // The seed's provenance commits WITH the seed append: the
                // marker now records which captured head this lineage's
                // first update imported (#815). A dedup replays the original
                // append whose commit already recorded it. Only the
                // lineage's FIRST update can be a seed — any other stamp
                // request is dropped, so a misuse degrades to a redundant
                // settle write, never a false claim that the file already
                // holds the doc.
                if let Some(seed_source) = seed_source_sha256.filter(|_| outcome.seq == 1) {
                    tx.execute(
                        "UPDATE ydoc_docs SET seed_source_sha256 = ?4 \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        rusqlite::params![
                            key.workspace_id,
                            key.version_id,
                            key.object_id,
                            seed_source,
                        ],
                    )
                    .map_err(map_sql)?;
                }
                post_append(tx, &outcome)?;
            }
            if let (Some(request_id), Some(hash)) = (request_id, request_hash.as_deref()) {
                // NEGATIVE namespace (-seq): rollback cleanup deletes ledger
                // rows by POSITIVE moment_order, so a stored -seq can never
                // be swept out from under a retry.
                tx.execute(
                    "INSERT INTO engine_requests \
                     (request_id, payload_hash, result_seq, committed_at, kind) \
                     VALUES (?1, ?2, ?3, ?4, 'ydoc')",
                    rusqlite::params![request_id, hash, -outcome.seq, now_ms],
                )
                .map_err(map_sql)?;
            }
            Ok(outcome)
        }
    })?;
    self_bound_log(store, key, &outcome, faults, now_ms)?;
    Ok(outcome)
}

fn append_local_update(
    conn: &Connection,
    key: &DocKey,
    marker: &Marker,
    update: &[u8],
    sha: &str,
    actor_origin_id: Option<&str>,
    now_ms: i64,
) -> Result<AppendOutcome, CollabError> {
    let base = load_for_replay_gate(conn, key)?;
    crate::validate_replay_parity(&base, update)?;
    if let Some(existing) = blob_seq_in_log(conn, key, sha)? {
        return Ok(AppendOutcome {
            seq: existing,
            deduped: true,
            emit_outbound: false,
        });
    }
    put_binary_blob(conn, update)?;
    let seq = append_row(conn, key, sha, actor_origin_id, now_ms)?;
    Ok(AppendOutcome {
        seq,
        deduped: false,
        emit_outbound: marker.regime == Regime::Replicated
            && marker.lineage_claim_status == LineageClaimStatus::Exact,
    })
}

/// After a genuinely-new append, fold the log if it has grown past the default
/// threshold (self-bounding). A dedup or a crash does nothing. Compaction is
/// convergence-neutral for BOTH regimes (it keeps a full-state snapshot; only a
/// local-only CLOSE prunes to nothing), so this is safe to run mid-session
/// regardless of regime.
pub(crate) fn self_bound_log(
    store: &mut EngineStore,
    key: &DocKey,
    outcome: &TxnOutcome<AppendOutcome>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<(), CollabError> {
    if let TxnOutcome::Committed(app) = outcome {
        if !app.deduped {
            // Best-effort fold; a fault-injected compaction crash is harmless
            // (the append is already durable) and leaves the log for the next
            // fold. `maybe_compact` no-ops below threshold.
            let _ = maybe_compact(store, key, DEFAULT_COMPACTION_THRESHOLD, faults, now_ms)?;
        }
    }
    Ok(())
}

// Below `threshold` (or nothing pending) means compaction cannot fire.
// Shared by `maybe_compact`'s cheap pre-check and its authoritative check so
// the two can never drift apart.
fn below_threshold(pending: i64, threshold: u32) -> bool {
    pending < i64::from(threshold) || pending <= 0
}

/// Fold the update log into a fresh full-state snapshot once the pending count
/// reaches `threshold`, prune the folded updates and superseded nonzero
/// snapshots, and advance `head_snapshot_seq`. Seq 0 remains as the permanent
/// base-claim proof. This costs at most one constant row. Convergence-neutral:
/// the new snapshot is a full-state re-encode, so a reconstruct from it yields
/// the same converged content as the un-compacted log. Below threshold this is
/// a no-op.
///
/// `threshold` of 0 forces a compaction (used by replicated close).
pub fn maybe_compact(
    store: &mut EngineStore,
    key: &DocKey,
    threshold: u32,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<CompactOutcome>, CollabError> {
    // A stale cheap read only ever costs an extra full reconstruction below,
    // never a wrong compaction.
    let marker = read_marker(store, key)?.ok_or(CollabError::NoMarker)?;
    let cheap_pending = marker.head_update_seq - marker.head_snapshot_seq;
    if below_threshold(cheap_pending, threshold) {
        return Ok(TxnOutcome::Committed(CompactOutcome::Skipped {
            pending: cheap_pending,
        }));
    }

    let persisted = match load_persisted(store, key)? {
        Some(p) => p,
        None => return Err(CollabError::NoMarker),
    };
    let pending = persisted.marker.head_update_seq - persisted.marker.head_snapshot_seq;
    if below_threshold(pending, threshold) {
        return Ok(TxnOutcome::Committed(CompactOutcome::Skipped { pending }));
    }
    if persisted.doc.has_missing_updates() {
        return Ok(TxnOutcome::Committed(CompactOutcome::Skipped { pending }));
    }

    // Encode the full-state snapshot + its state vector from the reconstructed
    // doc (read phase). Single writer per store ⇒ the head cannot advance
    // between this reconstruct and the write below.
    let snapshot_bytes = persisted.doc.encode_full_state();
    let sv_bytes = persisted.doc.encode_state_vector();
    let up_to = persisted.up_to_seq;

    store.write_with(faults, |tx| {
        let snapshot_sha = put_binary_blob(tx, &snapshot_bytes)?;
        let sv_sha = put_binary_blob(tx, &sv_bytes)?;
        tx.execute(
            "INSERT INTO ydoc_snapshots \
             (workspace_id, version_id, object_id, up_to_seq, \
              snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(workspace_id, version_id, object_id, up_to_seq) DO UPDATE SET \
               snapshot_blob_sha256 = excluded.snapshot_blob_sha256, \
               state_vector_blob_sha256 = excluded.state_vector_blob_sha256, \
               recorded_at_ms = excluded.recorded_at_ms",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                up_to,
                snapshot_sha,
                sv_sha,
                now_ms,
            ],
        )
        .map_err(map_sql)?;
        // Prune folded updates and superseded nonzero snapshots. Seq 0 proves
        // the exact base identity and state vector during successor replay.
        let pruned = tx
            .execute(
                "DELETE FROM ydoc_updates \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND seq <= ?4",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, up_to],
            )
            .map_err(map_sql)?;
        tx.execute(
            "DELETE FROM ydoc_snapshots \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
               AND up_to_seq > 0 AND up_to_seq < ?4",
            rusqlite::params![key.workspace_id, key.version_id, key.object_id, up_to],
        )
        .map_err(map_sql)?;
        tx.execute(
            "UPDATE ydoc_docs SET head_snapshot_seq = ?4, updated_at_ms = ?5 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                up_to,
                now_ms
            ],
        )
        .map_err(map_sql)?;
        Ok(CompactOutcome::Compacted {
            up_to_seq: up_to,
            snapshot_sha,
            pruned_updates: pruned,
        })
    })
}

/// Claim the single BASE snapshot for a replicated lineage (base-once). The base
/// bytes are a full-state re-encode of the document after its initial artifact
/// seed. Re-checks the lineage claim inside the transaction so a cross-process
/// first-open race resolves to exactly one base: the loser observes the winner's
/// base and returns [`ClaimOutcome::Resumed`] (emitting no second base).
pub fn claim_base(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    base_bytes: &[u8],
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<ClaimOutcome>, CollabError> {
    validate_update_bytes(base_bytes)?;
    let sv_bytes = {
        // The base's state vector, for provenance parity with compaction.
        let doc = Ydoc::wire();
        doc.apply(base_bytes)?;
        doc.encode_state_vector()
    };

    store.write_with(faults, |tx| {
        claim_base_in_tx(tx, key, content_kind, base_bytes, &sv_bytes, now_ms)
    })
}

/// Claim or arbitrate a base observed at an authenticated relay coordinate.
/// Lower relay position wins.
pub fn claim_base_at_relay(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    base_bytes: &[u8],
    coordinate: &BaseRelayCoordinate,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<ClaimOutcome>, CollabError> {
    validate_update_bytes(base_bytes)?;
    let doc = Ydoc::wire();
    doc.apply(base_bytes)?;
    let sv_bytes = doc.encode_state_vector();
    store.write_with(faults, |tx| {
        claim_base_at_relay_in_tx(
            tx,
            key,
            content_kind,
            base_bytes,
            &sv_bytes,
            coordinate,
            now_ms,
        )
    })
}

/// Transaction-composable form of [`claim_base`] for callers that must claim
/// a REMOTE base atomically with the imported coordinate's admission and ack
/// (a standalone claim before admission would persist a marker for an
/// envelope the sequence/divergence checks then reject).
pub fn claim_base_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    content_kind: ContentKind,
    base_bytes: &[u8],
    sv_bytes: &[u8],
    now_ms: i64,
) -> Result<ClaimOutcome, CollabError> {
    claim_base_with_coordinate_in_tx(tx, key, content_kind, base_bytes, sv_bytes, None, now_ms)
}

/// Transaction-composable form of [`claim_base_at_relay`].
pub fn claim_base_at_relay_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    content_kind: ContentKind,
    base_bytes: &[u8],
    sv_bytes: &[u8],
    coordinate: &BaseRelayCoordinate,
    now_ms: i64,
) -> Result<ClaimOutcome, CollabError> {
    claim_base_with_coordinate_in_tx(
        tx,
        key,
        content_kind,
        base_bytes,
        sv_bytes,
        Some(coordinate),
        now_ms,
    )
}

fn claim_base_with_coordinate_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    content_kind: ContentKind,
    base_bytes: &[u8],
    sv_bytes: &[u8],
    coordinate: Option<&BaseRelayCoordinate>,
    now_ms: i64,
) -> Result<ClaimOutcome, CollabError> {
    validate_update_bytes(base_bytes)?;
    let incoming_claim_id = crate::hex_sha256(base_bytes);
    (|| {
        // Upsert the marker first (FK parent for the snapshot), stamping the
        // replicated regime + content kind. In the INDIVIDUAL-FIRST flow the
        // marker already exists as `local-only` (created by `ensure_marker`), so
        // claiming a base must PROMOTE it to `replicated` — a `DO NOTHING` here
        // would leave `regime = 'local-only'`, and the next `close_session`
        // would take the prune branch and DELETE the just-claimed base
        // (destroying the shared lineage). Promote-on-claim keeps "open when
        // shared"; it also repairs a stale `content_kind`.
        tx.execute(
            "INSERT INTO ydoc_docs \
             (workspace_id, version_id, object_id, content_kind, regime, \
              head_update_seq, head_snapshot_seq, lineage_claim_status, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, 'replicated', 0, 0, 'unclaimed', ?5) \
             ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
               regime = CASE WHEN lineage_claim_status='unclaimed' \
                             THEN 'replicated' ELSE regime END, \
               content_kind = CASE WHEN lineage_claim_status='unclaimed' \
                                   THEN excluded.content_kind ELSE content_kind END, \
               updated_at_ms = CASE WHEN lineage_claim_status='unclaimed' \
                                    THEN excluded.updated_at_ms ELSE updated_at_ms END",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                content_kind.as_str(),
                now_ms,
            ],
        )
        .map_err(map_sql)?;

        // Atomic re-check: a base already claimed ⇒ resume the winner, emit no
        // second base — but ONLY when the incoming base IS the stored base.
        // Silently resuming (and acking) a DIFFERENT base would drop a
        // divergent lineage while the relay cursor advances past it, leaving
        // that peer's later updates missing an unrecoverable dependency.
        let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
        match marker.lineage_claim_status {
            LineageClaimStatus::Unclaimed => {}
            LineageClaimStatus::Exact => {
                return match marker.lineage_claim_id.clone() {
                    Some(stored) if stored == incoming_claim_id => {
                        if let Some(coordinate) = coordinate {
                            record_base_coordinate_in_tx(
                                tx,
                                BaseCoordinateRecord {
                                    key,
                                    lineage_claim_id: &incoming_claim_id,
                                    origin_id: &coordinate.origin_id,
                                    origin_seq: coordinate.origin_seq,
                                    relay_seq: Some(coordinate.relay_seq),
                                    now_ms,
                                },
                            )?;
                        }
                        Ok(ClaimOutcome::Resumed)
                    }
                    Some(stored) => {
                        let Some(coordinate) = coordinate else {
                            return Err(CollabError::BaseStateDiverged);
                        };
                        let local_relay_seq = match marker.base_relay_seq {
                            Some(relay_seq) => relay_seq,
                            None if marker.base_relay_confirmed_absent => {
                                replace_base_snapshot(
                                    tx,
                                    BaseSnapshotReplacement {
                                        key,
                                        content_kind,
                                        base_bytes,
                                        state_vector_bytes: sv_bytes,
                                        coordinate,
                                        incoming_claim_id: &incoming_claim_id,
                                        now_ms,
                                    },
                                )?;
                                let winner = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
                                return Ok(ClaimOutcome::Replaced {
                                    losing_lineage_claim_id: stored,
                                    winner,
                                });
                            }
                            None => return Err(CollabError::BaseRelaySequencePending),
                        };
                        if coordinate.relay_seq == local_relay_seq {
                            return Err(CollabError::BaseRelaySequenceCollision {
                                relay_seq: coordinate.relay_seq,
                            });
                        }
                        if coordinate.relay_seq > local_relay_seq {
                            return Ok(ClaimOutcome::AlreadyWon { winner: marker });
                        }
                        replace_base_snapshot(
                            tx,
                            BaseSnapshotReplacement {
                                key,
                                content_kind,
                                base_bytes,
                                state_vector_bytes: sv_bytes,
                                coordinate,
                                incoming_claim_id: &incoming_claim_id,
                                now_ms,
                            },
                        )?;
                        let winner = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
                        Ok(ClaimOutcome::Replaced {
                            losing_lineage_claim_id: stored,
                            winner,
                        })
                    }
                    None => Err(CollabError::Corrupt {
                        reason: "exact Y.Doc lineage claim is missing its claim id".to_owned(),
                    }),
                };
            }
            unresolved => {
                return Err(CollabError::LineageClaimUnresolved {
                    status: unresolved.as_str().to_owned(),
                });
            }
        }

        let base_sha = put_binary_blob(tx, base_bytes)?;
        let sv_sha = put_binary_blob(tx, sv_bytes)?;
        // Seq 0 is the base snapshot. INSERT makes the primary key reject a
        // second base.
        tx.execute(
            "INSERT INTO ydoc_snapshots \
             (workspace_id, version_id, object_id, up_to_seq, \
              snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms) \
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                base_sha,
                sv_sha,
                now_ms,
            ],
        )
        .map_err(map_sql)?;
        tx.execute(
            "UPDATE ydoc_docs SET lineage_claim_status='exact', \
             lineage_claim_id=?4, lineage_parent_claim_id=NULL, lineage_epoch_tag=NULL, \
             base_origin_id=?5,base_origin_seq=?6,base_relay_seq=?7, \
             base_relay_confirmed_absent=0,updated_at_ms=?8 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                incoming_claim_id,
                coordinate.map(|value| value.origin_id.as_str()),
                coordinate.map(|value| value.origin_seq),
                coordinate.map(|value| value.relay_seq),
                now_ms
            ],
        )
        .map_err(map_sql)?;
        Ok(ClaimOutcome::Claimed {
            base_snapshot_sha: base_sha,
        })
    })()
}

/// Persist an exact base origin and, when supplied, its authenticated relay
/// position. The claim id must still be active in this transaction.
pub fn record_base_coordinate(
    store: &mut EngineStore,
    record: BaseCoordinateRecord<'_>,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, CollabError> {
    store.write_with(faults, |tx| record_base_coordinate_in_tx(tx, record))
}

pub fn record_base_coordinate_in_tx(
    tx: &Transaction<'_>,
    record: BaseCoordinateRecord<'_>,
) -> Result<(), CollabError> {
    let BaseCoordinateRecord {
        key,
        lineage_claim_id,
        origin_id,
        origin_seq,
        relay_seq,
        now_ms,
    } = record;
    if origin_id.is_empty()
        || origin_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
        || origin_id.bytes().any(|byte| byte.is_ascii_control())
        || origin_seq < 0
        || relay_seq.is_some_and(|value| value < 0)
    {
        return Err(CollabError::InvalidIdentifier {
            reason: "base relay coordinates must be bounded and nonnegative".to_owned(),
        });
    }
    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.lineage_claim_id.as_deref() != Some(lineage_claim_id) {
        return Err(CollabError::LineageWriteStale {
            expected: Some(lineage_claim_id.to_owned()),
            observed: marker.lineage_claim_id,
        });
    }
    let replace = marker.base_origin_id.is_none()
        || marker.base_origin_seq.is_none()
        || matches!((relay_seq, marker.base_relay_seq), (Some(new), Some(old)) if new < old)
        || matches!((relay_seq, marker.base_relay_seq), (Some(_), None));
    if replace {
        tx.execute(
            "UPDATE ydoc_docs SET base_origin_id=?4,base_origin_seq=?5, \
             base_relay_seq=COALESCE(?6,base_relay_seq), \
             base_relay_confirmed_absent=CASE WHEN ?6 IS NULL \
               THEN base_relay_confirmed_absent ELSE 0 END,updated_at_ms=?7 \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                origin_id,
                origin_seq,
                relay_seq,
                now_ms,
            ],
        )
        .map_err(map_sql)?;
    }
    Ok(())
}

/// Mark a stored exact coordinate as authoritatively absent at the relay.
pub fn mark_base_coordinate_absent_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    lineage_claim_id: &str,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
) -> Result<(), CollabError> {
    let changed = tx
        .execute(
            "UPDATE ydoc_docs SET base_relay_confirmed_absent=1,updated_at_ms=?7 \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
               AND lineage_claim_id=?4 AND base_origin_id=?5 AND base_origin_seq=?6 \
               AND base_relay_seq IS NULL",
            rusqlite::params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                lineage_claim_id,
                origin_id,
                origin_seq,
                now_ms,
            ],
        )
        .map_err(map_sql)?;
    if changed != 1 {
        return Err(CollabError::BaseStateDiverged);
    }
    Ok(())
}

struct BaseSnapshotReplacement<'a> {
    key: &'a DocKey,
    content_kind: ContentKind,
    base_bytes: &'a [u8],
    state_vector_bytes: &'a [u8],
    coordinate: &'a BaseRelayCoordinate,
    incoming_claim_id: &'a str,
    now_ms: i64,
}

fn replace_base_snapshot(
    tx: &Transaction<'_>,
    replacement: BaseSnapshotReplacement<'_>,
) -> Result<(), CollabError> {
    let BaseSnapshotReplacement {
        key,
        content_kind,
        base_bytes,
        state_vector_bytes,
        coordinate,
        incoming_claim_id,
        now_ms,
    } = replacement;
    tx.execute(
        "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(map_sql)?;
    tx.execute(
        "DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(map_sql)?;
    let base_sha = put_binary_blob(tx, base_bytes)?;
    let sv_sha = put_binary_blob(tx, state_vector_bytes)?;
    tx.execute(
        "INSERT INTO ydoc_snapshots (workspace_id,version_id,object_id,up_to_seq, \
         snapshot_blob_sha256,state_vector_blob_sha256,recorded_at_ms) \
         VALUES (?1,?2,?3,0,?4,?5,?6)",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            base_sha,
            sv_sha,
            now_ms,
        ],
    )
    .map_err(map_sql)?;
    tx.execute(
        "UPDATE ydoc_docs SET content_kind=?4,regime='replicated',head_update_seq=0, \
         head_snapshot_seq=0,last_settled_sha=NULL,seed_source_sha256=NULL, \
         lineage_claim_status='exact', \
         lineage_claim_id=?5,lineage_parent_claim_id=NULL,lineage_epoch_tag=NULL, \
         base_origin_id=?6,base_origin_seq=?7,base_relay_seq=?8, \
         base_relay_confirmed_absent=0,updated_at_ms=?9 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            content_kind.as_str(),
            incoming_claim_id,
            coordinate.origin_id,
            coordinate.origin_seq,
            coordinate.relay_seq,
            now_ms,
        ],
    )
    .map_err(map_sql)?;
    Ok(())
}

/// Atomically archive an exact active predecessor and install a fresh
/// successor base. The claim and state-vector predicates are both checked in
/// the write transaction. A retry that finds the same successor is a strict
/// no-op.
#[derive(Debug, Clone, Copy)]
pub struct SuccessorReplacement<'a> {
    pub key: &'a DocKey,
    pub expected_predecessor_claim_id: &'a str,
    pub expected_predecessor_state_vector_sha256: &'a str,
    pub path: &'a str,
    pub successor: &'a SuccessorBase,
    /// The selected portable artifact for a scene successor. Scene Y.Docs keep
    /// asset references, not bytes, so validating the canonical artifact needs
    /// the exact text whose embedded files supply those bytes.
    pub scene_result: Option<&'a str>,
    pub now_ms: i64,
}

pub fn replace_lineage_with_successor(
    store: &mut EngineStore,
    replacement: SuccessorReplacement<'_>,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<SuccessorInstallOutcome>, CollabError> {
    validate_successor_base(replacement.successor, replacement.scene_result)?;
    store.write_with(faults, |tx| {
        replace_lineage_with_successor_in_tx(tx, replacement)
    })
}

/// Transaction-composable form of [`replace_lineage_with_successor`].
pub fn replace_lineage_with_successor_in_tx(
    tx: &Transaction<'_>,
    replacement: SuccessorReplacement<'_>,
) -> Result<SuccessorInstallOutcome, CollabError> {
    let SuccessorReplacement {
        key,
        expected_predecessor_claim_id,
        expected_predecessor_state_vector_sha256,
        path,
        successor,
        scene_result,
        now_ms,
    } = replacement;
    validate_successor_base(successor, scene_result)?;
    if successor.predecessor_state_vector_sha256 != expected_predecessor_state_vector_sha256 {
        return Err(CollabError::InvalidSuccessorBase {
            constraint: "predecessor state vector matches the successor CAS",
            expected: expected_predecessor_state_vector_sha256.to_owned(),
            observed: successor.predecessor_state_vector_sha256.clone(),
        });
    }
    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.lineage_claim_status == LineageClaimStatus::Exact
        && marker.lineage_claim_id.as_deref() == Some(successor.lineage_claim_id.as_str())
    {
        if marker.lineage_parent_claim_id.as_deref() != Some(expected_predecessor_claim_id)
            || marker.lineage_epoch_tag.as_deref() != Some(successor.epoch_tag.as_str())
            || marker.content_kind != successor.content_kind
            || marker.path.as_deref() != Some(path)
        {
            return Err(CollabError::Corrupt {
                reason: "replayed Y.Doc successor metadata does not match the active lineage"
                    .to_owned(),
            });
        }
        let stored_base: Option<(String, String)> = tx
            .query_row(
                "SELECT snapshot_blob_sha256, state_vector_blob_sha256 \
                 FROM ydoc_snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                   AND up_to_seq=0",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sql)?;
        let expected_state_vector_sha256 = crate::hex_sha256(&successor.state_vector);
        if stored_base.as_ref()
            != Some(&(
                successor.lineage_claim_id.clone(),
                expected_state_vector_sha256,
            ))
        {
            return Err(CollabError::Corrupt {
                reason: "replayed Y.Doc successor snapshot does not match its active claim"
                    .to_owned(),
            });
        }
        return Ok(SuccessorInstallOutcome::Replayed {
            successor_claim_id: successor.lineage_claim_id.clone(),
        });
    }
    let (marker, predecessor, predecessor_state_vector) = load_exact_active_lineage(
        tx,
        key,
        expected_predecessor_claim_id,
        expected_predecessor_state_vector_sha256,
    )?;

    let predecessor_full_state_sha = put_binary_blob(tx, &predecessor.encode_full_state())?;
    let predecessor_state_vector_sha = put_binary_blob(tx, &predecessor_state_vector)?;
    tx.execute(
        "INSERT INTO ydoc_inactive_lineages (workspace_id, version_id, object_id, \
         lineage_claim_id, parent_claim_id, disposition, content_kind, path, epoch_tag, \
         full_state_blob_sha256, state_vector_blob_sha256, recorded_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'superseded-predecessor', ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            expected_predecessor_claim_id,
            marker.lineage_parent_claim_id,
            marker.content_kind.as_str(),
            marker.path,
            marker.lineage_epoch_tag,
            predecessor_full_state_sha,
            predecessor_state_vector_sha,
            now_ms,
        ],
    )
    .map_err(map_sql)?;

    let successor_base_sha = put_binary_blob(tx, &successor.update)?;
    let successor_state_vector_sha = put_binary_blob(tx, &successor.state_vector)?;
    tx.execute(
        "DELETE FROM ydoc_updates \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(map_sql)?;
    tx.execute(
        "DELETE FROM ydoc_snapshots \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(map_sql)?;
    tx.execute(
        "INSERT INTO ydoc_snapshots (workspace_id, version_id, object_id, up_to_seq, \
         snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms) \
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            successor_base_sha,
            successor_state_vector_sha,
            now_ms,
        ],
    )
    .map_err(map_sql)?;
    tx.execute(
        "UPDATE ydoc_docs SET content_kind=?4, regime='replicated', head_update_seq=0, \
         head_snapshot_seq=0, seed_source_sha256=NULL, lineage_claim_status='exact', \
         lineage_claim_id=?5, lineage_parent_claim_id=?6, lineage_epoch_tag=?7, \
         path=?8, last_settled_sha=?9, updated_at_ms=?10 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            successor.content_kind.as_str(),
            successor.lineage_claim_id,
            expected_predecessor_claim_id,
            successor.epoch_tag,
            path,
            successor.result_sha256,
            now_ms,
        ],
    )
    .map_err(map_sql)?;
    Ok(SuccessorInstallOutcome::Installed {
        predecessor_claim_id: expected_predecessor_claim_id.to_owned(),
        successor_claim_id: successor.lineage_claim_id.clone(),
    })
}

/// Archive an exact active lineage without installing a text successor.
///
/// Binary, moved-object, and absent reviewed outcomes cannot keep the active
/// text lineage. The compact inactive row retains its causal branch so a late
/// delta can be compared with the reviewed head instead of being dropped.
pub fn archive_active_lineage_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    expected_claim_id: &str,
    expected_state_vector_sha256: &str,
    last_surfaced_projection_sha256: Option<&str>,
    now_ms: i64,
) -> Result<(), CollabError> {
    let (marker, doc, state_vector) =
        load_exact_active_lineage(tx, key, expected_claim_id, expected_state_vector_sha256)?;

    let full_state_sha256 = put_binary_blob(tx, &doc.encode_full_state())?;
    let state_vector_sha256 = put_binary_blob(tx, &state_vector)?;
    tx.execute(
        "INSERT INTO ydoc_inactive_lineages (workspace_id, version_id, object_id, \
         lineage_claim_id, parent_claim_id, disposition, content_kind, path, epoch_tag, \
         full_state_blob_sha256, state_vector_blob_sha256, \
         last_surfaced_state_vector_blob_sha256, last_surfaced_projection_sha256, \
         recorded_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'superseded-predecessor', ?6, ?7, ?8, \
                 ?9, ?10, ?10, ?11, ?12, ?12)",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            expected_claim_id,
            marker.lineage_parent_claim_id,
            marker.content_kind.as_str(),
            marker.path,
            marker.lineage_epoch_tag,
            full_state_sha256,
            state_vector_sha256,
            last_surfaced_projection_sha256,
            now_ms,
        ],
    )
    .map_err(map_sql)?;
    let deleted = tx
        .execute(
            "DELETE FROM ydoc_docs \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(map_sql)?;
    if deleted != 1 {
        return Err(CollabError::Corrupt {
            reason: "archived Y.Doc lineage marker vanished during its transaction".to_owned(),
        });
    }
    Ok(())
}

fn load_exact_active_lineage(
    tx: &Transaction<'_>,
    key: &DocKey,
    expected_claim_id: &str,
    expected_state_vector_sha256: &str,
) -> Result<(Marker, Ydoc, Vec<u8>), CollabError> {
    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.lineage_claim_status != LineageClaimStatus::Exact {
        return Err(CollabError::LineageClaimUnresolved {
            status: marker.lineage_claim_status.as_str().to_owned(),
        });
    }
    if marker.lineage_claim_id.as_deref() != Some(expected_claim_id) {
        return Err(CollabError::LineagePredecessorMismatch {
            expected: expected_claim_id.to_owned(),
            observed: marker.lineage_claim_id,
        });
    }
    let deferred: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(map_sql)?;
    if deferred {
        return Err(CollabError::LineageIncomplete {
            reason: "deferred Y.Doc coordinates are pending",
        });
    }
    let doc = load_for_replay_gate(tx, key)?;
    if doc.has_pending_dependencies() {
        return Err(CollabError::LineageIncomplete {
            reason: "the active Y.Doc has pending dependencies",
        });
    }
    let state_vector = doc.encode_state_vector();
    let observed_state_vector_sha256 = crate::hex_sha256(&state_vector);
    if observed_state_vector_sha256 != expected_state_vector_sha256 {
        return Err(CollabError::LineageStateVectorMismatch {
            expected: expected_state_vector_sha256.to_owned(),
            observed: observed_state_vector_sha256,
        });
    }
    Ok((marker, doc, state_vector))
}

fn validate_successor_base(
    successor: &SuccessorBase,
    scene_result: Option<&str>,
) -> Result<(), CollabError> {
    validate_update_bytes(&successor.update)?;
    let observed_claim = crate::hex_sha256(&successor.update);
    if observed_claim != successor.lineage_claim_id {
        return Err(CollabError::InvalidSuccessorBase {
            constraint: "lineage claim must equal the base blob SHA-256",
            expected: successor.lineage_claim_id.clone(),
            observed: observed_claim,
        });
    }
    let doc = Ydoc::wire();
    doc.apply(&successor.update)?;
    if doc.has_pending_dependencies() {
        return Err(CollabError::InvalidSuccessorBase {
            constraint: "successor base must be dependency-complete",
            expected: "no pending dependencies".to_owned(),
            observed: "pending dependencies".to_owned(),
        });
    }
    let observed_epoch = doc
        .lineage_epoch_tag()
        .unwrap_or_else(|| "missing".to_owned());
    if observed_epoch != successor.epoch_tag {
        return Err(CollabError::InvalidSuccessorBase {
            constraint: "reserved lineage epoch tag",
            expected: successor.epoch_tag.clone(),
            observed: observed_epoch,
        });
    }
    let observed_state_vector = doc.encode_state_vector();
    if observed_state_vector != successor.state_vector {
        return Err(CollabError::InvalidSuccessorBase {
            constraint: "successor state vector",
            expected: crate::hex_sha256(&successor.state_vector),
            observed: crate::hex_sha256(&observed_state_vector),
        });
    }
    let projected = if successor.content_kind == ContentKind::Scene {
        let scene_result = scene_result.ok_or_else(|| CollabError::InvalidSuccessorBase {
            constraint: "scene successor portable artifact",
            expected: successor.result_sha256.clone(),
            observed: "missing".to_owned(),
        })?;
        let parsed = crate::scene::parse_portable_scene(scene_result).map_err(|error| {
            CollabError::InvalidSuccessorBase {
                constraint: "scene successor portable artifact",
                expected: successor.result_sha256.clone(),
                observed: error.to_string(),
            }
        })?;
        let folded = doc.fold_scene();
        for (id, file) in &parsed.files {
            let asset = folded
                .assets
                .get(id)
                .ok_or_else(|| CollabError::InvalidSuccessorBase {
                    constraint: "scene successor asset digest",
                    expected: "a durable asset record".to_owned(),
                    observed: "missing".to_owned(),
                })?;
            let observed = crate::hex_sha256(&file.bytes);
            if observed != asset.sha256 {
                return Err(CollabError::InvalidSuccessorBase {
                    constraint: "scene successor asset digest",
                    expected: asset.sha256.clone(),
                    observed,
                });
            }
        }
        let asset_bytes = parsed
            .files
            .into_iter()
            .map(|(id, file)| (id, file.bytes))
            .collect();
        folded.portable_json_with_asset_bytes(&asset_bytes)?
    } else {
        doc.project(successor.content_kind)?.content
    };
    let observed_result = crate::hex_sha256(projected.as_bytes());
    if observed_result != successor.result_sha256 {
        return Err(CollabError::InvalidSuccessorBase {
            constraint: "successor canonical result",
            expected: successor.result_sha256.clone(),
            observed: observed_result,
        });
    }
    Ok(())
}

/// Read a doc's marker inside the caller's transaction.
///
/// Origination reads the marker under the SAME transaction as the append it
/// rides and the claim it may commit, so the three cannot disagree.
pub fn read_marker_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
) -> Result<Option<Marker>, CollabError> {
    read_marker_from_connection(tx, key)
}

/// Read a doc's marker from the caller's SQLite connection.
///
/// This is the read-only counterpart to [`read_marker_in_tx`]. Callers that
/// need a stable multi-query view must supply a connection inside their own
/// transaction.
pub fn read_marker_from_connection(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<Marker>, CollabError> {
    query_marker(conn, key)
}

/// Reconstruct the persisted doc inside the caller's transaction (marker
/// required). The conflict-resolution fold reads, rewrites, and appends under
/// ONE transaction so the folded update extends exactly the lineage it read.
pub fn load_doc_in_tx(tx: &Transaction<'_>, key: &DocKey) -> Result<Ydoc, CollabError> {
    load_doc_from_connection(tx, key)
}

/// Reconstruct a persisted doc from the caller's SQLite connection.
///
/// This is the read-only counterpart to [`load_doc_in_tx`]. Callers that need
/// the marker and update rows to share one snapshot must supply a connection
/// inside their own transaction.
pub fn load_doc_from_connection(conn: &Connection, key: &DocKey) -> Result<Ydoc, CollabError> {
    load_for_replay_gate(conn, key)
}

/// Append one locally-produced update inside the caller's transaction — the
/// transaction-composable core of [`record_local_update`]. Validates the
/// bytes, runs the replay-parity gate, content-dedupes, and advances the
/// head.
pub fn record_update_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    update: &[u8],
    now_ms: i64,
) -> Result<AppendOutcome, CollabError> {
    validate_update_bytes(update)?;
    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    let sha = crate::hex_sha256(update);
    append_local_update(tx, key, &marker, update, &sha, None, now_ms)
}

/// Append only if the active claim matches the lineage an open session bound
/// to. The check runs before any blob, update, or journal mutation.
pub fn record_update_for_lineage_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    expected_lineage_claim_id: Option<&str>,
    update: &[u8],
    now_ms: i64,
) -> Result<AppendOutcome, CollabError> {
    let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
    if marker.lineage_claim_id.as_deref() != expected_lineage_claim_id {
        return Err(CollabError::LineageWriteStale {
            expected: expected_lineage_claim_id.map(ToOwned::to_owned),
            observed: marker.lineage_claim_id,
        });
    }
    validate_update_bytes(update)?;
    let sha = crate::hex_sha256(update);
    append_local_update(tx, key, &marker, update, &sha, None, now_ms)
}

/// Encode the base bytes (and their state vector) that ORIGINATE `key`'s
/// replicated lineage, from the state persisted inside the caller's
/// transaction.
///
/// The encode is a full state of the lineage as it stands right now, never a
/// fresh artifact seed. A promoted lineage therefore publishes the update rows
/// it already holds: a fresh seed would mint new Yjs item ids, leave those rows
/// on the origin alone, and every clean peer would be permanently missing them.
///
/// `None` means "do not originate yet": the lineage has an unresolved
/// dependency, so a full-state encode would silently drop the pending row. A
/// later append retries once the predecessor lands. This is the same condition
/// [`maybe_compact`] skips on, for the same reason.
pub fn encode_origination_base_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
) -> Result<Option<OriginationBase>, CollabError> {
    let doc = load_for_replay_gate(tx, key)?;
    if doc.has_missing_updates() {
        return Ok(None);
    }
    Ok(Some(OriginationBase {
        base: doc.encode_full_state(),
        state_vector: doc.encode_state_vector(),
    }))
}

/// Settle: project the reconstructed Y.Doc to artifact content (with provenance),
/// content-address the projection in `binary_blobs`, and enqueue a durable
/// materialization job (R04's pipeline) in the SAME transaction.
///
/// **Clock-independent exactly-once.** The generation is a DURABLE, monotone
/// per-doc `settle_seq` (never the wall clock): a re-settle of UNCHANGED content
/// reuses the current generation (idempotent no-op even if the clock advanced —
/// a crash-retry dedups); a settle of CHANGED content bumps the generation (so a
/// content revert re-materializes, and a newer settle supersedes an older
/// on-disk generation for the path). The job id is deterministic in `(key,
/// content sha, generation)` and dedup-guarded, so a crash after commit but
/// before ack replays exactly-once regardless of the clock.
pub fn settle(
    store: &mut EngineStore,
    key: &DocKey,
    target_path: &str,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<SettleOutcome>, CollabError> {
    let persisted = match load_persisted(store, key)? {
        Some(p) => p,
        None => return Err(CollabError::NoMarker),
    };
    let projection = persisted.doc.project(persisted.marker.content_kind)?;
    let content_bytes = projection.content.clone().into_bytes();
    let content_sha = crate::hex_sha256(&content_bytes);
    let sv_bytes = persisted.doc.encode_state_vector();

    store.write_with(faults, |tx| {
        // Persist the content and its provenance state vector as blobs.
        put_binary_blob(tx, &content_bytes)?;
        put_binary_blob(tx, &sv_bytes)?;

        // Durable per-doc settle counter + last-materialized content.
        let (settle_seq, last_sha): (i64, Option<String>) = tx
            .query_row(
                "SELECT settle_seq, last_settled_sha FROM ydoc_docs \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(map_sql)?
            .ok_or(CollabError::NoMarker)?;
        // Unchanged content reuses the current generation (idempotent); changed
        // content bumps it. Clock-free either way.
        let content_changed = last_sha.as_deref() != Some(content_sha.as_str());
        let generation = if content_changed {
            settle_seq + 1
        } else {
            settle_seq
        };
        let job_id = crate::hex_sha256(
            format!(
                "{}\0{}\0{}\0{}\0{}",
                key.workspace_id, key.version_id, key.object_id, content_sha, generation
            )
            .as_bytes(),
        );

        // Dedup: a job with this deterministic id already present ⇒ exactly-once.
        let already: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM materialization_jobs WHERE job_id = ?1",
                [&job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql)?;
        if already.is_some() {
            return Ok(SettleOutcome {
                projection: projection.clone(),
                job_id: job_id.clone(),
                content_sha256: content_sha.clone(),
                deduped: true,
            });
        }
        enqueue_job(
            tx,
            &MaterializationJobSpec {
                job_id: job_id.clone(),
                workspace_id: key.workspace_id.clone(),
                target_path: target_path.to_string(),
                content_sha256: content_sha.clone(),
                // The preimage the materializer revalidates before replacing: the
                // FIRST settle expects the target absent; a later settle expects
                // the PREVIOUS settle's content still on disk (else an external
                // editor wrote it — preserve-both). `Absent` on every settle would
                // wrongly conflict-flag every edited doc after the first write.
                preimage: match &last_sha {
                    Some(sha) => Preimage::Present(sha.clone()),
                    None => Preimage::Absent,
                },
                target_generation: generation,
                now_ms,
            },
        )?;
        // Advance the durable settle counter only on a real content change.
        if content_changed {
            tx.execute(
                "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6 \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    generation,
                    content_sha,
                    now_ms,
                ],
            )
            .map_err(map_sql)?;
        }
        Ok(SettleOutcome {
            projection: projection.clone(),
            job_id: job_id.clone(),
            content_sha256: content_sha.clone(),
            deduped: false,
        })
    })
}

/// Close a session: regime-dependent. Replicated (or persist-closed-state)
/// compacts and KEEPS the lineage durable; local-only prunes every CRDT row to
/// the bare marker (the workspace file is the artifact). A caller that uses a
/// store-backed projector supplies its digest; scenes refuse the generic
/// projection because their portable files resolve from versioned storage.
pub fn close_session(
    store: &mut EngineStore,
    key: &DocKey,
    persist_closed_state: bool,
    authoritative_projection_sha256: Option<&str>,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<CloseOutcome>, CollabError> {
    let marker = read_marker(store, key)?.ok_or(CollabError::NoMarker)?;
    if marker.regime == Regime::Replicated || persist_closed_state {
        // Force a compaction (threshold 0) so the lineage is a single snapshot +
        // no trailing updates, and NEVER prune it.
        return Ok(match maybe_compact(store, key, 0, faults, now_ms)? {
            TxnOutcome::Committed(outcome) => {
                TxnOutcome::Committed(CloseOutcome::Compacted(outcome))
            }
            TxnOutcome::Crashed { committed } => TxnOutcome::Crashed { committed },
        });
    }
    // Local-only prune would DISCARD the CRDT cache. Refuse unless the artifact
    // already holds the head's bytes (the workspace file is the artifact: it
    // must exist before the cache is thrown away). A doc with no edits
    // (`head_update_seq == 0`) has nothing to lose and prunes freely.
    if marker.head_update_seq > 0 {
        let content_sha = match authoritative_projection_sha256 {
            Some(content_sha) => content_sha.to_owned(),
            None if marker.content_kind == ContentKind::Scene => {
                return Err(CollabError::UnsettledClose);
            }
            None => {
                let persisted = load_persisted(store, key)?.ok_or(CollabError::NoMarker)?;
                crate::hex_sha256(
                    persisted
                        .doc
                        .project(marker.content_kind)?
                        .content
                        .as_bytes(),
                )
            }
        };
        // TWO ways the artifact can already hold these bytes, and both count.
        // A settle records itself in `last_settled_sha`. A CAPTURE of the file
        // moves the HEAD to them and touches no marker column — it reads the
        // disk, so a matching captured head IS the proof this guard asks for.
        // Reading the marker alone refuses a document whose own projection is
        // already the head, and capture -> discharge -> open never converges
        // (#665). The sync-side `ydoc_apply::project_and_write_in_tx` uses a
        // narrower head/projection match to dedupe a converged envelope; it
        // does not gate this prune.
        let covered = store.read_with(|conn| -> Result<bool, CollabError> {
            if last_settled_sha(conn, key)?.as_deref() == Some(content_sha.as_str())
                || captured_head_sha(conn, key)?.as_deref() == Some(content_sha.as_str())
            {
                return Ok(true);
            }
            // THIRD proof (#815): a seed-only lineage whose recorded source
            // is still the captured head. The projection sha cannot match —
            // projecting normalizes — but everything the doc contains was
            // imported from bytes the captured head (and the version store's
            // moment for it) still holds, so the prune discards a cache of
            // the file, not content.
            let seed_source = seed_only_lineage_source(conn, key)?;
            Ok(seed_source.is_some() && seed_source == captured_head_sha(conn, key)?)
        })?;
        if !covered {
            return Err(CollabError::UnsettledClose);
        }
        // The settle may have COMMITTED while its materialization failed
        // transiently: last_settled_sha matches the projection but the job
        // that would land it on disk is still pending. Pruning now would
        // discard the CRDT with the artifact never replaced — refuse until
        // the replay (retry-settle or open-time) lands the job.
        //
        // Matched on the object's TARGET PATH rather than a job-id prefix.
        // Disk-writing jobs carry many id spellings (`ydoc-mat_`,
        // `resolve-mat_`, `merge-mat_`, `sync-resolve-mat_` from
        // `enqueue_write`; `secret-mat_` from the secrets store's own
        // enqueue; binary, version-switch, and unprefixed hash-id jobs
        // besides) and a prefix list drifts out of sync with them (#715:
        // three went unmatched, each a stale-disk window).
        // Every kind sets `target_path` to the disk path it intends to
        // write, so asking "is any pending job aimed at this object's disk
        // artifact" via that path is the fact itself, not a proxy for it —
        // and it needs no update when a future job kind is added.
        let job_pending: bool = store.read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM materialization_jobs j \
                 WHERE j.target_path = ( \
                     SELECT path FROM moments \
                      WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                      ORDER BY moment_order DESC LIMIT 1) \
                   AND j.status = 'pending' \
                   AND (j.workspace_id = ?1 OR j.workspace_id = ''))",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
            .map_err(map_sql)
        })?;
        if job_pending {
            return Err(CollabError::UnsettledClose);
        }
    }
    // Prune the CRDT cache to nothing, keep the marker.
    store.write_with(faults, |tx| {
        let removed_updates = tx
            .execute(
                "DELETE FROM ydoc_updates \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(map_sql)?;
        let removed_snapshots = tx
            .execute(
                "DELETE FROM ydoc_snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(map_sql)?;
        // `last_settled_sha` clears WITH the cache: it described the pruned
        // lineage. The next open reseeds from the file, and its settle
        // expectation must be the OPEN-TIME head — a retained sha from the
        // pruned lineage would turn the first settle after an intervening
        // capture/edit into a permanent ConflictStaleTarget.
        tx.execute(
            "UPDATE ydoc_docs SET head_update_seq = 0, head_snapshot_seq = 0, \
             last_settled_sha = NULL, seed_source_sha256 = NULL, updated_at_ms = ?4 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            rusqlite::params![key.workspace_id, key.version_id, key.object_id, now_ms],
        )
        .map_err(map_sql)?;
        Ok(CloseOutcome::Pruned {
            removed_updates,
            removed_snapshots,
        })
    })
}

// ---- shared internals (used here and by `replication`) ----------------------

pub(crate) fn validate_update_bytes(update: &[u8]) -> Result<(), CollabError> {
    if update.is_empty() {
        return Err(CollabError::EmptyUpdate);
    }
    if update.len() > MAX_YDOC_UPDATE_BYTES {
        return Err(CollabError::UpdateTooLarge {
            actual: update.len(),
            max: MAX_YDOC_UPDATE_BYTES,
        });
    }
    // Constraint 5: reject truncated/malformed bytes BEFORE journaling.
    // `Ydoc::validate_update` runs the abort-safe pre-validator
    // (`replay_parity::prevalidate_update_bytes`) FIRST — before any call that
    // can reach yrs 0.27.3's uncatchable `Update::decode_v1` hard-abort on
    // malformed input (`catch_unwind` cannot intercept it; see
    // `replay_parity::safe_read_string`'s doc comment) — so this single call
    // covers the pre-validation for both ingestion paths that reach here (the
    // local edit path `record_local_update` and the remote replication path
    // `apply_remote_update`). No separate pre-validate call is needed: it would
    // just re-walk the whole wire and re-allocate the fingerprints a second
    // time on this hot durable path.
    Ydoc::validate_update(update)?;
    Ok(())
}

/// Reconstruct a lineage from the caller's connection/transaction for the
/// replay-parity gate. Keeping this read inside the write transaction makes the
/// checked base exactly the base that the append will extend.
pub(crate) fn load_for_replay_gate(conn: &Connection, key: &DocKey) -> Result<Ydoc, CollabError> {
    query_marker(conn, key)?.ok_or(CollabError::NoMarker)?;
    let snapshot = latest_snapshot(conn, key)?;
    let from_seq = snapshot.as_ref().map_or(0, |(seq, _)| *seq);
    let tail = updates_after(conn, key, from_seq)?;
    let doc = Ydoc::wire();
    if let Some((_, sha)) = snapshot {
        let bytes = binary_blob_for_gate(conn, &sha)?;
        doc.apply(&bytes)?;
    }
    for (seq, sha) in tail {
        let bytes = binary_blob_for_gate(conn, &sha).map_err(|error| match error {
            CollabError::Corrupt { .. } => CollabError::Corrupt {
                reason: format!("update blob missing or invalid at seq {seq}"),
            },
            other => other,
        })?;
        doc.apply(&bytes)?;
    }
    Ok(doc)
}

fn binary_blob_for_gate(conn: &Connection, sha: &str) -> Result<Vec<u8>, CollabError> {
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256 = ?1",
            [sha],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sql)?
        .ok_or_else(|| CollabError::Corrupt {
            reason: "referenced Y.Doc blob is missing".to_owned(),
        })?;
    if crate::hex_sha256(&bytes) != sha {
        return Err(CollabError::Corrupt {
            reason: "referenced Y.Doc blob failed integrity validation".to_owned(),
        });
    }
    Ok(bytes)
}

struct MarkerRow {
    content_kind: String,
    regime: String,
    head_update_seq: i64,
    head_snapshot_seq: i64,
    lineage_claim_status: String,
    lineage_claim_id: Option<String>,
    lineage_parent_claim_id: Option<String>,
    lineage_epoch_tag: Option<String>,
    path: Option<String>,
    base_origin_id: Option<String>,
    base_origin_seq: Option<i64>,
    base_relay_seq: Option<i64>,
    base_relay_confirmed_absent: bool,
}

pub(crate) fn query_marker(conn: &Connection, key: &DocKey) -> Result<Option<Marker>, CollabError> {
    let row = conn
        .query_row(
            "SELECT content_kind, regime, head_update_seq, head_snapshot_seq, \
             lineage_claim_status, lineage_claim_id, lineage_parent_claim_id, \
             lineage_epoch_tag, path, base_origin_id, base_origin_seq, base_relay_seq, \
             base_relay_confirmed_absent FROM ydoc_docs \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            |row| {
                Ok(MarkerRow {
                    content_kind: row.get(0)?,
                    regime: row.get(1)?,
                    head_update_seq: row.get(2)?,
                    head_snapshot_seq: row.get(3)?,
                    lineage_claim_status: row.get(4)?,
                    lineage_claim_id: row.get(5)?,
                    lineage_parent_claim_id: row.get(6)?,
                    lineage_epoch_tag: row.get(7)?,
                    path: row.get(8)?,
                    base_origin_id: row.get(9)?,
                    base_origin_seq: row.get(10)?,
                    base_relay_seq: row.get(11)?,
                    base_relay_confirmed_absent: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(map_sql)?;
    row.map(|row| {
        Ok(Marker {
            content_kind: ContentKind::parse(&row.content_kind)?,
            regime: Regime::parse(&row.regime),
            head_update_seq: row.head_update_seq,
            head_snapshot_seq: row.head_snapshot_seq,
            lineage_claim_status: LineageClaimStatus::parse(&row.lineage_claim_status)?,
            lineage_claim_id: row.lineage_claim_id,
            lineage_parent_claim_id: row.lineage_parent_claim_id,
            lineage_epoch_tag: row.lineage_epoch_tag,
            path: row.path,
            base_origin_id: row.base_origin_id,
            base_origin_seq: row.base_origin_seq,
            base_relay_seq: row.base_relay_seq,
            base_relay_confirmed_absent: row.base_relay_confirmed_absent,
        })
    })
    .transpose()
}

/// The sha of the content the last settle materialized (or `None` if never
/// settled) — the durable settle-handoff marker the local-only close guard reads.
/// Full durable admission check for a remote update WITHOUT applying it:
/// byte validation (empty/5 MiB cap/abort-safe prevalidation) plus the
/// replay-parity gate against the lineage's current base. The sync defer
/// path runs this BEFORE acking a coordinate it can only replay later —
/// an update the drain would refuse must never be acked.
pub fn validate_remote_update_for(
    store: &EngineStore,
    key: &DocKey,
    bytes: &[u8],
) -> Result<(), CollabError> {
    validate_remote_update_with_pending(store, key, &[], bytes)
}

/// [`validate_remote_update_for`] with already-acked-but-deferred
/// predecessor updates replayed onto the gate doc first — a later deferred
/// update may only become invalid AFTER its queued predecessors apply, and
/// acking it against the bare durable head would strand the drain.
pub fn validate_remote_update_with_pending(
    store: &EngineStore,
    key: &DocKey,
    pending: &[Vec<u8>],
    bytes: &[u8],
) -> Result<(), CollabError> {
    validate_update_bytes(bytes)?;
    let base = store.read_with(|conn| load_for_replay_gate(conn, key))?;
    for queued in pending {
        base.apply(queued)?;
    }
    crate::validate_replay_parity(&base, bytes)
}

/// The content sha the lineage last durably settled (public read for the
/// daemon settle path's idempotent no-op check).
pub fn read_last_settled_sha(
    store: &EngineStore,
    key: &DocKey,
) -> Result<Option<String>, CollabError> {
    store.read_with(|conn| last_settled_sha(conn, key))
}

/// The captured head sha a SEED-ONLY lineage imported, or `None` when the
/// lineage is anything else (#815).
///
/// `Some(sha)` proves, from durable state alone, that the doc's entire
/// history is one client-declared seed update importing the captured head
/// `sha`: local-only regime, exactly one update in the log (and the head
/// pointers agreeing), no snapshots, never settled. While the captured head
/// still holds `sha`, the doc's canonical content IS that file's content —
/// the live Y.Doc stays canonical, and there is nothing to write on settle
/// and nothing a prune could lose. Every doubt (a second update, a snapshot,
/// a prior settle, a replicated regime, no recorded seed source) answers
/// `None`, and the caller falls back to writing exactly as before.
pub(crate) fn seed_only_lineage_source(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<String>, CollabError> {
    conn.query_row(
        "SELECT d.seed_source_sha256 FROM ydoc_docs d \
         WHERE d.workspace_id = ?1 AND d.version_id = ?2 AND d.object_id = ?3 \
           AND d.regime = 'local-only' \
           AND d.head_update_seq = 1 AND d.head_snapshot_seq = 0 \
           AND d.last_settled_sha IS NULL \
           AND d.seed_source_sha256 IS NOT NULL \
           AND (SELECT COUNT(*) FROM ydoc_updates u \
                 WHERE u.workspace_id = ?1 AND u.version_id = ?2 \
                   AND u.object_id = ?3) = 1 \
           AND NOT EXISTS (SELECT 1 FROM ydoc_snapshots s \
                 WHERE s.workspace_id = ?1 AND s.version_id = ?2 \
                   AND s.object_id = ?3)",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(map_sql)
    .map(Option::flatten)
}

/// Store-level [`seed_only_lineage_source`].
pub fn read_seed_only_lineage_source(
    store: &mut EngineStore,
    key: &DocKey,
) -> Result<Option<String>, CollabError> {
    store.read_with(|conn| seed_only_lineage_source(conn, key))
}

fn last_settled_sha(conn: &Connection, key: &DocKey) -> Result<Option<String>, CollabError> {
    conn.query_row(
        "SELECT last_settled_sha FROM ydoc_docs \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(map_sql)?
    .ok_or(CollabError::NoMarker)
}

/// The object's head sha, but ONLY when a capture put it there.
///
/// The DIRECTION decides, not the bytes. A capture is disk -> engine: it reads
/// the file, mints no materialization job, and its head therefore IS what the
/// file holds. A head the engine wrote is engine -> disk, and its job is the
/// only thing that says whether the file ever received it — a job that
/// conflicted leaves the head holding bytes the file never had, and
/// `ydoc_settle_on_store` withdraws `last_settled_sha` for exactly that case.
/// Answering "covered" from such a head would prune the CRDT over a file that
/// disagrees with it.
///
/// Matched on the recorded DIRECTION itself
/// (`dohc_engine_domain::store::CAPTURE_ORIGIN`), not on a job-row absence.
/// #723: a `NOT EXISTS(materialization_jobs …)` heuristic reads a leftover
/// TERMINAL job row for the same content+path (from an earlier, unrelated
/// engine settle) as "not captured" — a reversion to previously-engine-written
/// bytes then refuses a valid discharge. `claim_foreign_head`'s dedupe writes
/// `metadata_origin` directly and mints no job row either way, so it is the
/// fact this function needs, not a proxy for it.
///
/// A fact about LOCAL heads. The replication boundary stamps replicated
/// heads with `REPLICATED_SNAPSHOT_ORIGIN` (dohc-engine-sync), so this guard
/// reads only locally-minted origins.
fn captured_head_sha(conn: &Connection, key: &DocKey) -> Result<Option<String>, CollabError> {
    conn.query_row(
        "SELECT s.blob_sha256 FROM snapshots s \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3 \
           AND s.metadata_origin = ?4",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            dohc_engine_domain::store::CAPTURE_ORIGIN,
        ],
        // NULL for a BINARY head (schema v10), which a path whose bytes stop
        // round-tripping as UTF-8 becomes. It covers nothing, and reading it
        // as a plain String would raise InvalidColumnType instead —
        // `.optional()` absorbs only QueryReturnedNoRows.
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(map_sql)
    .map(Option::flatten)
}

pub(crate) fn head_of(
    conn: &Connection,
    key: &DocKey,
) -> Result<(i64, i64, LineageClaimStatus), CollabError> {
    let marker = query_marker(conn, key)?.ok_or(CollabError::NoMarker)?;
    Ok((
        marker.head_update_seq,
        marker.head_snapshot_seq,
        marker.lineage_claim_status,
    ))
}

pub(crate) fn blob_seq_in_log(
    conn: &Connection,
    key: &DocKey,
    sha: &str,
) -> Result<Option<i64>, CollabError> {
    conn.query_row(
        "SELECT seq FROM ydoc_updates \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
           AND update_blob_sha256 = ?4 ORDER BY seq ASC LIMIT 1",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id, sha],
        |r| r.get(0),
    )
    .optional()
    .map_err(map_sql)
}

/// Insert one update row with `seq = head + 1` and advance the head, atomically
/// within the caller's transaction. Returns the assigned seq.
pub(crate) fn append_row(
    conn: &Connection,
    key: &DocKey,
    sha: &str,
    actor_origin_id: Option<&str>,
    now_ms: i64,
) -> Result<i64, CollabError> {
    let (head, _, _) = head_of(conn, key)?;
    let seq = head + 1;
    conn.execute(
        "INSERT INTO ydoc_updates \
         (workspace_id, version_id, object_id, seq, update_blob_sha256, \
          actor_origin_id, recorded_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            seq,
            sha,
            actor_origin_id,
            now_ms,
        ],
    )
    .map_err(map_sql)?;
    conn.execute(
        "UPDATE ydoc_docs SET head_update_seq = ?4, updated_at_ms = ?5 \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id, seq, now_ms],
    )
    .map_err(map_sql)?;
    Ok(seq)
}

fn latest_snapshot(conn: &Connection, key: &DocKey) -> Result<Option<(i64, String)>, CollabError> {
    conn.query_row(
        "SELECT up_to_seq, snapshot_blob_sha256 FROM ydoc_snapshots \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
         ORDER BY up_to_seq DESC LIMIT 1",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(map_sql)
}

fn updates_after(
    conn: &Connection,
    key: &DocKey,
    from_seq: i64,
) -> Result<Vec<(i64, String)>, CollabError> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, update_blob_sha256 FROM ydoc_updates \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND seq > ?4 \
             ORDER BY seq ASC",
        )
        .map_err(map_sql)?;
    let rows = stmt
        .query_map(
            rusqlite::params![key.workspace_id, key.version_id, key.object_id, from_seq],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(map_sql)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_sql)?);
    }
    Ok(out)
}

fn map_sql(e: rusqlite::Error) -> CollabError {
    CollabError::Corrupt {
        reason: e.to_string(),
    }
}

#[cfg(test)]
mod successor_validation_tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::{
        encode_scene_asset_record, import_portable_scene, scene_asset_ref, SceneAsset,
        SuccessorIdentity, SuccessorIdentityInput,
    };

    fn canonical_image_scene(key: &DocKey) -> String {
        let source = serde_json::to_string(&json!({
            "type": "excalidraw",
            "elements": [{
                "id": "image-element",
                "type": "image",
                "version": 1,
                "versionNonce": 1,
                "isDeleted": false,
                "index": "a0",
                "fileId": "image-file"
            }],
            "files": {
                "image-file": {
                    "id": "image-file",
                    "mimeType": "image/png",
                    "created": 4,
                    "dataURL": "data:image/png;base64,AQID"
                }
            }
        }))
        .expect("scene source");
        let imported = import_portable_scene(&source).expect("import scene");
        let file = imported.files.get("image-file").expect("image file");
        let sha256 = crate::hex_sha256(&file.bytes);
        let record = encode_scene_asset_record(&SceneAsset {
            id: file.id.clone(),
            mime_type: file.mime_type.clone(),
            created: file.created,
            path: scene_asset_ref(
                &key.workspace_id,
                &key.version_id,
                &key.object_id,
                &sha256,
                &file.mime_type,
            )
            .expect("asset ref"),
            sha256,
            last_retrieved: file.last_retrieved,
            version: file.version,
        })
        .expect("asset record");
        let doc = Ydoc::wire();
        doc.apply(&imported.initial_update).expect("scene seed");
        doc.seed_scene_maps(
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::from([("image-file".to_owned(), record)]),
        );
        doc.fold_scene()
            .portable_json_with_asset_bytes(&BTreeMap::from([(
                "image-file".to_owned(),
                file.bytes.clone(),
            )]))
            .expect("canonical scene")
    }

    #[test]
    fn scene_successor_rejects_asset_bytes_that_miss_the_declared_digest() {
        let key = DocKey::new("ws", "main", "drawing-object").expect("key");
        let artifact = canonical_image_scene(&key);
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &"a".repeat(64),
            predecessor_state_vector_sha256: &"b".repeat(64),
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict",
            artifact_preimage_sha256: &"c".repeat(64),
            content_kind: ContentKind::Scene,
            result_sha256: &crate::hex_sha256(artifact.as_bytes()),
        });
        let valid = crate::fresh_successor_base(&identity, &artifact).expect("valid successor");
        let doc = Ydoc::wire();
        doc.apply(&valid.update).expect("successor update");
        let mut asset = doc.fold_scene().assets["image-file"].clone();
        asset.sha256 = "f".repeat(64);
        let record = encode_scene_asset_record(&asset).expect("tampered asset record");
        doc.seed_scene_maps(
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::from([("image-file".to_owned(), record)]),
        );
        let update = doc.encode_full_state();
        let tampered = SuccessorBase {
            lineage_claim_id: crate::hex_sha256(&update),
            state_vector: doc.encode_state_vector(),
            update,
            ..valid
        };

        let error = validate_successor_base(&tampered, Some(&artifact))
            .expect_err("asset bytes must match the durable digest");
        assert!(matches!(
            error,
            CollabError::InvalidSuccessorBase {
                constraint: "scene successor asset digest",
                ..
            }
        ));
    }
}
