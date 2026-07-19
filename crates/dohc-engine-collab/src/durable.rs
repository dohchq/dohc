//! The durable Y.Doc cache: the content-addressed update log, folded snapshots,
//! convergence-neutral compaction, the base-once replicated lineage, and the
//! settle pipeline. Every write goes through the storage crate's single owned
//! connection via `write_with` (one `BEGIN IMMEDIATE` per durable step,
//! consulting the named storage fault points), and every reconstruct reads the
//! content-addressed blobs the log/snapshots reference.
//!
//! ## Two regimes (never conflated — plan correction)
//!
//! [`Regime::LocalOnly`] keeps the log as a PRUNABLE fast-resume cache: markdown
//! is the durable canonical, and a closed session prunes every CRDT row to the
//! bare marker. [`Regime::Replicated`] makes the CRDT lineage durable canonical:
//! the base is emitted exactly once, local edits journal `ydoc.update` ops
//! (surfaced via [`AppendOutcome::emit_outbound`]), and close NEVER prunes — a
//! peer bootstraps from the persisted lineage.

use dohc_engine_storage::{
    enqueue_job, put_binary_blob, EngineStore, FaultInjector, MaterializationJobSpec, Preimage,
    TxnOutcome,
};
use rusqlite::{Connection, OptionalExtension};

use crate::error::CollabError;
use crate::limits::{DEFAULT_COMPACTION_THRESHOLD, MAX_PROJECTION_BYTES, MAX_YDOC_UPDATE_BYTES};
use crate::replay_cache::{CachedBase, ReplayBaseCache};
use crate::ydoc::{ContentKind, Projection, Ydoc};
use crate::DocKey;

/// Which durability regime a lineage lives under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Regime {
    /// Prunable fast-resume cache; markdown is durable canonical.
    LocalOnly,
    /// Durable canonical CRDT lineage; base-once, never pruned on close.
    Replicated,
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

/// A doc's marker row: content kind, regime, head pointers, and the base-once
/// flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub content_kind: ContentKind,
    pub regime: Regime,
    pub head_update_seq: i64,
    pub head_snapshot_seq: i64,
    pub base_claimed: bool,
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

/// The outcome of a base-once claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// This call minted the single base snapshot for the lineage.
    Claimed { base_snapshot_sha: String },
    /// A base already existed: the caller resumes the winner and emits NO second
    /// base (base-once). The existing base is left byte-intact.
    Resumed,
}

/// The outcome of a settle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleOutcome {
    /// The markdown projection with provenance.
    pub projection: Projection,
    /// The durable materialization job id (deterministic; a crash-retry with the
    /// same content is an idempotent no-op).
    pub job_id: String,
    /// Lowercase-hex sha-256 of the projected markdown (its `binary_blobs` key).
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
              head_update_seq, head_snapshot_seq, base_claimed, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, ?6) \
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

/// Append a locally-produced update to the durable log (advancing the head).
/// Validates the bytes BEFORE any blob put / journal (constraint 5: never
/// journal bytes that fail validation); content-addresses them; and dedups on
/// the blob sha so a crash-retry is exactly-once. Self-bounds the log: a
/// genuinely-new append triggers compaction once the pending count reaches the
/// default threshold, so a long-lived session that never explicitly compacts
/// still keeps a finite log (the "everything bounded" invariant).
pub fn record_local_update(
    store: &mut EngineStore,
    replay_cache: &mut ReplayBaseCache,
    key: &DocKey,
    update: &[u8],
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<AppendOutcome>, CollabError> {
    validate_update_bytes(update)?;
    let sha = crate::hex_sha256(update);

    let outcome = store.write_with(faults, |tx| -> Result<AppendOutcome, CollabError> {
        let marker = query_marker(tx, key)?.ok_or(CollabError::NoMarker)?;
        append_local_update(tx, replay_cache, key, &marker, update, &sha, now_ms)
    })?;
    if let TxnOutcome::Committed(app) = &outcome {
        if !app.deduped {
            replay_cache.advance(key, update, app.seq);
        }
    }
    self_bound_log(store, key, &outcome, faults, now_ms)?;
    Ok(outcome)
}

/// Create a marker when needed and append a locally-produced update in one
/// transaction. Validation, replay parity, blob storage, journal append, and
/// first-marker creation therefore share one rollback boundary.
#[allow(clippy::too_many_arguments)]
pub fn record_local_update_creating_marker(
    store: &mut EngineStore,
    replay_cache: &mut ReplayBaseCache,
    key: &DocKey,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<AppendOutcome>, CollabError> {
    let outcome = store.write_with(faults, |tx| -> Result<AppendOutcome, CollabError> {
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
                      head_update_seq, head_snapshot_seq, base_claimed, updated_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, ?6)",
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
                Marker {
                    content_kind,
                    regime,
                    head_update_seq: 0,
                    head_snapshot_seq: 0,
                    base_claimed: false,
                }
            }
        };
        let sha = crate::hex_sha256(update);
        append_local_update(tx, replay_cache, key, &marker, update, &sha, now_ms)
    })?;
    if let TxnOutcome::Committed(app) = &outcome {
        if !app.deduped {
            replay_cache.advance(key, update, app.seq);
        }
    }
    self_bound_log(store, key, &outcome, faults, now_ms)?;
    Ok(outcome)
}

