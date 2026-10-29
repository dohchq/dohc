//! Backfill rows this workspace locally originated before the live capture
//! path could journal them. Each row class derives its filter from that rule.
//!
//! Named-version payloads always read `fork_base_snapshots`. Named-version
//! creation freezes those rows from the same source as `snapshots` in the same
//! transaction, so the live caller gets identical bytes and delayed backfill
//! keeps the fork-time state.
//!
//! Moment backfill cannot use `metadata_origin` to tell local from imported:
//! `moment_apply.rs` stores the sending peer's wire value verbatim (S2's
//! boundary stamp covers `snapshots`/`fork_base_snapshots`, not `moments`).
//! It excludes an imported moment by exact provenance instead — a matching
//! successfully applied `imported=1` row in `replication_log`, correlated on
//! `momentId` (which the receiver preserves verbatim, unlike secrets). An
//! imported coordinate with a pending refusal did not create the matching
//! domain row, so it is not import provenance. The backfill also excludes
//! moments whose object has retained or claimed CRDT state, except its current
//! head when durable coverage proves it is the lineage's file artifact. Deferred
//! CRDT input still reserves the path. A pruned local marker has no such state:
//! its saved artifact history remains the source for enrollment. A declined
//! lineage instead exports one current saved version; its intermediate settles
//! stay local after prune, claim, and later enrollment.
//!
//! A live append stores its path on `ydoc_docs`, so enrollment can originate
//! the lineage before any settle creates a snapshot. Once a snapshot exists,
//! its path is canonical and can change while the document is closed. The
//! enrollment read therefore prefers the snapshot path and uses the Y.Doc path
//! only for a never-settled lineage. A lineage an open session holds is
//! deferred: the session's next record or its close originates it, and a
//! later sweep claims it once no session holds it.
//!
//! Secret-version payloads always read `secret_fork_bases`, including the
//! source tip's frozen last-edit timestamp. Receivers store `updatedAtMs` in
//! `secret_files`, so exact replay preserves both ciphertext and row metadata.

use dohc_engine_collab::DocKey;
use dohc_engine_domain::{SecretMomentRecord, SecretOp, VersionKind, VersionRecord};
use rusqlite::{OptionalExtension, Row, Transaction, params};

use crate::{
    BaseOrigination, LeaseProbe, SharingDeclined, SyncError, journal_moment_append_in_tx,
    journal_secret_delete_in_tx, journal_secret_put_from_moment_in_tx,
    journal_secret_version_fork_in_tx, journal_version_create_in_tx, originate_ydoc_base_in_tx,
};

pub(crate) fn backfill_enrolment_window_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    leases: &dyn LeaseProbe,
    now_ms: i64,
) -> Result<Vec<SharingDeclined>, SyncError> {
    backfill_versions(tx, workspace_id)?;
    crate::live_audit::enrollment::queue_history_in_tx(tx, workspace_id)?;
    let sharing_declined = if !crate::live_audit::enrollment::pending_in_tx(tx, workspace_id)? {
        let declined = originate_unclaimed_ydoc_bases_in_tx(tx, workspace_id, leases, now_ms)?;
        export_covered_heads_in_tx(tx, workspace_id, leases)?;
        backfill_moments_and_conflict_bundles(tx, workspace_id)?;
        declined
    } else {
        Vec::new()
    };
    backfill_secret_moments(tx, workspace_id)?;
    Ok(sharing_declined)
}

pub(crate) fn finish_live_history_enrolment_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    leases: &dyn LeaseProbe,
    now_ms: i64,
) -> Result<Vec<SharingDeclined>, SyncError> {
    let declined = originate_unclaimed_ydoc_bases_in_tx(tx, workspace_id, leases, now_ms)?;
    export_covered_heads_in_tx(tx, workspace_id, leases)?;
    backfill_moments_and_conflict_bundles(tx, workspace_id)?;
    Ok(declined)
}

