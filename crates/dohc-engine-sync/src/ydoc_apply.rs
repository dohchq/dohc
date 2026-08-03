use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    CollabError, DocKey, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update,
    apply_remote_update_in_transaction, maybe_compact,
};
use dohc_engine_domain::{
    ConflictFileState, DomainError, WriteText, enqueue_write, select_snapshot_by_path_in_tx,
    write_projected_text_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultInjector, Preimage, StorageError, TxnOutcome};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;

use dohc_engine_files::{
    PathClassification, classify_engine_file_path_normalized, search_policy::SearchPolicySnapshot,
};

use crate::error::local_corruption;
use crate::file_search::{search_policy_for_store, upsert_file_search_index};
use crate::{ApplyOutcome, ReplicationEnvelope, SyncError};

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

/// Direct-applier diagnostic result. A deferred update needs no caller action:
/// its coordinate is durably parked with the ack and is replayed by
/// [`drain_deferred_ydoc_for_key`] on lease teardown/open or before the next
/// non-leased update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocApplyResult {
    pub deferred: bool,
    pub reason: Option<&'static str>,
    /// Sync conflicts this envelope opened (the first-base-over-divergent-head
    /// branch). Counted like the moment lane so the pull pass reports it.
    pub conflicts_opened: i64,
    /// True when this apply rewrote or appended OUTBOUND journal rows (a lost
    /// origination race adopted the winner and republished local content).
    /// The pull surfaces this so the desktop schedules a push — nothing else
    /// will: sync materialization suppresses watcher events, and a pass
    /// pushes before it pulls.
    pub pending_push: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct YdocDrainResult {
    pub drained: usize,
    pub refusals: Vec<crate::ReplicationRefusal>,
    /// The drain's dependency-resolution retrigger journaled a base: the
    /// pull must surface it as a pending push, exactly like the append,
    /// cursor, and settlement edges.
    pub originated: bool,
}

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Ok(Vec::new());
    }
    let payload: YdocUpdatePayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update payload is malformed",
        })?;
    let fingerprint = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        envelope.workspace_id,
        payload.version_id,
        payload.object_id,
        payload.path,
        envelope.origin_id,
        envelope.origin_seq
    );
    let job_id = format!(
        "ydoc-mat_moment-ydoc-apply-{}",
        dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
    );
    let change = store.read_with(|conn| {
        conn.query_row(
            "SELECT target_path, operation FROM materialization_jobs WHERE job_id=?1",
            [&job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })?;
    let Some((path, operation)) = change else {
        return Ok(Vec::new());
    };
    let operation = match operation.as_str() {
        "write" => "write",
        "delete" => "delete",
        _ => {
            return Err(SyncError::InvalidInput {
                reason: "ydoc materialization operation is invalid",
            });
        }
    };
    Ok(vec![crate::MomentMaterializationChange {
        path,
        operation,
        content_kind: "text",
    }])
}

/// Recount the conflicts a redelivered `ydoc.update` base opened, keyed by
/// the deterministic incoming-side moment id (moment-lane parity: a crash
/// between commit and cursor advance redelivers the envelope as a skip, and
/// the caller still reports the conflict it opened).
pub(crate) fn redelivered_conflicts_opened(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<i64, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Ok(0);
    }
    let payload: YdocUpdatePayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update payload is malformed",
        })?;
    if !payload.is_base_state {
        return Ok(0);
    }
    let Ok(key) = DocKey::new(
        envelope.workspace_id.clone(),
        payload.version_id,
        payload.object_id,
    ) else {
        return Ok(0);
    };
    let _ = key;
    let recorded: Option<String> = store.read_with(|conn| {
        conn.query_row(
            "SELECT payload_hash FROM engine_requests \
             WHERE request_id=?1 AND kind='sync-ydoc-conflict'",
            [ydoc_conflict_decision_id(envelope)],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })?;
    match recorded {
        Some(count) => count.parse::<i64>().map_err(|_| SyncError::InvalidInput {
            reason: "recorded ydoc conflict count is invalid",
        }),
        None => Ok(0),
    }
}

/// The immutable per-envelope decision id for the conflicts a base opened
/// (crash-redelivery recount). The CONFLICT row itself is mutable — a later
/// delta coalesces it and rewrites its incoming anchor — so the recount must
/// never depend on it.
fn ydoc_conflict_decision_id(envelope: &ReplicationEnvelope) -> String {
    let coordinate = format!(
        "{}\0{}\0{}",
        envelope.workspace_id, envelope.origin_id, envelope.origin_seq
    );
    format!(
        "sync-ydoc-conflict:{}",
        dohc_engine_storage::hex_sha256(coordinate.as_bytes())
    )
}