fn append_local_update(
    conn: &Connection,
    replay_cache: &mut ReplayBaseCache,
    key: &DocKey,
    marker: &Marker,
    update: &[u8],
    sha: &str,
    now_ms: i64,
) -> Result<AppendOutcome, CollabError> {
    let base = load_for_replay_gate(conn, replay_cache, key, marker.head_update_seq)?;
    base.validate(update)?;
    if let Some(existing) = blob_seq_in_log(conn, key, sha)? {
        return Ok(AppendOutcome {
            seq: existing,
            deduped: true,
            emit_outbound: false,
        });
    }
    put_binary_blob(conn, update)?;
    let seq = append_row(conn, key, sha, None, now_ms)?;
    Ok(AppendOutcome {
        seq,
        deduped: false,
        emit_outbound: marker.regime == Regime::Replicated && marker.base_claimed,
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

/// Fold the update log into a fresh full-state snapshot once the pending count
/// reaches `threshold`, prune the folded updates and now-superseded older
/// snapshots, and advance `head_snapshot_seq`. Convergence-neutral: the snapshot
/// is a full-state re-encode, so a reconstruct from it yields the same converged
/// content as the un-compacted log. Below threshold this is a no-op.
///
/// `threshold` of 0 forces a compaction (used by replicated close).
pub fn maybe_compact(
    store: &mut EngineStore,
    key: &DocKey,
    threshold: u32,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<CompactOutcome>, CollabError> {
    let persisted = match load_persisted(store, key)? {
        Some(p) => p,
        None => return Err(CollabError::NoMarker),
    };
    let pending = persisted.marker.head_update_seq - persisted.marker.head_snapshot_seq;
    if pending < i64::from(threshold) || pending <= 0 {
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
        // Prune folded updates and now-superseded older snapshots.
        let pruned = tx
            .execute(
                "DELETE FROM ydoc_updates \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND seq <= ?4",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, up_to],
            )
            .map_err(map_sql)?;
        tx.execute(
            "DELETE FROM ydoc_snapshots \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND up_to_seq < ?4",
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
/// bytes are a full-state re-encode of the doc seeded from markdown at first
/// creation. Re-checks `base_claimed` inside the transaction so a cross-process
/// first-open race resolves to exactly one base: the loser observes the winner's
/// base and returns [`ClaimOutcome::Resumed`] (emitting no second base).
pub fn claim_base(
    store: &mut EngineStore,
    replay_cache: &mut ReplayBaseCache,
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

    let outcome = store.write_with(faults, |tx| -> Result<ClaimOutcome, CollabError> {
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
              head_update_seq, head_snapshot_seq, base_claimed, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, 'replicated', 0, 0, 0, ?5) \
             ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
               regime = 'replicated', content_kind = excluded.content_kind, \
               updated_at_ms = excluded.updated_at_ms",
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
        // second base.
        let (_, _, base_claimed) = head_of(tx, key)?;
        if base_claimed {
            return Ok(ClaimOutcome::Resumed);
        }

        let base_sha = put_binary_blob(tx, base_bytes)?;
        let sv_sha = put_binary_blob(tx, &sv_bytes)?;
        // The base IS the seq-0 snapshot. INSERT (not REPLACE): a genuine second
        // base at up_to_seq = 0 would conflict, a hard backstop under the flag.
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
            "UPDATE ydoc_docs SET base_claimed = 1, updated_at_ms = ?4 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            rusqlite::params![key.workspace_id, key.version_id, key.object_id, now_ms],
        )
        .map_err(map_sql)?;
        Ok(ClaimOutcome::Claimed {
            base_snapshot_sha: base_sha,
        })
    })?;
    replay_cache.invalidate(key);
    Ok(outcome)
}

/// Settle: project the reconstructed Y.Doc to markdown (with provenance),
/// content-address the markdown into `binary_blobs`, and enqueue a durable
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
    let projection = persisted.doc.project(persisted.marker.content_kind);
    if projection.markdown.len() > MAX_PROJECTION_BYTES {
        return Err(CollabError::UpdateTooLarge {
            actual: projection.markdown.len(),
            max: MAX_PROJECTION_BYTES,
        });
    }
    let markdown_bytes = projection.markdown.clone().into_bytes();
    let content_sha = crate::hex_sha256(&markdown_bytes);
    let sv_bytes = persisted.doc.encode_state_vector();

    store.write_with(faults, |tx| {
        // Persist the markdown + the provenance state vector as content blobs.
        put_binary_blob(tx, &markdown_bytes)?;
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
/// the bare marker (markdown-is-the-artifact).
pub fn close_session(
    store: &mut EngineStore,
    key: &DocKey,
    persist_closed_state: bool,
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
    // Local-only prune would DISCARD the CRDT cache. Refuse unless the current
    // head is already covered by a durable settle (markdown-is-the-artifact: the
    // artifact must exist before the cache is thrown away). A doc with no edits
    // (`head_update_seq == 0`) has nothing to lose and prunes freely.
    if marker.head_update_seq > 0 {
        let persisted = load_persisted(store, key)?.ok_or(CollabError::NoMarker)?;
        let content_sha = crate::hex_sha256(
            persisted
                .doc
                .project(marker.content_kind)
                .markdown
                .as_bytes(),
        );
        let last_settled = store.read_with(|conn| last_settled_sha(conn, key))?;
        if last_settled.as_deref() != Some(content_sha.as_str()) {
            return Err(CollabError::UnsettledClose);
        }
    }
    // Prune the CRDT cache to nothing, keep the marker. This mutates base
    // content and resets head_update_seq to 0 but takes no ReplayBaseCache: the
    // actor worker never drives close through a live cache, and a reset to seq 0
    // makes any stale entry (seq > 0) miss. If close is ever routed through a
    // shared cache, invalidate here (as claim_base does).
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
        tx.execute(
            "UPDATE ydoc_docs SET head_update_seq = 0, head_snapshot_seq = 0, updated_at_ms = ?4 \
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
pub(crate) fn load_for_replay_gate<'a>(
    conn: &Connection,
    replay_cache: &'a mut ReplayBaseCache,
    key: &DocKey,
    expected_seq: i64,
) -> Result<&'a CachedBase, CollabError> {
    replay_cache.get_or_reconstruct(conn, key, expected_seq)
}

pub(crate) fn reconstruct_for_replay_gate(
    conn: &Connection,
    key: &DocKey,
) -> Result<Ydoc, CollabError> {
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

pub(crate) fn query_marker(conn: &Connection, key: &DocKey) -> Result<Option<Marker>, CollabError> {
    conn.query_row(
        "SELECT content_kind, regime, head_update_seq, head_snapshot_seq, base_claimed \
         FROM ydoc_docs WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        rusqlite::params![key.workspace_id, key.version_id, key.object_id],
        |r| {
            Ok(Marker {
                content_kind: ContentKind::parse(&r.get::<_, String>(0)?),
                regime: Regime::parse(&r.get::<_, String>(1)?),
                head_update_seq: r.get(2)?,
                head_snapshot_seq: r.get(3)?,
                base_claimed: r.get::<_, i64>(4)? != 0,
            })
        },
    )
    .optional()
    .map_err(map_sql)
}

/// The sha of the content the last settle materialized (or `None` if never
/// settled) — the durable settle-handoff marker the local-only close guard reads.
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

pub(crate) fn head_of(conn: &Connection, key: &DocKey) -> Result<(i64, i64, bool), CollabError> {
    let marker = query_marker(conn, key)?.ok_or(CollabError::NoMarker)?;
    Ok((
        marker.head_update_seq,
        marker.head_snapshot_seq,
        marker.base_claimed,
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