/// A lineage with a live session is left unclaimed. The claim is the
/// lineage's durable state, and a session recording into it holds edits the
/// claim would not name, so claiming under it would turn the person's next
/// keystroke into a stale write. The session's own next record originates the
/// base in the same transaction and learns the claim from the result; closing
/// the session originates it too. This sweep claims whatever is left once no
/// session holds it.
pub(crate) fn originate_unclaimed_ydoc_bases_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    leases: &dyn LeaseProbe,
    now_ms: i64,
) -> Result<Vec<SharingDeclined>, SyncError> {
    if !crate::ydoc_origination::can_originate_local_bases_in_tx(tx, workspace_id)? {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>)> = collect_rows(
        tx,
        "SELECT d.version_id, d.object_id, COALESCE(s.path,d.path) \
         FROM ydoc_docs d LEFT JOIN snapshots s \
           ON s.workspace_id=d.workspace_id AND s.version_id=d.version_id \
          AND s.object_id=d.object_id \
         WHERE d.workspace_id=?1 AND d.lineage_claim_status = 'unclaimed' AND d.file_export_lane!=1 \
         ORDER BY d.version_id, d.object_id",
        workspace_id,
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut sharing_declined = Vec::new();
    for (version_id, object_id, path) in rows {
        let Some(path) = path else {
            // Legacy never-settled rows can predate durable Y.Doc paths. A
            // later local update supplies the path and retries origination.
            continue;
        };
        let key = DocKey {
            workspace_id: workspace_id.to_owned(),
            version_id,
            object_id,
        };
        if leases.is_live(&key) {
            continue;
        }
        if let BaseOrigination::Declined(declined) =
            originate_ydoc_base_in_tx(tx, &key, &path, None, None, now_ms)?
        {
            sharing_declined.push(declined);
        }
    }
    // Stored facts include leased and pruned lineages; reading them never claims a base.
    for declined in crate::ydoc_origination::current_sharing_declines_in_tx(tx, workspace_id)? {
        if let Some(existing) = sharing_declined.iter_mut().find(|item| {
            item.version_id == declined.version_id && item.object_id == declined.object_id
        }) {
            *existing = declined;
        } else {
            sharing_declined.push(declined);
        }
    }
    Ok(sharing_declined)
}

/// Originate the lineage a live session holds, once enrollment is ready. The
/// sweep leaves such a lineage alone because the session's next write would
/// expect the old claim. The daemon calls this for each live session instead,
/// serialized with that session's writes, and hands the session the claim.
/// Reads the path the way the sweep does.
pub fn originate_live_ydoc_base_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<BaseOrigination, SyncError> {
    if crate::live_audit::enrollment::pending_in_tx(tx, &key.workspace_id)? {
        return Ok(BaseOrigination::NothingToDo);
    }
    let path: Option<String> = tx
        .query_row(
            "SELECT COALESCE(s.path,d.path) \
             FROM ydoc_docs d LEFT JOIN snapshots s \
               ON s.workspace_id=d.workspace_id AND s.version_id=d.version_id \
              AND s.object_id=d.object_id \
             WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 \
               AND d.lineage_claim_status = 'unclaimed' AND d.file_export_lane IN (0,3)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .flatten();
    match path {
        Some(path) => originate_ydoc_base_in_tx(tx, key, &path, None, None, now_ms),
        None => Ok(BaseOrigination::NothingToDo),
    }
}

/// Originate the lineage a closing session held, when the sweep left it for
/// that session. A local-only close prunes the lineage, so this is the last
/// point its history can reach the relay. The file's current path comes
/// from its snapshot. A deleted file has none, and a claim would let peers
/// bring it back, so it originates nothing.
pub fn originate_closing_ydoc_base_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<BaseOrigination, SyncError> {
    let path: Option<String> = tx
        .query_row(
            "SELECT s.path FROM ydoc_docs d JOIN snapshots s \
             ON s.workspace_id=d.workspace_id AND s.version_id=d.version_id \
             AND s.object_id=d.object_id \
             WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 \
             AND d.lineage_claim_status = 'unclaimed' AND d.file_export_lane IN (0,3)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    match path {
        Some(path) => originate_ydoc_base_in_tx(tx, key, &path, None, None, now_ms),
        None => Ok(BaseOrigination::NothingToDo),
    }
}

fn backfill_moments_and_conflict_bundles(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), SyncError> {
    let bundles = crate::conflict_outbox::pending_conflict_bundle_cuts_in_tx(tx, workspace_id)?;
    let mut after_moment_order = -1;
    for bundle in bundles {
        backfill_moments_between(
            tx,
            workspace_id,
            after_moment_order,
            Some(bundle.pre_effect_moment_order),
        )?;
        crate::conflict_outbox::journal_pending_conflict_bundle_in_tx(
            tx,
            workspace_id,
            bundle.bundle_order,
        )?;
        after_moment_order = bundle.pre_effect_moment_order;
    }
    backfill_moments_between(tx, workspace_id, after_moment_order, None)
}

macro_rules! head_export_exclusions_sql {
    () => {
        "                     AND NOT EXISTS (SELECT 1 FROM live_device_application_bindings b \
                       WHERE b.workspace_id=s.workspace_id AND b.main_version_id=s.version_id \
                         AND b.object_id=s.object_id) \
                     AND NOT EXISTS (SELECT 1 FROM ydoc_owner_bindings b \
                       WHERE b.workspace_id=s.workspace_id AND b.main_version_id=s.version_id \
                         AND b.object_id=s.object_id) \
                     AND NOT EXISTS (SELECT 1 FROM conflicts c \
                       WHERE c.workspace_id=s.workspace_id AND c.status='open' \
                         AND (c.target_version_id=s.version_id OR c.source_version_id=s.version_id) \
                         AND (c.path=s.path OR s.object_id IN \
                           (c.base_object_id,c.current_object_id,c.incoming_object_id))) \
                     AND COALESCE((SELECT j.status='conflict' AND j.content_sha256=s.blob_sha256 \
                       FROM materialization_jobs j \
                       WHERE j.workspace_id IN (?1,'') AND j.target_path=s.path \
                       ORDER BY j.created_at_ms DESC,j.rowid DESC LIMIT 1),0)=0 \
                     AND NOT EXISTS (SELECT 1 FROM replication_pending_conflict_moments p \
                       WHERE p.workspace_id=?1 AND p.moment_id=s.latest_moment_id) \
                     AND NOT EXISTS (SELECT 1 FROM ydoc_deferred_updates u \
                       WHERE u.workspace_id=s.workspace_id AND u.version_id=s.version_id \
                         AND u.object_id=s.object_id) \
"
    };
}

// Unary + removes the correlated keys' TEXT affinity, allowing SQLite to
// use all columns of the JSON expression indexes.
const COVERED_HEADS_SQL: &str = concat!(
    "SELECT s.latest_moment_id,s.version_id,s.object_id,s.blob_sha256,d.content_kind, \
                     d.head_update_seq,d.head_snapshot_seq,d.lineage_claim_id FROM snapshots s JOIN ydoc_docs d \
                     ON d.workspace_id=s.workspace_id AND d.version_id=s.version_id \
                       AND d.object_id=s.object_id \
                   JOIN moments h ON h.workspace_id=s.workspace_id \
                     AND h.version_id=s.version_id AND h.object_id=s.object_id \
                     AND h.moment_id=s.latest_moment_id \
                     AND h.payload_after_blob_sha256=s.blob_sha256 AND h.payload_after_path=s.path \
                   WHERE s.workspace_id=?1 AND s.content_kind='text' AND ",
    dohc_engine_domain::exclude_capture_recovery_sql!("h"),
    " \
                     AND d.lineage_claim_status != 'unclaimed' \
                     AND d.lineage_parent_claim_id IS NULL AND d.base_origin_id = ( \
                       SELECT origin_id FROM sync_identity WHERE workspace_id=?1) \
                     AND CASE WHEN d.export_attempt_moment_id IS NOT s.latest_moment_id \
                       OR d.export_attempt_update_seq IS NOT d.head_update_seq \
                       OR d.export_attempt_snapshot_seq IS NOT d.head_snapshot_seq \
                       OR d.export_attempt_lineage_claim_id IS NOT d.lineage_claim_id \
                       THEN 1 WHEN d.export_wait_asset_sha256 IS NULL THEN 0 \
                         WHEN NOT EXISTS (SELECT 1 FROM binary_blobs waiting_blob \
                           WHERE waiting_blob.sha256=d.export_wait_asset_sha256) THEN 0 \
                         WHEN d.export_wait_asset_path IS NULL THEN 1 \
                         ELSE EXISTS (SELECT 1 FROM path_aliases a JOIN snapshots asset \
                           ON asset.workspace_id=a.workspace_id AND asset.version_id=a.version_id \
                             AND asset.object_id=a.object_id \
                           WHERE a.workspace_id=d.workspace_id AND a.version_id=d.version_id \
                             AND a.path=d.export_wait_asset_path AND asset.content_kind='binary' \
                             AND asset.binary_sha256=d.export_wait_asset_sha256 \
                           UNION ALL ",
    crate::ydoc_apply::retired_scene_asset_sql!(
        "d.workspace_id",
        "d.version_id",
        "d.export_wait_asset_path",
        "d.export_wait_asset_sha256"
    ),
    ") END \
                     AND ((d.settled_update_seq=d.head_update_seq \
                       AND d.last_settled_sha=s.blob_sha256) OR ( \
                       d.last_settled_sha IS NULL AND d.seed_source_sha256=s.blob_sha256 \
                       AND d.head_update_seq=1 AND d.head_snapshot_seq IN (0,1) \
                       AND (SELECT COUNT(*) FROM ydoc_updates u \
                         WHERE u.workspace_id=d.workspace_id AND u.version_id=d.version_id \
                           AND u.object_id=d.object_id)=1-d.head_snapshot_seq \
                       AND EXISTS (SELECT 1 FROM ydoc_snapshots b \
                         WHERE b.workspace_id=d.workspace_id AND b.version_id=d.version_id \
                           AND b.object_id=d.object_id AND b.up_to_seq=d.head_snapshot_seq) \
                       AND NOT EXISTS (SELECT 1 FROM ydoc_snapshots b \
                         WHERE b.workspace_id=d.workspace_id AND b.version_id=d.version_id \
                           AND b.object_id=d.object_id AND b.up_to_seq NOT IN (0,1)))) \
",
    head_export_exclusions_sql!(),
    "                     AND NOT EXISTS (SELECT 1 FROM replication_log r \
                       WHERE r.workspace_id=?1 AND r.op_kind='moment.append' \
                         AND json_extract(r.payload_json,'$.versionId')=+s.version_id \
                         AND json_extract(r.payload_json,'$.objectId')=+s.object_id) \
                     AND NOT EXISTS (SELECT 1 FROM replication_log r \
                       WHERE r.workspace_id=?1 AND r.op_kind='moment.append' \
                         AND json_extract(r.payload_json,'$.momentId')=+s.latest_moment_id \
                         AND (r.imported=0 OR NOT EXISTS ( \
                           SELECT 1 FROM replication_pending_refusals p \
                           WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id \
                             AND p.origin_seq=r.origin_seq))) \
                     ORDER BY h.moment_order"
);

/// Export an object's first file artifact only after this origin has journaled
/// its base. Durable coverage and the strict peer projection must both agree
/// with the head; disk materialization is not part of either proof.
pub(crate) fn export_covered_heads_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    leases: &dyn LeaseProbe,
) -> Result<(), SyncError> {
    let candidates = {
        let mut statement = tx
            .prepare_cached(COVERED_HEADS_SQL)
            .map_err(SyncError::corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for (moment_id, version_id, object_id, sha, kind, update_seq, snapshot_seq, lineage_claim_id) in
        candidates
    {
        let key = DocKey {
            workspace_id: workspace_id.to_owned(),
            version_id,
            object_id,
        };
        if leases.is_live(&key) {
            continue;
        }
        // Keep attempts and asset waits in this transaction so rollback
        // cannot suppress a retry.
        tx.execute(
            "UPDATE ydoc_docs SET export_attempt_moment_id=?4,export_attempt_update_seq=?5, \
             export_attempt_snapshot_seq=?6,export_attempt_lineage_claim_id=?7, \
             export_wait_asset_sha256=NULL,export_wait_asset_path=NULL WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![workspace_id, key.version_id, key.object_id, moment_id, update_seq, snapshot_seq, lineage_claim_id],
        ).map_err(SyncError::persist)?;
        let doc = match dohc_engine_collab::load_doc_in(tx, &key) {
            Ok(doc) => doc,
            Err(dohc_engine_collab::CollabError::Storage(error)) => return Err(error.into()),
            Err(_) => continue,
        };
        let Ok(kind) = dohc_engine_collab::ContentKind::parse(&kind) else {
            continue;
        };
        let projection = if kind == dohc_engine_collab::ContentKind::Scene {
            crate::ydoc_apply::project_scene_with_store(tx, &key, &doc)
        } else {
            doc.project(kind)
                .map_err(|error| match error {
                    dohc_engine_collab::CollabError::Storage(error) => SyncError::Storage(error),
                    _ => SyncError::InvalidInput {
                        reason: "export projection is unavailable",
                    },
                })
                .map_err(crate::ydoc_apply::SceneProjectionError::from)
        };
        let projection = match projection {
            Ok(projection) => projection,
            Err(failure) => {
                if let SyncError::Storage(_) = failure.error {
                    return Err(failure.error);
                }
                if let Some(wait) = failure.waiting_asset {
                    let (path, sha256) = match *wait {
                        crate::ydoc_apply::SceneAssetWait::Head { path, sha256 } => {
                            (Some(path), sha256)
                        }
                        crate::ydoc_apply::SceneAssetWait::Blob { sha256 } => (None, sha256),
                    };
                    tx.execute(
                        "UPDATE ydoc_docs SET export_wait_asset_path=?4,export_wait_asset_sha256=?5 \
                         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                        params![workspace_id, key.version_id, key.object_id, path, sha256],
                    ).map_err(SyncError::persist)?;
                }
                continue;
            }
        };
        let mut projection = projection.content;
        if kind == dohc_engine_collab::ContentKind::Richdoc
            && let Some(source) = doc.preserved_markdown_source(&projection)
        {
            projection = source;
        }
        if dohc_engine_storage::hex_sha256(projection.as_bytes()) == sha {
            match journal_moment_append_in_tx(tx, workspace_id, &moment_id) {
                Ok(()) => {}
                Err(error @ SyncError::Storage(_)) => return Err(error),
                Err(_) => continue,
            }
        }
    }
    Ok(())
}

fn backfill_moments_between(
    tx: &Transaction<'_>,
    workspace_id: &str,
    after_moment_order: i64,
    through_moment_order: Option<i64>,
) -> Result<(), SyncError> {
    // `metadata_origin` alone cannot tell a locally-authored moment from an
    // imported one: `moment_apply.rs`'s `INSERT INTO moments` stores the
    // WIRE payload's `metadata.origin` verbatim (the sending peer's own
    // value — "api", "capture", "local-file", whatever that peer used), not
    // a boundary stamp. Only `snapshots`/`fork_base_snapshots` get S2's
    // "sync" stamp. The reliable discriminator is real import provenance:
    // `moment_apply.rs` preserves the sender's `moment_id` verbatim (unlike
    // secrets, which re-mint theirs), and every applied envelope lands a
    // matching `imported=1` row in `replication_log` in the same transaction.
    // A refused coordinate is logged and ACKed too, but its pending refusal
    // still exists while first-position backfill runs. Exclude only a matching
    // coordinate with no refusal. Retained CRDT state supersedes file history,
    // so covered heads have their own strict projection proof.
    let moment_ids: Vec<String> = {
        let mut statement = tx
            .prepare(concat!(
                "SELECT m.moment_id FROM moments m \
                 WHERE m.workspace_id=?1 AND ",
                dohc_engine_domain::exclude_capture_recovery_sql!("m"),
                " \
                   AND ((m.metadata_origin != 'ydoc' OR EXISTS ( \
                     SELECT 1 FROM ydoc_docs p \
                     WHERE p.workspace_id=m.workspace_id AND p.version_id=m.version_id \
                       AND p.object_id=m.object_id AND p.lineage_claim_status='unclaimed' \
                       AND p.head_update_seq=0 AND p.head_snapshot_seq=0 AND p.file_export_lane=0 \
                       AND EXISTS(SELECT 1 FROM snapshots s WHERE s.workspace_id=p.workspace_id AND s.version_id=p.version_id AND s.object_id=p.object_id))) \
                     AND NOT EXISTS (SELECT 1 FROM ydoc_docs d \
                       WHERE d.workspace_id=m.workspace_id AND d.version_id=m.version_id \
                         AND d.object_id=m.object_id \
                         AND (d.head_update_seq>0 OR d.head_snapshot_seq>0 \
                           OR d.lineage_claim_status != 'unclaimed' OR d.file_export_lane IN (1,2)))) \
                   AND m.moment_order > ?2 \
                   AND (?3 IS NULL OR m.moment_order <= ?3) \
                   AND NOT EXISTS (SELECT 1 FROM replication_pending_conflict_moments p \
                     WHERE p.workspace_id=m.workspace_id AND p.moment_id=m.moment_id) \
                   AND NOT EXISTS (SELECT 1 FROM replication_log r \
                     WHERE r.workspace_id=?1 AND r.op_kind='moment.append' \
                       AND json_extract(r.payload_json,'$.momentId')=m.moment_id \
                       AND (r.imported=0 OR NOT EXISTS ( \
                         SELECT 1 FROM replication_pending_refusals p \
                         WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id \
                           AND p.origin_seq=r.origin_seq))) \
                   AND NOT EXISTS (SELECT 1 FROM ydoc_deferred_updates d \
                     WHERE d.workspace_id=m.workspace_id AND d.version_id=m.version_id \
                       AND d.object_id=m.object_id) \
                 ORDER BY m.moment_order"
            ))
            .map_err(SyncError::corrupt)?;
        statement
            .query_map(
                params![workspace_id, after_moment_order, through_moment_order],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for moment_id in moment_ids {
        journal_moment_append_in_tx(tx, workspace_id, &moment_id)?;
    }
    Ok(())
}

pub(crate) fn file_version_is_publishable_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    moment_id: &str,
) -> Result<bool, SyncError> {
    tx.query_row(
        concat!("SELECT EXISTS(SELECT 1 FROM moments h JOIN snapshots s USING(workspace_id,version_id,object_id)
           WHERE h.workspace_id=?1 AND h.version_id=?2 AND h.object_id=?3 AND h.moment_id=?4
             AND s.latest_moment_id=h.moment_id AND s.content_kind='text'
             AND h.payload_after_blob_sha256=s.blob_sha256 AND h.payload_after_path=s.path ",
             head_export_exclusions_sql!(), " AND ", dohc_engine_domain::exclude_capture_recovery_sql!("h"), ")"),
        params![key.workspace_id,key.version_id,key.object_id,moment_id],|r|r.get(0)
    ).map_err(SyncError::corrupt)
}

/// The cut and all candidate admissions share the actor's writer transaction.
pub(crate) fn backfill_file_versions_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), SyncError> {
    if !crate::ydoc_origination::can_originate_local_bases_in_tx(tx, workspace_id)? {
        return Ok(());
    }
    let cut: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(moment_order),-1) FROM moments WHERE workspace_id=?1",
            [workspace_id],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let mut file_budget = FileExportBudget::default();
    let candidates: Vec<(String, String, String)> = {
        let mut statement = tx.prepare(concat!(
            "SELECT m.moment_id,m.version_id,m.object_id
             FROM moments m JOIN snapshots s USING(workspace_id,version_id,object_id)
             JOIN ydoc_docs d USING(workspace_id,version_id,object_id)
             WHERE m.workspace_id=?1 AND d.file_export_lane IN (1,2) AND d.lineage_claim_status='unclaimed'
               AND s.latest_moment_id=m.moment_id AND s.content_kind='text'
               AND m.payload_after_blob_sha256=s.blob_sha256 AND m.payload_after_path=s.path
               AND m.moment_order<=?2
               AND NOT EXISTS(SELECT 1 FROM replication_log r WHERE r.workspace_id=m.workspace_id AND r.op_kind='moment.append' AND json_extract(r.payload_json,'$.momentId')=+m.moment_id AND (r.imported=0 OR NOT EXISTS(SELECT 1 FROM replication_pending_refusals p WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id AND p.origin_seq=r.origin_seq)))
             AND ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " ORDER BY m.moment_order"
        )).map_err(SyncError::corrupt)?;
        statement
            .query_map(params![workspace_id, cut], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<_, _>>()
            .map_err(SyncError::corrupt)?
    };
    for (moment_id, version_id, object_id) in candidates {
        let key = DocKey {
            workspace_id: workspace_id.to_owned(),
            version_id,
            object_id,
        };
        if file_version_is_publishable_in_tx(tx, &key, &moment_id)? {
            journal_file_version_in_tx(tx, &key, &moment_id, &mut file_budget)?;
        }
    }
    Ok(())
}

pub(crate) const LAST_FILE_EXPORT_SQL: &str = concat!("SELECT r.payload_json,m.moment_order,r.rowid FROM replication_log r
         JOIN moments m ON m.workspace_id=r.workspace_id
           AND m.moment_id=json_extract(r.payload_json,'$.momentId')
         WHERE r.workspace_id=?1 AND r.op_kind='moment.append'
           AND json_extract(r.payload_json,'$.versionId')=+?2
           AND json_extract(r.payload_json,'$.objectId')=+?3
           AND (r.imported=0 OR (COALESCE(m.sync_record_only,0)=0 AND NOT EXISTS(SELECT 1 FROM replication_pending_refusals p
             WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id AND p.origin_seq=r.origin_seq)))
         AND ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " ORDER BY m.moment_order DESC,r.rowid DESC LIMIT 1");

pub(crate) enum LastFileExport {
    Known(Option<serde_json::Value>),
    UnexplainedGap,
}

pub(crate) fn last_file_export_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
) -> Result<LastFileExport, SyncError> {
    let mut last: Option<(String, (i64, bool, i64))> = tx
        .query_row(
            LAST_FILE_EXPORT_SQL,
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, (row.get(1)?, true, row.get(2)?))),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    // Rollback replaces its target moment but leaves the published operation.
    // Its compensating moment orders that export immediately before the replacement.
    let mut missing = tx.prepare(
        "SELECT r.payload_json,r.rowid,json_extract(r.payload_json,'$.momentId')
         FROM replication_log r LEFT JOIN moments m ON m.workspace_id=r.workspace_id
           AND m.moment_id=json_extract(r.payload_json,'$.momentId')
         WHERE r.workspace_id=?1 AND r.op_kind='moment.append'
           AND json_extract(r.payload_json,'$.versionId')=+?2 AND json_extract(r.payload_json,'$.objectId')=+?3
           AND m.moment_id IS NULL AND (r.imported=0 OR NOT EXISTS(SELECT 1 FROM replication_pending_refusals p
             WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id AND p.origin_seq=r.origin_seq))"
    ).map_err(SyncError::corrupt)?;
    let rows = missing
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(SyncError::corrupt)?;
    for row in rows {
        let (json, rowid, id) = row.map_err(SyncError::corrupt)?;
        let replacement = dohc_engine_domain::rollback_compensating_moment_id(
            &key.workspace_id,
            &key.version_id,
            &id,
        );
        let order: Option<i64> = tx
            .query_row(
                "SELECT moment_order FROM moments WHERE workspace_id=?1 AND moment_id=?2",
                params![key.workspace_id, replacement],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some(order) = order else {
            eprintln!(
                "engine: published moment {id} is missing without its rollback compensator in {}/{}/{}; publishing the real preimage",
                key.workspace_id, key.version_id, key.object_id
            );
            return Ok(LastFileExport::UnexplainedGap);
        };
        let rank = (order, false, rowid);
        if last.as_ref().is_none_or(|(_, previous)| rank > *previous) {
            last = Some((json, rank));
        }
    }
    last.map(|(json, _)| serde_json::from_str(&json).map_err(SyncError::corrupt))
        .transpose()
        .map(LastFileExport::Known)
}

pub(crate) fn file_version_before_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    last: Option<&serde_json::Value>,
) -> Result<crate::outbound::PortableBefore, SyncError> {
    if let Some(last) = last {
        return Ok(crate::outbound::PortableBefore::published(last));
    }
    let first: String = tx.query_row(concat!("SELECT m.moment_id FROM moments m WHERE ", dohc_engine_domain::exclude_capture_recovery_sql!("m"), " AND m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND NOT EXISTS(SELECT 1 FROM materialization_jobs j WHERE j.workspace_id=m.workspace_id AND j.job_id='restore-delete-mat_'||m.moment_id) AND NOT EXISTS(SELECT 1 FROM replication_log r WHERE r.workspace_id=m.workspace_id AND r.op_kind='moment.append' AND r.imported=1 AND json_extract(r.payload_json,'$.momentId')=+m.moment_id AND NOT EXISTS(SELECT 1 FROM replication_pending_refusals p WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id AND p.origin_seq=r.origin_seq)) ORDER BY m.moment_order LIMIT 1"), params![key.workspace_id,key.version_id,key.object_id], |r|r.get(0)).map_err(SyncError::corrupt)?;
    let (bootstrap, _) =
        crate::outbound::moment_append_payload_in_tx(tx, &key.workspace_id, &first)?;
    Ok(crate::outbound::PortableBefore::bootstrap(&bootstrap))
}

#[derive(Default)]
pub(crate) struct FileExportBudget {
    blobs: std::collections::BTreeMap<String, i64>,
}

pub(crate) fn journal_file_version_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    moment_id: &str,
    budget: &mut FileExportBudget,
) -> Result<bool, SyncError> {
    let last = last_file_export_in_tx(tx, key)?;
    let (current, _) =
        crate::outbound::moment_append_payload_in_tx(tx, &key.workspace_id, moment_id)?;
    if let LastFileExport::Known(Some(last)) = &last
        && last["operation"] != "delete"
        && [
            "payloadAfterBlobSha256",
            "payloadAfterPath",
            "payloadAfterContentKind",
        ]
        .iter()
        .all(|field| last[*field] == current[*field])
    {
        return Ok(true);
    }
    let before = match &last {
        LastFileExport::Known(last) => file_version_before_in_tx(tx, key, last.as_ref())?,
        LastFileExport::UnexplainedGap => crate::outbound::PortableBefore::bootstrap(&current),
    };
    let payload = crate::outbound::moment_append_payload_from_in_tx(
        tx,
        &key.workspace_id,
        moment_id,
        &before,
    )?;
    let mut blobs = budget.blobs.clone();
    for (field, kind) in [
        ("payloadBeforeBlobSha256", "payloadBeforeContentKind"),
        ("payloadAfterBlobSha256", "payloadAfterContentKind"),
        ("beforeBlobSha256", "beforeContentKind"),
    ] {
        if payload[kind] == "text"
            && let Some(sha) = payload[field].as_str()
        {
            let length: i64 = tx
                .query_row(
                    "SELECT byte_length FROM blobs WHERE sha256=?1",
                    [sha],
                    |r| r.get(0),
                )
                .map_err(SyncError::corrupt)?;
            blobs.insert(sha.to_owned(), length);
        }
    }
    if blobs.values().sum::<i64>() > 20 * 1024 * 1024 {
        return Ok(false);
    }
    crate::outbound::journal_moment_append_from_in_tx(tx, &key.workspace_id, moment_id, &before)?;
    budget.blobs = blobs;
    Ok(true)
}

fn backfill_versions(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    type VersionRow = (String, String, String, i64, Option<String>, Option<String>);
    // The JSON lookup scans the workspace log once for each named version.
    // Enrollment runs once per workspace, so this bounded startup cost does
    // not justify another durable index or an in-memory shadow of the log.
    let raw_records: Vec<VersionRow> = collect_rows(
        tx,
        "SELECT v.version_id, v.kind, v.name, v.created_at_ms, \
                    v.fork_version_id, v.fork_moment_id \
             FROM versions v \
             WHERE v.workspace_id=?1 AND v.kind='named' \
                AND NOT EXISTS (SELECT 1 FROM replication_log r \
                  WHERE r.workspace_id=?1 AND r.op_kind='version.create' \
                    AND json_extract(r.payload_json,'$.versionId')=v.version_id \
                    AND (r.imported=0 OR NOT EXISTS ( \
                      SELECT 1 FROM replication_pending_refusals p \
                      WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id \
                        AND p.origin_seq=r.origin_seq))) \
             ORDER BY v.created_at_ms, v.version_id",
        workspace_id,
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;
    let records = raw_records
        .into_iter()
        .map(
            |(version_id, raw_kind, name, created_at_ms, fork_version_id, fork_moment_id)| {
                Ok(VersionRecord {
                    workspace_id: workspace_id.to_owned(),
                    version_id,
                    kind: VersionKind::from_db(&raw_kind).map_err(SyncError::corrupt)?,
                    name,
                    created_at_ms,
                    fork_version_id,
                    fork_moment_id,
                })
            },
        )
        .collect::<Result<Vec<_>, SyncError>>()?;
    let mut pending = records;
    let mut ordered = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let next = pending.iter().position(|record| {
            record.fork_version_id.as_ref().is_none_or(|parent_id| {
                !pending
                    .iter()
                    .any(|candidate| candidate.version_id == *parent_id)
            })
        });
        let Some(next) = next else {
            return Err(SyncError::corrupt(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("named version fork graph contains a cycle in workspace {workspace_id}"),
            )));
        };
        ordered.push(pending.remove(next));
    }
    for record in ordered {
        journal_version_create_in_tx(tx, &record)?;
        if let Some(from_version_id) = &record.fork_version_id {
            journal_secret_version_fork_in_tx(
                tx,
                &record.workspace_id,
                from_version_id,
                &record.version_id,
                record.created_at_ms,
            )?;
        }
    }
    Ok(())
}

