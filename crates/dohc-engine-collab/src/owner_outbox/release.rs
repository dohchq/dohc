//! Generation-bound Stop requests and release of this computer's owner draft.
use super::draft::{bounded_blob, collab, key, read_observed_in};
use super::*;
use crate::{AppendOutcome, CollabError, DocKey};
use dohc_engine_domain::ChangeAttribution;

pub const MAX_RELEASE_ENTRIES: i64 = 32;
pub const MAX_RELEASE_BYTES: i64 = 4 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeferredOwnerStop {
    pub unsent_edits: i64,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerLiveStop {
    pub binding: Option<LiveObjectBinding>,
    pub document: OwnerStopDocument,
    pub retirement_owed: bool,
    pub relay_database_namespace: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<DeferredOwnerStop>,
    /// The desktop's digest of the refused edits it recorded before this
    /// Stop's release took them. Only a Try again naming it settles the
    /// release again, so a restored older Stop cannot answer for a newer record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_snapshot: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerStopDocument {
    pub main_version_id: String,
    pub object_id: String,
    pub current_path: String,
}

fn read_in(conn: &Connection, key: &DocKey) -> Result<Option<OwnerLiveStop>, OwnerOutboxError> {
    let row: Option<(String,String)> = conn.query_row("SELECT binding_json,state FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3", params![key.workspace_id,key.version_id,key.object_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(read_sql)?;
    row.map(|(json, state)| {
        let mut stop: OwnerLiveStop =
            serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?;
        if stop.document.main_version_id != key.version_id
            || stop.document.object_id != key.object_id
            || stop.binding.as_ref().is_some_and(|b| {
                b.workspace_id != key.workspace_id
                    || b.main_version_id != key.version_id
                    || b.object_id != key.object_id
            })
        {
            return Err(OwnerOutboxError::Corrupt);
        }
        stop.state = state;
        if let Some(binding) = stop.binding.as_ref().filter(|_| stop.deferred.is_some()) {
            stop.deferred = Some(deferred_in(conn, binding)?);
        }
        Ok(stop)
    })
    .transpose()
}

pub fn request_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<OwnerLiveStop, OwnerOutboxError> {
    require_not_host_in(tx, key)?;
    let main: String = tx
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [&key.workspace_id],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    if main != key.version_id {
        return Err(OwnerOutboxError::MainVersionMismatch);
    }
    if let Some(saved) = read_in(tx, key)? {
        if saved.state == "released" {
            return Ok(saved);
        }
    }
    let bindings = {
        let mut stmt=tx.prepare("SELECT binding_json FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 LIMIT 2").map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![key.workspace_id, key.version_id, key.object_id],
                |r| r.get::<_, String>(0),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    if bindings.len() > 1 {
        return Err(OwnerOutboxError::StopConflict);
    }
    let draft = bindings
        .first()
        .map(|json| {
            let binding: LiveObjectBinding =
                serde_json::from_str(json).map_err(|_| OwnerOutboxError::Corrupt)?;
            if binding.workspace_id != key.workspace_id
                || binding.main_version_id != key.version_id
                || binding.object_id != key.object_id
            {
                return Err(OwnerOutboxError::Corrupt);
            }
            let observed = read_observed_in(tx, &binding)?.ok_or(OwnerOutboxError::Corrupt)?;
            let marker = crate::read_marker_in(tx, key)
                .map_err(collab)?
                .ok_or(OwnerOutboxError::Corrupt)?;
            if marker.head_update_seq != observed.native_head_sequence
                || marker.content_kind != crate::ContentKind::Richdoc
                || marker.regime != crate::Regime::Replicated
                || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
            {
                return Err(OwnerOutboxError::StopConflict);
            }
            Ok(observed)
        })
        .transpose()?;
    let path: Option<String> = tx
        .query_row(
            "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(read_sql)?;
    let current_path = path
        .or_else(|| {
            draft
                .as_ref()
                .map(|draft| draft.binding.current_path.clone())
        })
        .ok_or(OwnerOutboxError::NotFound)?;
    // An unenrolled file can have no Y.Doc marker yet. A bare marker records
    // identity only; ordinary open still imports the authoritative file.
    tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,lineage_claim_status,updated_at_ms) VALUES(?1,?2,?3,'richdoc','local-only',0,0,'unclaimed',?4) ON CONFLICT DO NOTHING",params![key.workspace_id,key.version_id,key.object_id,now_ms]).map_err(write_sql)?;
    let stop = OwnerLiveStop {
        document: OwnerStopDocument {
            main_version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            current_path,
        },
        retirement_owed: true,
        state: if draft.is_some() {
            "requested"
        } else {
            "released"
        }
        .into(),
        relay_database_namespace: draft
            .as_ref()
            .map(|draft| draft.relay_database_namespace.clone())
            .unwrap_or_default(),
        binding: draft.map(|draft| draft.binding),
        record_facts: Vec::new(),
        deferred: None,
        kept_snapshot: None,
    };
    save_in_tx(tx, key, &stop, now_ms)?;
    Ok(stop)
}

fn save_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    stop: &OwnerLiveStop,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let json = serde_json::to_string(stop).map_err(|_| OwnerOutboxError::Corrupt)?;
    tx.execute("INSERT INTO owner_live_stops(workspace_id,main_version_id,object_id,relay_database_namespace,state,binding_json,requested_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(workspace_id,main_version_id,object_id) DO UPDATE SET binding_json=excluded.binding_json,relay_database_namespace=excluded.relay_database_namespace,state=excluded.state,updated_at_ms=excluded.updated_at_ms",params![key.workspace_id,key.version_id,key.object_id,stop.relay_database_namespace,stop.state,json,now_ms]).map_err(write_sql)?;
    Ok(())
}

pub fn retired_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let mut stop = read_in(tx, key)?.ok_or(OwnerOutboxError::StopConflict)?;
    if stop.binding.is_some() || stop.state != "released" {
        return Err(OwnerOutboxError::StopConflict);
    }
    stop.retirement_owed = false;
    save_in_tx(tx, key, &stop, now_ms)
}

/// Returns the Stop it cleared in any state, including a finished one that
/// [`list_requested_in`] no longer shows, so the caller can end what that Stop
/// held. A Stop that cannot be read is still cleared and names nothing.
pub fn clear_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<Option<OwnerLiveStop>, OwnerOutboxError> {
    let cleared = read_in(tx, key).ok().flatten();
    tx.execute("DELETE FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id]).map_err(write_sql)?;
    Ok(cleared)
}

pub fn list_requested_in(
    conn: &Connection,
    workspace: &str,
) -> Result<Vec<OwnerLiveStop>, OwnerOutboxError> {
    let mut stmt=conn.prepare("SELECT main_version_id,object_id FROM owner_live_stops WHERE workspace_id=?1 AND (state='requested' OR json_extract(binding_json,'$.retirementOwed')=1 OR json_extract(binding_json,'$.deferred') IS NOT NULL) ORDER BY json_extract(binding_json,'$.retirementOwed') DESC,main_version_id,object_id LIMIT 64").map_err(read_sql)?;
    let keys = stmt
        .query_map([workspace], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    keys.into_iter()
        .map(|(version, object)| {
            let key = DocKey::new(workspace, &version, &object).map_err(collab)?;
            read_in(conn, &key)?.ok_or(OwnerOutboxError::Corrupt)
        })
        .collect()
}

/// The relay has retired exactly this binding's generation. The hook journals
/// each original entry in the same transaction, as recovery replay does.
///
/// `kept_snapshot` names the refused edits the desktop recorded before this
/// release; a released Stop answers again only for the same one. Without
/// `accepted_cursor` it is a Try again, which never starts a release.
pub fn release_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    accepted_cursor: Option<i64>,
    kept_snapshot: Option<&str>,
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
    if stop.binding.as_ref() != Some(binding) {
        return Err(OwnerOutboxError::StopConflict);
    }
    if stop.state == "released" {
        if kept_snapshot.is_some() && stop.kept_snapshot.as_deref() != kept_snapshot {
            return Err(OwnerOutboxError::StopConflict);
        }
        return Ok(stop);
    }
    let accepted_cursor = accepted_cursor.ok_or(OwnerOutboxError::StopConflict)?;
    stop.kept_snapshot = kept_snapshot.map(str::to_owned);
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
    // Check metadata before reading any update blob or changing native state.
    // Deferred Stops are final for this build; retry never publishes a prefix.
    let mut entries = 0_i64;
    let mut bytes = 0_i64;
    for id in &current {
        let (count, size): (i64, i64) = tx.query_row(
            "SELECT COUNT(*),COALESCE(SUM(byte_length),0) FROM (SELECT byte_length FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 LIMIT ?2)",
            params![id,MAX_RELEASE_ENTRIES+1], |r| Ok((r.get(0)?,r.get(1)?)),
        ).map_err(read_sql)?;
        entries = entries
            .checked_add(count)
            .ok_or(OwnerOutboxError::Corrupt)?;
        bytes = bytes.checked_add(size).ok_or(OwnerOutboxError::Corrupt)?;
    }
    if observed.accepted_cursor < accepted_cursor
        || entries > MAX_RELEASE_ENTRIES
        || bytes > MAX_RELEASE_BYTES
    {
        stop.state = "released".into();
        stop.retirement_owed = false;
        stop.deferred = Some(deferred_in(tx, binding)?);
        save_in_tx(tx, &key, &stop, now_ms)?;
        return Ok(stop);
    }
    let mut credited = Vec::new();
    let mut blobs = BTreeSet::from([observed.checkpoint_digest.clone()]);
    for id in &current {
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
    }
    if contains_pending_in(
        tx,
        &observed.checkpoint_digest,
        credited.iter().map(|(_, bytes)| bytes.as_slice()),
    )? {
        stop.state = "released".into();
        stop.retirement_owed = false;
        stop.deferred = Some(deferred_in(tx, binding)?);
        save_in_tx(tx, &key, &stop, now_ms)?;
        return Ok(stop);
    }
    // Unbinding would strand even a ready settlement: its replay joins this
    // binding. Let the delivery pass apply it before retrying Stop.
    let held: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_pending_settlements WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND relay_namespace=?5 AND applied=0)", params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,observed.relay_database_namespace], |r| r.get(0)).map_err(read_sql)?;
    if held {
        return Err(OwnerOutboxError::StopConflict);
    }
    tx.execute("DELETE FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    tx.execute("DELETE FROM ydoc_owner_applied_frames WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    stop.record_facts = crate::durable::record_credited_updates_in_tx(
        tx,
        &key,
        &credited,
        now_ms,
        &mut post_append,
    )
    .map_err(collab)?;
    for id in current {
        let mut stmt=tx.prepare("SELECT base_blob_digest FROM owner_ydoc_outboxes WHERE outbox_id=?1 UNION SELECT recovery_checkpoint_digest FROM owner_ydoc_outboxes WHERE outbox_id=?1 AND recovery_checkpoint_digest IS NOT NULL UNION SELECT update_blob_digest FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND update_blob_digest IS NOT NULL UNION SELECT terminal_blob_digest FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND terminal_blob_digest IS NOT NULL").map_err(read_sql)?;
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
    // Every original blob now belongs to a native row and journal append.
    let retained: BTreeSet<_> = credited
        .iter()
        .map(|(_, bytes)| hex_sha256(bytes))
        .collect();
    for digest in blobs.difference(&retained) {
        delete_binary_blob_if_unreferenced(tx, digest)?;
    }
    stop.state = "released".into();
    stop.retirement_owed = false;
    save_in_tx(tx, &key, &stop, now_ms)?;
    Ok(stop)
}

// A host-cut diff can contain an entry without retaining its original bytes.
// New insertions or deletions disprove containment; covered ranges still need
// the same apply-and-compare proof as receipt acknowledgement.
fn contains_pending_in<'a>(
    conn: &Connection,
    checkpoint_digest: &str,
    updates: impl Iterator<Item = &'a [u8]>,
) -> Result<bool, OwnerOutboxError> {
    use yrs::updates::decoder::Decode;
    let mut updates = updates.peekable();
    if updates.peek().is_none() {
        return Ok(false);
    }
    let checkpoint = bounded_blob(conn, checkpoint_digest)?;
    let accepted = crate::Ydoc::wire();
    accepted.apply(&checkpoint).map_err(collab)?;
    if accepted.has_pending_dependencies() {
        return Err(OwnerOutboxError::Corrupt);
    }
    let vector = accepted.state_vector();
    let deleted = accepted.delete_set();
    let empty = Default::default();
    let mut before = None;
    for bytes in updates {
        crate::replay_parity::prevalidate_update_bytes(bytes).map_err(collab)?;
        let update = yrs::Update::decode_v1(bytes).map_err(|_| OwnerOutboxError::Corrupt)?;
        if update
            .insertions(true)
            .iter()
            .any(|(client, ranges)| ranges.iter().any(|range| range.end > vector.get(client)))
        {
            continue;
        }
        // Decoded entry ranges can be unsorted; subset_of checks each range independently.
        if update
            .delete_set()
            .iter()
            .any(|(client, ranges)| !ranges.subset_of(deleted.get(client).unwrap_or(&empty)))
        {
            continue;
        }
        if before.is_none() {
            before = Some(super::draft::bounded(&accepted)?);
        }
        let scratch = crate::Ydoc::wire();
        scratch.apply(&checkpoint).map_err(collab)?;
        scratch.apply(bytes).map_err(collab)?;
        if !scratch.has_pending_dependencies() && Some(super::draft::bounded(&scratch)?) == before {
            return Ok(true);
        }
    }
    Ok(false)
}

fn deferred_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<DeferredOwnerStop, OwnerOutboxError> {
    let unsent_edits = conn.query_row("SELECT COALESCE(SUM(pending_entry_count),0) FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation],|r|r.get(0)).map_err(read_sql)?;
    let parent = find_parent_for_binding(conn, binding)?;
    let editable = parent.map_or(unsent_edits == 0, |p| {
        p.binding == *binding && p.state == OwnerOutboxState::Active
    });
    Ok(DeferredOwnerStop {
        unsent_edits,
        editable,
    })
}

#[cfg(test)]
#[path = "release_tests.rs"]
mod tests;
