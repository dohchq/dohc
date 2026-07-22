use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    DocKey, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update,
    apply_remote_update_in_transaction, maybe_compact,
};
use dohc_engine_domain::{
    WriteText, enqueue_write, select_snapshot_by_path_in_tx, write_projected_text_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultInjector, Preimage, TxnOutcome};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;

use crate::{ApplyOutcome, PathClass, ReplicationEnvelope, SyncError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YdocUpdatePayload {
    version_id: String,
    object_id: String,
    path: String,
    content_kind: String,
    update_blob_sha256: String,
    #[serde(default)]
    is_base_state: bool,
}

/// Read-only lease seam used by sync apply to avoid mutating a lineage while
/// an interactive daemon session owns it.
pub trait LeaseProbe: Send + Sync {
    fn is_live(&self, key: &DocKey) -> bool;
}

/// Default probe for callers that do not own an interactive session registry.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoLiveLeases;

impl LeaseProbe for NoLiveLeases {
    fn is_live(&self, _key: &DocKey) -> bool {
        false
    }
}

impl LeaseProbe for dohc_engine_collab::LeaseRegistry {
    fn is_live(&self, key: &DocKey) -> bool {
        self.is_held(key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocApplyResult {
    pub deferred: bool,
    pub reason: Option<&'static str>,
}

/// Drain acked Y.Doc envelopes deferred while `key` was leased. The
/// `ydoc_deferred_updates` table records exactly which coordinates are
/// pending (written in the same transaction as their ack); the imported
/// replication log keeps the payloads. Only those rows replay — never the
/// whole history, which after compaction would re-append non-dedupable
/// updates and cost O(history) per open. Each drained coordinate's marker
/// row is removed after a successful apply/dedup.
pub fn drain_deferred_ydoc_for_key(
    store: &mut EngineStore,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<usize, SyncError> {
    let pending: Vec<(String, i64, i64, YdocUpdatePayload)> = store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT log.origin_id, log.origin_seq, log.recorded_at_ms, log.payload_json \
                 FROM ydoc_deferred_updates AS deferred \
                 JOIN replication_log AS log \
                   ON log.workspace_id = deferred.workspace_id \
                  AND log.origin_id = deferred.origin_id \
                  AND log.origin_seq = deferred.origin_seq \
                 WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2 \
                   AND deferred.object_id = ?3 AND log.op_kind = 'ydoc.update' \
                 ORDER BY log.recorded_at_ms, log.origin_id, log.origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map(
                params![key.workspace_id, key.version_id, key.object_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(SyncError::corrupt)?;
        let mut pending = Vec::new();
        for row in rows {
            let (origin_id, origin_seq, recorded_at_ms, payload_json) =
                row.map_err(SyncError::corrupt)?;
            let payload =
                serde_json::from_str::<YdocUpdatePayload>(&payload_json).map_err(|_| {
                    SyncError::InvalidInput {
                        reason: "parked ydoc.update payload is malformed",
                    }
                })?;
            pending.push((origin_id, origin_seq, recorded_at_ms, payload));
        }
        Ok::<_, SyncError>(pending)
    })?;
    let mut applied = 0usize;
    let mut last_payload: Option<YdocUpdatePayload> = None;
    let mut payload_recorded_at = 0_i64;
    for (origin_id, origin_seq, recorded_at_ms, payload) in pending {
        let bytes = store
            .get_binary_blob(&payload.update_blob_sha256)?
            .ok_or(SyncError::BlobInvalid)?;
        if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        match apply_remote_update(
            store,
            key,
            &RemoteUpdate {
                origin_id: origin_id.clone(),
                origin_seq,
                bytes,
            },
            faults,
            recorded_at_ms,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "parked ydoc.update could not be applied",
        })? {
            TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. }) => {
                applied += 1;
                payload_recorded_at = recorded_at_ms;
                last_payload = Some(payload);
            }
            TxnOutcome::Committed(ReplicationApplyOutcome::Deduped { .. }) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
        let cleared = store.write_with(faults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![key.workspace_id, origin_id, origin_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })?;
        // A crash seam firing on this delete must surface like the
        // preceding remote-apply transaction's — reporting the drain as
        // successful would let settle/close proceed as if the pending row
        // were durably handled.
        if matches!(cleared, TxnOutcome::Crashed { .. }) {
            return Err(SyncError::FaultCrash);
        }
    }
    // Drained content must reach the VISIBLE head here, not only the CRDT
    // log: the drain runs outside `apply_envelope_with`, so a redelivery of
    // an already-acked coordinate skips its mutation closure — if the drain
    // did not project, the snapshot/materialization would stay stale until
    // some unrelated open/settle. Same idempotent-by-sha write as the pull
    // path; skipped while cross-origin dependencies are still pending.
    if applied > 0
        && let Some(payload) = last_payload
        && let Some(persisted) =
            dohc_engine_collab::load_persisted(store, key).map_err(|_| SyncError::InvalidInput {
                reason: "ydoc lineage load failed",
            })?
        && !persisted.doc.has_pending_dependencies()
    {
        let projected = store.write_with(faults, |tx| {
            project_and_write_in_tx(
                tx,
                key,
                &payload.path,
                &persisted.doc,
                persisted.marker.content_kind,
                "deferred-drain",
                payload_recorded_at,
                payload_recorded_at,
            )
        })?;
        if matches!(projected, TxnOutcome::Crashed { .. }) {
            return Err(SyncError::FaultCrash);
        }
    }
    Ok(applied)
}

/// Oracle parity for applied `ydoc.update` ops (`projectYDocUpdate` →
/// `writeTextFileInDb` → CRDT rows): every NON-DEFERRED apply materializes
/// its projection — moment, snapshot, and durable materialization job — in
/// the SAME admission transaction, so `versionedText.read`, search, and the
/// disk pipeline advance with the relay cursor instead of trailing it until
/// someone manually opens and settles the doc.
#[allow(clippy::too_many_arguments)]
pub fn project_and_write_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    doc: &dohc_engine_collab::Ydoc,
    content_kind: dohc_engine_collab::ContentKind,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
) -> Result<(), SyncError> {
    let projection = doc.project(content_kind);
    let current = select_snapshot_by_path_in_tx(tx, &key.workspace_id, &key.version_id, path)
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update head read failed",
        })?;
    // Identity pins (the oracle's fix-2): NEVER write through a path
    // occupied by a different object, and never project an object into a
    // path it does not own — a hostile op would otherwise mutate the wrong
    // plaintext file.
    if current.binary_sha256.is_some() {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update targets a binary head",
        });
    }
    if let Some(snapshot) = current.snapshot.as_ref()
        && snapshot.object_id != key.object_id
    {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update path is occupied by another object",
        });
    }
    let other_alias: Option<String> = tx
        .query_row(
            "SELECT path FROM path_aliases              WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 AND path != ?4",
            params![key.workspace_id, key.version_id, key.object_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if other_alias.is_some() {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update object already occupies another path",
        });
    }
    // Idempotent skip: a redelivered (or content-converged) envelope whose
    // projection already IS the head mints no duplicate moment/job — but the
    // MARKER still advances: the head may have reached these bytes via
    // capture/local write while last_settled_sha points at an older settle,
    // and leaving it stale would wedge the next settle in
    // ConflictStaleTarget over a converged doc.
    let projected_sha = dohc_engine_storage::hex_sha256(projection.markdown.as_bytes());
    if let Some(snapshot) = current
        .snapshot
        .as_ref()
        .filter(|snapshot| snapshot.blob_sha256 == projected_sha)
    {
        tx.execute(
            "UPDATE ydoc_docs SET last_settled_sha = ?4, updated_at_ms = ?5              WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                snapshot.blob_sha256,
                now_ms,
            ],
        )
        .map_err(SyncError::persist)?;
        return Ok(());
    }
    let preimage = current
        .snapshot
        .as_ref()
        .map_or(Preimage::Absent, |snapshot| {
            Preimage::Present(snapshot.blob_sha256.clone())
        });
    // Deterministic per-envelope moment id: a crash between commit and
    // cursor advance redelivers the envelope, whose re-apply lands in the
    // idempotent skip above (same projection) — the id can never collide.
    let fingerprint = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        key.workspace_id, key.version_id, key.object_id, path, origin_id, origin_seq
    );
    let moment_id = format!(
        "moment-ydoc-apply-{}",
        dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
    );
    let result = write_projected_text_in_tx(
        tx,
        &WriteText {
            workspace_id: key.workspace_id.clone(),
            version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            path: path.to_owned(),
            text: projection.markdown.clone(),
            moment_id,
            metadata_origin: "ydoc".to_owned(),
            author_json: None,
            now_ms,
            request_id: None,
        },
    )
    .map_err(|_| SyncError::InvalidInput {
        reason: "ydoc.update projection write failed",
    })?;
    enqueue_write(tx, &result, preimage, "ydoc").map_err(|_| SyncError::InvalidInput {
        reason: "ydoc.update materialization enqueue failed",
    })?;
    // The pulled projection IS the settled artifact (its job materializes
    // it): advance the marker exactly like a local settle would. Leaving the
    // OLD locally-settled sha behind would make the next session's settle
    // expectation trail the remote head — permanent ConflictStaleTarget.
    tx.execute(
        "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6          WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            result.moment.moment_order,
            projected_sha,
            now_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub fn apply_ydoc_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Err(SyncError::UnsupportedOperation);
    }
    let payload: YdocUpdatePayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update payload is malformed",
        })?;
    if crate::classify_share_path(&payload.path) != PathClass::Tracked
        || !matches!(payload.content_kind.as_str(), "plaintext" | "richdoc")
    {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update path or content kind is invalid",
        });
    }
    let key = DocKey::new(
        envelope.workspace_id.clone(),
        payload.version_id,
        payload.object_id,
    )
    .map_err(|_| SyncError::InvalidInput {
        reason: "ydoc.update coordinates are invalid",
    })?;
    // The blob is validated BEFORE any ack path — including the live-lease
    // defer. A defer acks the coordinate with the imported log as the durable
    // queue; if the referenced blob were missing or tampered, the peer cursor
    // would already be past a row the drain can never apply, and the bad
    // coordinate cannot be re-fetched. Missing/corrupt blob leaves the
    // coordinate unacked instead.
    let bytes: Vec<u8> = store.read_with(|conn| {
        conn.query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&payload.update_blob_sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::BlobInvalid)
    })?;
    if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
        return Err(SyncError::BlobInvalid);
    }
    if leases.is_live(&key) {
        // FULL durable validation BEFORE the ack: byte caps, abort-safe
        // prevalidation, AND the replay-parity gate — replayed on top of the
        // ALREADY-QUEUED deferred predecessors, because a later update can
        // only become invalid after they apply, and the drain will apply
        // them first. Anything the drain would refuse must stay unacked.
        let queued: Vec<Vec<u8>> = {
            let mut queued = Vec::new();
            let rows: Vec<String> = store.read_with(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT log.payload_json                          FROM ydoc_deferred_updates AS deferred                          JOIN replication_log AS log                            ON log.workspace_id = deferred.workspace_id                           AND log.origin_id = deferred.origin_id                           AND log.origin_seq = deferred.origin_seq                          WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2                            AND deferred.object_id = ?3                          ORDER BY log.recorded_at_ms, log.origin_id, log.origin_seq",
                    )
                    .map_err(SyncError::corrupt)?;
                let mapped = stmt
                    .query_map(
                        params![key.workspace_id, key.version_id, key.object_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(SyncError::corrupt)?;
                mapped
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(SyncError::corrupt)
            })?;
            for payload_json in rows {
                let queued_payload = serde_json::from_str::<YdocUpdatePayload>(&payload_json)
                    .map_err(|_| SyncError::InvalidInput {
                        reason: "parked ydoc.update payload is malformed",
                    })?;
                let queued_bytes = store
                    .get_binary_blob(&queued_payload.update_blob_sha256)?
                    .ok_or(SyncError::BlobInvalid)?;
                queued.push(queued_bytes);
            }
            queued
        };
        dohc_engine_collab::validate_remote_update_with_pending(store, &key, &queued, &bytes)
            .map_err(|_| SyncError::InvalidInput {
                reason: "ydoc.update bytes fail durable validation",
            })?;
        // A deferred coordinate is ACKED — it must be drainable later, which
        // the close/open drains only do for REPLICATED markers. A live lease
        // over an absent or local-only lineage cannot accept a remote update
        // now or later: refuse (leaving the coordinate unacked) exactly like
        // the non-live path's NoMarker/regime refusal would.
        let marker =
            dohc_engine_collab::read_marker(store, &key).map_err(|_| SyncError::InvalidInput {
                reason: "ydoc marker read failed",
            })?;
        if !marker.is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated) {
            return Err(SyncError::InvalidInput {
                reason: "live lease on a non-replicated lineage",
            });
        }
        let deferred_key = key.clone();
        return crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
            // Record WHICH coordinate is pending in the same transaction as
            // the ack: drains replay exactly these rows, never the whole
            // imported history (which after compaction would re-append
            // non-dedupable updates and cost O(history) per open).
            tx.execute(
                "INSERT OR IGNORE INTO ydoc_deferred_updates                  (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms)                  VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    deferred_key.workspace_id,
                    deferred_key.version_id,
                    deferred_key.object_id,
                    op.origin_id,
                    op.origin_seq,
                    op.recorded_at_ms,
                ],
            )
            .map_err(SyncError::persist)?;
            Ok(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-session-live"),
            })
        });
    }
    // Base bootstrap: a fresh replica's FIRST op for a replicated doc is the
    // base full-state — apply_remote_update requires an existing marker, so
    // without this branch the pull wedges on NoMarker before the ack. The
    // claim is idempotent (an existing claimed base resumes), so a crash
    // between claim and ack replays safely; the coordinate then acks below.
    if payload.is_base_state {
        // The claim runs INSIDE the admission transaction: a standalone claim
        // before apply_envelope_with would persist the marker/base for an
        // envelope the sequence/divergence checks then reject (out-of-order
        // or divergent redelivery), leaving state for an unacked coordinate.
        let kind = dohc_engine_collab::ContentKind::parse(&payload.content_kind);
        let sv_bytes = {
            let doc = dohc_engine_collab::Ydoc::wire();
            doc.apply(&bytes).map_err(|_| SyncError::InvalidInput {
                reason: "ydoc.update base bytes fail validation",
            })?;
            doc.encode_state_vector()
        };
        let claim_key = key.clone();
        let claim_bytes = bytes.clone();
        // The claim can PROMOTE a local-only lineage that already holds
        // update rows (a crash left them behind): the projection must be the
        // reconstructed lineage PLUS the base, or the visible snapshot would
        // drop local content that is still durably part of the CRDT.
        let base_doc = {
            let doc = match dohc_engine_collab::load_persisted(store, &key).map_err(|_| {
                SyncError::InvalidInput {
                    reason: "ydoc lineage load failed",
                }
            })? {
                Some(persisted) => persisted.doc,
                None => dohc_engine_collab::Ydoc::wire(),
            };
            doc.apply(&claim_bytes)
                .map_err(|_| SyncError::InvalidInput {
                    reason: "ydoc.update base bytes fail validation",
                })?;
            doc
        };
        let base_path = payload.path.clone();
        let outcome = crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES (?1, ?2, ?3)",
                rusqlite::params![claim_key.workspace_id, claim_key.object_id, op.recorded_at_ms],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_collab::claim_base_in_tx(
                tx,
                &claim_key,
                kind,
                &claim_bytes,
                &sv_bytes,
                op.recorded_at_ms,
            )
            .map_err(|_| SyncError::InvalidInput {
                reason: "ydoc.update base could not be claimed",
            })?;
            // A fresh base-only replica gets its FILE, not just CRDT rows.
            project_and_write_in_tx(
                tx,
                &claim_key,
                &base_path,
                &base_doc,
                kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
            )?;
            Ok(YdocApplyResult {
                deferred: false,
                reason: None,
            })
        })?;
        return Ok(outcome);
    }
    // The lease is NOT live: any coordinates parked by an earlier live
    // phase drain FIRST, so the projection below reconstructs the COMPLETE
    // applied lineage (a partial projection would materialize a file missing
    // parked content).
    if dohc_engine_collab::read_marker(store, &key)
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc marker read failed",
        })?
        .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
    {
        drain_deferred_ydoc_for_key(store, &key, faults)?;
    }
    // Reconstruct the post-apply doc OUTSIDE the admission tx (commutative:
    // the in-tx apply of the same bytes yields the same converged state, and
    // a dedup changes nothing).
    let projected_doc = {
        let persisted = dohc_engine_collab::load_persisted(store, &key)
            .map_err(|_| SyncError::InvalidInput {
                reason: "ydoc lineage load failed",
            })?
            .ok_or(SyncError::InvalidInput {
                reason: "ydoc.update targets an absent lineage",
            })?;
        persisted
            .doc
            .apply(&bytes)
            .map_err(|_| SyncError::InvalidInput {
                reason: "ydoc.update bytes fail durable validation",
            })?;
        persisted
    };
    let update_path = payload.path.clone();
    let update_kind = projected_doc.marker.content_kind;
    let remote = RemoteUpdate {
        origin_id: envelope.origin_id.clone(),
        origin_seq: envelope.origin_seq,
        bytes,
    };
    let outcome = crate::apply_envelope_with(store, envelope, faults, |tx, op| {
        let applied = apply_remote_update_in_transaction(tx, &key, &remote, op.recorded_at_ms)
            .map_err(|_| SyncError::InvalidInput {
                reason: "ydoc.update could not be applied",
            })?;
        // An out-of-order cross-origin update parks durably with missing
        // dependencies; a projection taken NOW would omit the pending remote
        // content and materialize an incomplete view. Skip — the envelope
        // that completes the dependency projects the full doc.
        if !projected_doc.doc.has_pending_dependencies() {
            project_and_write_in_tx(
                tx,
                &key,
                &update_path,
                &projected_doc.doc,
                update_kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
            )?;
        }
        Ok(applied)
    })?;
    if matches!(
        outcome,
        ApplyOutcome::Applied(ReplicationApplyOutcome::Applied { .. })
    ) {
        maybe_compact(
            store,
            &key,
            DEFAULT_COMPACTION_THRESHOLD,
            faults,
            envelope.recorded_at_ms,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update compaction failed",
        })?;
    }
    Ok(match outcome {
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: None,
        }),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
    })
}
