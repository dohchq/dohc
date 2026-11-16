//! Generation-bound Stop requests and release of this computer's owner draft.
use super::draft::{bounded_blob, collab, key, read_observed_in};
use super::*;
use crate::{AppendOutcome, CollabError, DocKey};
use dohc_engine_domain::ChangeAttribution;

/// How many updates one merge takes. A yrs merge slows faster than its input
/// grows, so a long run merges in pieces of this size, then merges the pieces.
const MERGE_FAN_IN: usize = 64;

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
    /// The relay's safety stop held the note. What the owner's screen showed
    /// is kept for a copy next to the note, and only Resume clears this Stop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<PausedOwnerStop>,
    #[serde(skip)]
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PausedOwnerStop {
    /// The last applied frame the route sent before its final refusal. The
    /// note holds exactly this.
    pub applied_cursor: i64,
    /// The last committed row it sent.
    pub row_cursor: i64,
    pub copy_path: String,
    /// The copy is on disk. Until then the Stop row's `copy_digest` blob is
    /// the only place the owner's unapplied text lives.
    pub copy_written: bool,
    /// Some edits could not be shown as text, so the copy leaves them out.
    #[serde(default)]
    pub left_out: bool,
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

/// `retirement_owed` is false when the relay already retired the note, as
/// when its last link ended, so nothing asks the relay to Stop it.
pub fn request_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    retirement_owed: bool,
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
    let retirement_owed = match read_in(tx, key)? {
        Some(saved) if saved.state == "released" => return Ok(saved),
        // The first request decides whether the relay still has to retire the note.
        Some(saved) => saved.retirement_owed,
        None => retirement_owed,
    };
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
    // A note the relay retired is released from its draft; without one, no
    // release would ever end this Stop.
    if !retirement_owed && draft.is_none() {
        return Err(OwnerOutboxError::StopConflict);
    }
    // An unenrolled file can have no Y.Doc marker yet. A bare marker records
    // identity only; ordinary open still imports the authoritative file.
    tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,lineage_claim_status,updated_at_ms) VALUES(?1,?2,?3,'richdoc','local-only',0,0,'unclaimed',?4) ON CONFLICT DO NOTHING",params![key.workspace_id,key.version_id,key.object_id,now_ms]).map_err(write_sql)?;
    let stop = OwnerLiveStop {
        document: OwnerStopDocument {
            main_version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            current_path,
        },
        retirement_owed,
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
        paused: None,
    };
    save_in_tx(tx, key, &stop, now_ms)?;
    Ok(stop)
}

