use super::*;

/// The original consumed coordinate and its immutable, credited publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFoldedSource {
    pub outbox_id: String,
    pub outbox_sequence: i64,
    pub append_key: String,
    pub delivery_id: String,
    pub native_sequence: i64,
    pub origin_id: String,
    pub origin_sequence: i64,
    pub recorded_at_ms: i64,
    pub publication: serde_json::Value,
}

pub(super) fn classify(
    conn: &Connection,
    input: &NativeRestorePreparation,
    context: &Ydoc,
    budget: &mut Budget,
    remaining_events: usize,
) -> Result<Vec<NativeRestoreFoldedSource>, ApplicationError> {
    use crate::owner_outbox::{prefix, release};
    let b = &input.fence.operation.old_binding;
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let length: Option<i64> = conn.query_row("SELECT length(CAST(binding_json AS BLOB)) FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id],|r|r.get(0)).optional().map_err(read_sql)?;
    if let Some(length) = length {
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    }
    let stop = release::read_in(conn, &key).map_err(|_| ApplicationError::Corrupt)?;
    let Some(stop) = stop else {
        return Ok(Vec::new());
    };
    let Some(p) = stop.prefix else {
        return Ok(Vec::new());
    };
    if stop.binding.as_ref() != Some(b) {
        return Err(ApplicationError::Conflict);
    }
    let tag = prefix::publication_tag(b, &p.release_digest);
    let mut sources = Vec::new();
    let mut query = conn.prepare("SELECT outbox_id,append_key FROM owner_prefix_consumed WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND ordinary_edit=0 AND native_sequence>?4 AND native_sequence<=?5 ORDER BY native_sequence LIMIT ?6").map_err(read_sql)?;
    let mut rows = query
        .query(params![
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            p.accepted_head,
            input.fence.local_head_sequence,
            remaining_events as i64 + 1
        ])
        .map_err(read_sql)?;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if sources.len() >= remaining_events {
            return Err(invalid("restore source count exceeds configured budget"));
        }
        // Charge identities before allocating them, and each full journal row before reading it.
        let outbox = row
            .get_ref(0)
            .map_err(read_sql)?
            .as_str()
            .map_err(|_| ApplicationError::Corrupt)?;
        let append = row
            .get_ref(1)
            .map_err(read_sql)?
            .as_str()
            .map_err(|_| ApplicationError::Corrupt)?;
        budget.charge(outbox.len() + append.len())?;
        let json = budget.sql_json_array(conn,
            &["c.outbox_id","c.sequence","c.append_key","c.delivery_id","c.native_sequence","l.origin_id","l.origin_seq","l.recorded_at_ms","l.payload_json"],
            "FROM owner_prefix_consumed c JOIN replication_log l ON l.workspace_id=c.workspace_id AND l.origin_id=json_extract(c.publication_coordinate_json,'$[0]') AND l.origin_seq=json_extract(c.publication_coordinate_json,'$[1]') AND l.op_kind='ydoc.update' AND json_extract(l.payload_json,'$.updateBlobSha256')=c.update_digest AND json_extract(l.payload_json,'$.release.releaseDigest')=?6 WHERE c.workspace_id=?1 AND c.version_id=?2 AND c.object_id=?3 AND c.outbox_id=?4 AND c.append_key=?5 ORDER BY l.origin_id,l.origin_seq LIMIT 1",
            &[&b.workspace_id,&b.main_version_id,&b.object_id,&outbox,&append,&p.release_digest])?;
        let (
            outbox_id,
            outbox_sequence,
            append_key,
            delivery_id,
            native_sequence,
            origin_id,
            origin_sequence,
            recorded_at_ms,
            payload,
        ): (String, i64, String, String, i64, String, i64, i64, String) =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        let publication: serde_json::Value =
            serde_json::from_str(&payload).map_err(|_| ApplicationError::Corrupt)?;
        if publication["release"] != tag
            || publication["versionId"] != b.main_version_id
            || publication["objectId"] != b.object_id
            || publication["lineageClaimId"] != b.lineage_claim_id
            || publication["contentKind"] != "richdoc"
            || publication["isBaseState"] != false
            || p.publication_frontier
                .get(&origin_id)
                .is_none_or(|s| *s < origin_sequence)
        {
            return Err(ApplicationError::Conflict);
        }
        let sha = publication["updateBlobSha256"]
            .as_str()
            .ok_or(ApplicationError::Corrupt)?;
        digest(sha)?;
        if let Some(actor) = publication.get("actorOriginId") {
            crate::validate_actor_origin_id(actor.as_str().ok_or(ApplicationError::Corrupt)?)?;
        }
        let attribution: Option<dohc_engine_domain::ChangeAttribution> = publication
            .get("attribution")
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .map_err(|_| ApplicationError::Corrupt)?;
        crate::durable::validate_attribution(attribution.as_ref())?;
        let bytes = budget.blob(conn, sha)?;
        if hex_sha256(&bytes) != sha {
            return Err(ApplicationError::Corrupt);
        }
        crate::validate_replay_parity(context, &bytes)?;
        context.apply(&bytes)?;
        sources.push(NativeRestoreFoldedSource {
            outbox_id,
            outbox_sequence,
            append_key,
            delivery_id,
            native_sequence,
            origin_id,
            origin_sequence,
            recorded_at_ms,
            publication,
        });
    }
    if sources.len() as i64 != p.consumed_entries {
        return Err(ApplicationError::Conflict);
    }
    Ok(sources)
}