fn backfill_secret_moments(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    type SecretRow = (
        i64,
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    );
    let rows: Vec<SecretRow> = collect_rows(
        tx,
        "SELECT moment_order, moment_id, workspace_id, version_id, path, recorded_at_ms, \
                operation, metadata_origin, metadata_summary, metadata_correlation_id, \
                after_iv_base64, after_auth_tag_base64, after_ciphertext_base64, \
                after_byte_length \
         FROM secret_moments sm \
         WHERE sm.workspace_id=?1 AND sm.source_origin_id IS NULL \
         ORDER BY sm.moment_order",
        workspace_id,
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
            ))
        },
    )?;
    for row in rows {
        let record = SecretMomentRecord {
            moment_order: row.0,
            moment_id: row.1,
            workspace_id: row.2,
            version_id: row.3,
            path: row.4,
            recorded_at_ms: row.5,
            operation: SecretOp::from_db(&row.6).map_err(SyncError::corrupt)?,
            metadata_origin: row.7,
            metadata_summary: row.8,
            metadata_correlation_id: row.9,
        };
        match record.operation {
            SecretOp::Write => journal_secret_put_from_moment_in_tx(
                tx,
                &record,
                row.10.as_deref().ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained iv",
                    ))
                })?,
                row.11.as_deref().ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained auth tag",
                    ))
                })?,
                row.12.as_deref().ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained ciphertext",
                    ))
                })?,
                row.13.ok_or_else(|| {
                    SyncError::corrupt(std::io::Error::other(
                        "secret write moment has no retained byte length",
                    ))
                })?,
            )?,
            SecretOp::Delete => journal_secret_delete_in_tx(tx, &record)?,
        }
    }
    Ok(())
}

