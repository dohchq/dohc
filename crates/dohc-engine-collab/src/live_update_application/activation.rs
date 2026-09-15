use super::*;
use crate::{ContentKind, Ydoc};

/// A source read and retained by the native actor after ordinary cursor commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedOwnerSource {
    pub version: u32,
    pub relay_database_namespace: String,
    pub workspace_id: String,
    pub main_version_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
    pub current_path: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub committed_cursor: i64,
    pub base_origin_id: String,
    pub base_origin_seq: i64,
    pub base_relay_seq: i64,
    pub source_moment_id: String,
    pub source_digest: String,
    pub source_byte_length: i64,
    pub native_head_sequence: i64,
    pub full_state_digest: String,
    pub full_state_byte_length: usize,
}

#[derive(Debug)]
pub struct ImportedOwnerActivation {
    pub activation_id: String,
    pub source: ImportedOwnerSource,
    pub baseline_bytes: Vec<u8>,
    pub full_state: Vec<u8>,
    pub restore_generation: Option<i64>,
}

pub fn release_imported_owner_activation(
    store: &mut EngineStore,
    namespace: &str,
    workspace_id: &str,
    activation_id: &str,
    session: Option<(&DocKey, &str)>,
    faults: &dyn FaultInjector,
) -> Result<(), ApplicationError> {
    let outcome = store.write_with(faults, |tx| {
        let removed: Option<String> = tx
            .query_row(
                "DELETE FROM ydoc_owner_activation_sources AS a WHERE a.activation_id=?1
             AND a.relay_database_namespace=?2 AND a.workspace_id=?3
             AND (?4 IS NULL OR (a.version_id=?4 AND a.object_id=?5 AND a.lineage_claim_id=?6))
             AND NOT EXISTS(SELECT 1 FROM live_owner_adoptions adopted
                 WHERE adopted.workspace_id=a.workspace_id AND adopted.main_version_id=a.version_id
                 AND adopted.object_id=a.object_id AND adopted.lineage_claim_id=a.lineage_claim_id
                 AND adopted.relay_database_namespace=a.relay_database_namespace) RETURNING full_state_digest",
                params![
                    activation_id,
                    namespace,
                    workspace_id,
                    session.map(|(key, _)| key.version_id.as_str()),
                    session.map(|(key, _)| key.object_id.as_str()),
                    session.map(|(_, lineage)| lineage)
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(write_sql)?;
        if let Some(digest) = removed {
            match tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&digest]) {
                Ok(_) => (),
                Err(rusqlite::Error::SqliteFailure(error, message))
                    if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
                        || (error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
                            && message.as_deref() == Some("FOREIGN KEY constraint failed")) => {}
                Err(error) => return Err(write_sql(error)),
            }
        } else {
            let retained: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_owner_activation_sources WHERE activation_id=?1)",
                [activation_id], |row| row.get(0),
            ).map_err(read_sql)?;
            if session.is_some() || retained {
                return Err(ApplicationError::Conflict);
            }
        }
        Ok(())
    })?;
    match outcome {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn capture_imported_owner_activation(
    store: &mut EngineStore,
    namespace: &str,
    key: &DocKey,
    path: &str,
    max_bytes: usize,
    faults: &dyn FaultInjector,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    identifier(namespace, 1024)?;
    if key.version_id != "main" || max_bytes == 0 {
        return Err(invalid("invalid ordinary activation capture"));
    }
    let result = store.write_with(faults, |tx| {
        let marker = durable::read_marker_in(tx, key)?.ok_or(ApplicationError::Conflict)?;
        if marker.content_kind != ContentKind::Richdoc || marker.regime != Regime::Replicated
            || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
            || marker.path.as_deref() != Some(path)
        { return Err(ApplicationError::Conflict); }
        let lineage = marker.lineage_claim_id.clone().ok_or(ApplicationError::Conflict)?;
        let base_origin_id = marker.base_origin_id.clone().ok_or(ApplicationError::Conflict)?;
        let base_origin_seq = marker.base_origin_seq.ok_or(ApplicationError::Conflict)?;
        let base_relay_seq = marker.base_relay_seq.ok_or(ApplicationError::Conflict)?;
        let (cursor, epoch, stream): (String, String, String) = tx.query_row(
            "SELECT cursor,replication_epoch,stream_identity FROM sync_relay_cursors WHERE workspace_id=?1",
            [&key.workspace_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(read_sql)?;
        let cursor: i64 = cursor.parse().map_err(|_| ApplicationError::Corrupt)?;
        integer(cursor, 0, SAFE)?;
        if base_relay_seq > cursor { return Err(ApplicationError::Conflict); }
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![key.workspace_id,key.version_id,key.object_id], |row| row.get(0)).map_err(read_sql)?;
        if pending { return Err(invalid("ordinary activation has deferred document input")); }
        let payload: String = tx.query_row("SELECT payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND imported=1 AND apply_disposition='applied' AND op_kind='ydoc.update'",
            params![key.workspace_id,base_origin_id,base_origin_seq], |row| row.get(0)).map_err(read_sql)?;
        let base: Value = serde_json::from_str(&payload).map_err(|_| ApplicationError::Corrupt)?;
        if base["versionId"] != key.version_id || base["objectId"] != key.object_id
            || base["lineageClaimId"] != lineage || base["updateBlobSha256"] != lineage
            || base["contentKind"] != "richdoc" || base["isBaseState"] != true
        { return Err(ApplicationError::Conflict); }
        let (moment, source_digest, source_length): (String,String,i64) = tx.query_row(
            "SELECT s.latest_moment_id,s.blob_sha256,b.byte_length FROM snapshots s
             JOIN path_aliases p USING(workspace_id,version_id,object_id,path)
             JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id AND m.object_id=s.object_id
                AND m.moment_id=s.latest_moment_id AND m.path=s.path AND m.after_blob_sha256=s.blob_sha256 AND m.after_content_kind='text'
             JOIN blobs b ON b.sha256=s.blob_sha256
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.content_kind='text'",
            params![key.workspace_id,key.version_id,key.object_id,path],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(read_sql)?;
        integer(source_length, 0, dohc_engine_domain::MAX_TEXT_BYTES as i64)?;
        let original: String = tx.query_row("SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
            params![key.workspace_id,key.version_id,key.object_id], |row| row.get(0)).map_err(read_sql)?;
        if original != lineage { return Err(ApplicationError::Conflict); }
        let baseline_length: i64 = tx.query_row("SELECT length(bytes) FROM binary_blobs WHERE sha256=?1",[&lineage],|row| row.get(0)).map_err(read_sql)?;
        if baseline_length < 2 || baseline_length as usize > max_bytes.min(crate::limits::MAX_YDOC_UPDATE_BYTES) {
            return Err(ApplicationError::ConfiguredByteBudgetExceeded);
        }
        adoption::require_local_replay_budget(tx, key, max_bytes)?;
        let local = durable::load_doc_in(tx, key)?;
        if local.has_missing_updates() { return Err(ApplicationError::Conflict); }
        let projection = local.project(ContentKind::Richdoc)?.content;
        let text = local.preserved_markdown_source(&projection).unwrap_or(projection);
        if text.len() as i64 != source_length || hex_sha256(text.as_bytes()) != source_digest {
            return Err(invalid("ordinary activation source does not match imported document"));
        }
        let full_state = local.encode_full_state_bounded(max_bytes.saturating_sub(baseline_length as usize).min(crate::limits::MAX_YDOC_UPDATE_BYTES))
            .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
        let baseline_bytes = get_binary_blob(tx, &lineage)?.ok_or(ApplicationError::Corrupt)?;
        let original_doc = Ydoc::wire(); original_doc.apply(&baseline_bytes)?;
        original_doc.validate_public_baseline(&baseline_bytes)?;
        let source = ImportedOwnerSource {version: 1, relay_database_namespace: namespace.to_owned(),
            workspace_id: key.workspace_id.clone(), main_version_id: key.version_id.clone(), object_id: key.object_id.clone(),
            lineage_claim_id: lineage, current_path: path.to_owned(), replication_epoch: epoch, stream_identity: stream,
            committed_cursor: cursor, base_origin_id, base_origin_seq, base_relay_seq, source_moment_id: moment,
            source_digest, source_byte_length: source_length, native_head_sequence: marker.head_update_seq,
            full_state_digest: hex_sha256(&full_state), full_state_byte_length: full_state.len()};
        let descriptor = serde_json::to_string(&source).map_err(|_| ApplicationError::Corrupt)?;
        if descriptor.len() > max_bytes.saturating_sub(baseline_bytes.len()).saturating_sub(full_state.len()) {
            return Err(ApplicationError::ConfiguredByteBudgetExceeded);
        }
        let activation_id = format!("ordinary-activation-{}",hex_sha256(descriptor.as_bytes()));
        let retained = dohc_engine_storage::put_binary_blob(tx, &full_state)?;
        if retained != source.full_state_digest { return Err(ApplicationError::Corrupt); }
        tx.execute("INSERT INTO ydoc_owner_activation_sources(activation_id,relay_database_namespace,workspace_id,version_id,object_id,lineage_claim_id,source_moment_id,source_digest,full_state_digest,descriptor_json)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(activation_id) DO NOTHING",
            params![activation_id,namespace,key.workspace_id,key.version_id,key.object_id,source.lineage_claim_id,
                source.source_moment_id,source.source_digest,source.full_state_digest,descriptor]).map_err(write_sql)?;
        let restore_generation = super::restore_generation(tx, key)?;
        Ok(ImportedOwnerActivation {activation_id,source,baseline_bytes,full_state,restore_generation})
    })?;
    match result {
        TxnOutcome::Committed(captured) => Ok(captured),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

pub fn resume_imported_owner_activation(
    store: &mut EngineStore,
    namespace: &str,
    key: &DocKey,
    path: &str,
    activation_id: &str,
    max_bytes: usize,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    identifier(namespace, 1024)?;
    identifier(activation_id, 1024)?;
    if key.version_id != "main" || max_bytes == 0 {
        return Err(invalid("invalid ordinary activation resume"));
    }
    store.read_with(|conn| {
        let sizes: (i64,i64,i64) = conn.query_row(
            "SELECT length(CAST(a.descriptor_json AS BLOB)),length(b.bytes),length(f.bytes)
             FROM ydoc_owner_activation_sources a JOIN binary_blobs b ON b.sha256=a.lineage_claim_id
             JOIN binary_blobs f ON f.sha256=a.full_state_digest WHERE a.activation_id=?1
             AND a.relay_database_namespace=?2 AND a.workspace_id=?3 AND a.version_id=?4 AND a.object_id=?5",
            params![activation_id,namespace,key.workspace_id,key.version_id,key.object_id],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(read_sql)?;
        let mut total=0usize;
        for length in [sizes.0,sizes.1,sizes.2] {
            let length=usize::try_from(length).map_err(|_|ApplicationError::Corrupt)?;
            total=total.checked_add(length).ok_or(ApplicationError::Corrupt)?;
            if total>max_bytes { return Err(ApplicationError::ConfiguredByteBudgetExceeded); }
        }
        if sizes.1<2 || sizes.2<2 || sizes.1 as usize>crate::limits::MAX_YDOC_UPDATE_BYTES
            || sizes.2 as usize>crate::limits::MAX_YDOC_UPDATE_BYTES { return Err(ApplicationError::Corrupt); }
        let json:String=conn.query_row("SELECT descriptor_json FROM ydoc_owner_activation_sources WHERE activation_id=?1",[activation_id],|r|r.get(0)).map_err(read_sql)?;
        if format!("ordinary-activation-{}",hex_sha256(json.as_bytes()))!=activation_id { return Err(ApplicationError::Corrupt); }
        let source:ImportedOwnerSource=serde_json::from_str(&json).map_err(|_|ApplicationError::Corrupt)?;
        let marker=durable::read_marker_in(conn,key)?.ok_or(ApplicationError::Conflict)?;
        if marker.content_kind!=ContentKind::Richdoc || marker.regime!=Regime::Replicated
            || marker.lineage_claim_status!=durable::LineageClaimStatus::Exact
            || marker.lineage_claim_id.as_deref()!=Some(source.lineage_claim_id.as_str())
            || marker.path.as_deref()!=Some(path) || source.current_path!=path
            || marker.base_origin_id.as_deref()!=Some(source.base_origin_id.as_str())
            || marker.base_origin_seq!=Some(source.base_origin_seq) || marker.base_relay_seq!=Some(source.base_relay_seq)
        { return Err(ApplicationError::Conflict); }
        let binding=LiveObjectBinding {workspace_id:key.workspace_id.clone(),main_version_id:key.version_id.clone(),
            object_id:key.object_id.clone(),lineage_claim_id:source.lineage_claim_id.clone(),current_path:path.to_owned(),
            selector_paths:vec![path.to_owned()],restore_fence_generation:1};
        let verified=adoption::read_adoption_source(conn,namespace,activation_id,&binding)?
            .and_then(|(_,_,_,_,source)|source).ok_or(ApplicationError::Corrupt)?;
        if verified!=source { return Err(ApplicationError::Corrupt); }
        let (cursor,epoch,stream):(String,String,String)=conn.query_row(
            "SELECT cursor,replication_epoch,stream_identity FROM sync_relay_cursors WHERE workspace_id=?1",
            [&key.workspace_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(read_sql)?;
        let cursor:i64=cursor.parse().map_err(|_|ApplicationError::Corrupt)?;
        if cursor<source.committed_cursor || epoch!=source.replication_epoch || stream!=source.stream_identity {
            return Err(ApplicationError::Conflict);
        }
        let adopted:Option<(String,String,i64,String,String,i64)>=conn.query_row(
            "SELECT relay_database_namespace,adoption_id,local_ydoc_sequence,source_moment_id,source_digest,source_byte_length
             FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![key.workspace_id,key.version_id,key.object_id,source.lineage_claim_id],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(read_sql)?;
        if let Some((saved_namespace,id,sequence,moment,digest,length))=adopted {
            if saved_namespace!=namespace || id!=activation_id || sequence!=source.native_head_sequence
                || marker.head_update_seq<sequence || moment!=source.source_moment_id
                || digest!=source.source_digest || length!=source.source_byte_length { return Err(ApplicationError::Conflict); }
        } else {
            if marker.head_update_seq!=source.native_head_sequence { return Err(ApplicationError::Conflict); }
            adoption::require_local_replay_budget(conn,key,max_bytes)?;
            let local=durable::load_doc_in(conn,key)?;
            let full=local.encode_full_state_bounded(max_bytes.min(crate::limits::MAX_YDOC_UPDATE_BYTES))
                .ok_or(ApplicationError::ConfiguredByteBudgetExceeded)?;
            if local.has_missing_updates() || full.len()!=source.full_state_byte_length
                || hex_sha256(&full)!=source.full_state_digest { return Err(ApplicationError::Conflict); }
            let current:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM snapshots s JOIN path_aliases p USING(workspace_id,version_id,object_id,path)
                WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.content_kind='text' AND s.blob_sha256=?5)",
                params![key.workspace_id,key.version_id,key.object_id,path,source.source_digest],|r|r.get(0)).map_err(read_sql)?;
            if !current { return Err(ApplicationError::Conflict); }
        }
        let original:String=conn.query_row("SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
            params![key.workspace_id,key.version_id,key.object_id],|r|r.get(0)).map_err(read_sql)?;
        if original!=source.lineage_claim_id { return Err(ApplicationError::Conflict); }
        let baseline_bytes=get_binary_blob(conn,&source.lineage_claim_id)?.ok_or(ApplicationError::Corrupt)?;
        let full_state=get_binary_blob(conn,&source.full_state_digest)?.ok_or(ApplicationError::Corrupt)?;
        if hex_sha256(&baseline_bytes)!=source.lineage_claim_id || hex_sha256(&full_state)!=source.full_state_digest {
            return Err(ApplicationError::Corrupt);
        }
        let restore_generation=super::restore_generation(conn,key)?;
        Ok(ImportedOwnerActivation {activation_id:activation_id.to_owned(),source,baseline_bytes,full_state,restore_generation})
    })
}
