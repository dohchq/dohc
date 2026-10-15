//! Inert original-entry prefix primitives. Production Stop does not call these.
use super::draft::{bounded_blob, collab, key, read_observed_in, ObservedOwnerBinding};
use super::*;
use crate::{doc_cache::CacheTuple, CollabError, DocKey, WriterDocCache};
use dohc_engine_domain::ChangeAttribution;
use dohc_engine_storage::FaultInjector;

#[cfg(feature = "test-support")]
thread_local! { static TURN_TIMES: std::cell::Cell<(f64,f64,f64)> = const { std::cell::Cell::new((0.0,0.0,0.0)) }; }

#[cfg(feature = "test-support")]
pub fn last_turn_times_for_test() -> (f64, f64, f64) {
    TURN_TIMES.with(|t| t.get())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefixNativeHead {
    head_update_seq: i64,
    head_snapshot_seq: i64,
    lineage_claim_id: Option<String>,
    lineage_epoch_tag: Option<String>,
    head_row_sha: Option<String>,
}

impl From<CacheTuple> for PrefixNativeHead {
    fn from(t: CacheTuple) -> Self {
        Self {
            head_update_seq: t.head_update_seq,
            head_snapshot_seq: t.head_snapshot_seq,
            lineage_claim_id: t.lineage_claim_id,
            lineage_epoch_tag: t.lineage_epoch_tag,
            head_row_sha: t.head_row_sha,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefixProgress {
    pub release_digest: String,
    pub anchor_cursor: i64,
    pub accepted_head: i64,
    pub checkpoint_digest: String,
    pub native_tuple: PrefixNativeHead,
    pub consumed_entries: i64,
    pub settlement_owed: bool,
    pub publication_frontier: std::collections::BTreeMap<String, i64>,
    pub closed_sessions: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixSettlement {
    pub binding: LiveObjectBinding,
    pub release_digest: String,
    pub anchor_cursor: i64,
    pub native_tuple: PrefixNativeHead,
    pub from_sequence: i64,
    pub through_sequence: i64,
}

impl PrefixSettlement {
    pub fn prepare_in(
        conn: &Connection,
        binding: &LiveObjectBinding,
    ) -> Result<Self, OwnerOutboxError> {
        let observed = effective_in(conn, binding)?;
        let key = key(binding)?;
        let p = progress_in(conn, &key)?.ok_or(OwnerOutboxError::StopConflict)?;
        let from_sequence = conn.query_row("SELECT COALESCE(settled_update_seq,0) FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id],|r|r.get(0)).map_err(read_sql)?;
        Ok(Self {
            binding: binding.clone(),
            release_digest: p.release_digest,
            anchor_cursor: p.anchor_cursor,
            native_tuple: p.native_tuple,
            from_sequence,
            through_sequence: observed.native_head_sequence,
        })
    }

    pub fn verify_in(&self, conn: &Connection) -> Result<(), CollabError> {
        if Self::prepare_in(conn, &self.binding).map_err(|_| CollabError::OwnerOutboxFrozen)?
            != *self
        {
            return Err(CollabError::OwnerOutboxFrozen);
        }
        Ok(())
    }
}

pub(crate) fn refresh_tuple_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<(), CollabError> {
    let mut stop = super::release::read_in(tx, key)
        .map_err(|_| CollabError::OwnerOutboxFrozen)?
        .ok_or(CollabError::OwnerOutboxFrozen)?;
    let p = stop.prefix.as_mut().ok_or(CollabError::OwnerOutboxFrozen)?;
    p.native_tuple = CacheTuple::read_current(tx, key)?
        .ok_or(CollabError::NoMarker)?
        .into();
    super::release::save_in_tx(tx, key, &stop, now_ms).map_err(|_| CollabError::OwnerOutboxFrozen)
}

pub fn compact_prefix(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    binding: &LiveObjectBinding,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<TxnOutcome<crate::CompactOutcome>, OwnerOutboxError> {
    store.read_with(|conn| effective_in(conn, binding))?;
    let key = key(binding)?;
    let outcome =
        crate::durable::compact_with_cache(store, &key, 0, faults, now_ms, Some(cache), true)
            .map_err(collab)?;
    if let TxnOutcome::Committed(crate::CompactOutcome::Compacted {
        up_to_seq,
        snapshot_sha,
        ..
    }) = &outcome
    {
        cache.note_compacted(store, &key, *up_to_seq, snapshot_sha);
    } else if matches!(outcome, TxnOutcome::Crashed { .. }) {
        cache.remove(&key);
    }
    Ok(outcome)
}

pub fn publication_tag(binding: &LiveObjectBinding, release_digest: &str) -> serde_json::Value {
    serde_json::json!({"releaseDigest":release_digest,"restoreFenceGeneration":binding.restore_fence_generation,"document":{"workspaceId":binding.workspace_id,"mainVersionId":binding.main_version_id,"objectId":binding.object_id,"lineageClaimId":binding.lineage_claim_id}})
}

pub fn history_committed_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let key = key(binding)?;
    let mut stop = super::release::read_in(tx, &key)?.ok_or(OwnerOutboxError::StopConflict)?;
    stop.prefix
        .as_mut()
        .ok_or(OwnerOutboxError::StopConflict)?
        .settlement_owed = false;
    super::release::save_in_tx(tx, &key, &stop, now_ms)
}

pub fn publication_acked_in(conn: &Connection, key: &DocKey) -> Result<bool, OwnerOutboxError> {
    let p = progress_in(conn, key)?.ok_or(OwnerOutboxError::StopConflict)?;
    for (origin, through) in p.publication_frontier {
        let ack: i64 = conn.query_row("SELECT COALESCE((SELECT pushed_seq FROM sync_relay_push_state WHERE workspace_id=?1 AND origin_id=?2),-1)",params![key.workspace_id,origin],|r|r.get(0)).map_err(read_sql)?;
        let refused: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM release_publication_admissions WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq<=?3 AND release_digest=?4)",params![key.workspace_id,origin,through,p.release_digest],|r|r.get(0)).map_err(read_sql)?;
        if ack < through || refused {
            return Ok(false);
        }
    }
    Ok(true)
}

fn require_publication_tag_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    release_digest: &str,
    origin: &str,
    seq: i64,
) -> Result<(), OwnerOutboxError> {
    let payload: String = tx
        .query_row(
            "SELECT payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND op_kind IN ('ydoc.update','moment.append')",
            params![binding.workspace_id, origin, seq],
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    let payload: serde_json::Value =
        serde_json::from_str(&payload).map_err(|_| OwnerOutboxError::Corrupt)?;
    if payload.get("release") != Some(&publication_tag(binding, release_digest)) {
        return Err(OwnerOutboxError::Corrupt);
    }
    Ok(())
}

/// Record only coordinates journaled with this release's immutable tag.
pub fn record_publication_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    origin: &str,
    seq: i64,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let key = key(binding)?;
    let mut stop = super::release::read_in(tx, &key)?.ok_or(OwnerOutboxError::StopConflict)?;
    if stop.binding.as_ref() != Some(binding) {
        return Err(OwnerOutboxError::StopConflict);
    }
    let p = stop.prefix.as_mut().ok_or(OwnerOutboxError::StopConflict)?;
    require_publication_tag_in_tx(tx, binding, &p.release_digest, origin, seq)?;
    p.publication_frontier
        .entry(origin.into())
        .and_modify(|head| *head = (*head).max(seq))
        .or_insert(seq);
    super::release::save_in_tx(tx, &key, &stop, now_ms)
}

pub fn require_delivery_open(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<(), OwnerOutboxError> {
    if progress_in(conn, &key(binding)?)?.is_some() {
        return Err(OwnerOutboxError::Stopping);
    }
    Ok(())
}

pub fn progress_in(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<PrefixProgress>, OwnerOutboxError> {
    Ok(super::release::read_in(conn, key)?.and_then(|s| s.prefix))
}

pub fn effective_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<ObservedOwnerBinding, OwnerOutboxError> {
    let key = key(binding)?;
    let stop = super::release::read_in(conn, &key)?;
    let Some(progress) = stop.as_ref().and_then(|s| s.prefix.as_ref()) else {
        return super::accepted::current(conn, binding);
    };
    let mut observed = read_observed_in(conn, binding)?.ok_or(OwnerOutboxError::NotFound)?;
    if stop.as_ref().is_none_or(|s| {
        s.binding.as_ref() != Some(binding)
            || s.relay_database_namespace != observed.relay_database_namespace
    }) || observed.native_head_sequence != progress.accepted_head
        || observed.accepted_cursor != progress.anchor_cursor
        || observed.checkpoint_digest != progress.checkpoint_digest
        || CacheTuple::read_current(conn, &key)
            .map_err(collab)?
            .map(PrefixNativeHead::from)
            .as_ref()
            != Some(&progress.native_tuple)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if crate::live_update_application::restore_generation(conn, &key)
        .map_err(collab)?
        .is_some_and(|g| g != binding.restore_fence_generation)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let marker = crate::read_marker_in(conn, &key)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::NotFound)?;
    if marker.content_kind != crate::ContentKind::Richdoc
        || marker.regime != crate::Regime::Replicated
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    observed.native_head_sequence = marker.head_update_seq;
    Ok(observed)
}

/// The caller has acquired a relay claim and applied its complete anchor.
/// This is deliberately not reachable from a production RPC in drain 2a.
pub fn seal_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
    release_digest: &str,
    anchor: i64,
    now_ms: i64,
) -> Result<PrefixProgress, OwnerOutboxError> {
    validate_digest(release_digest)?;
    let key = key(binding)?;
    super::release::require_not_host_in(tx, &key)?;
    let mut stop = super::release::read_in(tx, &key)?.ok_or(OwnerOutboxError::StopConflict)?;
    if stop.binding.as_ref() != Some(binding) {
        return Err(OwnerOutboxError::StopConflict);
    }
    if let Some(saved) = &stop.prefix {
        if saved.release_digest != release_digest || saved.anchor_cursor != anchor {
            return Err(OwnerOutboxError::StopConflict);
        }
        effective_in(tx, binding)?;
        return Ok(saved.clone());
    }
    let observed = super::accepted::current(tx, binding)?;
    if crate::live_update_application::restore_generation(tx, &key)
        .map_err(collab)?
        .is_some_and(|g| g != binding.restore_fence_generation)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if observed.accepted_cursor != anchor {
        return Err(OwnerOutboxError::StopConflict);
    }
    let fenced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND pending_entry_count>0 AND state='quarantined' AND quarantine_reason='restore-fenced')",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation],|r|r.get(0)).map_err(read_sql)?;
    if fenced {
        return Err(OwnerOutboxError::RestorePending);
    }
    let non_parent: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND (current_path<>?6 OR selector_paths_json<>?7) AND pending_entry_count>0)", params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation,binding.current_path,serde_json::to_string(&binding.selector_paths).map_err(|_| OwnerOutboxError::Corrupt)?], |r| r.get(0)).map_err(read_sql)?;
    if non_parent {
        tx.execute("UPDATE ydoc_owner_bindings SET binding_revision=binding_revision+1 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    }
    let progress = PrefixProgress {
        release_digest: release_digest.into(),
        anchor_cursor: anchor,
        accepted_head: observed.native_head_sequence,
        checkpoint_digest: observed.checkpoint_digest,
        native_tuple: CacheTuple::read_current(tx, &key)
            .map_err(collab)?
            .ok_or(OwnerOutboxError::Corrupt)?
            .into(),
        consumed_entries: 0,
        settlement_owed: false,
        publication_frontier: Default::default(),
        closed_sessions: Default::default(),
    };
    stop.prefix = Some(progress.clone());
    super::release::save_in_tx(tx, &key, &stop, now_ms)?;
    let doc = crate::durable::load_doc_in(tx, &key).map_err(collab)?;
    apply_remaining_in(tx, binding, &doc)?;
    dohc_engine_domain::collections::reconcile_collection_frontmatter_in_tx(
        tx,
        &key.workspace_id,
        &key.version_id,
        &key.object_id,
        &doc.frontmatter_json(),
    )
    .map_err(index_error)?;
    Ok(progress)
}

pub(super) fn apply_remaining_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    doc: &crate::Ydoc,
) -> Result<(), OwnerOutboxError> {
    let mut stmt = conn.prepare("SELECT e.update_digest,e.byte_length FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e ON e.outbox_id=o.outbox_id WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND e.pending=1 ORDER BY o.created_at_ms,o.outbox_id,e.sequence").map_err(read_sql)?;
    let rows = stmt
        .query_map(
            params![
                binding.workspace_id,
                binding.main_version_id,
                binding.object_id,
                binding.lineage_claim_id,
                binding.restore_fence_generation
            ],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(read_sql)?;
    for row in rows {
        let (digest, length) = row.map_err(read_sql)?;
        let bytes = bounded_blob(conn, &digest)?;
        if bytes.len() as i64 != length {
            return Err(OwnerOutboxError::Corrupt);
        }
        doc.apply(&bytes).map_err(collab)?;
    }
    if doc.has_pending_dependencies() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    Ok(())
}

type Entry = (
    String,
    i64,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

type FoldEntry = (Entry, String, i64, i64, i64, String);

fn credit(
    conn: &Connection,
    entry: &Entry,
    binding: &LiveObjectBinding,
) -> Result<(Option<String>, Option<ChangeAttribution>), OwnerOutboxError> {
    if let Some(json) = &entry.5 {
        let original = read_parent(conn, &entry.0)?
            .ok_or(OwnerOutboxError::Corrupt)?
            .binding;
        let source: OwnerOutboxSource =
            serde_json::from_str(json).map_err(|_| OwnerOutboxError::Corrupt)?;
        let source = source.native().ok_or(OwnerOutboxError::Corrupt)?;
        source.validate(&entry.2)?;
        if source.binding != original
            || source.update_digest != entry.3
            || original.workspace_id != binding.workspace_id
            || original.main_version_id != binding.main_version_id
            || original.object_id != binding.object_id
            || original.lineage_claim_id != binding.lineage_claim_id
            || original.restore_fence_generation != binding.restore_fence_generation
        {
            return Err(OwnerOutboxError::Corrupt);
        }
        return Ok(source.native_author()?.unwrap_or((None, None)));
    }
    let agent = stored_declaration(entry.6.clone())?;
    let automation = stored_automation_declaration(entry.7.clone())?;
    if agent.is_some() && automation.is_some() {
        return Err(OwnerOutboxError::Corrupt);
    }
    Ok(if let Some(a) = automation {
        (Some(a.automation_id), Some(a.attribution))
    } else if let Some(a) = agent {
        (Some(a.agent_id.clone()), Some(a.attribution()))
    } else if entry.8 == Some(1) {
        (
            Some("local-person".into()),
            Some(ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Human,
                on_behalf_of: None,
                depth: 0,
                run: None,
            }),
        )
    } else {
        (None, None)
    })
}

/// One bounded transaction, with original bytes and credit per native row.
pub fn commit_prefix(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    binding: &LiveObjectBinding,
    release_digest: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
    mut journal: impl FnMut(
        &rusqlite::Transaction<'_>,
        &[u8],
        Option<&str>,
        Option<&ChangeAttribution>,
    ) -> Result<Option<(String, i64)>, CollabError>,
) -> Result<TxnOutcome<PrefixProgress>, OwnerOutboxError> {
    let key = key(binding)?;
    store.read_with(|conn| effective_in(conn, binding))?;
    let mut committed_warm = None;
    let mut draft = cache.take_owner_draft(&key);
    #[cfg(feature = "test-support")]
    let started = std::time::Instant::now();
    #[cfg(feature = "test-support")]
    let mut validation_ms = 0.0;
    #[cfg(feature = "test-support")]
    let mut fold_ms = 0.0;
    let result = store.write_with(faults, |tx| {
        let observed = effective_in(tx, binding)?;
        if draft.as_ref().is_some_and(|d| super::draft::draft_proof(tx,binding,observed.revision).ok().as_ref() != Some(&d.proof)) { draft = None; }
        if crate::author_coverage::unresolved_in(tx,&key).map_err(collab)? { return Err(OwnerOutboxError::Stopping); }
        let mut stop = super::release::read_in(tx, &key)?.ok_or(OwnerOutboxError::StopConflict)?;
        let progress = stop.prefix.as_mut().ok_or(OwnerOutboxError::StopConflict)?;
        if progress.release_digest != release_digest || progress.settlement_owed { return Err(OwnerOutboxError::Stopping); }
        let entries: Vec<FoldEntry> = {
            let mut stmt = tx.prepare("SELECT o.outbox_id,e.sequence,e.append_key,e.update_digest,e.byte_length,e.native_source_json,e.agent_declaration_json,e.automation_declaration_json,e.person_edit,e.delivery_id,e.sequence,e.result_pending_bytes,e.result_oldest_entry_at_ms,e.result_state FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e ON e.outbox_id=o.outbox_id WHERE o.outbox_id=(SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND pending_entry_count>0 ORDER BY created_at_ms,outbox_id LIMIT 1) AND e.pending=1 ORDER BY e.sequence LIMIT ?6").map_err(read_sql)?;
            let rows = stmt.query_map(params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation,super::release::MAX_RELEASE_ENTRIES], |r| Ok(((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?),r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?))).map_err(read_sql)?;
            rows.collect::<Result<Vec<FoldEntry>,_>>().map_err(read_sql)?
        };
        let mut warm = cache.take_prefix(tx, &key).map_err(collab)?;
        let mut used = 0;
        let mut touched = std::collections::BTreeMap::new();
        for (entry, delivery_id, sequence, result_pending_bytes, result_oldest_entry_at_ms, result_state) in entries {
            if entry.4 < 1 { return Err(OwnerOutboxError::Corrupt); }
            if used > 0 && used + entry.4 > super::release::MAX_RELEASE_BYTES { break; }
            let (actor, attribution) = credit(tx, &entry, binding)?;
            if let Some(actor) = &actor { crate::validate_actor_origin_id(actor).map_err(collab)?; }
            crate::durable::validate_attribution(attribution.as_ref()).map_err(collab)?;
            let author = dohc_engine_domain::moment_author_json(actor.as_deref(),attribution.as_ref()).unwrap_or_else(|| r#"[{"kind":"unattributed"}]"#.into());
            match warm.authors.admit_prefix(&mut warm.author_bytes, &author) {
                Ok(_) => {}, Err(CollabError::AuthorCapacity) => { progress.settlement_owed = true; break; }, Err(e) => return Err(collab(e)),
            }
            let bytes = bounded_blob(tx,&entry.3)?;
            if bytes.len() as i64 != entry.4 { return Err(OwnerOutboxError::Corrupt); }
            warm.apply(&bytes).map_err(collab)?;
            let seq = crate::durable::append_row(tx,&key,&entry.3,actor.as_deref(),attribution.as_ref(),true,now_ms).map_err(collab)?;
            if actor.is_none() { crate::author_coverage::retain_pending_in(tx,&key,&[author]).map_err(collab)?; }
            if let Some((origin, seq)) = journal(tx,&bytes,actor.as_deref(),attribution.as_ref()).map_err(collab)? {
                require_publication_tag_in_tx(tx, binding, &progress.release_digest, &origin, seq)?;
                progress.publication_frontier.entry(origin).and_modify(|head| *head = (*head).max(seq)).or_insert(seq);
            }
            tx.execute("INSERT INTO owner_prefix_consumed (workspace_id,version_id,object_id,outbox_id,append_key,update_digest,native_sequence,delivery_id,sequence,result_pending_bytes,result_oldest_entry_at_ms,result_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![key.workspace_id,key.version_id,key.object_id,entry.0,entry.2,entry.3,seq,delivery_id,sequence,result_pending_bytes,result_oldest_entry_at_ms,result_state]).map_err(write_sql)?;
            tx.execute("DELETE FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence=?2 AND pending=1",params![entry.0,entry.1]).map_err(write_sql)?;
            *touched.entry(entry.0).or_insert(0) += entry.4;
            used += entry.4;
            progress.consumed_entries += 1;
        }
        for (id, bytes) in touched {
            tx.execute("UPDATE owner_ydoc_outboxes SET pending_bytes=pending_bytes-?3,oldest_entry_at_ms=(SELECT created_at_ms FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence LIMIT 1),state=CASE WHEN state='quarantined' THEN state WHEN pending_bytes-?3>=?2 THEN 'sealed' ELSE 'active' END WHERE outbox_id=?1",params![id,observed.limits.max_pending_bytes,bytes]).map_err(write_sql)?;
        }
        let tuple = CacheTuple::read_current(tx,&key).map_err(collab)?.ok_or(OwnerOutboxError::Corrupt)?;
        progress.native_tuple = tuple.clone().into();
        let saved = progress.clone();
        super::release::save_in_tx(tx,&key,&stop,now_ms)?;
        if let Some(draft) = draft.as_mut() { draft.proof = super::draft::draft_proof(tx,binding,observed.revision)?; draft.draft.observed = effective_in(tx,binding)?; }
        #[cfg(feature = "test-support")]
        { validation_ms = warm.validation_ms; fold_ms = warm.fold_ms; }
        committed_warm = Some((warm, tuple));
        Ok(saved)
    });
    if let Ok(TxnOutcome::Committed(_)) = &result {
        if let Some((warm, tuple)) = committed_warm {
            cache.finish_prefix(&key, warm, tuple, draft);
        }
    } else {
        cache.remove(&key);
    }
    #[cfg(feature = "test-support")]
    TURN_TIMES.with(|t| {
        t.set((
            started.elapsed().as_secs_f64() * 1000.0,
            validation_ms,
            fold_ms,
        ))
    });
    result
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedAppend {
    pub outbox_id: String,
    pub update_digest: String,
    pub native_sequence: i64,
}

pub fn append_old_session_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox: &str,
    input: &super::draft::OwnerDraftAppendInput,
    mut ordinary: impl FnMut(
        &rusqlite::Transaction<'_>,
        &[u8],
        Option<&str>,
        Option<&ChangeAttribution>,
        &str,
    ) -> Result<i64, CollabError>,
) -> Result<Option<ConsumedAppend>, OwnerOutboxError> {
    let key = key(&input.binding)?;
    validate_identifier(&input.append_key, "invalid append key")?;
    let digest = hex_sha256(&input.update);
    let alive: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_prefix_consumed WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND outbox_id=?4)",params![key.workspace_id,key.version_id,key.object_id,outbox],|r|r.get(0)).map_err(read_sql)?;
    if !alive {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let stop = super::release::read_in(tx, &key)?.ok_or(OwnerOutboxError::ParentMismatch)?;
    if stop.binding.as_ref() != Some(&input.binding)
        || stop
            .prefix
            .as_ref()
            .is_none_or(|p| p.closed_sessions.contains(outbox))
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let marker = crate::read_marker_in(tx, &key)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::ParentMismatch)?;
    let generation =
        crate::live_update_application::restore_generation(tx, &key).map_err(collab)?;
    if marker.lineage_claim_id.as_deref() != Some(&input.binding.lineage_claim_id)
        || generation.is_some_and(|g| g != input.binding.restore_fence_generation)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let saved: Option<(String,i64)> = tx.query_row("SELECT update_digest,native_sequence FROM owner_prefix_consumed WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND outbox_id=?4 AND append_key=?5",params![key.workspace_id,key.version_id,key.object_id,outbox,input.append_key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(read_sql)?;
    let seq = if let Some((original, seq)) = saved {
        if original != digest {
            return Err(OwnerOutboxError::AppendKeyMismatch);
        }
        seq
    } else {
        if stop.state != "released" || read_observed_in(tx, &input.binding)?.is_some() {
            return Ok(None);
        }
        let entry: Entry = (
            outbox.into(),
            0,
            input.append_key.clone(),
            digest.clone(),
            input.update.len() as i64,
            None,
            input
                .agent_declaration
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| OwnerOutboxError::Corrupt)?,
            input
                .automation_declaration
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| OwnerOutboxError::Corrupt)?,
            input.person_edit.then_some(1),
        );
        let (actor, attribution) = credit(tx, &entry, &input.binding)?;
        let seq = ordinary(
            tx,
            &input.update,
            actor.as_deref(),
            attribution.as_ref(),
            &input.append_key,
        )
        .map_err(collab)?;
        tx.execute(
            "INSERT INTO owner_prefix_consumed (workspace_id,version_id,object_id,outbox_id,append_key,update_digest,native_sequence,delivery_id,sequence,result_pending_bytes,result_oldest_entry_at_ms,result_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?7,1,0,'active')",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                outbox,
                input.append_key,
                digest,
                seq,
                super::delivery_id(outbox, seq, &digest),
            ],
        )
        .map_err(write_sql)?;
        seq
    };
    Ok(Some(ConsumedAppend {
        outbox_id: outbox.into(),
        update_digest: digest,
        native_sequence: seq,
    }))
}

/// Close session ownership durably before reclaiming any result.
pub fn close_consumed_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    outbox: &str,
    now_ms: i64,
) -> Result<(), OwnerOutboxError> {
    let mut stop = super::release::read_in(tx, key)?.ok_or(OwnerOutboxError::StopConflict)?;
    stop.prefix
        .as_mut()
        .ok_or(OwnerOutboxError::StopConflict)?
        .closed_sessions
        .insert(outbox.into());
    super::release::save_in_tx(tx, key, &stop, now_ms)
}

/// The caller closes session ownership before reclaiming its results.
pub fn cleanup_consumed_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    outbox: &str,
) -> Result<usize, OwnerOutboxError> {
    if !progress_in(tx, key)?.is_some_and(|p| p.closed_sessions.contains(outbox)) {
        return Err(OwnerOutboxError::StopConflict);
    }
    tx.execute("DELETE FROM owner_prefix_consumed WHERE rowid IN (SELECT rowid FROM owner_prefix_consumed WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND outbox_id=?4 LIMIT 64)",params![key.workspace_id,key.version_id,key.object_id,outbox]).map_err(write_sql)
}

pub fn cleanup_session_page_in_tx(
    tx: &rusqlite::Transaction<'_>,
    binding: &LiveObjectBinding,
) -> Result<usize, OwnerOutboxError> {
    super::draft::require_ordinary_write(tx, &key(binding)?).map_err(collab)?;
    let removed = tx.execute("DELETE FROM owner_ydoc_outbox_entries WHERE rowid IN (SELECT e.rowid FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e USING(outbox_id) WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND e.pending=0 LIMIT 64)",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation]).map_err(write_sql)?;
    let parents = tx.execute("DELETE FROM owner_ydoc_outboxes WHERE outbox_id IN (SELECT outbox_id FROM owner_ydoc_outboxes o WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND NOT EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e WHERE e.outbox_id=o.outbox_id) LIMIT 64)",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation]).map_err(write_sql)?;
    let frames = tx.execute("DELETE FROM ydoc_owner_applied_frames WHERE rowid IN (SELECT rowid FROM ydoc_owner_applied_frames WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 LIMIT 64)",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id]).map_err(write_sql)?;
    Ok(removed + parents + frames)
}