/// Whether this Stop is one the relay retired on its own, as when the note's
/// last link ended. Nobody waits to Resume it, so the release that finishes
/// it also ends it.
pub fn retired_by_relay_in(conn: &Connection, key: &DocKey) -> Result<bool, OwnerOutboxError> {
    Ok(read_in(conn, key)?.is_some_and(|stop| stop.state == "requested" && !stop.retirement_owed))
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
    let copy = copy_digest_in(tx, key)?;
    // Until the copy is on disk, its blob is the only place that text lives.
    if copy.is_some()
        && cleared
            .as_ref()
            .and_then(|stop| stop.paused.as_ref())
            .is_some_and(|paused| !paused.copy_written)
    {
        return Err(OwnerOutboxError::StopConflict);
    }
    tx.execute("DELETE FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id]).map_err(write_sql)?;
    if let Some(digest) = copy {
        delete_binary_blob_if_unreferenced(tx, &digest)?;
    }
    Ok(cleared)
}

pub fn list_requested_in(
    conn: &Connection,
    workspace: &str,
) -> Result<Vec<OwnerLiveStop>, OwnerOutboxError> {
    let mut stmt=conn.prepare("SELECT main_version_id,object_id FROM owner_live_stops WHERE workspace_id=?1 AND (state='requested' OR json_extract(binding_json,'$.retirementOwed')=1 OR json_extract(binding_json,'$.deferred') IS NOT NULL OR json_extract(binding_json,'$.paused') IS NOT NULL) ORDER BY json_extract(binding_json,'$.retirementOwed') DESC,main_version_id,object_id LIMIT 64").map_err(read_sql)?;
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

/// The relay has retired exactly this binding's generation. The recorder
/// journals each run of credited edits in the same transaction.
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
    // Deferred Stops are final for this build; retry never publishes a prefix.
    if observed.accepted_cursor < accepted_cursor {
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
            let mut stmt=tx.prepare("SELECT sequence,update_digest,byte_length,native_source_json,agent_declaration_json,automation_declaration_json,person_edit,agent_run_id FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence").map_err(read_sql)?;
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
                        r.get::<_, Option<String>>(7)?,
                    ))
                })
                .map_err(read_sql)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
        };

        for (_, digest, length, native, agent, automation, person, run) in entries {
            let bytes = bounded_blob(tx, &digest)?;
            if bytes.len() as i64 != length {
                return Err(OwnerOutboxError::Corrupt);
            }
            let source = native
                .map(
                    |json| -> Result<OwnerOutboxNativeSource, OwnerOutboxError> {
                        let source: OwnerOutboxSource =
                            serde_json::from_str(&json).map_err(|_| OwnerOutboxError::Corrupt)?;
                        let source = source.native().cloned().ok_or(OwnerOutboxError::Corrupt)?;
                        if source.binding != *binding || source.update_digest != digest {
                            return Err(OwnerOutboxError::Corrupt);
                        }
                        Ok(source)
                    },
                )
                .transpose()?;
            let credit = super::entry_credit(source.as_ref(), agent, run, automation, person)?;
            credited.push((credit, digest, bytes));
        }
    }
    if contains_pending_in(
        tx,
        &observed.checkpoint_digest,
        credited.iter().map(|(_, _, bytes)| bytes.as_slice()),
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
    super::taken::clear_in(tx, binding)?;
    tx.execute("DELETE FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    tx.execute("DELETE FROM ydoc_owner_applied_frames WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    let credited = credited_runs(tx, &key, credited)?;
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
    // Each recorded update stored its own blob; a merged run's edits no longer
    // need theirs.
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

fn copy_digest_in(conn: &Connection, key: &DocKey) -> Result<Option<String>, OwnerOutboxError> {
    conn.query_row(
        "SELECT copy_digest FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(read_sql)
    .map(Option::flatten)
}

/// The relay's final refusal of a held note, as the route reported it.
#[derive(Debug, Clone)]
pub struct OwnerPauseInput {
    pub binding: LiveObjectBinding,
    /// A: the last applied frame the route sent.
    pub applied_cursor: i64,
    /// N: the last row it sent that no save it sent holds; A when there is
    /// none. Rows and saves share one count, and a save's cursor can sit above
    /// a row it does not hold, so N can be below A.
    pub row_cursor: i64,
    /// A free name next to the note, chosen by the desktop.
    pub copy_path: String,
    /// The refused edits the desktop recorded as kept edits before the pause.
    pub kept_snapshot: Option<String>,
    pub now_ms: i64,
}

/// Pause a note the relay's safety stop held, in one transaction: render
/// what the owner's screen shows (accepted state, the committed rows, the
/// owner's pending entries) to Markdown, keep it as the copy's blob, remove
/// exactly the pending entries that render read, and unbind the note at A.
/// Nothing is credited to the note, so it never defers.
///
/// The owner's text is in the store at every moment: as outbox entries
/// before, as the copy's blob after. The caller writes the file from the blob.
/// `unbind` runs the pause inside the sync layer's end of the binding, as a
/// release does.
pub fn pause_cached(
    store: &mut EngineStore,
    cache: &mut crate::WriterDocCache,
    input: &OwnerPauseInput,
    faults: &dyn dohc_engine_storage::FaultInjector,
    unbind: impl FnOnce(
        &rusqlite::Transaction<'_>,
        &dyn Fn(&rusqlite::Transaction<'_>) -> Result<OwnerLiveStop, OwnerOutboxError>,
    ) -> Result<OwnerLiveStop, OwnerOutboxError>,
) -> Result<OwnerLiveStop, OwnerOutboxError> {
    let key = key(&input.binding)?;
    let layer = cache.owner_layer(&key);
    match store.write_with(faults, |tx| unbind(tx, &|tx| pause_in_tx(tx, input, layer)))? {
        dohc_engine_storage::TxnOutcome::Committed(stop) => {
            cache.clear_owner_layer(&key);
            Ok(stop)
        }
        dohc_engine_storage::TxnOutcome::Crashed { .. } => Err(OwnerOutboxError::Corrupt),
    }
}

fn pause_in_tx(
    tx: &rusqlite::Transaction<'_>,
    input: &OwnerPauseInput,
    layer: Option<&super::draft::OwnerLayer>,
) -> Result<OwnerLiveStop, OwnerOutboxError> {
    let binding = &input.binding;
    binding
        .validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    if input.applied_cursor < 0
        || input.row_cursor < 0
        || input.copy_path.is_empty()
        || !(0..=9_007_199_254_740_991).contains(&input.now_ms)
    {
        return Err(OwnerOutboxError::InvalidInput("invalid pause"));
    }
    let key = key(binding)?;
    if let Some(saved) = read_in(tx, &key)?.filter(|saved| saved.state == "released") {
        // A paused note stays paused; an ordinary release already unbound it.
        return match &saved.paused {
            Some(_) if saved.binding.as_ref() == Some(binding) => Ok(saved),
            _ => Err(OwnerOutboxError::StopConflict),
        };
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
    // The route reconnects and sends again until the note holds A and the
    // rows through N are here.
    // Rows and saves share one count, so N == A means no row was sent. A row
    // below A may not be in that save; only the layer shows it is here.
    let rows_through_n = input.row_cursor == input.applied_cursor
        || layer.is_some_and(|layer| layer.holds_row(binding, input.row_cursor));
    if observed.accepted_cursor != input.applied_cursor || !rows_through_n {
        return Err(OwnerOutboxError::AcceptedStateIncomplete);
    }
    // Unbinding would strand a ready settlement; let the delivery pass apply
    // it first, then the pause runs again.
    let held: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM owner_pending_settlements WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND relay_namespace=?5 AND applied=0)",
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.lineage_claim_id,
                observed.relay_database_namespace
            ],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    if held {
        return Err(OwnerOutboxError::StopConflict);
    }
    // The copy holds only the current draft, and the pause frees every outbox
    // of this generation. Refused edits there must be kept edits first.
    let refused: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes o WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND (o.state='quarantined' OR EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e WHERE e.outbox_id=o.outbox_id AND e.terminal_blob_digest IS NOT NULL)))",
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.lineage_claim_id,
                binding.restore_fence_generation
            ],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    if refused && input.kept_snapshot.is_none() {
        return Err(OwnerOutboxError::StopConflict);
    }
    let parts = super::draft::layered_parts_in(tx, binding, observed.revision, layer)?;
    let (markdown, left_out) = copy_text(parts)?;
    // A blob holds at least one byte; an empty note's copy is an empty file.
    let copy_digest = if markdown.is_empty() {
        None
    } else {
        Some(dohc_engine_storage::put_binary_blob(
            tx,
            markdown.as_bytes(),
        )?)
    };
    let outboxes = {
        let mut stmt = tx
            .prepare("SELECT outbox_id,restore_fence_generation FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4")
            .map_err(read_sql)?;
        let rows = stmt
            .query_map(
                params![
                    binding.workspace_id,
                    binding.main_version_id,
                    binding.object_id,
                    binding.lineage_claim_id
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    super::taken::clear_in(tx, binding)?;
    tx.execute("DELETE FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    tx.execute("DELETE FROM ydoc_owner_applied_frames WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    let mut blobs = BTreeSet::from([observed.checkpoint_digest.clone()]);
    for (id, generation) in outboxes {
        if generation > binding.restore_fence_generation {
            return Err(OwnerOutboxError::Corrupt);
        }
        if generation < binding.restore_fence_generation {
            continue;
        }
        // The render read every pending entry of this outbox in this
        // transaction, so the copy holds what these rows held.
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
    let stop = OwnerLiveStop {
        binding: Some(binding.clone()),
        document: OwnerStopDocument {
            main_version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            current_path: binding.current_path.clone(),
        },
        retirement_owed: false,
        relay_database_namespace: observed.relay_database_namespace.clone(),
        state: "released".into(),
        deferred: None,
        kept_snapshot: input.kept_snapshot.clone(),
        paused: Some(PausedOwnerStop {
            applied_cursor: input.applied_cursor,
            row_cursor: input.row_cursor,
            copy_path: input.copy_path.clone(),
            copy_written: false,
            left_out,
        }),
        record_facts: Vec::new(),
    };
    save_in_tx(tx, &key, &stop, input.now_ms)?;
    tx.execute(
        "UPDATE owner_live_stops SET copy_digest=?4 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id, copy_digest],
    )
    .map_err(write_sql)?;
    for digest in &blobs {
        if Some(digest) != copy_digest.as_ref() {
            delete_binary_blob_if_unreferenced(tx, digest)?;
        }
    }
    Ok(stop)
}

/// The copy's Markdown, and whether it leaves edits out. The pause must not
/// depend on the owner's screen becoming Markdown: a collaborator's row can
/// be too deep or too large to render. Then the copy leaves out each edit
/// that cannot render, and every edit that builds on one.
fn copy_text(parts: super::draft::LayeredParts) -> Result<(String, bool), OwnerOutboxError> {
    let base = parts.checkpoint;
    let mut waiting = parts.rows;
    waiting.extend(parts.pending);
    if let Some((markdown, waits)) = render(&base, &waiting) {
        // An owner entry waits for a row the route has not sent yet.
        if waits {
            return Err(OwnerOutboxError::AcceptedStateIncomplete);
        }
        return Ok((markdown, false));
    }
    if render(&base, &[]).is_none() {
        return Ok((String::new(), true));
    }
    // Keep each edit, in order, whose state still renders with nothing left
    // waiting. An edit that waits on one kept later is tried again then.
    let mut kept = Vec::new();
    loop {
        let before = waiting.len();
        for update in std::mem::take(&mut waiting) {
            kept.push(update);
            if !matches!(render(&base, &kept), Some((_, false))) {
                waiting.extend(kept.pop());
            }
        }
        if waiting.len() == before {
            break;
        }
    }
    let (markdown, _) = render(&base, &kept).ok_or(OwnerOutboxError::Corrupt)?;
    Ok((markdown, true))
}

/// The Markdown of `base` with `updates` applied in order, and whether an
/// update waits for one that is not there; `None` when it cannot be shown as
/// text.
fn render(base: &[u8], updates: &[Vec<u8>]) -> Option<(String, bool)> {
    let doc = crate::Ydoc::wire();
    doc.apply(base).ok()?;
    for update in updates {
        doc.apply(update).ok()?;
    }
    super::draft::bounded(&doc).ok()?;
    let projection = doc.project(crate::ContentKind::Richdoc).ok()?.content;
    let markdown = doc
        .settled_markdown_source(&projection, || Ok::<_, CollabError>(None))
        .ok()?
        .unwrap_or(projection);
    Some((markdown, doc.has_pending_dependencies()))
}
pub fn paused_copy_in(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<(OwnerLiveStop, Vec<u8>)>, OwnerOutboxError> {
    let Some(stop) = read_in(conn, key)?.filter(|stop| stop.paused.is_some()) else {
        return Ok(None);
    };
    let bytes = match copy_digest_in(conn, key)? {
        Some(digest) => {
            let bytes = get_binary_blob(conn, &digest)
                .map_err(OwnerOutboxError::Storage)?
                .ok_or(OwnerOutboxError::Corrupt)?;
            if hex_sha256(&bytes) != digest {
                return Err(OwnerOutboxError::Corrupt);
            }
            bytes
        }
        None => Vec::new(),
    };
    Ok(Some((stop, bytes)))
}

/// The copy is on disk at `copy_path`, which a restart may have moved to the
/// next free name.
pub fn copy_written_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    copy_path: &str,
    now_ms: i64,
) -> Result<OwnerLiveStop, OwnerOutboxError> {
    if copy_path.is_empty() {
        return Err(OwnerOutboxError::InvalidInput("invalid copy path"));
    }
    let mut stop = read_in(tx, key)?.ok_or(OwnerOutboxError::StopConflict)?;
    let paused = stop.paused.as_mut().ok_or(OwnerOutboxError::StopConflict)?;
    paused.copy_path = copy_path.to_owned();
    paused.copy_written = true;
    save_in_tx(tx, key, &stop, now_ms)?;
    Ok(stop)
}

/// One update and History row for each run of consecutive edits with the same
/// credit, so a release replays and stores each run once rather than each edit.
/// An edit already in the note's log stays alone, so the recorder still skips it
/// instead of recording it again inside a run. A Collection record's edits all
/// stay alone: its field history and record events need every value it held.
fn credited_runs(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    credited: Vec<(EntryCredit, String, Vec<u8>)>,
) -> Result<Vec<crate::durable::CreditedUpdate>, OwnerOutboxError> {
    let record = dohc_engine_domain::is_collection_record_bound_in_tx(
        tx,
        &key.workspace_id,
        &key.version_id,
        &key.object_id,
    )
    .map_err(|error| {
        collab(CollabError::Corrupt {
            reason: error.to_string(),
        })
    })?;
    let mut runs: Vec<(EntryCredit, Vec<Vec<u8>>, usize, bool)> = Vec::new();
    for (credit, digest, bytes) in credited {
        let alone = record
            || crate::durable::blob_seq_in_log(tx, key, &digest, &bytes)
                .map_err(collab)?
                .is_some();
        match runs.last_mut() {
            Some((last, run, size, false))
                if !alone
                    && *last == credit
                    && *size + bytes.len() <= crate::limits::MAX_YDOC_UPDATE_BYTES =>
            {
                *size += bytes.len();
                run.push(bytes);
            }
            _ => {
                let size = bytes.len();
                runs.push((credit, vec![bytes], size, alone));
            }
        }
    }
    let mut updates = Vec::with_capacity(runs.len());
    for (credit, run, _, _) in runs {
        if run.len() == 1 {
            updates.extend(run.into_iter().map(|bytes| (credit.clone(), bytes)));
            continue;
        }
        let merged = merge_run(&run)?;
        // A merge is normally smaller than its parts. If one is not, its edits
        // keep their own rows rather than store an update over the limit.
        if merged.len() <= crate::limits::MAX_YDOC_UPDATE_BYTES {
            updates.push((credit, merged));
        } else {
            updates.extend(run.into_iter().map(|bytes| (credit.clone(), bytes)));
        }
    }
    Ok(updates)
}

fn merge_run(run: &[Vec<u8>]) -> Result<Vec<u8>, OwnerOutboxError> {
    let mut level = run
        .chunks(MERGE_FAN_IN)
        .map(crate::merge_updates)
        .collect::<Result<Vec<_>, _>>()
        .map_err(collab)?;
    while level.len() > 1 {
        level = level
            .chunks(MERGE_FAN_IN)
            .map(crate::merge_updates)
            .collect::<Result<Vec<_>, _>>()
            .map_err(collab)?;
    }
    level.pop().ok_or(OwnerOutboxError::Corrupt)
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