fn record_ydoc_conflicts_opened(
    tx: &rusqlite::Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflicts_opened: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO engine_requests \
         (request_id,payload_hash,result_seq,committed_at,kind) \
         VALUES (?1,?2,?3,?4,'sync-ydoc-conflict')",
        params![
            ydoc_conflict_decision_id(envelope),
            conflicts_opened.to_string(),
            envelope.origin_seq,
            envelope.recorded_at_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Drain acked Y.Doc envelopes deferred while `key` was leased. The
/// `ydoc_deferred_updates` table records exactly which coordinates are
/// pending (written in the same transaction as their ack); the imported
/// replication log keeps the payloads. Only those rows replay — never the
/// whole history, which after compaction would re-append non-dedupable
/// updates and cost O(history) per open. Each drained coordinate's marker
/// row is removed after a successful apply/dedup. Terminal payload refusals
/// are returned as well as persisted so the triggering caller can report them.
pub fn drain_deferred_ydoc_for_key(
    store: &mut EngineStore,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
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
            let payload = serde_json::from_str::<YdocUpdatePayload>(&payload_json)
                .map_err(|_| local_corruption("parked ydoc.update payload is malformed"))?;
            pending.push((origin_id, origin_seq, recorded_at_ms, payload));
        }
        Ok::<_, SyncError>(pending)
    })?;
    if pending.is_empty() {
        return Ok(YdocDrainResult::default());
    }
    let search_policy = search_policy_for_store(store);
    let mut applied = 0usize;
    let mut refusals = Vec::new();
    let mut last_payload: Option<YdocUpdatePayload> = None;
    let mut payload_recorded_at = 0_i64;
    let mut drained_coordinates: Vec<(String, i64)> = Vec::new();
    let mut last_coordinate: Option<(String, i64)> = None;
    for (origin_id, origin_seq, recorded_at_ms, payload) in pending {
        let established_kind = dohc_engine_collab::read_marker(store, key)
            .map_err(map_collab_hard_error)?
            .map(|marker| marker.content_kind);
        let content_kind_refusal = established_kind
            .is_some_and(|kind| {
                kind != dohc_engine_collab::ContentKind::parse(&payload.content_kind)
            })
            .then_some("ydoc.update content kind does not match the established lineage");
        // Once the base arrives it establishes the authoritative path. A
        // queued payload naming another path is still refused, but its valid
        // CRDT bytes must enter the lineage first so descendants do not retain
        // an impossible missing-client-clock dependency.
        let identity_refusal =
            match store.read_with(|conn| validate_ydoc_identity(conn, key, &payload.path)) {
                Ok(_) => None,
                Err(SyncError::InvalidInput { reason }) => Some(reason),
                Err(hard) => return Err(hard),
            };
        let bytes = store
            .get_binary_blob(&payload.update_blob_sha256)?
            .ok_or(SyncError::BlobInvalid)?;
        if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        let outcome = match apply_remote_update(
            store,
            key,
            &RemoteUpdate {
                origin_id: origin_id.clone(),
                origin_seq,
                bytes,
            },
            faults,
            recorded_at_ms,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                match map_collab_payload_error(error, "parked ydoc.update could not be applied") {
                    SyncError::InvalidInput { reason } => {
                        refusals.push(refuse_deferred_ydoc(
                            store, key, &origin_id, origin_seq, reason, faults,
                        )?);
                        continue;
                    }
                    hard => return Err(hard),
                }
            }
        };
        match outcome {
            TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. }) => applied += 1,
            TxnOutcome::Committed(ReplicationApplyOutcome::Deduped { .. }) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
        if let Some(reason) = content_kind_refusal.or(identity_refusal) {
            // The CRDT bytes landed even though the established path identity
            // forbids projection. Count the coordinate as drained before its
            // already-ACKed queue row is converted into a refusal: a live
            // client's doc has not integrated these bytes, so settle must
            // force a resync instead of materializing unseen remote content.
            drained_coordinates.push((origin_id.clone(), origin_seq));
            refusals.push(refuse_deferred_ydoc(
                store, key, &origin_id, origin_seq, reason, faults,
            )?);
            continue;
        }
        // The payload tracks for DEDUPED rows too: a crash between an
        // earlier drain's apply and its marker delete redelivers the row as
        // a dedupe, and the projection below must still run or the visible
        // head stays behind the already-applied CRDT forever.
        payload_recorded_at = recorded_at_ms;
        last_payload = Some(payload);
        last_coordinate = Some((origin_id.clone(), origin_seq));
        drained_coordinates.push((origin_id, origin_seq));
    }
    // Drained content must reach the VISIBLE head here, not only the CRDT
    // log: the drain runs outside `apply_envelope_with`, so a redelivery of
    // an already-acked coordinate skips its mutation closure — if the drain
    // did not project, the snapshot/materialization would stay stale until
    // some unrelated open/settle. Same idempotent-by-sha write as the pull
    // path; skipped while cross-origin dependencies are still pending.
    let (drain_origin, drain_seq) = match &last_coordinate {
        Some((origin, seq)) => (origin.as_str(), *seq),
        None => ("deferred-drain", payload_recorded_at),
    };
    let mut originate_path = None;
    if let Some(payload) = last_payload
        && let Some(persisted) =
            dohc_engine_collab::load_persisted(store, key).map_err(map_collab_hard_error)?
        && !persisted.doc.has_pending_dependencies()
    {
        let projected = store.write_with(faults, |tx| {
            project_and_write_in_tx(
                tx,
                key,
                &payload.path,
                &persisted.doc,
                persisted.marker.content_kind,
                // The REAL last drained coordinate keys the moment id: a
                // synthetic (origin, recorded_at_ms) pair collides when two
                // drain batches land updates in the same millisecond, and
                // the duplicate id wedges the projection write.
                drain_origin,
                drain_seq,
                payload_recorded_at,
                search_policy.as_ref(),
            )
        });
        match projected {
            // Origination is owed only for a path the projection ACCEPTED
            // (#548 review): a refused identity below consumes the marker
            // without promoting — a stale or hostile path must never claim
            // and journal a base.
            Ok(TxnOutcome::Committed(())) => originate_path = Some(payload.path.clone()),
            Ok(TxnOutcome::Crashed { .. }) => return Err(SyncError::FaultCrash),
            // These rows are already ACKed and therefore cannot be retried
            // from the relay. If an identity pin now blocks projection,
            // retaining the marker would wedge every later drain. The CRDT
            // content is durable above; the visible path legitimately remains
            // governed by its current owner, so consume the marker.
            Err(SyncError::InvalidInput { .. }) => {}
            // Anything else (storage) is retryable: keep the markers so the
            // next drain retries the projection.
            Err(other) => return Err(other),
        }
    }
    // The durable markers clear LAST — after the projection committed. A
    // crash anywhere above leaves the rows in place, and the retry re-runs
    // apply (content-deduped) AND the projection; deleting first opened a
    // window where the CRDT held the edit but nothing would ever project it.
    let cleared = store.write_with(faults, |tx| {
        for (origin_id, origin_seq) in &drained_coordinates {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![key.workspace_id, origin_id, origin_seq],
            )
            .map_err(SyncError::persist)?;
        }
        // This drain may have just resolved the dependency that made an
        // earlier origination decline (#548): ask again in the SAME
        // transaction that clears the markers. The base-claimed and
        // workspace-replication gates live inside, so a claimed or private
        // lineage is a cheap no-op.
        if let Some(path) = &originate_path {
            return Ok(crate::ydoc_originate::originate_ydoc_base_in_tx(
                tx,
                key,
                path,
                payload_recorded_at,
            )?
            .is_some());
        }
        Ok::<_, SyncError>(false)
    })?;
    let originated = match cleared {
        TxnOutcome::Committed(originated) => originated,
        TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
    };
    // The count is DRAINED COORDINATES, not newly-applied rows: a marker
    // surviving an earlier failed drain redelivers its row as a dedupe, and
    // callers (the settle's remote-updates-pending refusal) must still see
    // that remote content landed which the live client has not resynced.
    let _ = applied;
    Ok(YdocDrainResult {
        drained: drained_coordinates.len(),
        refusals,
        originated,
    })
}

