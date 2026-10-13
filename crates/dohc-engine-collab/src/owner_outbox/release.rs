//! Generation-bound Stop requests and release of this computer's owner draft.
use super::draft::{bounded, bounded_blob, collab, descriptor_for_key_in, key, read_observed_in};
use super::*;
use crate::{AppendOutcome, CollabError, DocKey};
use dohc_engine_domain::ChangeAttribution;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerLiveStop {
    pub binding: LiveObjectBinding,
    pub relay_database_namespace: String,
    pub state: String,
    #[serde(skip)]
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

pub fn require_not_host_in(conn: &Connection, key: &DocKey) -> Result<(), OwnerOutboxError> {
    let hosted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)", params![key.workspace_id,key.version_id,key.object_id], |r| r.get(0)).map_err(read_sql)?;
    if hosted || has_adopted_owner_in(conn, key).map_err(collab)? {
        return Err(OwnerOutboxError::DesktopHost);
    }
    Ok(())
}

pub fn blocked_in(conn: &Connection, key: &DocKey) -> Result<bool, OwnerOutboxError> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)", params![key.workspace_id,key.version_id,key.object_id], |r| r.get(0)).map_err(read_sql)
}

fn read_in(conn: &Connection, key: &DocKey) -> Result<Option<OwnerLiveStop>, OwnerOutboxError> {
    let row: Option<(String,String,String)> = conn.query_row("SELECT binding_json,relay_database_namespace,state FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3", params![key.workspace_id,key.version_id,key.object_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(read_sql)?;
    row.map(|(binding, relay_database_namespace, state)| {
        Ok(OwnerLiveStop {
            binding: serde_json::from_str(&binding).map_err(|_| OwnerOutboxError::Corrupt)?,
            relay_database_namespace,
            state,
            record_facts: Vec::new(),
        })
    })
    .transpose()
}

pub fn request_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<OwnerLiveStop, OwnerOutboxError> {
    require_not_host_in(tx, key)?;
    if let Some(saved) = read_in(tx, key)? {
        if saved.state == "released" {
            return Ok(saved);
        }
    }
    let draft = descriptor_for_key_in(tx, key)?.ok_or(OwnerOutboxError::NotFound)?;
    tx.execute("INSERT INTO owner_live_stops(workspace_id,main_version_id,object_id,relay_database_namespace,state,binding_json,requested_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,'requested',?5,?6,?6) ON CONFLICT(workspace_id,main_version_id,object_id) DO UPDATE SET binding_json=excluded.binding_json,relay_database_namespace=excluded.relay_database_namespace,updated_at_ms=excluded.updated_at_ms WHERE owner_live_stops.state='requested'",params![key.workspace_id,key.version_id,key.object_id,draft.relay_database_namespace,binding_json(&draft.binding)?,now_ms]).map_err(write_sql)?;
    read_in(tx, key)?.ok_or(OwnerOutboxError::Corrupt)
}

pub fn clear_in_tx(tx: &rusqlite::Transaction<'_>, key: &DocKey) -> Result<(), OwnerOutboxError> {
    tx.execute("DELETE FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id]).map_err(write_sql)?;
    Ok(())
}

pub fn list_requested_in(
    conn: &Connection,
    workspace: &str,
) -> Result<Vec<OwnerLiveStop>, OwnerOutboxError> {
    let mut stmt=conn.prepare("SELECT binding_json,relay_database_namespace FROM owner_live_stops WHERE workspace_id=?1 AND state='requested' ORDER BY main_version_id,object_id LIMIT 64").map_err(read_sql)?;
    let rows = stmt
        .query_map([workspace], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(read_sql)?;
    rows.map(|r| {
        let (json, relay_database_namespace) = r.map_err(read_sql)?;
        Ok(OwnerLiveStop {
            binding: serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?,
            relay_database_namespace,
            state: "requested".into(),
            record_facts: Vec::new(),
        })
    })
    .collect()
}

/// The relay has retired exactly this binding's generation. The hook journals
/// each consecutive credit group in the same transaction, as recovery replay does.
pub fn release_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    now_ms: i64,
    mut post_append: impl FnMut(
        &rusqlite::Transaction<'_>,
        &[u8],
        Option<&str>,
        Option<&ChangeAttribution>,
        &mut AppendOutcome,
    ) -> Result<(), CollabError>,
) -> Result<OwnerLiveStop, OwnerOutboxError> {
    binding
        .validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    let key = key(binding)?;
    let mut stop = read_in(tx, &key)?.ok_or(OwnerOutboxError::StopConflict)?;
    if stop.binding != *binding {
        return Err(OwnerOutboxError::StopConflict);
    }
    if stop.state == "released" {
        return Ok(stop);
    }
    let observed = read_observed_in(tx, binding)
        .map_err(|error| match error {
            OwnerOutboxError::ParentMismatch => OwnerOutboxError::StopConflict,
            other => other,
        })?
        .ok_or(OwnerOutboxError::StopConflict)?;
    require_not_host_in(tx, &key)?;
    crate::live_update_application::require_restore_open(tx, &key)
        .map_err(|_| OwnerOutboxError::Corrupt)?;
    let outboxes = {
        let mut stmt=tx.prepare("SELECT outbox_id,restore_fence_generation,state,quarantine_reason FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 ORDER BY created_at_ms,outbox_id").map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![
                    binding.workspace_id,
                    binding.main_version_id,
                    binding.object_id,
                    binding.lineage_claim_id
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    let mut current = Vec::new();
    for (id, generation, state, reason) in outboxes {
        if generation > binding.restore_fence_generation {
            return Err(OwnerOutboxError::Corrupt);
        }
        if generation == binding.restore_fence_generation {
            if state == "quarantined" && reason.as_deref() == Some("restore-fenced") {
                return Err(OwnerOutboxError::RestorePending);
            }
            current.push(id);
        }
    }
    tx.execute("DELETE FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    tx.execute("DELETE FROM ydoc_owner_applied_frames WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    let doc = crate::load_doc_in(tx, &key).map_err(collab)?;
    let mut blobs = BTreeSet::from([observed.checkpoint_digest]);
    for id in current {
        let entries = {
            let mut stmt=tx.prepare("SELECT sequence,update_digest,byte_length,native_source_json,agent_declaration_json,automation_declaration_json,person_edit FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence").map_err(read_sql)?;
            let rows = stmt
                .query_map([&id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                    ))
                })
                .map_err(read_sql)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
        };
        let mut credited = Vec::with_capacity(entries.len());
        for (_, digest, length, native, agent, automation, person) in entries {
            let bytes = bounded_blob(tx, &digest)?;
            if bytes.len() as i64 != length {
                return Err(OwnerOutboxError::Corrupt);
            }
            let (actor, attribution) = if let Some(json) = native {
                let source: OwnerOutboxSource =
                    serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?;
                let source = source.native().ok_or(OwnerOutboxError::Corrupt)?;
                if source.binding != *binding || source.update_digest != digest {
                    return Err(OwnerOutboxError::Corrupt);
                }
                source.native_author()?.unwrap_or((None, None))
            } else {
                let agent = stored_declaration(agent)?;
                let automation = stored_automation_declaration(automation)?;
                if agent.is_some() && automation.is_some() {
                    return Err(OwnerOutboxError::Corrupt);
                }
                if let Some(a) = automation {
                    (Some(a.automation_id), Some(a.attribution))
                } else if let Some(a) = agent {
                    (Some(a.agent_id.clone()), Some(a.attribution()))
                } else if person == Some(1) {
                    (
                        Some("local-person".into()),
                        Some(dohc_engine_domain::ChangeAttribution {
                            actor_kind: dohc_engine_domain::ChangeActorKind::Human,
                            on_behalf_of: None,
                            depth: 0,
                            run: None,
                        }),
                    )
                } else {
                    (None, None)
                }
            };
            credited.push(((actor, attribution), bytes));
        }
        // A typing burst has many deltas but one credit. Keep each credit
        // boundary; validate, index and journal the combined delta once.
        for group in credited.chunk_by(|a, b| a.0 == b.0) {
            let (actor, attribution) = &group[0].0;
            let before = bounded(&doc)?;
            let vector = doc.encode_state_vector();
            for (_, bytes) in group {
                doc.apply(bytes).map_err(collab)?;
                if doc.has_pending_dependencies() {
                    return Err(OwnerOutboxError::Corrupt);
                }
            }
            if bounded(&doc)? == before {
                continue;
            }
            let update = doc.diff(&vector).map_err(collab)?;
            let mut outcome = crate::record_update_in_tx(
                tx,
                &key,
                &update,
                actor.as_deref(),
                attribution.as_ref(),
                now_ms,
            )
            .map_err(collab)?;
            post_append(
                tx,
                &update,
                actor.as_deref(),
                attribution.as_ref(),
                &mut outcome,
            )
            .map_err(collab)?;
            if let Some(facts) = outcome.record_facts {
                stop.record_facts.push(facts);
            }
        }
        let mut stmt=tx.prepare("SELECT base_blob_digest FROM owner_ydoc_outboxes WHERE outbox_id=?1 UNION SELECT update_blob_digest FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND update_blob_digest IS NOT NULL UNION SELECT terminal_blob_digest FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND terminal_blob_digest IS NOT NULL").map_err(read_sql)?;
        for r in stmt
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(read_sql)?
        {
            blobs.insert(r.map_err(read_sql)?);
        }
        drop(stmt);
        tx.execute(
            "DELETE FROM owner_ydoc_outbox_entries WHERE outbox_id=?1",
            [&id],
        )
        .map_err(write_sql)?;
        tx.execute("DELETE FROM owner_ydoc_outboxes WHERE outbox_id=?1", [&id])
            .map_err(write_sql)?;
    }
    for digest in blobs {
        delete_binary_blob_if_unreferenced(tx, &digest)?;
    }
    tx.execute("UPDATE owner_live_stops SET state='released',updated_at_ms=?4 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id,now_ms]).map_err(write_sql)?;
    stop.state = "released".into();
    Ok(stop)
}
