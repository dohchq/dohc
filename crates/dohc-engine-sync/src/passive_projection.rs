//! Private plaintext cuts. Every update is still admitted and projected by
//! the ordinary reducer; only its History write waits for the batch boundary.

use dohc_engine_collab::{ContentKind, DocKey, load_doc_prefix_in};
use dohc_engine_domain::{WriteText, validate_write_input, write_projected_text_in_tx};
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::{ReplicationEnvelope, SyncError};

pub(crate) fn stage(
    tx: &Transaction<'_>,
    input: &WriteText,
    claim: &str,
    origin: &str,
    seq: i64,
) -> Result<bool, SyncError> {
    validate_write_input(input).map_err(|error| {
        crate::ydoc_apply::map_domain_payload_error(error, "ydoc.update projection write failed")
    })?;
    let sha = dohc_engine_storage::hex_sha256(input.text.as_bytes());
    let through: i64 = tx
        .query_row(
            "SELECT head_update_seq FROM ydoc_docs \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![input.workspace_id, input.version_id, input.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let previous: Option<String> = tx
        .query_row(
            "SELECT blob_sha256 FROM passive_pending_projection WHERE workspace_id=?1",
            [&input.workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let same = match previous {
        Some(previous) => previous == sha,
        None => {
            tx.query_row(
                "SELECT s.blob_sha256 FROM snapshots s \
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3",
                params![input.workspace_id, input.version_id, input.object_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(SyncError::corrupt)?
                == sha
        }
    };
    if !same {
        tx.execute(
            "INSERT OR IGNORE INTO passive_projection_receipts \
            SELECT workspace_id,moment_id,version_id,object_id,path,blob_sha256 \
            FROM passive_pending_projection WHERE workspace_id=?1",
            [&input.workspace_id],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "INSERT INTO passive_pending_projection \
             (workspace_id,version_id,object_id,path,blob_sha256,moment_id,author_json,recorded_at_ms,lineage_claim_id,origin_id,origin_seq,through_seq) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
             ON CONFLICT(workspace_id) DO UPDATE SET text=NULL,blob_sha256=excluded.blob_sha256, \
             through_seq=excluded.through_seq,moment_id=excluded.moment_id, \
             author_json=excluded.author_json,recorded_at_ms=excluded.recorded_at_ms, \
             origin_id=excluded.origin_id,origin_seq=excluded.origin_seq",
            params![input.workspace_id,input.version_id,input.object_id,input.path,sha,
                input.moment_id,input.author_json,input.now_ms,claim,origin,seq,through],
        ).map_err(SyncError::persist)?;
    } else {
        tx.execute(
            "UPDATE passive_pending_projection SET through_seq=?2,text=NULL WHERE workspace_id=?1",
            params![input.workspace_id, through],
        )
        .map_err(SyncError::persist)?;
    }
    dohc_engine_collab::author_coverage::advance_in(
        tx,
        &DocKey::new(
            input.workspace_id.clone(),
            input.version_id.clone(),
            input.object_id.clone(),
        )
        .map_err(crate::ydoc_apply::map_collab_hard_error)?,
        false,
    )
    .map_err(crate::ydoc_apply::map_collab_hard_error)?;
    tx.execute(
        "UPDATE ydoc_docs SET updated_at_ms=?4,path=?5 \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            input.workspace_id,
            input.version_id,
            input.object_id,
            input.now_ms,
            input.path
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(!same)
}

fn pending_text(conn: &rusqlite::Connection, key: &DocKey) -> Result<Option<String>, SyncError> {
    let row: Option<(Option<String>, String, i64, String)> = conn
        .query_row(
            "SELECT text,blob_sha256,through_seq,lineage_claim_id FROM passive_pending_projection \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((text, sha, through, claim)) = row else {
        return Ok(None);
    };
    let marker = dohc_engine_collab::read_marker_in(conn, key)
        .map_err(crate::ydoc_apply::map_collab_hard_error)?;
    if marker
        .as_ref()
        .and_then(|marker| marker.lineage_claim_id.as_deref())
        != Some(claim.as_str())
    {
        return Err(crate::error::local_corruption(
            "pending projection changed lineage",
        ));
    }
    let text = match text {
        Some(text) => text,
        None => {
            load_doc_prefix_in(conn, key, through)
                .and_then(|doc| doc.project(ContentKind::Plaintext))
                .map_err(crate::ydoc_apply::map_collab_hard_error)?
                .content
        }
    };
    if dohc_engine_storage::hex_sha256(text.as_bytes()) != sha {
        return Err(crate::error::local_corruption(
            "pending projection digest changed",
        ));
    }
    Ok(Some(text))
}

/// Freeze the last valid text before a refused or dependency-incomplete append
/// can be compacted past it. Ordinary successful cuts need only a frontier.
pub(crate) fn freeze(tx: &Transaction<'_>, key: &DocKey) -> Result<(), SyncError> {
    if let Some(text) = pending_text(tx, key)? {
        tx.execute(
            "UPDATE passive_pending_projection SET text=?4 \
            WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND text IS NULL",
            params![key.workspace_id, key.version_id, key.object_id, text],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

pub(crate) fn receipt_exists(
    conn: &rusqlite::Connection,
    workspace: &str,
    id: &str,
) -> Result<bool, SyncError> {
    if !id.starts_with("moment-ydoc-apply-") || !private_connection(conn)? {
        return Ok(false);
    }
    conn.query_row("SELECT EXISTS(SELECT 1 FROM passive_projection_receipts WHERE workspace_id=?1 AND moment_id=?2)",
        params![workspace,id],|row|row.get(0)).map_err(SyncError::corrupt)
}

pub(crate) fn holds_content(
    conn: &rusqlite::Connection,
    key: &DocKey,
    sha: &str,
) -> Result<bool, SyncError> {
    if !private_connection(conn)? {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM passive_projection_receipts \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND blob_sha256=?4)",
        params![key.workspace_id, key.version_id, key.object_id, sha],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

pub(crate) fn holds_artifact(
    conn: &rusqlite::Connection,
    key: &DocKey,
    id: &str,
    path: &str,
    sha: &str,
) -> Result<bool, SyncError> {
    if !id.starts_with("moment-ydoc-apply-") || !private_connection(conn)? {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM passive_projection_receipts \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
           AND moment_id=?4 AND path=?5 AND blob_sha256=?6)",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            id,
            path,
            sha
        ],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

fn private_connection(conn: &rusqlite::Connection) -> Result<bool, SyncError> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_temp_schema WHERE type='trigger' AND name='passive_no_local_ops')",
        [],|row|row.get(0)).map_err(SyncError::corrupt)
}

/// A structural row may consume the settled head. It must see the preceding
/// valid projection, including when the next row is refused.
pub(crate) fn before_row(
    store: &mut EngineStore,
    op: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<(), SyncError> {
    if !store.is_passive() {
        return Ok(());
    }
    let continues = store.read_with(|conn| {
        conn.query_row(
            "SELECT version_id,object_id,path,lineage_claim_id FROM passive_pending_projection WHERE workspace_id=?1",
            [&op.workspace_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)),
        ).optional().map_err(SyncError::corrupt)
    })?.is_none_or(|(version,object,path,claim)| {
        op.op_kind == "ydoc.update" && op.payload["isBaseState"] != true
            && op.payload["contentKind"] == "plaintext"
            && op.payload["versionId"] == version && op.payload["objectId"] == object
            && op.payload["path"] == path && op.payload["lineageClaimId"] == claim
    });
    let collision = if continues && op.op_kind == "ydoc.update" {
        match (
            op.payload["versionId"].as_str(),
            op.payload["objectId"].as_str(),
            op.payload["path"].as_str(),
        ) {
            (Some(version), Some(object), Some(path)) => {
                let key = DocKey::new(
                    op.workspace_id.clone(),
                    version.to_owned(),
                    object.to_owned(),
                );
                if let Ok(key) = key {
                    let id = crate::ydoc_apply::ydoc_apply_moment_id(
                        &key,
                        path,
                        &op.origin_id,
                        op.origin_seq,
                    );
                    store.read_with(|conn| conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2) \
                     OR EXISTS(SELECT 1 FROM secret_moments WHERE workspace_id=?1 AND moment_id=?2)",
                        params![op.workspace_id,id],|row| row.get::<_,bool>(0),
                    ).map_err(SyncError::corrupt))?
                } else {
                    // The ordinary row handler owns malformed-input refusals.
                    false
                }
            }
            _ => false,
        }
    } else {
        false
    };
    if !continues || collision {
        flush(store, &op.workspace_id, faults)?;
    }
    Ok(())
}

pub(crate) fn flush(
    store: &mut EngineStore,
    workspace: &str,
    faults: &dyn FaultInjector,
) -> Result<(), SyncError> {
    if !store.is_passive() {
        return Ok(());
    }
    let pending = store.read_with(|conn| conn.query_row(
        "SELECT version_id,object_id,path,text,moment_id,author_json,recorded_at_ms,origin_id,origin_seq \
         FROM passive_pending_projection WHERE workspace_id=?1",
        [workspace], |row| Ok((WriteText {
            workspace_id: workspace.to_owned(),version_id:row.get(0)?,object_id:row.get(1)?,
            path:row.get(2)?,text:row.get::<_,Option<String>>(3)?.unwrap_or_default(),moment_id:row.get(4)?,author_json:row.get(5)?,
            now_ms:row.get(6)?,metadata_origin:"ydoc".into(),metadata_summary:None,
            metadata_correlation_id:None,request_id:None,
        },row.get::<_,String>(7)?,row.get::<_,i64>(8)?)),
    ).optional().map_err(SyncError::corrupt))?;
    let Some((mut input, origin, seq)) = pending else {
        return Ok(());
    };
    let key = DocKey::new(
        input.workspace_id.clone(),
        input.version_id.clone(),
        input.object_id.clone(),
    )
    .map_err(crate::ydoc_apply::map_collab_hard_error)?;
    input.text = store
        .read_with(|conn| pending_text(conn, &key))?
        .ok_or_else(|| crate::error::local_corruption("pending projection disappeared"))?;
    let policy = crate::file_search::search_policy_for_store(store);
    let result = store.write_with(faults, |tx| {
        let result = write_projected_text_in_tx(tx, &input)
            .map_err(crate::ydoc_apply::map_domain_hard_error)?;
        crate::live_audit::annotate_projected_moment_in_tx(tx, &key, &input.path, &origin, seq)?;
        crate::file_search::upsert_file_search_index(
            tx,
            workspace,
            &input.version_id,
            &input.object_id,
            &input.path,
            Some(&input.text),
            policy.as_ref(),
        )?;
        tx.execute(
            "UPDATE ydoc_docs SET settle_seq=?4,last_settled_sha=?5 \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![
                workspace,
                input.version_id,
                input.object_id,
                result.moment.moment_order,
                result.snapshot.blob_sha256
            ],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "DELETE FROM passive_pending_projection WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })?;
    match result {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}