/// Permanently dispose one already-ACKed deferred coordinate once the eventual
/// base proves its bytes payload-invalid. The refusal record and queue delete
/// share a transaction: a crash leaves the marker retryable, while a commit
/// guarantees this coordinate can never wedge later valid updates.
fn refuse_deferred_ydoc(
    store: &mut EngineStore,
    key: &DocKey,
    origin_id: &str,
    origin_seq: i64,
    reason: &'static str,
    faults: &dyn FaultInjector,
) -> Result<crate::ReplicationRefusal, SyncError> {
    let refusal = crate::ReplicationRefusal {
        workspace_id: key.workspace_id.clone(),
        origin_id: origin_id.to_owned(),
        origin_seq,
        op_kind: "ydoc.update".to_owned(),
        reason: crate::RefusalReason::InvalidInput {
            reason: reason.to_owned(),
        },
    };
    match store.write_with(faults, |tx| {
        crate::apply::persist_refusal(tx, &refusal)?;
        tx.execute(
            "DELETE FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![key.workspace_id, origin_id, origin_seq],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })? {
        TxnOutcome::Committed(()) => Ok(refusal),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// The deterministic per-envelope moment id the projection mints. Also the
/// incoming-side anchor of a base-divergence conflict, so a crash-redelivery
/// can recount the conflict it opened.
fn ydoc_apply_moment_id(key: &DocKey, path: &str, origin_id: &str, origin_seq: i64) -> String {
    let fingerprint = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        key.workspace_id, key.version_id, key.object_id, path, origin_id, origin_seq
    );
    format!(
        "moment-ydoc-apply-{}",
        dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
    )
}

/// The open sync conflict currently anchored on this object, if any. The
/// daemon's settle freeze reads the same probe the projection guard uses, so
/// the two cannot disagree about whether the head is under review.
pub fn open_sync_conflict_for_object(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT conflict_id FROM conflicts \
         WHERE workspace_id=?1 AND status='open' AND metadata_origin='sync' \
           AND target_version_id=?2 AND incoming_object_id=?3 \
         ORDER BY created_at_ms, conflict_id LIMIT 1",
        params![workspace_id, version_id, object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn open_sync_conflict_id(
    conn: &rusqlite::Connection,
    key: &DocKey,
) -> Result<Option<String>, SyncError> {
    open_sync_conflict_for_object(conn, &key.workspace_id, &key.version_id, &key.object_id)
}

/// Fold a conflict resolution's chosen text into the object's canonical
/// Y.Doc, inside the resolution's own transaction.
///
/// The invariant, stated once: an OPEN sync conflict on a Y.Doc object
/// freezes the visible head (`project_and_write_in_tx` coalesces the
/// conflict's incoming side instead of writing) and the settle (the daemon
/// refuses with `ydoc-conflict-open`, the same shape as #338's refusal of
/// the clobbering settle). RESOLUTION lifts the freeze by making the choice
/// durable here — one update that rewrites the lineage's projection to the
/// chosen bytes, journaled when the workspace replicates — in the SAME
/// transaction that closes the row, so the next inbound delta merges with
/// the choice instead of silently reversing it.
///
/// A non-Y.Doc object, an unclaimed lineage (local-only cache; the file is
/// canonical and reseeds it), and a projection that already equals the
/// choice are all no-ops.
pub fn fold_resolution_into_ydoc_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    chosen_text: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "conflict resolution coordinates are invalid",
        })?;
    // Acked-but-parked remote updates for this object were never part of
    // EITHER reviewed side, and the drain that lands them runs after the
    // review gate would have closed. Refuse the resolution while they are
    // queued: a resync or session close drains them, the open conflict
    // coalesces to the freshest incoming state, and the user resolves what
    // they can actually see.
    let deferred: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if deferred {
        return Err(SyncError::InvalidInput {
            reason: "ydoc-deferred-updates-pending",
        });
    }
    let Some(marker) =
        dohc_engine_collab::read_marker_in_tx(tx, &key).map_err(map_collab_hard_error)?
    else {
        return Ok(());
    };
    if !marker.base_claimed {
        return Ok(());
    }
    let doc = dohc_engine_collab::load_doc_in_tx(tx, &key).map_err(map_collab_hard_error)?;
    let projection = doc
        .project(marker.content_kind)
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc projection exceeds materialization cap",
        })?;
    if projection.markdown != chosen_text {
        let update = doc.rewrite_content_to_markdown(marker.content_kind, chosen_text);
        if update.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(SyncError::BlobTooLarge {
                constraint: "MAX_YDOC_UPDATE_BYTES (conflict resolution fold)",
                limit_bytes: dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
                observed_bytes: update.len(),
            });
        }
        let outcome = dohc_engine_collab::record_update_in_tx(tx, &key, &update, now_ms).map_err(
            |error| {
                map_collab_payload_error(error, "conflict resolution fold could not be appended")
            },
        )?;
        // Journal only when this workspace actually replicates: a receiver
        // that never enrolled has no sync identity, and its choice needs no
        // peer. `emit_outbound` alone cannot gate this — a claimed lineage
        // exists on identity-less receivers too.
        if !outcome.deduped
            && crate::journal::workspace_replicates_with_relay_in_tx(tx, workspace_id)?
        {
            crate::journal::journal_local_op_in_tx(
                tx,
                workspace_id,
                "ydoc.update",
                &serde_json::json!({
                    "versionId": key.version_id,
                    "objectId": key.object_id,
                    "path": path,
                    "contentKind": marker.content_kind.as_str(),
                    "updateBlobSha256": dohc_engine_storage::hex_sha256(&update),
                    "isBaseState": false,
                }),
                now_ms,
            )?;
        }
    }
    // The resolution's head IS the settled artifact now: align the settle
    // expectation so the next session does not refuse ConflictStaleTarget
    // over the very state the user just chose.
    tx.execute(
        "UPDATE ydoc_docs SET last_settled_sha=?4, updated_at_ms=?5 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            dohc_engine_storage::hex_sha256(chosen_text.as_bytes()),
            now_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// The sha of the seq-0 base snapshot this lineage claimed, if it still
/// exists (compaction legitimately folds it away).
fn stored_seq0_base_sha(
    conn: &rusqlite::Connection,
    key: &DocKey,
) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT snapshot_blob_sha256 FROM ydoc_snapshots \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

/// This machine's own refused Y.Doc base obligation for `key`, if one sits
/// unpushed in the journal: `(origin_id, origin_seq, base sha)`.
///
/// This is the durable trace of a lost origination race that survives
/// compaction: the seq-0 snapshot can legitimately fold away, but the
/// journal row the relay refused cannot leave the outbox on its own.
fn own_unpushed_base_row(
    conn: &rusqlite::Connection,
    key: &DocKey,
) -> Result<Option<(String, i64, String)>, SyncError> {
    let origin: Option<String> = conn
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id = ?1",
            [key.workspace_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(origin) = origin else {
        return Ok(None);
    };
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT origin_seq, json_extract(payload_json,'$.updateBlobSha256') \
             FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2 AND op_kind='ydoc.update' AND imported=0 \
               AND json_extract(payload_json,'$.versionId')=?3 \
               AND json_extract(payload_json,'$.objectId')=?4 \
               AND json_extract(payload_json,'$.isBaseState')=1 \
               AND origin_seq > COALESCE((SELECT pushed_seq FROM sync_relay_push_state \
                                          WHERE workspace_id=?1 AND origin_id=?2), -1) \
             ORDER BY origin_seq LIMIT 1",
            params![key.workspace_id, origin, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(row.map(|(seq, sha)| (origin, seq, sha)))
}

/// What one adoption did, for the caller's projection and outcome decisions.
struct AdoptionOutcome {
    /// Journal rows rewritten or appended — the pull surfaces this so the
    /// desktop schedules a push (nothing else will: sync materialization
    /// suppresses watcher events, and a pass pushes before it pulls).
    republished: usize,
    /// The losing lineage held a DIFFERENT content kind than the winner's
    /// base. The lineage now carries the winner's kind (the relay-arbitrated
    /// one) and the caller must open a review conflict instead of projecting
    /// over the loser's visible head.
    cross_kind: bool,
}

/// Adopt a peer's base over this machine's divergent claimed lineage (#547).
///
/// THE OBLIGATION INVARIANT: a base the relay refused is a durable
/// obligation. Adoption must either fulfil it — replace the refused journal
/// row, keep every local row (integrated OR still pending on a missing
/// dependency) republishable, and surface the rewritten rows so a push gets
/// scheduled — or leave the coordinate UNACKED so the obligation stays
/// claimable. It must never ack the winner while the obligation silently
/// rots in the outbox.
///
/// The swap keeps the losing lineage's persisted pieces VERBATIM: the
/// winner's base becomes the seq-0 snapshot, and the loser's latest snapshot
/// plus every update row after it — including rows parked on a missing
/// dependency — are re-appended on top and republished as deltas. Verbatim
/// pieces are what make this safe: each already passed the per-update cap
/// when it entered the lineage, a pending row survives byte-for-byte until
/// its predecessor arrives, and a clean peer replays exactly what this
/// machine holds. The refused journal row is rewritten in place into the
/// first republished piece (per-origin sequence density holds); the rest
/// append as fresh ops. A compacted snapshot larger than the per-update cap
/// is the one residual this cannot republish: that case refuses UNACKED and
/// names #549, which owns the measured bound.
#[allow(clippy::too_many_arguments)]
fn adopt_divergent_base_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    winner_kind: dohc_engine_collab::ContentKind,
    loser_kind: dohc_engine_collab::ContentKind,
    winner_base: &[u8],
    winner_sv: &[u8],
    now_ms: i64,
) -> Result<AdoptionOutcome, SyncError> {
    // The losing lineage's pieces, in replay order: its latest snapshot (the
    // seq-0 base itself when never compacted) plus every update row after it.
    let latest_snapshot: Option<(i64, String)> = tx
        .query_row(
            "SELECT up_to_seq, snapshot_blob_sha256 FROM ydoc_snapshots \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
             ORDER BY up_to_seq DESC LIMIT 1",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let from_seq = latest_snapshot.as_ref().map_or(0, |(seq, _)| *seq);
    let mut pieces: Vec<String> = latest_snapshot.iter().map(|(_, sha)| sha.clone()).collect();
    {
        let mut stmt = tx
            .prepare(
                "SELECT update_blob_sha256 FROM ydoc_updates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND seq > ?4 \
                 ORDER BY seq ASC",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map(
                params![key.workspace_id, key.version_id, key.object_id, from_seq],
                |row| row.get::<_, String>(0),
            )
            .map_err(SyncError::corrupt)?;
        for row in rows {
            pieces.push(row.map_err(SyncError::corrupt)?);
        }
    }
    // Every republished piece rides the same per-update cap every apply
    // enforces (constraint 5: never journal bytes a peer would refuse).
    // Update rows entered under the cap; only a compacted snapshot can
    // exceed it, and that residual leaves everything untouched and UNACKED.
    for sha in &pieces {
        let byte_length: i64 = tx
            .query_row(
                "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
                [sha],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if byte_length > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES as i64 {
            return Err(SyncError::RetryableState {
                reason: "ydoc adoption cannot republish a compacted snapshot over \
                         MAX_YDOC_UPDATE_BYTES (5 MiB per update); #549 owns the measured bound",
            });
        }
    }
    // Swap the durable lineage: winner base at seq 0, the loser's pieces
    // re-appended verbatim on top.
    tx.execute(
        "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(SyncError::persist)?;
    let base_sha =
        dohc_engine_storage::put_binary_blob(tx, winner_base).map_err(SyncError::Storage)?;
    let sv_sha = dohc_engine_storage::put_binary_blob(tx, winner_sv).map_err(SyncError::Storage)?;
    tx.execute(
        "INSERT INTO ydoc_snapshots \
         (workspace_id, version_id, object_id, up_to_seq, \
          snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms) \
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            base_sha,
            sv_sha,
            now_ms
        ],
    )
    .map_err(SyncError::persist)?;
    for (index, sha) in pieces.iter().enumerate() {
        tx.execute(
            "INSERT INTO ydoc_updates \
             (workspace_id, version_id, object_id, seq, update_blob_sha256, \
              actor_origin_id, recorded_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                (index + 1) as i64,
                sha,
                now_ms
            ],
        )
        .map_err(SyncError::persist)?;
    }
    // The lineage carries the WINNER's kind — the relay arbitrated this
    // coordinate, and its base is the one every clean peer reconstructs
    // from. A loser that held a different kind keeps its content durable in
    // the republished pieces (they live under their own roots), and the
    // caller opens a review conflict instead of projecting over its head.
    tx.execute(
        "UPDATE ydoc_docs SET regime='replicated', content_kind=?4, base_claimed=1, \
         head_update_seq=?5, head_snapshot_seq=0, updated_at_ms=?6 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            winner_kind.as_str(),
            pieces.len() as i64,
            now_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    // Republish through this machine's own journal. The refused base row is
    // rewritten in place into the first piece; the rest append. An
    // identity-less receiver has no journal and no obligation. With no
    // pieces at all (a bare claimed marker), the refused row becomes the
    // winner's own base — same sha, which the relay accepts and every
    // receiver resumes idempotently.
    let own_row = own_unpushed_base_row(tx, key)?;
    let Some((origin, refused_seq, _refused_sha)) = own_row else {
        return Ok(AdoptionOutcome {
            republished: 0,
            cross_kind: loser_kind != winner_kind,
        });
    };
    let piece_payload = |sha: &str, is_base: bool| {
        serde_json::json!({
            "versionId": key.version_id,
            "objectId": key.object_id,
            "path": path,
            "contentKind": winner_kind.as_str(),
            "updateBlobSha256": sha,
            "isBaseState": is_base,
        })
    };
    let first = match pieces.first() {
        Some(sha) => piece_payload(sha, false),
        None => piece_payload(&base_sha, true),
    };
    let payload_json = serde_json::to_string(&first).map_err(|_| SyncError::InvalidInput {
        reason: "adoption payload is not valid JSON",
    })?;
    tx.execute(
        "UPDATE replication_log SET payload_json=?4, recorded_at_ms=?5 \
         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![key.workspace_id, origin, refused_seq, payload_json, now_ms],
    )
    .map_err(SyncError::persist)?;
    let mut republished = 1usize;
    for sha in pieces.iter().skip(1) {
        crate::journal::journal_local_op_in_tx(
            tx,
            &key.workspace_id,
            "ydoc.update",
            &piece_payload(sha, false),
            now_ms,
        )?;
        republished += 1;
    }
    Ok(AdoptionOutcome {
        republished,
        cross_kind: loser_kind != winner_kind,
    })
}

/// Store the projected markdown as a text blob so a conflict side can
/// reference it (the conflict UI hydrates sides from `blobs`).
fn put_projection_text_blob(
    tx: &rusqlite::Transaction<'_>,
    markdown: &str,
    sha256: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
        params![sha256, markdown.len() as i64, markdown],
    )
    .map_err(SyncError::persist)?;
    Ok(())
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
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    let current = validate_ydoc_identity(tx, key, path)?;
    let projection = doc
        .project(content_kind)
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc projection exceeds materialization cap",
        })?;
    // While a sync conflict is open on this object, the visible head belongs
    // to the user's review: writing through it would clobber the exact state
    // the conflict preserves. Coalesce the incoming side to the freshest
    // remote projection instead (moment-lane parity) and leave the head and
    // the settle marker alone until a resolution closes the conflict.
    if let Some(conflict_id) = open_sync_conflict_id(tx, key)? {
        let projected_sha = dohc_engine_storage::hex_sha256(projection.markdown.as_bytes());
        put_projection_text_blob(tx, &projection.markdown, &projected_sha)?;
        crate::moment_apply::coalesce_conflict_sides(
            tx,
            &key.workspace_id,
            &conflict_id,
            &crate::moment_apply::ConflictSide {
                exists: true,
                path: path.to_owned(),
                object_id: Some(key.object_id.clone()),
                kind: Some(crate::moment_apply::ContentKind::Text),
                digest: Some(projected_sha),
                updated_at_ms: Some(now_ms),
                latest_moment_id: Some(ydoc_apply_moment_id(key, path, origin_id, origin_seq)),
                metadata: Some(crate::moment_apply::Metadata {
                    origin: "sync".to_owned(),
                    summary: None,
                    correlation_id: None,
                }),
            },
            now_ms,
        )?;
        return Ok(());
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
    let moment_id = ydoc_apply_moment_id(key, path, origin_id, origin_seq);
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
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms,
            request_id: None,
        },
    )
    .map_err(|error| map_domain_payload_error(error, "ydoc.update projection write failed"))?;
    if !result.deduped {
        upsert_file_search_index(
            tx,
            &key.workspace_id,
            &key.version_id,
            &result.snapshot.object_id,
            &result.snapshot.path,
            Some(&result.snapshot.text),
            search_policy,
        )?;
    }
    enqueue_write(tx, &result, preimage, "ydoc").map_err(map_domain_hard_error)?;
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
    let payload: YdocUpdatePayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(_) => {
            return refuse_ydoc(store, envelope, faults, "ydoc.update payload is malformed");
        }
    };
    let search_policy = search_policy_for_store(store);
    // Gate on the SAME floor the projection sink applies
    // (`validate_plaintext_storable_path`) rather than R10's narrow
    // share-boundary classifier, which misses reserved 8.3 aliases (`dohc~1`
    // aliases `.dohc`) and dots-and-spaces segments. The path is persisted as a
    // durable alias key, so it must already be canonical.
    let (classification, normalized) = classify_engine_file_path_normalized(&payload.path);
    if classification != PathClassification::Tracked
        || normalized.as_deref() != Some(payload.path.as_str())
        || !matches!(payload.content_kind.as_str(), "plaintext" | "richdoc")
    {
        return refuse_ydoc(
            store,
            envelope,
            faults,
            "ydoc.update path or content kind is invalid",
        );
    }
    let key = match DocKey::new(
        envelope.workspace_id.clone(),
        payload.version_id,
        payload.object_id,
    ) {
        Ok(key) => key,
        Err(_) => {
            return refuse_ydoc(
                store,
                envelope,
                faults,
                "ydoc.update coordinates are invalid",
            );
        }
    };
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
        // FULL durable validation BEFORE admission: byte caps, abort-safe
        // prevalidation, AND the replay-parity gate — replayed on top of the
        // ALREADY-QUEUED deferred predecessors, because a later update can
        // only become invalid after they apply, and the drain will apply
        // them first. Anything the drain would reject becomes a refusal, not a
        // deferred update.
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
                    .map_err(|_| local_corruption("parked ydoc.update payload is malformed"))?;
                let queued_bytes = store
                    .get_binary_blob(&queued_payload.update_blob_sha256)?
                    .ok_or(SyncError::BlobInvalid)?;
                queued.push(queued_bytes);
            }
            queued
        };
        if let Err(error) =
            dohc_engine_collab::validate_remote_update_with_pending(store, &key, &queued, &bytes)
        {
            return match map_collab_payload_error(
                error,
                "ydoc.update bytes fail durable validation",
            ) {
                SyncError::InvalidInput { reason } => refuse_ydoc(store, envelope, faults, reason),
                hard => Err(hard),
            };
        }
        // A deferred coordinate is ACKED — it must be drainable later, which
        // the close/open drains only do for REPLICATED markers. A live lease
        // over a local-only lineage is a transient local-state race. It stays
        // hard and unacked so the peer coordinate can be retried after the
        // session settles or closes.
        let marker = dohc_engine_collab::read_marker(store, &key).map_err(map_collab_hard_error)?;
        if !marker.is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated) {
            return Err(SyncError::RetryableState {
                reason: "live lease on a non-replicated Y.Doc lineage",
            });
        }
        // A DIVERGENT inbound base must not be acked-and-parked: the drain
        // replays raw bytes and cannot run the base branch's adoption, so a
        // parked divergent base would silently union while this machine's
        // own refused base wedges the push lane forever. Leave it unacked;
        // the retry adopts once the live session settles or closes. The
        // detector is the SAME pair the adoption branch uses — the stored
        // seq-0 base while it survives, and after compaction folds it away,
        // the obligation: our own refused base row still unpushed in the
        // journal. One detector, every path.
        if payload.is_base_state {
            let divergent = store.read_with(|conn| {
                Ok::<_, SyncError>(
                    stored_seq0_base_sha(conn, &key)?
                        .is_some_and(|stored| stored != payload.update_blob_sha256)
                        || own_unpushed_base_row(conn, &key)?
                            .is_some_and(|(_, _, sha)| sha != payload.update_blob_sha256),
                )
            })?;
            if divergent {
                return Err(SyncError::RetryableState {
                    reason: "live Y.Doc session over a divergent inbound base",
                });
            }
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
                conflicts_opened: 0,
                pending_push: false,
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
            if doc.apply(&bytes).is_err() {
                return refuse_ydoc(
                    store,
                    envelope,
                    faults,
                    "ydoc.update base bytes fail validation",
                );
            }
            doc.encode_state_vector()
        };
        let claim_key = key.clone();
        let claim_bytes = bytes.clone();
        let claim_sha = payload.update_blob_sha256.clone();
        // The claim can PROMOTE a local-only lineage that already holds
        // update rows (a crash left them behind): the projection must be the
        // reconstructed lineage PLUS the base, or the visible snapshot would
        // drop local content that is still durably part of the CRDT.
        let (base_doc, lineage_has_state) = {
            let persisted =
                dohc_engine_collab::load_persisted(store, &key).map_err(map_collab_hard_error)?;
            // A claimed base counts as durable state even at head seq 0: the
            // seq-0 snapshot does not advance either head counter, but the
            // lineage it establishes already carries the local head — a
            // second base coordinate must take the union/adoption path, not
            // the plain-file conflict below.
            let lineage_has_state = persisted.as_ref().is_some_and(|persisted| {
                persisted.marker.head_update_seq > 0
                    || persisted.marker.head_snapshot_seq > 0
                    || persisted.marker.base_claimed
            });
            let doc = match persisted {
                Some(persisted) => persisted.doc,
                None => dohc_engine_collab::Ydoc::wire(),
            };
            if doc.apply(&claim_bytes).is_err() {
                return refuse_ydoc(
                    store,
                    envelope,
                    faults,
                    "ydoc.update base bytes fail validation",
                );
            }
            (doc, lineage_has_state)
        };
        let base_path = payload.path.clone();
        let outcome = crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
            // Cross-origin file edits can temporarily occupy this path before
            // the base arrives. Retrying after the later delete/rename is
            // convergence-safe; refusing and ACKing would lose the base
            // forever on this receiver.
            let current = validate_retryable_ydoc_identity(tx, &claim_key, &base_path)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES (?1, ?2, ?3)",
                rusqlite::params![claim_key.workspace_id, claim_key.object_id, op.recorded_at_ms],
            )
            .map_err(SyncError::persist)?;
            // A non-base update can preallocate the FK parent before the base
            // establishes the lineage. That bare placeholder is not the
            // object's provenance: the base coordinate is. Match the daemon's
            // preallocated-object rule by correcting only an unbound,
            // markerless object that actually has a pre-base queue entry.
            tx.execute(
                "UPDATE file_objects SET created_at_ms=?3 \
                 WHERE workspace_id=?1 AND object_id=?2 \
                   AND EXISTS(SELECT 1 FROM ydoc_deferred_updates \
                     WHERE workspace_id=?1 AND version_id=?4 AND object_id=?2) \
                   AND NOT EXISTS(SELECT 1 FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?4 AND object_id=?2) \
                   AND NOT EXISTS(SELECT 1 FROM path_aliases \
                     WHERE workspace_id=?1 AND object_id=?2) \
                   AND NOT EXISTS(SELECT 1 FROM snapshots \
                     WHERE workspace_id=?1 AND object_id=?2)",
                params![
                    claim_key.workspace_id,
                    claim_key.object_id,
                    op.recorded_at_ms,
                    claim_key.version_id,
                ],
            )
            .map_err(SyncError::persist)?;
            // #547: an inbound base that differs from OUR claimed base means
            // the peer won the origination race at the relay (which admits
            // one base per lineage), so this machine adopts instead of
            // wedging in BaseStateDiverged. Divergence shows in the stored
            // seq-0 base while it survives — and after compaction folds it
            // away, in THE OBLIGATION: this machine's own refused base row
            // still sitting unpushed in the journal. Neither present means
            // divergence is unverifiable and the claim resumes, as before.
            let marker = dohc_engine_collab::read_marker_in_tx(tx, &claim_key)
                .map_err(map_collab_hard_error)?;
            let loser_kind = marker.as_ref().map(|marker| marker.content_kind);
            let divergent = marker.is_some_and(|marker| marker.base_claimed)
                && (stored_seq0_base_sha(tx, &claim_key)?
                    .is_some_and(|stored| stored != claim_sha)
                    || own_unpushed_base_row(tx, &claim_key)?
                        .is_some_and(|(_, _, sha)| sha != claim_sha));
            let adoption = if divergent {
                Some(adopt_divergent_base_in_tx(
                    tx,
                    &claim_key,
                    &base_path,
                    kind,
                    loser_kind.unwrap_or(kind),
                    &claim_bytes,
                    &sv_bytes,
                    op.recorded_at_ms,
                )?)
            } else {
                dohc_engine_collab::claim_base_in_tx(
                    tx,
                    &claim_key,
                    kind,
                    &claim_bytes,
                    &sv_bytes,
                    op.recorded_at_ms,
                )
                .map_err(|error| {
                    map_collab_payload_error(error, "ydoc.update base could not be claimed")
                })?;
                None
            };
            let adopted = adoption.is_some();
            let pending_push = adoption
                .as_ref()
                .is_some_and(|adoption| adoption.republished > 0);
            let cross_kind = adoption
                .as_ref()
                .is_some_and(|adoption| adoption.cross_kind);
            // The FIRST base is not a CRDT merge: a local head that no shared
            // lineage ever merged (capture or an external editor wrote it, and
            // the receiver holds no durable Y.Doc rows to union with) must not
            // be silently replaced by the sender's projection. Keep the head,
            // land the lineage, and open the same reviewable sync conflict the
            // moment lane opens for a diverged file — one resolution settles
            // both machines. A head that already equals the base's projection
            // needs no conflict, and a lineage WITH durable rows takes the
            // union path below (the projection carries the local content).
            //
            // A CROSS-KIND adoption opens the same conflict: the lineage now
            // carries the winner's kind, whose projection cannot show the
            // loser's content even though the republished pieces carry it —
            // silently writing that projection over the loser's head would
            // hide the user's text. The freeze holds until resolution folds
            // the chosen text into the winner-kind root.
            if (!lineage_has_state || cross_kind)
                && let Some(snapshot) = current.snapshot.as_ref()
            {
                let projection = base_doc
                    .project(kind)
                    .map_err(|_| SyncError::InvalidInput {
                        reason: "ydoc projection exceeds materialization cap",
                    })?;
                let projected_sha = dohc_engine_storage::hex_sha256(projection.markdown.as_bytes());
                if snapshot.blob_sha256 != projected_sha {
                    put_projection_text_blob(tx, &projection.markdown, &projected_sha)?;
                    let incoming_moment_id =
                        ydoc_apply_moment_id(&claim_key, &base_path, &op.origin_id, op.origin_seq);
                    let conflict_id = crate::moment_apply::sync_conflict_id(
                        &claim_key.workspace_id,
                        &claim_key.version_id,
                        &claim_key.object_id,
                        None,
                        Some((
                            Some(snapshot.latest_moment_id.as_str()),
                            Some(incoming_moment_id.as_str()),
                        )),
                    );
                    let base_side = crate::moment_apply::ConflictSide::absent(&base_path);
                    let current_side = crate::moment_apply::ConflictSide {
                        exists: true,
                        path: snapshot.path.clone(),
                        object_id: Some(snapshot.object_id.clone()),
                        kind: Some(crate::moment_apply::ContentKind::Text),
                        digest: Some(snapshot.blob_sha256.clone()),
                        updated_at_ms: Some(snapshot.updated_at_ms),
                        latest_moment_id: Some(snapshot.latest_moment_id.clone()),
                        metadata: Some(crate::moment_apply::Metadata {
                            origin: snapshot.metadata_origin.clone(),
                            summary: snapshot.metadata_summary.clone(),
                            correlation_id: snapshot.metadata_correlation_id.clone(),
                        }),
                    };
                    let incoming_side = crate::moment_apply::ConflictSide {
                        exists: true,
                        path: base_path.clone(),
                        object_id: Some(claim_key.object_id.clone()),
                        kind: Some(crate::moment_apply::ContentKind::Text),
                        digest: Some(projected_sha),
                        updated_at_ms: Some(op.recorded_at_ms),
                        latest_moment_id: Some(incoming_moment_id.clone()),
                        metadata: Some(crate::moment_apply::Metadata {
                            origin: "sync".to_owned(),
                            summary: None,
                            correlation_id: None,
                        }),
                    };
                    let conflicts_opened = crate::moment_apply::open_or_coalesce(
                        tx,
                        &claim_key.workspace_id,
                        crate::moment_apply::OpenConflict {
                            version_id: &claim_key.version_id,
                            anchor: crate::moment_apply::CoalesceAnchor::SameObject {
                                diverging_object_id: &claim_key.object_id,
                                incoming_branch_base: None,
                            },
                            conflict_id: &conflict_id,
                            path: &snapshot.path,
                            base: &base_side,
                            current: &current_side,
                            incoming: &incoming_side,
                            recorded_at_ms: op.recorded_at_ms,
                        },
                    )?;
                    // Immutable per-envelope record of what THIS coordinate
                    // opened: a later delta coalesces the conflict and
                    // rewrites its incoming anchor, so a crash-redelivery
                    // recount must not depend on the mutable conflict row.
                    record_ydoc_conflicts_opened(tx, op, conflicts_opened)?;
                    return Ok(YdocApplyResult {
                        deferred: false,
                        reason: Some("ydoc-base-conflict"),
                        conflicts_opened,
                        pending_push,
                    });
                }
            }
            // A fresh base-only replica gets its FILE, not just CRDT rows.
            // After an adoption this projects the MERGED doc — the winner's
            // base plus everything this machine held.
            project_and_write_in_tx(
                tx,
                &claim_key,
                &base_path,
                &base_doc,
                kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            )?;
            Ok(YdocApplyResult {
                deferred: false,
                reason: if adopted {
                    Some("ydoc-base-adopted")
                } else {
                    None
                },
                conflicts_opened: 0,
                pending_push,
            })
        })?;
        if matches!(outcome, ApplyOutcome::Applied(_) | ApplyOutcome::Skipped)
            && dohc_engine_collab::read_marker(store, &key)
                .map_err(map_collab_hard_error)?
                .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
        {
            let drain = drain_deferred_ydoc_for_key(store, &key, faults)?;
            return Ok(outcome.with_refusals(drain.refusals));
        }
        return Ok(outcome);
    }
    // The lease is NOT live: any coordinates parked by an earlier live
    // phase drain FIRST, so the projection below reconstructs the COMPLETE
    // applied lineage (a partial projection would materialize a file missing
    // parked content).
    let (drain_refusals, drain_originated) = if dohc_engine_collab::read_marker(store, &key)
        .map_err(map_collab_hard_error)?
        .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
    {
        let drain = drain_deferred_ydoc_for_key(store, &key, faults)?;
        (drain.refusals, drain.originated)
    } else {
        (Vec::new(), false)
    };
    // Reconstruct the post-apply doc OUTSIDE the admission tx (commutative:
    // the in-tx apply of the same bytes yields the same converged state, and
    // a dedup changes nothing).
    let projected_doc = {
        let Some(persisted) =
            dohc_engine_collab::load_persisted(store, &key).map_err(map_collab_hard_error)?
        else {
            if let Err(error) = dohc_engine_collab::Ydoc::wire().apply(&bytes) {
                return match map_collab_payload_error(
                    error,
                    "ydoc.update bytes fail durable validation",
                ) {
                    SyncError::InvalidInput { reason } => {
                        refuse_ydoc(store, envelope, faults, reason)
                    }
                    hard => Err(hard),
                };
            }
            let deferred_key = key.clone();
            return crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
                let version_exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM versions \
                         WHERE workspace_id=?1 AND version_id=?2)",
                        params![deferred_key.workspace_id, deferred_key.version_id],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                if !version_exists {
                    return Err(SyncError::RetryableState {
                        reason: "ydoc.update version is missing",
                    });
                }
                // Validate every identity fact already knowable from this
                // payload before its coordinate is ACKed and parked. For a
                // genuinely new object the eventual base path is unknown; the
                // drain repeats this gate after the base establishes it.
                validate_retryable_ydoc_identity(tx, &deferred_key, &payload.path)?;
                tx.execute(
                    "INSERT OR IGNORE INTO file_objects \
                     (workspace_id, object_id, created_at_ms) VALUES (?1, ?2, ?3)",
                    params![
                        deferred_key.workspace_id,
                        deferred_key.object_id,
                        op.recorded_at_ms
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT OR IGNORE INTO ydoc_deferred_updates \
                     (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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
                    reason: Some("ydoc-lineage-absent"),
                    conflicts_opened: 0,
                    pending_push: false,
                })
            });
        };
        if persisted.doc.apply(&bytes).is_err() {
            return refuse_ydoc(
                store,
                envelope,
                faults,
                "ydoc.update bytes fail durable validation",
            )
            .map(|outcome| outcome.with_refusals(drain_refusals));
        }
        persisted
    };
    let update_path = payload.path.clone();
    let update_kind = projected_doc.marker.content_kind;
    let remote = RemoteUpdate {
        origin_id: envelope.origin_id.clone(),
        origin_seq: envelope.origin_seq,
        bytes,
    };
    let mut originated_in_apply = false;
    let outcome =
        crate::apply::apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
            let applied = apply_remote_update_in_transaction(tx, &key, &remote, op.recorded_at_ms)
                .map_err(|error| {
                    map_collab_payload_error(error, "ydoc.update could not be applied")
                })?;
            // An out-of-order cross-origin update parks durably with missing
            // dependencies; a projection taken NOW would omit the pending remote
            // content and materialize an incomplete view. Skip — the envelope
            // that completes the dependency projects the full doc.
            if projected_doc.doc.has_pending_dependencies() {
                return Ok(crate::apply::MutationOutcome::Applied(applied));
            }
            tx.execute_batch("SAVEPOINT dohc_ydoc_projection")
                .map_err(SyncError::persist)?;
            match project_and_write_in_tx(
                tx,
                &key,
                &update_path,
                &projected_doc.doc,
                update_kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            ) {
                Ok(()) => {
                    // This apply may have just resolved the dependency that
                    // made an earlier origination decline (#548): ask again
                    // in the same admission transaction — but only INSIDE
                    // this savepoint, after the projection accepted the
                    // path. Originating before the identity check would
                    // promote and journal a lineage the projection is about
                    // to refuse (a stale or hostile path), outside the
                    // savepoint that unwinds the refusal. Claimed lineages
                    // and non-replicating workspaces no-op inside.
                    originated_in_apply = crate::ydoc_originate::originate_ydoc_base_in_tx(
                        tx,
                        &key,
                        &update_path,
                        op.recorded_at_ms,
                    )?
                    .is_some();
                    tx.execute_batch("RELEASE dohc_ydoc_projection")
                        .map_err(SyncError::persist)?;
                }
                Err(SyncError::InvalidInput { reason }) => {
                    tx.execute_batch(
                        "ROLLBACK TO dohc_ydoc_projection; \
                     RELEASE dohc_ydoc_projection",
                    )
                    .map_err(SyncError::persist)?;
                    return Ok(crate::apply::MutationOutcome::RefusedRetainingMutation { reason });
                }
                Err(hard) => return Err(hard),
            }
            Ok(crate::apply::MutationOutcome::Applied(applied))
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
    // A dependency-resolving apply or drain that ORIGINATED journaled a
    // base after this pass's push already ran: the pull must surface it,
    // exactly like the adoption, cursor, and settlement edges. (A drain
    // origination beside a refused primary outcome has no Applied result
    // to ride; its base goes out with the next pass's push.)
    let mut mapped = map_applied_ydoc_outcome(outcome);
    if (originated_in_apply || drain_originated)
        && let ApplyOutcome::Applied(result) = &mut mapped
    {
        result.pending_push = true;
    }
    Ok(mapped.with_refusals(drain_refusals))
}

