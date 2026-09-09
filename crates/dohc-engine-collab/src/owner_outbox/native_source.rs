use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerOutboxNativeSource {
    pub binding: LiveObjectBinding,
    pub adoption_id: String,
    pub native_sequence: i64,
    pub update_digest: String,
    pub origin: OwnerOutboxNativeOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum OwnerOutboxNativeOrigin {
    #[serde(rename_all = "camelCase")]
    NativeUpdate {
        actor_origin_id: Option<String>,
        actor_kind: Option<String>,
        on_behalf_of: Option<String>,
        chain_depth: Option<i64>,
        recorded_at_ms: i64,
    },
    AdoptionSeed,
}

impl OwnerOutboxNativeSource {
    pub(crate) fn validate(&self, append_key: &str) -> Result<(), OwnerOutboxError> {
        self.binding
            .validate_canonical()
            .map_err(OwnerOutboxError::InvalidInput)?;
        validate_identifier(&self.adoption_id, "invalid native source adoption")?;
        validate_digest(&self.update_digest)?;
        if !(0..=9_007_199_254_740_991).contains(&self.native_sequence) {
            return Err(OwnerOutboxError::Corrupt);
        }
        let expected = match &self.origin {
            OwnerOutboxNativeOrigin::AdoptionSeed => format!(
                "owner-adoption:{}",
                hex_sha256(
                    &serde_json::to_vec(&(
                        &self.adoption_id,
                        self.native_sequence,
                        &self.update_digest
                    ))
                    .map_err(|_| OwnerOutboxError::Corrupt)?
                )
            ),
            OwnerOutboxNativeOrigin::NativeUpdate {
                actor_origin_id,
                actor_kind,
                on_behalf_of,
                chain_depth,
                recorded_at_ms,
            } => {
                if self.native_sequence == 0
                    || !(0..=9_007_199_254_740_991).contains(recorded_at_ms)
                {
                    return Err(OwnerOutboxError::Corrupt);
                }
                if let Some(actor) = actor_origin_id {
                    crate::validate_actor_origin_id(actor)
                        .map_err(|_| OwnerOutboxError::Corrupt)?;
                }
                match (actor_kind, chain_depth) {
                    (Some(kind), Some(depth)) => {
                        let attribution = dohc_engine_domain::ChangeAttribution {
                            actor_kind: dohc_engine_domain::ChangeActorKind::parse(kind)
                                .ok_or(OwnerOutboxError::Corrupt)?,
                            on_behalf_of: on_behalf_of.clone(),
                            depth: u32::try_from(*depth).map_err(|_| OwnerOutboxError::Corrupt)?,
                        };
                        attribution
                            .validate()
                            .map_err(|_| OwnerOutboxError::Corrupt)?;
                    }
                    (None, None) if on_behalf_of.is_none() => {}
                    _ => return Err(OwnerOutboxError::Corrupt),
                }
                format!(
                    "adopted-local:{}",
                    hex_sha256(
                        &serde_json::to_vec(&(
                            &self.binding.workspace_id,
                            &self.binding.main_version_id,
                            &self.binding.object_id,
                            &self.binding.lineage_claim_id,
                            self.native_sequence
                        ))
                        .map_err(|_| OwnerOutboxError::Corrupt)?
                    )
                )
            }
        };
        if append_key != expected {
            return Err(OwnerOutboxError::Corrupt);
        }
        Ok(())
    }

    pub(crate) fn verify_retained_row(&self, conn: &Connection) -> Result<(), OwnerOutboxError> {
        let OwnerOutboxNativeOrigin::NativeUpdate {
            actor_origin_id,
            actor_kind,
            on_behalf_of,
            chain_depth,
            recorded_at_ms,
        } = &self.origin
        else {
            return Ok(());
        };
        let matches: Option<bool> = conn.query_row(
            "SELECT update_blob_sha256=?5 AND actor_origin_id IS ?6 AND actor_kind IS ?7 AND on_behalf_of IS ?8 AND chain_depth IS ?9 AND recorded_at_ms=?10 FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND seq=?4",
            params![self.binding.workspace_id,self.binding.main_version_id,self.binding.object_id,self.native_sequence,self.update_digest,actor_origin_id,actor_kind,on_behalf_of,chain_depth,recorded_at_ms],|row|row.get(0),
        ).optional().map_err(read_sql)?;
        match matches {
            Some(true) => {}
            Some(false) => return Err(OwnerOutboxError::Corrupt),
            None => {
                let compacted: i64=conn.query_row("SELECT head_snapshot_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![self.binding.workspace_id,self.binding.main_version_id,self.binding.object_id],|row|row.get(0)).map_err(read_sql)?;
                if self.native_sequence > compacted {
                    return Err(OwnerOutboxError::Corrupt);
                }
            }
        }
        Ok(())
    }
}

pub(super) fn read_native_update_source(
    conn: &Connection,
    binding: &LiveObjectBinding,
    adoption_id: &str,
    native_sequence: i64,
) -> Result<OwnerOutboxNativeSource, OwnerOutboxError> {
    conn.query_row("SELECT update_blob_sha256,actor_origin_id,actor_kind,on_behalf_of,chain_depth,recorded_at_ms FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND seq=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,native_sequence],|row|Ok(OwnerOutboxNativeSource {
        binding:binding.clone(),adoption_id:adoption_id.into(),native_sequence,update_digest:row.get(0)?,origin:OwnerOutboxNativeOrigin::NativeUpdate {actor_origin_id:row.get(1)?,actor_kind:row.get(2)?,on_behalf_of:row.get(3)?,chain_depth:row.get(4)?,recorded_at_ms:row.get(5)?},
    })).map_err(read_sql)
}

pub(crate) fn retain_native_source(
    tx: &rusqlite::Transaction<'_>,
    result: &OwnerOutboxAppendResult,
    source: &OwnerOutboxNativeSource,
) -> Result<(), OwnerOutboxError> {
    let (append_key, previous): (String,Option<String>) = tx.query_row("SELECT append_key,native_source_json FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2 AND update_digest=?3",params![result.outbox_id,result.sequence,result.update_digest],|row|Ok((row.get(0)?,row.get(1)?))).map_err(read_sql)?;
    source.validate(&append_key)?;
    if source.update_digest != result.update_digest {
        return Err(OwnerOutboxError::Corrupt);
    }
    let json = serde_json::to_string(source).map_err(|_| OwnerOutboxError::Corrupt)?;
    if let Some(previous) = previous {
        if previous != json {
            return Err(OwnerOutboxError::Corrupt);
        }
        return Ok(());
    }
    tx.execute("UPDATE owner_ydoc_outbox_entries SET native_source_json=?3 WHERE outbox_id=?1 AND sequence=?2",params![result.outbox_id,result.sequence,json]).map_err(write_sql)?;
    Ok(())
}