fn collect_rows<T, F>(
    tx: &Transaction<'_>,
    sql: &str,
    workspace_id: &str,
    map: F,
) -> Result<Vec<T>, SyncError>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = tx.prepare(sql).map_err(SyncError::corrupt)?;
    statement
        .query_map([workspace_id], map)
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
    use dohc_engine_crypto::{SECRET_KEY_BYTES, SecretDataKey};
    use dohc_engine_domain::{
        CreateNamedVersion, RenameTextFile, SecretDelete, SecretDiskIntent, SecretFileStore,
        SecretWrite, VersionedTextStore, WriteText,
    };
    use dohc_engine_storage::{EngineStore, NoFaults};
    use dohc_engine_testkit::open_store;
    use rusqlite::params;

    use super::*;

    fn seed_main(store: &mut EngineStore) {
        VersionedTextStore::new(store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("main version");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_identity \
                     (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                     VALUES ('ws','local','epoch','stream',1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("identity");
    }

    fn write_text(
        store: &mut EngineStore,
        version_id: &str,
        object_id: &str,
        moment_id: &str,
        text: &str,
        origin: &str,
        now_ms: i64,
    ) {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: version_id.to_owned(),
                    object_id: object_id.to_owned(),
                    path: format!("{object_id}.md"),
                    text: text.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: if origin == "capture" {
                        "api".to_owned()
                    } else {
                        origin.to_owned()
                    },
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write text");
        if origin == "capture" {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE moments SET metadata_origin='capture' \
                         WHERE workspace_id='ws' AND moment_id=?1",
                        [moment_id],
                    )
                    .map_err(SyncError::persist)?;
                    tx.execute(
                        "UPDATE snapshots SET metadata_origin='capture' \
                         WHERE workspace_id='ws' AND version_id=?1 AND object_id=?2",
                        params![version_id, object_id],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("stamp autonomous capture origin");
        }
    }

    fn enroll(store: &mut EngineStore) -> Result<(), SyncError> {
        match store.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws','local',-1)",
                [],
            )
            .map_err(SyncError::persist)?;
            backfill_enrolment_window_in_tx(tx, "ws", &crate::NoLiveLeases, 1_000)
        })? {
            dohc_engine_storage::TxnOutcome::Committed(_) => Ok(()),
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        }
    }

    fn local_ops(store: &EngineStore) -> Vec<(String, serde_json::Value)> {
        store
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT op_kind,payload_json FROM replication_log \
                     WHERE workspace_id='ws' AND imported=0 ORDER BY origin_seq",
                )?;
                statement
                    .query_map([], |row| {
                        let payload: String = row.get(1)?;
                        Ok((
                            row.get::<_, String>(0)?,
                            serde_json::from_str(&payload).expect("payload json"),
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("local ops")
    }

    fn seed_pending_conflict_bundle(
        store: &mut EngineStore,
        conflict_id: &str,
        pre_effect_moment_order: i64,
        effect_moment_ids: &[&str],
        recorded_at_ms: i64,
    ) {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_pending_conflict_bundles \
                     (workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) \
                     VALUES ('ws',?1,1,?2,?3)",
                    params![conflict_id, pre_effect_moment_order, recorded_at_ms],
                )
                .map_err(SyncError::persist)?;
                let bundle_order = tx.last_insert_rowid();
                let resolve = serde_json::json!({
                    "formatVersion": 1,
                    "workspaceId": "ws",
                    "conflictId": conflict_id,
                    "status": "resolved",
                });
                tx.execute(
                    "INSERT INTO replication_pending_conflict_ops \
                     (bundle_order,op_index,op_kind,payload_json,recorded_at_ms) \
                     VALUES (?1,0,'conflict.resolve',?2,?3)",
                    params![bundle_order, resolve.to_string(), recorded_at_ms],
                )
                .map_err(SyncError::persist)?;
                for (offset, moment_id) in effect_moment_ids.iter().enumerate() {
                    let op_index = i64::try_from(offset).expect("small effect list") + 1;
                    let payload = serde_json::json!({"momentId": moment_id});
                    tx.execute(
                        "INSERT INTO replication_pending_conflict_ops \
                         (bundle_order,op_index,op_kind,payload_json,recorded_at_ms) \
                         VALUES (?1,?2,'moment.append',?3,?4)",
                        params![bundle_order, op_index, payload.to_string(), recorded_at_ms],
                    )
                    .map_err(SyncError::persist)?;
                    tx.execute(
                        "INSERT INTO replication_pending_conflict_moments \
                         (workspace_id,bundle_order,op_index,moment_id) VALUES ('ws',?1,?2,?3)",
                        params![bundle_order, op_index, moment_id],
                    )
                    .map_err(SyncError::persist)?;
                }
                Ok::<_, SyncError>(())
            })
            .expect("seed pending conflict bundle");
    }

    fn record_unsettled_ydoc(
        store: &mut EngineStore,
        key: &DocKey,
        update: &[u8],
        path: Option<&str>,
        request_id: Option<&str>,
    ) -> dohc_engine_collab::AppendOutcome {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO file_objects
                     (workspace_id, object_id, created_at_ms) VALUES ('ws', ?1, 2)",
                    [&key.object_id],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("file object");
        match dohc_engine_collab::record_local_update(
            store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            key,
            update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path,
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                require_empty_lineage: true,
                request_id,
                ..Default::default()
            },
            &NoFaults,
            3,
            |_, _, _update_sha| Ok(()),
        )
        .expect("record unsettled Y.Doc")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        }
    }

    fn ydoc_path(store: &EngineStore, object_id: &str) -> Option<String> {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT path FROM ydoc_docs
                     WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                    [object_id],
                    |row| row.get(0),
                )
            })
            .expect("Y.Doc path")
    }

    fn secret_key() -> SecretDataKey {
        SecretDataKey::from_bytes(&[7_u8; SECRET_KEY_BYTES]).expect("test secret key")
    }

    fn write_secret(
        store: &mut EngineStore,
        key: &SecretDataKey,
        version_id: &str,
        moment_id: &str,
        text: &str,
        now_ms: i64,
    ) {
        SecretFileStore::new(store, key)
            .write_secret_file(
                &SecretWrite {
                    workspace_id: "ws".to_owned(),
                    version_id: version_id.to_owned(),
                    path: ".env".to_owned(),
                    text: text.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms,
                    disk_intent: SecretDiskIntent::Materialize,
                },
                &NoFaults,
            )
            .expect("write secret");
    }

    #[test]
    fn pull_imported_moments_are_not_echoed_by_enrolment() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "imported",
            "moment-imported",
            "peer",
            "sync",
            10,
        );
        // The exclusion reads real import provenance (`replication_log`), not
        // `metadata_origin` — `moment_apply.rs` stores the sender's wire value
        // verbatim, so a domain write alone does not simulate an import. Seed
        // the matching imported row a real pull would have landed.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     VALUES ('ws','peer',0,'moment.append',?1,10,1)",
                    [serde_json::json!({"momentId": "moment-imported"}).to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed imported provenance");

        enroll(&mut store).expect("enroll");

        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "moment.append"),
            "an imported moment must not be journaled under the receiver's origin"
        );
    }

    #[test]
    fn refused_import_does_not_hide_a_local_moment_with_the_same_id() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "local",
            "moment-collision",
            "local",
            "capture",
            10,
        );
        let refused = crate::ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "moment.append".to_owned(),
            payload: serde_json::json!({"momentId": "moment-collision"}),
            recorded_at_ms: 10,
        };
        assert!(matches!(
            crate::apply_moment_envelope(&mut store, &refused, &NoFaults, &crate::NoLiveLeases),
            Ok(crate::ApplyOutcome {
                primary: crate::ApplyDisposition::Refused(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "moment.append" && payload["momentId"] == "moment-collision"
                })
                .count(),
            1,
            "a refused import is not successful import provenance"
        );
    }

    #[test]
    fn cursor_commit_backfills_a_refused_import_collision_and_retains_its_notice() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "local",
            "moment-collision",
            "local",
            "capture",
            10,
        );
        let refused = crate::ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "moment.append".to_owned(),
            payload: serde_json::json!({"momentId": "moment-collision"}),
            recorded_at_ms: 10,
        };
        assert!(matches!(
            crate::apply_moment_envelope(&mut store, &refused, &NoFaults, &crate::NoLiveLeases),
            Ok(crate::ApplyOutcome {
                primary: crate::ApplyDisposition::Refused(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        let refusals =
            crate::apply::read_pending_refusals(&store, "ws").expect("read refusal report");
        assert_eq!(refusals.len(), 1);
        let cursor = crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            settlement_report_id: None,
            ordinary_pull: None,
        };

        assert!(matches!(
            crate::commit_relay_cursor(&mut store, "ws", &cursor, &NoFaults, &crate::NoLiveLeases, 1_000),
            Ok(dohc_engine_storage::TxnOutcome::Committed(ref declines)) if declines.sharing_declined.is_empty()
        ));
        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "moment.append" && payload["momentId"] == "moment-collision"
                })
                .count(),
            1,
            "first-position backfill must see the refused import"
        );
        let pending_refusals: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("pending refusal count");
        assert_eq!(
            pending_refusals, 1,
            "cursor commit retains unresolved refusals"
        );

        crate::commit_relay_cursor(
            &mut store,
            "ws",
            &cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_001,
        )
        .expect("repeat cursor commit");
        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "moment.append" && payload["momentId"] == "moment-collision"
                })
                .count(),
            1,
            "a repeated cursor commit must not journal the local moment twice"
        );
    }

    #[test]
    fn first_position_interleaves_pending_conflict_bundle_with_moment_backfill() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(&mut store, "main", "a", "moment-a", "A", "capture", 10);
        write_text(
            &mut store,
            "main",
            "resolved",
            "moment-resolved",
            "resolved",
            "capture",
            20,
        );
        write_text(&mut store, "main", "c", "moment-c", "C", "capture", 30);
        let cut: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT moment_order FROM moments WHERE workspace_id='ws' AND moment_id='moment-a'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("pre-resolution moment order");
        seed_pending_conflict_bundle(&mut store, "conflict-r", cut, &["moment-resolved"], 20);
        let raw_resolve = r#"{ "formatVersion": 1, "workspaceId": "ws", "conflictId": "conflict-r", "status": "resolved" }"#;
        let raw_shadow = r#"{ "momentId": "moment-resolved" }"#;
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE replication_pending_conflict_ops SET payload_json=?1 \
                     WHERE bundle_order=(SELECT bundle_order FROM replication_pending_conflict_bundles \
                       WHERE workspace_id='ws' AND conflict_id='conflict-r') AND op_index=0",
                    [raw_resolve],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE replication_pending_conflict_ops SET payload_json=?1 \
                     WHERE bundle_order=(SELECT bundle_order FROM replication_pending_conflict_bundles \
                       WHERE workspace_id='ws' AND conflict_id='conflict-r') AND op_index=1",
                    [raw_shadow],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("make stored wire bytes observable");

        enroll(&mut store).expect("first-position enrolment");

        let ordered: Vec<_> = local_ops(&store)
            .into_iter()
            .map(|(kind, payload)| {
                let id = payload
                    .get("momentId")
                    .or_else(|| payload.get("conflictId"))
                    .and_then(serde_json::Value::as_str)
                    .expect("op identity")
                    .to_owned();
                (kind, id)
            })
            .collect();
        assert_eq!(
            ordered,
            vec![
                ("moment.append".to_owned(), "moment-a".to_owned()),
                ("conflict.resolve".to_owned(), "conflict-r".to_owned()),
                ("moment.append".to_owned(), "moment-resolved".to_owned(),),
                ("moment.append".to_owned(), "moment-c".to_owned()),
            ]
        );
        let pending: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_conflict_bundles WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("pending bundle count");
        assert_eq!(
            pending, 0,
            "the exact bundle drains in the enrolment transaction"
        );
        let raw_bundle_ops: Vec<String> = store
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id='ws' AND op_kind IN ('conflict.resolve','moment.append') \
                       AND (json_extract(payload_json,'$.conflictId')='conflict-r' \
                         OR json_extract(payload_json,'$.momentId')='moment-resolved') \
                     ORDER BY origin_seq",
                )?;
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("raw drained bundle payloads");
        assert_eq!(raw_bundle_ops, vec![raw_resolve, raw_shadow]);
    }

    #[test]
    fn same_cut_zero_effect_conflict_bundles_keep_bundle_order() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(&mut store, "main", "a", "moment-a", "A", "capture", 10);
        write_text(&mut store, "main", "c", "moment-c", "C", "capture", 30);
        let cut: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT moment_order FROM moments WHERE workspace_id='ws' AND moment_id='moment-a'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("shared causal cut");
        seed_pending_conflict_bundle(&mut store, "conflict-first", cut, &[], 20);
        seed_pending_conflict_bundle(&mut store, "conflict-second", cut, &[], 21);

        enroll(&mut store).expect("first-position enrolment");

        let ordered: Vec<_> = local_ops(&store)
            .into_iter()
            .map(|(kind, payload)| {
                let id = payload
                    .get("momentId")
                    .or_else(|| payload.get("conflictId"))
                    .and_then(serde_json::Value::as_str)
                    .expect("op identity")
                    .to_owned();
                (kind, id)
            })
            .collect();
        assert_eq!(
            ordered,
            vec![
                ("moment.append".to_owned(), "moment-a".to_owned()),
                ("conflict.resolve".to_owned(), "conflict-first".to_owned(),),
                ("conflict.resolve".to_owned(), "conflict-second".to_owned(),),
                ("moment.append".to_owned(), "moment-c".to_owned()),
            ]
        );
    }

    #[test]
    fn malformed_pending_bundle_rolls_back_position_and_every_log_append() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_pending_conflict_bundles \
                     (workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) \
                     VALUES ('ws','conflict-gap',1,0,20)",
                    [],
                )
                .map_err(SyncError::persist)?;
                let bundle_order = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO replication_pending_conflict_ops \
                     (bundle_order,op_index,op_kind,payload_json,recorded_at_ms) VALUES \
                     (?1,0,'conflict.resolve',?2,20), \
                     (?1,2,'moment.append',?3,20)",
                    params![
                        bundle_order,
                        serde_json::json!({
                            "formatVersion": 1,
                            "workspaceId": "ws",
                            "conflictId": "conflict-gap",
                        })
                        .to_string(),
                        serde_json::json!({"momentId": "moment-gap"}).to_string(),
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO replication_pending_conflict_moments \
                     (workspace_id,bundle_order,op_index,moment_id) \
                     VALUES ('ws',?1,2,'moment-gap')",
                    [bundle_order],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed corrupt pending bundle");

        let error = enroll(&mut store).expect_err("a child-index gap must abort enrolment");
        assert!(
            format!("{error:?}").contains("operation indexes are not contiguous"),
            "{error:?}"
        );
        let fingerprint: (i64, i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_pending_conflict_bundles \
                         WHERE workspace_id='ws' AND conflict_id='conflict-gap'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_pending_conflict_ops",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM sync_relay_push_state WHERE workspace_id='ws'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("post-refusal fingerprint");
        assert_eq!(fingerprint, (1, 2, 0, 0));
    }

    #[test]
    fn refused_import_does_not_hide_a_local_version_with_the_same_id() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named-collision".to_owned(),
                    name: "Named collision".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let refused = crate::ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "version.create".to_owned(),
            payload: serde_json::json!({"versionId": "named-collision"}),
            recorded_at_ms: 20,
        };
        assert!(matches!(
            crate::apply_version_envelope(&mut store, &refused, &NoFaults),
            Ok(crate::ApplyOutcome {
                primary: crate::ApplyDisposition::Refused(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "version.create" && payload["versionId"] == "named-collision"
                })
                .count(),
            1,
            "a refused import is not successful import provenance"
        );
    }

    #[test]
    fn ydoc_projection_moments_are_excluded_while_the_base_is_backfilled() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "ydoc-object",
            "moment-ydoc-projection",
            "projected",
            "ydoc",
            10,
        );
        let key = DocKey::new("ws", "main", "ydoc-object").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "projected");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("ydoc-object.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            11,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("record local ydoc update");

        enroll(&mut store).expect("enroll");

        let ops = local_ops(&store);
        assert_eq!(
            ops.iter().filter(|(kind, _)| kind == "ydoc.update").count(),
            1,
            "the CRDT base is the one replicated source of truth"
        );
        assert_eq!(
            ops.iter()
                .filter(|(kind, _)| kind == "moment.append")
                .count(),
            0,
            "the derived Markdown projection must not compete with its CRDT base"
        );

        let base_payload = ops
            .iter()
            .find_map(|(kind, payload)| (kind == "ydoc.update").then_some(payload))
            .expect("backfilled Y.Doc base");
        let update_sha = base_payload["updateBlobSha256"]
            .as_str()
            .expect("update blob sha");
        let update_bytes = store
            .get_binary_blob(update_sha)
            .expect("read base blob")
            .expect("base blob exists");
        let (_peer_scratch, _, mut peer) = open_store();
        seed_main(&mut peer);
        assert_eq!(
            peer.put_binary_blob(&update_bytes).expect("copy base blob"),
            update_sha
        );
        crate::apply_ydoc_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &crate::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 0,
                relay_seq: Some(0),
                op_kind: "ydoc.update".to_owned(),
                payload: base_payload.clone(),
                recorded_at_ms: 11,
            },
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("clean peer applies the CRDT base");
        let peer_head: String = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT latest_moment_id FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND object_id='ydoc-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("clean peer projected head");
        assert!(
            peer_head.starts_with("moment-ydoc-apply-"),
            "the clean peer must derive Markdown from the CRDT stream"
        );
    }

    #[test]
    fn closed_rename_backfills_the_ydoc_base_at_the_current_path() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "renamed-object",
            "moment-base",
            "base",
            "capture",
            10,
        );
        let key = DocKey::new("ws", "main", "renamed-object").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "base");
        record_unsettled_ydoc(&mut store, &key, &update, Some("renamed-object.md"), None);
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    from_path: "renamed-object.md".to_owned(),
                    to_path: "current-name.md".to_owned(),
                    moment_id: "moment-rename".to_owned(),
                    request_id: None,
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 11,
                },
                &NoFaults,
            )
            .expect("rename closed document");
        assert_eq!(
            ydoc_path(&store, "renamed-object").as_deref(),
            Some("renamed-object.md"),
            "the Y.Doc marker intentionally retains the last live-session path"
        );

        enroll(&mut store).expect("enroll");

        let payloads: Vec<_> = local_ops(&store)
            .into_iter()
            .filter_map(|(kind, payload)| {
                (kind == "ydoc.update" && payload["objectId"] == "renamed-object")
                    .then_some(payload)
            })
            .collect();
        assert_eq!(payloads.len(), 1, "enrollment emits one Y.Doc base");
        let payload = &payloads[0];
        assert_eq!(
            payload["path"], "current-name.md",
            "enrollment must derive the current closed-document path from the snapshot"
        );
    }

    #[test]
    fn first_remote_base_claim_prevents_local_ydoc_origination() {
        let (_source_scratch, _, mut source) = open_store();
        seed_main(&mut source);
        let key = DocKey::new("ws", "main", "same-coordinate").expect("key");
        let source_doc = Ydoc::wire();
        let source_update = source_doc.plaintext_insert(0, "remote edit");
        record_unsettled_ydoc(
            &mut source,
            &key,
            &source_update,
            Some("same-coordinate.md"),
            None,
        );
        enroll(&mut source).expect("source enrolls");
        let source_ops = local_ops(&source);
        let remote_payload = source_ops
            .iter()
            .find_map(|(kind, payload)| (kind == "ydoc.update").then_some(payload.clone()))
            .expect("remote base payload");
        let remote_sha = remote_payload["updateBlobSha256"]
            .as_str()
            .expect("remote base sha")
            .to_owned();
        let remote_bytes = source
            .get_binary_blob(&remote_sha)
            .expect("read remote base")
            .expect("remote base exists");

        let (_local_scratch, _, mut local) = open_store();
        seed_main(&mut local);
        let local_doc = Ydoc::wire();
        let local_update = local_doc.plaintext_insert(0, "local edit");
        record_unsettled_ydoc(
            &mut local,
            &key,
            &local_update,
            Some("same-coordinate.md"),
            None,
        );
        assert_eq!(
            local
                .put_binary_blob(&remote_bytes)
                .expect("copy remote base"),
            remote_sha
        );
        let outcome = crate::apply_ydoc_envelope(
            &mut local,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &crate::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 0,
                relay_seq: Some(1),
                op_kind: "ydoc.update".to_owned(),
                payload: remote_payload,
                recorded_at_ms: 4,
            },
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("first pull applies remote base");
        let crate::ApplyDisposition::Applied(result) = outcome.primary else {
            panic!("remote base was not applied");
        };
        assert!(outcome.refusals.is_empty());
        assert!(outcome.sharing_declined.is_empty());
        let replacement = result
            .lineage_replacement
            .expect("remote base replaces the offline lineage");
        assert!(replacement.recovered_paths.is_empty());
        assert_eq!(result.conflicts_opened, 1);

        let (claim_status, base_sha, local_updates): (String, String, i64) = local
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT lineage_claim_status FROM ydoc_docs
                         WHERE workspace_id='ws' AND version_id='main'
                           AND object_id='same-coordinate'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT snapshot_blob_sha256 FROM ydoc_snapshots
                         WHERE workspace_id='ws' AND version_id='main'
                           AND object_id='same-coordinate' AND up_to_seq=0",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_updates
                         WHERE workspace_id='ws' AND version_id='main'
                           AND object_id='same-coordinate'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("local lineage after remote claim");
        assert_eq!(
            claim_status, "exact",
            "the remote base consumed the unclaimed slot"
        );
        assert_eq!(base_sha, remote_sha, "the claimed base is the remote base");
        assert_eq!(
            local_updates, 0,
            "the offline update must not remain in the remote lineage"
        );
        let recovered_text: String = local
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text FROM conflicts c JOIN blobs b ON b.sha256=c.current_blob_sha256 WHERE c.status='open'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("recovered offline edit");
        assert_eq!(recovered_text, "local edit");

        enroll(&mut local).expect("first-position backfill");
        let local_ydoc_ops = local_ops(&local)
            .into_iter()
            .filter(|(kind, _)| kind == "ydoc.update")
            .count();
        assert_eq!(
            local_ydoc_ops, 0,
            "enrollment must not originate a second lineage after the remote claim"
        );
        let persisted = dohc_engine_collab::load_persisted(&local, &key)
            .expect("load remote lineage after enrollment")
            .expect("remote lineage exists");
        assert_eq!(persisted.marker.lineage_claim_id, Some(remote_sha));
        assert_eq!(persisted.doc.plaintext_string(), "remote edit");
        assert!(!persisted.doc.has_pending_dependencies());
    }

    #[test]
    fn request_id_reuse_cannot_change_an_unsettled_ydoc_path() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "legacy-request").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "local edit");
        assert!(!record_unsettled_ydoc(&mut store, &key, &update, None, Some("request-1")).deduped);
        assert_eq!(ydoc_path(&store, "legacy-request"), None);

        let error = dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("legacy-request.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                require_empty_lineage: true,
                request_id: Some("request-1"),
                ..Default::default()
            },
            &NoFaults,
            4,
            |_, _, _update_sha| Ok(()),
        )
        .expect_err("the same request id cannot name a different path");
        assert!(
            matches!(error, dohc_engine_collab::CollabError::IdempotencyKeyReused),
            "unexpected request-id reuse error: {error:?}"
        );
        assert_eq!(
            ydoc_path(&store, "legacy-request"),
            None,
            "a refused request-id reuse must not mutate the marker"
        );
    }

    #[test]
    fn content_retry_repairs_a_legacy_unsettled_ydoc_path() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "legacy-content").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "local edit");
        assert!(!record_unsettled_ydoc(&mut store, &key, &update, None, None).deduped);
        assert_eq!(ydoc_path(&store, "legacy-content"), None);

        let retry = match dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("legacy-content.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                require_empty_lineage: true,
                ..Default::default()
            },
            &NoFaults,
            4,
            |_, _, _update_sha| Ok(()),
        )
        .expect("retry")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };
        assert!(retry.deduped);
        assert_eq!(
            ydoc_path(&store, "legacy-content").as_deref(),
            Some("legacy-content.md"),
            "a content-hash retry must repair the path before it returns"
        );
    }

    fn claim_status(store: &EngineStore, object_id: &str) -> (String, Option<String>) {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT lineage_claim_status, lineage_claim_id FROM ydoc_docs
                     WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                    [object_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("claim status")
    }

    // Turning sync on while a document is open must not claim its lineage
    // under the open session: the claim names durable state, and the session
    // holds edits that are not durable yet.
    #[test]
    fn enrolment_leaves_a_live_lineage_unclaimed_and_a_later_sweep_claims_it() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "open-plan").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "typed while open");
        record_unsettled_ydoc(&mut store, &key, &update, Some("open-plan.md"), None);
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let lease = leases.acquire(&key).expect("open session lease");

        match store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES ('ws','local',-1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                backfill_enrolment_window_in_tx(tx, "ws", &leases, 1_000)
            })
            .expect("enroll")
        {
            dohc_engine_storage::TxnOutcome::Committed(_) => {}
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        }
        assert_eq!(
            claim_status(&store, "open-plan"),
            ("unclaimed".to_owned(), None)
        );
        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "ydoc.update"),
            "no base may be journaled while the session holds the lineage"
        );

        drop(lease);
        let cursor = crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            settlement_report_id: None,
            ordinary_pull: None,
        };
        crate::commit_relay_cursor(&mut store, "ws", &cursor, &NoFaults, &leases, 1_001)
            .expect("cursor commit");
        let (status, claim) = claim_status(&store, "open-plan");
        assert_eq!(status, "exact");
        assert!(claim.is_some());
        let marker = dohc_engine_collab::read_marker(&store, &key)
            .expect("marker")
            .expect("claimed marker");
        let originated_here = |marker: &dohc_engine_collab::Marker| {
            store
                .read_with(|conn| crate::lineage_originated_here(conn, &key, marker))
                .expect("origin check")
        };
        assert!(
            originated_here(&marker),
            "a session that opened this lineage unclaimed may keep its document"
        );
        let relay_base = dohc_engine_collab::Marker {
            base_origin_id: Some("peer".to_owned()),
            ..marker.clone()
        };
        let successor = dohc_engine_collab::Marker {
            lineage_parent_claim_id: Some("f".repeat(64)),
            ..marker.clone()
        };
        assert!(
            !originated_here(&relay_base),
            "a relay base is another lineage"
        );
        assert!(
            !originated_here(&successor),
            "a successor is another lineage"
        );
        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "ydoc.update" && payload["objectId"] == "open-plan"
                })
                .count(),
            1,
            "the next sweep originates the released lineage once"
        );
    }

    // The sweep leaves an open lineage to its session. A local-only close
    // prunes the lineage, so the close has to originate it first.
    #[test]
    fn a_closing_session_originates_the_lineage_the_sweep_left_to_it() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "closing-plan",
            "moment-closing",
            "typed while open",
            "capture",
            2,
        );
        let key = DocKey::new("ws", "main", "closing-plan").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "typed while open");
        record_unsettled_ydoc(&mut store, &key, &update, Some("closing-plan.md"), None);
        // A file deleted while its session stayed open has no snapshot left.
        let deleted = DocKey::new("ws", "main", "deleted-plan").expect("key");
        let deleted_update = Ydoc::wire().plaintext_insert(0, "gone");
        record_unsettled_ydoc(
            &mut store,
            &deleted,
            &deleted_update,
            Some("deleted-plan.md"),
            None,
        );
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let _lease = leases.acquire(&key).expect("open session lease");
        let _deleted_lease = leases.acquire(&deleted).expect("open session lease");
        match store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES ('ws','local',-1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                backfill_enrolment_window_in_tx(tx, "ws", &leases, 1_000)
            })
            .expect("enroll")
        {
            dohc_engine_storage::TxnOutcome::Committed(_) => {}
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        }
        assert_eq!(claim_status(&store, "closing-plan").0, "unclaimed");

        let originated = match store
            .write_with(&NoFaults, |tx| {
                originate_closing_ydoc_base_in_tx(tx, &key, 1_001)
            })
            .expect("close origination")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };
        assert!(matches!(originated, BaseOrigination::Originated { .. }));
        assert_eq!(claim_status(&store, "closing-plan").0, "exact");
        let payloads: Vec<_> = local_ops(&store)
            .into_iter()
            .filter_map(|(kind, payload)| {
                (kind == "ydoc.update" && payload["objectId"] == "closing-plan").then_some(payload)
            })
            .collect();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0]["path"], "closing-plan.md");

        let deleted_outcome = match store
            .write_with(&NoFaults, |tx| {
                originate_closing_ydoc_base_in_tx(tx, &deleted, 1_002)
            })
            .expect("deleted close origination")
        {
            dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };
        assert_eq!(deleted_outcome, BaseOrigination::NothingToDo);
        assert_eq!(
            claim_status(&store, "deleted-plan").0,
            "unclaimed",
            "a deleted file must not reach peers through its closing session"
        );
    }

    #[test]
    fn enrolment_leaves_an_unclaimed_ydoc_without_a_path_for_a_later_retry() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = DocKey::new("ws", "main", "legacy-orphan").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "local edit");
        record_unsettled_ydoc(&mut store, &key, &update, None, None);

        enroll(&mut store).expect("a legacy pathless Y.Doc must not block enrolment");
        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "ydoc.update"),
            "the pathless lineage must remain local until a retry supplies its path"
        );
        assert_eq!(
            ydoc_path(&store, "legacy-orphan"),
            None,
            "enrolment must not invent or mutate a legacy Y.Doc path"
        );
    }

    #[test]
    fn pull_of_a_live_originated_base_does_not_publish_a_blocking_file_moment() {
        let (_scratch, _, mut source) = open_store();
        seed_main(&mut source);
        seed_retained_artifact(&mut source);
        let key = DocKey::new("ws", "main", "seed-object").expect("key");
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let held = leases.acquire(&key).expect("source editor");
        source
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_push_state VALUES ('ws','local',-1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                backfill_enrolment_window_in_tx(tx, "ws", &leases, 100)?;
                originate_live_ydoc_base_in_tx(tx, &key, 101)
            })
            .expect("originate live base");
        crate::commit_relay_cursor(
            &mut source,
            "ws",
            &crate::RelayCursor {
                cursor: 1,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &leases,
            102,
        )
        .expect("source pull cursor");

        let ops =
            crate::list_replication_ops(&source, "ws", "local", -1, 100).expect("published ops");
        let (_peer_scratch, _, mut peer) = open_store();
        seed_main(&mut peer);
        seed_retained_artifact(&mut peer);
        peer.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_identity SET origin_id='peer'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("peer identity");
        for op in &ops {
            if let Some(sha) = op.payload["updateBlobSha256"].as_str() {
                peer.put_binary_blob(
                    &source
                        .get_binary_blob(sha)
                        .expect("source blob")
                        .expect("base"),
                )
                .expect("hydrate base");
            }
        }
        let mut base = ops[0].clone();
        base.relay_seq = Some(1);
        crate::apply_replication_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("peer receives the base before opening its editor");
        let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
        *client.transport().pull.lock().expect("page") = Some(crate::PullResponse {
            next_cursor: ops.len() as i64,
            ops,
            has_more: false,
        });
        let peer_leases = dohc_engine_collab::LeaseRegistry::new();
        let peer_held = peer_leases.acquire(&key).expect("idle peer editor");
        let outcome = client
            .pull_chat_workspace(
                &mut peer,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &peer_leases,
                103,
            )
            .expect("pull while both editors are live");
        let crate::SyncPassOutcome::Complete {
            pending_cursor: Some(cursor),
            ..
        } = outcome
        else {
            panic!("pull cursor");
        };
        client
            .commit_pull_cursor(&mut peer, "ws", &cursor, &NoFaults, &peer_leases, 103)
            .expect("commit peer pull");
        assert!(
            local_ops(&source)
                .iter()
                .all(|(kind, _)| kind != "moment.append")
        );
        dohc_engine_collab::close_session(&mut source, &key, false, None, &NoFaults, 104)
            .expect("close compacts the replicated seed");
        drop(held);
        sweep(&mut source, 104);
        assert_eq!(
            local_ops(&source).len(),
            2,
            "released artifact exports once"
        );
        let ops =
            crate::list_replication_ops(&source, "ws", "local", -1, 100).expect("exported ops");
        *client.transport().pull.lock().expect("page") = Some(crate::PullResponse {
            next_cursor: ops.len() as i64,
            ops: ops.into_iter().skip(1).collect(),
            has_more: false,
        });
        let outcome = client
            .pull_chat_workspace(
                &mut peer,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &peer_leases,
                105,
            )
            .expect("export must not fail an idle editor's pull");
        let crate::SyncPassOutcome::Complete {
            pending_cursor: Some(cursor),
            ..
        } = outcome
        else {
            panic!("deferred cursor");
        };
        client
            .commit_pull_cursor(&mut peer, "ws", &cursor, &NoFaults, &peer_leases, 105)
            .expect("commit deferred cursor");
        let pending: i64 = peer
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |row| {
                    row.get(0)
                })
            })
            .expect("deferred file moment");
        assert_eq!(pending, 0, "an already projected artifact is history only");
        *client.transport().pull.lock().expect("page") = Some(crate::PullResponse {
            next_cursor: 2,
            ops: Vec::new(),
            has_more: false,
        });
        dohc_engine_collab::close_session(&mut peer, &key, false, None, &NoFaults, 106)
            .expect("peer close");
        drop(peer_held);
        client
            .pull_chat_workspace(
                &mut peer,
                &mut dohc_engine_collab::WriterDocCache::new(),
                "ws",
                &NoFaults,
                &peer_leases,
                107,
            )
            .expect("deferred file moment applies after close");
        assert_eq!(
            crate::read_replication_acked_seq(&peer, "ws", "local").expect("ack"),
            1
        );
    }

    #[test]
    fn saved_file_and_covered_head_exports_mark_unproven_hosted_authors_across_epochs() {
        for retained in [false, true] {
            let (_scratch, _, mut store) = open_store();
            seed_main(&mut store);
            if retained {
                seed_retained_artifact(&mut store);
            } else {
                write_text(
                    &mut store,
                    "main",
                    "seed-object",
                    "seed-moment",
                    "saved text",
                    "capture",
                    10,
                );
            }
            let authors=serde_json::json!([{"kind":"human","humanId":"hosted-reader","humanName":"Reader"},{"kind":"agent","agentId":"agent","onBehalfOf":"hosted-reader"}]).to_string();
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE moments SET author_json=?1 WHERE moment_id='seed-moment'",
                        [&authors],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .unwrap();
            enroll(&mut store).unwrap();
            let assert_marked = |store: &EngineStore| {
                let moments: Vec<_> = local_ops(store)
                    .into_iter()
                    .filter(|(kind, _)| kind == "moment.append")
                    .collect();
                assert!(!moments.is_empty());
                for (_, payload) in moments {
                    assert!(payload.get("authors").is_none());
                    assert!(payload.get("settlementReference").is_none());
                    assert_eq!(payload["metadata"]["summary"], "Attribution unavailable");
                    assert_eq!(
                        payload["attributionUnavailable"]["settlementId"],
                        "unavailable"
                    );
                }
                assert!(!crate::list_refusal_notices(store, "ws").unwrap().is_empty());
            };
            assert_marked(&store);
            store.write_with(&NoFaults,|tx| {
                tx.execute("DELETE FROM sync_relay_cursors WHERE workspace_id='ws'",[]).map_err(SyncError::persist)?;
                tx.execute("DELETE FROM sync_relay_push_state WHERE workspace_id='ws'",[]).map_err(SyncError::persist)?;
                tx.execute("UPDATE sync_identity SET replication_epoch='next-epoch',stream_identity='next-stream' WHERE workspace_id='ws'",[]).map_err(SyncError::persist)?;
                tx.execute("UPDATE moments SET author_json=?1 WHERE moment_id='seed-moment'",[&authors]).map_err(SyncError::persist)?;
                Ok::<_,SyncError>(())
            }).unwrap();
            enroll(&mut store).unwrap();
            assert_marked(&store);
        }
    }

    #[test]
    fn enrollment_exports_a_preserved_seed_head_once_without_changing_history() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);

        assert!(local_ops(&store).is_empty());
        enroll(&mut store).expect("enroll retained artifact");
        let ops = local_ops(&store);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].0, "ydoc.update");
        assert_eq!(ops[1].0, "moment.append");
        assert_eq!(ops[1].1["momentId"], "seed-moment");
        assert_eq!(ops[1].1["payloadAfterPath"], "seed-object.md");
        let head = VersionedTextStore::new(&mut store)
            .read_text("ws", "main", "seed-object.md")
            .expect("read unchanged head")
            .expect("head exists");
        assert_eq!(head.latest_moment_id, "seed-moment");
        assert_eq!(head.text, "original seed bytes\n");
        assert_eq!(ops[1].1["payloadAfterBlobSha256"], head.blob_sha256);

        store
            .write_with(&NoFaults, |tx| {
                backfill_enrolment_window_in_tx(tx, "ws", &crate::NoLiveLeases, 1_001)
            })
            .expect("repeat enrollment");
        assert_eq!(local_ops(&store), ops);
        let moments: i64 = store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |r| r.get(0)))
            .expect("moment count");
        assert_eq!(moments, 1);
    }

    fn seed_retained_artifact(store: &mut EngineStore) {
        seed_retained_artifact_as(store, "original seed bytes\n", ContentKind::Plaintext);
    }

    fn seed_retained_artifact_as(store: &mut EngineStore, text: &str, kind: ContentKind) {
        seed_retained_artifact_named(store, "seed-object", "seed-moment", text, kind);
    }

    fn seed_refused_richdoc_artifact(store: &mut EngineStore, source: &str, canonical: &str) {
        write_text(
            store,
            "main",
            "seed-object",
            "seed-moment",
            source,
            "capture",
            10,
        );
        let key = DocKey::new("ws", "main", "seed-object").expect("key");
        let path = "seed-object.md";
        let sha = dohc_engine_storage::hex_sha256(source.as_bytes());

        let projector = Ydoc::wire();
        assert!(
            projector
                .rewrite_content_to_markdown(ContentKind::Richdoc, source)
                .is_err(),
            "refused source unexpectedly accepted by the projector"
        );
        let reader = Ydoc::wire();
        assert!(
            reader
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
                .is_err(),
            "refused source unexpectedly accepted by the Rust fold reader"
        );

        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, canonical)
            .expect("canonical seed");
        doc.preserve_folded_markdown_source(source)
            .expect("source witness");
        assert_eq!(doc.preserved_markdown_source(canonical), None);
        let seed = doc.encode_full_state();
        dohc_engine_collab::record_local_update(
            store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &seed,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some(path),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                is_seed: true,
                seed_source_sha256: Some(&sha),
                ..Default::default()
            },
            &NoFaults,
            11,
            |_, _, _| Ok(()),
        )
        .expect("retain refused seed lineage");
    }

    fn seed_retained_artifact_named(
        store: &mut EngineStore,
        object_id: &str,
        moment_id: &str,
        text: &str,
        kind: ContentKind,
    ) {
        write_text(store, "main", object_id, moment_id, text, "capture", 10);
        let key = DocKey::new("ws", "main", object_id).expect("key");
        let path = format!("{object_id}.md");
        let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
        let doc = Ydoc::wire();
        let seed = doc
            .rewrite_content_to_markdown_preserving_source(kind, text)
            .expect("seed");
        dohc_engine_collab::record_local_update(
            store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &seed,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some(&path),
                    content_kind: kind,
                    regime: Regime::LocalOnly,
                }),
                is_seed: true,
                seed_source_sha256: Some(&sha),
                ..Default::default()
            },
            &NoFaults,
            11,
            |_, _, _| Ok(()),
        )
        .expect("retain seed lineage");
    }

    fn mark_head_settled(store: &mut EngineStore) {
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET settled_update_seq=head_update_seq, \
                last_settled_sha=(SELECT blob_sha256 FROM snapshots s \
                    WHERE s.workspace_id=ydoc_docs.workspace_id AND s.version_id=ydoc_docs.version_id \
                        AND s.object_id=ydoc_docs.object_id)", []).map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).expect("record settlement coverage");
    }

    fn sweep(store: &mut EngineStore, now_ms: i64) {
        crate::commit_relay_cursor(
            store,
            "ws",
            &crate::RelayCursor {
                bootstrap_complete: true,
                cursor: now_ms,
                replication_epoch: "epoch".to_owned(),
                stream_identity: "stream".to_owned(),
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &crate::NoLiveLeases,
            now_ms,
        )
        .expect("recurring sweep");
    }

    #[test]
    #[ignore = "release cursor sweep measurement"]
    fn cursor_sweep_many_retained_heads() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact_as(&mut store, "- parent\n  - nested\n", ContentKind::Richdoc);
        enroll(&mut store).expect("enroll benchmark seed");
        store.write_with(&NoFaults, |tx| (|| {
            tx.execute_batch("CREATE TEMP TABLE benchmark_ids AS WITH RECURSIVE ids(n) AS \
                (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<9999) SELECT n FROM ids;")?;
            for table in ["file_objects", "moments", "snapshots", "ydoc_docs", "ydoc_updates"] {
                let columns = tx.prepare(&format!("PRAGMA table_info({table})"))?
                    .query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()?;
                let expressions = columns.iter().map(|column| match column.as_str() {
                    "object_id" => "'bench-'||n".to_owned(),
                    "moment_id" | "latest_moment_id" => "'bench-moment-'||n".to_owned(),
                    "moment_order" => "n+1".to_owned(),
                    "path" | "payload_after_path" => "'bench-'||n||'.md'".to_owned(),
                    _ => format!("source.{column}"),
                }).collect::<Vec<_>>().join(",");
                tx.execute_batch(&format!("INSERT INTO {table} ({}) SELECT {expressions} \
                    FROM {table} source CROSS JOIN benchmark_ids WHERE source.object_id='seed-object'",
                    columns.join(",")))?;
            }
            tx.execute_batch("INSERT INTO replication_log \
                (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                SELECT 'ws','other',n,'moment.append',json_object('versionId','main', \
                    'objectId','other-'||n,'momentId','other-moment-'||n),1,0 FROM benchmark_ids;")?;
            Ok::<_, rusqlite::Error>(())
        })().map_err(SyncError::persist)).expect("bulk fixture");
        // Separate first-use cost from recurring unchanged-head cost.
        for pass in 0..4 {
            let start = std::time::Instant::now();
            sweep(&mut store, 200 + pass);
            println!(
                "CURSOR_BENCH documents=10000 moments=10000 journal_moments=9999 pass={pass} elapsed_ms={:.3}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }

    #[test]
    fn leased_head_exports_only_after_its_live_or_closing_base_is_released() {
        for closing in [false, true] {
            let (_scratch, _, mut store) = open_store();
            seed_main(&mut store);
            seed_retained_artifact(&mut store);
            let key = DocKey::new("ws", "main", "seed-object").expect("key");
            let leases = dohc_engine_collab::LeaseRegistry::new();
            let lease = leases.acquire(&key).expect("lease");
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO sync_relay_push_state VALUES ('ws','local',-1)",
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    backfill_enrolment_window_in_tx(tx, "ws", &leases, 100)
                })
                .expect("enroll leased document");
            assert!(
                local_ops(&store).is_empty(),
                "no file moment before its base"
            );
            for _ in 0..2 {
                store
                    .write_with(&NoFaults, |tx| {
                        if closing {
                            originate_closing_ydoc_base_in_tx(tx, &key, 101)
                        } else {
                            originate_live_ydoc_base_in_tx(tx, &key, 101)
                        }
                    })
                    .expect("originate session base");
            }
            assert_eq!(local_ops(&store).len(), 1, "only the base while leased");
            dohc_engine_collab::close_session(&mut store, &key, false, None, &NoFaults, 102)
                .expect("close compacts the seed");
            drop(lease);
            sweep(&mut store, 102);
            let ops = local_ops(&store);
            assert_eq!(ops.len(), 2);
            assert_eq!(ops[0].0, "ydoc.update");
            assert_eq!(ops[1].0, "moment.append");
            let (_scratch, _, mut peer) = open_store();
            seed_main(&mut peer);
            replay_from_zero(&store, &mut peer, &ops);
        }
    }

    #[test]
    fn export_candidate_query_uses_complete_object_and_moment_indexes() {
        let (_scratch, _, store) = open_store();
        let plan = store
            .read_with(|conn| {
                conn.prepare(&format!("EXPLAIN QUERY PLAN {COVERED_HEADS_SQL}"))?
                    .query_map(["ws"], |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("candidate query plan");
        assert!(
            plan.iter().any(|detail| detail.contains(
                "replication_log_moment_object (workspace_id=? AND <expr>=? AND <expr>=?)"
            )),
            "{plan:?}"
        );
        assert!(
            plan.iter()
                .any(|detail| detail
                    .contains("replication_log_moment (workspace_id=? AND <expr>=?)")),
            "{plan:?}"
        );
    }

    #[test]
    fn candidate_load_kind_and_projection_errors_do_not_abort_cursor_or_other_exports() {
        for failure in ["load", "kind", "projection", "journal"] {
            let (_scratch, _, mut store) = open_store();
            seed_main(&mut store);
            seed_refused_richdoc_artifact(&mut store, "- \n\n  - b\n - c", "- \n\n- b\n\n- c");
            enroll(&mut store).expect("originate unexportable seed base");
            let bad_bytes = if failure == "projection" {
                Ydoc::wire().plaintext_insert(
                    0,
                    &"x".repeat(dohc_engine_collab::limits::MAX_PROJECTION_BYTES + 1),
                )
            } else {
                b"invalid Y.Doc".to_vec()
            };
            let bad_sha = store
                .put_binary_blob(&bad_bytes)
                .expect("bad candidate blob");
            store.write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET export_attempt_moment_id=NULL", []).map_err(SyncError::persist)?;
                if failure == "journal" {
                    tx.execute("UPDATE moments SET author_json='invalid' WHERE moment_id='seed-moment'", [])
                        .map_err(SyncError::persist)?;
                    tx.execute("UPDATE ydoc_docs SET content_kind='plaintext'", []).map_err(SyncError::persist)?;
                    // Preserve matching document coverage so the journal's
                    // stored-author validation is the failing boundary.
                    let seed = Ydoc::wire().plaintext_insert(0, "- \n\n  - b\n - c");
                    let sha = dohc_engine_storage::put_binary_blob(tx, &seed).map_err(SyncError::Storage)?;
                    tx.execute("UPDATE ydoc_updates SET update_blob_sha256=?1", [sha]).map_err(SyncError::persist)?;
                } else if failure == "kind" {
                    tx.execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE ydoc_docs SET content_kind='invalid'; PRAGMA ignore_check_constraints=OFF;")
                        .map_err(SyncError::persist)?;
                } else {
                    tx.execute("UPDATE ydoc_updates SET update_blob_sha256=?1", [&bad_sha]).map_err(SyncError::persist)?;
                    if failure == "projection" {
                        tx.execute("UPDATE ydoc_docs SET content_kind='plaintext'", []).map_err(SyncError::persist)?;
                    }
                }
                Ok::<_, SyncError>(())
            }).expect("make failed candidate eligible");
            seed_retained_artifact_named(
                &mut store,
                "healthy",
                "healthy-moment",
                "healthy\n",
                ContentKind::Plaintext,
            );
            sweep(&mut store, 101);
            let ops = local_ops(&store);
            assert!(
                ops.iter()
                    .any(|(kind, payload)| kind == "moment.append"
                        && payload["objectId"] == "healthy"),
                "{failure}"
            );
            assert!(
                !ops.iter().any(|(kind, payload)| kind == "moment.append"
                    && payload["objectId"] == "seed-object"),
                "{failure}"
            );
            assert_eq!(
                crate::read_relay_cursor(&store, "ws")
                    .expect("cursor")
                    .expect("committed cursor")
                    .cursor,
                101
            );
            sweep(&mut store, 102);
            assert_eq!(local_ops(&store), ops);
        }
    }

    #[test]
    fn export_storage_failure_rolls_back_the_pull_cursor_and_attempt() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO sync_relay_push_state VALUES ('ws','local',-1)", [])
                .map_err(SyncError::persist)?;
            originate_live_ydoc_base_in_tx(tx, &DocKey::new("ws", "main", "seed-object").unwrap(), 100)?;
            tx.execute_batch("CREATE TRIGGER fail_export BEFORE INSERT ON replication_log \
                WHEN NEW.op_kind='moment.append' BEGIN SELECT RAISE(ABORT,'storage write failed'); END;")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).expect("prepare export write failure");
        let result = crate::commit_relay_cursor(
            &mut store,
            "ws",
            &crate::RelayCursor {
                cursor: 1,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &crate::NoLiveLeases,
            101,
        );
        assert!(matches!(result, Err(SyncError::Storage(_))));
        assert!(
            crate::read_relay_cursor(&store, "ws")
                .expect("cursor")
                .is_none()
        );
        let attempted: Option<String> = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT export_attempt_moment_id FROM ydoc_docs",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("attempt");
        assert!(attempted.is_none());
        assert_eq!(
            local_ops(&store).len(),
            1,
            "only the committed base remains"
        );
    }

    #[test]
    fn failed_projection_retries_only_after_moment_or_document_head_changes() {
        let (_scratch, path, mut store) = open_store();
        seed_main(&mut store);
        seed_refused_richdoc_artifact(&mut store, "- \n\n  - b\n - c", "- \n\n- b\n\n- c");
        mark_head_settled(&mut store);
        enroll(&mut store).expect("enroll unprojectable seed");
        observe_export_attempts(&mut store);
        sweep(&mut store, 101);
        assert_eq!(
            export_attempt_count(&store),
            0,
            "unchanged failed projection is skipped"
        );
        drop(store);
        let mut store = EngineStore::open(&path, 102).expect("reopen failed projection cache");
        sweep(&mut store, 102);
        assert_eq!(
            export_attempt_count(&store),
            0,
            "restart keeps the failed projection skipped"
        );
        write_text(
            &mut store,
            "main",
            "seed-object",
            "next-moment",
            "- \n\n  - b\n - c",
            "ydoc",
            102,
        );
        sweep(&mut store, 103);
        assert_eq!(export_attempt_count(&store), 1, "new moment is retried");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET head_update_seq=2,settled_update_seq=2",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("advance document head");
        sweep(&mut store, 104);
        assert_eq!(
            export_attempt_count(&store),
            2,
            "new document sequence is retried"
        );
        sweep(&mut store, 105);
        assert_eq!(
            export_attempt_count(&store),
            2,
            "unchanged failed head is skipped"
        );
    }

    fn export_pass(store: &mut EngineStore) {
        store
            .write_with(&NoFaults, |tx| {
                export_covered_heads_in_tx(tx, "ws", &crate::NoLiveLeases)
            })
            .expect("export pass");
    }

    fn observe_export_attempts(store: &mut EngineStore) {
        store.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE export_attempt_test(count INTEGER NOT NULL); \
                INSERT INTO export_attempt_test VALUES(0); \
                CREATE TRIGGER count_export_attempts AFTER UPDATE OF export_attempt_moment_id ON ydoc_docs \
                WHEN NEW.export_attempt_moment_id IS NOT NULL \
                BEGIN UPDATE export_attempt_test SET count=count+1; END;")
                .map_err(SyncError::persist)
        }).expect("observe attempts");
    }

    fn export_attempt_count(store: &EngineStore) -> i64 {
        store
            .read_with(|conn| {
                conn.query_row("SELECT count FROM export_attempt_test", [], |row| {
                    row.get(0)
                })
            })
            .expect("attempt count")
    }

    #[test]
    fn retained_export_retries_reseeded_lineage_on_the_same_head() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);
        let author: Option<String> = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT author_json FROM moments WHERE moment_id='seed-moment'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("original author");
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES ('ws','local',-1)", [])
                .map_err(SyncError::persist)?;
            originate_unclaimed_ydoc_bases_in_tx(tx, "ws", &crate::NoLiveLeases, 100)?;
            tx.execute("UPDATE moments SET author_json='invalid' WHERE moment_id='seed-moment'", [])
                .map_err(SyncError::persist)?;
            export_covered_heads_in_tx(tx, "ws", &crate::NoLiveLeases)
        }).expect("attempt cannot journal malformed author");
        observe_export_attempts(&mut store);
        let coordinates = |store: &EngineStore| {
            store
                .read_with(|conn| {
                    conn.query_row(
            "SELECT export_attempt_moment_id,head_update_seq,head_snapshot_seq FROM ydoc_docs", [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
        )
                })
                .expect("head coordinates")
        };
        let before = coordinates(&store);
        store
            .write_with(&NoFaults, |tx| {
                let lineage = dohc_engine_storage::put_binary_blob(tx, b"reseeded lineage")?;
                tx.execute("UPDATE ydoc_docs SET lineage_claim_id=?1", [lineage])
                    .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE moments SET author_json=?1 WHERE moment_id='seed-moment'",
                    [author],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("reseed lineage and restore journalable artifact");
        export_pass(&mut store);
        assert_eq!(
            coordinates(&store),
            before,
            "moment and head sequences did not change"
        );
        assert_eq!(
            export_attempt_count(&store),
            1,
            "new lineage retries unchanged head"
        );
        assert!(
            local_ops(&store)
                .iter()
                .any(|(kind, p)| kind == "moment.append" && p["momentId"] == "seed-moment")
        );
        export_pass(&mut store);
        assert_eq!(export_attempt_count(&store), 1);
    }

    #[test]
    fn retained_export_retries_scene_after_missing_asset_arrives() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_scene(&mut store, "scene", false);
        observe_export_attempts(&mut store);
        enroll(&mut store).expect("enroll pending scene");
        assert_eq!(export_attempt_count(&store), 1);
        assert!(
            !local_ops(&store)
                .iter()
                .any(|(kind, p)| kind == "moment.append" && p["objectId"] == "scene")
        );
        // Store and authorize the asset without changing the scene's document or moment.
        let sha = dohc_engine_storage::hex_sha256(&[1, 2, 3]);
        VersionedTextStore::new(&mut store)
            .write_binary(
                &dohc_engine_domain::WriteBinary {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "asset".to_owned(),
                    path: dohc_engine_collab::scene_asset_ref(
                        "ws",
                        "main",
                        "scene",
                        &sha,
                        "image/png",
                    )
                    .expect("ref"),
                    bytes: vec![1, 2, 3],
                    moment_id: "asset-moment".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 101,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("asset arrives");
        sweep(&mut store, 102);
        assert_eq!(
            export_attempt_count(&store),
            2,
            "asset arrival retries the scene"
        );
        assert!(
            local_ops(&store)
                .iter()
                .any(|(kind, p)| kind == "moment.append" && p["objectId"] == "scene")
        );
        sweep(&mut store, 103);
        assert_eq!(
            export_attempt_count(&store),
            2,
            "successful scene is skipped"
        );
        let wait: (Option<String>, Option<String>) = store.read_with(|conn| conn.query_row(
            "SELECT export_wait_asset_path,export_wait_asset_sha256 FROM ydoc_docs WHERE object_id='scene'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        )).expect("cleared asset wait");
        assert_eq!(wait, (None, None));
    }

    #[test]
    fn retained_export_waits_for_its_asset_before_retrying() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_scene(&mut store, "scene", false);
        observe_export_attempts(&mut store);
        enroll(&mut store).expect("enroll waiting scene");
        store_scene_asset(&mut store, "unrelated");
        for pass in 101..104 {
            sweep(&mut store, pass);
        }
        assert_eq!(
            export_attempt_count(&store),
            1,
            "unchanged missing asset must not re-project"
        );
        store_scene_asset(&mut store, "scene");
        sweep(&mut store, 104);
        sweep(&mut store, 105);
        assert_eq!(
            export_attempt_count(&store),
            2,
            "arrival wakes exactly one attempt"
        );
        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, p)| kind == "moment.append" && p["objectId"] == "scene")
                .count(),
            1
        );
    }

    #[test]
    fn retained_export_wakes_when_the_arriving_asset_head_was_retired() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_scene(&mut store, "scene", false);
        observe_export_attempts(&mut store);
        enroll(&mut store).expect("enroll waiting scene");
        store_scene_asset(&mut store, "scene");
        let sha = dohc_engine_storage::hex_sha256(&[1, 2, 3]);
        let path = dohc_engine_collab::scene_asset_ref("ws", "main", "scene", &sha, "image/png")
            .expect("ref");
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path,
                    moment_id: "asset-retired".to_owned(),
                    request_id: None,
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 102,
                },
                &NoFaults,
            )
            .expect("retire arriving asset head");
        let key = DocKey::new("ws", "main", "scene").expect("key");
        store
            .read_with(|conn| {
                let doc = dohc_engine_collab::load_doc_in(conn, &key).expect("scene");
                crate::project_ydoc_with_store(conn, &key, &doc, ContentKind::Scene)
            })
            .expect("retired history already authorizes the scene asset");
        sweep(&mut store, 103);
        assert_eq!(
            export_attempt_count(&store),
            2,
            "retired asset arrival wakes the scene"
        );
        assert!(
            local_ops(&store)
                .iter()
                .any(|(kind, p)| kind == "moment.append" && p["objectId"] == "scene")
        );
        sweep(&mut store, 104);
        assert_eq!(export_attempt_count(&store), 2);
    }

    fn store_scene_asset(store: &mut EngineStore, object_id: &str) {
        let sha = dohc_engine_storage::hex_sha256(&[1, 2, 3]);
        VersionedTextStore::new(store)
            .write_binary(
                &dohc_engine_domain::WriteBinary {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: format!("{object_id}-asset"),
                    path: dohc_engine_collab::scene_asset_ref(
                        "ws",
                        "main",
                        object_id,
                        &sha,
                        "image/png",
                    )
                    .expect("ref"),
                    bytes: vec![1, 2, 3],
                    moment_id: format!("{object_id}-asset-moment"),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 101,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("asset arrives");
    }

    #[test]
    fn retained_export_wait_selection_uses_asset_indexes() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_scene(&mut store, "scene", false);
        enroll(&mut store).expect("enroll waiting scene");
        let plan = store
            .read_with(|conn| {
                conn.prepare(&format!("EXPLAIN QUERY PLAN {COVERED_HEADS_SQL}"))?
                    .query_map(["ws"], |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("selection plan");
        for index in [
            "sqlite_autoindex_binary_blobs_1",
            "sqlite_autoindex_path_aliases_1",
            "sqlite_autoindex_snapshots_1",
            "idx_moments_version_path_order",
        ] {
            assert!(
                plan.iter().any(|line| line.contains(index)),
                "{index}: {plan:?}"
            );
        }
        assert!(
            !plan.iter().any(|line| line.starts_with("SCAN ")),
            "unexpected scan in retained export selection: {plan:?}"
        );
        for alias in ["deleted", "newer"] {
            let search = format!("SEARCH {alias} USING INDEX idx_moments_version_path_order ");
            assert!(
                plan.iter().any(|line| line.starts_with(&search)),
                "{alias} must search the partial index: {plan:?}"
            );
        }
    }

    #[test]
    fn retained_export_keeps_non_asset_permanent_projection_failure() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);
        let oversized = Ydoc::wire().plaintext_insert(
            0,
            &"x".repeat(dohc_engine_collab::limits::MAX_PROJECTION_BYTES + 1),
        );
        store
            .write_with(&NoFaults, |tx| {
                let sha = dohc_engine_storage::put_binary_blob(tx, &oversized)?;
                tx.execute("UPDATE ydoc_updates SET update_blob_sha256=?1", [sha])
                    .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("oversized projection");
        observe_export_attempts(&mut store);
        enroll(&mut store).expect("enroll oversized projection");
        assert_eq!(export_attempt_count(&store), 1);
        for pass in 101..104 {
            sweep(&mut store, pass);
        }
        assert_eq!(
            export_attempt_count(&store),
            1,
            "permanent projection failure stays cached"
        );
        assert!(
            !local_ops(&store)
                .iter()
                .any(|(kind, p)| kind == "moment.append" && p["objectId"] == "seed-object")
        );
    }

    fn seed_retained_scene(
        store: &mut EngineStore,
        object_id: &str,
        asset_present: bool,
    ) -> String {
        use dohc_engine_domain::WriteBinary;
        use serde_json::json;
        use std::collections::BTreeMap;
        let key = DocKey::new("ws", "main", object_id).expect("scene key");
        let asset_sha = dohc_engine_storage::hex_sha256(&[1, 2, 3]);
        let asset_ref =
            dohc_engine_collab::scene_asset_ref("ws", "main", object_id, &asset_sha, "image/png")
                .expect("asset ref");
        if asset_present {
            VersionedTextStore::new(store)
                .write_binary(
                    &WriteBinary {
                        workspace_id: "ws".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: format!("{object_id}-asset"),
                        path: asset_ref.clone(),
                        bytes: vec![1, 2, 3],
                        moment_id: format!("{object_id}-asset-moment"),
                        metadata_origin: "api".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .expect("save image");
        }
        let imported = dohc_engine_collab::import_portable_scene(
            &json!({
                "type":"excalidraw", "version":2, "source":"https://excalidraw.com",
                "elements":[{"id":"image", "type":"image", "version":1, "versionNonce":1,
                    "isDeleted":false, "index":"a0", "fileId":"image-file"}], "appState":{},
                "files":{"image-file":{"id":"image-file", "mimeType":"image/png", "created":1,
                    "dataURL":"data:image/png;base64,AQID"}}
            })
            .to_string(),
        )
        .expect("import scene");
        let records = BTreeMap::from([(
            "image-file".to_owned(),
            json!({"id":"image-file", "created":1,
            "mimeType":"image/png", "ref":asset_ref, "sha256":asset_sha})
            .to_string(),
        )]);
        let assets =
            dohc_engine_collab::encode_scene_asset_records(&records).expect("asset records");
        let update = dohc_engine_collab::merge_updates(&[imported.initial_update, assets])
            .expect("scene state");
        let doc = Ydoc::wire();
        doc.apply(&update).expect("apply scene");
        let content = doc
            .fold_scene()
            .portable_json_with_asset_bytes(&BTreeMap::from([(
                "image-file".to_owned(),
                vec![1, 2, 3],
            )]))
            .expect("hydrated artifact");
        write_text(
            store,
            "main",
            object_id,
            &format!("{object_id}-moment"),
            &content,
            "capture",
            11,
        );
        let sha = dohc_engine_storage::hex_sha256(content.as_bytes());
        dohc_engine_collab::record_local_update(
            store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some(&format!("{object_id}.md")),
                    content_kind: ContentKind::Scene,
                    regime: Regime::LocalOnly,
                }),
                is_seed: true,
                seed_source_sha256: Some(&sha),
                ..Default::default()
            },
            &NoFaults,
            12,
            |_, _, _| Ok(()),
        )
        .expect("retain scene");
        sha
    }

    #[test]
    fn retained_scene_with_image_exports_the_hydrated_artifact_after_its_base() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let sha = seed_retained_scene(&mut store, "scene", true);
        enroll(&mut store).expect("enroll scene");
        let ops = local_ops(&store);
        let base = ops
            .iter()
            .position(|(kind, p)| kind == "ydoc.update" && p["objectId"] == "scene")
            .expect("scene base");
        let artifact = ops
            .iter()
            .position(|(kind, p)| kind == "moment.append" && p["objectId"] == "scene")
            .expect("scene artifact");
        assert!(base < artifact);
        assert_eq!(ops[artifact].1["payloadAfterBlobSha256"], sha);
        sweep(&mut store, 102);
        assert_eq!(local_ops(&store), ops);
    }

    #[test]
    fn checked_delete_pending_preimage_does_not_abort_bootstrap() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);
        let expected = dohc_engine_storage::hex_sha256(b"original seed bytes\n");
        store.write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM materialization_jobs", []).unwrap();
            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','peer',0,'moment.append','{\"momentId\":\"seed-moment\"}',12,1)", []).unwrap();
            tx.execute("UPDATE moments SET sync_record_only=1 WHERE moment_id='seed-moment'", []).unwrap();
            let result = dohc_engine_domain::prepare_checked_delete_in_tx(tx, &dohc_engine_domain::DeleteTextFile {
                workspace_id: "ws".into(), version_id: "main".into(), path: "seed-object.md".into(), moment_id: "pending-delete".into(), request_id: None,
                metadata_origin: "restore".into(), metadata_summary: None, metadata_correlation_id: None, author_json: None, now_ms: 13,
            }, Some("seed-object"), &expected).unwrap();
            dohc_engine_storage::enqueue_delete_job(tx, &dohc_engine_storage::MaterializationJobSpec {
                job_id: "restore-delete-mat_pending-delete".into(), workspace_id: "ws".into(), target_path: "seed-object.md".into(), content_sha256: expected.clone(),
                preimage: dohc_engine_storage::Preimage::Present(expected.clone()), target_generation: result.moment.moment_order, now_ms: 13,
            }).unwrap();
            Ok::<_, SyncError>(())
        }).unwrap();
        write_text(
            &mut store,
            "main",
            "seed-object",
            "current",
            "original seed bytes\n",
            "capture",
            14,
        );
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET file_export_lane=1", [])
                    .map_err(SyncError::persist)
            })
            .unwrap();
        sweep(&mut store, 100);
        store
            .write_with(&NoFaults, |tx| backfill_file_versions_in_tx(tx, "ws"))
            .expect("bootstrap file versions must commit");
        let ops = local_ops(&store);
        assert!(
            !ops.iter()
                .any(|(kind, p)| kind == "moment.append" && p["momentId"] == "pending-delete")
        );
        assert!(
            ops.iter()
                .any(|(kind, p)| kind == "moment.append" && p["momentId"] == "current")
        );
        assert_eq!(
            crate::read_relay_cursor(&store, "ws")
                .unwrap()
                .unwrap()
                .cursor,
            100
        );
    }

    #[test]
    fn incomplete_bootstrap_does_not_export_an_unclaimed_head() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);
        crate::commit_relay_cursor(
            &mut store,
            "ws",
            &crate::RelayCursor {
                bootstrap_complete: false,
                cursor: 0,
                replication_epoch: "epoch".to_owned(),
                stream_identity: "stream".to_owned(),
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &crate::NoLiveLeases,
            100,
        )
        .expect("partial bootstrap");
        assert!(local_ops(&store).is_empty());
        sweep(&mut store, 101);
        assert_eq!(local_ops(&store).len(), 2);
    }

    #[test]
    fn normalizing_richdoc_seed_and_lenient_settle_do_not_export_unprojectable_bytes() {
        for settled in [false, true] {
            let (_scratch, _, mut store) = open_store();
            seed_main(&mut store);
            let source = "---\nid: rec\n---\n\n- \n\n  - b\n - c";
            seed_refused_richdoc_artifact(
                &mut store,
                source,
                "---\nid: rec\n---\n\n- \n\n- b\n- c",
            );
            let key = DocKey::new("ws", "main", "seed-object").expect("key");
            let doc = store
                .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
                .expect("doc");
            let projection = doc
                .project(ContentKind::Richdoc)
                .expect("projection")
                .content;
            assert_ne!(projection, source);
            assert_eq!(doc.preserved_markdown_source(&projection), None);
            if settled {
                let local_projection = store
                    .read_with(|conn| {
                        crate::project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc)
                    })
                    .expect("local projection");
                assert_eq!(
                    local_projection.content, source,
                    "the lenient snapshot fallback keeps the source locally"
                );
                mark_head_settled(&mut store);
            }
            enroll(&mut store).expect("enroll normalizing seed");
            sweep(&mut store, 101);
            let ops = local_ops(&store);
            assert_eq!(ops.len(), 1, "only the base may be exported");
            assert_eq!(ops[0].0, "ydoc.update");
            let (_scratch, _, mut peer) = open_store();
            seed_main(&mut peer);
            replay_from_zero(&store, &mut peer, &ops);
        }
    }

    #[test]
    fn busy_enrollment_exports_after_settle_despite_pending_materialization_once() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        seed_retained_artifact(&mut store);
        let key = DocKey::new("ws", "main", "seed-object").expect("key");
        let doc = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .expect("doc");
        let update = doc.plaintext_insert(0, "edited ");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend::default(),
            &NoFaults,
            12,
            |_, _, _| Ok(()),
        )
        .expect("record unsaved edits");
        enroll(&mut store).expect("enroll while unsettled");
        assert_eq!(
            local_ops(&store).len(),
            1,
            "unsettled artifact is not covered"
        );
        dohc_engine_collab::settle(&mut store, &key, "seed-object.md", &NoFaults, 101)
            .expect("settle busy document");
        write_text(
            &mut store,
            "main",
            "seed-object",
            "busy-settled",
            "edited original seed bytes\n",
            "ydoc",
            101,
        );
        mark_head_settled(&mut store);
        let pending: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM materialization_jobs WHERE status='pending'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("pending jobs");
        assert!(pending > 0);
        sweep(&mut store, 102);
        let ops = local_ops(&store);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].0, "moment.append");
        sweep(&mut store, 103);
        assert_eq!(local_ops(&store), ops);
        let (_scratch, _, mut peer) = open_store();
        seed_main(&mut peer);
        replay_from_zero(&store, &mut peer, &ops);
        // Later settlements travel through Y.Doc deltas, not enrollment exports.
        let update = doc.plaintext_insert(0, "later ");
        let marker = dohc_engine_collab::read_marker(&store, &key)
            .expect("marker")
            .expect("claimed");
        let claim = marker.lineage_claim_id.expect("claim");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend::default(),
            &NoFaults,
            104,
            |tx, _, sha| {
                crate::journal_local_op_in_tx(
                    tx,
                    "ws",
                    "ydoc.update",
                    &crate::ydoc_update_payload(
                        &key,
                        "seed-object.md",
                        ContentKind::Plaintext,
                        sha,
                        &claim,
                        None,
                        None,
                        false,
                    ),
                    104,
                )
                .expect("journal delta");
                Ok(())
            },
        )
        .expect("journal later delta");
        write_text(
            &mut store,
            "main",
            "seed-object",
            "later-head",
            "later edited original seed bytes\n",
            "ydoc",
            105,
        );
        mark_head_settled(&mut store);
        sweep(&mut store, 106);
        let later_ops = local_ops(&store);
        assert_eq!(later_ops.len(), 3);
        assert_eq!(
            later_ops[2].0, "ydoc.update",
            "later heads must not add file moments"
        );
        let (_scratch, _, mut later_peer) = open_store();
        seed_main(&mut later_peer);
        replay_from_zero(&store, &mut later_peer, &later_ops);
    }

    #[test]
    fn recurring_export_excludes_a_claim_by_another_origin_or_successor() {
        for successor in [false, true] {
            let (_scratch, _, mut store) = open_store();
            seed_main(&mut store);
            seed_retained_artifact(&mut store);
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute("UPDATE ydoc_docs SET seed_source_sha256=NULL", [])
                        .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("defer artifact coverage");
            enroll(&mut store).expect("originate base without file");
            let parent = store
                .put_binary_blob(b"parent lineage")
                .expect("parent blob");
            store.write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET seed_source_sha256=(SELECT blob_sha256 FROM snapshots), \
                    base_origin_id=?1,lineage_parent_claim_id=?2,lineage_epoch_tag=?3",
                    params![if successor { "local" } else { "peer" }, successor.then_some(&parent), successor.then(|| "e".repeat(64))])
                    .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            }).expect("another claim");
            sweep(&mut store, 101);
            assert_eq!(
                local_ops(&store).len(),
                1,
                "foreign and successor claims must not export"
            );
        }
    }

    #[test]
    fn enrollment_does_not_export_an_unproved_or_live_bound_retained_head() {
        for invalidate in [
            "UPDATE ydoc_docs SET seed_source_sha256=NULL",
            "UPDATE ydoc_docs SET head_update_seq=2",
            "UPDATE ydoc_docs SET head_snapshot_seq=1",
            "UPDATE snapshots SET blob_sha256=(SELECT sha256 FROM blobs WHERE text='rival')",
            "INSERT INTO live_device_application_bindings VALUES \
             ('relay','ws','main','seed-object','lineage','seed-object.md','[\"seed-object.md\"]',0,'host',1,'instance','connection',1)",
            "INSERT INTO replication_log \
             (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
             VALUES ('ws','peer',0,'moment.append','{\"momentId\":\"seed-moment\"}',12,1)",
            "INSERT INTO ydoc_deferred_updates \
             (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) \
             VALUES ('ws','main','seed-object','peer',0,12)",
            "INSERT INTO ydoc_owner_bindings \
             SELECT 'ws','main','seed-object',update_blob_sha256,'{}','relay',1,0,1,update_blob_sha256,1024,1000 \
             FROM ydoc_updates WHERE object_id='seed-object'",
            "INSERT INTO materialization_jobs \
             (job_id,workspace_id,target_path,content_sha256,preimage_present,target_generation,status,created_at_ms) \
             SELECT 'conflict','ws',path,blob_sha256,0,1,'conflict',12 FROM snapshots",
            "INSERT INTO conflicts \
             (workspace_id,conflict_id,path,target_version_id,source_version_id,created_at_ms,updated_at_ms, \
              status,chosen_from,metadata_origin,base_exists,base_path,current_exists,current_path, \
              current_object_id,incoming_exists,incoming_path) \
             VALUES ('ws','sync-conflict','seed-object.md','main','peer',12,12,'open','current','sync', \
              0,'seed-object.md',1,'seed-object.md','seed-object',0,'seed-object.md')",
        ] {
            let (_scratch, _, mut store) = open_store();
            seed_main(&mut store);
            seed_retained_artifact(&mut store);
            let key = DocKey::new("ws", "main", "seed-object").expect("key");
            let leases = dohc_engine_collab::LeaseRegistry::new();
            let _lease = leases.acquire(&key).expect("lease");
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO sync_relay_push_state VALUES ('ws','local',-1)",
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    backfill_enrolment_window_in_tx(tx, "ws", &leases, 100)
                })
                .expect("enroll leased document");
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,5,'rival')",
                        [dohc_engine_storage::hex_sha256(b"rival")],
                    )
                    .map_err(SyncError::persist)?;
                    tx.execute(invalidate, []).map_err(SyncError::persist)?;
                    originate_live_ydoc_base_in_tx(tx, &key, 101)?;
                    export_covered_heads_in_tx(tx, "ws", &crate::NoLiveLeases)
                })
                .expect("backfill unproved artifact");
            assert!(
                local_ops(&store)
                    .iter()
                    .all(|(kind, _)| kind != "moment.append"),
                "{invalidate}"
            );
        }
    }

    #[test]
    fn capture_history_is_superseded_when_the_same_object_gains_a_ydoc_lineage() {
        assert_enrollment_after_live_edit(false);
    }

    #[test]
    fn pruned_local_lineage_backfills_saved_file_history_instead_of_empty_state() {
        assert_enrollment_after_live_edit(true);
    }

    fn assert_enrollment_after_live_edit(close_before_enrollment: bool) {
        let (scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "live-object",
            "moment-before-live",
            "captured before live editing",
            "capture",
            10,
        );
        let key = DocKey::new("ws", "main", "live-object").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "edited in the live session");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("live-object.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            11,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("record live edit");
        store
            .write_with(&NoFaults, |tx| {
                let authors = dohc_engine_collab::author_coverage::interval_in(tx, &key, i64::MAX)
                    .map_err(SyncError::corrupt)?;
                dohc_engine_domain::write_projected_text_in_tx(
                    tx,
                    &WriteText {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        object_id: "live-object".into(),
                        path: "live-object.md".into(),
                        text: "edited in the live session".into(),
                        moment_id: "moment-live-settle".into(),
                        metadata_origin: "ydoc".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: authors.moment_json(),
                        now_ms: 12,
                        request_id: None,
                    },
                )
                .map_err(SyncError::corrupt)?;
                dohc_engine_collab::author_coverage::advance_in(tx, &key, false)
                    .map_err(SyncError::corrupt)?;
                // The close case still has to materialize its first saved artifact.
                if !close_before_enrollment {
                    tx.execute(
                        "UPDATE ydoc_docs SET last_settled_sha=(SELECT blob_sha256 FROM snapshots s \
                       WHERE s.workspace_id=ydoc_docs.workspace_id \
                         AND s.version_id=ydoc_docs.version_id AND s.object_id=ydoc_docs.object_id)",
                        [],
                    )
                    .map_err(SyncError::persist)?;
                }
                Ok::<_, SyncError>(())
            })
            .expect("record settlement coverage");

        if close_before_enrollment {
            assert_eq!(
                VersionedTextStore::new(&mut store)
                    .get_moment("ws", "moment-live-settle")
                    .unwrap()
                    .unwrap()
                    .author_json
                    .as_deref(),
                Some(r#"[{"kind":"unattributed"}]"#),
                "the saved History moment covers the actorless live edit",
            );
            let settled =
                match dohc_engine_collab::settle(&mut store, &key, "live-object.md", &NoFaults, 13)
                    .expect("settle the live document")
                {
                    dohc_engine_storage::TxnOutcome::Committed(outcome) => outcome,
                    dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
                };
            let job = store
                .load_materialization_job(&settled.job_id)
                .expect("load settlement job")
                .expect("settlement queues materialization");
            assert_eq!(
                job.preimage,
                dohc_engine_storage::Preimage::Absent,
                "the first saved artifact has not been materialized yet",
            );
            assert_eq!(
                dohc_engine_files::materialize_one(
                    &store,
                    &scratch,
                    &job,
                    &dohc_engine_files::MaterializeOptions {
                        holds: None,
                        policy: dohc_engine_files::DurabilityPolicy::none(),
                        replacer: &dohc_engine_files::StdReplacer,
                        backoff: &dohc_engine_files::NoBackoff,
                        now_ms: 14,
                        faults: &NoFaults,
                    },
                )
                .expect("materialize the saved document"),
                dohc_engine_files::JobOutcome::Completed
            );
            assert_eq!(
                std::fs::read(scratch.join("live-object.md")).expect("read saved document"),
                b"edited in the live session"
            );
            assert!(matches!(
                dohc_engine_collab::close_session(&mut store, &key, false, None, &NoFaults, 15)
                    .expect("close the saved local document"),
                dohc_engine_storage::TxnOutcome::Committed(
                    dohc_engine_collab::CloseOutcome::Pruned { .. }
                )
            ));
        }
        enroll(&mut store).expect("enroll after settle");

        let ops = local_ops(&store);
        let (_peer_scratch, _, mut peer) = open_store();
        seed_main(&mut peer);
        replay_from_zero(&store, &mut peer, &ops);
        let peer_text: String = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' \
                       AND s.object_id='live-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("clean peer head");
        assert_eq!(peer_text, "edited in the live session");
        assert_eq!(
            ops.iter().filter(|(kind, _)| kind == "ydoc.update").count(),
            usize::from(!close_before_enrollment),
            "only retained CRDT state may originate a live baseline"
        );
        assert_eq!(
            ops.iter()
                .filter(|(kind, _)| kind == "moment.append")
                .count(),
            if close_before_enrollment { 2 } else { 1 }
        );
    }

    fn replay_from_zero(
        store: &EngineStore,
        peer: &mut EngineStore,
        ops: &[(String, serde_json::Value)],
    ) {
        for (origin_seq, (kind, payload)) in ops.iter().enumerate() {
            if kind == "ydoc.update" {
                let sha = payload["updateBlobSha256"]
                    .as_str()
                    .expect("Y.Doc blob sha");
                let bytes = store
                    .get_binary_blob(sha)
                    .expect("read Y.Doc blob")
                    .expect("Y.Doc blob exists");
                assert_eq!(peer.put_binary_blob(&bytes).expect("copy Y.Doc blob"), sha);
            } else if kind == "moment.append" {
                for field in ["payloadBeforeBlobSha256", "payloadAfterBlobSha256"] {
                    let Some(sha) = payload[field].as_str() else {
                        continue;
                    };
                    let (byte_length, text): (i64, String) = store
                        .read_with(|conn| {
                            conn.query_row(
                                "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                                [sha],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                        })
                        .expect("read moment blob");
                    peer.write_with(&NoFaults, |tx| {
                        tx.execute(
                            "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                            params![sha, byte_length, text],
                        )
                        .map_err(SyncError::persist)?;
                        Ok::<_, SyncError>(())
                    })
                    .expect("copy moment blob");
                }
            }
            crate::apply_replication_envelope(
                peer,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &crate::ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: "ws".to_owned(),
                    origin_id: "source".to_owned(),
                    origin_seq: origin_seq as i64,
                    relay_seq: (kind == "ydoc.update").then_some(origin_seq as i64 + 1),
                    op_kind: kind.clone(),
                    payload: payload.clone(),
                    recorded_at_ms: 20 + origin_seq as i64,
                },
                &NoFaults,
                &crate::NoLiveLeases,
            )
            .expect("clean peer replays backfilled op");
        }
        let conflicts: i64 = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM conflicts WHERE status='open'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("conflict count");
        assert_eq!(conflicts, 0, "full sync replay must not open a conflict");
    }

    #[test]
    fn secret_backfill_uses_each_moments_retained_ciphertext() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let first = b"historical secret";
        let latest = b"current secret";
        store
            .write_with(&NoFaults, |tx| {
                for (order, id, bytes) in [
                    (1_i64, "moment-first", first.as_slice()),
                    (2_i64, "moment-latest", latest.as_slice()),
                ] {
                    tx.execute(
                        "INSERT INTO secret_moments \
                         (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,after_present,after_iv_base64,after_auth_tag_base64,after_ciphertext_base64,after_byte_length) \
                         VALUES ('ws',?1,?2,'main','.env',?1,'write','api',1,?3,?4,?5,?6)",
                        params![
                            order,
                            id,
                            STANDARD.encode([1_u8; 12]),
                            STANDARD.encode([2_u8; 16]),
                            STANDARD.encode(bytes),
                            bytes.len() as i64,
                        ],
                    )
                    .map_err(SyncError::persist)?;
                }
                tx.execute(
                    "INSERT INTO secret_files \
                     (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                     VALUES ('ws','main','.env',?1,?2,?3,?4,2,'moment-latest')",
                    params![
                        STANDARD.encode([1_u8; 12]),
                        STANDARD.encode([2_u8; 16]),
                        STANDARD.encode(latest),
                        latest.len() as i64,
                    ],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed secret history");

        enroll(&mut store).expect("enroll");

        let shas = local_ops(&store)
            .into_iter()
            .filter(|(kind, _)| kind == "secret.file.put")
            .map(|(_, payload)| {
                payload["ciphertextSha256"]
                    .as_str()
                    .expect("ciphertext sha")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            shas,
            [
                dohc_engine_storage::hex_sha256(first),
                dohc_engine_storage::hex_sha256(latest),
            ]
        );
    }

    #[test]
    fn secret_write_then_delete_backfills_without_delete_ciphertext() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(&mut store, &key, "main", "moment-secret-put", "token", 10);
        SecretFileStore::new(&mut store, &key)
            .delete_secret_file(
                &SecretDelete {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: ".env".to_owned(),
                    moment_id: "moment-secret-delete".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 11,
                },
                &NoFaults,
            )
            .expect("delete secret")
            .expect("delete moment");

        enroll(&mut store).expect("enroll");

        let kinds = local_ops(&store)
            .into_iter()
            .filter_map(|(kind, _)| kind.starts_with("secret.file.").then_some(kind))
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["secret.file.put", "secret.file.delete"]);
    }

    #[test]
    fn named_version_is_backfilled_before_its_ydoc_base() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let key = DocKey::new("ws", "named", "forked").expect("key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "base");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("forked.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            21,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("named ydoc");

        enroll(&mut store).expect("enroll");

        let kinds = local_ops(&store)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect::<Vec<_>>();
        let version = kinds
            .iter()
            .position(|kind| kind == "version.create")
            .expect("version.create");
        let base = kinds
            .iter()
            .position(|kind| kind == "ydoc.update")
            .expect("ydoc.update");
        assert!(
            version < base,
            "the target version must exist before its Y.Doc base"
        );
    }

    #[test]
    fn forked_ydoc_base_fast_forwards_its_shipped_ancestor() {
        let (_source_scratch, _, mut source) = open_store();
        seed_main(&mut source);
        write_text(
            &mut source,
            "main",
            "forked-history",
            "moment-base",
            "base",
            "ydoc",
            10,
        );
        VersionedTextStore::new(&mut source)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named-history".to_owned(),
                    name: "Named history".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let key = DocKey::new("ws", "named-history", "forked-history").expect("key");
        let doc = Ydoc::wire();
        let base_update = doc.plaintext_insert(0, "base");
        dohc_engine_collab::record_local_update(
            &mut source,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &base_update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("forked-history.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            21,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("named Y.Doc base state");
        let post_fork_update = doc.plaintext_insert(4, " plus edit");
        dohc_engine_collab::record_local_update(
            &mut source,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &post_fork_update,
            dohc_engine_collab::LocalAppend::default(),
            &NoFaults,
            22,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("post-fork Y.Doc edit");
        enroll(&mut source).expect("source enrolls");

        let ops = local_ops(&source);
        let version_payload = ops
            .iter()
            .find_map(|(kind, payload)| (kind == "version.create").then_some(payload.clone()))
            .expect("version.create payload");
        assert_eq!(
            version_payload["forkSnapshots"][0]["metadata"]["origin"], "ydoc",
            "the shipped fork snapshot must identify its Y.Doc ancestry"
        );
        let base_payload = ops
            .iter()
            .find_map(|(kind, payload)| (kind == "ydoc.update").then_some(payload.clone()))
            .expect("Y.Doc base payload");
        let base_sha = base_payload["updateBlobSha256"].as_str().expect("base sha");
        let base_bytes = source
            .get_binary_blob(base_sha)
            .expect("read base")
            .expect("base exists");

        let (_peer_scratch, _, mut peer) = open_store();
        seed_main(&mut peer);
        let fork_sha = dohc_engine_storage::hex_sha256(b"base");
        peer.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, 4, 'base')",
                [&fork_sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("copy fork snapshot blob");
        assert_eq!(
            peer.put_binary_blob(&base_bytes).expect("copy base"),
            base_sha
        );
        crate::apply_version_envelope(
            &mut peer,
            &crate::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 0,
                relay_seq: None,
                op_kind: "version.create".to_owned(),
                payload: version_payload,
                recorded_at_ms: 20,
            },
            &NoFaults,
        )
        .expect("peer applies version.create");
        let outcome = crate::apply_ydoc_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &crate::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "ws".to_owned(),
                origin_id: "peer".to_owned(),
                origin_seq: 1,
                relay_seq: Some(2),
                op_kind: "ydoc.update".to_owned(),
                payload: base_payload,
                recorded_at_ms: 22,
            },
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .expect("peer applies Y.Doc base");
        assert_eq!(
            outcome,
            crate::ApplyOutcome::new(crate::ApplyDisposition::Applied(crate::YdocApplyResult {
                deferred: false,
                reason: None,
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: Vec::new(),
            })),
            "the Y.Doc base must fast-forward its shipped fork ancestor"
        );
    }

    #[test]
    fn named_version_parent_is_backfilled_before_same_time_child() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "zzz-parent".to_owned(),
                    name: "Parent".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("parent version");
        versions
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "zzz-parent".to_owned(),
                    new_version_id: "aaa-child".to_owned(),
                    name: "Child".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("child version");

        enroll(&mut store).expect("enroll");

        let version_ids = local_ops(&store)
            .into_iter()
            .filter_map(|(kind, payload)| {
                (kind == "version.create").then(|| {
                    payload["versionId"]
                        .as_str()
                        .expect("version id")
                        .to_owned()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            version_ids,
            ["zzz-parent", "aaa-child"],
            "a fork parent must be journaled before its child"
        );
    }

    #[test]
    fn moment_backfill_follows_durable_moment_order() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store, "main", "first", "moment-z", "first", "capture", 10,
        );
        write_text(
            &mut store, "main", "second", "moment-a", "second", "capture", 10,
        );

        enroll(&mut store).expect("enroll");

        let ids = local_ops(&store)
            .into_iter()
            .filter(|(kind, _)| kind == "moment.append")
            .map(|(_, payload)| payload["momentId"].as_str().expect("moment id").to_owned())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["moment-z", "moment-a"]);
    }

    #[test]
    fn delayed_version_backfill_uses_the_frozen_fork_base() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        let base_sha = dohc_engine_storage::hex_sha256(b"base");
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        write_text(
            &mut store,
            "named",
            "forked",
            "moment-edit",
            "edited",
            "capture",
            30,
        );

        enroll(&mut store).expect("enroll");

        let fork_sha = local_ops(&store)
            .into_iter()
            .find(|(kind, payload)| kind == "version.create" && payload["versionId"] == "named")
            .expect("named version op")
            .1["forkSnapshots"][0]["blobSha256"]
            .as_str()
            .expect("fork sha")
            .to_owned();
        assert_eq!(
            fork_sha, base_sha,
            "the delayed op must ship the fork-time state"
        );
    }

    #[test]
    fn delayed_secret_fork_backfill_uses_the_frozen_fork_base() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(&mut store, &key, "main", "moment-secret-base", "base", 10);
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        let frozen_ciphertext: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT ciphertext_base64 FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='named' AND path='.env'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("frozen secret base");
        let frozen_sha = dohc_engine_storage::hex_sha256(
            &STANDARD
                .decode(frozen_ciphertext)
                .expect("frozen ciphertext is base64"),
        );
        write_secret(
            &mut store,
            &key,
            "named",
            "moment-secret-edit",
            "edited",
            30,
        );

        enroll(&mut store).expect("enroll");

        let fork_payload = local_ops(&store)
            .into_iter()
            .find(|(kind, payload)| {
                kind == "secret.version.fork" && payload["toVersionId"] == "named"
            })
            .expect("secret fork op")
            .1;
        let fork_sha = fork_payload["rows"][0]["ciphertextSha256"]
            .as_str()
            .expect("fork ciphertext sha")
            .to_owned();
        assert_eq!(
            fork_sha, frozen_sha,
            "the delayed secret fork must ship the fork-time ciphertext"
        );
        assert_eq!(fork_payload["rows"][0]["updatedAtMs"], 10);
    }

    #[test]
    fn main_version_is_never_backfilled_as_a_named_fork() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "only",
            "moment-only",
            "only",
            "capture",
            10,
        );

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, _)| kind == "version.create")
                .count(),
            0
        );
    }

    #[test]
    fn already_journaled_named_version_is_not_backfilled_twice() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "forked",
            "moment-base",
            "base",
            "capture",
            10,
        );
        let record = VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        store
            .write_with(&NoFaults, |tx| journal_version_create_in_tx(tx, &record))
            .expect("journal named version");

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "version.create" && payload["versionId"] == "named"
                })
                .count(),
            1
        );
    }

    /// An older build captured Finder's `.DS_Store`. A version forked over
    /// that head ships every other head, and leaves the ignored path out.
    #[test]
    fn a_fork_leaves_heads_at_ignored_paths_out() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        write_text(
            &mut store,
            "main",
            "notes",
            "moment-notes",
            "notes",
            "capture",
            10,
        );
        write_text(
            &mut store,
            "main",
            "finder",
            "moment-finder",
            "finder",
            "capture",
            11,
        );
        store
            .write_with(&NoFaults, |tx| {
                for table in ["snapshots", "path_aliases"] {
                    tx.execute(
                        &format!("UPDATE {table} SET path='.DS_Store' WHERE path='finder.md'"),
                        [],
                    )
                    .map_err(crate::SyncError::persist)?;
                }
                Ok::<_, crate::SyncError>(())
            })
            .expect("an older build's head");
        let record = VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: "ws".to_owned(),
                    from_version_id: "main".to_owned(),
                    new_version_id: "named".to_owned(),
                    name: "Named".to_owned(),
                    now_ms: 20,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("named version");
        store
            .write_with(&NoFaults, |tx| journal_version_create_in_tx(tx, &record))
            .expect("journal named version");

        let shipped: Vec<serde_json::Value> = local_ops(&store)
            .into_iter()
            .filter(|(kind, _)| kind == "version.create")
            .flat_map(|(_, payload)| payload["forkSnapshots"].as_array().cloned().unwrap())
            .map(|snapshot| snapshot["path"].clone())
            .collect();
        assert_eq!(shipped, vec![serde_json::json!("notes.md")]);
    }

    #[test]
    fn imported_secret_moments_are_not_echoed_by_enrolment() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let imported = crate::ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            relay_seq: None,
            op_kind: "secret.file.delete".to_owned(),
            payload: serde_json::json!({
                "versionId": "main",
                "path": ".env",
                "metadata": {"origin": "sync"}
            }),
            recorded_at_ms: 10,
        };
        assert!(matches!(
            crate::apply_secret_envelope(&mut store, &imported, &NoFaults),
            Ok(crate::ApplyOutcome {
                primary: crate::ApplyDisposition::Applied(()),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        let source: (Option<String>, Option<i64>) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT source_origin_id,source_origin_seq FROM secret_moments \
                     WHERE workspace_id='ws' AND path='.env'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("imported secret provenance");
        assert_eq!(source, (Some("peer".to_owned()), Some(0)));

        enroll(&mut store).expect("enroll");

        assert!(
            local_ops(&store)
                .iter()
                .all(|(kind, _)| kind != "secret.file.delete")
        );
    }

    #[test]
    fn imported_secret_coordinates_cannot_hide_an_unrelated_local_moment() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(
            &mut store,
            &key,
            "main",
            "local-secret-collision",
            "genuinely local content",
            10,
        );
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     VALUES ('ws','unrelated-peer',91,'secret.file.put',?1,10,1)",
                    [serde_json::json!({
                        "versionId": "main",
                        "path": ".env",
                        "metadata": {"origin": "sync"},
                        "ciphertextSha256": "unrelated-imported-content",
                    })
                    .to_string()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed colliding imported coordinate");

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, payload)| {
                    kind == "secret.file.put" && payload["versionId"] == "main"
                })
                .count(),
            1,
            "an imported timestamp and payload correlation must not hide a local secret moment"
        );
    }

    #[test]
    fn caller_chosen_secret_sync_prefix_does_not_hide_a_local_secret_write() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        let key = secret_key();
        write_secret(
            &mut store,
            &key,
            "main",
            "secret-sync-caller-chosen",
            "local secret",
            10,
        );

        enroll(&mut store).expect("enroll");

        assert_eq!(
            local_ops(&store)
                .iter()
                .filter(|(kind, _)| kind == "secret.file.put")
                .count(),
            1,
            "caller-controlled text must not forge imported provenance"
        );
    }

    #[test]
    fn every_sync_pass_surfaces_a_declined_ydoc_base_until_it_is_claimed() {
        let (_scratch, _, mut store) = open_store();
        seed_main(&mut store);
        enroll(&mut store).expect("enroll before the local Y.Doc append");
        write_text(
            &mut store,
            "main",
            "oversized",
            "moment-oversized",
            "seed",
            "ydoc",
            10,
        );
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, &"x".repeat(21_000_000));
        let full_state = doc.encode_full_state();
        assert!(
            full_state.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
            "the fixture must cross the base limit"
        );
        let state_sha = store
            .put_binary_blob(&full_state)
            .expect("store full state");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO ydoc_docs \
                     (workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,lineage_claim_status,updated_at_ms,path) \
                     VALUES ('ws','main','oversized','plaintext','local-only',1,0,'unclaimed',11,'oversized.md')",
                    [],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO ydoc_updates \
                     (workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) \
                     VALUES ('ws','main','oversized',1,?1,11)",
                    [state_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed oversized local lineage");

        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET seed_source_sha256=(SELECT blob_sha256 FROM snapshots WHERE object_id='oversized') WHERE object_id='oversized'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).expect("record oversized seed coverage");
        let cursor = crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 0,
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            settlement_report_id: None,
            ordinary_pull: None,
        };
        let declines = match crate::commit_relay_cursor(
            &mut store,
            "ws",
            &cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_000,
        )
        .expect("commit relay cursor after the local append")
        {
            dohc_engine_storage::TxnOutcome::Committed(declines) => declines.sharing_declined,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };

        store
            .write_with(&NoFaults, |tx| backfill_file_versions_in_tx(tx, "ws"))
            .unwrap();
        assert!(
            local_ops(&store)
                .iter()
                .any(|(kind, _)| kind == "moment.append"),
            "a declined lineage exports its saved file version at the next push cut"
        );
        assert_eq!(declines.len(), 1, "the caller receives the declined base");
        assert_eq!(declines[0].constraint, "MAX_YDOC_UPDATE_BYTES");
        assert!(declines[0].observed_bytes > declines[0].limit_bytes);

        let pushed_declines = match crate::cursor::write_pushed_seq(
            &mut store,
            "ws",
            "local",
            0,
            &NoFaults,
            &crate::NoLiveLeases,
            1_001,
        )
        .expect("advance a pushed origin after enrolment")
        {
            dohc_engine_storage::TxnOutcome::Committed(declines) => declines,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };
        assert!(
            pushed_declines.is_empty(),
            "pushed-origin updates must not repeat the per-pass full-state scan"
        );

        let next_cursor = crate::RelayCursor {
            cursor: 1,
            ..cursor
        };
        let next_declines = match crate::commit_relay_cursor(
            &mut store,
            "ws",
            &next_cursor,
            &NoFaults,
            &crate::NoLiveLeases,
            1_002,
        )
        .expect("commit next relay cursor")
        {
            dohc_engine_storage::TxnOutcome::Committed(declines) => declines.sharing_declined,
            dohc_engine_storage::TxnOutcome::Crashed { .. } => panic!("no injected crash"),
        };

        assert_eq!(
            next_declines, declines,
            "the unresolved base remains visible on every successful sync pass"
        );
    }
}