fn map_applied_ydoc_outcome(
    outcome: ApplyOutcome<ReplicationApplyOutcome>,
) -> ApplyOutcome<YdocApplyResult> {
    match outcome {
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: None,
            conflicts_opened: 0,
            pending_push: false,
        }),
        ApplyOutcome::Refused(refusal) => ApplyOutcome::Refused(refusal),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
        ApplyOutcome::WithRefusals { outcome, refusals } => ApplyOutcome::WithRefusals {
            outcome: Box::new(map_applied_ydoc_outcome(*outcome)),
            refusals,
        },
    }
}

fn refuse_ydoc(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    reason: &'static str,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    crate::apply_envelope_with(store, envelope, faults, move |_tx, _op| {
        Err(SyncError::InvalidInput { reason })
    })
}

fn map_collab_payload_error(error: CollabError, reason: &'static str) -> SyncError {
    match error {
        CollabError::MalformedUpdate { .. }
        | CollabError::ReplayParityViolation { .. }
        | CollabError::EmptyUpdate
        | CollabError::UpdateTooLarge { .. }
        | CollabError::ProjectionTooLarge { .. }
        | CollabError::ProjectionTooComplex { .. } => SyncError::InvalidInput { reason },
        CollabError::BaseStateDiverged => SyncError::CoordinateDiverged,
        hard => map_collab_hard_error(hard),
    }
}

fn validate_ydoc_identity(
    conn: &rusqlite::Connection,
    key: &DocKey,
    path: &str,
) -> Result<ConflictFileState, SyncError> {
    let current = select_snapshot_by_path_in_tx(conn, &key.workspace_id, &key.version_id, path)
        .map_err(map_domain_hard_error)?;
    // Identity pins (the oracle's fix-2): NEVER write through a path occupied
    // by a different object, and never project an object into a path it does
    // not own — a hostile op would otherwise mutate the wrong plaintext file.
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
    let other_alias: Option<String> = conn
        .query_row(
            "SELECT path FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = ?2 \
               AND object_id = ?3 AND path != ?4",
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
    Ok(current)
}

fn validate_retryable_ydoc_identity(
    conn: &rusqlite::Connection,
    key: &DocKey,
    path: &str,
) -> Result<ConflictFileState, SyncError> {
    validate_ydoc_identity(conn, key, path).map_err(|error| match error {
        SyncError::InvalidInput { reason } => SyncError::RetryableState { reason },
        hard => hard,
    })
}

fn map_collab_hard_error(error: CollabError) -> SyncError {
    match error {
        CollabError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

fn map_domain_payload_error(error: DomainError, reason: &'static str) -> SyncError {
    match error {
        DomainError::InvalidText { .. } | DomainError::InvalidPath { .. } => {
            SyncError::InvalidInput { reason }
        }
        hard @ DomainError::InvalidInput {
            reason: "object_id is already bound to another object",
        } => map_domain_hard_error(hard),
        DomainError::InvalidInput { .. } => SyncError::InvalidInput { reason },
        hard => map_domain_hard_error(hard),
    }
}

fn map_domain_hard_error(error: DomainError) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}
